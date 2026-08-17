import asyncio
from pathlib import Path

import httpx

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def _app(data_root: Path):
    return create_app(Settings(data_root=data_root, max_upload_bytes=1_000_000))


def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


def test_health_reports_backend_metadata(tmp_path):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "version": "0.1.0"}

    asyncio.run(exercise())


def test_workspace_api_processes_upload_without_preview_mutation(
    tmp_path, sample_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            assert workspace.status_code == 200
            workspace_id = workspace.json()["workspace_id"]

            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("cu_rt01.xmu", sample_xmu_bytes, "text/plain")},
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
                'attachment; filename="xraylarch-data.csv"'
            )

            recipe = await client.get(
                f"/api/workspaces/{workspace_id}/revisions/{revision_id}/recipe.json"
            )
            assert recipe.status_code == 200
            assert recipe.json()["revision_id"] == revision_id
            assert recipe.headers["content-disposition"] == (
                'attachment; filename="xraylarch-recipe.json"'
            )

            missing_revision = await client.get(
                f"/api/workspaces/{workspace_id}/revisions/999/data.csv"
            )
            assert missing_revision.status_code == 404
            assert missing_revision.json()["error"]["code"] == "revision_not_found"

    asyncio.run(exercise())


def test_workspace_api_isolates_uploads_and_serializes_safe_errors(
    tmp_path, sample_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            first = await client.post("/api/workspaces")
            second = await client.post("/api/workspaces")
            first_id = first.json()["workspace_id"]
            second_id = second.json()["workspace_id"]

            inspected = await client.post(
                f"/api/workspaces/{first_id}/uploads/inspect",
                files={"file": ("private.xmu", sample_xmu_bytes, "text/plain")},
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
    tmp_path, sample_xmu_bytes
):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            workspace_id = workspace.json()["workspace_id"]
            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("cu_rt01.xmu", sample_xmu_bytes, "text/plain")},
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


def test_restore_creates_a_new_applied_revision(tmp_path, sample_xmu_bytes):
    async def exercise() -> None:
        async with _client(_app(tmp_path)) as client:
            workspace = await client.post("/api/workspaces")
            workspace_id = workspace.json()["workspace_id"]
            inspected = await client.post(
                f"/api/workspaces/{workspace_id}/uploads/inspect",
                files={"file": ("cu_rt01.xmu", sample_xmu_bytes, "text/plain")},
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
