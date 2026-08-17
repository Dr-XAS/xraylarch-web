import asyncio
import gc
from pathlib import Path

import httpx
import pytest

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
import xraylarch_web.routes as routes_module


def _app(data_root: Path):
    return create_app(Settings(data_root=data_root, max_upload_bytes=1_000_000))


def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


async def _asgi_request(app, *, headers, body_chunks):
    """Run a request with an intentionally absent or misleading Content-Length."""
    chunks = iter(body_chunks)
    received = 0
    sent = []

    async def receive():
        nonlocal received
        received += 1
        try:
            body = next(chunks)
        except StopIteration:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": body, "more_body": True}

    async def send(message):
        sent.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/workspaces/ignored/uploads/inspect",
            "raw_path": b"/api/workspaces/ignored/uploads/inspect",
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        },
        receive,
        send,
    )
    status = next(message["status"] for message in sent if message["type"] == "http.response.start")
    body = b"".join(
        message.get("body", b"")
        for message in sent
        if message["type"] == "http.response.body"
    )
    return status, body, received


def test_health_reports_backend_metadata(tmp_path):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "version": "0.1.0"}

    asyncio.run(exercise())


def test_workspace_api_processes_upload_without_preview_mutation(
    tmp_path, synthetic_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            assert workspace.status_code == 200
            workspace_id = workspace.json()["workspace_id"]

            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("synthetic.xmu", synthetic_xmu_bytes, "text/plain")},
            )
            assert inspected.status_code == 200
            inspection = inspected.json()
            assert inspection["upload_id"]
            assert inspection["columns"][0]["name"] == "energy"
            upload_id = inspection["upload_id"]

            mapped = await client.post(
                f"/api/workspaces/{workspace_id}/mapping",
                json={
                    "upload_id": upload_id,
                    "energy_column": "energy",
                    "signal_column": "mu",
                },
            )
            assert mapped.status_code == 200
            source_id = mapped.json()["revisions"][-1]["revision_id"]

            preview = await client.post(
                f"/api/workspaces/{workspace_id}/preview",
                json={"source_revision_id": source_id, "recipe": {}},
            )
            assert preview.status_code == 200
            assert {plot["id"] for plot in preview.json()["plots"]} == {
                "raw_mu",
                "norm_mu",
                "chi_k",
                "chi_r",
            }

            hydrated_before_apply = await client.get(f"/api/workspaces/{workspace_id}")
            assert hydrated_before_apply.status_code == 200
            assert hydrated_before_apply.json()["active_revision_id"] is None

            applied = await client.post(
                f"/api/workspaces/{workspace_id}/apply",
                json={
                    "source_revision_id": source_id,
                    "expected_parent_revision": None,
                    "recipe": {},
                },
            )
            assert applied.status_code == 200
            revision_id = applied.json()["active_revision_id"]

            download = await client.get(
                f"/api/workspaces/{workspace_id}/revisions/{revision_id}/data.csv"
            )
            assert download.status_code == 200
            assert "energy" in download.text.lower()
            assert download.headers["content-disposition"] == (
                'attachment; filename="data.csv"'
            )

            recipe = await client.get(
                f"/api/workspaces/{workspace_id}/revisions/{revision_id}/recipe.json"
            )
            assert recipe.status_code == 200
            assert recipe.json()["revision_id"] == revision_id
            effective = recipe.json()["effective"]
            assert effective["pre1"] == pytest.approx(-230.0)
            assert effective["nnorm"] == 2
            assert effective["autobk_kmax"] == pytest.approx(9.85)
            assert effective["autobk_kmax_automatic"] is True
            assert effective["xftf_kmax"] == 20.0
            assert effective["xftf_kmax_automatic"] is True
            assert effective["xftf_dk2"] == 1.0
            assert effective["xftf_dk2_automatic"] is True
            assert recipe.headers["content-disposition"] == (
                'attachment; filename="recipe.json"'
            )

            missing_revision = await client.get(
                f"/api/workspaces/{workspace_id}/revisions/999/data.csv"
            )
            assert missing_revision.status_code == 404
            assert missing_revision.json()["error"]["code"] == "revision_not_found"

    asyncio.run(exercise())


def test_inspection_accepts_browser_mime_fallbacks_for_supported_suffixes(tmp_path):
    async def exercise() -> None:
        xdi_fixture = (
            Path(__file__).parents[2] / "dylibs" / "XDI" / "cu_metal_rt.xdi"
        ).read_bytes()
        async with _client(_app(tmp_path)) as client:
            workspace_id = (await client.post("/api/workspaces")).json()["workspace_id"]
            xmu = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("browser.xmu", b"# energy mu\n1 2\n2 3\n", "")},
            )
            xdi = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={
                    "file": (
                        "browser.xdi",
                        xdi_fixture,
                        "application/octet-stream",
                    )
                },
            )
            unsupported = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("browser.exe", b"1 2\n2 3\n", "text/plain")},
            )

        assert xmu.status_code == 200
        assert xdi.status_code == 200
        assert unsupported.status_code == 400
        assert unsupported.json()["error"]["code"] == "upload_extension"

    asyncio.run(exercise())


def test_inspection_rejects_malformed_middle_row_without_reinterpreting_table(
    tmp_path,
):
    malformed_xmu = (
        b"# energy mu\n"
        b"8979.0 0.102\n"
        b"8980.0 0.103\n"
        b"energy replacement_header\n"
        b"8981.0 0.104\n"
    )

    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace_id = (await client.post("/api/workspaces")).json()["workspace_id"]
            response = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("malformed-middle.xmu", malformed_xmu, "text/plain")},
            )

        assert response.status_code == 400
        assert response.json() == {
            "error": {
                "code": "upload_malformed_rows",
                "message": "The upload contains a malformed or inconsistent data row.",
                "fields": ["file"],
                "recovery": "Repair the tabular rows and upload the data again.",
            }
        }
        assert "upload_id" not in response.text
        assert "columns" not in response.text

    asyncio.run(exercise())


def test_inspection_enforces_configured_table_limits(tmp_path):
    async def exercise() -> None:
        app = create_app(
            Settings(
                data_root=tmp_path,
                max_upload_bytes=1_000_000,
                max_points=2,
                max_columns=2,
            )
        )
        async with _client(app) as client:
            workspace_id = (await client.post("/api/workspaces")).json()["workspace_id"]
            too_many_points = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("points.dat", b"1 2\n2 3\n3 4\n", "text/plain")},
            )
            too_many_columns = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("columns.dat", b"1 2 3\n2 3 4\n", "text/plain")},
            )

        assert too_many_points.status_code == 400
        assert too_many_points.json()["error"]["code"] == "upload_too_many_points"
        assert too_many_columns.status_code == 400
        assert too_many_columns.json()["error"]["code"] == "upload_too_many_columns"

    asyncio.run(exercise())


def test_api_maps_the_second_duplicate_column_independently(tmp_path, xas_arrays):
    energy, mu = xas_arrays
    rows = (
        f"{x:.8f},{y:.12f},{y + 0.5:.12f}"
        for x, y in zip(energy, mu, strict=True)
    )
    duplicate_csv = ("energy,mu,mu\n" + "\n".join(rows) + "\n").encode()

    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace_id = (await client.post("/api/workspaces")).json()["workspace_id"]
            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("duplicates.csv", duplicate_csv, "text/csv")},
            )
            assert inspected.status_code == 200
            inspection = inspected.json()
            assert [column["name"] for column in inspection["columns"]] == [
                "energy",
                "mu",
                "mu",
            ]
            assert [column["column_id"] for column in inspection["columns"]] == [
                "column_0001",
                "column_0002",
                "column_0003",
            ]

            mapped = await client.post(
                f"/api/workspaces/{workspace_id}/mapping",
                json={
                    "upload_id": inspection["upload_id"],
                    "energy_column": "column_0001",
                    "signal_column": "column_0003",
                },
            )
            assert mapped.status_code == 200
            source = mapped.json()["draft_source"]
            assert source["signal_column_id"] == "column_0003"

            preview = await client.post(
                f"/api/workspaces/{workspace_id}/preview",
                json={"source_revision_id": source["source_revision_id"], "recipe": {}},
            )
            assert preview.status_code == 200
            assert preview.json()["plots"][0]["y"] == pytest.approx((mu + 0.5).tolist())

    asyncio.run(exercise())


def test_workspace_api_isolates_uploads_and_serializes_safe_errors(
    tmp_path, synthetic_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            first = await client.post("/api/workspaces")
            second = await client.post("/api/workspaces")
            first_id = first.json()["workspace_id"]
            second_id = second.json()["workspace_id"]

            inspected = await client.post(
                f"/api/workspaces/{first_id}/uploads/inspect",
                files={"file": ("private.xmu", synthetic_xmu_bytes, "text/plain")},
            )
            upload_id = inspected.json()["upload_id"]

            isolated = await client.post(
                f"/api/workspaces/{second_id}/mapping",
                json={
                    "upload_id": upload_id,
                    "energy_column": "energy",
                    "signal_column": "mu",
                },
            )
            assert isolated.status_code == 400
            assert isolated.json() == {
                "error": {
                    "code": "upload_not_found",
                    "message": "Upload was not found.",
                    "fields": [],
                    "recovery": "Upload the source data again.",
                }
            }

            malformed = await client.post(
                f"/api/workspaces/{first_id}/mapping",
                json={
                    "upload_id": upload_id,
                    "energy_column": "missing",
                    "signal_column": "mu",
                },
            )
            assert malformed.status_code == 400
            body = malformed.json()
            assert body["error"]["code"] == "invalid_mapping"
            assert set(body["error"]) == {"code", "message", "fields", "recovery"}
            assert str(tmp_path) not in malformed.text
            assert "traceback" not in malformed.text.lower()

            missing = await client.get("/api/workspaces/not-a-workspace")
            assert missing.status_code == 404
            assert missing.json()["error"]["code"] == "workspace_not_found"

    asyncio.run(exercise())


def test_stale_apply_returns_conflict_without_changing_applied_revision(
    tmp_path, synthetic_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            workspace_id = workspace.json()["workspace_id"]
            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("synthetic.xmu", synthetic_xmu_bytes, "text/plain")},
            )
            mapped = await client.post(
                f"/api/workspaces/{workspace_id}/mapping",
                json={
                    "upload_id": inspected.json()["upload_id"],
                    "energy_column": "energy",
                    "signal_column": "mu",
                },
            )
            source_id = mapped.json()["revisions"][-1]["revision_id"]
            first = await client.post(
                f"/api/workspaces/{workspace_id}/apply",
                json={
                    "source_revision_id": source_id,
                    "expected_parent_revision": None,
                    "recipe": {},
                },
            )
            active_revision_id = first.json()["active_revision_id"]

            stale = await client.post(
                f"/api/workspaces/{workspace_id}/apply",
                json={
                    "source_revision_id": source_id,
                    "expected_parent_revision": None,
                    "recipe": {"rbkg": 1.2},
                },
            )
            assert stale.status_code == 409
            assert stale.json()["error"]["code"] == "stale_revision"

            hydrated = await client.get(f"/api/workspaces/{workspace_id}")
            assert hydrated.json()["active_revision_id"] == active_revision_id

    asyncio.run(exercise())


def test_restore_creates_a_new_applied_revision(tmp_path, synthetic_xmu_bytes):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            workspace_id = workspace.json()["workspace_id"]
            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("synthetic.xmu", synthetic_xmu_bytes, "text/plain")},
            )
            mapped = await client.post(
                f"/api/workspaces/{workspace_id}/mapping",
                json={
                    "upload_id": inspected.json()["upload_id"],
                    "energy_column": "energy",
                    "signal_column": "mu",
                },
            )
            source_id = mapped.json()["revisions"][-1]["revision_id"]
            applied = await client.post(
                f"/api/workspaces/{workspace_id}/apply",
                json={
                    "source_revision_id": source_id,
                    "expected_parent_revision": None,
                    "recipe": {},
                },
            )
            first_revision_id = applied.json()["active_revision_id"]

            restored = await client.post(
                f"/api/workspaces/{workspace_id}/restore",
                json={
                    "revision_id": first_revision_id,
                    "expected_parent_revision": first_revision_id,
                },
            )
            assert restored.status_code == 200
            snapshot = restored.json()
            assert snapshot["active_revision_id"] > first_revision_id
            assert snapshot["revisions"][-1]["restored_from_revision_id"] == first_revision_id

    asyncio.run(exercise())


def test_cross_source_restore_hydrates_and_previews_the_active_source(
    tmp_path, xas_arrays
):
    energy, mu = xas_arrays

    def upload_bytes(offset: float) -> bytes:
        rows = (f"{x:.8f} {y + offset:.12f}" for x, y in zip(energy, mu, strict=True))
        return ("# energy mu\n" + "\n".join(rows) + "\n").encode()

    async def inspect_map_apply(
        client, workspace_id, filename, source_bytes, expected_parent
    ):
        inspected = await client.post(
            f"/api/workspaces/{workspace_id}/uploads/inspect",
            files={"file": (filename, source_bytes, "application/octet-stream")},
        )
        mapped = await client.post(
            f"/api/workspaces/{workspace_id}/mapping",
            json={
                "upload_id": inspected.json()["upload_id"],
                "energy_column": "column_0001",
                "signal_column": "column_0002",
            },
        )
        source_id = mapped.json()["draft_source"]["source_revision_id"]
        applied = await client.post(
            f"/api/workspaces/{workspace_id}/apply",
            json={
                "source_revision_id": source_id,
                "expected_parent_revision": expected_parent,
                "recipe": {},
            },
        )
        return source_id, applied.json()["active_revision_id"]

    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace_id = (await client.post("/api/workspaces")).json()["workspace_id"]
            source_a, revision_a = await inspect_map_apply(
                client, workspace_id, "source-a.xmu", upload_bytes(0), None
            )
            source_b, revision_b = await inspect_map_apply(
                client, workspace_id, "source-b.xmu", upload_bytes(0.25), revision_a
            )
            restored = await client.post(
                f"/api/workspaces/{workspace_id}/restore",
                json={
                    "revision_id": revision_a,
                    "expected_parent_revision": revision_b,
                },
            )
            hydrated = await client.get(f"/api/workspaces/{workspace_id}")
            active_source = hydrated.json()["active_source"]
            preview = await client.post(
                f"/api/workspaces/{workspace_id}/preview",
                json={"source_revision_id": active_source["source_revision_id"], "recipe": {}},
            )

        assert restored.status_code == 200
        assert source_a != source_b
        assert active_source["source_revision_id"] == source_a
        assert active_source["display_name"] == "source-a.xmu"
        assert hydrated.json()["draft_source"]["source_revision_id"] == source_b
        assert preview.json()["plots"][0]["y"] == pytest.approx(mu.tolist())

    asyncio.run(exercise())


def test_upload_cap_rejects_an_oversized_declared_content_length_before_receive(
    tmp_path, monkeypatch
):
    parsed = False

    def fail_if_parsed(*args, **kwargs):
        nonlocal parsed
        parsed = True
        raise AssertionError("multipart parsing reached the upload route")

    monkeypatch.setattr(routes_module, "parse_upload", fail_if_parsed)

    async def exercise() -> None:
        app = create_app(Settings(data_root=tmp_path, max_upload_bytes=10))
        status, body, received = await _asgi_request(
            app,
            headers=[
                (b"content-type", b"multipart/form-data; boundary=boundary"),
                (b"content-length", b"11"),
            ],
            body_chunks=(),
        )

        assert status == 400
        assert body == (
            b'{"error":{"code":"upload_too_large",'
            b'"message":"Upload exceeds the 10 byte limit.",'
            b'"fields":["file"],'
            b'"recovery":"Choose a smaller text upload."}}'
        )
        assert received == 0
        assert not parsed

    asyncio.run(exercise())


def test_upload_cap_rejects_streamed_body_without_trusting_content_length(
    tmp_path, monkeypatch
):
    parsed = False

    def fail_if_parsed(*args, **kwargs):
        nonlocal parsed
        parsed = True
        raise AssertionError("multipart parsing reached the upload route")

    monkeypatch.setattr(routes_module, "parse_upload", fail_if_parsed)

    async def exercise() -> None:
        app = create_app(Settings(data_root=tmp_path, max_upload_bytes=300))
        multipart_body = (
            b"--boundary\r\n"
            b'Content-Disposition: form-data; name="file"; filename="oversized.xmu"\r\n'
            b"Content-Type: text/plain\r\n\r\n"
            + b"1" * 300
            + b"\r\n--boundary--\r\n"
        )
        for content_length in (None, b"1"):
            headers = [(b"content-type", b"multipart/form-data; boundary=boundary")]
            if content_length is not None:
                headers.append((b"content-length", content_length))
            status, body, received = await _asgi_request(
                app,
                headers=headers,
                body_chunks=(multipart_body[:200], multipart_body[200:]),
            )

            assert status == 400
            assert b'"code":"upload_too_large"' in body
            assert received == 2
            assert not parsed

    asyncio.run(exercise())
    gc.collect()
