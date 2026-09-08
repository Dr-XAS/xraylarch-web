"""Difference-panel numerics against Larch, analytic curves and source Romberg.

Natural-spline values are independently reconstructed from their curvature
equations. scipy.integrate.romb evaluates each source refinement's diagonal;
these tests do not call the helper's interpolation/integration internals.
"""

from copy import deepcopy
import json
from pathlib import Path

from larch import Group
from larch.io import read_athena
from larch.math import interp
from larch.xafs import pre_edge
import numpy as np
from pydantic import ValidationError
import pytest
from scipy.integrate import romb

from xraylarch_web.athena_difference import DifferenceOptions, difference_spectrum
from xraylarch_web.athena_science import AthenaParameters, ScientificError, process_spectrum


FORMS = ("xmu", "norm", "der", "nder", "sec", "nsec")
REPORT_KEYS = {"group_id", "label", "energy", "difference", "data", "standard", "form",
               "data_form", "standard_form", "area", "e0", "integration", "warnings",
               "extrapolated_points", "y_label", "area_label"}


def spectrum(ident, energy, mu, *, shift=0, e0=9000, flatten=True, norm=None, flat=None):
    energy, mu = np.asarray(energy, dtype=float), np.asarray(mu, dtype=float)
    return {"id": ident, "label": ident, "data_type": "mu", "energy": energy.tolist(),
            "mu": mu.tolist(), "parameters": {"energy_shift": shift, "flatten": flatten},
            "result": {"effective": {"e0": e0, "flatten": flatten}, "arrays": {
                "energy": (energy + shift).tolist(),
                "norm": (mu / 3 if norm is None else np.asarray(norm)).tolist(),
                "flat": (mu / 4 if flat is None else np.asarray(flat)).tolist()}},
            "processing_error": None}


def options(standard, **kwargs):
    return DifferenceOptions(standard_id=standard["id"], **kwargs)


def slope(x, y):
    """Larch deriv(y)/deriv(x): endpoint slopes and interior secants."""
    x, y = np.asarray(x), np.asarray(y)
    return np.r_[(y[1] - y[0]) / (x[1] - x[0]),
                 (y[2:] - y[:-2]) / (x[2:] - x[:-2]),
                 (y[-1] - y[-2]) / (x[-1] - x[-2])]


def expected_form(group, form):
    x = np.asarray(group["energy"]) + group["parameters"]["energy_shift"]
    resolved = "flat" if form == "norm" and group["parameters"]["flatten"] else form
    if form in ("xmu", "der", "sec"):
        y = np.asarray(group["mu"])
    else:
        y = np.asarray(group["result"]["arrays"][resolved if form == "norm" else "norm"])
    if form in ("der", "nder", "sec", "nsec"):
        y = slope(x, y)
    if form in ("sec", "nsec"):
        y = slope(x, y)
    return x, y, resolved


def assert_json_report(result):
    assert set(result) == REPORT_KEYS
    for key in ("energy", "difference", "data", "standard"):
        assert isinstance(result[key], list)
        assert len(result[key]) == len(result["energy"])
        assert np.isfinite(result[key]).all()
    assert isinstance(result["warnings"], list)
    assert isinstance(result["extrapolated_points"], int)
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("form", FORMS)
@pytest.mark.parametrize("flatten", [(True, False), (False, True)])
def test_six_forms_match_larch_on_real_processed_spectra_without_mutation(xas_arrays, form, flatten):
    x, y = xas_arrays
    groups = []
    for ident, grid, mu, shift, flat in (
        ("data", x, y, 2.0, flatten[0]),
        ("standard", x[::2], 1.1 * y[::2], -1.0, flatten[1]),
    ):
        parameters = AthenaParameters(e0=8980 + shift, energy_shift=shift, flatten=flat)
        group = spectrum(ident, grid, mu, shift=shift, e0=8980 + shift, flatten=flat)
        group["parameters"] = parameters.model_dump()
        group["result"] = process_spectrum(grid, mu, parameters, "xanes")
        groups.append(group)
    data, standard = groups
    before = deepcopy(groups)
    choice = options(standard, form=form, integrate=False, multiplier=-0.75)
    saved_options = choice.model_dump()
    result = difference_spectrum(data, standard, choice)
    dx, dy, dform = expected_form(data, form)
    sx, sy, sform = expected_form(standard, form)
    grid = sx
    expected_data = interp(dx, dy, grid)  # The pinned Larch template's default.
    np.testing.assert_array_equal(result["energy"], grid)
    np.testing.assert_allclose(result["data"], expected_data, atol=1e-12)
    np.testing.assert_allclose(result["standard"], -0.75 * sy, atol=1e-12)
    np.testing.assert_allclose(result["difference"], expected_data + 0.75 * sy, atol=1e-12)
    assert (result["form"], result["data_form"], result["standard_form"]) == (form, dform, sform)
    assert result["area"] is result["integration"] is None
    assert result["e0"] == 8982
    assert result["extrapolated_points"] == int(np.count_nonzero((sx < dx[0]) | (sx > dx[-1])))
    assert any("extrapolated DATA" in warning for warning in result["warnings"])
    assert groups == before and choice.model_dump() == saved_options
    assert_json_report(result)


@pytest.mark.parametrize("data_flat,standard_flat", [(True, True), (True, False), (False, True), (False, False)])
def test_norm_resolves_each_saved_flatten_preference_independently(data_flat, standard_flat):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, x / 100, flatten=data_flat, norm=x / 200, flat=x / 400)
    standard = spectrum("standard", x, x / 500, flatten=standard_flat, norm=x / 1000, flat=x / 2000)
    result = difference_spectrum(data, standard, options(standard))
    expected = x / (400 if data_flat else 200) - x / (2000 if standard_flat else 1000)
    np.testing.assert_allclose(result["difference"], expected)
    assert result["data_form"] == ("flat" if data_flat else "norm")
    assert result["standard_form"] == ("flat" if standard_flat else "norm")


def test_already_normalized_input_uses_parameter_flatten_even_when_effective_is_none():
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.sin(x), norm=np.sin(x), flat=np.sin(x))
    standard = spectrum("standard", x, np.cos(x), norm=np.cos(x), flat=np.cos(x))
    for group in (data, standard):
        group["data_type"] = "norm"
        group["result"]["effective"]["flatten"] = None
    result = difference_spectrum(data, standard, options(standard, integrate=False))
    assert result["data_form"] == result["standard_form"] == "flat"
    np.testing.assert_allclose(result["difference"], np.sin(x) - np.cos(x))


@pytest.mark.parametrize("form", ["der", "nder", "sec", "nsec"])
def test_derivatives_use_raw_or_unflattened_signal_on_nonuniform_grid(form):
    x = np.array([8960, 8961, 8963, 8966, 8970, 8980, 8991, 9000, 9011, 9025, 9040.0])
    t = x - 9000
    data = spectrum("data", x, t**3 + 2 * t, norm=t**2 + 7 * t, flat=3 * t)
    standard = spectrum("standard", x, np.zeros_like(x), norm=np.zeros_like(x), flat=np.zeros_like(x))
    # Cached derivatives in the main science result are normalized; they are
    # not interchangeable with either raw derivative or a flattened derivative.
    data["result"]["arrays"].update(dmude=[999] * len(x), d2mude=[888] * len(x))
    _, expected, _ = expected_form(data, form)
    result = difference_spectrum(data, standard, options(standard, form=form, integrate=False))
    np.testing.assert_allclose(result["difference"], expected, atol=1e-12)
    base = np.asarray(data["mu"] if form in ("der", "sec") else data["result"]["arrays"]["norm"])
    alternative = np.gradient(base, x)
    if form in ("sec", "nsec"):
        alternative = np.gradient(alternative, x)
    assert not np.allclose(expected, alternative)


@pytest.mark.parametrize("invert", [False, True])
def test_reference_grid_shifted_axes_signed_multiplier_and_target_e0(invert):
    dx, sx = np.arange(8980.0, 9041, 2), np.arange(8978.0, 9050, 1.5)
    data = spectrum("DATA", dx, 3 * (dx + 4 - 9000) + 8, shift=4, e0=9000)
    standard = spectrum("STANDARD", sx, -0.5 * (sx - 3 - 9000) + 2, shift=-3, e0=9020)
    result = difference_spectrum(data, standard, options(standard, form="xmu", multiplier=-2,
        invert=invert, xmin=-10, xmax=10))
    reference_grid = sx - 3
    np.testing.assert_array_equal(result["energy"], reference_grid)
    np.testing.assert_allclose(result["data"], 3 * (reference_grid - 9000) + 8)
    np.testing.assert_allclose(result["standard"], reference_grid - 9000 - 4)
    sign = -1 if invert else 1
    np.testing.assert_allclose(result["difference"], sign * (2 * (reference_grid - 9000) + 12))
    assert result["area"] == pytest.approx(sign * 240, abs=1e-10)
    assert result["integration"] == {"xmin": -10, "xmax": 10, "lower": 8990, "upper": 9010,
                                     "converged": True, "iterations": 1}
    assert result["label"] == ("diff STANDARD - DATA" if invert else "diff DATA - STANDARD")
    assert_json_report(result)


@pytest.mark.parametrize("value", [-2.5, 0, 3.0])
def test_constant_signed_difference_has_analytic_signed_area(value):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.full_like(x, value))
    standard = spectrum("standard", x, np.zeros_like(x))
    result = difference_spectrum(data, standard, options(standard, form="xmu"))
    np.testing.assert_array_equal(result["difference"], np.full_like(x, value))
    assert result["area"] == pytest.approx(value * 50)
    assert result["integration"]["converged"] is True
    assert result["warnings"] == []


def natural_spline(x, y, grid):
    """Solve natural second derivatives, then evaluate the cubic pieces."""
    n = len(x)
    h = np.diff(x)
    matrix = np.zeros((n, n))
    matrix[0, 0] = matrix[-1, -1] = 1
    rhs = np.zeros(n)
    for i in range(1, n - 1):
        matrix[i, i - 1:i + 2] = [h[i - 1], 2 * (h[i - 1] + h[i]), h[i]]
        rhs[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1])
    curvature = np.linalg.solve(matrix, rhs)
    i = np.clip(np.searchsorted(x, grid, side="right") - 1, 0, n - 2)
    width = x[i + 1] - x[i]
    left, right = (x[i + 1] - grid) / width, (grid - x[i]) / width
    return (left * y[i] + right * y[i + 1] + width**2 / 6 *
            ((left**3 - left) * curvature[i] + (right**3 - right) * curvature[i + 1]))


def reference_romberg(x, y, lower, upper):
    previous = None
    for iteration in range(7):
        grid = np.linspace(lower, upper, 2**iteration + 1)
        diagonal = float(romb(natural_spline(x, y, grid), dx=(upper - lower) / 2**iteration))
        if previous is not None and abs(diagonal - previous) <= 1e-5:
            return diagonal, True, iteration
        previous = diagonal
    return previous, False, 6


@pytest.mark.parametrize("frequency", [0.03, 0.83])
def test_natural_cubic_spline_and_six_step_romberg_match_independent_source_oracle(frequency):
    x = np.linspace(8950, 9050, 51)
    y = np.sin(frequency * (x - 8950)) + 0.003 * (x - 8997)**2
    data = spectrum("data", x, y)
    standard = spectrum("standard", x, np.zeros_like(x))
    expected, converged, iterations = reference_romberg(x, y, 8981, 9029)
    result = difference_spectrum(data, standard, options(standard, form="xmu", xmin=-19, xmax=29))
    assert result["area"] == pytest.approx(expected, abs=1e-10)
    assert result["integration"]["converged"] is converged
    assert result["integration"]["iterations"] == iterations
    assert bool(result["warnings"]) is (not converged)
    if frequency == 0.83:
        assert not converged and iterations == 6
        assert "last finite estimate" in result["warnings"][0]


@pytest.mark.parametrize("invert", [False, True])
def test_names_resolve_forms_format_numeric_tokens_and_leave_unknown_tokens(invert):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.ones_like(x), flat=np.full_like(x, 3))
    standard = spectrum("standard", x, np.ones_like(x), flat=np.ones_like(x))
    data["label"], standard["label"] = "D%a", "S%d"
    result = difference_spectrum(data, standard, options(standard, multiplier=1.25, invert=invert,
        xmin=-10, xmax=10, name_template="%d|%s|%f|%m|%n|%x|%a|%%|%q|%"))
    sign = -1 if invert else 1
    names = "S%d|D%a" if invert else "D%a|S%d"
    assert result["label"] == f"{names}|flat|1.25|-10|10|{sign * 35:.5f}|%|%q|%"


def test_disabled_integration_needs_no_e0_or_processed_arrays_and_does_not_invent_area():
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, x / 100)
    standard = spectrum("standard", x, x / 200)
    data["result"] = standard["result"] = None
    data["processing_error"] = "No absorption edge exists in this signed scan."
    result = difference_spectrum(data, standard, options(standard, form="xmu", integrate=False,
        xmin=-1e20, xmax=1e20, name_template="%a", plot_inputs=False, plot_space="k", renormalize=True))
    assert result["area"] is result["integration"] is result["e0"] is None
    assert result["label"] == "n/a"
    np.testing.assert_allclose(result["difference"], x / 200)
    assert_json_report(result)


@pytest.mark.parametrize("form,y_unit,area_unit", [
    ("xmu", "input μ units", "input μ units·eV"),
    ("norm", "normalized", "eV"),
    ("der", "input μ units/eV", "input μ units"),
    ("nder", "eV⁻¹", "dimensionless"),
    ("sec", "input μ units/eV²", "input μ units/eV"),
    ("nsec", "eV⁻²", "eV⁻¹"),
])
def test_labels_track_signal_and_integral_dimensions(form, y_unit, area_unit):
    x = np.arange(8960.0, 9041.0)
    group = spectrum("same", x, np.sin(x))
    result = difference_spectrum(group, group, options(group, form=form))
    assert y_unit in result["y_label"] and area_unit in result["area_label"]
    assert result["area"] == 0


@pytest.mark.parametrize("patch", [
    {"standard_id": ""}, {"standard_id": "  "}, {"standard_id": 1}, {"standard_id": "x" * 201},
    {"form": "flat"}, {"form": "chi"}, {"multiplier": "1.2"}, {"multiplier": True},
    {"multiplier": float("nan")}, {"multiplier": float("inf")},
    {"invert": 1}, {"integrate": "false"}, {"plot_inputs": 0}, {"plot_space": "R"},
    {"renormalize": 1}, {"xmin": "-20"}, {"xmin": float("nan")}, {"xmax": float("inf")},
    {"xmin": 30, "xmax": 30}, {"xmin": 40, "xmax": 30},
    {"name_template": "x" * 201}, {"name_template": 42}, {"unknown": True},
])
def test_options_reject_coercion_nonfinite_values_unordered_ranges_and_extra_fields(patch):
    with pytest.raises(ValidationError):
        DifferenceOptions.model_validate({"standard_id": "standard", **patch})


def test_options_require_standard_preserve_nullable_policy_and_validate_assignment():
    with pytest.raises(ValidationError):
        DifferenceOptions()
    defaults = DifferenceOptions(standard_id="native/id")
    assert defaults.model_dump() == {"standard_id": "native/id", "form": "norm", "multiplier": 1.0,
        "invert": False, "integrate": True, "xmin": -20.0, "xmax": 30.0, "renormalize": None,
        "name_template": "diff %d - %s", "plot_inputs": True, "plot_space": "E"}
    assert DifferenceOptions(standard_id="standard", form="xmu").renormalize is None
    with pytest.raises(ValidationError):
        defaults.multiplier = float("inf")


@pytest.mark.parametrize("damage,message", [
    ("chi", "energy data"), ("duplicate", "strictly increasing"),
    ("nan", "NaN"), ("complex", "real numeric"), ("negative-energy", "positive eV"),
    ("shift-inf", "energy_shift"), ("short", "5 to 100000"), ("oversize", "5 to 100000"),
])
def test_invalid_raw_inputs_fail_without_processing_or_modification(damage, message):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, x / 100)
    standard = spectrum("standard", x, x / 200)
    if damage == "chi":
        data["data_type"] = "chi"
    elif damage == "duplicate":
        data["energy"][10] = data["energy"][9]
    elif damage == "nan":
        data["mu"][10] = float("nan")
    elif damage == "complex":
        data["mu"][10] = 1j
    elif damage == "negative-energy":
        data["parameters"]["energy_shift"] = -10000
    elif damage == "shift-inf":
        data["parameters"]["energy_shift"] = float("inf")
    elif damage in ("short", "oversize"):
        count = 4 if damage == "short" else 100001
        data["energy"] = np.linspace(8960, 9040, count).tolist()
        data["mu"] = np.ones(count).tolist()
    before = repr(data)
    with pytest.raises(ScientificError, match=message):
        difference_spectrum(data, standard, options(standard, form="xmu", integrate=False))
    assert repr(data) == before


@pytest.mark.parametrize("damage,message", [
    ("missing-flat", "no flat array"), ("missing-norm", "no norm array"),
    ("length", "equal length"), ("stale-axis", "shifted source axis"),
    ("failed-processing", "apply valid processing"), ("invalid-flatten", "flatten must be a boolean"),
])
def test_normalized_forms_require_valid_saved_arrays_and_preferences(damage, message):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.sin(x))
    standard = spectrum("standard", x, np.cos(x))
    form = "norm"
    if damage == "missing-flat":
        del data["result"]["arrays"]["flat"]
    elif damage == "missing-norm":
        del data["result"]["arrays"]["norm"]
        form = "nder"
    elif damage == "length":
        data["result"]["arrays"]["flat"].pop()
    elif damage == "stale-axis":
        data["result"]["arrays"]["energy"] = (x + 3).tolist()
    elif damage == "failed-processing":
        data["processing_error"] = "Bad normalization range."
    else:
        data["parameters"]["flatten"] = 1
    with pytest.raises(ScientificError, match=message):
        difference_spectrum(data, standard, options(standard, form=form, integrate=False))


@pytest.mark.parametrize("reason", ["wrong-standard", "missing-e0", "nonpositive-e0", "outside-integration"])
def test_identity_and_integration_failures_are_explicit(reason):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.ones_like(x))
    standard = spectrum("standard", x, np.zeros_like(x))
    choice = options(standard, form="xmu")
    if reason == "wrong-standard":
        choice.standard_id = "another"
        message = "standard_id"
    elif reason in ("missing-e0", "nonpositive-e0"):
        data["result"]["effective"]["e0"] = None if reason == "missing-e0" else 0
        message = "positive finite data-group E0"
    else:
        choice.xmax = 50
        message = "Integration bounds"
    before = deepcopy([data, standard])
    with pytest.raises(ScientificError, match=message):
        difference_spectrum(data, standard, choice)
    assert [data, standard] == before


def test_integration_uses_full_standard_spline_domain_without_spline_extrapolation():
    dx, sx = np.arange(8955.0, 9046.0), np.arange(8950.0, 9051.0, 10)
    data = spectrum("data", dx, np.ones_like(dx))
    standard = spectrum("standard", sx, np.zeros_like(sx))
    # The template permits DATA endpoint extrapolation to 8950 and 9050;
    # only extrapolating the subsequent integration spline is forbidden.
    result = difference_spectrum(data, standard, options(standard, form="xmu", xmin=-50, xmax=50))
    np.testing.assert_array_equal(result["energy"], sx)
    assert result["area"] == pytest.approx(100)
    assert result["extrapolated_points"] == 2
    assert any("integration interval includes extrapolated" in warning for warning in result["warnings"])
    with pytest.raises(ScientificError, match="8950 to 9050"):
        difference_spectrum(data, standard, options(standard, form="xmu", xmin=-51, xmax=20))


def test_extreme_finite_multiplier_rejects_nonfinite_output_cleanly():
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.ones_like(x))
    standard = spectrum("standard", x, np.full_like(x, 1e200))
    with pytest.raises(ScientificError, match="rescale"):
        difference_spectrum(data, standard, options(standard, form="xmu", multiplier=1e200, integrate=False))


def test_full_standard_grid_uses_linear_endpoint_extrapolation_not_clamping_or_cropping():
    dx, sx = np.arange(8990.0, 9011, 2), np.arange(8986.0, 9015)
    dy = (dx - 9000)**2
    data = spectrum("data", dx, dy)
    standard = spectrum("standard", sx, np.zeros_like(sx))
    expected = np.interp(sx, dx, dy)
    below, above = sx < dx[0], sx > dx[-1]
    expected[below] = dy[0] + (sx[below] - dx[0]) * (dy[1] - dy[0]) / (dx[1] - dx[0])
    expected[above] = dy[-1] + (sx[above] - dx[-1]) * (dy[-1] - dy[-2]) / (dx[-1] - dx[-2])
    result = difference_spectrum(data, standard, options(standard, form="xmu", xmin=-10, xmax=10))
    np.testing.assert_array_equal(result["energy"], sx)
    np.testing.assert_allclose(result["difference"], expected, atol=1e-9)
    assert result["extrapolated_points"] == 8
    assert result["difference"][0] > dy[0] and result["difference"][-1] > dy[-1]
    assert any("estimates, not measured" in warning for warning in result["warnings"])
    assert not any("integration interval includes" in warning for warning in result["warnings"])


@pytest.mark.parametrize("direction", [-1, 1])
def test_disjoint_reference_grid_is_returned_with_explicit_all_extrapolated_warning(direction):
    dx = np.arange(8990.0, 9011)
    sx = np.arange(8990.0, 9011) + direction * 100
    data = spectrum("data", dx, 2 * (dx - 9000) + 3)
    standard = spectrum("standard", sx, np.zeros_like(sx))
    result = difference_spectrum(data, standard, options(standard, form="xmu",
        xmin=direction * 100 - 10, xmax=direction * 100 + 10))
    np.testing.assert_array_equal(result["energy"], sx)
    np.testing.assert_allclose(result["difference"], 2 * (sx - 9000) + 3, atol=1e-9)
    assert result["extrapolated_points"] == len(sx)
    assert result["area"] == pytest.approx((direction * 200 + 3) * 20, abs=1e-8)
    assert any("integration interval includes extrapolated" in warning for warning in result["warnings"])
    assert_json_report(result)


@pytest.mark.parametrize("form", ["xmu", "der", "sec"])
@pytest.mark.parametrize("effective_e0", [None, float("nan"), float("inf")])
def test_raw_integration_uses_saved_physical_e0_despite_normalization_failure(form, effective_e0):
    x = np.arange(8960.0, 9041.0)
    data = spectrum("difference", x, -0.02 * (x - 9000)**2, shift=3, e0=effective_e0)
    data["is_difference"] = True
    data["parameters"]["e0"] = 9003
    data["processing_error"] = "There is no positive absorption edge."
    data["result"]["arrays"] = {}
    standard = spectrum("standard", x, np.zeros_like(x), shift=3, e0=9010)
    result = difference_spectrum(data, standard, options(standard, form=form, xmin=-10, xmax=10))
    assert result["e0"] == 9003  # Already physical: do not add shift twice.
    assert (result["integration"]["lower"], result["integration"]["upper"]) == (8993, 9013)
    assert np.isfinite(result["area"])
    assert_json_report(result)


def test_finite_effective_e0_takes_precedence_over_saved_parameter():
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, x - 9000, e0=9000)
    data["parameters"]["e0"] = 9010
    standard = spectrum("standard", x, np.zeros_like(x))
    result = difference_spectrum(data, standard, options(standard, form="xmu", xmin=-10, xmax=10))
    assert result["e0"] == 9000 and result["area"] == pytest.approx(0, abs=1e-12)


@pytest.mark.parametrize("xmin,xmax", [(30, -20), (7, 7)])
def test_disabled_integration_allows_unordered_finite_naming_bounds(xmin, xmax):
    x = np.arange(8960.0, 9041.0)
    group = spectrum("data", x, np.ones_like(x))
    choice = options(group, form="xmu", integrate=False, xmin=xmin, xmax=xmax, name_template="%m %n %x %a")
    result = difference_spectrum(group, group, choice)
    assert result["area"] is result["integration"] is None
    assert result["label"] == f"1 {xmin} {xmax} n/a"
    with pytest.raises(ValidationError):
        DifferenceOptions.model_validate(choice.model_dump() | {"integrate": True})


def test_expanded_label_is_truncated_in_preview_with_an_explicit_warning():
    x = np.arange(8960.0, 9041.0)
    data = spectrum("data", x, np.ones_like(x))
    standard = spectrum("standard", x, np.ones_like(x))
    data["label"], standard["label"] = "D" * 190, "S" * 190
    result = difference_spectrum(data, standard, options(standard, form="xmu", integrate=False))
    assert result["label"] == ("diff " + data["label"] + " - " + standard["label"])[:200]
    assert len(result["label"]) == 200
    assert any("truncated" in warning and "200" in warning for warning in result["warnings"])


@pytest.fixture(scope="module")
def measured_pt_groups():
    """Original Demeter diff.prj; explicit Larch degree-2 normalization oracle.

    All seven records have bkg_nnorm=3 and fixstep=0. Normalize with Larch
    nnorm=2, saved E0/pre/norm windows and per-record flatten, refitting step.
    This is the chosen Larch recipe, not a native-import order-mapping test
    or a claim that Larch's normalization duplicates Ifeffit's coefficients.
    Native fnorm affects background removal; it does not replace E-space mu.
    """
    native = read_athena(str(Path(__file__).parent / "fixtures" / "demeter-diff.prj"),
                         do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    assert len(native.groups) == 21
    records = list(native.groups.items())
    groups = {}
    for record in (1, 6, 9, 12, 15, 18, 21):
        ident, raw = records[record - 1]
        bkg = raw.athena_params.bkg
        assert bkg.nnorm == 3 and bkg.fixstep == 0 and bkg.z == "Pt"
        shift, flatten = float(bkg.eshift), bkg.flatten == 1
        physical = np.asarray(raw.energy) + shift
        normalized = Group()
        pre_edge(physical, raw.mu, group=normalized, e0=float(bkg.e0),
                 pre1=float(bkg.pre1), pre2=float(bkg.pre2), norm1=float(bkg.nor1),
                 norm2=float(bkg.nor2), nnorm=2, make_flat=flatten)
        item = spectrum(ident, raw.energy, raw.mu, shift=shift, e0=normalized.e0, flatten=flatten,
                        norm=normalized.norm, flat=normalized.flat)
        item["label"] = raw.label
        groups[record] = item
    return groups


@pytest.mark.parametrize("record", [6, 9, 12, 15, 18, 21])
def test_measured_pt_difference_demo_matches_independent_larch_recipe_and_source_integration(measured_pt_groups, record):
    data, standard = measured_pt_groups[record], measured_pt_groups[1]
    before = deepcopy([data, standard])
    dx = np.asarray(data["energy"]) + data["parameters"]["energy_shift"]
    sx = np.asarray(standard["energy"]) + standard["parameters"]["energy_shift"]
    data_y = np.asarray(data["result"]["arrays"]["flat" if data["parameters"]["flatten"] else "norm"])
    standard_y = np.asarray(standard["result"]["arrays"]["flat" if standard["parameters"]["flatten"] else "norm"])
    expected = interp(dx, data_y, sx) - standard_y
    e0 = data["result"]["effective"]["e0"]
    area, converged, iterations = reference_romberg(sx, expected, e0 - 20, e0 + 30)
    result = difference_spectrum(data, standard, options(standard))
    assert result["label"] == f"diff scan {record} - scan 1"
    assert result["data_form"] == result["standard_form"] == "flat"
    assert len(result["energy"]) == 161 and result["extrapolated_points"] == 0
    np.testing.assert_array_equal(result["energy"], sx)
    np.testing.assert_allclose(result["difference"], expected, atol=1e-12)
    assert np.max(np.abs(expected)) > 0.01  # These are changing measured spectra.
    assert result["area"] == pytest.approx(area, abs=1e-10)
    assert f"{result['area']:.3f}" == f"{area:.3f}"  # diff.pl's displayed precision.
    assert result["integration"] == {"xmin": -20, "xmax": 30, "lower": e0 - 20,
        "upper": e0 + 30, "converged": converged, "iterations": iterations}
    assert [data, standard] == before
    assert_json_report(result)
