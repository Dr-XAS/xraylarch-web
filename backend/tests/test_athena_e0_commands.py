"""E0 operations across persisted groups, real normalization and dependencies."""
from copy import deepcopy
import json

import numpy as np
import pytest
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_science import ScientificError, process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


@pytest.fixture
def workspace(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    original = store.create()
    project = deepcopy(original)
    x, y = xas_arrays
    for label, shift in (("sample", 3.5), ("reference", 3.5), ("other", 0)):
        group = store.make_group(label, x, y, data_type="xanes",
                                 parameters={"e0": 8980 + shift, "energy_shift": shift})
        assert group["processing_error"] is None
        project["groups"].append(group)
    project["groups"][0]["reference_id"] = project["groups"][1]["id"]
    return store, store.save(project, original, "Edge-selection fixture")


def run(store, project, action="set_e0", ids=None, **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
        group_ids=ids if ids is not None else [g["id"] for g in project["groups"]], options=options))


def assert_saved(store, project):
    assert AthenaStore(store.settings).load(project["id"]) == project


def test_manual_uses_shifted_axis_without_moving_reference(workspace):
    store, before = workspace
    selected = before["groups"][0]["id"]
    after = run(store, before, ids=[selected], method="manual", value=8984.25)
    group = after["groups"][0]
    assert group["parameters"] == before["groups"][0]["parameters"] | {"e0": 8984.25}
    assert group["result"]["effective"]["e0"] == 8984.25
    np.testing.assert_array_equal(group["result"]["arrays"]["energy"],
                                  np.asarray(group["energy"]) + 3.5)
    assert group["reference_id"] == before["groups"][0]["reference_id"]
    assert after["groups"][1:] == before["groups"][1:]
    for field in ("energy", "mu", "marked", "frozen", "notes"):
        assert group[field] == before["groups"][0][field]
    report = after["last_operation"]["e0_results"][0]
    assert (report["group_id"], report["method"], report["e0"]) == (selected, "manual", 8984.25)
    assert group["source"]["e0_selection"]["energy_shift"] == 3.5
    assert_saved(store, after)


def test_batch_finds_each_spectrums_edge_independently(workspace):
    store, before = workspace
    after = run(store, before, method="derivative")
    values = [g["parameters"]["e0"] for g in after["groups"]]
    assert values[0] == pytest.approx(values[2] + 3.5, abs=1e-6)
    assert values[0] == values[1]
    for old, group in zip(before["groups"], after["groups"], strict=True):
        assert group["parameters"]["energy_shift"] == old["parameters"]["energy_shift"]
        assert group["result"]["effective"]["e0"] == group["parameters"]["e0"]
    assert after["last_operation"]["skipped_group_ids"] == []
    assert len(after["last_operation"]["e0_results"]) == 3
    assert_saved(store, after)


@pytest.mark.parametrize("explicit", [False, True])
def test_atomic_value_is_absolute_and_does_not_calibrate_axis(workspace, explicit):
    store, before = workspace
    options = {"element": "Cu", "edge": "K"} if explicit else {}
    after = run(store, before, method="atomic", **options)
    assert [g["parameters"]["e0"] for g in after["groups"]] == [8979.0] * 3
    for old, group in zip(before["groups"], after["groups"], strict=True):
        assert group["parameters"]["energy_shift"] == old["parameters"]["energy_shift"]
        report = group["source"]["e0_selection"]
        assert (report["element"], report["edge"], report["tabulated_e0"]) == ("Cu", "K", 8979.0)
    assert_saved(store, after)


def test_frozen_and_nonabsorption_groups_are_reported_and_untouched(workspace):
    store, before = workspace
    before = run(store, before, action="selection", ids=[before["groups"][0]["id"]], field="frozen", mode="all")
    changed = deepcopy(before)
    changed["groups"][1].update(data_type="chi", processing_error="Deliberately unavailable")
    changed["groups"][2]["source"]["operation"] = "difference"
    before = store.save(changed, before, "Nonabsorption data")
    after = run(store, before, method="manual", value=8980)
    assert after["groups"] == before["groups"]
    assert set(after["last_operation"]["skipped_group_ids"]) == {g["id"] for g in before["groups"]}
    assert len(after["last_operation"]["skipped_reasons"]) == 3
    assert after["last_operation"]["e0_results"] == []
    assert_saved(store, after)


def test_mixed_frozen_selection_applies_only_editable_groups(workspace):
    store, before = workspace
    before = run(store, before, action="selection", ids=[before["groups"][0]["id"]], field="frozen", mode="all")
    after = run(store, before, method="manual", value=8981)
    assert after["groups"][0] == before["groups"][0]
    assert all(g["parameters"]["e0"] == 8981 for g in after["groups"][1:])
    assert after["last_operation"]["skipped_group_ids"] == [before["groups"][0]["id"]]


def test_invalid_later_group_rolls_back_earlier_selection_and_history(workspace):
    store, before = workspace
    changed = deepcopy(before)
    changed["groups"][1]["energy"] = [e + 1000 for e in changed["groups"][1]["energy"]]
    before = store.save(changed, before, "Different energy interval")
    snapshots = set(store.storage.workspace_dir(before["id"]).glob("undo-*.json"))
    with pytest.raises((ScientificError, WebInputError), match="reference|range"):
        run(store, before, method="manual", value=8982)
    assert_saved(store, before)
    assert set(store.storage.workspace_dir(before["id"]).glob("undo-*.json")) == snapshots


@pytest.mark.parametrize("options", [
    {"method": "unknown"}, {"method": "manual"}, {"method": "manual", "value": True},
    {"method": "manual", "value": float("inf")}, {"method": "manual", "value": -1},
    {"method": "fraction", "fraction": 0}, {"method": "fraction", "fraction": 1.1},
    {"method": "fraction", "fraction": True}, {"method": "fraction", "fraction": float("nan")},
    {"method": "atomic", "element": "Cu"}, {"method": "atomic", "edge": "K"},
    {"method": "derivative", "value": 8980}, {"method": "derivative", "fraction": 0.5},
    {"method": "manual", "value": 8980, "seed_e0": 8979},
])
def test_invalid_options_do_not_mutate_project(workspace, options):
    store, before = workspace
    with pytest.raises((ValidationError, ScientificError, WebInputError)):
        run(store, before, **options)
    assert_saved(store, before)


def test_empty_selection_and_stale_revision_cannot_apply(workspace):
    store, before = workspace
    with pytest.raises(WebInputError, match="Select at least"):
        run(store, before, ids=[], method="manual", value=8981)
    after = run(store, before, method="manual", value=8981)
    with pytest.raises(WebInputError, match="another tab"):
        run(store, before, method="manual", value=8982)
    assert_saved(store, after)


def test_selection_undo_redo_and_project_exchange(workspace):
    store, before = workspace
    after = run(store, before, method="manual", value=8982)
    undone = run(store, after, action="undo", ids=[])
    assert undone["groups"] == before["groups"]
    redone = run(store, undone, action="redo", ids=[])
    assert redone["groups"] == after["groups"]
    for format in ("json", "prj"):
        payload = store.export_project(redone["id"], format)
        target = store.create()
        restored = store.restore(target["id"], 0, payload, f"edges.{format}")
        for old, group in zip(redone["groups"], restored["groups"], strict=True):
            assert group["source"]["e0_selection"] == old["source"]["e0_selection"]
            assert group["parameters"]["e0"] == 8982
            assert group["result"]["effective"]["e0"] == 8982
    json.dumps(redone, allow_nan=False)


def test_e0_refreshes_background_consumers_and_respects_frozen_dependents(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    before = store.create()
    changed = deepcopy(before)
    x, y = xas_arrays
    for label, limit in (("standard", 9), ("consumer", 8), ("leaf", 7)):
        g = store.make_group(label, x, y, parameters={"e0": 8980, "bkg_kmax": limit, "kmax": limit})
        assert g["processing_error"] is None
        changed["groups"].append(g)
    before = store.save(changed, before, "Background chain")
    ids = [g["id"] for g in before["groups"]]
    for target, standard in ((ids[1], ids[0]), (ids[2], ids[1])):
        before = run(store, before, action="background_standard", ids=[target], standard_id=standard)
    after = run(store, before, ids=[ids[0]], method="manual", value=8981)
    for i, group in enumerate(after["groups"]):
        standard = None if i == 0 else {key: after["groups"][i-1]["result"]["arrays"][key] for key in ("k", "chi")}
        expected = process_spectrum(group["energy"], group["mu"], group["parameters"], background_standard=standard)
        np.testing.assert_allclose(group["result"]["arrays"]["chi"], expected["arrays"]["chi"], atol=1e-12)
        assert not np.allclose(group["result"]["arrays"]["chi"], before["groups"][i]["result"]["arrays"]["chi"])
    frozen = run(store, after, action="selection", ids=[ids[2]], field="frozen", mode="all")
    skipped = run(store, frozen, ids=[ids[0]], method="manual", value=8982)
    assert skipped["groups"] == frozen["groups"]
    assert skipped["last_operation"]["skipped_group_ids"] == [ids[0]]
    assert_saved(store, skipped)
