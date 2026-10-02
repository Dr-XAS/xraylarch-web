"""Public report submissions retain only the reporting visitor's project."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import bug_reports
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def application(tmp_path, monkeypatch):
    monkeypatch.delenv("XRAYLARCH_SLACK_BOT_TOKEN", raising=False)
    monkeypatch.delenv("XRAYLARCH_BUGREPORT_SLACK_CHANNEL", raising=False)
    return create_app(Settings(data_root=tmp_path, public_mode=True))


def submit(client, project_id=None):
    return client.post("/api/bug-reports", data={
        "description": "Public deployment regression check",
        "user_email": "deployment-test@example.invalid",
        "project_id": project_id or "", "attach_project": "true",
    })


def test_public_reports_cannot_export_another_visitors_project(application, tmp_path):
    with (TestClient(application, base_url="https://testserver") as alice,
          TestClient(application, base_url="https://testserver") as bob):
        project = alice.post("/api/athena/projects").json()
        foreign = submit(bob, project["id"])
        assert foreign.status_code == 200, foreign.text
        assert foreign.json()["project_export_attached"] is False
        foreign_dir = tmp_path / "bug_reports" / foreign.json()["report_id"]
        assert not (foreign_dir / "project_export.json").exists()
        state = json.loads((foreign_dir / "project_state.json").read_text())
        assert "summary" not in state and "summary_error" in state
        own = submit(alice, project["id"])
        assert own.status_code == 200 and own.json()["project_export_attached"]
        own_dir = tmp_path / "bug_reports" / own.json()["report_id"]
        assert (own_dir / "project_export.json").exists()
        state = json.loads((own_dir / "project_state.json").read_text())
        assert state["summary"]["id"] == project["id"]
        for client in (alice, bob):
            assert client.get("/api/bug-reports").status_code == 405
            assert client.get(f"/api/bug-reports/{own.json()['report_id']}").status_code == 404


@pytest.mark.parametrize("capacity", ["library", "disk"])
def test_public_capacity_rejects_without_removing_existing_reports(application, tmp_path, monkeypatch, capacity):
    directory = tmp_path / "bug_reports" / "existing-report"
    directory.mkdir(parents=True)
    (directory / "description.txt").write_text("Keep this report")
    if capacity == "library":
        monkeypatch.setattr(bug_reports, "PUBLIC_REPORT_LIBRARY_BYTES", 1)
    else:
        monkeypatch.setattr(bug_reports.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    with TestClient(application, base_url="https://testserver") as client:
        response = submit(client)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "bug_report_capacity"
    assert (directory / "description.txt").read_text() == "Keep this report"
    assert not list((tmp_path / "bug_reports").glob("bug_*"))
