"""Synthetic recovery, Larch agreement, and failure contracts for Athena tools."""

import json

import numpy as np
import pytest
from larch import Group
from larch.xafs import fluo_corr, rebin_xafs, xas_deconvolve
from larch.xafs.xafsutils import KTOE
from scipy.special import voigt_profile
from xraydb import material_mu, xray_edge, xray_line

import xraylarch_web.athena_operations as operations
from xraylarch_web.athena_operations import fit_peaks, log_ratio, transform_spectrum


def gaussian(x, center, sigma, area):
    return area / (sigma * np.sqrt(2 * np.pi)) * np.exp(-0.5 * ((x - center) / sigma) ** 2)


def lorentzian(x, center, sigma, area):
    return area * sigma / (np.pi * ((x - center) ** 2 + sigma**2))


@pytest.fixture
def simple_arrays():
    x = np.linspace(10, 30, 101)
    return x, 3 * x + 2


@pytest.mark.parametrize("irregular", [False, True])
def test_smooth_preserves_energy_polynomial_including_boundaries(irregular):
    x = np.linspace(1, 5, 101)
    if irregular:
        x = x**1.4
    y = 2 + 3 * x - 0.1 * x**2
    original = y.copy()
    result = transform_spectrum("smooth", x, y, {"window": 9, "order": 2})
    np.testing.assert_allclose(result["mu"], y, atol=1e-11)
    np.testing.assert_array_equal(y, original)
    assert (result["details"]["method"] == "local_polynomial_least_squares") == irregular


def test_smooth_reduces_noise():
    x = np.linspace(0, 10, 501)
    truth = np.sin(x)
    noisy = truth + np.random.default_rng(77).normal(0, 0.1, x.size)
    result = transform_spectrum("smooth", x, noisy, {"window": 21, "order": 3})
    assert np.mean((np.array(result["mu"]) - truth) ** 2) < 0.2 * np.mean((noisy - truth) ** 2)


@pytest.mark.parametrize("selector", [{"indices": [10, 11, 12]}, {"xmin": 12, "xmax": 12.4}, {"points": [12, 12.2, 12.4]}])
def test_deglitch_interpolates_only_selected_points(simple_arrays, selector):
    x, truth = simple_arrays
    damaged = truth.copy()
    damaged[10:13] += 99
    result = transform_spectrum("deglitch", x, damaged, selector)
    np.testing.assert_allclose(result["mu"], truth)
    assert result["details"]["indices"] == [10, 11, 12]
    assert damaged[10] == truth[10] + 99


def test_deglitch_separate_glitches_use_local_energy_brackets():
    x = np.array([1, 2, 4, 5, 8, 9, 10], dtype=float)
    y = np.array([1, 99, 4, 5, 99, 9, 10], dtype=float)
    result = transform_spectrum("deglitch", x, y, {"indices": [1, 4]})
    np.testing.assert_allclose(result["mu"], x)


def test_truncate_is_inclusive_and_does_not_interpolate(simple_arrays):
    x, y = simple_arrays
    result = transform_spectrum("truncate", x, y, {"xmin": 12, "xmax": 14})
    np.testing.assert_array_equal(result["energy"], x[10:21])
    np.testing.assert_array_equal(result["mu"], y[10:21])


@pytest.mark.parametrize("method", ["boxcar", "spline", "centroid"])
def test_rebin_uses_larch_three_region_grid(xas_arrays, method):
    x, y = xas_arrays
    opts = {"e0": 8980, "pre1": -230, "pre2": -30, "pre_step": 2,
            "xanes_step": 0.5, "exafs1": 20, "exafs2": 370,
            "exafs_kstep": 0.1, "method": method}
    expected = Group(__name__="expected")
    rebin_xafs(x, y, group=expected, **opts)
    result = transform_spectrum("rebin", x, y, opts)
    np.testing.assert_allclose(result["energy"], expected.rebinned.energy)
    np.testing.assert_allclose(result["mu"], expected.rebinned.mu)
    k = np.sqrt((np.array(result["energy"])[np.array(result["energy"]) >= 9000] - 8980) / KTOE)
    np.testing.assert_allclose(np.diff(k), np.diff(k)[0], atol=1e-12)
    assert result["energy"][-1] < x[-1]
    json.dumps(result, allow_nan=False)


def test_rebin_does_not_include_data_above_requested_end(xas_arrays):
    x, y = xas_arrays
    opts = {"e0": 8980, "exafs2": 200, "xanes_step": 0.5}
    expected = transform_spectrum("rebin", x, y, opts)
    corrupted = y.copy()
    corrupted[x > 9180] += 1000
    actual = transform_spectrum("rebin", x, corrupted, opts)
    np.testing.assert_allclose(actual["mu"], expected["mu"])


def test_gaussian_convolution_recovers_known_broadened_peak():
    x = np.linspace(-40, 40, 4001)
    original = gaussian(x, 2, 2, 7)
    result = transform_spectrum("convolve", x, original, {"form": "gaussian", "width": 1.5})
    expected = gaussian(x, 2, np.hypot(2, 1.5), 7)
    np.testing.assert_allclose(result["mu"], expected, rtol=2e-5, atol=1e-8)
    assert x[np.argmax(result["mu"])] == 2
    assert np.trapezoid(result["mu"], x) == pytest.approx(7, rel=1e-6)


def test_lorentzian_convolution_has_additive_half_width():
    x = np.linspace(-100, 100, 4001)
    result = transform_spectrum("convolve", x, lorentzian(x, 0, 2, 5), {"form": "lorentzian", "width": 1})
    expected = lorentzian(x, 0, 3, 5)
    selected = np.abs(x) < 20
    np.testing.assert_allclose(np.array(result["mu"])[selected], expected[selected], rtol=0.008)
    assert x[np.argmax(result["mu"])] == 0


@pytest.mark.parametrize("form", ["gaussian", "lorentzian"])
def test_convolution_preserves_constant_on_nonuniform_grid(form):
    x = np.linspace(1, 20, 150)**1.4
    result = transform_spectrum("convolve", x, np.full(x.size, 8), {"form": form, "width": 0.5})
    np.testing.assert_allclose(result["mu"], 8, atol=1e-12)


@pytest.mark.parametrize("form", ["gaussian", "lorentzian"])
@pytest.mark.parametrize("smooth", [False, True])
def test_deconvolution_matches_larch_and_documents_normalized_input(form, smooth):
    x = np.linspace(8900, 9120, 441)
    y = 0.1 + 1 / (1 + np.exp(-(x - 8980) / 3))
    opts = {"form": form, "esigma": 1, "eshift": -0.5, "smooth": smooth}
    if smooth:
        opts.update(sgwindow=7, sgorder=2)
    expected = Group()
    xas_deconvolve(x, y, group=expected, **opts)
    result = transform_spectrum("deconvolve", x, y, opts)
    np.testing.assert_allclose(result["mu"], expected.deconv)
    assert "normalized" in result["details"]["assumptions"]
    json.dumps(result, allow_nan=False)


def test_self_absorption_matches_larch_and_angle_geometry(xas_arrays):
    x, y = xas_arrays
    opts = {"formula": "CuO", "element": "Cu", "edge": "K", "angle_in": 30,
            "angle_out": 60, "e0": 8980, "pre1": -230, "pre2": -30,
            "norm1": 100, "norm2": 370, "nnorm": 1}
    group = Group()
    fluo_corr(x, y, "CuO", "Cu", group=group, edge="K", line="Ka", anginp=30, angout=60,
              e0=8980, pre1=-230, pre2=-30, norm1=100, norm2=370, nnorm=1)
    result = transform_spectrum("self_absorption", x, y, opts)
    np.testing.assert_allclose(result["mu"], group.mu_corr)
    np.testing.assert_allclose(result["details"]["normalized_mu"], group.norm_corr)
    assert "thick homogeneous" in result["details"]["assumptions"]
    assert not np.allclose(result["mu"], y)
    json.dumps(result, allow_nan=False)


def test_self_absorption_default_edge_normalization(xas_arrays):
    x, y = xas_arrays
    result = transform_spectrum("self_absorption", x, y, {"formula": "CuO", "element": "Cu"})
    assert result["details"]["e0"] == 8979
    assert result["details"]["line"] == "Ka"


def test_self_absorption_recovers_known_thick_sample_fluorescence():
    """Forward fluorescence saturation and correction recover the true edge."""
    x = np.linspace(8750, 9350, 1201)
    e0 = xray_edge("Cu", "K").energy
    line_energy = xray_line("Cu", "Ka").energy
    attenuation = material_mu("CuO", [line_energy, e0 - 10, e0 + 10], density=1)
    alpha = (attenuation[0] + attenuation[1]) / (attenuation[2] - attenuation[1])
    true_mu = (x >= e0).astype(float)
    near_edge = (x >= e0) & (x < e0 + 60)
    true_mu[near_edge] += 0.4 * np.exp(-0.5 * ((x[near_edge] - e0 - 10) / 3)**2)
    fluorescence = true_mu * (alpha + 1) / (alpha + true_mu)
    result = transform_spectrum("self_absorption", x, fluorescence,
                                {"formula": "CuO", "element": "Cu", "e0": e0})
    np.testing.assert_allclose(result["mu"], true_mu, atol=1e-13)
    assert np.max(fluorescence) < np.max(true_mu)


@pytest.mark.parametrize("overrides, message", [
    ({"formula": "Fe2O3"}, "absorbing element"),
    ({"formula": "Cu0O"}, "stoichiometry"),
    ({"formula": "Cu1e999O"}, "stoichiometry"),
    ({"formula": "not a formula"}, "element"),
    ({"angle_in": 0}, "greater than zero"),
    ({"angle_out": 91}, "degrees"),
    ({"line": "La"}, "originating"),
    ({"norm1": 500}, "norm1 < norm2"),
    ({"e0": 9500}, "relative to e0"),
    ({"edge": "L3"}, "straddle"),
])
def test_self_absorption_invalid_material_geometry_and_ranges(xas_arrays, overrides, message):
    x, y = xas_arrays
    with pytest.raises(ValueError, match=message):
        transform_spectrum("self_absorption", x, y, {"formula": "CuO", "element": "Cu", **overrides})


def test_self_absorption_rejects_singular_correction(xas_arrays):
    x, y = xas_arrays
    y = y.copy()
    y[np.argmin(np.abs(x - 8985))] = 100
    with pytest.raises(ValueError, match="singular or nonphysical"):
        transform_spectrum("self_absorption", x, y, {"formula": "CuO", "element": "Cu"})


def test_self_absorption_rejects_flat_and_inverted_edges(xas_arrays):
    x, y = xas_arrays
    for bad in (np.ones(x.size), -y):
        with pytest.raises(ValueError, match="positive, resolvable"):
            transform_spectrum("self_absorption", x, bad, {"formula": "CuO", "element": "Cu"})


def test_dispersive_polynomial_recovery_and_decreasing_axis():
    pixel = np.arange(100.)
    y = np.sin(pixel)
    result = transform_spectrum("dispersive", pixel, y, {"offset": 8900, "linear": 0.5, "quadratic": 0.002})
    np.testing.assert_allclose(result["energy"], 8900 + 0.5 * pixel + 0.002 * pixel**2)
    result = transform_spectrum("dispersive", pixel, y, {"offset": 9200, "linear": -0.5})
    np.testing.assert_allclose(result["energy"], (9200 - 0.5 * pixel)[::-1])
    np.testing.assert_allclose(result["mu"], y[::-1])
    assert result["details"]["reversed"] is True


@pytest.mark.parametrize("opts", [{"offset": 100, "linear": -4, "quadratic": 1}, {"linear": 0}, {"offset": -100}])
def test_dispersive_rejects_nonphysical_or_nonmonotonic_calibration(opts):
    with pytest.raises(ValueError, match="monotonic|positive"):
        transform_spectrum("dispersive", np.arange(6), np.ones(6), opts)


@pytest.mark.parametrize("x,y,message", [
    ([1, 1, 2], [1, 2, 3], "strictly increasing"),
    ([3, 2, 1], [1, 2, 3], "strictly increasing"),
    ([1, 2, 3], [1, 2], "same length"),
    ([1, np.nan, 3], [1, 2, 3], "finite"),
    ([1, 2, 3], [1, np.inf, 3], "finite"),
    ([1, 2, 3], [1, 2, 3j], "numeric array"),
    ([[1, 2, 3]], [1, 2, 3], "one-dimensional"),
    ([1, 2, 3], [True, False, True], "numeric array"),
    ([1, 2, 3], ["1", "2", "3"], "numeric array"),
    ([1], [2], "2–100000"),
])
def test_transform_validates_arrays(x, y, message):
    with pytest.raises(ValueError, match=message):
        transform_spectrum("truncate", x, y, {})


@pytest.mark.parametrize("operation,opts,message", [
    ("unknown", {}, "operation must be"),
    ("smooth", {"window": 8}, "odd"),
    ("smooth", {"window": 5, "order": 4}, "order"),
    ("smooth", {"window": 7.5}, "integer"),
    ("smooth", {"order": True}, "finite number"),
    ("smooth", {"typo": 3}, "Unsupported options"),
    ("truncate", {"xmin": 20, "xmax": 15}, "xmin < xmax"),
    ("truncate", {"xmin": 0}, "measured range"),
    ("truncate", {"xmin": 12.01, "xmax": 12.05}, "at least 2"),
    ("deglitch", {}, "exactly one"),
    ("deglitch", {"indices": [0]}, "both sides"),
    ("deglitch", {"indices": [-1]}, "integer"),
    ("deglitch", {"indices": [10.2]}, "integer"),
    ("deglitch", {"indices": []}, "nonempty"),
    ("deglitch", {"points": [12.01]}, "match a measured"),
    ("deglitch", {"xmin": 13}, "both xmin and xmax"),
    ("deglitch", {"indices": [1], "xmin": 12, "xmax": 13}, "exactly one"),
    ("convolve", {"width": 0}, "greater than zero"),
    ("convolve", {"width": float("inf")}, "finite"),
    ("convolve", {"form": "voigt"}, "form must be"),
    ("convolve", {"width": 1e-20}, "grid is too large"),
    ("convolve", {"width": 1e8}, "kernel is too large"),
    ("deconvolve", {"smooth": "false"}, "boolean"),
    ("deconvolve", {"smooth": False, "sgorder": 3}, "smooth=true"),
    ("deconvolve", {"width": 1, "esigma": 2}, "only esigma"),
    ("deconvolve", {"eshift": 1e8}, "quarter"),
    ("dispersive", {"linear": "__import__('os')"}, "finite number"),
])
def test_operation_errors_are_actionable(simple_arrays, operation, opts, message):
    with pytest.raises(ValueError, match=message):
        transform_spectrum(operation, *simple_arrays, opts)


@pytest.mark.parametrize("opts,message", [
    ({}, "e0"),
    ({"e0": 8980, "exafs1": -10}, "pre1 < pre2"),
    ({"e0": 8980, "pre_step": 0}, "greater than zero"),
    ({"e0": 8980, "exafs_kstep": 1e-12}, "work limit"),
    ({"e0": 8980, "xanes_step": 1e-12}, "work limit"),
    ({"e0": 8980, "pre1": -400}, "within measured"),
    ({"e0": 8980, "method": "nearest"}, "method must be"),
    ({"e0": 8980, "pre_step": 300}, "one requested step"),
])
def test_rebin_rejects_invalid_ranges_and_resource_requests(xas_arrays, opts, message):
    with pytest.raises(ValueError, match=message):
        transform_spectrum("rebin", *xas_arrays, opts)


def test_large_inputs_and_deconvolution_work_rejected_before_larch(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Larch should not run for oversized requests")

    monkeypatch.setattr(operations, "xas_deconvolve", forbidden)
    x = np.linspace(8900, 9000, 100_001)
    with pytest.raises(ValueError, match="100000"):
        transform_spectrum("truncate", x, np.ones(x.size), {})
    x = np.linspace(8900, 9100, 20_001)
    with pytest.raises(ValueError, match="5000"):
        transform_spectrum("deconvolve", x, np.ones(x.size), {})


def test_deconvolution_rejects_zero_endpoint_and_invalid_smoothing():
    x = np.linspace(8900, 9120, 441)
    y = np.ones(x.size)
    y[-1] = 0
    with pytest.raises(ValueError, match="post-edge endpoint"):
        transform_spectrum("deconvolve", x, y, {})
    with pytest.raises(ValueError, match="odd"):
        transform_spectrum("deconvolve", x, np.ones(x.size), {"sgwindow": 8})
    with pytest.raises(ValueError, match="integer"):
        transform_spectrum("deconvolve", x, np.ones(x.size), {"sgwindow": 10001})


@pytest.mark.parametrize("function", [transform_spectrum, fit_peaks, log_ratio])
def test_options_must_be_a_dictionary(simple_arrays, function):
    x, y = simple_arrays
    with pytest.raises(ValueError, match="dictionary"):
        if function is transform_spectrum:
            function("smooth", x, y, "window=7")
        elif function is fit_peaks:
            function(x, y, "peaks")
        else:
            function(x, y.astype(complex), y.astype(complex), "kmin")


@pytest.mark.parametrize("kind", ["gaussian", "lorentzian", "voigt"])
def test_peak_fit_recovers_known_area_center_width_and_background(kind):
    x = np.linspace(8950, 9020, 701)
    center, sigma, area = 8985, 2.3, 8
    if kind == "voigt":
        peak = area * voigt_profile(x - center, sigma, sigma)
    else:
        peak = {"gaussian": gaussian, "lorentzian": lorentzian}[kind](x, center, sigma, area)
    y = 0.002 * x - 17.5 + peak
    result = fit_peaks(x, y, {"peaks": [{"center": 8984.5, "sigma": 2, "amplitude": 7, "kind": kind}]})
    parameters = result["parameters"]
    for name, value in (("peak_1_center", center), ("peak_1_sigma", sigma), ("peak_1_amplitude", area),
                        ("background_slope", 0.002), ("background_intercept", -17.5)):
        assert parameters[name]["value"] == pytest.approx(value, rel=2e-6, abs=1e-7)
    np.testing.assert_allclose(result["fit"], y, atol=1e-8)
    np.testing.assert_allclose(np.sum(list(result["components"].values()), axis=0), result["fit"], atol=1e-12)
    np.testing.assert_allclose(result["residual"], y - np.array(result["fit"]), atol=1e-12)
    assert result["redchi"] < 1e-16
    if kind == "voigt":
        assert parameters["peak_1_gamma"]["value"] == pytest.approx(sigma, rel=1e-6)
        assert parameters["peak_1_gamma"]["vary"] is False
    json.dumps(result, allow_nan=False)


def test_two_peak_recovery_with_noise_and_cropped_fit():
    x = np.linspace(-15, 15, 601)
    truth = 0.3 + 0.01 * x + gaussian(x, -3, 1.2, 4) + lorentzian(x, 3, 0.8, 2.5)
    y = truth + np.random.default_rng(234).normal(0, 0.003, x.size)
    result = fit_peaks(x, y, {"xmin": -10, "xmax": 10, "peaks": [
        {"center": -2.6, "sigma": 1, "amplitude": 3.6},
        {"center": 2.7, "sigma": 1, "amplitude": 2, "kind": "lorentzian"},
    ]})
    for name, expected in (("peak_1_center", -3), ("peak_1_sigma", 1.2), ("peak_1_amplitude", 4),
                            ("peak_2_center", 3), ("peak_2_sigma", 0.8), ("peak_2_amplitude", 2.5)):
        assert result["parameters"][name]["value"] == pytest.approx(expected, abs=0.02)
    assert result["x"][0] == -10
    assert result["x"][-1] == 10
    assert result["redchi"] == pytest.approx(0.003**2, rel=0.2)
    assert result["parameters"]["peak_1_center"]["stderr"] > 0


def test_voigt_with_independently_fitted_gamma():
    x = np.linspace(-15, 15, 601)
    y = 0.4 + 0.01 * x + 5 * voigt_profile(x - 1.2, 0.8, 1.5)
    result = fit_peaks(x, y, {"peaks": [{"center": 1, "sigma": 1, "gamma": 1,
                                        "amplitude": 4, "kind": "voigt"}]})
    assert result["parameters"]["peak_1_gamma"]["value"] == pytest.approx(1.5, rel=1e-5)
    assert result["parameters"]["peak_1_sigma"]["value"] == pytest.approx(0.8, rel=1e-5)
    assert result["parameters"]["peak_1_gamma"]["vary"] is True


@pytest.mark.parametrize("overrides,message", [
    ({"xmin": 5, "xmax": -5}, "xmin < xmax"),
    ({"xmin": -20}, "measured range"),
    ({"xmin": 0, "xmax": 0.01}, "at least 6"),
    ({"peaks": []}, "peaks must contain"),
    ({"peaks": [None]}, "dictionary"),
    ({"peaks": [{"center": 1, "sigma": 1}]}, "amplitude"),
    ({"peaks": [{"center": 20, "sigma": 1, "amplitude": 2}]}, "within the selected"),
    ({"peaks": [{"center": 1, "sigma": -1, "amplitude": 2}]}, "greater than zero"),
    ({"peaks": [{"center": 1, "sigma": 1, "amplitude": -2}]}, "greater than zero"),
    ({"peaks": [{"center": 1, "sigma": 1, "amplitude": 2, "kind": "step"}]}, "peak kind"),
    ({"peaks": [{"center": 1, "sigma": 1, "amplitude": 2, "gamma": 1}]}, "Voigt"),
    ({"peaks": [{"center": 1, "sigma": 1, "amplitude": 2, "expr": "x"}]}, "Unsupported options"),
    ({"background": {"expression": "x"}}, "Unsupported options"),
    ({"max_nfev": 5001}, "integer"),
])
def test_fit_invalid_ranges_and_options(overrides, message):
    x = np.linspace(-10, 10, 201)
    opts = {"peaks": [{"center": 1, "sigma": 1, "amplitude": 2}], **overrides}
    with pytest.raises(ValueError, match=message):
        fit_peaks(x, gaussian(x, 1, 1, 2), opts)


def test_fit_exhausted_optimizer_is_not_returned_as_success():
    x = np.linspace(-10, 10, 201)
    with pytest.raises(ValueError, match="did not converge"):
        fit_peaks(x, gaussian(x, 2, 1, 2), {"max_nfev": 1,
                  "peaks": [{"center": 1, "sigma": 2, "amplitude": 1}]})


def test_fit_underdetermined_model_is_rejected():
    x = np.linspace(-1, 1, 7)
    with pytest.raises(ValueError, match="more than 8"):
        fit_peaks(x, np.ones(x.size), {"peaks": [
            {"center": -0.3, "sigma": 0.2, "amplitude": 1},
            {"center": 0.3, "sigma": 0.2, "amplitude": 1},
        ]})


def test_log_ratio_recovers_exact_complex_amplitude_and_unwrapped_phase():
    k = np.linspace(2, 14, 601)
    reference = np.exp(-0.02 * k**2) * np.exp(1j * (4 * k + 0.7))
    logamp = np.log(0.85) - 0.004 * k**2
    phase = 0.3 * k
    target = reference * np.exp(logamp + 1j * phase)
    result = log_ratio(k, reference, target, {"kmin": 3, "kmax": 13})
    mask = (k >= 3) & (k <= 13)
    np.testing.assert_allclose(result["log_amplitude_ratio"], logamp[mask], atol=1e-14)
    np.testing.assert_allclose(result["phase_difference"], phase[mask], atol=1e-14)
    assert "No cumulant" in result["details"]["assumptions"]
    json.dumps(result, allow_nan=False)


def test_log_ratio_keeps_phase_branch_explicit():
    k = np.linspace(2, 10, 101)
    reference = np.ones(k.size, dtype=complex)
    target = np.exp(1j * (4 + k * 0.1))
    result = log_ratio(k, reference, target, {"phase_offset": 1})
    np.testing.assert_allclose(result["phase_difference"], 4 + 0.1 * k, atol=1e-14)


def test_log_ratio_rejects_real_raw_chi_zero_amplitude_and_bad_ranges():
    k = np.linspace(2, 10, 101)
    z = np.exp(1j * 4 * k)
    with pytest.raises(ValueError, match="complex shell-filtered"):
        log_ratio(k, np.sin(k), np.sin(k), {})
    bad = z.copy()
    bad[12] = 0
    with pytest.raises(ValueError, match="amplitude_min"):
        log_ratio(k, z, bad, {})
    with pytest.raises(ValueError, match="kmin < kmax"):
        log_ratio(k, z, z, {"kmin": 12})
    with pytest.raises(ValueError, match="same length"):
        log_ratio(k, z[:-1], z, {})
    with pytest.raises(ValueError, match="Unsupported options"):
        log_ratio(k, z, z, {"fit_expression": "c0+k"})


@pytest.mark.parametrize("edge_step", [1, 3.7])
def test_multi_electron_subtraction_recovers_known_secondary_edge(edge_step):
    x = np.linspace(8750, 9350, 1201)
    e0, shift, amplitude, width = 8980, 120, 0.014, 2
    base = 0.2 + edge_step / (1 + np.exp(-(x - e0) / 3))
    # Independent equation for a Lorentzian-broadened secondary step, with
    # amplitude specified relative to the primary edge, not in raw mu units.
    excitation = amplitude * edge_step * (0.5 + np.arctan((x - e0 - shift) / width) / np.pi)
    observed = base + excitation
    before = observed.copy()
    result = transform_spectrum("multi_electron", x, observed,
        {"e0": e0, "shift": shift, "amplitude": amplitude, "width": width, "edge_step": edge_step})
    np.testing.assert_allclose(result["mu"], base, atol=1e-14)
    np.testing.assert_array_equal(observed, before)
    np.testing.assert_array_equal(result["energy"], x)
    np.testing.assert_allclose(result["details"]["excitation"], excitation, atol=1e-14)
    assert result["details"]["model"] == "arctangent"
    assert result["details"]["excitation"][np.argmin(abs(x - 9100))] == pytest.approx(amplitude * edge_step / 2)
    assert "Reflected-spectrum method is not implemented" in result["details"]["assumptions"]
    json.dumps(result, allow_nan=False)


def test_multi_electron_zero_amplitude_is_explicit_identity(xas_arrays):
    x, y = xas_arrays
    result = transform_spectrum("multi_electron", x, y,
        {"e0": 8980, "shift": 120, "amplitude": 0, "width": 2, "edge_step": 1})
    np.testing.assert_array_equal(result["mu"], y)
    assert result["details"]["amplitude"] == 0


@pytest.mark.parametrize("overrides, message", [
    ({"method": "reflection"}, "method must be"),
    ({"shift": 0}, "greater than zero"),
    ({"shift": 1000}, "inside the measured range"),
    ({"amplitude": -0.01}, "fraction"),
    ({"amplitude": 2}, "fraction"),
    ({"amplitude": True}, "finite number"),
    ({"width": 0}, "greater than zero"),
    ({"width": 1e-20}, "energy spacing"),
    ({"width": 1e8}, "energy spacing"),
    ({"edge_step": 0}, "greater than zero"),
    ({"e0": 1000}, "inside the measured range"),
    ({"fit": True}, "Unsupported options"),
])
def test_multi_electron_rejects_unjustified_or_invalid_parameters(xas_arrays, overrides, message):
    opts = {"e0": 8980, "shift": 120, "amplitude": 0.014, "width": 2, "edge_step": 1, **overrides}
    with pytest.raises(ValueError, match=message):
        transform_spectrum("multi_electron", *xas_arrays, opts)


@pytest.mark.parametrize("missing", ["e0", "shift", "amplitude", "width", "edge_step"])
def test_multi_electron_does_not_guess_parameters(xas_arrays, missing):
    opts = {"e0": 8980, "shift": 120, "amplitude": 0.014, "width": 2, "edge_step": 1}
    del opts[missing]
    with pytest.raises(ValueError, match=missing):
        transform_spectrum("multi_electron", *xas_arrays, opts)


@pytest.mark.parametrize("order", [2, 3, 4])
def test_log_ratio_cumulants_recover_known_effective_distribution_changes(order):
    k = np.linspace(2, 14, 601)
    truth = {"c0": np.log(0.85), "delta_c1": 0.035, "delta_c2": 0.0015}
    if order >= 3:
        truth["delta_c3"] = 0.00008
    if order == 4:
        truth["delta_c4"] = 0.000003
    # Characteristic-function expansion: increased variance attenuates the
    # target, while increased first cumulant increases its phase.
    logamp = truth["c0"] - 2 * truth["delta_c2"] * k**2 + (2 / 3) * truth.get("delta_c4", 0) * k**4
    phase = 2 * truth["delta_c1"] * k - (4 / 3) * truth.get("delta_c3", 0) * k**3
    reference = np.exp(-0.008 * k**2 + 1j * (4 * k + 0.5))
    target = reference * np.exp(logamp + 1j * phase)
    result = log_ratio(k, reference, target,
        {"kmin": 3, "kmax": 13, "fit_cumulants": True, "max_cumulant": order})
    fitted = result["cumulant_fit"]
    assert set(fitted["parameters"]) == set(truth)
    for name, value in truth.items():
        assert fitted["parameters"][name]["value"] == pytest.approx(value, abs=1e-13)
    assert fitted["parameters"]["delta_c2"]["value"] > 0
    assert fitted["parameters"]["delta_c2"]["units"] == "angstrom^2"
    for key, observed in (("log_amplitude", result["log_amplitude_ratio"]), ("phase", result["phase_difference"])):
        np.testing.assert_allclose(fitted[key]["fit"], observed, atol=1e-13)
        assert fitted[key]["redchi"] < 1e-25
        assert len(fitted[key]["covariance"]) == len(fitted[key]["parameter_order"])
    assert fitted["details"]["omitted_terms"] == [f"delta_c{i}" for i in range(order + 1, 5)]
    assert "minus the c2" in fitted["details"]["convention"]
    json.dumps(result, allow_nan=False)


def test_log_ratio_cumulant_noisy_fit_has_explicit_nominal_covariance():
    k = np.linspace(2, 14, 601)
    rng = np.random.default_rng(728)
    reference = np.exp(1j * 4 * k)
    logamp = -0.15 - 0.002 * k**2 + 2e-6 * k**4 + rng.normal(0, 0.001, k.size)
    phase = 0.08 * k - 8e-5 * k**3 + rng.normal(0, 0.001, k.size)
    target = reference * np.exp(logamp + 1j * phase)
    fitted = log_ratio(k, reference, target, {"fit_cumulants": True})["cumulant_fit"]
    expected = {"c0": -0.15, "delta_c1": 0.04, "delta_c2": 0.001,
                "delta_c3": 6e-5, "delta_c4": 3e-6}
    for name, value in expected.items():
        par = fitted["parameters"][name]
        assert par["stderr"] > 0
        assert abs(par["value"] - value) < 4 * par["stderr"]
    for key, nparams in (("log_amplitude", 3), ("phase", 2)):
        fit = fitted[key]
        assert fit["redchi"] == pytest.approx(1e-6, rel=0.15)
        assert fit["degrees_of_freedom"] == k.size - nparams
        covariance = np.array(fit["covariance"])
        np.testing.assert_allclose(covariance, covariance.T)
        assert np.linalg.eigvalsh(covariance).min() > 0
        for i, name in enumerate(fit["parameter_order"]):
            assert covariance[i, i] == pytest.approx(fitted["parameters"][name]["stderr"]**2)
    assert "filtered samples are correlated" in fitted["details"]["uncertainty"]


def test_cumulant_fits_do_not_resolve_global_phase_ambiguity_silently():
    k = np.linspace(10, 14, 101)
    reference = np.ones(k.size, dtype=complex)
    target = np.exp(1j * 0.4 * k)
    result = log_ratio(k, reference, target,
                       {"fit_cumulants": True, "max_cumulant": 2, "phase_offset": 1})
    fitted = result["cumulant_fit"]
    assert fitted["parameters"]["delta_c1"]["value"] == pytest.approx(0.2, abs=1e-14)
    assert fitted["phase"]["redchi"] < 1e-25


@pytest.mark.parametrize("options, message", [
    ({"fit_cumulants": "true"}, "boolean"),
    ({"fit_cumulants": True, "max_cumulant": 5}, "integer"),
    ({"fit_cumulants": True, "max_cumulant": 2.5}, "integer"),
    ({"max_cumulant": 4}, "requires fit_cumulants"),
    ({"fit_cumulants": True, "kmin": 11, "kmax": 5}, "kmin < kmax"),
])
def test_log_ratio_cumulant_invalid_options(options, message):
    k = np.linspace(2, 14, 601)
    z = np.exp(1j * 4 * k)
    with pytest.raises(ValueError, match=message):
        log_ratio(k, z, z, options)


@pytest.mark.parametrize("grid, message", [
    (np.linspace(2, 14, 5), "6–20000"),
    (np.linspace(2, 14, 20001), "6–20000"),
    (np.linspace(10, 10.000001, 101), "ill-conditioned"),
])
def test_log_ratio_cumulant_rejects_unsafe_or_unidentifiable_fits(grid, message):
    z = np.exp(1j * 4 * grid)
    with pytest.raises(ValueError, match=message):
        log_ratio(grid, z, z, {"fit_cumulants": True})
