"""Numerical contracts for core Athena-style science (not desktop parity)."""

import json
from pathlib import Path

import numpy as np
import pytest
from larch import Group
from larch.xafs import autobk, find_e0, pre_edge, xftf, xftr
from larch.xafs.xafsft import ftwindow, xftf_fast
from pydantic import ValidationError

import xraylarch_web.athena_science as science
from xraylarch_web.athena_science import (
    ARRAY_NAMES,
    AthenaParameters,
    ScientificError,
    align_shift,
    calibrate_shift,
    combine_spectra,
    linear_combination,
    merge_spectra,
    principal_components,
    process_spectrum,
)


def direct_pipeline(energy, mu, effective, flatten=True):
    """Independent calls to the actual checkout's Larch routines."""
    e = effective
    group = Group()
    pre_edge(energy, mu, group=group, make_flat=flatten,
             **{key: e[key] for key in ("e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm")})
    autobk(energy, mu, group=group, ek0=e["e0"], edge_step=e["edge_step"],
           rbkg=e["rbkg"], kmin=e["bkg_kmin"], kmax=e["bkg_kmax"],
           kweight=e["bkg_kweight"], clamp_lo=e["clamp_lo"], clamp_hi=e["clamp_hi"],
           dk=e["bkg_dk"], win=e["bkg_window"], nclamp=e["nclamp"],
           nfft=e["nfft"], kstep=e["kstep"])
    # Compensate for this checkout's integer cast; integer cases still call
    # the original high-level weighted transform on unchanged chi.
    integer_weight = int(e["kweight"])
    chi_for_ft = group.chi * group.k ** (e["kweight"] - integer_weight)
    xftf(group.k, chi_for_ft, group=group, kmin=e["kmin"], kmax=e["kmax"],
         kweight=integer_weight, dk=e["dk"], window=e["window"],
         nfft=e["nfft"], kstep=e["kstep"], rmax_out=e["rmax_out"])
    xftr(group.r, group.chir, group=group, rmin=e["rmin"], rmax=e["rmax"],
         dr=e["dr"], window=e["rwindow"], nfft=e["nfft"], kstep=e["kstep"],
         qmax_out=e["qmax_out"])
    group.chir_pha = np.unwrap(np.angle(group.chir))
    group.chiq_pha = np.unwrap(np.angle(group.chiq))
    return group


@pytest.mark.parametrize("overrides", [
    {},
    dict(e0=8980, step=0.85, pre1=-200, pre2=-40, norm1=35, norm2=300,
         nnorm=1, flatten=False, rbkg=1.2, bkg_kmin=0.5, bkg_kmax=9,
         bkg_kweight=1.5, bkg_dk=0.6, bkg_window="welch", nclamp=7,
         clamp_lo=1, clamp_hi=2, kmin=2, kmax=8,
         kweight=3, dk=0.5, window="parzen", rmin=0.5, rmax=4,
         dr=0.25, rwindow="welch", nfft=4096, kstep=0.04),
    dict(bkg_kweight=0.75, kweight=2.25, bkg_dk=0.75, nclamp=0),
])
def test_pipeline_matches_direct_larch_and_preserves_input(xas_arrays, overrides):
    energy, mu = xas_arrays
    before = energy.copy(), mu.copy()
    p = AthenaParameters(**overrides)
    result = process_spectrum(energy, mu, p)
    arrays, effective = result["arrays"], result["effective"]
    direct = direct_pipeline(energy, mu, effective, p.flatten)
    assert set(arrays) == set(ARRAY_NAMES)
    for key in ARRAY_NAMES:
        if key in ("energy", "mu", "weighted_chi"):
            continue
        np.testing.assert_allclose(arrays[key], getattr(direct, key), rtol=1e-11, atol=1e-11, err_msg=key)
    np.testing.assert_allclose(arrays["weighted_chi"], direct.chi * direct.k ** p.kweight)
    np.testing.assert_array_equal(energy, before[0])
    np.testing.assert_array_equal(mu, before[1])
    assert effective["exafs"] is True
    assert effective["edge_step"] > 0
    assert len(arrays["kwin"]) == len(arrays["k"]) == len(arrays["weighted_chi"])
    assert len(arrays["q"]) == len(arrays["chiq_re"]) == len(arrays["chiq_mag"]) == len(arrays["chiq_im"]) == len(arrays["chiq_pha"])
    assert len(arrays["r"]) == len(arrays["chir_re"]) == len(arrays["rwin"]) == len(arrays["chir_pha"])
    assert result["warnings"] == []
    json.dumps(result, allow_nan=False)


def test_default_normalization_really_matches_larch_defaults(xas_arrays):
    energy, mu = xas_arrays
    direct = Group()
    pre_edge(energy, mu, group=direct)
    result = process_spectrum(energy, mu, {})
    assert result["effective"]["e0"] == direct.e0 == 8980
    assert result["effective"]["edge_step"] == pytest.approx(direct.edge_step)
    for key in ("pre1", "pre2", "norm1", "norm2", "nnorm"):
        assert result["effective"][key] == getattr(direct.pre_edge_details, key)
    np.testing.assert_allclose(result["arrays"]["norm"], direct.norm, rtol=1e-12)
    assert result["effective"]["kmax"] == pytest.approx(result["arrays"]["k"][-1] - 1)


def test_missing_saved_background_fields_use_athena_defaults(xas_arrays):
    saved = AthenaParameters().model_dump()
    for key in ("bkg_dk", "bkg_window", "nclamp"):
        del saved[key]
    implicit = process_spectrum(*xas_arrays, {})
    restored = process_spectrum(*xas_arrays, saved)
    explicit = process_spectrum(*xas_arrays, {"bkg_dk": 1, "bkg_window": "hanning", "nclamp": 5})
    assert restored == explicit == implicit
    assert restored["effective"]["bkg_dk"] == 1
    assert restored["effective"]["bkg_window"] == "hanning"
    assert restored["effective"]["nclamp"] == 5


def test_fractional_weights_survive_saved_recipe_and_model_assignment():
    parameters = AthenaParameters(kweight=1.25, bkg_kweight=2.75)
    restored = AthenaParameters.model_validate_json(parameters.model_dump_json())
    assert restored.kweight == 1.25 and restored.bkg_kweight == 2.75
    restored.kweight = 3.125
    restored.bkg_kweight = 0.125
    assert restored.kweight == 3.125 and restored.bkg_kweight == 0.125
    with pytest.raises(ValidationError):
        restored.kweight = np.nan


def test_forward_controls_do_not_change_the_background_solution(xas_arrays):
    first = process_spectrum(*xas_arrays, {"kweight": 1.25, "dk": 0.5, "window": "parzen"})
    second = process_spectrum(*xas_arrays, {"kweight": 3.5, "dk": 1.5, "window": "welch"})
    for key in ("norm", "bkg", "k", "chi"):
        np.testing.assert_array_equal(first["arrays"][key], second["arrays"][key])
    for key in ("bkg_dk", "bkg_window", "nclamp", "bkg_kweight"):
        assert first["effective"][key] == second["effective"][key]
    assert not np.allclose(first["arrays"]["chir_mag"], second["arrays"]["chir_mag"])


@pytest.mark.parametrize("override", [
    {"bkg_dk": 0.3}, {"bkg_window": "welch"}, {"nclamp": 0}, {"bkg_kweight": 0.75},
])
def test_spline_controls_change_chi_without_changing_ft_settings(xas_arrays, override):
    baseline = process_spectrum(*xas_arrays, {})
    changed = process_spectrum(*xas_arrays, override)
    np.testing.assert_array_equal(baseline["arrays"]["norm"], changed["arrays"]["norm"])
    np.testing.assert_array_equal(baseline["arrays"]["kwin"], changed["arrays"]["kwin"])
    assert not np.allclose(baseline["arrays"]["chi"], changed["arrays"]["chi"], rtol=1e-7, atol=1e-10)
    for key, value in override.items():
        assert changed["effective"][key] == value
    for key in ("dk", "window", "kweight", "kmin", "kmax"):
        assert changed["effective"][key] == baseline["effective"][key]


@pytest.mark.parametrize("window", ["hanning", "parzen", "welch", "gaussian", "sine", "kaiser"])
def test_background_window_and_fractional_weight_match_direct_autobk(xas_arrays, window):
    x, y = xas_arrays
    params = {"e0": 8980, "bkg_window": window, "bkg_dk": 1.2, "bkg_kweight": 1.25, "nclamp": 6}
    actual = process_spectrum(x, y, params)
    effective = actual["effective"]
    direct = Group()
    autobk(x, y, group=direct, ek0=8980, edge_step=effective["edge_step"],
           kmax=effective["bkg_kmax"], win=window, dk=1.2, kweight=1.25, nclamp=6)
    np.testing.assert_allclose(actual["arrays"]["bkg"], direct.bkg, atol=1e-12)
    np.testing.assert_allclose(actual["arrays"]["chi"], direct.chi, atol=1e-12)
    assert {key: effective[key] for key in params} == params


@pytest.mark.parametrize("weight", [0.0, 0.5, 1.75, 3.125, 4.0])
def test_real_forward_weight_matches_low_level_larch_fft(weight):
    k = np.arange(0, 14.0001, 0.05)
    chi = np.sin(4.6 * k + 0.3) * np.exp(-0.015 * k**2)
    parameters = {"kweight": weight, "kmin": 2, "kmax": 12, "dk": 0.6, "window": "hanning"}
    result = process_spectrum(k, chi, parameters, "chi")
    arrays = result["arrays"]
    kwin = ftwindow(k, xmin=2, xmax=12, dx=0.6, dx2=0.6, window="hanning")
    expected = xftf_fast(chi * k**weight * kwin, nfft=2048, kstep=0.05)[:len(arrays["r"])]
    actual = np.array(arrays["chir_re"]) + 1j * np.array(arrays["chir_im"])
    np.testing.assert_allclose(actual, expected, atol=1e-11)
    np.testing.assert_allclose(arrays["weighted_chi"], chi * k**weight, atol=1e-12)
    assert result["effective"]["kweight"] == weight
    if not weight.is_integer():
        truncated = xftf_fast(chi * k**int(weight) * kwin, nfft=2048, kstep=0.05)[:len(actual)]
        assert not np.allclose(actual, truncated)


def test_complex_backtransform_retains_sign_and_phase():
    k = np.arange(0, 14.0001, 0.05)
    chi = np.sin(4.6 * k + 0.2) * np.exp(-0.015 * k**2)
    result = process_spectrum(k, chi, {"kweight": 1.25, "dr": 0.3}, "chi")
    arrays, e = result["arrays"], result["effective"]
    chir = np.array(arrays["chir_re"]) + 1j * np.array(arrays["chir_im"])
    direct = Group()
    xftr(np.array(arrays["r"]), chir, group=direct, rmin=1, rmax=3, dr=0.3,
         window="hanning", nfft=2048, kstep=0.05, qmax_out=e["qmax_out"])
    chiq = np.array(arrays["chiq_re"]) + 1j * np.array(arrays["chiq_im"])
    np.testing.assert_array_equal(arrays["q"], direct.q)
    np.testing.assert_allclose(chiq, direct.chiq, atol=1e-12)
    assert np.any(chiq.imag < -1e-3) and np.any(chiq.imag > 1e-3)
    for spectrum, phase, magnitude in ((chir, arrays["chir_pha"], arrays["chir_mag"]),
                                       (chiq, arrays["chiq_pha"], arrays["chiq_mag"])):
        np.testing.assert_allclose(phase, np.unwrap(np.angle(spectrum)), atol=1e-12)
        np.testing.assert_allclose(np.array(magnitude) * np.exp(1j * np.array(phase)), spectrum, atol=1e-11)
    json.dumps(result, allow_nan=False)


def test_d2mude_matches_larch_on_irregular_shifted_energy_grid():
    x = np.linspace(0, 1, 1201)**1.3 * 600 + 8750
    y = 0.15 + 0.00002 * (x - 8750) + 0.9 / (1 + np.exp(-(x - 8980) / 2.5))
    result = process_spectrum(x, y, {"e0": 8984, "energy_shift": 4}, "xanes")
    direct = Group()
    e = result["effective"]
    pre_edge(x + 4, y, group=direct,
             **{key: e[key] for key in ("e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm")})
    np.testing.assert_allclose(result["arrays"]["d2mude"], direct.d2mude, atol=1e-12)
    assert any(value != 0 for value in result["arrays"]["d2mude"])
    assert len(result["arrays"]["d2mude"]) == len(x)


def test_normalized_input_second_derivative_and_inactive_background_settings():
    x = np.linspace(8970, 8990, 201)
    y = 1 / (1 + np.exp(-(x - 8980)))
    result = process_spectrum(x, y, {"e0": 8980}, "norm")
    expected = np.gradient(np.gradient(y) / np.gradient(x)) / np.gradient(x)
    np.testing.assert_allclose(result["arrays"]["d2mude"], expected, atol=1e-12)
    assert all(result["effective"][key] is None for key in ("bkg_dk", "bkg_window", "nclamp", "bkg_kweight"))
    assert all(result["arrays"][key] == [] for key in ("chir_pha", "chiq_im", "chiq_pha"))


@pytest.fixture
def fluorescence_arrays():
    """Rising low-energy fluorescence envelope with known EXAFS modulation."""
    energy = np.linspace(2300, 3000, 1401)
    k = np.sqrt(np.maximum(0, (energy - 2472) * science.ETOK))
    edge = 1 / (1 + np.exp(-(energy - 2472) / 1.5))
    chi = 0.04 * np.sin(5 * k) * np.exp(-0.012 * k*k)
    response = 1 + 0.002 * (energy - 2472) + 1e-6 * (energy - 2472)**2
    return energy, edge * response * (1 + chi), edge * (1 + chi)


def test_fnorm_defaults_and_saved_recipe_roundtrip_preserve_existing_outputs(xas_arrays):
    recipe = AthenaParameters().model_dump()
    assert recipe.pop("fnorm") is False
    old = process_spectrum(*xas_arrays, recipe)
    explicit = process_spectrum(*xas_arrays, {**recipe, "fnorm": False}, background_standard=None)
    assert old == explicit == process_spectrum(*xas_arrays, {})
    assert old["effective"]["fnorm"] is False
    assert old["effective"]["fnorm_edge_step"] is None
    assert old["effective"]["fnorm_scale"] is None
    assert old["effective"]["background_standard"] is False
    enabled = AthenaParameters(fnorm=True)
    assert AthenaParameters.model_validate_json(enabled.model_dump_json()).fnorm is True
    enabled.fnorm = False
    assert enabled.fnorm is False


@pytest.mark.parametrize("invalid", [None, 0, 1, 0.5, "true", "false", [], np.nan])
def test_fnorm_requires_a_boolean(invalid):
    with pytest.raises(ValidationError, match="fnorm"):
        AthenaParameters(fnorm=invalid)


def test_functional_normalization_matches_demeter_array_operations():
    # Independent hand calculation of fnorm.tmpl: ceil([1.2,1.8,2.4]) is
    # max=2.4, giving [1,1,0.5,0.75,1], then divide the ENTIRE mu signal.
    x = np.array([100, 102, 104, 106, 108.0])
    mu = np.array([0.1, 0.2, 1.5, 1.8, 2.5])
    pre = np.full(5, 0.2)
    post = np.array([-1, 0, 1.4, 2.0, 2.6])
    before = [value.copy() for value in (x, mu, pre, post)]
    corrected, scale = science._functional_normalization(x, mu, pre, post, 104)
    assert scale == pytest.approx(2.4)
    np.testing.assert_allclose(corrected, [0.1, 0.2, 3, 2.4, 2.5])
    for value, original in zip((x, mu, pre, post), before):
        np.testing.assert_array_equal(value, original)


def test_fnorm_uses_ifeffit_parser_nearest_sample_with_lower_midpoint_tie():
    corrected, scale = science._functional_normalization(
        np.array([100, 102, 104, 106.0]), np.array([0.1, 1, 2, 3.0]),
        np.zeros(4), np.array([1, 2, 3, 4.0]), 103)
    assert scale == 4
    np.testing.assert_allclose(corrected, [0.1, 2, 8 / 3, 3])


def test_fnorm_keeps_energy_shift_and_native_grids_consistent(fluorescence_arrays):
    x, y, _ = fluorescence_arrays
    params = {"e0": 2477, "fnorm": True, "nclamp": 0, "norm1": 80, "norm2": 500}
    shifted = process_spectrum(x, y, {**params, "energy_shift": 5})
    direct = process_spectrum(x + 5, y, params)
    assert shifted["arrays"] == direct["arrays"]
    assert shifted["effective"]["fnorm_scale"] == direct["effective"]["fnorm_scale"]
    ordinary = process_spectrum(x + 5, y, {**params, "fnorm": False})
    for key in ("k", "r", "q"):
        np.testing.assert_array_equal(shifted["arrays"][key], ordinary["arrays"][key])


@pytest.mark.parametrize("step", [None, 2.0])
def test_fnorm_refits_mu_before_autobk_and_preserves_energy_outputs(fluorescence_arrays, step):
    x, y, _ = fluorescence_arrays
    params = {"e0": 2472, "norm1": 80, "norm2": 500, "nnorm": 2, "step": step,
              "nclamp": 0, "bkg_kweight": 1.5, "kweight": 2.25}
    baseline = process_spectrum(x, y, params)
    result = process_spectrum(x, y, {**params, "fnorm": True})
    # Numerical reference: literal Demeter template array operations followed
    # by independent public Larch pre_edge/autobk/FT calls on corrected mu.
    a, e = baseline["arrays"], result["effective"]
    nearest = int(np.argmin(abs(x - params["e0"])))
    denominator = np.array(a["post_edge"]) - np.array(a["pre_edge"])
    factor = np.r_[np.ones(nearest), denominator[nearest:] / max(denominator[nearest:])]
    corrected_mu = y / factor
    normalized = Group()
    pre_edge(x, corrected_mu, group=normalized, e0=2472, step=step, make_flat=False,
             **{key: e[key] for key in ("pre1", "pre2", "norm1", "norm2", "nnorm")})
    direct = direct_pipeline(x, corrected_mu, {**e, "step": normalized.edge_step, "edge_step": normalized.edge_step})
    assert e["fnorm"] is True
    assert e["edge_step"] == baseline["effective"]["edge_step"]
    assert e["fnorm_edge_step"] == pytest.approx(normalized.edge_step)
    assert e["fnorm_scale"] == pytest.approx(max(denominator[nearest:]))
    for key in ("energy", "mu", "norm", "flat", "pre_edge", "post_edge", "bkg", "dmude", "d2mude"):
        np.testing.assert_array_equal(result["arrays"][key], baseline["arrays"][key], err_msg=key)
    for key in ("k", "chi", "chir_re", "chir_im", "chiq_re", "chiq_im", "chiq_pha"):
        np.testing.assert_allclose(result["arrays"][key], getattr(direct, key), atol=1e-10, rtol=1e-10, err_msg=key)
    assert not np.allclose(result["arrays"]["chi"], baseline["arrays"]["chi"])
    # A correction applied only after the old background fit is not this method.
    chi_energy = params["e0"] + np.array(a["k"])**2 / science.ETOK
    posthoc = np.array(a["chi"]) / np.interp(chi_energy, x, factor)
    assert not np.allclose(result["arrays"]["chi"], posthoc)
    assert any("E-space" in warning and "fluorescence" in warning for warning in result["warnings"])
    json.dumps(result, allow_nan=False)


def test_fnorm_corrects_synthetic_fluorescence_amplitude_growth(fluorescence_arrays):
    x, measured, unamplified = fluorescence_arrays
    params = {"e0": 2472, "norm1": 80, "norm2": 500, "nnorm": 2, "nclamp": 0}
    reference = process_spectrum(x, unamplified, params)["arrays"]
    ordinary = process_spectrum(x, measured, params)["arrays"]
    corrected = process_spectrum(x, measured, {**params, "fnorm": True})["arrays"]
    reliable = (np.array(reference["k"]) >= 4) & (np.array(reference["k"]) <= 10)
    truth = np.array(reference["chi"])[reliable]
    before = np.linalg.norm(np.array(ordinary["chi"])[reliable] - truth)
    after = np.linalg.norm(np.array(corrected["chi"])[reliable] - truth)
    assert after < before * 0.25


@pytest.mark.parametrize("bad_post", [[1, 1, 0, 1], [1, 1, -1, 1], [1, 1, np.inf, 1]])
def test_fnorm_rejects_nonpositive_or_nonfinite_postedge_divisors(bad_post):
    with pytest.raises(ScientificError, match="fnorm.*post_edge"):
        science._functional_normalization(np.arange(100, 104.0), np.ones(4), np.zeros(4), np.array(bad_post), 101)


def test_fnorm_and_standard_reject_numerical_overflow_and_oversized_standard(xas_arrays):
    with pytest.raises(ScientificError, match="fnorm correction overflowed"):
        science._functional_normalization(np.arange(100, 104.0), np.full(4, 1e308),
                                           np.zeros(4), np.array([1, 1e-10, 1, 1.0]), 101)
    k = np.linspace(0, 12, 100)
    with pytest.raises(ScientificError, match="standard scaling overflowed"):
        process_spectrum(*xas_arrays, {"step": 2}, background_standard={"k": k, "chi": np.full(k.size, 1e308)})
    k = np.linspace(0, 12, 100001)
    with pytest.raises(ScientificError, match="100000 points"):
        process_spectrum(*xas_arrays, {}, background_standard={"k": k, "chi": np.zeros(k.size)})


@pytest.mark.parametrize("data_type", ["norm", "chi", "xanes"])
def test_fnorm_rejects_inputs_without_raw_mu_exafs(xas_arrays, data_type):
    with pytest.raises(ScientificError, match="fnorm requires raw mu"):
        process_spectrum(*xas_arrays, {"fnorm": True}, data_type)


@pytest.mark.parametrize("step", [0.85, 2.7])
def test_background_standard_matches_larch_with_dimensionless_chi_units(xas_arrays, step):
    x, y = xas_arrays
    k = np.linspace(0, 12, 601)
    standard = {"k": k, "chi": 0.035 * np.sin(2.2*k + 0.3) * np.exp(-0.17*k)}
    before = {key: value.copy() for key, value in standard.items()}
    params = {"e0": 8980, "step": step, "nclamp": 0, "bkg_kweight": 1.25}
    result = process_spectrum(x, y, params, background_standard=standard)
    baseline = process_spectrum(x, y, params)
    e = result["effective"]
    direct = Group()
    autobk(x, y, group=direct, ek0=8980, edge_step=step, rbkg=e["rbkg"],
           kmin=e["bkg_kmin"], kmax=e["bkg_kmax"], kweight=e["bkg_kweight"],
           dk=e["bkg_dk"], win=e["bkg_window"], nclamp=e["nclamp"],
           clamp_lo=e["clamp_lo"], clamp_hi=e["clamp_hi"], nfft=e["nfft"], kstep=e["kstep"],
           k_std=k, chi_std=standard["chi"] * step)
    np.testing.assert_allclose(result["arrays"]["bkg"], direct.bkg, atol=1e-12)
    np.testing.assert_allclose(result["arrays"]["chi"], direct.chi, atol=1e-12)
    np.testing.assert_array_equal(result["arrays"]["norm"], baseline["arrays"]["norm"])
    assert not np.allclose(result["arrays"]["chi"], baseline["arrays"]["chi"])
    assert e["background_standard"] is True
    assert e["background_standard_kmin"] == 0
    assert e["background_standard_kmax"] == 12
    assert e["background_standard_points"] == 601
    for key in standard:
        np.testing.assert_array_equal(standard[key], before[key])
    assert any("fixed-amplitude" in warning for warning in result["warnings"])
    json.dumps(result, allow_nan=False)


def test_background_standard_recovers_known_low_r_chi_instead_of_subtracting_it():
    e0, step = 8980.0, 2.5
    k = np.arange(0, 12.0001, 0.025)
    chi = 0.04 * np.sin(1.2 * k)
    post_energy = e0 + k*k / science.ETOK
    pre_energy = np.linspace(e0 - 200, e0 - 0.5, 400)
    energy = np.r_[pre_energy, post_energy]
    baseline = 0.2 + 0.00005 * (energy - e0)
    mu = baseline + np.r_[np.zeros(pre_energy.size), step * (1 + chi)]
    params = {"e0": e0, "step": step, "nclamp": 0, "bkg_kmax": 12, "norm1": 100, "norm2": 500}
    result = process_spectrum(energy, mu, params, background_standard={"k": k, "chi": chi})
    ordinary = process_spectrum(energy, mu, params)
    kout = np.array(result["arrays"]["k"])
    expected = 0.04 * np.sin(1.2 * kout)
    np.testing.assert_allclose(result["arrays"]["chi"], expected, atol=2e-5)
    assert np.linalg.norm(np.array(ordinary["arrays"]["chi"]) - expected) > 0.1


def test_fnorm_and_standard_use_the_corrected_step_together(fluorescence_arrays):
    x, y, _ = fluorescence_arrays
    k = np.linspace(0, 12, 1201)
    standard = {"k": k, "chi": 0.04 * np.sin(5*k) * np.exp(-0.012*k*k)}
    params = {"e0": 2472, "norm1": 80, "norm2": 500, "nnorm": 2, "nclamp": 0}
    raw = process_spectrum(x, y, params, background_standard=standard)
    result = process_spectrum(x, y, {**params, "fnorm": True}, background_standard=standard)
    a, e = result["arrays"], result["effective"]
    start = int(np.argmin(abs(x - 2472)))
    d = np.array(a["post_edge"])[start:] - np.array(a["pre_edge"])[start:]
    corrected_mu = y / np.r_[np.ones(start), d / max(d)]
    direct = Group()
    autobk(x, corrected_mu, group=direct, ek0=2472, edge_step=e["fnorm_edge_step"],
           rbkg=e["rbkg"], kmin=e["bkg_kmin"], kmax=e["bkg_kmax"],
           kweight=e["bkg_kweight"], dk=e["bkg_dk"], win=e["bkg_window"],
           nclamp=e["nclamp"], clamp_lo=e["clamp_lo"], clamp_hi=e["clamp_hi"],
           nfft=e["nfft"], kstep=e["kstep"], k_std=k, chi_std=standard["chi"] * e["fnorm_edge_step"])
    np.testing.assert_allclose(a["chi"], direct.chi, atol=1e-12)
    np.testing.assert_array_equal(a["bkg"], raw["arrays"]["bkg"])
    assert e["fnorm"] is True and e["background_standard"] is True
    assert e["fnorm_edge_step"] != pytest.approx(e["edge_step"])


@pytest.mark.parametrize("standard", [
    {}, {"k": [0, 1, 2, 3]}, {"k": [0, 1, 2, 3], "chi": [0, 0, 0, 0], "scale": 2},
    ([0, 1, 2, 3], [0, 0, 0, 0]),
    {"k": [0, 1, 2, 3], "chi": [0, 1]},
    {"k": [0, 1, 1, 3], "chi": [0, 1, 2, 3]},
    {"k": [0, 1, 2, 3], "chi": [0, np.nan, 0, 0]},
    {"k": [0, 1, 2, 3], "chi": np.array([0, 1j, 0, 0])},
    {"k": [-1, 0, 1, 2], "chi": [0, 1, 2, 3]},
    {"k": [0, 1, 2, 101], "chi": [0, 1, 2, 3]},
])
def test_invalid_background_standard_is_actionable(xas_arrays, standard):
    with pytest.raises(ScientificError, match="[Bb]ackground.standard"):
        process_spectrum(*xas_arrays, {}, background_standard=standard)


@pytest.mark.parametrize("k", [np.linspace(0.05, 12, 100), np.linspace(0, 5, 100)])
def test_background_standard_never_extrapolates_even_with_a_positive_fit_kmin(xas_arrays, k):
    with pytest.raises(ScientificError, match="complete AUTOBK grid"):
        process_spectrum(*xas_arrays, {"bkg_kmin": 2}, background_standard={"k": k, "chi": np.zeros(k.size)})


def test_background_standard_supports_normalized_input_and_explicit_shorter_grid(xas_arrays):
    x, y = xas_arrays
    norm = process_spectrum(x, y, {})["arrays"]["norm"]
    k = np.linspace(0, 5, 201)
    result = process_spectrum(x, norm, {"e0": 8980, "bkg_kmax": 5}, "norm",
                              background_standard={"k": k, "chi": np.zeros(k.size)})
    baseline = process_spectrum(x, norm, {"e0": 8980, "bkg_kmax": 5}, "norm")
    assert result["arrays"] == baseline["arrays"]
    assert result["effective"]["background_standard"] is True


@pytest.mark.parametrize("data_type", ["xanes", "chi"])
def test_standard_rejects_inputs_without_background_removal(xas_arrays, data_type):
    with pytest.raises(ScientificError, match="requires mu or norm"):
        process_spectrum(*xas_arrays, {}, data_type, background_standard={"k": [0, 1, 2, 20], "chi": [0, 0, 0, 0]})


@pytest.mark.parametrize("fnorm, standard", [(True, None), (False, {"k": [0, 1, 2, 20], "chi": [0, 0, 0, 0]})])
def test_explicit_background_options_reject_insufficient_exafs(fnorm, standard):
    x = np.linspace(8970, 8990, 201)
    y = 1 / (1 + np.exp(-(x - 8980)))
    with pytest.raises(ScientificError, match="sufficient post-edge"):
        process_spectrum(x, y, {"e0": 8980, "fnorm": fnorm}, background_standard=standard)


def test_rbkg_reports_larch_resolution_clamp(xas_arrays):
    result = process_spectrum(*xas_arrays, {"rbkg": 0.01})
    assert result["effective"]["rbkg"] == pytest.approx(2 * np.pi / (2048 * 0.05))


def test_energy_shift_and_explicit_e0_use_shifted_axis(xas_arrays):
    x, y = xas_arrays
    actual = process_spectrum(x, y, {"energy_shift": 3.5, "e0": 8983.5})
    expected = process_spectrum(x + 3.5, y, {"e0": 8983.5})
    assert actual["arrays"] == expected["arrays"]
    assert actual["effective"]["e0"] == 8983.5


def test_xanes_does_not_call_exafs_even_with_long_data(xas_arrays, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("XANES must not call AUTOBK or Fourier transforms")
    monkeypatch.setattr(science, "autobk", forbidden)
    monkeypatch.setattr(science, "xftf", forbidden)
    result = process_spectrum(*xas_arrays, {}, data_type="xanes")
    assert result["arrays"]["norm"]
    assert result["arrays"]["k"] == result["arrays"]["bkg"] == []
    assert result["effective"]["exafs"] is False
    assert result["effective"]["kmax"] is None


@pytest.mark.parametrize("kind", ["mu", "xanes", "norm"])
def test_short_near_edge_scan_remains_usable(kind):
    x = np.linspace(8970, 8990, 201)
    y = 0.1 + 1 / (1 + np.exp(-(x - 8980)))
    result = process_spectrum(x, y, {"e0": 8980}, kind)
    assert len(result["arrays"]["norm"]) == x.size
    assert result["effective"]["exafs"] is False
    assert result["arrays"]["chi"] == []
    if kind != "xanes":
        assert any("Insufficient post-edge" in w for w in result["warnings"])


def test_truncated_copper_fixture_does_not_invent_a_post_edge():
    data = np.loadtxt(Path(__file__).parent / "fixtures" / "cu_rt01.xmu")
    with pytest.raises(ScientificError, match="norm1/norm2"):
        process_spectrum(data[:, 0], data[:, 1], {}, "xanes")


def test_measured_copper_fixture_matches_direct_larch():
    data = np.loadtxt(Path(__file__).parents[2] / "examples" / "xafsdata" / "cu_rt01.xmu")
    result = process_spectrum(data[:, 0], data[:, 1], {})
    assert 8970 < result["effective"]["e0"] < 9010
    direct = direct_pipeline(data[:, 0], data[:, 1], result["effective"])
    for key in ("norm", "flat", "bkg", "chi", "chir_mag", "chiq_re"):
        np.testing.assert_allclose(result["arrays"][key], getattr(direct, key), atol=1e-10)


def test_norm_preserves_normalized_signal_and_unit_edge_step(xas_arrays):
    x, y = xas_arrays
    normalized = process_spectrum(x, y, {}, "xanes")["arrays"]["norm"]
    result = process_spectrum(x, normalized, {}, "norm")
    assert result["arrays"]["norm"] == normalized
    assert result["arrays"]["flat"] == normalized
    assert result["effective"]["edge_step"] == 1
    assert result["effective"]["exafs"] is True
    direct = Group()
    e = result["effective"]
    autobk(x, np.asarray(normalized), group=direct, ek0=e["e0"], edge_step=1,
           kweight=2, kmax=e["bkg_kmax"], dk=1, win="hanning", nclamp=5)
    np.testing.assert_allclose(result["arrays"]["chi"], direct.chi)


@pytest.mark.parametrize("window", ["hanning", "parzen", "welch", "gaussian", "sine", "kaiser"])
def test_chi_transform_matches_larch_and_known_shell(window):
    k = np.arange(0, 14.0001, 0.05)
    chi = np.sin(2 * 2.3 * k) * np.exp(-0.015 * k * k)
    result = process_spectrum(k, chi, dict(window=window, rwindow=window, dr=0.3), "chi")
    arrays, e = result["arrays"], result["effective"]
    direct = Group()
    xftf(k, chi, group=direct, kmin=e["kmin"], kmax=e["kmax"], kweight=2,
         dk=1, window=window, rmax_out=e["rmax_out"])
    xftr(direct.r, direct.chir, group=direct, rmin=1, rmax=3, dr=0.3,
         window=window, qmax_out=k[-1])
    for key in ("kwin", "chir_re", "chir_im", "rwin", "chiq_re", "chiq_im", "chiq_mag"):
        np.testing.assert_allclose(arrays[key], getattr(direct, key), atol=1e-11)
    peak_r = arrays["r"][np.argmax(arrays["chir_mag"])]
    assert peak_r == pytest.approx(2.3, abs=0.08)
    assert arrays["energy"] == arrays["mu"] == arrays["norm"] == []
    assert e["e0"] is None and e["edge_step"] is None
    assert all(e[key] is None for key in ("bkg_dk", "bkg_window", "bkg_kweight", "nclamp"))
    assert arrays["d2mude"] == []


def test_nonuniform_chi_regrids_without_extrapolating_low_k():
    k = np.linspace(1, 12, 400) ** 1.01
    chi = np.sin(k)
    result = process_spectrum(k, chi, {"kmin": 3}, "chi")
    grid = np.asarray(result["arrays"]["k"])
    np.testing.assert_allclose(np.diff(grid), 0.05)
    np.testing.assert_allclose(result["arrays"]["chi"], np.interp(grid, k, chi, left=0))


def test_short_chi_automatic_kmax_and_kmin():
    k = np.arange(0, 2.5001, 0.05)
    result = process_spectrum(k, np.sin(k), {}, "chi")
    assert 0 < result["effective"]["kmin"] < result["effective"]["kmax"] < k[-1]
    assert result["warnings"]
    with pytest.raises(ScientificError, match="kmin"):
        process_spectrum(k, np.sin(k), {"kmin": 4}, "chi")


@pytest.mark.parametrize("end", [8995, 9000, 9020, 9040])
def test_short_scan_defaults_survive_recipe_serialization(end):
    x = np.linspace(8950, end, 401)
    y = 0.2 + 1 / (1 + np.exp(-(x - 8980) / 1.5))
    implicit = process_spectrum(x, y, {})
    serialized = process_spectrum(x, y, AthenaParameters().model_dump())
    assert serialized == implicit


@pytest.mark.parametrize("params", [
    {"extra": 1}, {"e0": np.nan}, {"step": np.inf}, {"step": 0},
    {"rbkg": 0}, {"rbkg": 21}, {"nnorm": 4}, {"nnorm": 1.5},
    {"kweight": -1}, {"bkg_kweight": 5}, {"kweight": True}, {"clamp_hi": -1},
    {"bkg_kweight": True}, {"kweight": np.inf}, {"bkg_kweight": -np.inf},
    {"bkg_dk": -1}, {"bkg_dk": 21}, {"bkg_dk": True},
    {"bkg_window": "unknown"}, {"bkg_window": "gaussian", "bkg_dk": 0},
    {"nclamp": -1}, {"nclamp": 101}, {"nclamp": 5.5}, {"nclamp": True},
    {"kmin": 6, "kmax": 5}, {"bkg_kmin": 5, "bkg_kmax": 5},
    {"pre1": -10, "pre2": -20}, {"norm1": 100, "norm2": 50},
    {"pre2": 1}, {"norm2": -100}, {"rmin": 4, "rmax": 3},
    {"energy_shift": float("nan")}, {"dk": -1}, {"dr": float("inf")},
    {"nfft": 32}, {"nfft": 2000}, {"nfft": 131072}, {"nfft": True},
    {"kstep": 0}, {"kstep": 0.00001}, {"kstep": 1},
    {"window": "hanning-invalid"}, {"rwindow": "unknown"},
    {"rwindow": "gaussian", "dr": 0},
])
def test_model_rejects_invalid_or_oversized_parameters(params):
    with pytest.raises(ValidationError):
        AthenaParameters(**params)


@pytest.mark.parametrize("field", ["e0", "step", "pre1", "pre2", "norm1", "norm2", "rbkg",
    "bkg_kmin", "bkg_kmax", "bkg_kweight", "bkg_dk", "kweight", "clamp_lo", "clamp_hi",
    "kmin", "kmax", "dk", "rmin", "rmax", "dr", "kstep"])
def test_all_float_fields_reject_nan(field):
    with pytest.raises(ValidationError):
        AthenaParameters(**{field: float("nan")})


def test_process_converts_pydantic_errors_and_revalidates_constructed_models(xas_arrays):
    with pytest.raises(ScientificError, match="Invalid Athena parameters"):
        process_spectrum(*xas_arrays, {"window": "garbage"})
    p = AthenaParameters.model_construct(nfft=1_048_576)
    with pytest.raises(ScientificError, match="nfft"):
        process_spectrum(*xas_arrays, p)
    assert AthenaParameters(window="Kaiser-Bessel").window == "kaiser"
    assert AthenaParameters(bkg_window="Kaiser-Bessel").bkg_window == "kaiser"


@pytest.mark.parametrize("params, message", [
    ({"e0": 9500}, "e0"), ({"pre1": -500}, "pre1"),
    ({"norm2": 500}, "norm1/norm2"), ({"norm1": 30, "norm2": 30.1}, "norm1/norm2"),
    ({"bkg_kmax": 50}, "post-edge"), ({"bkg_kmin": 20}, "post-edge"),
    ({"kmax": 20}, "kmax"), ({"nfft": 128}, "nfft/2"),
    ({"dk": 20}, "dk"), ({"dr": 10}, "dr"),
    ({"bkg_dk": 20}, "bkg_dk"),
    ({"bkg_kmax": 3, "nclamp": 100}, "nclamp"),
    ({"rbkg": 0.01, "nclamp": 0}, "too few residuals"),
    ({"rmin": 1, "rmax": 1.001}, "FFT bin"),
])
def test_spectrum_dependent_bounds(xas_arrays, params, message):
    with pytest.raises(ScientificError, match=message):
        process_spectrum(*xas_arrays, params)


@pytest.mark.parametrize("x,y", [
    ([1, 2], [1]), ([1, 1, 2], [1, 2, 3]), ([3, 2, 1], [1, 2, 3]),
    ([[1, 2]], [[1, 2]]), ([1, 2, 3], [1, np.nan, 3]), ([1, np.inf, 3], [1, 2, 3]),
])
def test_utilities_reject_invalid_arrays(x, y):
    with pytest.raises(ScientificError):
        merge_spectra([(x, y)])


def test_processing_rejects_constant_signal_and_oversized_arrays(xas_arrays):
    x, y = xas_arrays
    with pytest.raises(ScientificError, match="constant"):
        process_spectrum(x, np.ones_like(y), {})
    with pytest.raises(ScientificError, match="100000"):
        merge_spectra([(np.arange(100001), np.ones(100001))])
    with pytest.raises(ScientificError, match="data_type"):
        process_spectrum(x, y, {}, "other")


def test_calibration_matches_larch_edge_and_shift_sign(xas_arrays):
    x, y = xas_arrays
    assert calibrate_shift(x, y, 8983) == pytest.approx(8983 - find_e0(x, y))
    assert calibrate_shift(x, y, 8983, observed=8985) == -2
    with pytest.raises(ScientificError, match="observed"):
        calibrate_shift(x, y, 8983, observed=9900)
    with pytest.raises(ScientificError, match="finite"):
        calibrate_shift(x, y, np.inf)


@pytest.mark.parametrize("shift", [-7.35, -0.4, 0, 4.2, 13.75])
def test_alignment_correct_sign_and_known_shift(xas_arrays, shift):
    x, y = xas_arrays
    actual = align_shift(x + shift, y * 2.7 + 4, x, y)
    assert actual == pytest.approx(-shift, abs=0.005)
    assert np.linalg.norm(np.interp(x, x + shift + actual, y) - y) < 1e-5


def test_alignment_different_sampling_and_absolute_fit_window():
    rx = np.linspace(8800, 9200, 2001)
    x = np.linspace(8820, 9170, 1101)
    def signal(energy):
        return 1 / (1 + np.exp(-(energy - 8980) / 2)) + 0.1 * np.exp(-((energy - 8991) / 4) ** 2)
    shift = align_shift(x + 3.7, 2 * signal(x) + 0.01 * x, rx, signal(rx), 8965, 9010)
    assert shift == pytest.approx(-3.7, abs=0.03)


def test_alignment_rejects_no_overlap_no_structure_and_outside_window(xas_arrays):
    x, y = xas_arrays
    with pytest.raises(ScientificError, match="overlap"):
        align_shift(x + 2000, y, x, y)
    with pytest.raises(ScientificError, match="derivative"):
        align_shift(x, np.ones_like(y), x, y)
    with pytest.raises(ScientificError, match="absolute"):
        align_shift(x, y, x, y, -20, 30)
    with pytest.raises(ScientificError, match="ten points"):
        align_shift(x, y, x, y, 8980, 8981)
    with pytest.raises(ScientificError, match="bound"):
        align_shift(x + 60, y, x, y)


def test_merge_overlap_mean_and_population_stddev():
    first_x = np.arange(0, 10, 0.5)
    second_x = np.arange(2, 12, 0.25)
    x, mean, stddev = merge_spectra([(first_x, 2 * first_x), (second_x, 2 * second_x + 4)])
    x = np.asarray(x)
    assert x[0] == 2 and x[-1] == 9.5
    np.testing.assert_allclose(mean, 2 * x + 2)
    np.testing.assert_allclose(stddev, 2)
    np.testing.assert_array_equal(merge_spectra([(first_x, first_x)])[2], np.zeros_like(first_x))
    with pytest.raises(ScientificError, match="overlap"):
        merge_spectra([(first_x, first_x), (second_x + 100, second_x)])


def test_importance_weighted_merge_recovers_affine_signal_and_scatter():
    first_x = np.arange(0, 10, 0.5)
    second_x = np.arange(2, 12, 0.25)
    spectra = [(first_x, 2 * first_x), (second_x, 2 * second_x + 4)]
    before = [(x.copy(), y.copy()) for x, y in spectra]
    weights = np.array([1.0, 3.0])
    result = combine_spectra(spectra, weights)
    x = np.asarray(result["x"])
    np.testing.assert_array_equal(x, first_x[first_x >= 2])
    np.testing.assert_allclose(result["y"], 2 * x + 3)
    np.testing.assert_allclose(result["stddev"], np.sqrt(3))
    assert result["weights"] == [1, 3]
    assert result["coefficients"] == [0.25, 0.75]
    assert result["uncertainty"] is None
    assert result["mode"] == "merge"
    assert result["details"]["overlap"] == [2, 9.5]
    np.testing.assert_allclose(result["components"], [0.5 * x, 1.5 * x + 3])
    np.testing.assert_allclose(np.sum(result["components"], axis=0), result["y"])
    for actual, key in zip(merge_spectra(spectra, weights), ("x", "y", "stddev")):
        assert isinstance(actual, np.ndarray)
        np.testing.assert_array_equal(actual, result[key])
    np.testing.assert_array_equal(weights, [1, 3])
    for pair, original in zip(spectra, before):
        for actual, expected in zip(pair, original):
            np.testing.assert_array_equal(actual, expected)
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("weights, expected", [
    (None, lambda x: 4 * x + 4),
    ([2, -0.5], lambda x: 3 * x - 2),
    ([1, -1], lambda x: np.full(x.size, -4)),
    ([0, 0], lambda x: np.zeros(x.size)),
])
def test_linear_sum_uses_signed_coefficients_without_normalizing(weights, expected):
    first_x, second_x = np.arange(0, 10, 0.5), np.arange(2, 12, 0.25)
    result = combine_spectra([(first_x, 2 * first_x), (second_x, 2 * second_x + 4)],
                             weights, mode="sum")
    x = np.asarray(result["x"])
    np.testing.assert_array_equal(x, first_x[first_x >= 2])
    np.testing.assert_allclose(result["y"], expected(x))
    assert result["coefficients"] == result["weights"] == ([1, 1] if weights is None else weights)
    assert result["stddev"] is None and result["uncertainty"] is None
    np.testing.assert_allclose(np.sum(result["components"], axis=0), result["y"])
    json.dumps(result, allow_nan=False)


def test_weight_normalization_does_not_normalize_the_spectra():
    x, y = np.arange(4), np.array([0.2, 0.4, 1.1, 1.2])
    raw = combine_spectra([(x, y), (x, 10 * y)])
    normalized = combine_spectra([(x, y), (x, y)])
    np.testing.assert_allclose(raw["y"], 5.5 * y)
    np.testing.assert_allclose(normalized["y"], y)
    np.testing.assert_array_equal(normalized["stddev"], np.zeros(4))


def test_same_length_distinct_grids_are_interpolated_and_zero_weights_keep_support():
    x1, x2 = np.array([0, 1, 2, 3.0]), np.array([0, 0.5, 2.5, 3.0])
    result = combine_spectra([(x1, x1**2), (x2, x2**2)], [0, 1])
    np.testing.assert_array_equal(result["x"], x1)
    np.testing.assert_allclose(result["y"], [0, 1.75, 4.75, 9])
    np.testing.assert_array_equal(result["stddev"], np.zeros(4))
    trimmed = combine_spectra([(x1, x1), (x2[1:], x2[1:])], [1, 0])
    assert trimmed["x"] == [1, 2, 3]
    with pytest.raises(ScientificError, match="overlap"):
        combine_spectra([(x1, x1), (x2 + 10, x2)], [1, 0])


@pytest.mark.parametrize("mode, weights, expected", [
    ("merge", [1, 3], np.hypot(0.25 * 2, 0.75 * 3)),
    ("sum", [2, -0.5], np.hypot(2 * 2, -0.5 * 3)),
    ("sum", [0, 0], 0),
])
def test_propagated_sigma_is_separate_from_between_scan_scatter(mode, weights, expected):
    x = np.arange(5.0)
    spectra = [(x, x + 10), (x, x + 10)]
    supplied = [np.full(5, 2.0), 3.0]
    result = combine_spectra(spectra, weights, mode=mode, uncertainties=supplied)
    np.testing.assert_allclose(result["uncertainty"], expected)
    if mode == "merge":
        np.testing.assert_array_equal(result["stddev"], np.zeros(5))
    else:
        assert result["stddev"] is None
    without_errors = combine_spectra(spectra, weights, mode=mode)
    assert without_errors["y"] == result["y"]
    assert without_errors["stddev"] == result["stddev"]
    assert without_errors["uncertainty"] is None
    np.testing.assert_array_equal(supplied[0], np.full(5, 2.0))
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("mode, coefficient", [("merge", 1), ("sum", -2)])
@pytest.mark.parametrize("native_sigma, expected", [
    ([2, 4, 6], [2, np.sqrt(5), 4, np.sqrt(13), 6]),
    (2, [2, np.sqrt(2), 2, np.sqrt(2), 2]),
])
def test_uncertainty_interpolation_propagates_native_variances(mode, coefficient, native_sigma, expected):
    x1, x2 = np.arange(5.0), np.array([0, 2, 4.0])
    result = combine_spectra([(x1, x1), (x2, 2 * x2)], [0, coefficient],
                             mode=mode, uncertainties=[100, native_sigma])
    np.testing.assert_allclose(result["uncertainty"], abs(coefficient) * np.array(expected))
    np.testing.assert_allclose(result["y"], coefficient * 2 * x1)


def test_single_scan_scatter_is_zero_but_supplied_errors_remain():
    x, y = np.arange(3.0), np.array([0.5, -2, 3.0])
    result = combine_spectra([(x, y)], [4], uncertainties=[[0.2, 0.3, 0.4]])
    np.testing.assert_array_equal(result["y"], y)
    np.testing.assert_array_equal(result["stddev"], np.zeros(3))
    np.testing.assert_allclose(result["uncertainty"], [0.2, 0.3, 0.4])


@pytest.mark.parametrize("weights", [
    [], [1], [1, 2, 3], 1, [[1, 2]], [np.nan, 1], [1, np.inf],
    [True, 1], np.array([True, False]), ["1", "2"], [1 + 0j, 2],
    {"a": 1, "b": 2}, [10**400, 1],
])
@pytest.mark.parametrize("mode", ["merge", "sum"])
def test_combine_rejects_invalid_weights(weights, mode):
    x = np.arange(3.0)
    with pytest.raises(ScientificError, match="weights"):
        combine_spectra([(x, x), (x, x)], weights, mode=mode)


@pytest.mark.parametrize("weights", [[0, 0], [-1, 2], [-1, -2]])
def test_merge_rejects_nonpositive_total_and_negative_weights(weights):
    x = np.arange(3.0)
    with pytest.raises(ScientificError, match="nonnegative"):
        merge_spectra([(x, x), (x, x)], weights)


@pytest.mark.parametrize("mode", ["average", "SUM", "noise", None, True, np.array(["sum"])])
def test_combine_rejects_unsupported_mode(mode):
    with pytest.raises(ScientificError, match="mode"):
        combine_spectra([([0, 1], [1, 2])], mode=mode)


@pytest.mark.parametrize("errors", [
    [], [1], [1, 2, 3], 1, np.array(1), [[1, 2], 1], [[[-1, 2, 3]], 1],
    [-1, 1], [1, np.inf], [np.nan, 1], [True, 1], [[1, True, 1], 1],
    ["1", 1], [1j, 1], [None, 1], {"a": 1, "b": 2},
])
def test_combine_rejects_invalid_uncertainties_even_for_zero_weight(errors):
    x = np.arange(3.0)
    with pytest.raises(ScientificError, match="uncertainties"):
        combine_spectra([(x, x), (x, x)], [0, 1], uncertainties=errors)


@pytest.mark.parametrize("spectra", [
    [], [([0], [1])], [([0, 0, 1], [1, 2, 3])],
    [([0, 1], [0, np.nan])], [([0, 1, 2], [1, 2, 3]), ([1.5, 3], [1, 2])],
    [(np.array([0, 1j]), [1, 2])], [([0, 1], np.array([1, 2j]))],
])
def test_combine_rejects_invalid_spectra_and_insufficient_overlap(spectra):
    with pytest.raises(ScientificError):
        combine_spectra(spectra)


def test_combination_bounds_large_finite_values_and_weight_dynamic_range():
    x = np.arange(3.0)
    positive, negative = np.full(3, 1e200), np.full(3, -1e200)
    result = combine_spectra([(x, positive), (x, negative)], [1e308, 1e308])
    np.testing.assert_array_equal(result["y"], np.zeros(3))
    np.testing.assert_allclose(result["stddev"], 1e200)
    assert result["coefficients"] == [0.5, 0.5]
    with pytest.raises(ScientificError, match="dynamic range"):
        merge_spectra([(x, x), (x, x)], [1e-300, 1e300])
    with pytest.raises(ScientificError, match="rescale"):
        combine_spectra([(x, positive)], [1e200], mode="sum")
    with pytest.raises(ScientificError, match="rescale"):
        combine_spectra([(x, x)], [1e200], mode="sum", uncertainties=[1e200])
    with pytest.raises(ScientificError, match="100 spectra"):
        combine_spectra([(x, x)] * 101)
    large_x = np.arange(100_000.0)
    with pytest.raises(ScientificError, match="matrix is too large"):
        combine_spectra([(large_x, large_x)] * 21)


@pytest.fixture
def combination_fixture():
    x = np.linspace(-5, 5, 301)
    a = np.exp(-((x + 1) / 0.8) ** 2)
    b = np.exp(-((x - 1.5) / 1.2) ** 2)
    return x, a, b


@pytest.mark.parametrize("sum_to_one,nonnegative,weights", [
    (True, True, [0.25, 0.75]), (True, False, [-0.2, 1.2]),
    (False, True, [0.4, 1.5]), (False, False, [-0.3, 1.7]),
])
def test_linear_combination_recovers_known_weights(combination_fixture, sum_to_one, nonnegative, weights):
    x, a, b = combination_fixture
    y = weights[0] * a + weights[1] * b
    result = linear_combination(x, y, [(x, a), (x, b)], -4, 4, sum_to_one, nonnegative)
    np.testing.assert_allclose(result["weights"], weights, atol=2e-7)
    np.testing.assert_allclose(result["fit"], result["observed"], atol=2e-7)
    np.testing.assert_allclose(result["residual"], np.asarray(result["observed"]) - result["fit"])
    assert result["rfactor"] < 1e-12
    json.dumps(result, allow_nan=False)


def test_nonnegative_constraint_is_optimized_not_clipped(combination_fixture):
    x, a, b = combination_fixture
    result = linear_combination(x, -0.3 * a + 1.3 * b, [(x, a), (x, b)], -5, 5)
    np.testing.assert_allclose(result["weights"], [0, 1], atol=1e-8)
    residual, observed = np.asarray(result["residual"]), np.asarray(result["observed"])
    assert result["rfactor"] == pytest.approx((residual @ residual) / (observed @ observed))


def test_linear_combination_interpolates_components(combination_fixture):
    x, a, b = combination_fixture
    coarser = x[::2]
    y = 0.3 * np.interp(x, coarser, a[::2]) + 0.7 * b
    result = linear_combination(x, y, [(coarser, a[::2]), (x, b)], -4, 4)
    np.testing.assert_allclose(result["weights"], [0.3, 0.7], atol=1e-7)


def test_fit_rejects_extrapolation_and_dependent_standards(combination_fixture):
    x, a, b = combination_fixture
    with pytest.raises(ScientificError, match="overlap"):
        linear_combination(x, a, [(x, b)], -6, 4)
    with pytest.raises(ScientificError, match="linearly dependent"):
        linear_combination(x, a, [(x, b), (x, b)], -4, 4)
    with pytest.raises(ScientificError, match="greater"):
        principal_components([(x, a), (x, b)], 4, -4)


def test_single_component_and_zero_target(combination_fixture):
    x, a, _ = combination_fixture
    assert linear_combination(x, a, [(x, a)], -4, 4)["weights"] == [1]
    result = linear_combination(x, np.zeros_like(x), [(x, a)], -4, 4, sum_to_one=False)
    assert result["weights"] == [0]
    assert result["rfactor"] == 0
    with pytest.raises(ScientificError, match="undefined"):
        linear_combination(x, np.zeros_like(x), [(x, a)], -4, 4)


def test_pca_svd_reconstruction_and_rank_one_variation(combination_fixture):
    x, a, b = combination_fixture
    values = np.asarray([a + amount * b for amount in (0, 0.2, 0.5, 1)])
    result = principal_components([(x, y) for y in values], -5, 5)
    components, scores, mean = (np.asarray(result[key]) for key in ("components", "scores", "mean"))
    np.testing.assert_allclose(mean + scores @ components, values, atol=1e-12)
    np.testing.assert_allclose(components @ components.T, np.eye(4), atol=1e-12)
    expected = np.linalg.svd(values - values.mean(axis=0), full_matrices=False)[1]
    np.testing.assert_allclose(result["singular_values"], expected, atol=1e-12)
    np.testing.assert_allclose(result["explained_variance"], expected ** 2 / 3, atol=1e-12)
    assert result["explained_variance_ratio"][0] == pytest.approx(1)
    assert np.all(components[np.arange(4), np.argmax(np.abs(components), axis=1)] >= 0)
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("count", [2, 3, 5])
def test_pca_identical_spectra_has_finite_zero_variance(combination_fixture, count):
    x, a, _ = combination_fixture
    result = principal_components([(x, a)] * count, -4, 4)
    assert result["explained_variance_ratio"] == [0] * count
    assert result["singular_values"] == [0] * count
    with pytest.raises(ScientificError, match="between 2"):
        principal_components([(x, a)], -4, 4)


def test_matrix_resource_bound_is_actionable():
    x = np.linspace(1, 10, 25001)
    with pytest.raises(ScientificError, match="matrix is too large"):
        principal_components([(x, x)] * 81, 1, 10)
