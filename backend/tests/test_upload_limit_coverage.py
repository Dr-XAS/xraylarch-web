"""Every multipart route must be capped before Starlette spools its body."""
from __future__ import annotations

import asyncio
import inspect
import json
import re

from fastapi import params
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from xraylarch_web.upload_limit import UploadBodyLimitMiddleware


def _file_routes(app):
    for route in app.routes:
        if isinstance(route, APIRoute) and any(
            isinstance(parameter.default, params.File)
            for parameter in inspect.signature(route.endpoint).parameters.values()
        ):
            yield route


def test_every_file_upload_route_is_capped_before_parsing(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    routes = list(_file_routes(app))
    assert len(routes) >= 7
    uncapped = [
        f"{method} {route.path}"
        for route in routes
        for method in route.methods
        if not UploadBodyLimitMiddleware._is_capped_upload({
            "method": method,
            "path": re.sub(r"\{[^}]+\}", "AAAAAAAAAAAAAAAAAAAAAAAA", route.path),
        })
    ]
    assert uncapped == []


def test_oversized_project_restore_is_rejected_without_reading_the_body(tmp_path):
    app = create_app(Settings(data_root=tmp_path, max_upload_bytes=1000))
    project = TestClient(app).post("/api/athena/projects").json()
    path = f"/api/athena/projects/{project['id']}/restore"
    received, sent = 0, []

    async def receive():
        nonlocal received
        received += 1
        return {"type": "http.request", "body": b"x" * 5000, "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"version=0",
        "root_path": "", "client": ("127.0.0.1", 1), "server": ("test", 80),
        "headers": [(b"content-type", b"multipart/form-data; boundary=b"), (b"content-length", b"5000")],
    }, receive, send))
    assert sent[0]["status"] == 400
    assert json.loads(sent[1]["body"])["error"]["code"] == "upload_too_large"
    assert received == 0
