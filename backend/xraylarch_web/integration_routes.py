from __future__ import annotations

from datetime import UTC, datetime
import json

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


class RenameProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)


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

    v2 = APIRouter(prefix="/api/integration/v2")

    async def signed(request: Request) -> tuple[bytes, str, datetime]:
        raw = await request.body()
        try:
            nonce, timestamp = service.verify_v2_request(
                method=request.method, path=request.url.path, raw_body=raw,
                headers=request.headers, now=_now(),
            )
        except Exception as exc:
            raise _http_error(exc)
        service.storage.expire_due(_now())
        return raw, nonce, timestamp

    def claim(nonce: str, timestamp: datetime) -> None:
        try:
            service.claim_v2_nonce(nonce, timestamp)
        except Exception as exc:
            raise _http_error(exc)

    @v2.post("/projects")
    async def create_project(request: Request):
        from .integration_contracts import ProjectBootstrapRequest
        raw, nonce, timestamp = await signed(request)
        try:
            payload = ProjectBootstrapRequest.model_validate_json(raw)
            claim(nonce, timestamp)
            project_id, capability, summary = service.create_v2_project(payload, now=_now())
        except ValidationError:
            raise HTTPException(status_code=422, detail="Project request is invalid.")
        except Exception as exc:
            raise _http_error(exc)
        return {"contract_version": 2, "project_id": project_id, "capability": capability,
                "project": summary.model_dump(mode="json")}

    @v2.get("/projects/{project_id}")
    async def project_summary(project_id: str, request: Request):
        _, nonce, timestamp = await signed(request)
        capability = request.headers.get("X-XrayLarch-Project-Capability")
        if not capability:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        try:
            record = service.storage.load_project(project_id, capability, now=_now())
            project = service.athena_store.load(project_id)
            claim(nonce, timestamp)
            return service._project_summary(project, record).model_dump(mode="json")
        except (IntegrationNotFoundError, IntegrationAuthorizationError):
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        except Exception as exc:
            raise _http_error(exc)

    @v2.post("/projects/{project_id}/launch")
    async def launch_project(project_id: str, request: Request):
        raw, nonce, timestamp = await signed(request)
        try:
            capability = json.loads(raw or b"{}")["capability"]
            service.storage.load_project(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return {"handle": service.launch_v2_project(project_id, capability, now=_now())}
        except (KeyError, json.JSONDecodeError, TypeError):
            raise HTTPException(status_code=422, detail="Project request is invalid.")
        except Exception as exc:
            raise _http_error(exc)

    if settings.browser_consume_enabled:
        @v2.post("/browser/consume")
        def consume_v2(payload: ConsumeRequest, response: Response):
            try:
                session = service.consume_v2_handle(payload.handle, now=_now())
            except IntegrationReplayError:
                raise HTTPException(status_code=404, detail="Integration project was not found.")
            except Exception as exc:
                raise _http_error(exc)
            response.headers["Cache-Control"] = "no-store"
            return session

    @v2.patch("/projects/{project_id}")
    async def rename_project(project_id: str, request: Request):
        raw, nonce, timestamp = await signed(request)
        try:
            payload = RenameProjectRequest.model_validate_json(raw)
            capability = request.headers.get("X-XrayLarch-Project-Capability")
            if not capability:
                raise IntegrationAuthorizationError()
            service.storage.load_project(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return service.rename_v2_project(project_id, capability, payload.name, now=_now()).model_dump(mode="json")
        except ValidationError:
            raise HTTPException(status_code=422, detail="Project request is invalid.")
        except Exception as exc:
            raise _http_error(exc)

    @v2.delete("/projects/{project_id}")
    async def delete_project(project_id: str, request: Request):
        _, nonce, timestamp = await signed(request)
        capability = request.headers.get("X-XrayLarch-Project-Capability")
        if not capability:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        try:
            service.storage.authorize_project_cleanup(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return service.delete_v2_project(project_id, capability, now=_now())
        except Exception as exc:
            raise _http_error(exc)

    @v2.post("/projects/{project_id}/capability/rotate")
    async def rotate_capability(project_id: str, request: Request):
        _, nonce, timestamp = await signed(request)
        capability = request.headers.get("X-XrayLarch-Project-Capability")
        if not capability:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        try:
            service.storage.load_project(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return {"capability": service.storage.rotate_project_capability(project_id, capability, now=_now())}
        except Exception as exc:
            raise _http_error(exc)

    @v2.post("/projects/{project_id}/exports/reservations/{reservation_id}")
    async def reserve_export(project_id: str, reservation_id: str, request: Request):
        from .integration_contracts import SelectedGroupExportRequest
        raw, nonce, timestamp = await signed(request)
        capability = request.headers.get("X-XrayLarch-Project-Capability")
        if not capability:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        try:
            payload = SelectedGroupExportRequest.model_validate_json(raw)
            if payload.project_id != project_id:
                raise IntegrationAuthorizationError()
            service.storage.load_project(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return service.reserve_v2_export(project_id, capability, payload.selections, reservation_id, now=_now()).model_dump(mode="json")
        except ValidationError:
            raise HTTPException(status_code=422, detail="Export request is invalid.")
        except Exception as exc:
            raise _http_error(exc)

    @v2.post("/projects/{project_id}/exports/reservations/{reservation_id}/{action}")
    async def complete_export(project_id: str, reservation_id: str, action: str, request: Request):
        _, nonce, timestamp = await signed(request)
        if action not in {"commit", "abort"}:
            raise HTTPException(status_code=404, detail="Integration export reservation was not found.")
        capability = request.headers.get("X-XrayLarch-Project-Capability")
        if not capability:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        try:
            service.storage.load_project(project_id, capability, now=_now())
            claim(nonce, timestamp)
            return service.complete_v2_export(project_id, capability, reservation_id,
                                              commit=action == "commit", now=_now()).model_dump(mode="json")
        except Exception as exc:
            raise _http_error(exc)

    @v2.api_route("/{unmatched:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def v2_fallback(unmatched: str, request: Request):
        if unmatched == "browser/consume" and not settings.browser_consume_enabled:
            raise HTTPException(status_code=404, detail="Integration project was not found.")
        # Authenticate any other v2-shaped request before reporting that its
        # route is absent, so a method/path substitution never becomes an oracle.
        await signed(request)
        raise HTTPException(status_code=404, detail="Integration project was not found.")

    root = APIRouter()
    root.include_router(router)
    root.include_router(v2)
    return root


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
