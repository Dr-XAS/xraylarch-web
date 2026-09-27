"""Undo/redo snapshots are full project copies; only the listed ones may stay on disk."""
from __future__ import annotations

from fastapi.testclient import TestClient

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
