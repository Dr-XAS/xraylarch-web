"""Bug reports file into a local library the way Dr.XAS keeps its own."""
from __future__ import annotations

import io
import json
import os
import stat

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import bug_report_notify
from xraylarch_web.bug_reports import (
    MAX_SCREENSHOTS,
    MAX_SCREENSHOT_BYTES,
    new_report_id,
    normalize_client_metadata,
)
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("XRAYLARCH_SLACK_BOT_TOKEN", raising=False)
    monkeypatch.delenv("XRAYLARCH_BUGREPORT_SLACK_CHANNEL", raising=False)
    with TestClient(create_app(Settings(data_root=tmp_path, bug_report_max_bytes=8_000_000))) as client:
        yield client


def metadata(**overrides):
    base = {
        "schema_version": 1,
        "captured_at": "2026-10-02T15:04:05.000Z",
        "app": {"version": "v0.2026.10.02.812.6b91b", "build_sha": "6b91b"},
        "page": {"pathname": "/advanced-xas/app", "href": "https://example.test/advanced-xas/app"},
        "browser": {"name": "Chrome", "version": "131.0"},
        "os": {"name": "macOS", "version": "15.1"},
        "storage": {"local_storage": {"xraylarch-web.theme": "dark"}, "session_storage": {}},
    }
    base.update(overrides)
    return base


def submit(client, **fields):
    data = {"description": "The merge preview is blank.", "type": "bug", "user_email": "ana@example.org"}
    files = fields.pop("files", None)
    data.update(fields)
    return client.post("/api/bug-reports", data=data, files=files)


def read_report(tmp_path, report_id):
    return json.loads((tmp_path / "bug_reports" / report_id / "report.json").read_text())


def test_report_writes_the_dr_xas_directory_layout(client, tmp_path):
    response = submit(
        client,
        client_metadata=json.dumps(metadata()),
        project_state=json.dumps({"mode": "local", "project": None, "busy": "", "error": ""}),
        files=[
            ("screenshots", ("paste.png", b"\x89PNG...", "image/png")),
            ("attachments", ("../../Cu foil.dat", b"energy mu\n1 2\n", "text/plain")),
        ],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "success" and body["stored_locally"] is True
    assert body["project_export_attached"] is False
    report_id = body["report_id"]
    assert report_id.startswith("bug_")

    report_dir = tmp_path / "bug_reports" / report_id
    assert sorted(p.name for p in report_dir.iterdir()) == [
        "attachments", "client_metadata.json", "description.txt", "project_state.json",
        "report.json", "screenshot_1.png",
    ]
    assert (report_dir / "attachments" / "01_Cu foil.dat").read_bytes() == b"energy mu\n1 2\n"
    assert (report_dir / "description.txt").read_text() == "The merge preview is blank."
    assert stat.S_IMODE((report_dir / "report.json").stat().st_mode) == 0o600

    report = read_report(tmp_path, report_id)
    assert report["type"] == "bug" and report["status"] == "pending"
    assert report["source"] == "local_bug_library" and report["surface"] == "web"
    assert report["project_id"] == "xraylarch-web"
    assert report["user_email"] == "ana@example.org"
    assert report["attachment_owner_report_id"] == report_id
    assert report["admin_schedule_approved"] is False
    assert report["screenshot_files"] == ["screenshot_1.png"]
    assert report["description_file"] == f"bug_reports/{report_id}/description.txt"
    assert report["attached_files"] == [{
        "name": "Cu foil.dat", "stored_filename": "01_Cu foil.dat", "type": "text/plain",
        "size_bytes": 14, "has_content": True,
    }]
    assert report["client_metadata_file"] == "client_metadata.json"
    assert report["client_metadata_summary"] == {
        "captured_at": "2026-10-02T15:04:05.000Z", "browser": "Chrome 131.0", "os": "macOS 15.1",
        "app_version": "v0.2026.10.02.812.6b91b", "page": "/advanced-xas/app",
        "storage_bytes": len(json.dumps({"xraylarch-web.theme": "dark"})) + 2,
    }
    assert report["project_state_file"] == "project_state.json"
    assert report["project_state_summary"]["mode"] == "local"
    assert report["app"]["name"] == "xraylarch-web"
    assert not [p for p in (tmp_path / "bug_reports").iterdir() if p.name.startswith(".stage-")]


def test_report_adds_project_summary_transcript_and_export(client, tmp_path):
    project = client.post("/api/athena/projects").json()
    client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "example", "group_ids": [], "options": {}})
    loaded = client.get(f"/api/athena/projects/{project['id']}?view=summary").json()
    assert loaded["counts"]["groups"] > 0

    response = submit(
        client, type="feedback", project_id=project["id"], attach_project="true",
        project_state=json.dumps({"mode": "local", "project": {"id": project["id"], "name": loaded["name"], "version": loaded["version"], "groups": []}}),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["project_export_attached"] is True and body["report_id"].startswith("feedback_")
    report_dir = tmp_path / "bug_reports" / body["report_id"]
    report = read_report(tmp_path, body["report_id"])

    state = json.loads((report_dir / "project_state.json").read_text())
    assert state["summary"]["id"] == project["id"]
    assert state["summary"]["counts"]["groups"] == loaded["counts"]["groups"]
    assert "mu" not in state["summary"]["groups"][0] and state["summary"]["groups"][0]["points"] > 0
    assert [record["action"] for record in state["transcript"]][-1] == "example"
    assert report["project_state_summary"]["group_count"] == loaded["counts"]["groups"]
    assert report["project_state_summary"]["transcript_records"] == len(state["transcript"])

    exported = json.loads((report_dir / "project_export.json").read_bytes())
    assert exported["id"] == project["id"] and len(exported["groups"]) == loaded["counts"]["groups"]
    assert report["project_export_file"] == "project_export.json"
    assert report["project_export_bytes"] == (report_dir / "project_export.json").stat().st_size


def test_missing_project_still_files_and_records_the_failure(client, tmp_path):
    response = submit(client, project_id="gone", attach_project="true", project_state=json.dumps({"mode": "local"}))
    assert response.status_code == 200, response.text
    report = read_report(tmp_path, response.json()["report_id"])
    assert response.json()["project_export_attached"] is False
    assert report["project_export_error"]
    state = json.loads((tmp_path / "bug_reports" / report["report_id"] / "project_state.json").read_text())
    assert state["summary_error"] and ("transcript_error" in state or state["transcript"] == [])


@pytest.mark.parametrize(("fields", "field"), [
    ({"description": "   "}, "description"),
    ({"user_email": "not-an-address"}, "user_email"),
    ({"user_email": ""}, "user_email"),
    ({"type": "praise"}, "type"),
    ({"client_metadata": "{not json"}, "client_metadata"),
    ({"project_state": "[1, 2]"}, "project_state"),
])
def test_invalid_fields_are_refused_without_writing(client, tmp_path, fields, field):
    response = submit(client, **fields)
    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["code"] == "bug_report_invalid" and error["fields"] == [field]
    assert not (tmp_path / "bug_reports").exists()


def test_screenshot_count_and_size_limits(client, tmp_path):
    too_many = [("screenshots", (f"s{i}.png", b"x", "image/png")) for i in range(MAX_SCREENSHOTS + 1)]
    response = submit(client, files=too_many)
    assert response.status_code == 400 and response.json()["error"]["fields"] == ["screenshots"]

    oversized = submit(client, files=[("screenshots", ("big.png", b"x" * (MAX_SCREENSHOT_BYTES + 1), "image/png"))])
    assert oversized.status_code == 400, oversized.text
    assert oversized.json()["error"]["code"] == "bug_report_invalid"
    assert oversized.json()["error"]["fields"] == ["screenshots"]
    assert not (tmp_path / "bug_reports").exists()


def test_unrecognised_client_metadata_is_dropped_not_refused(client, tmp_path):
    response = submit(client, client_metadata=json.dumps({"schema_version": 2, "storage": {}}))
    assert response.status_code == 200, response.text
    report = read_report(tmp_path, response.json()["report_id"])
    assert "client_metadata_file" not in report
    assert normalize_client_metadata(metadata(storage={"local_storage": {"k": 1}, "session_storage": {}})) is None
    assert normalize_client_metadata(metadata()) is not None


def test_oversized_report_body_is_capped_by_middleware(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path, bug_report_max_bytes=1_000))) as client:
        # The cap allows 64 KiB of multipart overhead on top of the configured bytes.
        response = submit(client, files=[("attachments", ("log.txt", b"y" * 200_000, "text/plain"))])
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "upload_too_large"


def test_report_ids_sort_by_time_and_prefix_by_kind():
    assert new_report_id("bug").startswith("bug_") and new_report_id("feature_request").startswith("bug_")
    assert new_report_id("feedback").startswith("feedback_")
    report_id = new_report_id("bug")
    stamp, suffix = report_id[len("bug_"):].rsplit("_", 1)
    assert len(stamp) == 15 and len(suffix) == 8


def test_slack_notification_is_off_without_configuration(client, tmp_path, monkeypatch):
    posted = []
    monkeypatch.setattr(bug_report_notify, "post_message", lambda *args: posted.append(args) or True)
    assert submit(client).status_code == 200
    assert posted == []


def test_slack_notification_posts_after_a_configured_submit(tmp_path, monkeypatch):
    monkeypatch.setenv("XRAYLARCH_SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("XRAYLARCH_BUGREPORT_SLACK_CHANNEL", "C0123")
    posted = []
    monkeypatch.setattr(bug_report_notify, "post_message", lambda channel, token, text: posted.append((channel, token, text)) or True)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        response = submit(
            client, type="feature_request", description="Please add <b>bold</b> & more",
            project_state=json.dumps({"project": {"name": "Cu series", "groups": [{}, {}]}}),
            files=[("screenshots", ("a.png", b"x", "image/png"))],
        )
    assert response.status_code == 200, response.text
    assert len(posted) == 1
    channel, token, text = posted[0]
    assert (channel, token) == ("C0123", "xoxb-test")
    assert text.startswith("💡 *New feature request*  ·  XrayLarch Web  ·  from ana@example.org")
    assert "> Please add &lt;b&gt;bold&lt;/b&gt; &amp; more" in text
    assert text.endswith(f"`{response.json()['report_id']}`  ·  project Cu series, 2 groups, 1 screenshot")


def test_slack_post_failure_is_swallowed(monkeypatch):
    monkeypatch.setenv("XRAYLARCH_SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("XRAYLARCH_BUGREPORT_SLACK_CHANNEL", "C0123")

    class Refused(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["auth"] = request.get_header("Authorization")
        captured["body"] = json.loads(request.data)
        return Refused(b'{"ok": false, "error": "not_in_channel"}')

    monkeypatch.setattr(bug_report_notify.urllib.request, "urlopen", fake_urlopen)
    assert bug_report_notify.notify_new_report({"report_id": "bug_1", "type": "bug", "description": "x"}) is False
    assert captured["url"] == bug_report_notify.SLACK_POST_MESSAGE_URL
    assert captured["auth"] == "Bearer xoxb-test"
    assert captured["body"]["channel"] == "C0123" and captured["body"]["unfurl_links"] is False

    def broken(request, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(bug_report_notify.urllib.request, "urlopen", broken)
    assert bug_report_notify.notify_new_report({"report_id": "bug_1", "type": "bug"}) is False


def test_settings_validate_the_bug_report_cap(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="XRAYLARCH_BUG_REPORT_MAX_BYTES"):
        Settings(data_root=tmp_path, bug_report_max_bytes=0)
    monkeypatch.setenv("XRAYLARCH_BUG_REPORT_MAX_BYTES", "12345")
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    assert Settings.from_environment().bug_report_max_bytes == 12345
    assert os.environ["XRAYLARCH_BUG_REPORT_MAX_BYTES"] == "12345"
