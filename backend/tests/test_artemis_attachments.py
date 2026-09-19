"""CIF attachment transactions, project exchange, and offline snapshot FEFF."""
import copy
import gzip
import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import artemis_attachments as attachments
from xraylarch_web import artemis_structures as structures
from xraylarch_web.artemis_attachments import AttachRequest, attach_structure, validate_attachments
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def attach(store, project, ident=13088):
    return attach_structure(store, project["id"], AttachRequest(version=project["version"], amcsd_id=ident))


def test_attach_is_persistent_idempotent_versioned_and_undoable(store):
    project = store.create()
    first = attach(store, project)
    record = first["artemis_structures"][0]
    assert first["version"] == 1 and first["groups"] == project["groups"]
    assert record["amcsd_id"] == record["structure"]["id"] == 13088
    assert record["sha256"] == hashlib.sha256(record["structure"]["cif"].encode()).hexdigest()
    assert AthenaStore(store.settings).load(first["id"]) == first
    assert attach(store, first) == first
    with pytest.raises(WebInputError, match="changed"):
        attach(store, project)
    undone = store.command(first["id"], Command(version=first["version"], action="undo"))
    assert undone.get("artemis_structures", []) == []
    redone = store.command(first["id"], Command(version=undone["version"], action="redo"))
    assert redone["artemis_structures"] == first["artemis_structures"]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_full_and_subset_exchange_preserve_cif_snapshots_and_merge_destinations(store, format):
    project = store.create()
    project = store.command(project["id"], Command(version=0, action="example"))
    project = attach(store, project)
    payload = store.export_project(project["id"], format)
    if format == "prj":
        expanded = gzip.decompress(payload).decode()
        assert '"artemis_structures"' in next(line for line in expanded.splitlines() if line.startswith("# Athena-Web "))
    restored = store.restore(store.create()["id"], 0, payload, f"saved.{format}")
    assert restored["artemis_structures"] == project["artemis_structures"]
    assert len(restored["groups"]) == len(project["groups"])
    destination = attach(store, store.create(), 9994)
    merged = store.restore(destination["id"], destination["version"], payload, f"saved.{format}", [project["groups"][0]["id"]])
    assert [record["amcsd_id"] for record in merged["artemis_structures"]] == [9994, 13088]
    assert len(merged["groups"]) == 1
    # Export only one spectrum; structure snapshots remain project-owned.
    subset = store.export_project(project["id"], format, [project["groups"][0]["id"]])
    subset_project = store.restore(store.create()["id"], 0, subset, f"subset.{format}")
    assert subset_project["artemis_structures"] == project["artemis_structures"]


def test_cif_only_project_roundtrip_and_import_deduplication(store):
    project = attach(store, store.create())
    for format in ("json", "prj"):
        restored = store.restore(store.create()["id"], 0, store.export_project(project["id"], format), f"cif-only.{format}")
        assert restored["groups"] == []
        assert restored["artemis_structures"] == project["artemis_structures"]
    imported = store.restore(project["id"], project["version"], store.export_project(project["id"]), "same.json")
    assert len(imported["artemis_structures"]) == 1


@pytest.mark.parametrize("change", ["checksum", "server_path", "duplicate", "over_count", "nonfinite", "unsupported_field", "id_mismatch"])
def test_malformed_import_snapshots_are_transactionally_rejected(store, change):
    project = attach(store, store.create())
    document = json.loads(store.export_project(project["id"]))
    record = document["artemis_structures"][0]
    if change == "checksum": record["structure"]["cif"] += "\n# changed"
    elif change == "server_path":
        record["structure"]["cif"] = "/etc/passwd"
        record["sha256"] = hashlib.sha256(record["structure"]["cif"].encode()).hexdigest()
    elif change == "duplicate": document["artemis_structures"].append(copy.deepcopy(record))
    elif change == "over_count": document["artemis_structures"] *= 21
    elif change == "nonfinite": record["structure"]["cell"]["a"] = float("inf")
    elif change == "unsupported_field": record["structure"]["exec"] = "print('unsafe')"
    elif change == "id_mismatch": record["amcsd_id"] = 9994
    destination = store.create()
    with pytest.raises(WebInputError):
        store.restore(destination["id"], 0, json.dumps(document).encode(), "malformed.json")
    assert store.load(destination["id"]) == destination


def test_snapshot_byte_limit_and_conflicting_snapshot_import_preserve_project(store, monkeypatch):
    project = attach(store, store.create())
    document = json.loads(store.export_project(project["id"]))
    record = document["artemis_structures"][0]
    record["structure"]["cif"] += "\n# same AMCSD ID, different snapshot\n"
    record["sha256"] = hashlib.sha256(record["structure"]["cif"].encode()).hexdigest()
    with pytest.raises(WebInputError, match="different CIF"):
        store.restore(project["id"], project["version"], json.dumps(document).encode(), "changed.json")
    assert store.load(project["id"]) == project
    monkeypatch.setattr(attachments, "MAX_STRUCTURE_BYTES", 100)
    with pytest.raises(WebInputError, match="4 MB"):
        validate_attachments(document["artemis_structures"])


def test_http_attachment_and_integration_draft_denials(store):
    project = store.create()
    endpoint = f"/api/artemis/projects/{project['id']}/structures"
    with TestClient(create_app(store.settings)) as client:
        assert client.get(endpoint).json() == dict(project_id=project["id"], version=0, structures=[])
        attached = client.post(endpoint, json=dict(version=0, amcsd_id=13088))
        assert attached.status_code == 200, attached.text
        project = attached.json()
        assert client.get(endpoint).json()["structures"] == project["artemis_structures"]
        assert client.post(endpoint, json=dict(version=1, amcsd_id=13088)).json() == project
        assert client.post(endpoint, json=dict(version=0, amcsd_id=13088)).status_code == 409
        project["integration"] = True
        store.storage.write_json(project["id"], "project.json", project)
        assert client.get(endpoint).status_code == 400
        assert client.post(endpoint, json=dict(version=1, amcsd_id=9994)).status_code == 400
        denied = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"],
            attachment_id=project["artemis_structures"][0]["id"], version=1, absorber="Cu", site_index=1))
        assert denied.status_code == 400 and "local project" in denied.json()["error"]["message"]


def test_native_feff_uses_saved_cif_when_database_is_unavailable(store, monkeypatch):
    project = attach(store, store.create())
    record = project["artemis_structures"][0]
    def no_database(*args): pytest.fail("Attached CIF generation must not re-query AMCSD")
    monkeypatch.setattr(structures, "structure_details", no_database)
    with TestClient(create_app(store.settings)) as client:
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"],
            attachment_id=record["id"], version=project["version"], absorber="Cu", site_index=1,
            cluster_radius=3, path_radius=3, max_legs=2))
        assert response.status_code == 202, response.text
        job = response.json()
        deadline = time.monotonic() + 25
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            job = client.get(f"/api/artemis/feff/jobs/{job['id']}").json()
        assert job["status"] == "complete", job
        assert job["paths"][0]["metadata"]["degen"] == 12
        assert job["provenance"]["cif"] == record["structure"]["cif"]
        assert job["provenance"]["cif_sha256"] == record["sha256"]
        assert job["provenance"]["source_revision"] == project["version"]
        assert job["provenance"]["attachment_id"] == record["id"]
        assert "AMCSD structure 13088" in job["provenance"]["feff_input"]
        assert store.load(project["id"]) == project


def test_imported_supported_flag_does_not_bypass_cif_occupancy_validation(store):
    project = attach(store, store.create(), 1735)
    record = project["artemis_structures"][0]
    record["structure"].update(supported=True, ordered=True, warnings=[])
    store.storage.write_json(project["id"], "project.json", project)
    with TestClient(create_app(store.settings)) as client:
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"],
            attachment_id=record["id"], version=project["version"], absorber="Ti", site_index=1))
    assert response.status_code == 400 and "occupancies" in response.json()["error"]["message"]


def test_extreme_cell_is_rejected_before_neighbor_allocation(monkeypatch):
    from types import SimpleNamespace
    from pymatgen.core import Lattice, Structure

    cell = Structure(Lattice.orthorhombic(0.00001, 1000, 1000), ["Cu"], [[0, 0, 0]])
    def no_allocation(*args, **kwargs): pytest.fail("Extreme cells must fail before periodic neighbor allocation")
    monkeypatch.setattr(cell, "get_sites_in_sphere", no_allocation)
    monkeypatch.setattr(structures, "CIF_Cluster", lambda **kwargs: SimpleNamespace(struct=cell, unique_sites=[(cell[0], 1, "1a")]))
    with pytest.raises(WebInputError, match="too many periodic atoms"):
        structures._prepare_input(structures.FeffJobRequest(amcsd_id=13088, absorber="Cu", site_index=1), {"cif": "unused", "id": 13088})
