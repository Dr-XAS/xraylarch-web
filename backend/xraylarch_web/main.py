from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .config import Settings
from .contracts import ErrorEnvelope
from .errors import WebInputError
from .routes import build_api_router
from .upload_limit import UploadBodyLimitMiddleware
from .workspace import WorkspaceStore

_NOT_FOUND_CODES = {"workspace_not_found", "revision_not_found"}


def _error_response(error: ErrorEnvelope, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error.model_dump()})


def _domain_status(error: WebInputError) -> int:
    if error.code == "stale_revision":
        return 409
    if error.code in _NOT_FOUND_CODES:
        return 404
    return 400


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.from_environment()
    app = FastAPI(title="XrayLarch Web", version=__version__)
    store = WorkspaceStore(active_settings.data_root, max_nfft=active_settings.max_nfft)
    app.add_middleware(
        UploadBodyLimitMiddleware,
        max_body_bytes=active_settings.max_upload_bytes,
    )

    @app.exception_handler(WebInputError)
    async def handle_web_input_error(_: Request, error: WebInputError) -> JSONResponse:
        return _error_response(error.envelope, _domain_status(error))

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
        fields = tuple(
            sorted(
                {
                    str(issue["loc"][-1])
                    for issue in error.errors()
                    if issue.get("loc")
                }
            )
        )
        return _error_response(
            ErrorEnvelope(
                code="invalid_request",
                message="The request contains invalid fields.",
                fields=fields,
                recovery="Review the highlighted fields and retry.",
            ),
            422,
        )

    @app.get("/health")
    def health() -> dict[str, str | int]:
        return {"status": "ok", "version": __version__, "integration_contract_version": 2}

    app.include_router(build_api_router(store, active_settings))
    from .athena import AthenaStore, build_athena_router

    athena_store = AthenaStore(active_settings)
    integration_service = None
    if active_settings.integration_api_enabled:
        from .integration_routes import build_integration_router
        from .integration_service import IntegrationService
        from .integration_storage import IntegrationStorage

        integration_storage = IntegrationStorage(
            active_settings.data_root,
            integration_secret=active_settings.integration_hmac_secret or "",
            draft_ttl_seconds=active_settings.draft_ttl_seconds,
        )
        integration_service = IntegrationService(
            active_settings, athena_store, integration_storage
        )
        app.state.integration_service = integration_service
        app.state.athena_store = athena_store
        app.include_router(
            build_integration_router(integration_service, active_settings)
        )
    app.include_router(
        build_athena_router(
            active_settings,
            store=athena_store,
            integration_service=integration_service,
        )
    )
    return app


app = create_app()
