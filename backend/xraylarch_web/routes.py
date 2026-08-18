from __future__ import annotations

import csv
from io import StringIO

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse, Response

from .config import Settings
from .contracts import (
    ApplyRequest,
    InspectionResponse,
    MappingRequest,
    PreviewRequest,
    ProcessingResult,
    RestoreRequest,
    WorkspaceSnapshot,
)
from .errors import WebInputError
from .parsing import parse_upload
from .workspace import WorkspaceStore

_UPLOAD_CHUNK_BYTES = 1024 * 1024
async def _read_bounded_upload(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    try:
        while chunk := await file.read(_UPLOAD_CHUNK_BYTES):
            size += len(chunk)
            if size > max_bytes:
                raise WebInputError(
                    "upload_too_large",
                    f"Upload exceeds the {max_bytes} byte limit.",
                    ("file",),
                    "Choose a smaller text upload.",
                )
            chunks.append(chunk)
    finally:
        await file.close()
    return b"".join(chunks)


def _csv_result(result: ProcessingResult) -> str:
    output = StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(("trace_id", "x_label", "x_unit", "y_label", "y_unit", "x", "y"))
    for trace in result.plots:
        writer.writerows(
            (
                trace.id,
                trace.x_label,
                trace.x_unit,
                trace.y_label,
                trace.y_unit,
                x,
                y,
            )
            for x, y in zip(trace.x, trace.y, strict=True)
        )
    return output.getvalue()


def build_api_router(store: WorkspaceStore, settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.post("/workspaces", response_model=WorkspaceSnapshot)
    def create_workspace() -> WorkspaceSnapshot:
        return store.create()

    @router.post(
        "/workspaces/{workspace_id}/uploads/inspect",
        response_model=InspectionResponse,
    )
    async def inspect_upload(workspace_id: str, file: UploadFile = File(...)) -> InspectionResponse:
        source_bytes = await _read_bounded_upload(file, settings.max_upload_bytes)
        parsed = parse_upload(
            source_bytes,
            file.filename or "upload.dat",
            max_bytes=settings.max_upload_bytes,
            max_points=settings.max_points,
            max_columns=settings.max_columns,
        )
        upload_id = store.save_upload(workspace_id, parsed)
        return InspectionResponse(upload_id=upload_id, **parsed.inspection().model_dump())

    @router.post("/workspaces/{workspace_id}/mapping", response_model=WorkspaceSnapshot)
    def confirm_mapping(workspace_id: str, request: MappingRequest) -> WorkspaceSnapshot:
        store.confirm_mapping(
            workspace_id,
            request.upload_id,
            request.energy_column,
            request.signal_column,
        )
        return store.load(workspace_id)

    @router.get("/workspaces/{workspace_id}", response_model=WorkspaceSnapshot)
    def get_workspace(workspace_id: str) -> WorkspaceSnapshot:
        return store.load(workspace_id)

    @router.post("/workspaces/{workspace_id}/preview", response_model=ProcessingResult)
    def preview(workspace_id: str, request: PreviewRequest) -> ProcessingResult:
        return store.preview(workspace_id, request.source_revision_id, request.recipe)

    @router.post("/workspaces/{workspace_id}/apply", response_model=WorkspaceSnapshot)
    def apply(workspace_id: str, request: ApplyRequest) -> WorkspaceSnapshot:
        store.apply_revision(
            workspace_id,
            request.source_revision_id,
            expected_parent_revision=request.expected_parent_revision,
            recipe=request.recipe,
        )
        return store.load(workspace_id)

    @router.post("/workspaces/{workspace_id}/restore", response_model=WorkspaceSnapshot)
    def restore(workspace_id: str, request: RestoreRequest) -> WorkspaceSnapshot:
        store.restore_revision(
            workspace_id,
            request.revision_id,
            expected_parent_revision=request.expected_parent_revision,
        )
        return store.load(workspace_id)

    @router.get("/workspaces/{workspace_id}/revisions/{revision_id}/data.csv")
    def download_data(workspace_id: str, revision_id: int) -> Response:
        return Response(
            _csv_result(store.revision_result(workspace_id, revision_id)),
            media_type="text/csv",
            headers={
                "Content-Disposition": 'attachment; filename="data.csv"'
            },
        )

    @router.get("/workspaces/{workspace_id}/revisions/{revision_id}/recipe.json")
    def download_recipe(workspace_id: str, revision_id: int) -> JSONResponse:
        return JSONResponse(
            store.revision_provenance(workspace_id, revision_id),
            headers={
                "Content-Disposition": 'attachment; filename="recipe.json"'
            },
        )

    return router
