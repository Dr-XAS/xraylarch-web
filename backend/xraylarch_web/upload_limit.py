from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import WebInputError


class _UploadBodyTooLarge(Exception):
    pass


class UploadBodyLimitMiddleware:
    """Cap inspect-upload bodies before Starlette parses multipart data."""

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    @staticmethod
    def _is_inspect_upload(scope: Scope) -> bool:
        parts = scope["path"].split("/")
        return (
            scope["method"] == "POST"
            and len(parts) == 6
            and parts[1] == "api"
            and parts[2] == "workspaces"
            and parts[4] == "uploads"
            and parts[5] == "inspect"
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
        if scope["type"] != "http" or not self._is_inspect_upload(scope):
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
                    raise _UploadBodyTooLarge
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
