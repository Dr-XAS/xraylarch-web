"""Saved-fit display weights preserve native transforms and archived science."""
import copy

import numpy as np
import pytest
from larch.xafs import feffit_transform
from pydantic import ValidationError

from test_artemis import model, spectrum
from test_artemis_persistence import workspace
from xraylarch_web import artemis_plot
from xraylarch_web.artemis import FitRequest, fit_group
from xraylarch_web.artemis_persistence import validate_result
from xraylarch_web.artemis_plot import PlotTransformRequest, transform_result
from xraylarch_web.errors import WebInputError


@pytest.fixture
def saved_fit(model, spectrum):
    model["transform"]["kweight"] = [2]
    model["paths"][0]["s02"] = "0.65 * amp"
    model["paths"].append(model["paths"][0] | dict(id="second", s02="0.35 * amp", deltar="del_r + 0.11"))
    return dict(project_id="original-project", version=1, **fit_group(spectrum, FitRequest(**model)))


@pytest.mark.parametrize("weight", range(5))
def test_saved_raw_curves_reproduce_native_transform_for_each_display_weight(saved_fit, weight):
    before = copy.deepcopy(saved_fit)
    result = transform_result(saved_fit, weight)
    source, k = saved_fit["plot_source"], np.asarray(saved_fit["k"]["x"])
    native = feffit_transform(**(saved_fit["transform"] | {"kweight": weight}),
                              kstep=0.05, nfft=2048, rwindow="hanning")
    for name in ("data", "model"):
        raw = np.asarray(source[name])
        np.testing.assert_allclose(result["k"][name], raw * k ** weight, rtol=1e-12, atol=1e-12)
        expected = native.fftf(raw)[:len(result["r"]["x"])]
        np.testing.assert_allclose(result["r"][f"{name}_re"], expected.real, rtol=1e-12, atol=1e-12)
        np.testing.assert_allclose(result["r"][f"{name}_im"], expected.imag, rtol=1e-12, atol=1e-12)
    for path, original in zip(result["paths"], source["paths"]):
        raw = np.asarray(original["chi"])
        np.testing.assert_allclose(path["k"]["chi"], raw * k ** weight, rtol=1e-12, atol=1e-12)
        expected = native.fftf(raw)[:len(result["r"]["x"])]
        np.testing.assert_allclose(path["r"]["re"], expected.real, rtol=1e-12, atol=1e-12)
        np.testing.assert_allclose(path["r"]["im"], expected.imag, rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose(result["r"]["residual_re"], np.array(result["r"]["data_re"]) - result["r"]["model_re"])
    np.testing.assert_allclose(result["r"]["residual_mag"], np.hypot(result["r"]["residual_re"], result["r"]["residual_im"]))
    np.testing.assert_allclose(np.sum([p["k"]["chi"] for p in result["paths"]], axis=0), result["k"]["model"], atol=1e-12)
    assert saved_fit == before
    if weight == 2:
        for name, values in saved_fit["r"].items():
            np.testing.assert_allclose(result["r"][name], values, rtol=1e-12, atol=1e-12)


@pytest.mark.parametrize("weight", [1, 2, 3, 4])
def test_older_weighted_archives_transform_exactly_at_positive_weights(saved_fit, weight):
    old = copy.deepcopy(saved_fit)
    del old["plot_source"]
    assert validate_result(old) == old
    actual, expected = transform_result(old, weight), transform_result(saved_fit, weight)
    for space in ("k", "r"):
        for name in actual[space]:
            np.testing.assert_allclose(actual[space][name], expected[space][name], atol=1e-12, rtol=1e-12)


def test_older_weighted_archives_do_not_invent_unweighted_zero(saved_fit):
    del saved_fit["plot_source"]
    with pytest.raises(WebInputError, match="unweighted k=0 value is unavailable"):
        transform_result(saved_fit, 0)


def test_older_unweighted_archive_retains_zero_and_supports_every_weight(model, spectrum):
    model["transform"]["kweight"] = [0]
    saved = dict(project_id="original-project", version=1, **fit_group(spectrum, FitRequest(**model)))
    del saved["plot_source"]
    for weight in range(5):
        result = transform_result(saved, weight)
        np.testing.assert_allclose(result["k"]["data"], np.asarray(saved["k"]["data"]) * np.asarray(saved["k"]["x"]) ** weight)


@pytest.mark.parametrize("change", ["length", "identity", "schema", "extra"])
def test_saved_source_shape_is_strict_and_bounded(saved_fit, change):
    if change == "length": saved_fit["plot_source"]["data"].pop()
    if change == "identity": saved_fit["plot_source"]["paths"][0]["id"] = "another"
    if change == "schema": saved_fit["plot_source"]["schema_version"] = True
    if change == "extra": saved_fit["plot_source"]["arbitrary"] = "text"
    with pytest.raises(ValidationError):
        PlotTransformRequest(version=1, kweight=2, result=saved_fit)


@pytest.mark.parametrize("change", ["nfft", "phase", "grid"])
def test_incompatible_transform_metadata_is_rejected(saved_fit, change):
    if change == "nfft": saved_fit["metadata"]["nfft"] = 1_000_000
    if change == "phase": saved_fit["metadata"]["phase_corrected"] = True
    if change == "grid": saved_fit["k"]["x"][1] += 0.001
    with pytest.raises(WebInputError):
        transform_result(saved_fit, 2)


def test_http_transform_uses_saved_snapshot_is_read_only_and_checks_version(workspace, saved_fit, monkeypatch):
    store, client, project, group_id = workspace
    endpoint = f"/api/artemis/projects/{project['id']}/groups/{group_id}/plot-transform"
    before = store.load(project["id"])
    request = dict(version=project["version"], kweight=4, result=saved_fit)
    # The input is an archive with original project/group IDs and different
    # data from the current project. Neither current science nor FEFF is read.
    import xraylarch_web.artemis as fitting
    monkeypatch.setattr(fitting, "fit_group", lambda *args, **kwargs: pytest.fail("Display must not run a fit"))
    response = client.post(endpoint, json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    expected = transform_result(saved_fit, 4)
    assert result == dict(project_id=project["id"], group_id=group_id, version=project["version"], **expected)
    assert store.load(project["id"]) == before
    assert client.post(endpoint, json=request | {"version": project["version"] - 1}).status_code == 409
    assert client.post(endpoint, json=request | {"kweight": 5}).status_code == 422


def test_http_transform_rechecks_revision_and_blocks_integration(workspace, saved_fit, monkeypatch):
    store, client, project, group_id = workspace
    endpoint = f"/api/artemis/projects/{project['id']}/groups/{group_id}/plot-transform"
    request = dict(version=project["version"], kweight=3, result=saved_fit)
    real_transform = artemis_plot.transform_result

    def transform_and_edit(*args):
        output = real_transform(*args)
        old = store.load(project["id"])
        new = copy.deepcopy(old)
        new["groups"][0]["label"] = "Concurrent edit"
        store.save(new, old, "Concurrent edit")
        return output

    monkeypatch.setattr(artemis_plot, "transform_result", transform_and_edit)
    assert client.post(endpoint, json=request).status_code == 409
    current = store.load(project["id"])
    changed = copy.deepcopy(current)
    changed["integration"] = True
    current = store.save(changed, current, "Integration draft")
    response = client.post(endpoint, json=request | {"version": current["version"]})
    assert response.status_code == 400
    assert "integration draft" in response.json()["error"]["message"]
