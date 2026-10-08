"""CIF forward simulation is a native FEFF sum, not a fit to invented data."""
import copy
import hashlib
import json
import time
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import feffpath, ff2chi, find_exe, xftf
from pydantic import ValidationError

from xraylarch_web import artemis
from xraylarch_web.artemis_simulation import AddSimulationRequest, SimulationRequest, add_simulation, simulate_job, view_simulation
from xraylarch_web.artemis_attachments import RenameRequest, rename_structure, structure_attachment
from xraylarch_web.artemis_structures import structure_details
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def job():
    example = artemis.cuprite_example()
    return dict(id="a" * 32, status="complete", request=dict(absorber="Cu", edge="K", site_index=1),
                provenance=dict(cif=(artemis._CUPRITE_EXAMPLE / "source.cif").read_text(),
                                feff_input=(artemis._CUPRITE_EXAMPLE / "feff.inp").read_text()),
                paths=[dict(path, id=f"feff{i:04d}") for i, path in enumerate(example["paths"], 1)],
                warnings=[], total_paths=4, truncated=False)


def test_native_sum_and_fourier_parity_with_explicit_disorder(job, tmp_path):
    before = copy.deepcopy(job)
    request = SimulationRequest(s02=0.83, e0=2.7, deltar=0.017, sigma2=0.005)
    result = simulate_job(job, request)
    paths = []
    for source in job["paths"]:
        file = tmp_path / source["filename"]
        file.write_text(source["content"])
        paths.append(feffpath(str(file), s02=request.s02, e0=request.e0, deltar=request.deltar, sigma2=request.sigma2))
    native = Group()
    ff2chi(paths, group=native, k=np.array(result["k"]["x"]))
    np.testing.assert_allclose(result["k"]["chi"], native.chi, atol=1e-12)
    np.testing.assert_allclose(result["k"]["total"], native.chi * native.k ** 2, atol=1e-12)
    assert result["k"]["chi"][0] == native.chi[0]
    transformed = Group()
    xftf(native.k, native.chi, group=transformed, kmin=3, kmax=12, dk=2, kweight=2, window="hanning", nfft=2048, kstep=0.05, rmax_out=10)
    np.testing.assert_allclose(result["r"]["total_re"], transformed.chir.real, atol=1e-12)
    np.testing.assert_allclose(result["r"]["total_mag"], abs(transformed.chir), atol=1e-12)
    for component in ("re", "im"):
        np.testing.assert_allclose(np.sum([path["r"][component] for path in result["paths"]], axis=0), result["r"][f"total_{component}"], atol=1e-12)
    assert [p["metadata"]["degen"] for p in result["paths"]] == [p["metadata"]["degen"] for p in job["paths"]]
    assert job == before
    assert result["source"]["provenance"] == job["provenance"]


def test_all_paths_can_exceed_fit_limit_and_scale_linearly(job):
    job["paths"] = [dict(job["paths"][0], id=f"p{i}") for i in range(30)]
    job["total_paths"] = 30
    result = simulate_job(job, SimulationRequest())
    single = simulate_job(job, SimulationRequest(path_ids=["p0"], s02=0.5))
    assert len(result["paths"]) == 30
    np.testing.assert_allclose(result["k"]["chi"], np.array(single["k"]["chi"]) * 51, atol=1e-12)
    assert "Only 1 of 30" in single["warnings"][0]


@pytest.mark.parametrize("body", [{"path_ids": []}, {"path_ids": ["a", "a"]}, {"s02": -1}, {"sigma2": -0.001},
    {"s02": float("nan")}, {"transform": {"kmin": 12, "kmax": 3}}, {"transform": {"kmax": 21, "kweight": [2]}},
    {"transform": {"kweight": [1, 2]}}])
def test_invalid_requests(body):
    with pytest.raises(ValidationError):
        SimulationRequest(**body)


def test_partial_transform_keeps_simulation_defaults():
    request = SimulationRequest(transform={"kmax": 14})
    assert request.s02 == 0.85
    assert request.transform.kweight == [2]
    assert request.transform.kmin == 3


def test_job_selection_support_and_truncation_guards(job):
    with pytest.raises(WebInputError, match="complete"):
        simulate_job(dict(job, status="running"), SimulationRequest())
    with pytest.raises(WebInputError, match="belonging"):
        simulate_job(job, SimulationRequest(path_ids=["missing"]))
    job["truncated"], job["total_paths"] = True, 12
    result = simulate_job(job, SimulationRequest())
    assert any("4 of 12" in warning for warning in result["warnings"])
    job["paths"][0]["metadata"]["kmax"] = 10
    with pytest.raises(WebInputError, match="Reduce the Fourier kmax"):
        simulate_job(job, SimulationRequest())


def test_uploaded_cif_simulates_without_a_measured_group_and_does_not_mutate_project(tmp_path):
    if any(find_exe(f"feff8l_{name}") is None for name in ("rdinp", "pot", "xsph", "pathfinder", "genfmt", "ff2x")):
        pytest.skip("Bundled FEFF8L executables unavailable")
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        described = client.get("/api/artemis/capabilities/simulation")
        assert described.status_code == 200
        assert "default [2]" in described.json()["transform"]["kweight"]
        project = client.post("/api/athena/projects", json={}).json()
        cif = structure_details(13088)["cif"]
        response = client.post(f"/api/artemis/projects/{project['id']}/structures", json=dict(version=0, provider="uploaded", filename="copper.cif", cif=cif))
        assert response.status_code == 200, response.text
        project = response.json()
        response = client.post("/api/artemis/feff/jobs", json=dict(project_id=project["id"], version=project["version"],
            attachment_id=project["artemis_structures"][0]["id"], absorber="Cu", site_index=1, cluster_radius=3.0, path_radius=3.0, max_legs=2))
        assert response.status_code in (200, 202), response.text
        job = response.json()
        deadline = time.monotonic() + 60
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.1)
            job = client.get(f"/api/artemis/feff/jobs/{job['id']}?view=summary").json()
        assert job["status"] == "complete", job
        url = f"/api/artemis/feff/jobs/{job['id']}/simulate"
        response = client.post(url, json={})
        assert response.status_code == 200, response.text
        result = response.json()
        assert len(result["k"]["chi"]) == 401 and max(abs(np.array(result["k"]["chi"]))) > 0
        assert result["source"]["provenance"]["cif"] == cif
        assert result["paths"][0]["metadata"]["reff"] == pytest.approx(2.5668, abs=0.0001)
        summary = client.post(url + "?view=summary", json={}).json()
        assert "source" not in summary and not isinstance(summary["k"]["chi"], list)
        after = client.get(f"/api/athena/projects/{project['id']}").json()
        assert after == project and after["groups"] == []
        assert client.post(url, json={"path_ids": []}).status_code == 422
        assert client.post("/api/artemis/feff/jobs/invalid/simulate", json={}).status_code == 400
        assert client.post(f"/api/artemis/feff/jobs/{'0' * 32}/simulate", json={}).status_code == 400


@pytest.fixture
def owned_simulation(tmp_path, job):
    store = AthenaStore(Settings(data_root=tmp_path))
    original = store.create()
    attachment = structure_attachment(cif=job["provenance"]["cif"], filename="cuprite.cif")
    project = copy.deepcopy(original)
    project["artemis_structures"] = [attachment]
    project = store.save(project, original, "Attached theory source")
    job["request"].update(project_id=project["id"], version=project["version"], attachment_id=attachment["id"])
    job["provenance"].update(project_id=project["id"], attachment_id=attachment["id"],
                              source_revision=project["version"], cif_sha256=attachment["sha256"])
    return store, SimpleNamespace(get=lambda ident: copy.deepcopy(job)), project, job


def addition(project, job, **values):
    return AddSimulationRequest(version=project["version"], feff_job_id=job["id"],
                                simulation=SimulationRequest(**values))


def test_addition_keeps_unweighted_chi_exact_transform_and_provenance(owned_simulation):
    store, jobs, original, job = owned_simulation
    request = addition(original, job, s02=0.82, sigma2=0.006, e0=2.5, deltar=0.01,
                       path_ids=[job["paths"][0]["id"]], transform=dict(kmin=2, kmax=14, kweight=[1], dk=3, window="parzen"))
    displayed = simulate_job(job, request.simulation)
    saved = add_simulation(store, jobs, original["id"], request)
    assert saved["version"] == original["version"] + 1
    assert len(saved["groups"]) == 1
    group = saved["groups"][0]
    assert group["label"] == "cuprite.cif · Cu K · theory"
    assert group["data_type"] == "chi" and group["marked"] is True
    assert group["processing_error"] is None
    assert group["source"]["tags"] == ["theory"]
    assert group["source"]["simulation"] == displayed["simulation"]
    assert group["source"]["feff"] == displayed["source"]
    assert group["source"]["edge_identity"] == dict(element="Cu", edge="K", origin="selected")
    assert group["energy"] == displayed["k"]["x"]
    assert group["mu"] == displayed["k"]["chi"]
    np.testing.assert_allclose(group["result"]["arrays"]["chi"], displayed["k"]["chi"], atol=1e-12)
    np.testing.assert_allclose(group["result"]["arrays"]["weighted_chi"], displayed["k"]["total"], atol=1e-12)
    np.testing.assert_allclose(group["result"]["arrays"]["chir_re"], displayed["r"]["total_re"], atol=1e-12)
    assert group["parameters"]["kmax"] == 14 and group["parameters"]["kweight"] == 1
    assert group["parameters"]["dk"] == 3 and group["parameters"]["window"] == "parzen"
    assert any("Only 1" in warning for warning in group["result"]["warnings"])
    assert saved["last_operation"]["simulation"]["group_id"] == group["id"]
    assert store.load(original["id"])["groups"][0] == group


@pytest.mark.parametrize("label", [None, "Custom theory spectrum"])
def test_addition_uses_current_cif_name_unless_spectrum_name_is_explicit(owned_simulation, label):
    store, jobs, original, job = owned_simulation
    renamed = rename_structure(store, original["id"], original["artemis_structures"][0]["id"],
                               RenameRequest(version=original["version"], label="Cuprite reference"))
    request = addition(renamed, job).model_copy(update={"label": label})
    saved = add_simulation(store, jobs, original["id"], request)
    assert saved["groups"][0]["label"] == (label or "Cuprite reference · Cu K · theory")
    assert saved["groups"][0]["source"]["feff"]["provenance"] == job["provenance"]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_theory_tag_and_exact_sources_survive_project_exchange(owned_simulation, format):
    store, jobs, original, job = owned_simulation
    saved = add_simulation(store, jobs, original["id"], addition(original, job))
    group = saved["groups"][0]
    payload = json.dumps(saved).encode() if format == "json" else store.export_project(saved["id"], format="prj")
    if format == "prj":
        assert payload[:2] == b"\x1f\x8b"
    imported = store.create()
    restored = store.restore(imported["id"], imported["version"], payload, f"theory.{format}")
    reopened = AthenaStore(store.settings).load(restored["id"])["groups"][0]
    assert reopened["label"] == group["label"]
    assert reopened["source"]["tags"] == ["theory"]
    assert reopened["source"]["simulation"] == group["source"]["simulation"]
    assert reopened["source"]["feff"] == group["source"]["feff"]
    assert reopened["mu"] == group["mu"] and reopened["parameters"] == group["parameters"]
    assert reopened["processing_error"] is None
    replay = view_simulation(reopened)
    np.testing.assert_allclose(replay["k"]["chi"], group["mu"], atol=1e-12)
    assert len(replay["paths"]) == 4
    assert replay["simulation"]["request"] == group["source"]["simulation"]["request"]


def test_addition_is_undoable_and_redoable(owned_simulation):
    store, jobs, original, job = owned_simulation
    saved = add_simulation(store, jobs, original["id"], addition(original, job))
    group = saved["groups"][0]
    undone = store.command(original["id"], Command(version=saved["version"], action="undo", group_ids=[], options={}))
    assert undone["groups"] == [] and undone["artemis_structures"] == original["artemis_structures"]
    redone = store.command(original["id"], Command(version=undone["version"], action="redo", group_ids=[], options={}))
    assert redone["groups"][0] == group


def test_addition_retries_once_and_rejects_reused_key_with_other_inputs(owned_simulation):
    store, jobs, original, job = owned_simulation
    request = addition(original, job)
    saved = add_simulation(store, jobs, original["id"], request, idempotency_key="lost-response")
    jobs.get = lambda ident: pytest.fail("An idempotent replay must not need a retained FEFF job")
    replay = add_simulation(store, jobs, original["id"], request, idempotency_key="lost-response")
    assert replay["version"] == saved["version"] and len(replay["groups"]) == 1
    assert replay["last_operation"]["idempotent_replay"]["action"] == "simulation"
    assert replay["last_operation"]["idempotent_replay"]["version_after"] == saved["version"]
    assert replay["last_operation"]["simulation"]["group_id"] == saved["groups"][0]["id"]
    with pytest.raises(WebInputError, match="different simulation inputs"):
        add_simulation(store, jobs, original["id"], addition(original, job, s02=0.5), idempotency_key="lost-response")
    key_hash = hashlib.sha256(b"lost-response").hexdigest()
    store.storage.path(original["id"], f"simulation-add-{key_hash}.json").unlink()
    recovered = add_simulation(store, jobs, original["id"], request, idempotency_key="lost-response")
    assert recovered["last_operation"]["idempotent_replay"]["action"] == "simulation" and len(recovered["groups"]) == 1


@pytest.mark.parametrize("failure", ["stale", "other-project", "removed-cif", "different-cif", "running", "integration"])
def test_invalid_additions_do_not_change_project(owned_simulation, failure):
    store, jobs, original, job = owned_simulation
    request = addition(original, job)
    if failure == "stale":
        request.version -= 1
    elif failure == "other-project":
        job["provenance"]["project_id"] = "other"
    elif failure == "removed-cif":
        original["artemis_structures"] = []
    elif failure == "different-cif":
        job["provenance"]["cif"] += "\n# changed"
    elif failure == "running":
        job["status"] = "running"
    elif failure == "integration":
        original["integration"] = True
    store.storage.write_json(original["id"], "project.json", original)
    before = store.load(original["id"])
    with pytest.raises(WebInputError):
        add_simulation(store, jobs, original["id"], request)
    assert store.load(original["id"]) == before


def test_addition_route_summary_and_validation(owned_simulation, monkeypatch):
    from xraylarch_web.artemis_structures import FeffJobs
    store, jobs, original, job = owned_simulation
    monkeypatch.setattr(FeffJobs, "get", lambda self, ident: jobs.get(ident))
    with TestClient(create_app(store.settings)) as client:
        url = f"/api/artemis/projects/{original['id']}/simulation"
        response = client.post(url + "?view=summary", json=addition(original, job).model_dump(),
                               headers={"Idempotency-Key": "http-add"})
        assert response.status_code == 200, response.text
        project = response.json()
        assert project["groups"][0]["data_type"] == "chi" and project["groups"][0]["tags"] == ["theory"]
        assert "energy" not in project["groups"][0]
        stale = client.post(url, json=addition(original, job).model_dump())
        assert stale.status_code == 409, stale.text
        invalid = client.post(url, json=addition(original, job).model_dump() | {"label": "  "})
        assert invalid.status_code == 422, invalid.text
        invalid = client.post(url, json=addition(original, job).model_dump() | {"feff_job_id": "../bad"})
        assert invalid.status_code == 422, invalid.text


@pytest.mark.parametrize("weight", [None, 0, 3])
def test_saved_theory_view_preserves_recipe_and_native_path_sums(owned_simulation, weight):
    store, jobs, original, job = owned_simulation
    request = addition(original, job, s02=0.82, sigma2=0.006, e0=2.5, deltar=0.01,
                       path_ids=[job["paths"][i]["id"] for i in (2, 0)],
                       transform=dict(kmin=2, kmax=14, kweight=[1], dk=3, window="parzen"))
    saved = add_simulation(store, jobs, original["id"], request)
    group = saved["groups"][0]
    before = copy.deepcopy(group)
    jobs.get = lambda ident: pytest.fail("Saved theory must not need a live FEFF job")
    result = view_simulation(group, weight)
    effective_weight = 1 if weight is None else weight
    assert result["k"]["weight"] == effective_weight
    assert result["simulation"]["request"] == request.simulation.model_dump()
    np.testing.assert_allclose(result["k"]["chi"], group["mu"], atol=1e-12)
    np.testing.assert_allclose(result["k"]["total"], np.array(group["mu"]) * np.array(group["energy"]) ** effective_weight, atol=1e-12)
    np.testing.assert_allclose(np.sum([p["k"]["chi"] for p in result["paths"]], axis=0), result["k"]["total"], atol=1e-12)
    native = Group()
    xftf(np.array(group["energy"]), np.array(group["mu"]), group=native, kmin=2, kmax=14, dk=3,
         kweight=effective_weight, window="parzen", nfft=2048, kstep=0.05, rmax_out=10)
    np.testing.assert_allclose(result["r"]["total_re"], native.chir.real, atol=1e-12)
    for part in ("re", "im"):
        np.testing.assert_allclose(np.sum([p["r"][part] for p in result["paths"]], axis=0), result["r"][f"total_{part}"], atol=1e-12)
    assert group == before and store.load(saved["id"]) == saved
    assert not {"statistics", "report", "correlations", "success"} & result.keys()


def test_saved_theory_view_exceeds_fit_path_limit_and_labels_modified_data(owned_simulation):
    store, jobs, original, job = owned_simulation
    job["paths"] = [dict(job["paths"][0], id=f"p{i}") for i in range(30)]
    job["total_paths"] = 30
    saved = add_simulation(store, jobs, original["id"], addition(original, job))
    group = saved["groups"][0]
    group["mu"][20] += 0.01
    group["parameters"]["kmax"] = 8
    result = view_simulation(group)
    assert len(result["paths"]) == 30
    assert result["transform"]["kmax"] == 12
    assert any("original theory" in warning for warning in result["warnings"])


@pytest.mark.parametrize("broken", ["no-files", "bad-files", "duplicate", "selection", "request", "tags", "version"])
def test_saved_theory_view_rejects_incomplete_sources(owned_simulation, broken):
    store, jobs, original, job = owned_simulation
    group = add_simulation(store, jobs, original["id"], addition(original, job))["groups"][0]
    source = group["source"]
    if broken == "no-files":
        del source["feff"]["paths"]
    elif broken == "bad-files":
        source["feff"]["paths"] = [None]
    elif broken == "duplicate":
        source["feff"]["paths"][1] = source["feff"]["paths"][0]
    elif broken == "selection":
        source["simulation"]["path_ids"].reverse()
    elif broken == "request":
        source["simulation"]["request"] = {}
    elif broken == "tags":
        source["tags"] = None
    else:
        source["simulation"]["schema_version"] = 2
    with pytest.raises(WebInputError):
        view_simulation(group)


def test_saved_theory_view_http_is_read_only_and_version_checked(owned_simulation, monkeypatch):
    from xraylarch_web.artemis_structures import FeffJobs
    store, jobs, original, job = owned_simulation
    saved = add_simulation(store, jobs, original["id"], addition(original, job))
    group_id = saved["groups"][0]["id"]
    monkeypatch.setattr(FeffJobs, "get", lambda *args: pytest.fail("Expired FEFF jobs must not be needed"))
    with TestClient(create_app(store.settings)) as client:
        url = f"/api/artemis/projects/{saved['id']}/groups/{group_id}/simulation-view"
        response = client.post(url, json=dict(version=saved["version"], kweight=3))
        assert response.status_code == 200, response.text
        assert response.json()["group_id"] == group_id and response.json()["k"]["weight"] == 3
        summary = client.post(url + "?view=summary", json=dict(version=saved["version"])).json()
        assert isinstance(summary["k"]["total"], str)
        assert client.post(url, json=dict(version=saved["version"] - 1)).status_code == 409
        assert client.post(url, json=dict(version=saved["version"], kweight=4)).status_code == 422
    assert store.load(saved["id"]) == saved
