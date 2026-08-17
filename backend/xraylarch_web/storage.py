from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from .errors import WorkspaceStateError

_OPAQUE_ID = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")
_SAFE_NAME = re.compile(r"[A-Za-z0-9_.-]+\Z")


class WorkspaceStorage:
    """Private, atomic filesystem persistence for opaque workspace identifiers."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    @staticmethod
    def _validate_id(value: str) -> str:
        if not _OPAQUE_ID.fullmatch(value):
            raise WorkspaceStateError(
                "workspace_not_found",
                "Workspace was not found.",
                recovery="Create a new workspace and retry.",
            )
        return value

    @staticmethod
    def _validate_name(value: str) -> str:
        if value in {"", ".", ".."} or not _SAFE_NAME.fullmatch(value):
            raise WorkspaceStateError(
                "storage_invalid_name",
                "Workspace storage name is invalid.",
                recovery="Retry the request.",
            )
        return value

    def workspace_dir(self, workspace_id: str, *, create: bool = False) -> Path:
        workspace_id = self._validate_id(workspace_id)
        path = (self.root / workspace_id).resolve()
        if path.parent != self.root:
            raise WorkspaceStateError("workspace_not_found", "Workspace was not found.", recovery="Create a new workspace and retry.")
        if create:
            path.mkdir(mode=0o700, exist_ok=False)
        if not path.is_dir():
            raise WorkspaceStateError("workspace_not_found", "Workspace was not found.", recovery="Create a new workspace and retry.")
        os.chmod(path, 0o700)
        return path

    def path(self, workspace_id: str, name: str) -> Path:
        workspace = self.workspace_dir(workspace_id)
        path = (workspace / self._validate_name(name)).resolve()
        if path.parent != workspace:
            raise WorkspaceStateError(
                "storage_invalid_name",
                "Workspace storage name is invalid.",
                recovery="Retry the request.",
            )
        return path

    def _atomic_replace(self, path: Path, writer) -> None:
        temp = path.with_name(f".{path.name}.{secrets.token_urlsafe(8)}.tmp")
        try:
            writer(temp)
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()

    def write_json(self, workspace_id: str, name: str, data: Mapping[str, Any]) -> None:
        path = self.path(workspace_id, name)

        def write(temp: Path) -> None:
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(data, handle, separators=(",", ":"), allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, 0o600)

        self._atomic_replace(path, write)

    def read_json(self, workspace_id: str, name: str) -> dict[str, Any]:
        with open(self.path(workspace_id, name), encoding="utf-8") as handle:
            return json.load(handle)

    def write_bytes(self, workspace_id: str, name: str, data: bytes) -> None:
        path = self.path(workspace_id, name)

        def write(temp: Path) -> None:
            with open(temp, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, 0o600)

        self._atomic_replace(path, write)

    def write_arrays(self, workspace_id: str, name: str, arrays: Mapping[str, np.ndarray]) -> None:
        path = self.path(workspace_id, name)
        safe_arrays = {self._validate_name(key): np.asarray(value) for key, value in arrays.items()}
        if any(array.dtype.hasobject for array in safe_arrays.values()):
            raise WorkspaceStateError(
                "storage_invalid_array",
                "Workspace arrays must not contain object values.",
                recovery="Retry the request with numeric arrays.",
            )

        def write(temp: Path) -> None:
            with open(temp, "wb") as handle:
                np.savez_compressed(handle, **safe_arrays)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, 0o600)

        self._atomic_replace(path, write)

    def read_arrays(self, workspace_id: str, name: str) -> dict[str, np.ndarray]:
        with np.load(self.path(workspace_id, name), allow_pickle=False) as archive:
            return {key: np.array(archive[key], copy=True) for key in archive.files}
