"""Blocking parsing, storage and Larch work must never run on the event loop."""
from __future__ import annotations

import asyncio
import inspect
import time

import httpx
from fastapi.routing import APIRoute

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def _integrated_settings(tmp_path):
    return Settings(
        data_root=tmp_path, integration_api_enabled=True, browser_consume_enabled=True,
        import_enabled=True, integration_issuer="drxas-test", integration_audience="xraylarch-test",
        integration_hmac_secret="s" * 32,
    )


def test_every_api_endpoint_runs_in_the_threadpool(tmp_path):
    # FastAPI calls an async endpoint directly on the event loop. Every route
    # here does synchronous file I/O or science, so each one must be plain def.
    app = create_app(_integrated_settings(tmp_path))
    coroutines = sorted(
        f"{sorted(route.methods)} {route.path}"
        for route in app.routes
        if isinstance(route, APIRoute) and inspect.iscoroutinefunction(route.endpoint)
    )
    assert coroutines == []


def test_slow_project_restore_does_not_delay_other_requests(tmp_path, monkeypatch):
    def slow_restore(self, ident, version, data, filename, group_ids=None, *, keep_name=False):
        time.sleep(0.6)
        return {"restored": True}

    monkeypatch.setattr(AthenaStore, "restore", slow_restore)
    app = create_app(Settings(data_root=tmp_path))

    async def exercise():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            project = (await client.post("/api/athena/projects")).json()

            async def restore():
                response = await client.post(
                    f"/api/athena/projects/{project['id']}/restore",
                    params={"version": project["version"]},
                    files={"file": ("project.prj", b"ignored")},
                )
                assert response.status_code == 200
                return time.monotonic()

            async def health():
                await asyncio.sleep(0.1)
                assert (await client.get("/health")).status_code == 200
                return time.monotonic()

            restored, healthy = await asyncio.gather(restore(), health())
        assert healthy < restored - 0.2

    asyncio.run(exercise())
