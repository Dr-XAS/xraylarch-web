"""Project CIF names persist independently of immutable scientific snapshots."""
import copy
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import artemis_attachments as attachments
from xraylarch_web import materials_project
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture
def project(store):
    return attachments.attach_structure(store, store.create()["id"],
                                        attachments.AttachRequest(version=0, amcsd_id=13088))


def rename(client, project, label, attachment_id=None, version=None):
    attachment_id = attachment_id or project["artemis_structures"][0]["id"]
    return client.post(f"/api/artemis/projects/{project['id']}/structures/{attachment_id}/rename",
                       json={"version": project["version"] if version is None else version, "label": label})


@pytest.mark.parametrize("provider", ["amcsd", "uploaded", "materials_project"])
def test_rename_preserves_source_and_is_persistent_and_undoable(store, project, monkeypatch, provider):
    original_record = project["artemis_structures"][0]
    if provider == "uploaded":
        project = attachments.attach_structure(store, project["id"], attachments.AttachRequest(
            version=project["version"], provider="uploaded", filename="original-copper.cif",
            cif=original_record["structure"]["cif"]))
    elif provider == "materials_project":
        snapshot = copy.deepcopy(original_record["structure"])
        snapshot.update(id="mp-30", provider="materials_project", source="https://materialsproject.org/materials/mp-30",
                        provenance={"database_version": None, "retrieved_at": "2026-10-06T00:00:00Z",
                                    "task_id": None, "structure_type": "dft_relaxed"})
        monkeypatch.setattr(materials_project, "structure_details", lambda ident: snapshot)
        project = attachments.attach_structure(store, project["id"], attachments.AttachRequest(
            version=project["version"], provider="materials_project", material_id="mp-30"))
    record = project["artemis_structures"][-1]
    with TestClient(create_app(store.settings)) as client:
        response = rename(client, project, "  Cu foil · 300 K  ", record["id"])
        assert response.status_code == 200, response.text
        renamed = response.json()
        assert renamed["version"] == project["version"] + 1
        assert renamed["groups"] == project["groups"]
        assert renamed["artemis_structures"][-1] == {**record, "label": "Cu foil · 300 K"}
        assert renamed["artemis_structures"][:-1] == project["artemis_structures"][:-1]
        assert AthenaStore(store.settings).load(project["id"]) == renamed
        listed = client.get(f"/api/artemis/projects/{project['id']}/structures").json()
        assert listed["structures"] == renamed["artemis_structures"]
        assert rename(client, renamed, "Cu foil · 300 K", record["id"]).json() == renamed
    undone = store.command(project["id"], Command(version=renamed["version"], action="undo"))
    assert undone["artemis_structures"] == project["artemis_structures"]
    redone = store.command(project["id"], Command(version=undone["version"], action="redo"))
    assert redone["artemis_structures"] == renamed["artemis_structures"]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_rename_survives_project_exchange_and_keeps_destination_name_on_deduplication(store, project, format):
    attachment_id = project["artemis_structures"][0]["id"]
    renamed = attachments.rename_structure(store, project["id"], attachment_id,
                                          attachments.RenameRequest(version=project["version"], label="Reference Cu"))
    payload = store.export_project(project["id"], format)
    restored = store.restore(store.create()["id"], 0, payload, f"renamed.{format}")
    assert restored["artemis_structures"] == renamed["artemis_structures"]
    destination = attachments.rename_structure(store, restored["id"], attachment_id,
                                              attachments.RenameRequest(version=restored["version"], label="My Cu"))
    merged = store.restore(destination["id"], destination["version"], payload, f"renamed.{format}")
    assert merged["artemis_structures"] == destination["artemis_structures"]


@pytest.mark.parametrize("label", ["", "   ", "x" * 201, "Cu\nfoil", "Cu\tfoil", "Cu\x00foil", "Cu\x7ffoil",
                                  "Cu\x85foil", None, 123, True, []])
def test_invalid_names_leave_project_unchanged(store, project, label):
    with TestClient(create_app(store.settings)) as client:
        response = rename(client, project, label)
    assert response.status_code == 422, response.text
    assert store.load(project["id"]) == project


def test_rename_rejects_stale_missing_foreign_and_integration_changes(store, project):
    foreign = attachments.attach_structure(store, store.create()["id"],
                                          attachments.AttachRequest(version=0, amcsd_id=13088))
    with TestClient(create_app(store.settings)) as client:
        assert rename(client, project, "New name", version=0).status_code == 409
        for ident in ("missing-cif", foreign["artemis_structures"][0]["id"]):
            response = rename(client, project, "New name", ident)
            assert response.status_code == 400
            assert response.json()["error"]["fields"] == ["attachment_id"]
        assert store.load(project["id"]) == project
        assert store.load(foreign["id"]) == foreign
        project["integration"] = True
        store.storage.write_json(project["id"], "project.json", project)
        response = rename(client, project, "New name")
        assert response.status_code == 400
        assert response.json()["error"]["fields"] == ["project"]
    assert store.load(project["id"]) == project


@pytest.mark.parametrize("body", [{"label": "Cu"}, {"version": True, "label": "Cu"},
                                 {"version": "1", "label": "Cu"}, {"version": -1, "label": "Cu"},
                                 {"version": 1, "label": "Cu", "amcsd_id": 13088}])
def test_rename_requires_a_strict_request(store, project, body):
    attachment_id = project["artemis_structures"][0]["id"]
    with TestClient(create_app(store.settings)) as client:
        response = client.post(f"/api/artemis/projects/{project['id']}/structures/{attachment_id}/rename", json=body)
    assert response.status_code == 422
    assert store.load(project["id"]) == project


def test_legacy_snapshots_keep_their_shape_and_imported_names_are_validated(store, project):
    assert "label" not in attachments.validate_attachments(project["artemis_structures"])[0]
    exported = json.loads(store.export_project(project["id"]))
    exported["artemis_structures"][0]["label"] = "bad\nname"
    with pytest.raises(WebInputError, match="control characters"):
        store.restore(project["id"], project["version"], json.dumps(exported).encode(), "bad-name.json")
    assert store.load(project["id"]) == project
