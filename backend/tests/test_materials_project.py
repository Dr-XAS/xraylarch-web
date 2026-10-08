"""MP transport contract, project exchange, and FEFF from saved CIFs."""
import copy
import hashlib
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from httpx import Client as HttpClient
from pymatgen.core import Lattice, Structure

from xraylarch_web import materials_project as mp
from xraylarch_web.artemis_attachments import (
    AttachRequest, attach_structure, merge_attachments, structure_attachment, validate_attachments,
)
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def upstream(monkeypatch):
    monkeypatch.setenv("MP_API_KEY", "test-server-only-secret")
    mp._CACHE.clear()
    requests = []
    copper = Structure.from_spacegroup("Fm-3m", Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])
    document = dict(material_id="mp-aaaaaaft", formula_pretty="Cu", symmetry={"symbol": "Fm-3m"},
                    structure=copper.as_dict(), origins=[dict(name="structure", task_id="task-copper")])

    def handler(request):
        requests.append(request)
        if request.url.path == "/heartbeat":
            return httpx.Response(200, json={"db_version": "test-2026"})
        row = copy.deepcopy(document)
        if request.url.params.get("id_format") == "legacy":
            row["material_id"] = "mp-30"
        return httpx.Response(200, json={"data": [row], "meta": {"total_doc": 1}})

    client = httpx.Client
    monkeypatch.setattr(mp.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    yield requests, document
    mp._CACHE.clear()


@pytest.mark.parametrize("query,element,expected", [
    ("Cu2O", "", {"formula": "Cu2O"}), ("Cu-O", "", {"chemsys": "Cu-O"}),
    ("", "cu", {"elements": "Cu"}), ("Cu", "", {"formula": "Cu"}),
    ("mp-30", "", {"material_ids": "mp-30"}), ("mp-aaaaaaft", "", {"material_ids": "mp-aaaaaaft"}),
    ("Cu2O", "Cu", {"formula": "Cu2O", "elements": "Cu"}),
])
def test_search_contract_key_confinement_and_cache(upstream, query, element, expected):
    requests, _ = upstream
    response = mp.search_structures(query, element, 5)
    assert response["results"][0]["provider"] == "materials_project"
    request = requests[0]
    for key, value in expected.items():
        assert request.url.params[key] == value
    assert request.url.params["_limit"] == "6"
    assert request.url.params["_skip"] == "0"
    assert "structure" not in request.url.params["_fields"].split(",")
    assert request.headers["x-api-key"] == "test-server-only-secret"
    assert "secret" not in str(request.url) and "secret" not in str(response)
    assert mp.search_structures(query, element, 5) == response
    if query == "Cu2O":
        assert len(requests) == 2
        assert requests[1].url.params["chemsys"] == "Cu-O"
        assert "formula" not in requests[1].url.params
        if element:
            assert requests[1].url.params["elements"] == element
    else:
        assert len(requests) == 1


def _search_upstream(monkeypatch, exact, broad, *, broad_total=None):
    """Serve separate bounded pages, just as the upstream formula/system filters do."""
    monkeypatch.setenv("MP_API_KEY", "test-server-only-secret")
    mp._CACHE.clear()
    requests = []

    def handler(request):
        requests.append(request)
        rows = exact if "formula" in request.url.params else broad
        metadata = {"total_doc": len(rows)}
        if "chemsys" in request.url.params and broad_total is not None:
            metadata["total_doc"] = broad_total
        return httpx.Response(200, json={"data": rows, "meta": metadata})

    monkeypatch.setattr(mp.httpx, "Client", lambda **kwargs: HttpClient(transport=httpx.MockTransport(handler), **kwargs))
    return requests


def _search_document(ident, formula):
    return dict(material_id=ident, formula_pretty=formula, symmetry={"symbol": "P1"})


def test_formula_search_finds_different_proportions_and_preserves_exact_priority(monkeypatch):
    exact = _search_document("mp-1", "LiMnNiO2")
    fractional = _search_document("mp-2", "LiMn0.5Ni0.5O2")
    other = _search_document("mp-3", "Li2MnNiO3")
    # The exact result is outside the fetched chemical-system page.
    requests = _search_upstream(monkeypatch, [exact], [fractional, other], broad_total=100)
    response = mp.search_structures("LiMnNiO2", "Ni", limit=2)
    assert [row["id"] for row in response["results"]] == ["mp-1", "mp-2"]
    assert response["limited"] is True
    assert len(requests) == 2
    assert requests[0].url.params["formula"] == "LiMnNiO2"
    assert requests[1].url.params["chemsys"] == "Li-Mn-Ni-O"
    for request in requests:
        assert request.url.params["elements"] == "Ni"
        assert request.url.params["_limit"] == "3"
        assert request.url.params["_skip"] == "0"
        assert "structure" not in request.url.params["_fields"].split(",")


def test_formula_search_uses_reduced_integer_formula_and_ranks_equivalent_stoichiometry(monkeypatch):
    equivalent = _search_document("mp-1", "Li2MnNiO4")
    different = _search_document("mp-2", "LiMnNiO2")
    exact_reordered = _search_document("mp-3", "Ni0.5Mn0.5LiO2")
    requests = _search_upstream(monkeypatch, [equivalent], [different, equivalent, exact_reordered])
    response = mp.search_structures("LiMn0.5Ni0.5O2", limit=3)
    assert requests[0].url.params["formula"] == "Li2MnNiO4"
    assert [row["id"] for row in response["results"]] == ["mp-3", "mp-1", "mp-2"]
    assert response["count"] == 3
    assert response["limited"] is False  # The overlapping MP ID is one result.


def test_formula_search_with_no_exact_match_still_returns_the_chemical_system(monkeypatch):
    _search_upstream(monkeypatch, [], [_search_document("mp-1", "LiMn0.5Ni0.5O2")])
    response = mp.search_structures("LiMnNiO2")
    assert response["results"][0]["formula"] == "LiMn0.5Ni0.5O2"
    assert response["limited"] is False


def test_search_limited_uses_upstream_total_when_page_is_short(monkeypatch):
    row = _search_document("mp-1", "LiMnNiO2")
    _search_upstream(monkeypatch, [row], [row], broad_total=10)
    response = mp.search_structures("LiMnNiO2", limit=5)
    assert response["count"] == 1
    assert response["limited"] is True


def test_duplicate_records_do_not_create_false_truncation(monkeypatch):
    row = _search_document("mp-1", "Cu")
    _search_upstream(monkeypatch, [row, row], [])
    response = mp.search_structures("Cu", limit=1)
    assert response["count"] == 1
    assert response["limited"] is False


@pytest.mark.parametrize("query,element", [("copper", ""), ("", ""), ("Cu-*", ""), ("Cu-XX", ""), ("Cu", "Xx"), ("mp-invalid", "")])
def test_invalid_queries_do_not_reach_upstream(upstream, query, element):
    with pytest.raises(WebInputError, match="chemical formula"):
        mp.search_structures(query, element)
    assert upstream[0] == []


def test_missing_key_is_actionable_and_does_not_call_network(upstream, monkeypatch):
    monkeypatch.delenv("MP_API_KEY")
    with pytest.raises(WebInputError, match="MP_API_KEY") as error:
        mp.search_structures("Cu")
    assert error.value.code == "materials_project_not_configured"
    assert upstream[0] == []


@pytest.mark.parametrize("status,code", [(401, "materials_project_auth"), (403, "materials_project_auth"),
    (400, "invalid_materials_project_query"), (422, "invalid_materials_project_query"),
    (429, "materials_project_rate_limit"), (503, "materials_project_unavailable")])
def test_upstream_failures_are_sanitized(monkeypatch, status, code):
    monkeypatch.setenv("MP_API_KEY", "failure-test-secret")
    mp._CACHE.clear()
    client = httpx.Client
    monkeypatch.setattr(mp.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(
        lambda request: httpx.Response(status, text="upstream body with failure-test-secret")), **kwargs))
    with pytest.raises(WebInputError) as error:
        mp.search_structures("Cu")
    assert error.value.code == code
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("payload", [{}, {"data": None}, {"data": [{}]}, {"data": "not records"}])
def test_malformed_responses_are_not_empty_results(monkeypatch, payload):
    monkeypatch.setenv("MP_API_KEY", "malformed-test-secret")
    mp._CACHE.clear()
    client = httpx.Client
    monkeypatch.setattr(mp.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload)), **kwargs))
    with pytest.raises(WebInputError):
        mp.search_structures("Cu")


@pytest.mark.parametrize("ident", ["mp-30", "mp-aaaaaaft"])
def test_cif_preserves_cell_and_provenance(upstream, ident):
    details = mp.structure_details(ident)
    assert details["id"] == ident
    assert details["provider"] == "materials_project" and details["supported"]
    assert details["cell"]["a"] == pytest.approx(3.61)
    assert details["provenance"]["database_version"] == "test-2026"
    assert details["provenance"]["task_id"] == "task-copper"
    assert details["source"] == f"https://materialsproject.org/materials/{ident}"
    assert details["provenance"]["retrieved_at"] == mp.structure_details(ident)["provenance"]["retrieved_at"]


@pytest.mark.parametrize("field,value", [("symmetry", {"symbol": {"bad": 1}}), ("origins", 42),
    ("origins", [{"name": "structure", "task_id": {"bad": 1}}])])
def test_optional_metadata_is_validated(upstream, field, value):
    upstream[1][field] = value
    with pytest.raises(WebInputError):
        mp.structure_details("mp-aaaaaaft")


def test_search_truncation_and_detail_without_database_version(monkeypatch, upstream):
    document = upstream[1]
    def handler(request):
        if request.url.path == "/heartbeat":
            return httpx.Response(503)
        rows = [document]
        if "structure" not in request.url.params["_fields"].split(","):
            rows.append(document | {"material_id": "mp-2"})
        return httpx.Response(200, json={"data": rows})
    monkeypatch.setattr(mp.httpx, "Client", lambda **kwargs: HttpClient(transport=httpx.MockTransport(handler), **kwargs))
    result = mp.search_structures("Cu", limit=1)
    assert result["count"] == 1 and result["limited"] is True
    assert mp.structure_details("mp-aaaaaaft")["provenance"]["database_version"] is None


def mp_attach(store, project):
    return attach_structure(store, project["id"], AttachRequest(version=project["version"],
                            provider="materials_project", material_id="mp-aaaaaaft"))


@pytest.mark.parametrize("format", ["json", "prj"])
def test_mixed_provider_roundtrip_undo_remove_and_legacy_compatibility(upstream, tmp_path, format):
    store = AthenaStore(Settings(data_root=tmp_path))
    legacy = structure_attachment(13088)
    assert validate_attachments([legacy]) == [legacy]
    assert "provider" not in legacy and "provenance" not in legacy["structure"]
    project = mp_attach(store, store.create())
    assert mp_attach(store, project) == project
    project = attach_structure(store, project["id"], AttachRequest(version=project["version"], amcsd_id=13088))
    restored = store.restore(store.create()["id"], 0, store.export_project(project["id"], format), f"mixed.{format}")
    assert restored["artemis_structures"] == project["artemis_structures"]
    assert merge_attachments(restored["artemis_structures"], project["artemis_structures"]) == project["artemis_structures"]
    record = project["artemis_structures"][0]
    with TestClient(create_app(store.settings)) as client:
        response = client.post(f"/api/artemis/projects/{project['id']}/structures/{record['id']}/remove", json={"version": project["version"]})
    assert response.status_code == 200
    removed = response.json()
    undone = store.command(project["id"], Command(version=removed["version"], action="undo"))
    assert undone["artemis_structures"] == project["artemis_structures"]
    redone = store.command(project["id"], Command(version=undone["version"], action="redo"))
    assert redone["artemis_structures"] == removed["artemis_structures"]


@pytest.mark.parametrize("change", ["id", "provider", "mixed", "nested", "checksum", "duplicate"])
def test_rejects_inconsistent_mp_snapshots(upstream, change):
    record = structure_attachment(material_id="mp-aaaaaaft")
    records = [record]
    if change == "id": record["material_id"] = "mp-149"
    elif change == "provider": record["provider"] = "amcsd"
    elif change == "mixed": record["amcsd_id"] = 13088
    elif change == "nested": record["structure"]["provider"] = "amcsd"
    elif change == "checksum": record["structure"]["cif"] += "\n# changed"
    elif change == "duplicate": records.append(copy.deepcopy(record))
    with pytest.raises(WebInputError):
        validate_attachments(records)


def test_conflicting_snapshot_and_example_with_existing_mp(upstream, tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = mp_attach(store, store.create())
    record = copy.deepcopy(project["artemis_structures"][0])
    record["structure"]["cif"] += "\n# different snapshot\n"
    record["sha256"] = hashlib.sha256(record["structure"]["cif"].encode()).hexdigest()
    with pytest.raises(WebInputError, match="different CIF"):
        merge_attachments(project["artemis_structures"], [record])
    example = store.command(project["id"], Command(version=project["version"], action="example"))
    assert example["artemis_structures"][0] == project["artemis_structures"][0]
    assert example["artemis_structures"][1]["amcsd_id"] == 15851


def test_http_search_attach_and_offline_native_feff(upstream, tmp_path, monkeypatch):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    with TestClient(create_app(store.settings)) as client:
        search = client.get("/api/artemis/structures", params={"provider": "materials_project", "q": "Cu"})
        assert search.status_code == 200
        ident = search.json()["results"][0]["id"]
        detail = client.get(f"/api/artemis/structures/{ident}?provider=materials_project")
        assert detail.status_code == 200 and detail.json()["supported"]
        response = client.post(f"/api/artemis/projects/{project['id']}/structures", json=dict(version=0, provider="materials_project", material_id=ident))
        assert response.status_code == 200, response.text
        project = response.json()
        record = project["artemis_structures"][0]
        monkeypatch.delenv("MP_API_KEY")
        monkeypatch.setattr(mp, "structure_details", lambda *args: pytest.fail("Saved CIF must work offline"))
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"], attachment_id=record["id"],
            version=project["version"], absorber="Cu", site_index=1, cluster_radius=3, path_radius=3, max_legs=2))
        assert response.status_code == 202, response.text
        job = response.json()
        deadline = time.monotonic() + 25
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            job = client.get(f"/api/artemis/feff/jobs/{job['id']}").json()
        assert job["status"] == "complete", job["message"]
        assert job["paths"][0]["metadata"]["degen"] == 12
        assert job["provenance"]["cif"] == record["structure"]["cif"]
        assert job["provenance"]["cif_sha256"] == record["sha256"]
        assert f"Materials Project {ident} (DFT-relaxed)" in job["provenance"]["feff_input"]
        assert job["provenance"]["structure"]["provenance"] == record["structure"]["provenance"]
