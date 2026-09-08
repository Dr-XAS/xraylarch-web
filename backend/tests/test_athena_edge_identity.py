"""Identity-only editing through the real store, persistence and Larch readers.

Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406 Main.pm: bkg_z/fft_edge
are group controls (line 146); mode freezes them (635) but leaves them enabled
for chi (668). OnAbsorber/OnEdge (922/928) only assign metadata and mark the
project modified. Real measured/synthetic calculations establish the fixtures.
Processing monkeypatches are tripwires for forbidden recalculation, never
substitutes for a numerical result or an identity lookup.
"""

from copy import deepcopy
import gzip
from io import StringIO
import json
from pathlib import Path

from larch.io import read_athena
import numpy as np
import pytest
from pydantic import ValidationError

import xraylarch_web.athena as athena
from xraylarch_web.athena import AthenaStore, Command, ImportRequest, RestoreUploadRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


EXAMPLES = Path(__file__).parents[2] / "examples" / "xafsdata"
TYPES = ("mu", "xanes", "norm", "chi", "difference", "failed")
SELECTED = {"element": "Fe", "edge": "L3", "origin": "selected"}


def run(store, project, action, ids=(), **options):
    return store.command(project["id"], Command(
        version=project["version"], action=action, group_ids=list(ids), options=options))


def get(project, ident):
    return next(group for group in project["groups"] if group["id"] == ident)


def forbid_processing(monkeypatch, store):
    def forbidden(*args, **kwargs):
        pytest.fail("Saving edge identity must not call scientific processing")
    monkeypatch.setattr(store, "process", forbidden)
    monkeypatch.setattr(athena, "process_spectrum", forbidden)


def files(store, project):
    root = store.storage.workspace_dir(project["id"])
    return {path.name: path.read_bytes() for path in root.glob("*.json")
            if not path.name.startswith(("upload-", "project-upload-"))}


def assert_saved(store, project):
    assert AthenaStore(store.settings).load(project["id"]) == project
    json.dumps(project, allow_nan=False)


def assert_identity_only(before, after, identity=SELECTED):
    expected = deepcopy(before)
    expected["source"]["edge_identity"] = identity
    if expected.get("result"):
        expected["result"]["effective"].update({key: identity[key] for key in ("element", "edge")})
    # Compare every existing field, permitting independent schema additions
    # such as the persistent is_difference flag during old-project migration.
    for key, value in expected.items():
        assert after[key] == value, key


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture(scope="module")
def templates(tmp_path_factory):
    """Compute once; each test persists fresh copies in its own real store."""
    oracle = AthenaStore(Settings(data_root=tmp_path_factory.mktemp("identity-spectra")))
    data = np.loadtxt(EXAMPLES / "cu_rt01.xmu")
    x, y = data[:, 0], data[:, 1]
    parameters = {"e0": 8982.5, "energy_shift": 2.5, "bkg_kmax": 9, "kmax": 8}
    mu = oracle.make_group("Measured copper", x, y, parameters=parameters)
    groups = {"mu": mu,
              "xanes": oracle.make_group("Measured XANES", x, y, parameters=parameters, data_type="xanes"),
              "norm": oracle.make_group("Normalized copper", x, mu["result"]["arrays"]["norm"],
                                         parameters=parameters, data_type="norm")}
    k = np.arange(0, 12.0001, .05)
    groups["chi"] = oracle.make_group("Synthetic shell", k, .03 * np.sin(4.6 * k) * np.exp(-.1 * k),
                                      data_type="chi", parameters=parameters | {"energy_shift": 0})
    other = oracle.make_group("Perturbed copper", x, y + .002 * np.sin((x - 8980) / 8), parameters=parameters)
    initial = oracle.create()
    prepared = deepcopy(initial)
    prepared["groups"] = [deepcopy(mu), other]
    prepared = oracle.save(prepared, initial, "Measured and perturbed copper")
    difference = run(oracle, prepared, "difference", [g["id"] for g in prepared["groups"]])["groups"][-1]
    groups["difference"] = difference
    for kind, group in groups.items():
        assert group["result"] and group["processing_error"] is None, (kind, group["processing_error"])
    groups["failed"] = oracle.make_group("Constant raw scan", np.linspace(8750, 9350, 101), np.ones(101))
    assert groups["failed"]["result"] is None and groups["failed"]["processing_error"]
    return groups


def seed(store, templates, names=("mu",)):
    initial = store.create()
    project = deepcopy(initial)
    project["groups"] = [deepcopy(templates[name]) for name in names]
    return store.save(project, initial, "Identity test spectra")


def import_mu(store, project, x, y, **options):
    text = StringIO()
    np.savetxt(text, np.column_stack((x, y)), header="energy mu", fmt="%.17g")
    inspected = store.inspect(project["id"], text.getvalue().encode(), "scan.dat")
    columns = {col["name"]: col["column_id"] for col in inspected["columns"]}
    return store.import_data(project["id"], ImportRequest(
        version=project["version"], upload_id=inspected["upload_id"],
        energy_column=columns["energy"], numerator=[columns["mu"]], **options))


@pytest.mark.parametrize("kind", TYPES)
def test_identity_save_is_metadata_only_for_every_unfrozen_type(store, templates, monkeypatch, kind):
    before = seed(store, templates, [kind])
    original = before["groups"][0]
    forbid_processing(monkeypatch, store)
    after = run(store, before, "edge_identity", [original["id"]], element="fe", edge="l3")
    assert_identity_only(original, after["groups"][0])
    assert after["version"] == before["version"] + 1
    assert after["last_operation"]["action"] == "edge_identity"
    assert after["last_operation"]["skipped_group_ids"] == []
    assert_saved(store, after)


@pytest.mark.parametrize("element,edge,canonical", [
    (" cu ", "k", ("Cu", "K")), ("pt", "l2", ("Pt", "L2")), ("FE", "L3", ("Fe", "L3")),
])
def test_pair_is_canonicalized_without_requiring_coverage_or_changing_e0(store, templates, monkeypatch, element, edge, canonical):
    before = seed(store, templates)
    forbid_processing(monkeypatch, store)
    after = run(store, before, "edge_identity", [before["groups"][0]["id"]], element=element, edge=edge)
    identity = {"element": canonical[0], "edge": canonical[1], "origin": "selected"}
    assert_identity_only(before["groups"][0], after["groups"][0], identity)


def test_batch_updates_only_selected_groups_and_never_processes(store, templates, monkeypatch):
    before = seed(store, templates, TYPES)
    chosen = [g["id"] for g in before["groups"][:-1]]
    forbid_processing(monkeypatch, store)
    after = run(store, before, "edge_identity", chosen, element="Fe", edge="L3")
    for original, changed in zip(before["groups"][:-1], after["groups"][:-1], strict=True):
        assert_identity_only(original, changed)
    assert after["groups"][-1] == before["groups"][-1]
    assert_saved(store, after)


@pytest.mark.parametrize("options", [
    {}, {"element": "Cu"}, {"edge": "K"},
    {"element": "Cu", "edge": None}, {"element": None, "edge": "K"},
    {"element": "", "edge": "K"}, {"element": "Cu", "edge": ""},
    {"element": 29, "edge": "K"}, {"element": True, "edge": "K"},
    {"element": "Cu", "edge": 1}, {"element": "Cu", "edge": True},
    {"element": "Xx", "edge": "K"}, {"element": "Cu", "edge": "L9"},
    {"element": "H", "edge": "L3"},
    {"element": "Fe", "edge": "K", "fraction": .5},
    {"element": "Fe", "edge": "K", "e0": 7112},
    {"element": "Fe", "edge": "K", "energy_shift": 2},
    {"element": "Fe", "edge": "K", "method": "atomic"},
    {"element": "Fe", "edge": "K", "origin": "enforced"},
])
def test_invalid_pairs_types_and_unknown_options_reject_atomically(store, templates, monkeypatch, options):
    before = seed(store, templates)
    disk = files(store, before)
    forbid_processing(monkeypatch, store)
    with pytest.raises((ValidationError, WebInputError, ValueError)):
        run(store, before, "edge_identity", [before["groups"][0]["id"]], **options)
    assert files(store, before) == disk
    assert_saved(store, before)


@pytest.mark.parametrize("kind", TYPES)
def test_frozen_group_rejects_identity_without_any_saved_changes(store, templates, monkeypatch, kind):
    before = seed(store, templates, [kind])
    ident = before["groups"][0]["id"]
    before = run(store, before, "metadata", [ident], frozen=True)
    disk = files(store, before)
    forbid_processing(monkeypatch, store)
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, before, "edge_identity", [ident], element="Fe", edge="L3")
    assert files(store, before) == disk
    assert_saved(store, before)


@pytest.mark.parametrize("reverse", [False, True])
def test_mixed_frozen_batch_rejects_atomically_in_either_order(store, templates, monkeypatch, reverse):
    before = seed(store, templates, ["mu", "chi"])
    ids = [g["id"] for g in before["groups"]]
    before = run(store, before, "metadata", [ids[1]], frozen=True)
    disk = files(store, before)
    forbid_processing(monkeypatch, store)
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, before, "edge_identity", ids[::-1] if reverse else ids, element="Fe", edge="L3")
    assert files(store, before) == disk
    assert_saved(store, before)


def test_identity_does_not_touch_frozen_dependents_reference_links_or_analysis_numbers(store, xas_arrays, monkeypatch):
    x, y = xas_arrays
    initial = store.create()
    prepared = deepcopy(initial)
    for label, kmax in (("standard", 9), ("consumer", 8), ("leaf", 7), ("reference", 8)):
        prepared["groups"].append(store.make_group(label, x, y, parameters={
            "e0": 8982.5, "energy_shift": 2.5, "bkg_kmax": kmax, "kmax": kmax}))
    before = store.save(prepared, initial, "Background chain and reference")
    ids = [g["id"] for g in before["groups"]]
    before = run(store, before, "background_standard", [ids[1]], standard_id=ids[0])
    before = run(store, before, "background_standard", [ids[2]], standard_id=ids[1])
    before = run(store, before, "tie_reference", [ids[0], ids[3]])
    store.analyze(before["id"], Command(version=before["version"], action="pca", group_ids=ids[:2],
                                       options={"array": "norm", "xmin": 8950, "xmax": 9100}))
    before = store.load(before["id"])
    assert before["analyses"][0]["result"]
    before = run(store, before, "metadata", ids[1:], frozen=True)
    forbid_processing(monkeypatch, store)
    after = run(store, before, "edge_identity", [ids[0]], element="Fe", edge="L3")
    assert_identity_only(before["groups"][0], after["groups"][0])
    assert after["groups"][1:] == before["groups"][1:]
    assert after["analyses"] == before["analyses"]
    assert_saved(store, after)


def test_undo_redo_restores_identity_and_numerics_without_reprocessing(store, templates, monkeypatch):
    before = seed(store, templates, ["mu", "chi", "difference", "failed"])
    forbid_processing(monkeypatch, store)
    selected = run(store, before, "edge_identity", [g["id"] for g in before["groups"]], element="Fe", edge="L3")
    undone = run(store, selected, "undo")
    assert undone["groups"] == before["groups"]
    redone = run(store, undone, "redo")
    assert redone["groups"] == selected["groups"]
    assert [p["version"] for p in (before, selected, undone, redone)] == list(range(before["version"], before["version"] + 4))
    assert_saved(store, redone)


@pytest.mark.parametrize("kind", ["mu", "xanes", "norm", "chi", "difference"])
@pytest.mark.parametrize("format", ["json", "prj"])
def test_selected_identity_survives_preview_restore_and_recalculation(store, templates, monkeypatch, kind, format):
    before = seed(store, templates, [kind])
    with monkeypatch.context() as guard:
        forbid_processing(guard, store)
        selected = run(store, before, "edge_identity", [before["groups"][0]["id"]], element="Fe", edge="L3")
    saved = selected["groups"][0]
    payload = store.export_project(selected["id"], format)
    target = store.create()
    preview = store.preview_project(target["id"], payload, "identity." + format)
    assert_saved(store, target)
    mode = "chi" if kind == "chi" else "mu"
    curve = store.preview_project_group(target["id"], preview["upload_id"], saved["id"], mode)
    x = np.asarray(saved["energy"]) + (0 if kind == "chi" else saved["parameters"]["energy_shift"])
    indices = np.linspace(0, len(x) - 1, min(800, len(x)), dtype=int)
    np.testing.assert_array_equal(curve["x"], x[indices])
    np.testing.assert_array_equal(curve["y"], np.asarray(saved["mu"])[indices])
    assert_saved(store, target)
    restored = store.restore_upload(target["id"], RestoreUploadRequest(
        version=target["version"], upload_id=preview["upload_id"]))
    added = restored["groups"][0]
    assert added["id"] != saved["id"]
    for key in ("parameters", "energy", "mu", "source", "data_type", "processing_error", "result"):
        assert added[key] == saved[key], key
    assert added["source"]["edge_identity"] == SELECTED
    assert_saved(store, restored)


def test_native_reader_sees_selected_pair_but_old_e0_fraction_and_arrays(store, templates, monkeypatch, tmp_path):
    measured = templates["mu"]
    before = import_mu(store, store.create(), measured["energy"], measured["mu"],
                       edge_policy={"element": "Cu", "edge": "K", "fraction": .65})
    original = before["groups"][0]
    with monkeypatch.context() as guard:
        forbid_processing(guard, store)
        after = run(store, before, "edge_identity", [original["id"]], element="Fe", edge="L3")
    assert_identity_only(original, after["groups"][0])
    path = tmp_path / "selected.prj"
    payload = store.export_project(after["id"], "prj")
    path.write_bytes(payload)
    independent = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    read = independent.groups[original["id"]]
    assert read.athena_params.bkg.z == "Fe"
    assert read.athena_params.fft.edge.upper() == "L3"
    assert read.athena_params.bkg.e0 == original["parameters"]["e0"]
    assert read.athena_params.bkg.e0_fraction == .65
    np.testing.assert_array_equal(read.energy, original["energy"])
    np.testing.assert_array_equal(read.mu, original["mu"])
    # Independent native arguments must suffice even without the web sidecar.
    text = gzip.decompress(payload).decode()
    native_only = gzip.compress('\n'.join(line for line in text.splitlines()
        if not line.startswith('# Athena-Web ')).encode())
    destination = store.create()
    restored = store.restore(destination["id"], 0, native_only, "native-only.prj")
    group = restored["groups"][0]
    assert group["source"]["edge_identity"] == {**SELECTED, "origin": "native"}
    assert group["source"]["native"]["args"]["bkg_z"] == "Fe"
    assert group["source"]["native"]["args"]["fft_edge"] == "L3"
    assert group["parameters"]["e0"] == original["parameters"]["e0"]


def test_historical_import_policy_and_fraction_are_inert_after_identity_selection(store, templates, monkeypatch):
    measured = templates["mu"]
    before = import_mu(store, store.create(), measured["energy"], measured["mu"],
                       edge_policy={"element": "Cu", "edge": "K", "fraction": .65})
    original = before["groups"][0]
    with monkeypatch.context() as guard:
        forbid_processing(guard, store)
        selected = run(store, before, "edge_identity", [original["id"]], element="Fe", edge="L3")
    assert_identity_only(original, selected["groups"][0])
    assert selected["groups"][0]["source"]["edge_policy"] == {"element": "Cu", "edge": "K", "fraction": .65}
    assert selected["groups"][0]["source"]["e0_fraction"] == .65
    # A later ordinary Cu import neither follows Fe L3 nor reuses fraction .65.
    imported = import_mu(store, selected, measured["energy"], measured["mu"])
    assert imported["groups"][0] == selected["groups"][0]
    newest = imported["groups"][-1]
    assert newest["source"]["edge_identity"] == {"element": "Cu", "edge": "K", "origin": "inferred"}
    assert newest["parameters"]["e0"] is None
    assert "edge_policy" not in newest["source"] and "e0_fraction" not in newest["source"]
    assert_saved(store, imported)


def test_legacy_missing_identity_uses_cached_e0_without_processing_or_guessing_for_ineligible_data(store, templates, monkeypatch):
    legacy = seed(store, templates, ["mu", "chi", "difference", "failed"])
    for group in legacy["groups"]:
        group["source"].pop("edge_identity", None)
        if group.get("result"):
            for key in ("element", "edge"):
                group["result"]["effective"].pop(key, None)
    store.storage.write_json(legacy["id"], "project.json", legacy)
    forbid_processing(monkeypatch, store)
    before = store.load(legacy["id"])
    assert_identity_only(legacy["groups"][0], before["groups"][0],
                         {"element": "Cu", "edge": "K", "origin": "inferred"})
    assert before["groups"][1:] == legacy["groups"][1:]
    assert all(not g["source"].get("edge_identity") for g in before["groups"][1:])
    after = run(store, before, "edge_identity", [before["groups"][1]["id"]], element="Fe", edge="L3")
    assert after["groups"][0] == before["groups"][0]
    assert_identity_only(before["groups"][1], after["groups"][1])
    assert after["groups"][2:] == before["groups"][2:]
    assert_saved(store, after)


@pytest.mark.parametrize("problem", ["stale", "missing", "empty"])
def test_invalid_target_or_revision_has_no_partial_identity_save(store, templates, monkeypatch, problem):
    before = seed(store, templates)
    ids = [before["groups"][0]["id"]]
    version = before["version"]
    if problem == "missing":
        ids.append("missing-group")
    elif problem == "empty":
        ids = []
    else:
        version -= 1
    disk = files(store, before)
    forbid_processing(monkeypatch, store)
    with pytest.raises(WebInputError):
        store.command(before["id"], Command(version=version, action="edge_identity", group_ids=ids,
                                            options={"element": "Fe", "edge": "L3"}))
    assert files(store, before) == disk
    assert_saved(store, before)
