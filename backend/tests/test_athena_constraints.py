"""Athena parameter constraints and bidirectional reference energy shifts."""

from copy import deepcopy

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_science import AthenaParameters, ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


@pytest.fixture
def workspace(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    original = store.create()
    project = deepcopy(original)
    x, y = xas_arrays
    for index, shift in enumerate((0, 0, 4.2, 4.2)):
        project["groups"].append(store.make_group(f"scan-{index}", x + shift, y))
    return store, store.save(project, original, "Four test spectra")


def run(store, project, action, indices, **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
        group_ids=[project["groups"][i]["id"] for i in indices], options=options))


def test_all_parameter_copy_preserves_shifts_and_skips_frozen_targets(workspace):
    store, p = workspace
    p = run(store, p, "parameters", [0], energy_shift=3, rbkg=1.3, kweight=2.5)
    p = run(store, p, "parameters", [1], energy_shift=-2)
    p = run(store, p, "metadata", [2], frozen=True)
    before = deepcopy(p)
    p = run(store, p, "copy_parameters", [1, 2, 3], source_id=p["groups"][0]["id"], section="all")
    assert p["groups"][2] == before["groups"][2]
    assert p["groups"][0] == before["groups"][0]
    for index in (1, 3):
        actual, source = p["groups"][index]["parameters"], p["groups"][0]["parameters"]
        assert actual["energy_shift"] == before["groups"][index]["parameters"]["energy_shift"]
        assert {k: v for k, v in actual.items() if k != "energy_shift"} == {
            k: v for k, v in source.items() if k != "energy_shift"}
    assert p["last_operation"]["skipped_group_ids"] == [p["groups"][2]["id"]]
    assert "skipped 1" in p["history"][-1]["message"]


def test_section_copy_uses_draft_but_keeps_other_sections(workspace):
    store, p = workspace
    before = deepcopy(p)
    p = run(store, p, "copy_parameters", [1], source_id=p["groups"][0]["id"],
        section="forward", values={"kmin": 2, "kweight": 1.5, "rbkg": 2, "energy_shift": 8})
    assert p["groups"][0] == before["groups"][0]
    actual = p["groups"][1]["parameters"]
    assert actual["kmin"] == 2 and actual["kweight"] == 1.5
    assert actual["rbkg"] == before["groups"][1]["parameters"]["rbkg"]
    assert actual["energy_shift"] == 0
    assert actual["bkg_kweight"] == 2


def test_individual_parameter_copy_and_reset_are_independent(workspace):
    store, p = workspace
    p = run(store, p, "copy_parameters", [1, 2], source_id=p["groups"][0]["id"],
        parameter="bkg_dk", values={"bkg_dk": 2.2, "dk": 3})
    assert p["groups"][1]["parameters"]["bkg_dk"] == 2.2
    assert p["groups"][1]["parameters"]["dk"] == 1
    p = run(store, p, "reset_parameters", [1], parameter="bkg_dk")
    assert p["groups"][1]["parameters"]["bkg_dk"] == AthenaParameters().bkg_dk
    assert p["groups"][2]["parameters"]["bkg_dk"] == 2.2


def test_reset_all_preserves_calibration_and_frozen_group(workspace):
    store, p = workspace
    p = run(store, p, "parameters", [1, 2], energy_shift=3, rbkg=1.4, kweight=3)
    p = run(store, p, "metadata", [2], frozen=True)
    before = deepcopy(p)
    p = run(store, p, "reset_parameters", [1, 2], section="all")
    assert p["groups"][1]["parameters"] == AthenaParameters(energy_shift=3).model_dump()
    assert p["groups"][2] == before["groups"][2]


@pytest.mark.parametrize("options", [{"parameter": "unknown"}, {"section": "unknown"},
    {"section": "all", "values": {"unknown": 1}}])
def test_invalid_copy_selection_does_not_write(workspace, options):
    store, p = workspace
    with pytest.raises(WebInputError):
        run(store, p, "copy_parameters", [1, 2], source_id=p["groups"][0]["id"], **options)
    assert store.load(p["id"]) == p


def test_invalid_scientific_copy_rolls_back_every_target(workspace):
    store, p = workspace
    with pytest.raises(ScientificError):
        run(store, p, "copy_parameters", [0, 2], source_id=p["groups"][1]["id"],
            parameter="e0", values={"e0": 8752})
    assert store.load(p["id"]) == p


def test_single_frozen_edit_rejected_but_mixed_batch_skips(workspace):
    store, p = workspace
    p = run(store, p, "metadata", [1], frozen=True)
    frozen = deepcopy(p["groups"][1])
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, p, "parameters", [1], rbkg=1.5)
    p = run(store, p, "parameters", [0, 1], rbkg=1.5)
    assert p["groups"][0]["parameters"]["rbkg"] == 1.5
    assert p["groups"][1] == frozen


def test_reference_shifts_propagate_both_directions_and_survive_reload(workspace):
    store, p = workspace
    p = run(store, p, "tie_reference", [0, 1])
    for index, shift in ((0, 2.5), (1, -1.25)):
        before = deepcopy(p)
        p = run(store, p, "parameters", [index], energy_shift=shift)
        for tied in (0, 1):
            group = p["groups"][tied]
            assert group["parameters"]["energy_shift"] == shift
            assert group["energy"] == before["groups"][tied]["energy"]
            assert group["mu"] == before["groups"][tied]["mu"]
            np.testing.assert_allclose(group["result"]["arrays"]["energy"], np.asarray(group["energy"]) + shift)
        assert p["groups"][2:] == before["groups"][2:]
        assert AthenaStore(store.settings).load(p["id"]) == p


def test_frozen_reference_blocks_direct_shift_but_global_copy_skips_pair(workspace):
    store, p = workspace
    p = run(store, p, "tie_reference", [0, 1])
    p = run(store, p, "metadata", [1], frozen=True)
    before = deepcopy(p)
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, p, "parameters", [0], energy_shift=2)
    assert store.load(p["id"]) == p
    p = run(store, p, "copy_parameters", [0, 2], source_id=p["groups"][3]["id"],
        parameter="energy_shift", values={"energy_shift": 2})
    assert p["groups"][:2] == before["groups"][:2]
    assert p["groups"][2]["parameters"]["energy_shift"] == 2


def test_reference_calibration_then_alignment_keeps_standard_fixed(workspace):
    store, p = workspace
    p = run(store, p, "tie_reference", [0, 1])
    p = run(store, p, "tie_reference", [2, 3])
    p = run(store, p, "calibrate", [1], observed=8980, target=8982)
    assert [g["parameters"]["energy_shift"] for g in p["groups"][:2]] == [2, 2]
    standard = deepcopy(p["groups"][:2])
    p = run(store, p, "align", [0, 1, 2, 3], reference_id=p["groups"][0]["id"], use_reference=True)
    assert p["groups"][:2] == standard
    for g in p["groups"][2:]:
        assert g["parameters"]["energy_shift"] == pytest.approx(-2.2, abs=.005)
        np.testing.assert_allclose(g["result"]["arrays"]["energy"], standard[0]["result"]["arrays"]["energy"], atol=.005)


def test_alignment_skips_frozen_reference_family_and_aligns_remaining(workspace):
    store, p = workspace
    p = run(store, p, "metadata", [2], frozen=True)
    frozen = deepcopy(p["groups"][2])
    p = run(store, p, "align", [2, 3], reference_id=p["groups"][0]["id"])
    assert p["groups"][2] == frozen
    assert p["groups"][3]["parameters"]["energy_shift"] == pytest.approx(-4.2, abs=.005)


def test_retying_untying_and_undo_do_not_leave_dangling_links(workspace):
    store, p = workspace
    p = run(store, p, "tie_reference", [0, 1])
    old = deepcopy(p)
    p = run(store, p, "tie_reference", [0, 2])
    assert p["groups"][0]["reference_id"] == p["groups"][2]["id"]
    assert p["groups"][1]["reference_id"] is None
    p = run(store, p, "undo", [])
    assert p["groups"] == old["groups"]
    p = run(store, p, "untie_reference", [1])
    p = run(store, p, "parameters", [1], energy_shift=2)
    assert p["groups"][0]["parameters"]["energy_shift"] == 0


def test_duplicate_and_copy_series_detach_reference_links(workspace):
    store, p = workspace
    p = run(store, p, "tie_reference", [0, 1])
    p = run(store, p, "duplicate", [0])
    p = run(store, p, "copy_series", [0], parameter="energy_shift", start=1, stop=2, count=2)
    assert all(g["reference_id"] is None for g in p["groups"][4:])
    p = run(store, p, "parameters", [0], energy_shift=3)
    assert [g["parameters"]["energy_shift"] for g in p["groups"][4:]] == [0, 1, 2]


def test_reading_frozen_groups_for_merge_does_not_edit_sources(workspace):
    store, p = workspace
    p = run(store, p, "metadata", [0, 1], frozen=True)
    before = deepcopy(p["groups"])
    p = run(store, p, "merge", [0, 1])
    assert p["groups"][:4] == before
    np.testing.assert_allclose(p["groups"][-1]["mu"], before[0]["mu"])


def test_weighted_normalized_merge_uses_processed_signals_and_preserves_sources(workspace):
    store, p = workspace
    before = deepcopy(p["groups"])
    p = run(store, p, "merge", [0, 2], array="norm", weights=[1, 3])
    merged = p["groups"][-1]
    assert p["groups"][:4] == before
    assert merged["data_type"] == "norm"
    x = np.asarray(merged["energy"])
    values = [np.interp(x, g["result"]["arrays"]["energy"], g["result"]["arrays"]["norm"]) for g in (before[0], before[2])]
    expected = .25 * values[0] + .75 * values[1]
    np.testing.assert_allclose(merged["mu"], expected)
    np.testing.assert_allclose(merged["source"]["stddev"], np.sqrt(.25*(values[0]-expected)**2 + .75*(values[1]-expected)**2), atol=1e-14)
    assert merged["source"]["coefficients"] == [.25, .75]
    assert merged["source"]["weights"] == [1, 3]
    assert merged["processing_error"] is None


def test_signed_sum_uses_coefficients_without_normalizing_them(workspace):
    store, p = workspace
    original = deepcopy(p["groups"])
    p = run(store, p, "sum", [0, 1], array="mu", weights=[3, -1])
    summed = p["groups"][-1]
    np.testing.assert_allclose(summed["mu"], 2*np.asarray(original[0]["mu"]))
    assert summed["source"]["coefficients"] == [3, -1]
    assert "stddev" not in summed["source"]
    assert p["groups"][:4] == original


def test_zero_sum_keeps_exact_raw_data_with_explicit_processing_error(workspace):
    store, p = workspace
    p = run(store, p, "sum", [0, 1], array="mu", weights=[1, -1])
    summed = p["groups"][-1]
    np.testing.assert_allclose(summed["mu"], 0)
    assert summed["processing_error"]
    assert summed["result"] is None


def test_chi_merge_uses_computed_k_grid_and_never_adds_energy_shift_to_k(workspace):
    store, p = workspace
    p = run(store, p, "parameters", [0, 1], energy_shift=3)
    before = deepcopy(p["groups"])
    p = run(store, p, "merge", [0, 1], array="chi", weights=[2, 1])
    merged = p["groups"][-1]
    assert merged["data_type"] == "chi"
    np.testing.assert_allclose(merged["energy"], before[0]["result"]["arrays"]["k"])
    np.testing.assert_allclose(merged["mu"], before[0]["result"]["arrays"]["chi"])
    assert merged["parameters"]["energy_shift"] == 0
    assert merged["result"]["arrays"]["chir_mag"]


@pytest.mark.parametrize("weights", [[1], [1, -1], [0, 0], [True, 2]])
def test_bad_merge_weights_do_not_write_a_derived_group(workspace, weights):
    store, p = workspace
    with pytest.raises(ScientificError):
        run(store, p, "merge", [0, 1], weights=weights)
    assert store.load(p["id"]) == p


def test_combination_explicit_uncertainties_are_not_confused_with_scatter(workspace):
    store, p = workspace
    p = run(store, p, "merge", [0, 1], array="mu", weights=[1, 1], uncertainties=[.1, .2])
    source = p["groups"][-1]["source"]
    np.testing.assert_allclose(source["stddev"], 0)
    np.testing.assert_allclose(source["uncertainty"], np.sqrt(.1**2+.2**2)/2)


@pytest.mark.parametrize("field", ["marked", "frozen"])
@pytest.mark.parametrize("mode", ["all", "none", "invert"])
def test_selection_changes_only_target_flags_and_is_undoable(workspace, field, mode):
    store, p = workspace
    p = run(store, p, "metadata", [1], marked=False, frozen=True)
    before = deepcopy(p)
    p = run(store, p, "selection", [0, 1], field=field, mode=mode)
    for index, group in enumerate(p["groups"]):
        expected = deepcopy(before["groups"][index])
        if index in (0, 1):
            expected[field] = not expected[field] if mode == "invert" else mode == "all"
        assert group == expected
    p = run(store, p, "undo", [])
    assert p["groups"] == before["groups"]


@pytest.mark.parametrize("options", [{"field": "parameters"}, {"mode": "pattern"}])
def test_invalid_selection_does_not_change_project(workspace, options):
    store, p = workspace
    with pytest.raises(WebInputError):
        run(store, p, "selection", [0, 1], **options)
    assert store.load(p["id"]) == p
