"""Numerical E0 selection against analytic spectra and pinned source formulas.

Measured Cu data come from the repository's XrayLarch examples. The spline
reference solves the natural-spline curvature equations independently of
the production CubicSpline call, then evaluates Ifeffit's splint expression.
No store, edge finder, normalization or interpolation calls are mocked.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from larch import Group
from larch.xafs import find_e0, pre_edge
from scipy.linalg import solve_banded
from scipy.special import expit

from xraylarch_web.athena_e0 import atomic_edge, compute_e0, edge_catalog
from xraylarch_web.athena_science import AthenaParameters, ScientificError


NORMALIZATION = {"pre1": -150, "pre2": -30, "norm1": 50, "norm2": 300, "nnorm": 1}
REPORT_KEYS = {"method", "e0", "seed_e0", "element", "edge", "tabulated_e0", "iterations", "converged", "warnings"}
MEASURED = Path(__file__).parents[2] / "examples" / "xafsdata" / "cu_rt01.xmu"


@pytest.fixture
def clean_edge():
    x = np.linspace(8750, 9350, 1201)
    y = .2 + .0001 * (x - x[0]) + 1.8 * expit((x - 8980) / 2.5)
    return x, y


@pytest.fixture
def white_lines():
    x = np.linspace(8750, 9350, 1201)
    # The first peak is deliberately smaller; the large linear background
    # separates the maximum of raw mu from that of the flattened spectrum.
    y = (.2 + .01 * (x - x[0]) + 1.8 * expit((x - 8980) / 2)
         + .7 * np.exp(-.5 * ((x - 8992.16) / 1.7) ** 2)
         + 2 * np.exp(-.5 * ((x - 9025.12) / 2) ** 2))
    return x, y


def assert_report(report):
    assert set(report) == REPORT_KEYS
    assert isinstance(report["e0"], float)
    assert isinstance(report["iterations"], int)
    assert isinstance(report["converged"], bool)
    assert isinstance(report["warnings"], list)
    json.dumps(report, allow_nan=False)


def natural_spline_reference(x, y, grid):
    """Solve natural curvatures, then the Ifeffit 1.2.11d splint equation."""
    h = np.diff(x)
    n = x.size
    band = np.zeros((3, n))
    band[1, 0] = band[1, -1] = 1
    band[1, 1:-1] = 2 * (h[:-1] + h[1:])
    band[0, 2:] = h[1:]
    band[2, :-2] = h[:-1]
    rhs = np.zeros(n)
    rhs[1:-1] = 6 * np.diff(np.diff(y) / h)
    curvature = solve_banded((1, 1), band, rhs)
    index = np.clip(np.searchsorted(x, grid, side="right") - 1, 0, n - 2)
    width = x[index + 1] - x[index]
    a = (x[index + 1] - grid) / width
    b = (grid - x[index]) / width
    return (a * y[index] + b * y[index + 1] + width ** 2 / 6 *
            ((a ** 3 - a) * curvature[index] + (b ** 3 - b) * curvature[index + 1]))


def test_default_derivative_matches_existing_larch_and_ignores_old_e0(clean_edge):
    x, y = clean_edge
    report = compute_e0(x, y, {"e0": 9020})
    assert report["e0"] == find_e0(x, y) == 8980
    assert report["seed_e0"] == 8980
    assert report["iterations"] == 0 and report["converged"] is True
    assert report["warnings"] == ["Element and edge are inferred from energy; confirm Cu K matches this measurement."]
    assert_report(report)


@pytest.mark.parametrize("data_type", ["mu", "xanes", "norm"])
def test_derivative_supports_all_energy_representations(clean_edge, data_type):
    report = compute_e0(*clean_edge, None, data_type=data_type)
    assert report["e0"] == 8980
    assert_report(report)


def test_short_spectrum_uses_documented_derivative_fallback():
    x = np.linspace(8920, 9040, 61)
    y = expit((x - 8980) / 2)
    report = compute_e0(x, y, {})
    assert report["e0"] == x[1 + np.argmax(np.gradient(y, x)[1:-1])]
    assert any("fallback" in warning for warning in report["warnings"])


@pytest.mark.parametrize("fraction", [.2, .5, .8])
@pytest.mark.parametrize("data_type", ["mu", "xanes", "norm"])
def test_fraction_recovers_logistic_known_answer(clean_edge, fraction, data_type):
    x, y = clean_edge
    if data_type == "norm":
        y = expit((x - 8980) / 2.5)
    report = compute_e0(x, y, NORMALIZATION, method="fraction", fraction=fraction,
                        data_type=data_type, seed_e0=8982)
    expected = 8980 + 2.5 * np.log(fraction / (1 - fraction))
    assert report["e0"] == pytest.approx(expected, abs=.006)
    assert 1 <= report["iterations"] <= 5
    assert report["converged"] is True
    assert report["seed_e0"] == 8982
    assert_report(report)


def test_fraction_honors_fixed_step_instead_of_refitting_amplitude(clean_edge):
    x, y = clean_edge
    # Doubling the fixed step makes half of that step the whole actual edge;
    # choose 0.25 to test a well-bracketed, identical half-height crossing.
    ordinary = compute_e0(x, y, NORMALIZATION, method="fraction", fraction=.5)
    fixed = compute_e0(x, y, {**NORMALIZATION, "step": 3.6}, method="fraction", fraction=.25)
    assert fixed["e0"] == pytest.approx(ordinary["e0"], abs=1e-4)
    shifted_fraction = compute_e0(x, y, {**NORMALIZATION, "step": 2.7}, method="fraction", fraction=.5)
    # Linear interpolation of a 0.5 eV-sampled logistic differs slightly
    # from its continuous analytic inverse; compare the measured crossing.
    sampled = np.interp(.75, expit((x - 8980) / 2.5), x)
    assert shifted_fraction["e0"] == pytest.approx(sampled, abs=1e-4)
    assert shifted_fraction["e0"] == pytest.approx(8980 + 2.5 * np.log(3), abs=.007)


def test_fraction_uses_normalized_values_without_fitting_or_display_corrections(clean_edge):
    x, _ = clean_edge
    y = expit((x - 8980) / 2.5)
    a = compute_e0(x, y, {}, method="fraction", fraction=.7, data_type="norm")
    b = compute_e0(x, y, {"step": 9, "fnorm": True, "flatten": False, "norm1": 1000, "norm2": 2000},
                   method="fraction", fraction=.7, data_type="norm")
    assert a == b


@pytest.mark.parametrize("upper,expected", [(1.2, 8980 + 1 / 3), (1.0, 8981)])
def test_fraction_one_recovers_interior_unit_step_crossing(upper, expected):
    # A normalized edge with a white-line overshoot crosses unit height
    # inside the scan, either between samples or at an exact measured point.
    x = np.arange(8975, 8986, dtype=float)
    y = np.array([0, .05, .1, .3, .6, .9, upper, 1.3, 1.2, 1.1, 1])
    report = compute_e0(x, y, {}, method="fraction", fraction=1,
                        seed_e0=8980, data_type="norm")
    assert report["e0"] == pytest.approx(expected, abs=1e-10)
    assert x[1] < report["e0"] < x[-2]
    assert report["iterations"] == 2
    assert report["converged"] is True
    assert_report(report)


def test_fraction_stops_after_five_real_normalizations_and_reports_nonconvergence(clean_edge):
    x, _ = clean_edge
    y = .2 + .0001 * (x - x[0]) + 1.8 * expit((x - 8980) / 8)
    p = {"pre1": -150, "pre2": -60, "norm1": 0, "norm2": 20, "nnorm": 0}
    report = compute_e0(x, y, p, method="fraction", fraction=.9, seed_e0=8980)
    assert report["iterations"] == 5
    assert report["converged"] is False
    assert any("did not converge" in warning for warning in report["warnings"])
    assert_report(report)


@pytest.mark.parametrize("seed", [8978.2, 8981.8, 8980])
def test_zero_crossing_finds_known_inflection_in_either_direction(clean_edge, seed):
    x, _ = clean_edge
    y = expit((x - 8980) / 2.5)
    report = compute_e0(x, y, {}, method="zero_crossing", seed_e0=seed)
    assert report["e0"] == pytest.approx(8980, abs=1e-10)
    assert report["iterations"] == 1
    assert_report(report)


def test_zero_crossing_uses_source_sample_search_order_on_irregular_grid():
    x = np.array([100, 101, 102, 103, 110, 111, 112, 113.])
    y = np.array([0, .1, .2, .6, .8, .7, .4, .3])
    # At seed=104 the anchor is sample 110. The downward root at
    # 101+6/7 is nearer in eV, but the upward bracket is encountered first
    # by the pinned source's expanding sample-count search.
    report = compute_e0(x, y, {}, method="zero_crossing", seed_e0=104)
    assert report["e0"] == pytest.approx(111.68, abs=1e-10)
    assert abs(104 - (101 + 6 / 7)) < abs(104 - report["e0"])


def test_zero_crossing_can_continue_on_remaining_side_at_scan_boundary():
    x = np.array([100, 101, 102, 103, 110, 111, 112, 113.])
    y = np.array([0, .1, .2, .6, .8, .7, .4, .3])
    report = compute_e0(x, y, {}, method="zero_crossing", seed_e0=112)
    assert report["e0"] == pytest.approx(111.68)


def test_white_line_uses_first_local_turnover_not_largest_peak(white_lines):
    x, y = white_lines
    p = {**NORMALIZATION, "norm1": 60}
    first = compute_e0(x, y, p, method="white_line", seed_e0=8980)
    second = compute_e0(x, y, p, method="white_line", seed_e0=9000)
    assert first["e0"] == pytest.approx(8992.18, abs=.021)
    assert second["e0"] == pytest.approx(9025.12, abs=.021)
    assert first["e0"] < 9000 < second["e0"]
    assert first["iterations"] == second["iterations"] == 1
    assert_report(first)


def test_white_line_matches_pinned_natural_spline_of_flattened_full_scan(white_lines):
    x, y = white_lines
    p = {**NORMALIZATION, "norm1": 60}
    direct = Group()
    pre_edge(x, y, group=direct, e0=8980, make_flat=True, **p)
    # First sampled raw turnover is 8992.0; pinned margin=6 samples (3 eV).
    peak = int(np.where(x == 8992)[0][0])
    assert y[peak + 1] < y[peak] and y[peak] > y[peak - 1]
    grid = x[peak - 6] + .02 * np.arange(301)
    flat_interpolated = natural_spline_reference(x, direct.flat, grid)
    raw_interpolated = natural_spline_reference(x, y, grid)
    expected = float(grid[np.argmax(flat_interpolated)])
    report = compute_e0(x, y, p, method="white_line", seed_e0=8980)
    assert report["e0"] == pytest.approx(expected, abs=1e-10)
    assert abs(expected - grid[np.argmax(raw_interpolated)]) >= .02 - 1e-10
    assert report["e0"] != x[peak]  # interpolation actually refines the sample
    # Plot flattening selection does not change the source's fixed flat suffix.
    assert report == compute_e0(x, y, {**p, "flatten": False, "fnorm": True}, method="white_line", seed_e0=8980)


def test_white_line_normalized_input_uses_existing_curve(white_lines):
    x, y = white_lines
    p = {**NORMALIZATION, "norm1": 60}
    direct = Group()
    pre_edge(x, y, group=direct, e0=8980, make_flat=True, **p)
    report = compute_e0(x, direct.flat, {}, method="white_line", data_type="norm", seed_e0=8980)
    assert report["e0"] == pytest.approx(8992.18, abs=.021)


@pytest.mark.parametrize("method,options", [
    ("derivative", {}), ("fraction", {"fraction": .7, "seed_e0": 8980}),
    ("zero_crossing", {"seed_e0": 8981}), ("white_line", {"seed_e0": 8980}),
])
def test_shifted_coordinates_match_explicitly_shifted_data(white_lines, method, options):
    x, y = white_lines
    shift = 4.25
    kwargs = {**options}
    if "seed_e0" in kwargs:
        kwargs["seed_e0"] += shift
    p = {**NORMALIZATION, "norm1": 60}
    a = compute_e0(x, y, {**p, "energy_shift": shift}, method=method, **kwargs)
    b = compute_e0(x + shift, y, p, method=method, **kwargs)
    assert a == b
    base = compute_e0(x, y, p, method=method, **options)
    assert a["e0"] == pytest.approx(base["e0"] + shift, abs=1e-6)


def test_manual_and_atomic_values_are_not_shifted_twice(clean_edge):
    x, y = clean_edge
    manual = compute_e0(x, y, {"energy_shift": 4.25}, method="manual", value=8981.125)
    assert manual["e0"] == 8981.125 and manual["seed_e0"] is None
    atomic = compute_e0(x, y, {"energy_shift": 4.25}, method="atomic", element="cu", edge="k")
    assert atomic["e0"] == atomic["tabulated_e0"] == 8979
    assert atomic["warnings"] == []
    assert_report(manual)
    assert_report(atomic)


@pytest.mark.parametrize("element,edge,energy", [(" cu ", " k ", 8979), ("fe", "K", 7112), ("PT", "l3", 11564)])
def test_atomic_edge_canonicalizes_and_matches_known_elam_values(element, edge, energy):
    assert atomic_edge(element, edge) == {"element": element.strip().title(), "edge": edge.strip().upper(), "energy": energy}


def test_atomic_inference_uses_seed_and_warns_concisely(clean_edge):
    report = compute_e0(*clean_edge, {}, method="atomic")
    assert (report["seed_e0"], report["element"], report["edge"], report["e0"]) == (8980, "Cu", "K", 8979)
    assert report["warnings"] == ["Element and edge are inferred from energy; confirm Cu K matches this measurement."]


@pytest.mark.parametrize("source,preferred", [(('Nd', 'L1'), ('Fe', 'K')), (('Sm', 'L1'), ('Co', 'K')), (('Ir', 'L1'), ('Bi', 'L3'))])
def test_inference_uses_pinned_demeter_remappings_but_explicit_pair_wins(source, preferred):
    energy = atomic_edge(*source)["energy"]
    x = np.linspace(energy - 300, energy + 300, 1201)
    y = expit((x - energy) / 2)
    inferred = compute_e0(x, y, {}, method="atomic", seed_e0=energy)
    assert (inferred["element"], inferred["edge"]) == preferred
    explicit = compute_e0(x, y, {}, method="atomic", element=source[0], edge=source[1])
    assert (explicit["element"], explicit["edge"], explicit["e0"]) == (*source, energy)
    assert explicit["warnings"] == []


def test_edge_catalog_matches_atomic_lookup_and_does_not_share_mutable_state():
    symbols = edge_catalog()["elements"]
    assert symbols[0] == "H" and symbols[-1] == "Cf" and "Cu" in symbols
    catalog = edge_catalog("cu")
    assert catalog["element"] == "Cu"
    assert catalog["edges"][0] == {"edge": "K", "energy": 8979}
    for row in catalog["edges"]:
        assert atomic_edge("Cu", row["edge"])["energy"] == row["energy"]
    catalog["edges"][0]["energy"] = -1
    symbols.clear()
    assert edge_catalog("Cu")["edges"][0]["energy"] == 8979
    assert edge_catalog()["elements"][0] == "H"
    assert edge_catalog("Og") == {"element": "Og", "edges": []}
    json.dumps(edge_catalog("Pt"), allow_nan=False)


@pytest.mark.parametrize("element,edge", [("Xx", "K"), ("copper", "K"), (29, "K"), (True, "K"), ("Cu", None), ("Cu", "L9"), ("Og", "K")])
def test_atomic_lookup_rejects_unknown_symbols_or_unavailable_edges(element, edge):
    with pytest.raises(ScientificError, match="element|symbol|edge"):
        atomic_edge(element, edge)


@pytest.mark.parametrize("options", [
    {"method": "unknown"}, {"method": "derivative", "value": 8980},
    {"method": "derivative", "seed_e0": 8980}, {"method": "manual"},
    {"method": "manual", "value": True}, {"method": "manual", "value": np.inf},
    {"method": "atomic", "element": "Cu"}, {"method": "atomic", "edge": "K"},
    {"method": "zero_crossing", "seed_e0": np.nan},
    {"method": "zero_crossing", "seed_e0": True},
    {"method": "fraction", "fraction": 0}, {"method": "fraction", "fraction": np.nextafter(1., 2.)},
    {"method": "fraction", "fraction": -1}, {"method": "fraction", "fraction": True},
    {"method": "fraction", "fraction": np.nan}, {"method": "fraction", "fraction": np.inf},
    {"method": "derivative", "fraction": .7}, {"method": "manual", "value": 8980, "element": "Cu"},
])
def test_invalid_method_arguments_are_actionable(clean_edge, options):
    with pytest.raises(ScientificError):
        compute_e0(*clean_edge, {}, **options)


@pytest.mark.parametrize("value", [8750, 9350, -1, 1e8])
@pytest.mark.parametrize("method,key", [("manual", "value"), ("fraction", "seed_e0")])
def test_explicit_coordinates_require_measured_support_on_both_sides(clean_edge, method, key, value):
    with pytest.raises(ScientificError, match="shifted energy range"):
        compute_e0(*clean_edge, {}, method=method, **{key: value})


def test_atomic_outside_scan_is_rejected_without_calibration(clean_edge):
    with pytest.raises(ScientificError, match="Tabulated atomic E0.*shifted energy range"):
        compute_e0(*clean_edge, {}, method="atomic", element="Fe", edge="K")


@pytest.mark.parametrize("data_type", ["chi", "difference", "pixels", None])
def test_nonenergy_types_are_rejected(clean_edge, data_type):
    with pytest.raises(ScientificError, match="energy data"):
        compute_e0(*clean_edge, {}, data_type=data_type)


@pytest.mark.parametrize("x,y", [
    ([1, 2], [1, 2]), (list(range(1, 10)), list(range(8))),
    ([1, 2, 3, 4, 5, 6, 7, 7], list(range(8))),
    (list(range(8, 0, -1)), list(range(8))),
    (list(range(1, 9)), [0, 1, 2, 3, np.nan, 5, 6, 7]),
    (list(range(1, 9)), np.ones(8)),
    (list(range(1, 9)), np.arange(8, dtype=complex)),
    (np.ones((2, 4)), np.ones((2, 4))),
])
def test_invalid_spectra_are_rejected(x, y):
    with pytest.raises(ScientificError):
        compute_e0(x, y, {})


def test_bounds_close_spacing_and_bad_recipe_types(clean_edge):
    x, y = clean_edge
    with pytest.raises(ScientificError, match="100000"):
        compute_e0(np.linspace(8700, 9400, 100001), np.arange(100001), {})
    with pytest.raises(ScientificError, match="0.0005"):
        compute_e0(np.linspace(8000, 8000.0001, 10), np.arange(10), {})
    with pytest.raises(ScientificError, match="positive energies"):
        compute_e0(x, y, {"energy_shift": -9000})
    with pytest.raises(ScientificError, match="rescale"):
        compute_e0(np.arange(1, 9), np.linspace(-1, 1, 8) * 1e308, {})
    for invalid in ([], 0, "parameters"):
        with pytest.raises(ScientificError, match="parameters"):
            compute_e0(x, y, invalid)


def test_missing_fraction_and_derivative_crossings_raise_instead_of_falling_back():
    x = np.arange(100, 200, dtype=float)
    y = np.linspace(.1, .2, x.size)
    with pytest.raises(ScientificError, match="not bracketed"):
        compute_e0(x, y, {}, method="fraction", fraction=.5, data_type="norm", seed_e0=150)
    with pytest.raises(ScientificError, match="not bracketed"):
        compute_e0(x, y + .5, {}, method="fraction", fraction=.5, data_type="norm", seed_e0=150)
    with pytest.raises(ScientificError, match="No second-derivative"):
        compute_e0(x, x * 2, {}, method="zero_crossing", seed_e0=150)
    with pytest.raises(ScientificError, match="No sampled white-line turnover"):
        compute_e0(x, x * 2, {}, method="white_line", seed_e0=150)


def test_white_line_rejects_missing_margin_and_oversized_refinement_grid():
    x = np.arange(100, 110, dtype=float)
    y = np.exp(-.5 * ((x - 106) / 2) ** 2)
    with pytest.raises(ScientificError, match="six measured samples"):
        compute_e0(x, y, {}, method="white_line", data_type="norm", seed_e0=104)
    x = 10000 + np.arange(30) * 1000.
    y = np.exp(-.5 * ((np.arange(30) - 15) / 2) ** 2)
    with pytest.raises(ScientificError, match="100000 grid points"):
        compute_e0(x, y, {}, method="white_line", data_type="norm", seed_e0=20000)


def test_normalization_interval_without_measured_overlap_is_rejected(clean_edge):
    with pytest.raises(ScientificError, match="norm1/norm2"):
        compute_e0(*clean_edge, {"norm1": 600, "norm2": 1000}, method="fraction")


@pytest.mark.parametrize("method,options", [
    ("derivative", {}), ("fraction", {}), ("zero_crossing", {}),
    ("white_line", {}), ("atomic", {}), ("manual", {"value": 8981}),
])
def test_measured_copper_returns_finite_source_backed_selection_without_mutation(method, options):
    assert hashlib.sha256(MEASURED.read_bytes()).hexdigest() == "cb66455a09abf464d486989faf43ffbaffdf14f970e85bdbe75f47261cfa96e6"
    data = np.loadtxt(MEASURED)
    x, y = data[:, 0].copy(), data[:, 1].copy()
    parameters = AthenaParameters()
    before = x.copy(), y.copy(), deepcopy(parameters.model_dump())
    result = compute_e0(x, y, parameters, method=method, **options)
    assert 8978 < result["e0"] < 8990
    assert (result["element"], result["edge"]) == ("Cu", "K")
    if method == "derivative":
        assert result["e0"] == find_e0(x, y) == 8980.5
    elif method == "fraction":
        assert result["e0"] == pytest.approx(8985.9996355, abs=.001)
        assert result["converged"] is True and result["iterations"] == 3
    elif method == "zero_crossing":
        assert result["e0"] == pytest.approx(8980.55848090622, abs=1e-6)
    elif method == "atomic":
        assert result["e0"] == 8979
    assert_report(result)
    np.testing.assert_array_equal(x, before[0])
    np.testing.assert_array_equal(y, before[1])
    assert parameters.model_dump() == before[2]
