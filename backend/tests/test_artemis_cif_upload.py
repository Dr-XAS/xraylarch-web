"""User CIFs retain their source, geometry and identity through project exchange."""
import copy
import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from test_artemis_attachments import store
from xraylarch_web import artemis_attachments as attachments
from xraylarch_web import artemis_structures as structures
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def cif():
    return structures.structure_details(13088)["cif"]


def upload(store, project, cif, filename="my-copper.cif"):
    return attachments.attach_structure(store, project["id"], attachments.AttachRequest(
        version=project["version"], provider="uploaded", filename=filename, cif=cif))


def test_minimal_custom_cif_without_database_metadata_uses_filename_and_parsed_formula(store):
    cif = """data_custom
_cell_length_a 3.6
_cell_length_b 3.6
_cell_length_c 3.6
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Cu1 Cu 0.125 0.25 0.375
"""
    project = upload(store, store.create(), cif, "custom-cell.cif")
    details = project["artemis_structures"][0]["structure"]
    assert details["mineral"] == "custom-cell.cif"
    assert details["formula"] == "Cu" and details["supported"]
    assert details["cell"]["a"] == pytest.approx(3.6)
    assert details["cif"] == cif
    assert details["year"] is None and details["authors"] == ""


def test_upload_retains_text_and_filename_and_is_versioned_persistent_and_undoable(store, cif):
    original = store.create()
    project = upload(store, original, cif)
    record = project["artemis_structures"][0]
    details = record["structure"]
    assert record["provider"] == details["provider"] == "uploaded"
    assert record["sha256"] == hashlib.sha256(cif.encode()).hexdigest()
    assert details["id"] == "cif-" + record["sha256"]
    assert details["filename"] == details["source"] == "my-copper.cif"
    assert details["cif"] == cif
    assert details["formula"] == "Cu" and details["supported"]
    assert details["sites"] == structures.structure_details(13088)["sites"]
    assert details["cell"] == structures.structure_details(13088)["cell"]
    assert project["version"] == 1 and project["groups"] == []
    assert AthenaStore(store.settings).load(project["id"]) == project
    assert upload(store, project, cif, "renamed.cif") == project
    with pytest.raises(WebInputError, match="changed"):
        upload(store, original, cif)
    undone = store.command(project["id"], Command(version=1, action="undo"))
    assert not undone.get("artemis_structures")
    redone = store.command(project["id"], Command(version=undone["version"], action="redo"))
    assert redone["artemis_structures"] == project["artemis_structures"]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_upload_exchange_and_merge_keep_distinct_content_with_same_filename(store, cif, format):
    project = upload(store, store.create(), cif)
    project = upload(store, project, cif + "\n# second snapshot\n")
    project = attachments.attach_structure(store, project["id"], attachments.AttachRequest(version=2, amcsd_id=13088))
    payload = store.export_project(project["id"], format)
    restored = store.restore(store.create()["id"], 0, payload, f"saved.{format}")
    assert restored["artemis_structures"] == project["artemis_structures"]
    merged = store.restore(restored["id"], restored["version"], payload, f"same.{format}")
    assert merged["artemis_structures"] == restored["artemis_structures"]


@pytest.mark.parametrize("change", ["filename", "extension", "empty", "path", "nul", "too_large", "bytes", "malformed", "multiple", "database_id", "wrong_provider"])
def test_invalid_uploads_fail_without_changing_project(store, cif, change):
    project = store.create()
    body = dict(version=0, provider="uploaded", filename="mine.CIF", cif=cif)
    if change == "filename": body["filename"] = "../mine.cif"
    if change == "extension": body["filename"] = "mine.txt"
    if change == "empty": body["cif"] = ""
    if change == "path": body["cif"] = "/tmp/my-very-long-local-crystal-structure-file.cif"
    if change == "nul": body["cif"] += "\x00"
    if change == "too_large": body["cif"] += "#" * 500_001
    if change == "bytes": body["cif"] += "#" + "é" * 250_000
    if change == "malformed": body["cif"] = "data_empty\n# missing lattice and atomic sites\n"
    if change == "multiple": body["cif"] += "\ndata_another\n_cell_length_a 3.6\n"
    if change == "database_id": body["amcsd_id"] = 13088
    if change == "wrong_provider": body["provider"] = "amcsd"
    with TestClient(create_app(store.settings)) as client:
        response = client.post(f"/api/artemis/projects/{project['id']}/structures", json=body)
    assert response.status_code in (400, 422), response.text
    assert store.load(project["id"]) == project


def test_upload_http_limits_remove_and_draft_restriction(store, cif, monkeypatch):
    project = store.create()
    endpoint = f"/api/artemis/projects/{project['id']}/structures"
    body = dict(version=0, provider="uploaded", filename="mine.CIF", cif=cif)
    with TestClient(create_app(store.settings)) as client:
        response = client.post(endpoint, json=body)
        assert response.status_code == 200, response.text
        project = response.json()
        assert client.post(endpoint, json=body).status_code == 409
        assert client.get(endpoint).json()["structures"] == project["artemis_structures"]
        monkeypatch.setattr(attachments, "MAX_STRUCTURES", 1)
        assert client.post(endpoint, json={**body, "version": 1}).json() == project
        assert client.post(endpoint, json={**body, "version": 1, "cif": cif + "\n# changed"}).status_code == 400
        assert store.load(project["id"]) == project
        removed = client.post(f"{endpoint}/{project['artemis_structures'][0]['id']}/remove", json={"version": 1})
        assert removed.status_code == 200 and removed.json()["artemis_structures"] == []
        project = removed.json()
        project["integration"] = True
        store.storage.write_json(project["id"], "project.json", project)
        assert client.post(endpoint, json={**body, "version": project["version"]}).status_code == 400
        assert store.load(project["id"]) == project


def test_upload_content_identity_cannot_be_forged_on_import(store, cif):
    project = upload(store, store.create(), cif)
    records = copy.deepcopy(project["artemis_structures"])
    records[0]["structure"]["cif"] += "\n# changed"
    records[0]["sha256"] = hashlib.sha256(records[0]["structure"]["cif"].encode()).hexdigest()
    with pytest.raises(WebInputError, match="content ID"):
        attachments.validate_attachments(records)


def test_disordered_upload_is_saved_with_warning_and_feff_is_refused(store):
    cif = structures.structure_details(1735)["cif"]
    project = upload(store, store.create(), cif, "disordered.cif")
    record = project["artemis_structures"][0]
    assert not record["structure"]["supported"] and record["structure"]["warnings"]
    with TestClient(create_app(store.settings)) as client:
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"],
            attachment_id=record["id"], version=project["version"], absorber="Ti", site_index=1))
    assert response.status_code == 400 and "occupancies" in response.json()["error"]["message"]


def test_real_feff_uses_uploaded_snapshot_offline(store, cif, monkeypatch):
    project = upload(store, store.create(), cif)
    record = project["artemis_structures"][0]
    def no_database(*args): pytest.fail("Uploaded CIF generation must not query a database")
    monkeypatch.setattr(structures, "structure_details", no_database)
    with TestClient(create_app(store.settings)) as client:
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"],
            attachment_id=record["id"], version=1, absorber="Cu", site_index=1,
            cluster_radius=3, path_radius=3, max_legs=2))
        assert response.status_code == 202, response.text
        job = response.json()
        deadline = time.monotonic() + 25
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            job = client.get(f"/api/artemis/feff/jobs/{job['id']}").json()
        assert job["status"] == "complete", job
        assert job["paths"][0]["metadata"]["degen"] == 12
        assert job["provenance"]["cif"] == cif
        assert job["provenance"]["cif_sha256"] == record["sha256"]
        assert "Uploaded CIF my-copper.cif" in job["provenance"]["feff_input"]
        assert store.load(project["id"]) == project
