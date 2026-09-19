"""Viewer k-weight overrides preserve applied windows and saved processing."""
from copy import deepcopy

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import xftf, xftr

from xraylarch_web.athena_plot_transform import PlotTransformOptions, plot_transform
from xraylarch_web.athena_science import AthenaParameters, ScientificError, process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def processed_group():
    k = np.arange(301) * 0.05
    chi = 0.04 * np.sin(4.2 * k + 0.3) * np.exp(-0.1 * k)
    parameters = AthenaParameters(kweight=2, kmin=2.5, kmax=12, dk=1.5,
                                  window="parzen", rmin=1.2, rmax=3.4, dr=0.5)
    return dict(id="copper", label="Copper", data_type="chi", processing_error=None,
                parameters=parameters.model_dump(),
                result=process_spectrum(k, chi, parameters, data_type="chi"))


@pytest.mark.parametrize("weight", [0, 1, 1.5, 2, 3, 4])
def test_weight_recomputes_forward_and_back_transform_without_double_weighting_or_mutation(weight):
    group = processed_group()
    before = deepcopy(group)
    view = plot_transform(group, PlotTransformOptions(version=0, kweight=weight))
    k = np.asarray(group["result"]["arrays"]["k"])
    chi = np.asarray(group["result"]["arrays"]["chi"])
    p = group["result"]["effective"]
    reference = Group()
    weighted_chi = chi * k ** weight
    xftf(k, weighted_chi, group=reference, kweight=0, kmin=p["kmin"], kmax=p["kmax"],
         dk=p["dk"], window=p["window"], nfft=p["nfft"], kstep=p["kstep"], rmax_out=p["rmax_out"])
    xftr(reference.r, reference.chir, group=reference, rmin=p["rmin"], rmax=p["rmax"],
         dr=p["dr"], window=p["rwindow"], nfft=p["nfft"], kstep=p["kstep"], qmax_out=k[-1])
    np.testing.assert_allclose(view["arrays"]["weighted_chi"], weighted_chi, rtol=0, atol=0)
    for key in ("r", "chir_mag", "chir_re", "chir_im", "q", "chiq_mag", "chiq_re", "chiq_im", "kwin", "rwin"):
        np.testing.assert_allclose(view["arrays"][key], getattr(reference, key), rtol=0, atol=0)
    np.testing.assert_allclose(view["arrays"]["chir_pha"], np.unwrap(np.angle(reference.chir)))
    np.testing.assert_allclose(view["arrays"]["chiq_pha"], np.unwrap(np.angle(reference.chiq)))
    assert view["effective"] == {**p, "kweight": weight}
    assert group == before
    if weight != 2:
        assert not np.allclose(view["arrays"]["chir_mag"], group["result"]["arrays"]["chir_mag"])


def test_override_uses_applied_transform_parameters_including_resolved_automatic_bounds():
    group = processed_group()
    expected = plot_transform(group, PlotTransformOptions(version=0, kweight=3))
    # Displaying a stored result must retain its effective window and grid.
    group["parameters"].update(kmin=3, kmax=None, dk=2, window="hanning",
                               rmin=1, rmax=3, dr=0, nfft=4096, kstep=0.025)
    before = deepcopy(group)
    actual = plot_transform(group, PlotTransformOptions(version=0, kweight=3))
    assert actual == expected
    assert group == before


@pytest.mark.parametrize("bad", ["no_chi", "mismatched", "nonfinite", "nonuniform", "origin", "processing_error", "xanes"])
def test_invalid_processed_data_is_rejected_without_mutation(bad):
    group = processed_group()
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
        arrays["k"] = [value + 0.05 for value in arrays["k"]]
    elif bad == "processing_error":
        group["processing_error"] = "Invalid processing parameters."
    elif bad == "xanes":
        group["result"]["effective"]["exafs"] = False
    before = deepcopy(group)
    with pytest.raises(ScientificError):
        plot_transform(group, PlotTransformOptions(version=0, kweight=3))
    assert group == before


def test_http_override_is_versioned_validated_and_read_only(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        project = client.post("/api/athena/projects").json()
        url = f"/api/athena/projects/{project['id']}"
        response = client.post(f"{url}/command", json={"version": 0, "action": "example"})
        assert response.status_code == 200, response.text
        project = response.json()
        group = project["groups"][0]
        endpoint = f"{url}/groups/{group['id']}/plot-transform"
        response = client.post(endpoint, json={"version": project["version"], "kweight": 3})
        assert response.status_code == 200, response.text
        view = response.json()
        assert view["project_id"] == project["id"]
        assert view["version"] == project["version"]
        assert view["group_id"] == group["id"]
        assert view["kweight"] == view["effective"]["kweight"] == 3
        assert view["arrays"]["chi"] == group["result"]["arrays"]["chi"]
        assert all(np.isfinite(values).all() for values in view["arrays"].values())
        assert client.get(url).json() == project
        response = client.post(endpoint, json={"version": 0, "kweight": 3})
        assert response.status_code == 409, response.text
        for invalid in ({"kweight": True}, {"kweight": None}, {"kweight": -1}, {"kweight": 5},
                        {"kweight": "3"}, {"kweight": 3, "unexpected": True}, {}):
            response = client.post(endpoint, json={"version": project["version"], **invalid})
            assert response.status_code == 400, response.text
            assert response.json()["error"]["recovery"]
        assert client.get(url).json() == project
