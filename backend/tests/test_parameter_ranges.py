"""Scientific input limits agree across processing and read-only viewers."""

import numpy as np
import pytest
from pydantic import ValidationError

from xraylarch_web.athena_export import DataExport
from xraylarch_web.athena_merge_plot import MergePlotOptions
from xraylarch_web.athena_plot_transform import PlotTransformOptions
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.athena_special_plot import SpecialPlotOptions
from xraylarch_web.athena_wavelet import WaveletOptions
from xraylarch_web.artemis import FitTransform
from xraylarch_web.artemis_simulation import SimulationViewRequest
from xraylarch_web.contracts import RecipeDraft
from xraylarch_web.integration_contracts import AutobkParameters, ForwardFtParameters
from xraylarch_web.processing import validate_recipe


WEIGHT_MODELS = [
    (AthenaParameters, {}, "kweight"),
    (AthenaParameters, {}, "bkg_kweight"),
    (AutobkParameters, {"kmax": 12}, "kweight"),
    (ForwardFtParameters, {"kmax": 12}, "kweight"),
    (PlotTransformOptions, {"version": 0}, "kweight"),
    (WaveletOptions, {"version": 0}, "kweight"),
    (MergePlotOptions, {"version": 0}, "kweight"),
    (SpecialPlotOptions, {"version": 0, "group_ids": ["one"]}, "kweight"),
    (DataExport, {"version": 0, "group_id": "one"}, "arbitrary_kweight"),
]


@pytest.mark.parametrize("model,base,key", WEIGHT_MODELS)
@pytest.mark.parametrize("weight", [-1, 3.01, 4, 9, np.nan, np.inf, True])
def test_processing_and_viewer_weights_reject_values_outside_zero_to_three(model, base, key, weight):
    with pytest.raises(ValidationError):
        model(**base, **{key: weight})


@pytest.mark.parametrize("model,base,key", WEIGHT_MODELS)
@pytest.mark.parametrize("weight", [0, 1.5, 3])
def test_supported_real_weights_are_preserved_without_rounding(model, base, key, weight):
    assert getattr(model(**base, **{key: weight}), key) == weight


@pytest.mark.parametrize("weight", [-1, 1.5, 4, 9, True])
def test_artemis_weights_remain_discrete_with_the_same_upper_limit(weight):
    with pytest.raises(ValidationError):
        FitTransform(kweight=[weight])
    with pytest.raises(ValidationError):
        SimulationViewRequest(version=0, kweight=weight)


@pytest.mark.parametrize("value", [1, 4, 129, 10000])
def test_spline_knot_requests_cannot_be_silently_clipped_by_larch(value):
    with pytest.raises(ValidationError):
        AthenaParameters(nknots=value)
    with pytest.raises(ValidationError):
        AutobkParameters(kmax=12, nknots=value)


@pytest.mark.parametrize("value", [0, 5, 128])
def test_automatic_or_supported_spline_knot_counts(value):
    assert AthenaParameters(nknots=value).nknots == value
    assert AutobkParameters(kmax=12, nknots=value).nknots == value


@pytest.mark.parametrize("key", [
    name for name in AthenaParameters.model_fields
    if name not in {"window", "rwindow", "bkg_window", "flatten", "fnorm", "forward_with_phase", "reverse_with_phase"}
])
def test_athena_numeric_parameters_do_not_accept_booleans(key):
    with pytest.raises(ValidationError):
        AthenaParameters(**{key: True})


@pytest.mark.parametrize("overrides", [
    {"pre1": 0}, {"pre2": 1}, {"norm1": -1}, {"norm2": 0}, {"kweight": 4}, {"kweight": 9},
])
def test_classic_rejects_nonphysical_normalization_sides_and_weights(xas_arrays, overrides):
    issues = validate_recipe(RecipeDraft(**overrides), xas_arrays[0])
    assert {field for issue in issues for field in issue.fields} >= set(overrides)


def test_classic_preserves_valid_signed_offsets_and_zero_weight(xas_arrays):
    assert validate_recipe(RecipeDraft(pre1=-150, pre2=-30, norm1=0, norm2=300, kweight=0), xas_arrays[0]) == ()


@pytest.mark.parametrize("key", ["e0", "step", "kweight", "nfft", "kstep", "nnorm"])
def test_classic_numeric_parameters_do_not_accept_booleans(key):
    with pytest.raises(ValidationError):
        RecipeDraft(**{key: True})


def test_invalid_processing_weight_does_not_change_a_project(tmp_path, xas_arrays):
    from fastapi.testclient import TestClient

    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.config import Settings
    from xraylarch_web.main import create_app

    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    project = store.create()
    project["groups"].append(store.make_group("Synthetic spectrum", *xas_arrays))
    project = store.save(project, store.load(project["id"]), "Synthetic import")
    before = store.load(project["id"])
    with TestClient(create_app(settings)) as client:
        response = client.post(f"/api/athena/projects/{project['id']}/command?view=summary", json={
            "version": project["version"], "action": "parameters",
            "group_ids": [project["groups"][0]["id"]], "options": {"kweight": 9},
        })
    assert response.status_code == 400
    assert "kweight" in response.text
    assert store.load(project["id"]) == before
