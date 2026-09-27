from __future__ import annotations

import json

from starlette.formparsers import MultiPartException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import WebInputError


class _UploadBodyTooLarge(MultiPartException):
    """Abort multipart parsing through Starlette's temporary-file cleanup path."""

    def __init__(self) -> None:
        super().__init__("Upload body exceeds the configured limit.")


class UploadBodyLimitMiddleware:
    """Cap multipart upload bodies before Starlette parses them.

    Starlette spools a whole multipart body to a temporary file before a route
    runs, so a route's own byte check cannot stop an oversized upload from
    filling the disk first. Every route that accepts a file is listed here.
    """

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    @staticmethod
    def _is_capped_upload(scope: Scope) -> bool:
        if scope["method"] != "POST":
            return False
        parts = scope["path"].split("/")[1:]
        if len(parts) == 5 and parts[:2] == ["api", "workspaces"]:
            return parts[3:] == ["uploads", "inspect"]
        if len(parts) == 5 and parts[:3] == ["api", "athena", "projects"]:
            return parts[4] in {"inspect", "restore", "preview-project"}
        if len(parts) == 6 and parts[:3] == ["api", "athena", "projects"]:
            return parts[4:] == ["dispersive", "inspect"]
        return parts in (
            ["api", "athena", "preferences", "plugins", "import"],
            ["api", "athena", "preferences", "dispersive", "import"],
        )

    @staticmethod
    def _declared_content_length(scope: Scope) -> int | None:
        values = [
            value
            for name, value in scope["headers"]
            if name.lower() == b"content-length"
        ]
        if len(values) != 1:
            return None
        try:
            value = int(values[0])
        except ValueError:
            return None
        return value if value >= 0 else None

    async def _send_too_large(self, send: Send) -> None:
        error = WebInputError(
            "upload_too_large",
            f"Upload exceeds the {self.max_body_bytes} byte limit.",
            ("file",),
            "Choose a smaller text upload.",
        )
        body = json.dumps(
            {"error": error.envelope.model_dump()}, separators=(",", ":")
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 400,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._is_capped_upload(scope):
            await self.app(scope, receive, send)
            return

        declared_length = self._declared_content_length(scope)
        if declared_length is not None and declared_length > self.max_body_bytes:
            await self._send_too_large(send)
            return

        received_bytes = 0
        exceeded = False

        async def limited_receive() -> Message:
            nonlocal exceeded, received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_body_bytes:
                    exceeded = True
                    raise _UploadBodyTooLarge()
            return message

        async def limited_send(message: Message) -> None:
            if not exceeded:
                await send(message)

        try:
            await self.app(scope, limited_receive, limited_send)
        except _UploadBodyTooLarge:
            pass

        if exceeded:
            await self._send_too_large(send)
