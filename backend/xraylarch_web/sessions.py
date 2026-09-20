"""Optional anonymous browser workspaces for a small public deployment.

The signed cookie is the browser's access credential. Keep the data directory
(including its signing key) across deploys. Clearing cookies starts a new private
workspace; there is deliberately no public session or project discovery API.
"""
from __future__ import annotations

import base64
from contextvars import ContextVar
from dataclasses import replace
import hashlib
import hmac
import re
import secrets
import threading

from fastapi import Request
from starlette.requests import HTTPConnection
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings
from .storage import WorkspaceStorage

SESSION_COOKIE = "xraylarch_session"
_TOKEN_PATTERN = re.compile(r"([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\Z")


def request_settings(request: Request, fallback: Settings) -> Settings:
    scoped = getattr(request.state, "xraylarch_settings", None)
    if scoped is not None:
        return scoped
    if fallback.public_mode:
        raise RuntimeError("Public routes require anonymous session middleware.")
    return fallback


_request_context: ContextVar[dict | None] = ContextVar(
    "xraylarch_public_request", default=None
)


class RequestScopedStore:
    """Resolve a concrete store inside the signed request's data namespace.

    FastAPI copies this context into worker threads. Background tasks must
    resolve their concrete store before starting a separate thread.
    """

    def __init__(self, settings: Settings, factory) -> None:
        self.base_settings = settings
        self.factory = factory

    def resolve(self):
        context = _request_context.get()
        if context is None:
            raise RuntimeError(
                "Public stores require an authenticated browser request."
            )
        with context["lock"]:
            if self not in context["stores"]:
                context["stores"][self] = self.factory(context["settings"])
            return context["stores"][self]

    def __getattr__(self, name):
        return getattr(self.resolve(), name)


class AnonymousSessionMiddleware:
    """Select a filesystem namespace without retaining sessions in memory."""

    def __init__(self, app: ASGIApp, *, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        storage = WorkspaceStorage(settings.data_root / ".session-auth")
        ident = "session_signing_key"
        try:
            storage.workspace_dir(ident, create=True)
        except FileExistsError:
            pass
        with storage.lock(ident):
            path = storage.path(ident, "key.bin")
            if not path.exists():
                storage.write_bytes(ident, "key.bin", secrets.token_bytes(32))
            self.key = path.read_bytes()
            if len(self.key) != 32:
                raise RuntimeError("Public session signing key is invalid; restore it from backup.")

    def _signature(self, ident: str) -> str:
        digest = hmac.new(self.key, ident.encode("ascii"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

    def _session(self, cookie: str | None) -> tuple[str, str | None]:
        match = _TOKEN_PATTERN.fullmatch(cookie or "")
        if match and hmac.compare_digest(match[2], self._signature(match[1])):
            return match[1], None
        ident = secrets.token_urlsafe(32)
        return ident, f"{ident}.{self._signature(ident)}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        ident, cookie = self._session(HTTPConnection(scope).cookies.get(SESSION_COOKIE))
        scope.setdefault("state", {})["xraylarch_settings"] = replace(
            self.settings, data_root=self.settings.data_root / "sessions" / ident,
        )

        async def session_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                # Public API responses contain browser-private data, even GETs.
                headers = [(key, value) for key, value in message.get("headers", [])
                           if key.lower() != b"cache-control"]
                headers.append((b"cache-control", b"private, no-store"))
                if cookie is not None:
                    response = Response()
                    response.set_cookie(SESSION_COOKIE, cookie, max_age=365 * 24 * 60 * 60,
                        httponly=True, secure=self.settings.session_cookie_secure,
                        samesite="lax", path="/")
                    headers.extend((key, value) for key, value in response.raw_headers
                                   if key == b"set-cookie")
                message = {**message, "headers": headers}
            await send(message)

        context = {
            "settings": scope["state"]["xraylarch_settings"],
            "stores": {},
            "lock": threading.RLock(),
        }
        token = _request_context.set(context)
        try:
            await self.app(scope, receive, session_send)
        finally:
            _request_context.reset(token)
