"""CIF forward simulation is a native FEFF sum, not a fit to invented data."""
import copy
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import feffpath, ff2chi, find_exe, xftf
from pydantic import ValidationError

from xraylarch_web import artemis
from xraylarch_web.artemis_simulation import SimulationRequest, simulate_job
from xraylarch_web.artemis_structures import structure_details
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
    np.testing.assert_allclose(result["k"]["chi"], np.array(single["k"]["chi"]) * 60, atol=1e-12)
    assert "Only 1 of 30" in single["warnings"][0]


@pytest.mark.parametrize("body", [{"path_ids": []}, {"path_ids": ["a", "a"]}, {"s02": -1}, {"sigma2": -0.001},
    {"s02": float("nan")}, {"transform": {"kmin": 12, "kmax": 3}}, {"transform": {"kmax": 21, "kweight": [2]}},
    {"transform": {"kweight": [1, 2]}}])
def test_invalid_requests(body):
    with pytest.raises(ValidationError):
        SimulationRequest(**body)


def test_partial_transform_keeps_simulation_defaults():
    request = SimulationRequest(transform={"kmax": 14})
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
