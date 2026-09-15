from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import Settings
from .integration_contracts import DraftStatus
from .integration_service import (
    IntegrationAuthenticationError,
    IntegrationAuthorizationError,
    IntegrationService,
)
from .integration_storage import (
    IntegrationConflictError,
    IntegrationNotFoundError,
    IntegrationReplayError,
)


class ConsumeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    handle: str = Field(min_length=22, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


def _now() -> datetime:
    return datetime.now(UTC)


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, IntegrationAuthenticationError):
        return HTTPException(status_code=401, detail="Integration authentication failed.")
    if isinstance(exc, IntegrationNotFoundError):
        return HTTPException(status_code=404, detail="Integration draft was not found.")
    if isinstance(exc, IntegrationAuthorizationError):
        return HTTPException(status_code=404, detail="Integration draft was not found.")
    if isinstance(exc, IntegrationReplayError):
        return HTTPException(status_code=400, detail="Integration token was already used.")
    if isinstance(exc, IntegrationConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    raise exc


def build_integration_router(
    service: IntegrationService, settings: Settings
) -> APIRouter:
    router = APIRouter(prefix="/api/integration/v1")

    @router.post("/bootstrap")
    async def bootstrap(request: Request):
        raw_body = await request.body()
        service.storage.expire_due(_now())
        try:
            launch = service.bootstrap(
                raw_body=raw_body, headers=request.headers, now=_now()
            )
        except ValidationError:
            raise HTTPException(status_code=422, detail="Launch envelope is invalid.")
        except Exception as exc:
            raise _http_error(exc)
        return {"handle": launch.launch_handle}

    if settings.browser_consume_enabled:
        @router.post("/browser/consume")
        def consume(payload: ConsumeRequest, response: Response):
            service.storage.expire_due(_now())
            try:
                session = service.consume_browser_handle(payload.handle, _now())
            except Exception as exc:
                raise _http_error(exc)
            response.headers["Cache-Control"] = "no-store"
            return {
                "draft_id": session.draft_id,
                "project_id": session.project_id,
                "group_id": session.group_id,
                "source_sha256": session.source_sha256,
                "owner_capability": session.owner_capability,
            }

    def owner_draft(draft_id: str, capability: str | None, *, terminal=False):
        if not capability:
            raise HTTPException(status_code=404, detail="Integration draft was not found.")
        service.storage.expire_due(_now())
        try:
            draft = service.storage.load_draft(draft_id, capability)
        except Exception as exc:
            raise _http_error(exc)
        if not terminal and draft.status is not DraftStatus.ACTIVE:
            raise HTTPException(status_code=404, detail="Integration draft was not found.")
        return draft

    @router.get("/drafts/{draft_id}")
    def get_draft(
        draft_id: str,
        capability: str | None = Header(default=None, alias="X-XrayLarch-Draft-Capability"),
    ):
        draft = owner_draft(draft_id, capability, terminal=True)
        return _draft_json(draft)

    @router.post("/drafts/{draft_id}/discard")
    def discard_draft(
        draft_id: str,
        capability: str | None = Header(default=None, alias="X-XrayLarch-Draft-Capability"),
    ):
        owner_draft(draft_id, capability, terminal=True)
        try:
            draft = service.storage.transition(
                draft_id, capability or "", DraftStatus.DISCARDED, _now()
            )
        except Exception as exc:
            raise _http_error(exc)
        return _draft_json(draft)

    @router.post("/drafts/{draft_id}/seal")
    def seal_draft(
        draft_id: str,
        capability: str | None = Header(default=None, alias="X-XrayLarch-Draft-Capability"),
    ):
        owner_draft(draft_id, capability, terminal=True)
        try:
            draft = service.storage.transition(
                draft_id, capability or "", DraftStatus.SEALED, _now()
            )
        except Exception as exc:
            raise _http_error(exc)
        return _draft_json(draft)

    if settings.import_enabled:
        @router.post("/drafts/{draft_id}/import")
        async def import_action(draft_id: str, request: Request, response: Response):
            raw_body = await request.body()
            try:
                state = service.verified_import_action(
                    raw_body=raw_body, headers=request.headers, draft_id=draft_id, now=_now()
                )
            except ValidationError:
                raise HTTPException(status_code=422, detail="Import request is invalid.")
            except Exception as exc:
                raise _http_error(exc)
            response.headers["Cache-Control"] = "no-store"
            return state.model_dump(mode="json")

        @router.post("/drafts/{draft_id}/snapshot")
        async def snapshot_draft(draft_id: str, request: Request, response: Response):
            raw_body = await request.body()
            try:
                snapshot = service.verified_snapshot(
                    raw_body=raw_body, headers=request.headers, draft_id=draft_id, now=_now()
                )
            except ValidationError:
                raise HTTPException(status_code=422, detail="Editor result is invalid.")
            except Exception as exc:
                raise _http_error(exc)
            response.headers["Cache-Control"] = "no-store"
            return snapshot.model_dump(mode="json")

        @router.post("/drafts/{draft_id}/export")
        async def export_draft(draft_id: str, request: Request, response: Response):
            raw_body = await request.body()
            service.storage.expire_due(_now())
            try:
                sealed = service.verified_export(
                    raw_body=raw_body,
                    headers=request.headers,
                    draft_id=draft_id,
                    now=_now(),
                )
            except ValidationError:
                raise HTTPException(status_code=422, detail="Export request is invalid.")
            except Exception as exc:
                raise _http_error(exc)
            response.headers["Cache-Control"] = "no-store"
            return sealed.model_dump(mode="json")

    @router.get("/drafts/{draft_id}/workspace")
    def workspace(
        draft_id: str,
        capability: str | None = Header(default=None, alias="X-XrayLarch-Draft-Capability"),
    ):
        draft = owner_draft(draft_id, capability, terminal=True)
        if draft.status in {DraftStatus.DISCARDED, DraftStatus.EXPIRED}:
            raise HTTPException(status_code=404, detail="Integration draft was not found.")
        project = service.athena_store.load(draft.project_id)
        return {
            "draft": _draft_json(draft),
            "project": project,
            "allowed_operations": ([
                "metadata", "parameters", "set_e0", "undo", "redo"
            ] if draft.status is DraftStatus.ACTIVE else []) + (["export"] if settings.import_enabled else []),
        }

    return router


def _draft_json(draft) -> dict:
    return {
        "draft_id": draft.id,
        "project_id": draft.project_id,
        "group_id": draft.group_id,
        "source_sha256": draft.source_sha256,
        "status": draft.status.value,
        "created_at": draft.created_at.isoformat(),
        "updated_at": draft.updated_at.isoformat(),
        "expires_at": draft.expires_at.isoformat(),
    }
