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
from xraylarch_web.upload_limit import UploadBodyLimitMiddleware, _MULTIPART_OVERHEAD_BYTES


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
    body_bytes = 1000 + _MULTIPART_OVERHEAD_BYTES + 1
    received, sent = 0, []

    async def receive():
        nonlocal received
        received += 1
        return {"type": "http.request", "body": b"x" * body_bytes, "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"version=0",
        "root_path": "", "client": ("127.0.0.1", 1), "server": ("test", 80),
        "headers": [(b"content-type", b"multipart/form-data; boundary=b"),
                    (b"content-length", str(body_bytes).encode())],
    }, receive, send))
    assert sent[0]["status"] == 400
    assert json.loads(sent[1]["body"])["error"]["code"] == "upload_too_large"
    assert received == 0


def test_file_at_configured_limit_is_accepted_with_multipart_overhead(tmp_path):
    payload = b"---\nDemeter::Plugins::X10C: 1\n"
    app = create_app(Settings(data_root=tmp_path, max_upload_bytes=len(payload)))
    with TestClient(app) as client:
        response = client.post(
            "/api/athena/preferences/plugins/import?version=0",
            files={"file": ("athena.plugin_registry", payload)},
        )
    assert response.status_code == 200, response.text
    assert response.json()["enabled"]["Demeter::Plugins::X10C"] is True


def test_small_preference_file_routes_have_smaller_body_caps(tmp_path):
    app = create_app(Settings(data_root=tmp_path, max_upload_bytes=1_000_000))
    middleware = UploadBodyLimitMiddleware(app, max_body_bytes=1_000_000)
    assert middleware._body_limit({"path": "/api/athena/preferences/plugins/import"}) == 64_000 + _MULTIPART_OVERHEAD_BYTES
    assert middleware._body_limit({"path": "/api/athena/preferences/dispersive/import"}) == 4096 + _MULTIPART_OVERHEAD_BYTES
