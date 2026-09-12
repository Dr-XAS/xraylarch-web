"""Live background-standard commands, with real Larch and persisted projects.

References contain processed, unweighted chi(k).  Descending 9/8/7 Å⁻¹
AUTOBK grids keep every consumer inside its standard's measured support.
Expected spectra are recalculated independently of AthenaStore's dependency
walker; no processing or persistence methods are mocked.
"""

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
    energy, mu = xas_arrays
    for label, limit in (("standard", 9), ("consumer", 8), ("leaf", 7), ("other", 8)):
        group = store.make_group(label, energy, mu, parameters={
            "e0": 8980, "bkg_kmax": limit, "kmax": limit,
        })
        assert group["processing_error"] is None
        project["groups"].append(group)
    project = store.save(project, original, "Synthetic background-standard spectra")
    ids = {g["label"]: g["id"] for g in project["groups"]}
    return store, project, ids


def run(store, project, action, group_ids=(), **options):
    return store.command(project["id"], Command(
        version=project["version"], action=action, group_ids=list(group_ids), options=options))


def group(project, ident):
    return next(g for g in project["groups"] if g["id"] == ident)


def chi(project, ident):
    return np.asarray(group(project, ident)["result"]["arrays"]["chi"])


def independent(project, ident, *, standard_arrays=None):
    target = group(project, ident)
    standard_id = target["background_standard_id"]
    if standard_id is not None and standard_arrays is None:
        standard_arrays = group(project, standard_id)["result"]["arrays"]
    standard = None if standard_id is None else {
        key: standard_arrays[key] for key in ("k", "chi")}
    return process_spectrum(target["energy"], target["mu"], target["parameters"],
                            target["data_type"], background_standard=standard)


def assert_processed(project, ident, *, standard_arrays=None):
    target = group(project, ident)
    expected = independent(project, ident, standard_arrays=standard_arrays)
    assert target["processing_error"] is None
    assert target["result"]["effective"]["background_standard_id"] == target["background_standard_id"]
    assert target["result"]["effective"]["background_standard"] is (target["background_standard_id"] is not None)
    for key in ("k", "chi", "chir_re", "chir_im", "chiq_re", "chiq_im"):
        np.testing.assert_allclose(target["result"]["arrays"][key], expected["arrays"][key],
                                   rtol=1e-10, atol=1e-12, err_msg=f"{target['label']}: {key}")
    return expected


def assert_changed(before, after):
    assert np.linalg.norm(np.asarray(before) - np.asarray(after)) > 1e-5


def assert_saved(store, project):
    # Compare the entire document, including history/version/undo, not only chi.
    assert AthenaStore(store.settings).load(project["id"]) == project


def attach_chain(store, project, ids):
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    return run(store, project, "background_standard", [ids["leaf"]], standard_id=ids["consumer"])


def test_attach_uses_live_processed_standard_and_persists(workspace):
    store, before, ids = workspace
    project = run(store, before, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    assert_processed(project, ids["consumer"])
    assert_changed(chi(before, ids["consumer"]), chi(project, ids["consumer"]))
    target = group(project, ids["consumer"])
    for key in ("energy", "mu", "parameters"):
        assert target[key] == group(before, ids["consumer"])[key]
    for name in ("standard", "leaf", "other"):
        assert group(project, ids[name]) == group(before, ids[name])
    assert_saved(store, project)


def test_point_removal_refreshes_background_chain_and_preserves_raw_consumers(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    before = deepcopy(project)
    source = group(project, ids['standard'])
    request = Command(version=project['version'], action='deglitch', group_ids=[ids['standard']],
                      options=dict(mode='point', point=source['energy'][300]))
    preview = store.preview_point_edit(project['id'], request)
    assert store.load(project['id']) == before
    after = store.command(project['id'], request)
    standard = assert_processed(after, ids['standard'])
    consumer = assert_processed(after, ids['consumer'], standard_arrays=standard['arrays'])
    assert_processed(after, ids['leaf'], standard_arrays=consumer['arrays'])
    assert group(after, ids['standard'])['energy'] == preview['results'][0]['energy']
    for name in ('consumer', 'leaf'):
        assert group(after, ids[name])['energy'] == group(before, ids[name])['energy']
        assert group(after, ids[name])['mu'] == group(before, ids[name])['mu']
    assert group(after, ids['other']) == group(before, ids['other'])
    assert_saved(store, after)


def test_point_removal_cannot_change_a_frozen_transitive_consumer(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, 'metadata', [ids['leaf']], frozen=True)
    with pytest.raises((ValueError, WebInputError), match='Unfreeze'):
        run(store, project, 'deglitch', [ids['standard']], mode='indices', indices=[300])
    assert store.load(project['id']) == project


@pytest.mark.parametrize('reverse_order', [False, True])
def test_calibration_preview_stages_and_save_refreshes_background_chain(workspace,reverse_order):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    if reverse_order:
        project = run(store, project, 'reorder', ids=list(reversed([g['id'] for g in project['groups']])))
    before = deepcopy(project)
    request = Command(version=project['version'],action='calibrate',group_ids=[ids['standard']],
                      options=dict(coordinate='displayed',observed=8980.7,target=8983.21))
    preview = store.preview_calibration(project['id'],request)
    assert store.load(project['id']) == before
    assert preview['processing_errors'] == {}
    after = store.command(project['id'],request)
    standard = assert_processed(after,ids['standard'])
    consumer = assert_processed(after,ids['consumer'],standard_arrays=standard['arrays'])
    assert_processed(after,ids['leaf'],standard_arrays=consumer['arrays'])
    assert group(after,ids['standard'])['parameters']['energy_shift'] == preview['energy_shift']
    assert [g['id'] for g in after['groups']] == [g['id'] for g in before['groups']]
    for name in ('standard','consumer','leaf'):
        assert_changed(chi(before,ids[name]),chi(after,ids[name]))
        for key in ('energy','mu','source'):
            assert group(after,ids[name])[key] == group(before,ids[name])[key]
    assert group(after,ids['other']) == group(before,ids['other'])
    assert_saved(store,after)


def test_calibration_preview_and_save_protect_a_frozen_transitive_consumer(workspace):
    store, project, ids = workspace
    project = attach_chain(store,project,ids)
    project = run(store,project,'metadata',[ids['leaf']],frozen=True)
    request = Command(version=project['version'],action='calibrate',group_ids=[ids['standard']],
                      options=dict(coordinate='displayed',observed=8980.7,target=8983.21))
    for operation in (store.preview_calibration,store.command):
        with pytest.raises(WebInputError,match='Unfreeze'):operation(project['id'],request)
        assert store.load(project['id']) == project


@pytest.mark.parametrize("reverse_order", [False, True])
def test_source_edit_recomputes_two_hops_topologically(workspace, reverse_order):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    if reverse_order:
        project = run(store, project, "reorder", ids=list(reversed([g["id"] for g in project["groups"]])))
    before = deepcopy(project)
    project = run(store, project, "parameters", [ids["standard"]], step=1.4)
    standard = assert_processed(project, ids["standard"])
    target = assert_processed(project, ids["consumer"], standard_arrays=standard["arrays"])
    assert_processed(project, ids["leaf"], standard_arrays=target["arrays"])
    for name in ("standard", "consumer", "leaf"):
        assert_changed(chi(before, ids[name]), chi(project, ids[name]))
    assert group(project, ids["other"]) == group(before, ids["other"])
    assert [g["id"] for g in project["groups"]] == [g["id"] for g in before["groups"]]
    assert_saved(store, project)


def test_batch_recipes_are_staged_before_dependent_processing(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    before = deepcopy(project)
    project = run(store, project, "parameters", [ids["consumer"], ids["standard"]], step=1.6)
    standard = assert_processed(project, ids["standard"])
    target = assert_processed(project, ids["consumer"], standard_arrays=standard["arrays"])
    assert_processed(project, ids["leaf"], standard_arrays=target["arrays"])
    assert_changed(chi(before, ids["leaf"]), chi(project, ids["leaf"]))


@pytest.mark.parametrize("targets", [("standard",), ("consumer", "standard")])
def test_self_standard_assignment_rolls_back_all_targets(workspace, targets):
    store, project, ids = workspace
    with pytest.raises(WebInputError, match="cycle|same group|own background"):
        run(store, project, "background_standard", [ids[name] for name in targets], standard_id=ids["standard"])
    assert_saved(store, project)


def test_two_hop_cycle_is_rejected_atomically(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    with pytest.raises(WebInputError, match="cycle"):
        run(store, project, "background_standard", [ids["standard"]], standard_id=ids["leaf"])
    assert_saved(store, project)


@pytest.mark.parametrize("standard_id", ["missing-standard", 4, True, ["invalid"]])
def test_invalid_standard_id_is_rejected_without_writing(workspace, standard_id):
    store, project, ids = workspace
    with pytest.raises(WebInputError):
        run(store, project, "background_standard", [ids["consumer"]], standard_id=standard_id)
    assert_saved(store, project)


def test_insufficient_grid_rolls_back_earlier_valid_target(workspace):
    store, project, ids = workspace
    project = run(store, project, "parameters", [ids["standard"]], bkg_kmax=6, kmax=6)
    project = run(store, project, "parameters", [ids["leaf"]], bkg_kmax=5, kmax=5)
    # Leaf would succeed first; the later consumer needs k=8 and must abort all.
    project = run(store, project, "reorder", ids=[ids[n] for n in ("standard", "leaf", "consumer", "other")])
    with pytest.raises(ScientificError, match="full.*grid|bkg_kmax"):
        run(store, project, "background_standard", [ids["leaf"], ids["consumer"]], standard_id=ids["standard"])
    assert_saved(store, project)


def test_source_grid_reduction_cannot_leave_stale_consumers(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    with pytest.raises(ScientificError, match="full.*grid|bkg_kmax"):
        run(store, project, "parameters", [ids["standard"]], bkg_kmax=6, kmax=6)
    assert_saved(store, project)


def test_frozen_second_hop_blocks_direct_source_parameter_edit(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, "metadata", [ids["leaf"]], frozen=True)
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, project, "parameters", [ids["standard"]], step=1.4)
    assert_saved(store, project)


def test_bulk_parameter_edit_skips_source_of_frozen_consumer(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, "metadata", [ids["leaf"]], frozen=True)
    before = deepcopy(project)
    project = run(store, project, "parameters", [ids["standard"], ids["other"]], step=1.4)
    assert project["last_operation"]["skipped_group_ids"] == [ids["standard"]]
    for name in ("standard", "consumer", "leaf"):
        assert group(project, ids[name]) == group(before, ids[name])
    assert group(project, ids["other"])["parameters"]["step"] == 1.4
    assert_processed(project, ids["other"])
    assert_changed(chi(before, ids["other"]), chi(project, ids["other"]))


def test_bulk_background_assignment_skips_frozen_consumer_family(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, "metadata", [ids["leaf"]], frozen=True)
    before = deepcopy(project)
    project = run(store, project, "background_standard", [ids["consumer"], ids["other"]], standard_id=ids["standard"])
    assert project["last_operation"]["skipped_group_ids"] == [ids["consumer"]]
    for name in ("standard", "consumer", "leaf"):
        assert group(project, ids[name]) == group(before, ids[name])
    assert group(project, ids["other"])["background_standard_id"] == ids["standard"]
    assert_processed(project, ids["other"])


def test_detach_recomputes_descendants_and_stops_old_source_updates(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    before = deepcopy(project)
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=None)
    assert group(project, ids["consumer"])["background_standard_id"] is None
    expected = assert_processed(project, ids["consumer"])
    assert_processed(project, ids["leaf"], standard_arrays=expected["arrays"])
    assert_changed(chi(before, ids["consumer"]), chi(project, ids["consumer"]))
    detached = deepcopy(project)
    project = run(store, project, "parameters", [ids["standard"]], step=1.4)
    for name in ("consumer", "leaf"):
        assert group(project, ids[name]) == group(detached, ids[name])


def test_delete_invalidates_two_hops_undo_restores_and_empty_apply_repairs(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    before = deepcopy(project)
    project = run(store, project, "delete", [ids["standard"]])
    assert group(project, ids["consumer"])["background_standard_id"] is None
    assert group(project, ids["leaf"])["background_standard_id"] == ids["consumer"]
    for name in ("consumer", "leaf"):
        target = group(project, ids[name])
        assert target["result"] is None
        assert "removed" in target["processing_error"].lower()
    assert group(project, ids["other"]) == group(before, ids["other"])
    restored = run(store, project, "undo")
    assert restored["groups"] == before["groups"]
    deleted = run(store, restored, "delete", [ids["standard"]])
    repaired = run(store, deleted, "parameters", [ids["consumer"]])
    expected = assert_processed(repaired, ids["consumer"])
    assert_processed(repaired, ids["leaf"], standard_arrays=expected["arrays"])
    assert_changed(chi(before, ids["consumer"]), chi(repaired, ids["consumer"]))
    assert_saved(store, repaired)


def test_copy_series_preserves_live_standard_but_detaches_energy_reference(workspace):
    store, project, ids = workspace
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    project = run(store, project, "tie_reference", [ids["consumer"], ids["other"]])
    before = deepcopy(project)
    project = run(store, project, "copy_series", [ids["consumer"]], parameter="rbkg", start=1.1, stop=1.5, count=2)
    copies = project["groups"][4:]
    assert project["groups"][:4] == before["groups"]
    assert len(copies) == 2
    for copied, radius in zip(copies, (1.1, 1.5)):
        assert copied["background_standard_id"] == ids["standard"]
        assert copied["reference_id"] is None
        assert copied["parameters"]["rbkg"] == radius
        assert copied["source"]["parent"] == ids["consumer"]
        assert_processed(project, copied["id"])
    changed = run(store, project, "parameters", [ids["standard"]], step=1.4)
    for copied in copies:
        assert_processed(changed, copied["id"])
        assert_changed(chi(project, copied["id"]), chi(changed, copied["id"]))


@pytest.mark.parametrize("action,options,linked", [
    ("duplicate", {}, True),
    ("smooth", {"window": 7, "order": 2}, True),
    ("merge", {"array": "mu"}, True),
    ("merge", {"array": "norm"}, True),
    ("sum", {"array": "mu", "weights": [1, 1]}, True),
    ("merge", {"array": "chi"}, False),
    ("difference", {}, False),
])
def test_derived_groups_keep_only_applicable_live_standard_links(workspace, action, options, linked):
    store, project, ids = workspace
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    before = deepcopy(project)
    selected = [ids["consumer"]] if action in ("duplicate", "smooth") else [ids["consumer"], ids["other"]]
    project = run(store, project, action, selected, **options)
    derived = project["groups"][-1]
    assert project["groups"][:4] == before["groups"]
    assert derived["reference_id"] is None
    assert derived["background_standard_id"] == (ids["standard"] if linked else None)
    assert derived["processing_error"] is None
    if linked:
        assert_processed(project, derived["id"])
    changed = run(store, project, "parameters", [ids["standard"]], step=1.4)
    if linked:
        assert_processed(changed, derived["id"])
        assert_changed(chi(project, derived["id"]), chi(changed, derived["id"]))
    else:
        assert group(changed, derived["id"]) == derived


def test_fnorm_command_changes_chi_persists_and_can_be_disabled(workspace):
    store, project, ids = workspace
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    before = deepcopy(project)
    project = run(store, project, "parameters", [ids["consumer"]], fnorm=True)
    target = group(project, ids["consumer"])
    assert target["parameters"]["fnorm"] is True
    assert target["result"]["effective"]["fnorm"] is True
    assert_processed(project, ids["consumer"])
    assert_changed(chi(before, ids["consumer"]), chi(project, ids["consumer"]))
    for key in ("energy", "mu", "norm", "flat", "pre_edge", "post_edge", "bkg"):
        assert target["result"]["arrays"][key] == group(before, ids["consumer"])["result"]["arrays"][key]
    assert_saved(store, project)
    exported = json.loads(store.export_project(project["id"]))
    assert group(exported, ids["consumer"])["parameters"]["fnorm"] is True
    disabled = run(store, project, "parameters", [ids["consumer"]], fnorm=False)
    assert group(disabled, ids["consumer"])["parameters"]["fnorm"] is False
    np.testing.assert_allclose(chi(disabled, ids["consumer"]), chi(before, ids["consumer"]), atol=1e-12)


@pytest.mark.parametrize("value", [None, 0, 1, 0.5, "true", "false", []])
def test_fnorm_command_rejects_non_booleans_atomically(workspace, value):
    store, project, ids = workspace
    with pytest.raises(ValidationError, match="fnorm"):
        run(store, project, "parameters", [ids["consumer"], ids["other"]], fnorm=value)
    assert_saved(store, project)


@pytest.mark.parametrize("selection", [
    {"section": "background"}, {"section": "all"}, {"parameter": "background_standard_id"},
])
def test_copy_standard_link_skips_self_and_frozen_destinations(workspace, selection):
    store, project, ids = workspace
    project = run(store, project, "parameters", [ids["consumer"]],
                  background_standard_id=ids["standard"], rbkg=1.3, kweight=2.5)
    project = run(store, project, "parameters", [ids["other"]], energy_shift=2, kweight=1.5)
    project = run(store, project, "metadata", [ids["leaf"]], frozen=True)
    before = deepcopy(project)
    project = run(store, project, "copy_parameters", [ids["standard"], ids["other"], ids["leaf"]],
                  source_id=ids["consumer"], **selection)
    assert set(project["last_operation"]["skipped_group_ids"]) == {ids["standard"], ids["leaf"]}
    for name in ("standard", "consumer", "leaf"):
        assert group(project, ids[name]) == group(before, ids[name])
    target = group(project, ids["other"])
    assert target["background_standard_id"] == ids["standard"]
    assert "background_standard_id" not in target["parameters"]
    assert target["parameters"]["energy_shift"] == 2
    if "parameter" in selection:
        assert target["parameters"] == group(before, ids["other"])["parameters"]
    else:
        assert target["parameters"]["rbkg"] == 1.3
        assert target["parameters"]["kweight"] == (2.5 if selection["section"] == "all" else 1.5)
    assert_processed(project, ids["other"])
    assert_changed(chi(before, ids["other"]), chi(project, ids["other"]))
    assert_saved(store, project)


@pytest.mark.parametrize("selection", [
    {"section": "background"}, {"section": "all"}, {"parameter": "background_standard_id"},
])
def test_copy_values_standard_override_takes_precedence_over_saved_source_link(workspace, selection):
    store, project, ids = workspace
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    before = deepcopy(project)
    project = run(store, project, "copy_parameters", [ids["leaf"]], source_id=ids["consumer"],
                  values={"background_standard_id": ids["other"]}, **selection)
    assert group(project, ids["leaf"])["background_standard_id"] == ids["other"]
    assert group(project, ids["consumer"]) == group(before, ids["consumer"])
    assert_processed(project, ids["leaf"])
    detached = run(store, project, "copy_parameters", [ids["leaf"]], source_id=ids["consumer"],
                   values={"background_standard_id": None}, **selection)
    assert group(detached, ids["leaf"])["background_standard_id"] is None
    assert_processed(detached, ids["leaf"])


@pytest.mark.parametrize("selection", [
    {"section": "background"}, {"section": "all"}, {"parameter": "background_standard_id"},
])
def test_reset_link_recomputes_consumer_and_descendants(workspace, selection):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, "parameters", [ids["consumer"]], fnorm=True, rbkg=1.3, kweight=2.5)
    before = deepcopy(project)
    project = run(store, project, "reset_parameters", [ids["consumer"]], **selection)
    target = group(project, ids["consumer"])
    assert target["background_standard_id"] is None
    assert "background_standard_id" not in target["parameters"]
    assert group(project, ids["leaf"])["background_standard_id"] == ids["consumer"]
    if "parameter" in selection:
        assert target["parameters"] == group(before, ids["consumer"])["parameters"]
    else:
        assert target["parameters"]["fnorm"] is False
        assert target["parameters"]["rbkg"] == 1
        assert target["parameters"]["kweight"] == (2 if selection["section"] == "all" else 2.5)
    expected = assert_processed(project, ids["consumer"])
    assert_processed(project, ids["leaf"], standard_arrays=expected["arrays"])
    assert_changed(chi(before, ids["leaf"]), chi(project, ids["leaf"]))
    assert_saved(store, project)


@pytest.mark.parametrize("action", ["copy_parameters", "reset_parameters"])
@pytest.mark.parametrize("section", ["normalization", "forward", "reverse", "grid"])
def test_other_parameter_sections_leave_standard_links_unchanged(workspace, action, section):
    store, project, ids = workspace
    project = run(store, project, "background_standard", [ids["consumer"]], standard_id=ids["standard"])
    options = {"source_id": ids["other"], "values": {"background_standard_id": None}} if action == "copy_parameters" else {}
    project = run(store, project, action, [ids["consumer"]], section=section, **options)
    assert group(project, ids["consumer"])["background_standard_id"] == ids["standard"]
    assert_processed(project, ids["consumer"])


@pytest.mark.parametrize("selection", [
    {"section": "background"}, {"section": "all"}, {"parameter": "background_standard_id"},
])
def test_copy_link_cycle_failure_rolls_back_recipes_and_all_targets(workspace, selection):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    with pytest.raises(WebInputError, match="cycle"):
        run(store, project, "copy_parameters", [ids["other"], ids["standard"]], source_id=ids["leaf"],
            values={"rbkg": 1.4}, **selection)
    assert_saved(store, project)


def test_parameter_patch_applies_new_limit_and_standard_together(workspace):
    store, project, ids = workspace
    # This source cannot cover the target's old grid (8), but covers its new
    # grid (6). Resolving the link before staging the new recipe would fail.
    before = deepcopy(project)
    project = run(store, project, "parameters", [ids["consumer"]],
                  bkg_kmax=6, kmax=6, background_standard_id=ids["leaf"])
    target = group(project, ids["consumer"])
    assert target["background_standard_id"] == ids["leaf"]
    assert target["parameters"]["bkg_kmax"] == 6
    assert "background_standard_id" not in target["parameters"]
    assert_processed(project, ids["consumer"])
    assert group(project, ids["leaf"]) == group(before, ids["leaf"])
    assert_saved(store, project)


def test_reset_link_bulk_skips_frozen_dependent_family(workspace):
    store, project, ids = workspace
    project = attach_chain(store, project, ids)
    project = run(store, project, "background_standard", [ids["other"]], standard_id=ids["standard"])
    project = run(store, project, "metadata", [ids["leaf"]], frozen=True)
    before = deepcopy(project)
    project = run(store, project, "reset_parameters", [ids["consumer"], ids["other"]], parameter="background_standard_id")
    assert project["last_operation"]["skipped_group_ids"] == [ids["consumer"]]
    for name in ("standard", "consumer", "leaf"):
        assert group(project, ids[name]) == group(before, ids[name])
    assert group(project, ids["other"])["background_standard_id"] is None
    assert_processed(project, ids["other"])
