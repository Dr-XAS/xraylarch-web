"""Cauchy-wavelet parity, scientific guards and the read-only HTTP lifecycle."""
import copy

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import cauchy_wavelet

from xraylarch_web.athena_science import ScientificError
from xraylarch_web.athena_wavelet import WaveletOptions, wavelet_plot
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def processed_group(*, step=0.05, points=301, weight=2):
    k = np.arange(points) * step
    chi = 0.04 * np.sin(2 * 2.1 * k + 0.3) * np.exp(-0.1 * k)
    return dict(id="copper", label="Copper", processing_error=None,
                parameters=dict(kweight=weight),
                result=dict(effective=dict(kweight=weight),
                            arrays=dict(k=k.tolist(), chi=chi.tolist())))


@pytest.mark.parametrize("weight", [0, 1.5, 2, 3])
def test_matches_drxas_unwindowed_weighting_and_r_clipping_without_mutation(weight):
    group = processed_group(weight=weight)
    before = copy.deepcopy(group)
    view = wavelet_plot(group, WaveletOptions(version=0))
    k = np.asarray(group["result"]["arrays"]["k"])
    chi = np.asarray(group["result"]["arrays"]["chi"])
    reference = Group(k=k, chi=chi * k ** weight)
    # Exactly the Dr.XAS algorithm: default 10 Å computation, then clip.
    cauchy_wavelet(reference, kweight=0)
    mask = (reference.wcauchy_r >= 0) & (reference.wcauchy_r <= 6)
    np.testing.assert_allclose(view["r"], reference.wcauchy_r[mask], rtol=0, atol=0)
    np.testing.assert_allclose(view["magnitude"], reference.wcauchy_mag[mask], rtol=0, atol=0)
    assert view["k"] == k.tolist()
    assert view["kweight"] == weight
    assert view["metadata"]["window"] == "none"
    assert view["metadata"]["phase_corrected"] is False
    assert group == before
    # A single-shell signal must retain its R location in the displayed map.
    dominant_r = np.asarray(view["r"])[np.asarray(view["magnitude"]).sum(axis=1).argmax()]
    assert dominant_r == pytest.approx(2.1, abs=0.2)


def test_auto_uses_processed_weight_and_display_rmax_does_not_change_transform():
    group = processed_group(weight=2)
    group["parameters"]["kweight"] = 3
    full = wavelet_plot(group, WaveletOptions(version=0))
    narrow = wavelet_plot(group, WaveletOptions(version=0, rmax=4))
    assert full["kweight"] == narrow["kweight"] == 2
    assert narrow["r"] == full["r"][:len(narrow["r"])]
    assert narrow["magnitude"] == full["magnitude"][:len(narrow["r"])]
    unweighted = wavelet_plot(group, WaveletOptions(version=0, kweight=0))
    assert unweighted["kweight"] == 0
    assert not np.allclose(unweighted["magnitude"], full["magnitude"])


def test_fine_grid_keeps_data_beyond_native_default_fft_capacity():
    group = processed_group(step=0.01, points=1501)
    k = np.asarray(group["result"]["arrays"]["k"])
    # All signal is past the default native cutoff, making truncation visible.
    chi = np.where(k > 11, np.sin(4.2 * k), 0)
    group["result"]["arrays"]["chi"] = chi.tolist()
    view = wavelet_plot(group, WaveletOptions(version=0, kweight=0))
    assert view["metadata"]["nfft"] == 4096
    assert np.max(view["magnitude"]) > 0.01
    assert np.asarray(view["magnitude"]).shape == (len(view["r"]), len(k))
    assert view["k"][-1] == 15


@pytest.mark.parametrize("bad", ["no_chi", "mismatched", "nonfinite", "nonuniform", "origin", "processing_error", "submillistep", "detector"])
def test_unusable_processed_arrays_are_rejected_without_mutation(bad):
    group = processed_group(step=0.0125 if bad == "submillistep" else 0.05)
    arrays = group["result"]["arrays"]
    if bad == "no_chi":
        arrays["chi"] = []
    elif bad == "mismatched":
        arrays["chi"].pop()
    elif bad == "nonfinite":
        arrays["chi"][3] = float("inf")
    elif bad == "nonuniform":
        arrays["k"][3] += 0.001
    elif bad == "origin":
        arrays["k"] = [x + 0.05 for x in arrays["k"]]
    elif bad == "processing_error":
        group["processing_error"] = "The processing recipe is invalid."
    elif bad == "detector":
        group["data_type"] = "detector"
    before = copy.deepcopy(group)
    with pytest.raises(ScientificError):
        wavelet_plot(group, WaveletOptions(version=0))
    assert group == before


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


def test_http_wavelet_is_versioned_read_only_and_returns_finite_oriented_grid(client):
    project = client.post("/api/athena/projects").json()
    project_url = f"/api/athena/projects/{project['id']}"
    response = client.post(f"{project_url}/command", json={"version": 0, "action": "example"})
    assert response.status_code == 200, response.text
    project = response.json()
    group = project["groups"][0]
    endpoint = f"{project_url}/groups/{group['id']}/wavelet"
    response = client.post(endpoint, json={"version": project["version"], "kweight": None, "rmax": 6})
    assert response.status_code == 200, response.text
    view = response.json()
    assert view["project_id"] == project["id"]
    assert view["version"] == project["version"]
    assert view["group_id"] == group["id"]
    assert view["kweight"] == group["result"]["effective"]["kweight"]
    assert len(view["k"]) == len(group["result"]["arrays"]["chi"])
    assert 0 <= view["r"][0] < view["r"][-1] <= 6
    assert np.asarray(view["magnitude"]).shape == (len(view["r"]), len(view["k"]))
    assert np.isfinite(view["magnitude"]).all()
    assert client.get(project_url).json() == project
    stale = client.post(endpoint, json={"version": 0})
    assert stale.status_code == 409, stale.text
    for invalid in ({"kweight": True}, {"kweight": -1}, {"kweight": 5}, {"rmax": 0}, {"rmax": 11}, {"unexpected": True}):
        response = client.post(endpoint, json={"version": project["version"], **invalid})
        assert response.status_code == 400, response.text
        assert response.json()["error"]["recovery"]
    assert client.get(project_url).json() == project


def test_http_rejects_xanes_without_creating_processing_results(client):
    project = client.post("/api/athena/projects").json()
    project_url = f"/api/athena/projects/{project['id']}"
    project = client.post(f"{project_url}/command", json={"version": 0, "action": "example"}).json()
    group = project["groups"][0]
    response = client.post(f"{project_url}/command", json={"version": project["version"],
        "action": "change_datatype", "group_ids": [group["id"]], "options": {"data_type": "xanes"}})
    assert response.status_code == 200, response.text
    project = response.json()
    response = client.post(f"{project_url}/groups/{group['id']}/wavelet", json={"version": project["version"]})
    assert response.status_code == 400, response.text[:1000]
    assert "chi(k)" in response.json()["error"]["message"]
    assert client.get(project_url).json() == project
