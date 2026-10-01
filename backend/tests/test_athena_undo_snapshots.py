"""Undo/redo snapshots are full project copies; only the listed ones may stay on disk."""
from __future__ import annotations

import json

from fastapi.testclient import TestClient
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def _snapshots(tmp_path, ident):
    directory = tmp_path / "athena" / ident
    return sorted(path.name for path in directory.iterdir()
                  if path.name.startswith(("undo-", "redo-")))


def _rename(client, project, name):
    response = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "project", "group_ids": [], "options": {"name": name}})
    assert response.status_code == 200, response.text
    return response.json()


def _step(client, project, action):
    response = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": action, "group_ids": [], "options": {}})
    assert response.status_code == 200, response.text
    return response.json()


def test_only_listed_undo_and_redo_snapshots_remain_on_disk(tmp_path):
    client = TestClient(create_app(Settings(data_root=tmp_path)))
    project = client.post("/api/athena/projects").json()
    for index in range(35):
        project = _rename(client, project, f"name {index}")
    assert len(project["undo"]) == 30
    assert _snapshots(tmp_path, project["id"]) == sorted(project["undo"])

    # Undo consumes its snapshot and records a redo snapshot in its place.
    project = _step(client, project, "undo")
    project = _step(client, project, "undo")
    assert project["name"] == "name 32"
    assert len(project["redo"]) == 2
    assert _snapshots(tmp_path, project["id"]) == sorted(project["undo"] + project["redo"])

    project = _step(client, project, "redo")
    assert project["name"] == "name 33"
    assert _snapshots(tmp_path, project["id"]) == sorted(project["undo"] + project["redo"])

    # A new edit clears Redo, and its files with it.
    project = _rename(client, project, "branch")
    assert project["redo"] == []
    assert _snapshots(tmp_path, project["id"]) == sorted(project["undo"])

    # Everything still listed restores correctly.
    project = _step(client, project, "undo")
    assert project["name"] == "name 33"


def test_next_save_removes_snapshots_leaked_by_earlier_versions(tmp_path):
    client = TestClient(create_app(Settings(data_root=tmp_path)))
    project = _rename(client, client.post("/api/athena/projects").json(), "first")
    directory = tmp_path / "athena" / project["id"]
    (directory / "undo-9999.json").write_text("{}")
    (directory / "redo-9998.json").write_text("{}")
    (directory / "undo-notes.txt").write_text("not a snapshot")

    project = _rename(client, project, "second")
    assert _snapshots(tmp_path, project["id"]) == sorted(project["undo"] + ["undo-notes.txt"])


def test_failed_analysis_restore_preserves_history_until_successful_retry(tmp_path, monkeypatch):
    store = AthenaStore(Settings(data_root=tmp_path))
    source = store.create()
    payload = json.loads(store.export_project(source["id"], "json"))
    payload["analyses"] = [{
        "group_ids": ["missing-group"], "result": {}, "options": {}, "project_version": 0,
    }]
    data = json.dumps(payload).encode()

    project = store.create()
    for name in ("one", "two"):
        project = store.command(project["id"], Command(
            version=project["version"], action="project", options={"name": name}))
    project = store.command(project["id"], Command(version=project["version"], action="undo"))
    before = store.load(project["id"])
    assert before["undo"] and before["redo"]

    write_json = store.storage.write_json
    failed = False

    def fail_once(ident, name, content):
        nonlocal failed
        if name == "analyses.json" and not failed:
            failed = True
            raise OSError("simulated sidecar failure")
        return write_json(ident, name, content)

    monkeypatch.setattr(store.storage, "write_json", fail_once)
    with pytest.raises(OSError, match="simulated sidecar failure"):
        store.restore(project["id"], project["version"], data, "source.json")
    assert store.load(project["id"]) == before
    assert _snapshots(tmp_path, project["id"]) == sorted(before["undo"] + before["redo"])

    redone = store.command(project["id"], Command(version=project["version"], action="redo"))
    assert redone["name"] == "two"
    undone = store.command(project["id"], Command(version=redone["version"], action="undo"))
    assert undone["name"] == "one"
    restored = store.restore(project["id"], undone["version"], data, "source.json")
    assert restored["analyses"]
    assert _snapshots(tmp_path, project["id"]) == sorted(restored["undo"] + restored["redo"])


def test_snapshot_cleanup_error_does_not_fail_committed_save(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    directory = tmp_path / "athena" / project["id"]
    (directory / "undo-9999.json").mkdir()
    (directory / "redo-9998.json").write_text("{}")

    saved = store.command(project["id"], Command(
        version=project["version"], action="project", options={"name": "saved"}))
    assert store.load(project["id"]) == saved
    assert saved["name"] == "saved"
    assert (directory / "undo-9999.json").is_dir()
    assert not (directory / "redo-9998.json").exists()
