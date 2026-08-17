from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

import numpy as np

from .contracts import (
    ColumnInfo,
    ParsedUpload,
    PlotTrace,
    ProcessingResult,
    RecipeDraft,
    RevisionSummary,
    WorkspaceSnapshot,
)
from .errors import WorkspaceStateError
from .processing import run_processing, validate_mapping
from .storage import WorkspaceStorage

_WORKSPACE_FILE = "workspace.json"


class WorkspaceStore:
    """Immutable workspace revision service backed by private local storage."""

    def __init__(self, root: Path) -> None:
        self.storage = WorkspaceStorage(root)

    @staticmethod
    def _id() -> str:
        return secrets.token_urlsafe(16)

    def create(self) -> WorkspaceSnapshot:
        workspace_id = self._id()
        self.storage.workspace_dir(workspace_id, create=True)
        self.storage.write_json(
            workspace_id,
            _WORKSPACE_FILE,
            {
                "workspace_id": workspace_id,
                "active_revision_id": None,
                "uploads": {},
                "revisions": [],
            },
        )
        return self.load(workspace_id)

    def _metadata(self, workspace_id: str) -> dict[str, Any]:
        try:
            return self.storage.read_json(workspace_id, _WORKSPACE_FILE)
        except FileNotFoundError as exc:
            raise WorkspaceStateError("workspace_not_found", "Workspace was not found.", recovery="Create a new workspace and retry.") from exc

    def _write_metadata(self, workspace_id: str, metadata: dict[str, Any]) -> None:
        self.storage.write_json(workspace_id, _WORKSPACE_FILE, metadata)

    @staticmethod
    def _revision(metadata: dict[str, Any], revision_id: int) -> dict[str, Any]:
        for revision in metadata["revisions"]:
            if revision["revision_id"] == revision_id:
                return revision
        raise WorkspaceStateError("revision_not_found", "Revision was not found.", recovery="Select a revision from this workspace and retry.")

    @staticmethod
    def _next_revision_id(metadata: dict[str, Any]) -> int:
        return max((revision["revision_id"] for revision in metadata["revisions"]), default=0) + 1

    def save_upload(self, workspace_id: str, parsed: ParsedUpload) -> str:
        metadata = self._metadata(workspace_id)
        upload_id = self._id()
        arrays_name = f"upload-{upload_id}.npz"
        source_name = f"upload-{upload_id}.bin"
        self.storage.write_arrays(workspace_id, arrays_name, parsed.arrays)
        self.storage.write_bytes(workspace_id, source_name, parsed.source_bytes)
        metadata["uploads"][upload_id] = {
            "display_name": parsed.display_name,
            "row_count": parsed.row_count,
            "columns": [column.model_dump(mode="json") for column in parsed.columns],
            "warnings": list(parsed.warnings),
            "issues": [issue.model_dump(mode="json") for issue in parsed.issues],
            "arrays_name": arrays_name,
            "source_name": source_name,
        }
        self._write_metadata(workspace_id, metadata)
        return upload_id

    def _parsed_upload(self, workspace_id: str, metadata: dict[str, Any], upload_id: str) -> ParsedUpload:
        try:
            upload = metadata["uploads"][upload_id]
        except KeyError as exc:
            raise WorkspaceStateError("upload_not_found", "Upload was not found.", recovery="Upload the source data again.") from exc
        return ParsedUpload(
            display_name=upload["display_name"],
            row_count=upload["row_count"],
            columns=tuple(ColumnInfo.model_validate(column) for column in upload["columns"]),
            arrays=self.storage.read_arrays(workspace_id, upload["arrays_name"]),
            warnings=tuple(upload["warnings"]),
            issues=tuple(),
            source_bytes=b"",
        )

    def confirm_mapping(
        self, workspace_id: str, upload_id: str, energy_column: str, signal_column: str
    ) -> RevisionSummary:
        metadata = self._metadata(workspace_id)
        parsed = self._parsed_upload(workspace_id, metadata, upload_id)
        validate_mapping(parsed, energy_column, signal_column)
        revision = {
            "revision_id": self._next_revision_id(metadata),
            "kind": "mapping",
            "parent_revision_id": None,
            "source_revision_id": None,
            "restored_from_revision_id": None,
            "upload_id": upload_id,
            "energy_column": energy_column,
            "signal_column": signal_column,
        }
        metadata["revisions"].append(revision)
        self._write_metadata(workspace_id, metadata)
        return RevisionSummary.model_validate(revision)

    def _source_mapping(self, metadata: dict[str, Any], revision_id: int) -> dict[str, Any]:
        revision = self._revision(metadata, revision_id)
        source_id = revision_id if revision["kind"] == "mapping" else revision["source_revision_id"]
        if source_id is None:
            raise WorkspaceStateError("revision_not_found", "Revision has no source mapping.", recovery="Choose a source mapping revision and retry.")
        source = self._revision(metadata, source_id)
        if source["kind"] != "mapping":
            raise WorkspaceStateError("revision_not_found", "Revision has no source mapping.", recovery="Choose a source mapping revision and retry.")
        return source

    @staticmethod
    def _check_parent(metadata: dict[str, Any], expected_parent_revision: int | None) -> None:
        if metadata["active_revision_id"] != expected_parent_revision:
            raise WorkspaceStateError(
                "stale_revision",
                "The active revision changed before this recipe was applied.",
                ("expected_parent_revision",),
                "Refresh the workspace, preview again, and retry the apply.",
            )

    @staticmethod
    def _result_arrays(result: ProcessingResult) -> dict[str, np.ndarray]:
        arrays: dict[str, np.ndarray] = {}
        for trace in result.plots:
            arrays[f"{trace.id}_x"] = np.asarray(trace.x, dtype=float)
            arrays[f"{trace.id}_y"] = np.asarray(trace.y, dtype=float)
        return arrays

    def _save_result(self, workspace_id: str, revision_id: int, result: ProcessingResult) -> dict[str, Any]:
        arrays_name = f"revision-{revision_id}.npz"
        self.storage.write_arrays(workspace_id, arrays_name, self._result_arrays(result))
        return {
            "arrays_name": arrays_name,
            "effective": result.effective.model_dump(mode="json"),
            "plots": [trace.model_dump(exclude={"x", "y"}, mode="json") for trace in result.plots],
        }

    def _load_result(self, workspace_id: str, result_data: dict[str, Any]) -> ProcessingResult:
        arrays = self.storage.read_arrays(workspace_id, result_data["arrays_name"])
        plots = tuple(
            PlotTrace.model_validate({
                **trace,
                "x": tuple(float(value) for value in arrays[f"{trace['id']}_x"]),
                "y": tuple(float(value) for value in arrays[f"{trace['id']}_y"]),
            })
            for trace in result_data["plots"]
        )
        return ProcessingResult.model_validate({"effective": result_data["effective"], "plots": plots})

    def apply_revision(
        self,
        workspace_id: str,
        source_revision_id: int,
        *,
        expected_parent_revision: int | None,
        recipe: RecipeDraft,
    ) -> RevisionSummary:
        metadata = self._metadata(workspace_id)
        self._check_parent(metadata, expected_parent_revision)
        source = self._source_mapping(metadata, source_revision_id)
        parsed = self._parsed_upload(workspace_id, metadata, source["upload_id"])
        energy, mu = validate_mapping(parsed, source["energy_column"], source["signal_column"])
        result = run_processing(energy, mu, recipe)
        revision_id = self._next_revision_id(metadata)
        revision = {
            "revision_id": revision_id,
            "kind": "applied",
            "parent_revision_id": expected_parent_revision,
            "source_revision_id": source["revision_id"],
            "restored_from_revision_id": None,
            "recipe": recipe.model_dump(mode="json"),
            "effective": result.effective.model_dump(mode="json"),
            "result": self._save_result(workspace_id, revision_id, result),
        }
        metadata["revisions"].append(revision)
        metadata["active_revision_id"] = revision_id
        self._write_metadata(workspace_id, metadata)
        return RevisionSummary.model_validate(revision)

    def restore_revision(
        self,
        workspace_id: str,
        revision_id: int,
        *,
        expected_parent_revision: int | None,
    ) -> RevisionSummary:
        metadata = self._metadata(workspace_id)
        self._check_parent(metadata, expected_parent_revision)
        previous = self._revision(metadata, revision_id)
        if previous["kind"] != "applied":
            raise WorkspaceStateError("revision_not_restorable", "Only applied revisions can be restored.", recovery="Select an applied recipe revision and retry.")
        result = self._load_result(workspace_id, previous["result"])
        new_revision_id = self._next_revision_id(metadata)
        revision = {
            "revision_id": new_revision_id,
            "kind": "applied",
            "parent_revision_id": expected_parent_revision,
            "source_revision_id": previous["source_revision_id"],
            "restored_from_revision_id": revision_id,
            "recipe": previous["recipe"],
            "effective": previous["effective"],
            "result": self._save_result(workspace_id, new_revision_id, result),
        }
        metadata["revisions"].append(revision)
        metadata["active_revision_id"] = new_revision_id
        self._write_metadata(workspace_id, metadata)
        return RevisionSummary.model_validate(revision)

    def load(self, workspace_id: str) -> WorkspaceSnapshot:
        metadata = self._metadata(workspace_id)
        summaries = tuple(RevisionSummary.model_validate(revision) for revision in metadata["revisions"])
        active_result = None
        if metadata["active_revision_id"] is not None:
            active = self._revision(metadata, metadata["active_revision_id"])
            active_result = self._load_result(workspace_id, active["result"])
        return WorkspaceSnapshot(
            workspace_id=metadata["workspace_id"],
            active_revision_id=metadata["active_revision_id"],
            revisions=summaries,
            active_result=active_result,
        )
