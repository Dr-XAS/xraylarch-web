"""Enforced import defaults with real scalar normalization and final Larch.

References are pinned Defaults.pm and bkg/fft/xanes configuration formulas.
Measured Cu foil and Fe2O3 are the repository's XrayLarch example spectra.
No derivative finder, normalization, selector, or processing call is mocked.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from larch import Group
from larch.xafs import pre_edge
from larch.xafs.xafsutils import ETOK
from scipy.special import expit

from xraylarch_web.athena_e0 import atomic_edge, compute_e0
from xraylarch_web.athena_import_policy import initialize_import
from xraylarch_web.athena_science import AthenaParameters, ScientificError, process_spectrum


CU_POLICY = {"element": "Cu", "edge": "K"}
EXAMPLES = Path(__file__).parents[2] / "examples" / "xafsdata"
RESULT_KEYS = {"parameters", "data_type", "edge_identity", "e0_selection", "defaults", "warnings"}


@pytest.fixture
def copper():
    x = np.linspace(8779, 9479, 1401)
    y = .2 + .00002 * (x - x[0]) + 1.8 * expit((x - 8983) / 2.5)
    return x, y


def assert_report(result, element="Cu", edge="K"):
    assert set(result) == RESULT_KEYS
    assert result["edge_identity"] == {"element": element, "edge": edge, "origin": "enforced"}
    assert result["e0_selection"]["method"] == "fraction"
    assert result["e0_selection"]["seed_e0"] == atomic_edge(element, edge)["energy"]
    assert result["parameters"]["e0"] == result["e0_selection"]["e0"]
    assert AthenaParameters(**result["parameters"]).model_dump() == result["parameters"]
    json.dumps(result, allow_nan=False)


def final_processing(x, y, result):
    processed = process_spectrum(x, y, result["parameters"], result["data_type"])
    assert processed["effective"]["e0"] == result["parameters"]["e0"]
    assert processed["arrays"]["norm"]
    if result["data_type"] != "xanes":
        assert processed["arrays"]["chi"]
    json.dumps(processed, allow_nan=False)
    return processed


def test_default_import_resolves_pinned_ranges_at_table_seed(copper):
    x, y = copper
    result = initialize_import(x, y, policy=CU_POLICY)
    seed = 8979
    k_end = np.sqrt((x[-1] - seed) * ETOK)
    resolved = result["defaults"]["resolved_at_seed"]
    assert resolved["pre1"] == -150 and resolved["pre2"] == -30
    assert resolved["norm1"] == 150 and resolved["norm2"] == x[-1] - seed - 100
    assert resolved["nnorm"] == 2  # source bkg.nnorm=3; template subtracts one
    assert resolved["bkg_kmin"] == 0 and resolved["kmin"] == 3
    assert resolved["bkg_kmax"] == min(round(k_end, 3), k_end)
    assert resolved["kmax"] == round(k_end - 2, 3)  # actual fft.kmax default
    assert result["defaults"]["automatic_fields"] == sorted([
        "pre1", "pre2", "norm1", "norm2", "nnorm", "bkg_kmax", "kmax"])
    assert result["defaults"]["seed_energy_range"] == [x[0], x[-1]]
    assert result["defaults"]["short_scan"] is False
    assert result["parameters"]["e0"] == pytest.approx(8983, abs=.001)
    assert result["warnings"] == []
    assert_report(result)
    final_processing(x, y, result)


def test_preedge_noise_false_derivative_is_bypassed_by_enforced_seed(copper):
    x, y = copper
    noisy = y + .4 * np.exp(-.5 * ((x - 8840) / .7) ** 2)
    unforced = compute_e0(x, noisy, {})
    assert unforced["e0"] < 8900  # fixture really confounds initial finding
    result = initialize_import(x, noisy, policy=CU_POLICY)
    assert result["e0_selection"]["seed_e0"] == 8979
    assert result["parameters"]["e0"] == pytest.approx(8983, abs=.15)
    assert_report(result)
    final_processing(x, noisy, result)


@pytest.mark.parametrize("element,expected_pre2", [("Cu", -30), ("Se", -45), ("Ag", -60), ("I", -75)])
def test_each_absorber_uses_its_table_seed_and_energy_dependent_pre2(element, expected_pre2):
    seed = atomic_edge(element, "K")["energy"]
    x = np.linspace(seed - 250, seed + 500, 1501)
    y = .1 + 1.5 * expit((x - seed - 3) / 2)
    result = initialize_import(x, y, policy={"element": element.lower(), "edge": "k"})
    assert result["defaults"]["seed_e0"] == seed
    assert result["defaults"]["resolved_at_seed"]["pre2"] == expected_pre2
    assert result["parameters"]["e0"] == pytest.approx(seed + 3, abs=.002)
    assert_report(result, element)


def test_explicit_recipe_survives_enforcement_except_e0(copper):
    x, y = copper
    parameters = AthenaParameters(e0=8880, energy_shift=5.5, step=1.8,
        pre1=-120, pre2=-40, norm1=80, norm2=300, nnorm=1,
        rbkg=1.4, bkg_kmin=.4, bkg_kmax=9, bkg_kweight=1.5,
        bkg_dk=.5, bkg_window="welch", nclamp=3, clamp_lo=2, clamp_hi=4,
        kmin=2.3, kmax=8, kweight=2.5, dk=.75, window="parzen",
        rmin=.5, rmax=4, dr=.2, rwindow="welch", kstep=.1, nfft=1024, flatten=False)
    original = parameters.model_dump()
    result = initialize_import(x, y, parameters, policy=CU_POLICY)
    assert result["parameters"] == original | {"e0": result["parameters"]["e0"]}
    assert parameters.model_dump() == original
    assert result["parameters"]["e0"] == pytest.approx(8988.5, abs=.002)
    assert result["defaults"]["automatic_fields"] == []
    assert result["defaults"]["final_adjustments"] == {}
    assert_report(result)
    final_processing(x, y, result)


def test_shift_is_applied_to_coverage_and_defaults_once(copper):
    x, y = copper
    shifted = initialize_import(x, y, {"energy_shift": 4.25}, policy=CU_POLICY)
    direct = initialize_import(x + 4.25, y, policy=CU_POLICY)
    assert shifted["parameters"] == direct["parameters"] | {"energy_shift": 4.25}
    assert shifted["defaults"] == direct["defaults"]
    assert shifted["e0_selection"] == direct["e0_selection"]
    assert shifted["defaults"]["seed_e0"] == 8979
    final_processing(x, y, shifted)


def test_shifted_axis_can_restore_table_coverage(copper):
    x, y = copper
    with pytest.raises(ScientificError, match="shifted energy range"):
        initialize_import(x - 1000, y, policy=CU_POLICY)
    result = initialize_import(x - 1000, y, {"energy_shift": 1000}, policy=CU_POLICY)
    assert result["parameters"]["e0"] == pytest.approx(8983, abs=.002)


def test_seed_spline_endpoint_moves_inside_final_available_range(copper):
    x, y = copper
    result = initialize_import(x, y, policy=CU_POLICY)
    limits = result["defaults"]["final_adjustments"]["bkg_kmax"]
    available = np.sqrt(ETOK * (x[-1] - result["parameters"]["e0"]))
    assert limits["seed"] > available
    assert limits["final"] == result["parameters"]["bkg_kmax"] == available
    assert "kmax" not in result["defaults"]["final_adjustments"]
    final_processing(x, y, result)


def test_same_data_end_bound_is_not_clipped_when_explicit(copper):
    x, y = copper
    # Valid at the tabulated seed; invalid once fraction moves E0 upward.
    explicit = float(np.sqrt(ETOK * (x[-1] - 8979)))
    params = {"bkg_kmax": explicit}
    with pytest.raises(ScientificError, match="explicit spline bounds"):
        initialize_import(x, y, params, policy=CU_POLICY)
    assert params == {"bkg_kmax": explicit}


def test_automatic_ft_upper_bound_respects_explicit_shorter_spline(copper):
    x, y = copper
    result = initialize_import(x, y, {"bkg_kmax": 7.98}, policy=CU_POLICY)
    assert result["parameters"]["bkg_kmax"] == 7.98
    assert result["parameters"]["kmax"] == pytest.approx(7.95)
    final_processing(x, y, result)


@pytest.mark.parametrize("data_type", ["mu", "xanes"])
def test_short_scans_use_seeded_xanes_defaults_and_live_auto_norm_endpoint(data_type):
    x = np.linspace(8779, 9049, 1081)
    y = .2 + 1.8 * expit((x - 8983) / 2.5)
    result = initialize_import(x, y, policy=CU_POLICY, data_type=data_type)
    assert result["data_type"] == "xanes"
    assert result["defaults"]["short_scan"] is True
    resolved = result["defaults"]["resolved_at_seed"]
    assert resolved["norm1"] == 15 and resolved["norm2"] == 70
    assert resolved["nnorm"] == 2  # resolve_defaults does not call to_default
    assert result["parameters"]["norm2"] == x[-1] - result["parameters"]["e0"]
    assert result["defaults"]["final_adjustments"]["norm2"]["seed"] == 70
    assert result["e0_selection"]["converged"] is True
    assert result["parameters"]["e0"] == pytest.approx(8983, abs=.03)
    assert result["parameters"]["kmax"] is None  # inactive EXAFS recipe
    assert_report(result)
    final_processing(x, y, result)


def test_explicit_xanes_uses_xanes_post_ranges_even_on_a_long_scan(copper):
    x, y = copper
    result = initialize_import(x, y, policy=CU_POLICY, data_type="xanes")
    assert result["defaults"]["short_scan"] is False
    assert result["defaults"]["resolved_at_seed"]["norm1"] == 15
    assert result["defaults"]["resolved_at_seed"]["norm2"] == 500
    final_processing(x, y, result)


def test_short_xanes_keeps_explicit_post_request_and_reports_measured_fit_endpoint():
    x = np.linspace(8779, 9049, 1081)
    y = .2 + 1.8 * expit((x - 8983) / 2.5)
    result=initialize_import(x,y,{"norm1":15,"norm2":70},policy=CU_POLICY)
    assert result['parameters']['norm2']==70
    processed=process_spectrum(x,y,result['parameters'],result['data_type'])
    assert processed['effective']['norm2']==x[-1]-result['parameters']['e0']
    assert any('Normalization norm2' in w for w in result['warnings'])
    direct=Group();pre_edge(x,y,group=direct,**{k:result['parameters'][k] for k in ['e0','pre1','pre2','norm1','norm2','nnorm']})
    np.testing.assert_allclose(processed['arrays']['norm'],direct.norm,rtol=2e-12,atol=2e-13)


def test_short_scan_does_not_silently_disable_explicit_fnorm():
    x = np.linspace(8779, 9049, 1081)
    with pytest.raises(ScientificError, match="disable fnorm"):
        initialize_import(x, expit((x - 8983) / 2.5), {"fnorm": True}, policy=CU_POLICY)


def test_automatic_preedge_start_follows_measured_boundary_when_fraction_moves_down():
    x = np.linspace(8939, 9479, 1081)
    y = .2 + 1.8 * expit((x - 8977) / 1)
    result = initialize_import(x, y, policy=CU_POLICY)
    assert result["defaults"]["resolved_at_seed"]["pre1"] == -40
    assert result["parameters"]["pre1"] == x[0] - result["parameters"]["e0"]
    assert result["defaults"]["final_adjustments"]["pre1"]["final"] > -40
    final_processing(x, y, result)


def test_explicit_preedge_request_survives_fraction_refinement_with_visible_fit_limit():
    x = np.linspace(8939, 9479, 1081)
    y = .2 + 1.8 * expit((x - 8977) / 1)
    result=initialize_import(x,y,{"pre1":-40},policy=CU_POLICY)
    assert result['parameters']['pre1']==-40
    processed=process_spectrum(x,y,result['parameters'],result['data_type'])
    assert processed['effective']['pre1']==x[0]-result['parameters']['e0']
    assert any('Normalization pre1' in w for w in result['warnings'])


@pytest.mark.parametrize("fraction", [.2, .5, .8, 1])
def test_normalized_input_uses_supplied_unit_step_without_recursion(copper, fraction):
    x, _ = copper
    # White-line overshoot crosses 1 in the interior of an otherwise
    # normalized unit-step signal; first fractional crossing is unambiguous.
    y = expit((x - 8983) / 2.5) + .2 * np.exp(-.5 * ((x - 8992) / 3) ** 2)
    direct = compute_e0(x, y, {}, method="fraction", fraction=fraction, seed_e0=8979, data_type="norm")
    result = initialize_import(x, y, {"step": 9, "norm1": 1000, "norm2": 2000},
                               policy={**CU_POLICY, "fraction": fraction}, data_type="norm")
    assert result["data_type"] == "norm"
    assert result["e0_selection"] == direct
    assert result["parameters"]["step"] == 9
    assert result["parameters"]["norm1"] == 1000
    assert not set(result["defaults"]["automatic_fields"]) & {"pre1", "pre2", "norm1", "norm2", "nnorm"}
    assert_report(result)
    processed = final_processing(x, y, result)
    np.testing.assert_array_equal(processed["arrays"]["norm"], y)


def test_enforced_identity_is_not_replaced_by_fraction_inference(copper):
    x, _ = copper
    y = expit((x - 9046) / 2)
    result = initialize_import(x, y, policy=CU_POLICY, data_type="norm")
    assert result["edge_identity"] == {"element": "Cu", "edge": "K", "origin": "enforced"}
    assert (result["e0_selection"]["element"], result["e0_selection"]["edge"]) == ("Dy", "L1")
    assert any("enforced identity remains Cu K" in warning for warning in result["warnings"])


def test_nonconvergence_reports_actual_outer_normalization_iterations(copper):
    x, _ = copper
    y = .2 + .0001 * (x - x[0]) + 1.8 * expit((x - 8980) / 8)
    parameters = {"pre1": -150, "pre2": -60, "norm1": 0, "norm2": 20, "nnorm": 0}
    reference = compute_e0(x, y, parameters, method="fraction", fraction=.9, seed_e0=8979)
    result = initialize_import(x, y, parameters, policy={**CU_POLICY, "fraction": .9})
    assert result["e0_selection"]["iterations"] == 5
    assert result["e0_selection"]["converged"] is False
    assert result["parameters"]["e0"] == reference["e0"]
    assert any("did not converge" in warning for warning in result["warnings"])
    assert any("did not converge" in warning for warning in result["e0_selection"]["warnings"])
    assert_report(result)


def test_fraction_requires_a_measured_crossing_without_clamping_signal(copper):
    x, _ = copper
    y = .9 * expit((x - 8983) / 2.5)
    with pytest.raises(ScientificError, match="not bracketed"):
        initialize_import(x, y, policy={**CU_POLICY, "fraction": 1}, data_type="norm")


@pytest.mark.parametrize("policy", [None, CU_POLICY, {"not": "a policy"}])
def test_chi_bypasses_policy_with_unchanged_validated_recipe(policy):
    params = AthenaParameters(e0=7112, energy_shift=3, kmin=1, kmax=9, rbkg=1.5).model_dump()
    result = initialize_import(np.arange(10), np.zeros(10), params, policy=policy, data_type="chi")
    assert result == {"parameters": params, "data_type": "chi", "edge_identity": None,
                      "e0_selection": None, "defaults": None, "warnings": []}


def test_disabled_policy_is_a_noop_without_resolving_ranges(copper):
    result = initialize_import(*copper, {"e0": 8990}, policy=None)
    assert result["parameters"] == AthenaParameters(e0=8990).model_dump()
    assert result["edge_identity"] is result["e0_selection"] is result["defaults"] is None
    assert result["warnings"] == []


@pytest.mark.parametrize("policy", [
    {}, [], {"element": "Cu"}, {"edge": "K"}, {"element": "Cu", "edge": None},
    {"element": "Xx", "edge": "K"}, {"element": "Cu", "edge": "L9"},
    {**CU_POLICY, "method": "derivative"}, {**CU_POLICY, "fraction": 0},
    {**CU_POLICY, "fraction": np.nextafter(1., 2.)}, {**CU_POLICY, "fraction": True},
    {**CU_POLICY, "fraction": np.nan}, {**CU_POLICY, "fraction": np.inf},
    {**CU_POLICY, "fraction": None}, {**CU_POLICY, "fraction": "invalid"},
])
def test_invalid_policy_does_not_fall_back_to_another_seed(copper, policy):
    with pytest.raises(ScientificError):
        initialize_import(*copper, policy=policy)


@pytest.mark.parametrize("params", [
    {"norm1":499.5,"norm2":800}, {"pre2": -300}, {"norm1": 600, "norm2": 800},
    {"bkg_kmax": 15}, {"bkg_kmax": 8, "kmax": 9},
    {"bkg_kmax": 7.98, "kmax": 7.98}, {"bkg_kmin": 10},
    {"kmin": 11}, {"kmin": 9, "dk": 4}, {"bkg_kmin": 9, "bkg_dk": 10},
])
def test_unusable_explicit_ranges_are_rejected_without_mutation(copper, params):
    before = deepcopy(params)
    with pytest.raises(ValueError):
        initialize_import(*copper, params, policy=CU_POLICY)
    assert params == before


def test_insufficient_postedge_and_preedge_margins_are_actionable():
    for lo, hi in ((8779, 8989), (8977, 9479)):
        x = np.linspace(lo, hi, 1001)
        with pytest.raises(ScientificError, match="normalization ranges|range"):
            initialize_import(x, expit((x - 8981) / 2), policy=CU_POLICY)


def test_norm_short_scan_does_not_change_representation_to_force_processing():
    x = np.linspace(8779, 9049, 1001)
    y = expit((x - 8983) / 2.5)
    with pytest.raises(ValueError, match="kmax|FT range"):
        initialize_import(x, y, policy=CU_POLICY, data_type="norm")
    result = initialize_import(x, y, {"kmin": 1}, policy=CU_POLICY, data_type="norm")
    assert result["data_type"] == "norm"
    final_processing(x, y, result)


def test_invalid_spectrum_and_resource_bounds(copper):
    x, y = copper
    for invalid_x, invalid_y in ((x[::-1], y), (x[:-1], y), (x, np.zeros_like(y)),
                                  (x, y.astype(complex)), (x, np.full_like(y, np.nan))):
        with pytest.raises(ValueError):
            initialize_import(invalid_x, invalid_y, policy=CU_POLICY)
    with pytest.raises(ScientificError, match="100000"):
        initialize_import(np.linspace(8700, 9400, 100001), np.arange(100001), policy=CU_POLICY)
    with pytest.raises(ScientificError, match="spacing"):
        initialize_import(np.linspace(8978.999, 8979.001, 20), np.arange(20), policy=CU_POLICY)
    with pytest.raises(ScientificError, match="positive energies"):
        initialize_import(x, y, {"energy_shift": -10000}, policy=CU_POLICY)
    with pytest.raises(ScientificError, match="parameters"):
        initialize_import(x, y, [], policy=CU_POLICY)
    with pytest.raises(ScientificError, match="data_type"):
        initialize_import(x, y, policy=CU_POLICY, data_type="difference")


def test_enforcement_does_not_mutate_arrays_policy_or_mapping(copper):
    x, y = copper
    policy = {"element": "cu", "edge": "k", "fraction": .6}
    parameters = {"energy_shift": 2.25, "rbkg": 1.3, "kweight": 1.5}
    before = x.copy(), y.copy(), deepcopy(policy), deepcopy(parameters)
    result = initialize_import(x, y, parameters, policy=policy)
    np.testing.assert_array_equal(x, before[0])
    np.testing.assert_array_equal(y, before[1])
    assert policy == before[2] and parameters == before[3]
    assert_report(result)


@pytest.mark.parametrize("element,filename,known_e0,sha256", [
    ("Cu", "cu_rt01.xmu", 8986.437276261428,
     "cb66455a09abf464d486989faf43ffbaffdf14f970e85bdbe75f47261cfa96e6"),
    ("Fe", "fe2o3_rt1.xmu", 7123.315900150594,
     "85e497dd98761e014ddcb31f736d38ec0700c11a9c2c51cd8950b73dc273c5ed"),
])
def test_measured_cu_and_fe_match_independent_seeded_source_formulas(element, filename, known_e0, sha256):
    path = EXAMPLES / filename
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha256
    data = np.loadtxt(path)
    x, y = data[:, 0], data[:, 1]
    seed = atomic_edge(element, "K")["energy"]
    reference_recipe = {"pre1": -150, "pre2": -30, "norm1": 150,
                        "norm2": round(x[-1] - seed - 100, 3), "nnorm": 3 - 1}
    reference = compute_e0(x, y, reference_recipe, method="fraction", seed_e0=seed)
    result = initialize_import(x, y, policy={"element": element, "edge": "K"})
    assert result["e0_selection"] == reference
    assert result["parameters"]["e0"] == pytest.approx(known_e0, abs=1e-6)
    # Independent final normalization verifies the returned recipe, including
    # the source order conversion rather than the native exchange mapping.
    direct = Group()
    pre_edge(x, y, group=direct, e0=result["parameters"]["e0"], **reference_recipe)
    processed = final_processing(x, y, result)
    np.testing.assert_allclose(processed["arrays"]["norm"], direct.norm, atol=1e-11)
    assert_report(result, element)
