"""Real difference-panel preview/save, rollback, k previews and exchange.

Native reference: Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406,
Diff.pm make_group and UI/Athena/Difference.pm make: renormalization sets
is_nor=False independently of xmu/xanes datatype. diff_make.tmpl aliases
arrays; it does not establish historical-origin semantics for is_diff.
Here is_diff/is_difference tests the agreed web processing mode: True for
signed, unnormalized output, False when renormalizing. Origin stays in source.

Interpolation expectations use real Larch interp on the full shifted STANDARD
grid. Integration has an independent constant-difference known answer. k
oracles run process_spectrum directly, outside the store preview. No science
results are mocked; limited tripwires check forbidden processing or simulate
a real concurrent edit between the preview's version checks.
"""

import asyncio
from copy import deepcopy
import gzip
import json
from pathlib import Path

import httpx
from larch.io import read_athena
from larch.math import deriv, interp
import numpy as np
import pytest
from scipy.special import expit

import xraylarch_web.athena as athena
from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_science import process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


FORMS = ("xmu", "norm", "der", "nder", "sec", "nsec")
PREVIEW_KEYS = {"group_id", "label", "energy", "difference", "data", "standard", "form",
                "data_form", "standard_form", "area", "e0", "integration", "warnings",
                "y_label", "area_label", "extrapolated_points", "k", "weighted_chi", "kweight", "k_error", "input_k"}


def run(store, project, action, ids=(), **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
                         group_ids=list(ids), options=options))


def request(project, targets=None, **options):
    return Command(version=project["version"], action="difference",
                   group_ids=list(targets if targets is not None else [g["id"] for g in project["groups"][1:]]),
                   options={"standard_id": project["groups"][0]["id"], **options})


def preview(store, project, targets=None, **options):
    return store.preview_difference(project["id"], request(project, targets, **options))


def save_difference(store, project, targets=None, **options):
    return store.command(project["id"], request(project, targets, **options))


def disk_snapshot(store, project):
    root = store.storage.workspace_dir(project["id"])
    # Acquiring the store's advisory lock may create workspace.lock even for
    # a rejected command. It contains no project, history, upload or science.
    return {str(path.relative_to(root)): (path.stat().st_mtime_ns, path.read_bytes())
            for path in root.rglob("*") if path.is_file() and path.name != "workspace.lock"}


def assert_saved(store, project):
    assert AthenaStore(store.settings).load(project["id"]) == project
    json.dumps(project, allow_nan=False)


def physical(group):
    return np.asarray(group["energy"]) + group["parameters"]["energy_shift"]


def mu_signal(x, e0, amplitude):
    delta = x - e0
    return (.15 + .000025 * delta + amplitude * expit(delta / 2.8)
            * (1 + .025 * np.sin(delta / 7) * np.exp(-np.maximum(delta, 0) / 90)))


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture(scope="module")
def spectra(tmp_path_factory):
    oracle = AthenaStore(Settings(data_root=tmp_path_factory.mktemp("difference-spectra")))
    specifications = [
        ("Standard", np.arange(8700., 9540.1, 1.), 8980., -1.25, .7, 10, 9, False, "Pt", "L3"),
        ("Target A", np.arange(8740.1, 9500.1, .8), 8983., 2.5, 1.4, 9, 8, True, "Cu", "K"),
        ("Target B", np.arange(8770.2, 9470.2, 1.1), 8991.5, -3., 1.1, 8, 7, False, "Fe", "K"),
    ]
    groups = []
    for i, (label, x, e0, shift, amplitude, bkg_max, kmax, flatten, element, edge) in enumerate(specifications):
        y = mu_signal(x, e0, amplitude)
        group = oracle.make_group(label, x - shift, y, parameters={
            "e0": e0, "energy_shift": shift, "pre1": -150, "pre2": -35,
            "norm1": 60 + 10 * i, "norm2": 250 + 10 * i, "nnorm": 2,
            "bkg_kmax": bkg_max, "kmin": 2, "kmax": kmax, "flatten": flatten,
            "kweight": 2.5 if i == 1 else 1.5}, source={
                "filename": label + ".dat", "edge_identity": {"element": element, "edge": edge, "origin": "selected"},
                "e0_fraction": .5 + .1 * i,
                "raw_arrays": {"i0": np.ones(x.size).tolist(), "signal": np.exp(-y).tolist()}})
        assert group["processing_error"] is None, (label, group["processing_error"])
        groups.append(group)
    return groups


def seed(store, spectra):
    old = store.create()
    project = deepcopy(old)
    project["groups"] = deepcopy(spectra)
    return store.save(project, old, "Unequal calibrated scans")


@pytest.fixture
def project(store, spectra):
    return seed(store, spectra)


def curve(group, form):
    """Independent form extraction using stored arrays and Larch derivatives."""
    x = physical(group)
    if form == "norm":
        name = "flat" if group["parameters"]["flatten"] else "norm"
        y = np.asarray(group["result"]["arrays"][name])
    else:
        name = form
        y = np.asarray(group["result"]["arrays"]["norm"] if form in ("nder", "nsec") else group["mu"])
        if form in ("der", "nder", "sec", "nsec"):
            y = deriv(y) / deriv(x)
        if form in ("sec", "nsec"):
            y = deriv(y) / deriv(x)
    return x, y, name


def assert_energy_oracle(result, target, standard, form, multiplier=1., invert=False):
    sx, sy, standard_form = curve(standard, form)
    dx, dy, data_form = curve(target, form)
    expected_data = interp(dx, dy, sx, kind="linear")
    expected_standard = multiplier * sy
    np.testing.assert_array_equal(result["energy"], sx)
    np.testing.assert_allclose(result["data"], expected_data, rtol=1e-13, atol=1e-13)
    np.testing.assert_allclose(result["standard"], expected_standard, rtol=1e-13, atol=1e-13)
    expected = (expected_data - expected_standard) * (-1 if invert else 1)
    np.testing.assert_allclose(result["difference"], expected, rtol=1e-13, atol=1e-13)
    assert result["data_form"] == data_form and result["standard_form"] == standard_form
    outside = int(np.count_nonzero((sx < dx[0]) | (sx > dx[-1])))
    assert result["extrapolated_points"] == outside
    if outside:
        assert any("extrapolat" in message.lower() for message in result["warnings"])
    assert result["e0"] == target["result"]["effective"]["e0"]


@pytest.mark.parametrize("form", FORMS)
def test_readonly_preview_forms_full_standard_grid_and_individual_e0(store, project, form, monkeypatch):
    before = deepcopy(project)
    disk = disk_snapshot(store, project)
    def forbidden(*args, **kwargs):
        pytest.fail("E-space difference preview must use source curves without reprocessing")
    monkeypatch.setattr(athena, "process_spectrum", forbidden)
    shown = preview(store, project, form=form, multiplier=.75, xmin=-17, xmax=26)
    assert shown["version"] == project["version"]
    resolved = shown["options"]
    assert resolved == {"standard_id": project["groups"][0]["id"], "form": form,
        "multiplier": .75, "invert": False, "integrate": True, "xmin": -17., "xmax": 26.,
        "renormalize": form == "xmu", "name_template": "diff %d - %s", "plot_inputs": True, "plot_space": "E"}
    assert len(shown["results"]) == 2
    for result, target in zip(shown["results"], project["groups"][1:], strict=True):
        assert PREVIEW_KEYS <= result.keys()
        assert result["group_id"] == target["id"]
        assert result["label"] == f"diff {target['label']} - Standard"
        assert_energy_oracle(result, target, project["groups"][0], form, .75)
        integration = result["integration"]
        assert integration["lower"] == target["result"]["effective"]["e0"] - 17
        assert integration["upper"] == target["result"]["effective"]["e0"] + 26
        assert 1 <= integration["iterations"] <= 6
        assert np.isfinite(result["area"])
        assert result["y_label"] and result["area_label"]
        assert result["k"] == result["weighted_chi"] == []
        assert result["kweight"] is result["k_error"] is None
        assert result["input_k"] == []
    assert project == before
    assert_saved(store, project)
    assert disk_snapshot(store, project) == disk
    json.dumps(shown, allow_nan=False)


def test_inversion_changes_sign_area_and_name_but_keeps_input_curves(store, project):
    normal = preview(store, project, multiplier=.6, name_template="%d / %s / %f / %m / %n / %x / %a / %%")
    inverted = preview(store, project, multiplier=.6, invert=True,
                       name_template="%d / %s / %f / %m / %n / %x / %a / %%")
    for a, b in zip(normal["results"], inverted["results"], strict=True):
        np.testing.assert_allclose(b["difference"], -np.asarray(a["difference"]), atol=1e-14)
        assert b["area"] == pytest.approx(-a["area"], abs=1e-12)
        assert b["data"] == a["data"] and b["standard"] == a["standard"]
        assert b["label"].startswith("Standard / Target")
        assert f"{b['area']:.5f}" in b["label"] and b["label"].endswith(" / %")


def test_constant_difference_known_integral_on_unequal_calibrated_grids(store, project):
    target, standard = project["groups"][1], project["groups"][0]
    sx, dx = physical(standard), physical(target)
    replacement = store.make_group("Offset standard", sx - standard["parameters"]["energy_shift"],
        interp(dx, np.asarray(target["mu"]), sx) - .2, parameters=standard["parameters"])
    assert replacement["processing_error"] is None
    changed = deepcopy(project)
    changed["groups"][0] = replacement
    changed = store.save(changed, project, "Known constant subtraction")
    result = preview(store, changed, [target["id"]], form="xmu", xmin=-17, xmax=26)["results"][0]
    np.testing.assert_allclose(result["difference"], .2, atol=1e-14)
    assert result["area"] == pytest.approx(.2 * 43, abs=1e-11)
    assert result["integration"]["lower"] == 8983 - 17
    assert result["integration"]["upper"] == 8983 + 26


def test_disabled_integration_and_plot_inputs_do_not_change_scientific_curves(store, project):
    enabled = preview(store, project)
    disabled = preview(store, project, integrate=False, plot_inputs=False, name_template="%d area=%a")
    for a, b in zip(enabled["results"], disabled["results"], strict=True):
        for key in ("energy", "difference", "data", "standard", "e0", "extrapolated_points"):
            assert b[key] == a[key]
        assert b["area"] is b["integration"] is None
        assert b["label"].endswith("area=n/a")


def test_integration_can_warn_outside_target_but_cannot_leave_standard_grid(store, project):
    target = project["groups"][1]
    result = preview(store, project, [target["id"]], xmin=-270, xmax=-250)["results"][0]
    assert result["integration"]["lower"] < physical(target)[0]
    assert np.isfinite(result["area"])
    assert any("integrat" in warning.lower() and "extrapolat" in warning.lower() for warning in result["warnings"])
    disk = disk_snapshot(store, project)
    for xmin, xmax in ((-300, -290), (550, 570)):
        with pytest.raises(WebInputError):
            preview(store, project, [target["id"]], xmin=xmin, xmax=xmax)
    assert disk_snapshot(store, project) == disk


@pytest.mark.parametrize("form", FORMS)
def test_signed_save_creates_fresh_groups_without_edge_processing(store, project, form, monkeypatch):
    shown = preview(store, project, form=form, renormalize=False)
    def forbidden(*args, **kwargs):
        pytest.fail("Signed difference must not enter edge normalization or AUTOBK")
    monkeypatch.setattr(athena, "process_spectrum", forbidden)
    saved = save_difference(store, project, form=form, renormalize=False)
    assert saved["groups"][:3] == project["groups"]
    assert saved["version"] == project["version"] + 1
    assert saved["last_operation"]["skipped_group_ids"] == []
    summaries = saved["last_operation"]["difference_results"]
    for derived, result, target, summary in zip(saved["groups"][3:], shown["results"], project["groups"][1:], summaries, strict=True):
        assert derived["id"] not in {g["id"] for g in project["groups"]}
        assert summary == {"group_id": derived["id"], "source_group_id": target["id"], "label": result["label"], "area": result["area"]}
        assert derived["energy"] == result["energy"] and derived["mu"] == result["difference"]
        assert derived["data_type"] == ("mu" if form == "xmu" else "xanes")
        assert derived["is_difference"] is True
        assert derived["parameters"] == target["parameters"] | {"energy_shift": 0., "fnorm": False, "e0": result["e0"]}
        assert derived["reference_id"] is derived["background_standard_id"] is None
        assert derived["processing_error"] is None
        arrays = derived["result"]["arrays"]
        assert arrays["norm"] == arrays["flat"] == arrays["mu"] == result["difference"]
        assert arrays["k"] == arrays["chi"] == []
        assert derived["result"]["effective"]["e0"] is None
        source = derived["source"]
        assert source["operation"] == "difference" and source["parent"] == target["id"]
        assert source["standard_id"] == project["groups"][0]["id"]
        assert source["parents"] == [target["id"], project["groups"][0]["id"]]
        assert source["edge_identity"] == target["source"]["edge_identity"]
        assert source["e0_fraction"] == target["source"]["e0_fraction"]
        assert source["options"] == shown["options"]
        for key in ("form", "data_form", "standard_form", "area", "integration", "warnings",
                    "extrapolated_points", "y_label", "area_label"):
            assert source[key] == result[key]
        assert "raw_arrays" not in source
    assert_saved(store, saved)


def test_frozen_data_and_standard_are_readable_and_new_group_clears_live_links(store, project):
    ids = [g["id"] for g in project["groups"]]
    # Real linked processing first; frozen metadata/links must then survive.
    linked = run(store, project, "background_standard", [ids[1]], standard_id=ids[0])
    linked = run(store, linked, "tie_reference", [ids[1], ids[2]])
    linked = run(store, linked, "metadata", ids, frozen=True, multiplier=3, offset=100)
    before = deepcopy(linked)
    shown = preview(store, linked, [ids[1]])
    saved = save_difference(store, linked, [ids[1]])
    assert linked == before and saved["groups"][:-1] == before["groups"]
    derived = saved["groups"][-1]
    assert derived["mu"] == shown["results"][0]["difference"]
    assert derived["reference_id"] is derived["background_standard_id"] is None
    assert_saved(store, saved)


@pytest.mark.parametrize("form,renormalize", [("xmu", True), ("norm", True), ("xmu", False), ("norm", False)])
def test_renormalization_mode_matches_independent_larch_processing(store, project, form, renormalize):
    target = project["groups"][1]
    shown = preview(store, project, [target["id"]], form=form, multiplier=.2, renormalize=renormalize)
    result = shown["results"][0]
    saved = save_difference(store, project, [target["id"]], form=form, multiplier=.2, renormalize=renormalize)
    derived = saved["groups"][-1]
    assert derived["is_difference"] is (not renormalize)
    assert derived["data_type"] == ("mu" if form == "xmu" else "xanes")
    assert derived["mu"] == result["difference"]
    if renormalize:
        expected = process_spectrum(result["energy"], result["difference"], derived["parameters"], derived["data_type"])
        assert derived["result"]["arrays"] == expected["arrays"]
        assert derived["result"]["effective"]["e0"] == result["e0"]
        assert not np.allclose(derived["result"]["arrays"]["norm"], result["difference"])
    else:
        assert derived["result"]["arrays"]["norm"] == result["difference"]
    assert_saved(store, saved)


def test_failed_renormalization_of_later_target_rolls_back_whole_save(store, project, monkeypatch):
    standard, target = project["groups"][:2]
    zero_target = store.make_group("Identical to standard", standard["energy"], standard["mu"], parameters=standard["parameters"])
    assert zero_target["processing_error"] is None
    changed = deepcopy(project)
    changed["groups"].append(zero_target)
    changed = store.save(changed, project, "Identical scan for zero difference")
    chosen = [target["id"], zero_target["id"]]
    shown = preview(store, changed, chosen, form="xmu", renormalize=True)
    np.testing.assert_allclose(shown["results"][1]["difference"], 0, atol=1e-14)
    disk = disk_snapshot(store, changed)
    made = []
    original_make = store.make_group
    def real_make(*args, **kwargs):
        group = original_make(*args, **kwargs)
        made.append(group)
        return group
    monkeypatch.setattr(store, "make_group", real_make)
    with pytest.raises(WebInputError, match="(?i)difference|process|constant|normal"):
        save_difference(store, changed, chosen, form="xmu", renormalize=True)
    assert len(made) == 2
    assert made[0]["processing_error"] is None and made[1]["processing_error"]
    assert disk_snapshot(store, changed) == disk
    assert_saved(store, changed)


@pytest.mark.parametrize("renormalize", [False, True])
def test_k_preview_has_direct_larch_oracle_and_leaves_sources_untouched(store, project, renormalize):
    disk = disk_snapshot(store, project)
    shown = preview(store, project, form="norm", multiplier=.2, renormalize=renormalize, plot_space="k")
    for target, result in zip(project["groups"][1:], shown["results"], strict=True):
        parameters = target["parameters"] | {"energy_shift": 0., "e0": result["e0"], "fnorm": False}
        expected = process_spectrum(result["energy"], result["difference"], parameters,
                                    data_type="mu" if renormalize else "norm")
        assert result["k_error"] is None
        np.testing.assert_array_equal(result["k"], expected["arrays"]["k"])
        np.testing.assert_allclose(result["weighted_chi"], expected["arrays"]["weighted_chi"], rtol=1e-12, atol=1e-12)
        assert result["kweight"] == target["parameters"]["kweight"]
    assert_saved(store, project)
    assert disk_snapshot(store, project) == disk


def assert_cached_input(entry, group, role):
    arrays = group["result"]["arrays"]
    assert entry == {"role": role, "group_id": group["id"], "label": group["label"],
                     "k": arrays["k"], "weighted_chi": arrays["weighted_chi"],
                     "kweight": group["result"]["effective"]["kweight"], "error": None}


def test_k_input_curves_keep_saved_grids_weights_and_ignore_all_scaling(store, project):
    decorated = project
    for group, multiplier, offset in zip(project["groups"], (3., -2., .4), (100., -10., 20.), strict=True):
        decorated = run(store, decorated, "metadata", [group["id"]], multiplier=multiplier, offset=offset)
    before = deepcopy(decorated)
    disk = disk_snapshot(store, decorated)
    baseline = preview(store, decorated, multiplier=.2, plot_space="k")
    altered = preview(store, decorated, multiplier=1.4, invert=True, plot_inputs=False, plot_space="k")
    standard = decorated["groups"][0]
    assert len({len(g["result"]["arrays"]["k"]) for g in decorated["groups"]}) == 3
    assert standard["result"]["effective"]["kweight"] == 1.5
    assert decorated["groups"][1]["result"]["effective"]["kweight"] == 2.5
    for target, first, second in zip(decorated["groups"][1:], baseline["results"], altered["results"], strict=True):
        assert len(first["input_k"]) == 2
        assert_cached_input(first["input_k"][0], target, "DATA")
        assert_cached_input(first["input_k"][1], standard, "STANDARD")
        assert first["input_k"] == second["input_k"]
        assert not np.allclose(first["difference"], second["difference"])
    assert decorated == before
    assert_saved(store, decorated)
    assert disk_snapshot(store, decorated) == disk


@pytest.mark.parametrize("role", ["DATA", "STANDARD"])
@pytest.mark.parametrize("failure", ["processing_error", "missing_arrays"])
def test_unusable_original_k_reports_input_error_without_losing_other_curves(store, project, role, failure):
    changed = deepcopy(project)
    index = 1 if role == "DATA" else 0
    original = changed["groups"][index]
    if failure == "processing_error":
        # Real failed EXAFS recipe retains valid raw mu and a saved E0.
        failed = store.make_group(original["label"], original["energy"], original["mu"],
            parameters=original["parameters"] | {"bkg_kmax": 40.}, source=original["source"])
        assert failed["processing_error"] and failed["result"] is None
        changed["groups"][index] = failed
    else:
        # An older/imported report can contain energy arrays but no chi cache.
        original["result"]["arrays"].pop("weighted_chi")
    changed = store.save(changed, project, "Input with unavailable cached chi")
    before = deepcopy(changed)
    disk = disk_snapshot(store, changed)
    energy = preview(store, changed, form="xmu", renormalize=False, multiplier=.2)
    shown = preview(store, changed, form="xmu", renormalize=False, multiplier=.2, plot_space="k")
    for target, e, k in zip(changed["groups"][1:], energy["results"], shown["results"], strict=True):
        assert e["input_k"] == []
        for key in ("energy", "difference", "data", "standard", "area", "integration"):
            assert k[key] == e[key]
        assert len(k["input_k"]) == 2
        for entry, group, expected_role in zip(k["input_k"], (target, changed["groups"][0]), ("DATA", "STANDARD"), strict=True):
            if group["id"] == changed["groups"][index]["id"]:
                assert entry["role"] == expected_role and entry["group_id"] == group["id"]
                assert entry["label"] == group["label"]
                assert entry["k"] == entry["weighted_chi"] == []
                assert entry["kweight"] is None
                assert isinstance(entry["error"], str) and entry["error"].strip()
            else:
                assert_cached_input(entry, group, expected_role)
    assert shown["results"][1]["k_error"] is None
    assert shown["results"][1]["k"] and shown["results"][1]["weighted_chi"]
    assert changed == before
    assert_saved(store, changed)
    assert disk_snapshot(store, changed) == disk
    json.dumps(shown, allow_nan=False)


def test_k_failure_is_per_result_and_keeps_valid_energy_difference(store, project):
    x = np.arange(8900., 9050.1, .5)
    standard = store.make_group("Short XANES standard", x, mu_signal(x, 8980, .7), data_type="xanes",
        parameters={"e0": 8980, "pre1": -65, "pre2": -35, "norm1": 20, "norm2": 55, "nnorm": 1})
    assert standard["processing_error"] is None
    changed = deepcopy(project)
    changed["groups"][0] = standard
    changed = store.save(changed, project, "Short standard")
    second = changed["groups"][2]["id"]
    changed = run(store, changed, "parameters", [second], bkg_kmax=3., kmin=1., kmax=2.8)
    disk = disk_snapshot(store, changed)
    energy = preview(store, changed, multiplier=.2)
    shown = preview(store, changed, multiplier=.2, plot_space="k")
    failed, successful = shown["results"]
    assert failed["k_error"] and failed["k"] == failed["weighted_chi"] == []
    assert failed["kweight"] is None
    assert successful["k_error"] is None and successful["k"]
    for e, k in zip(energy["results"], shown["results"], strict=True):
        for key in ("energy", "difference", "data", "standard", "area", "integration"):
            assert e[key] == k[key]
    assert disk_snapshot(store, changed) == disk
    assert_saved(store, changed)


def test_plot_space_is_inert_for_saved_type_and_scientific_arrays(store, spectra):
    results = []
    for space in ("E", "k"):
        before = seed(store, spectra)
        after = save_difference(store, before, [before["groups"][1]["id"]], plot_space=space)
        results.append(after["groups"][-1])
    a, b = results
    for key in ("energy", "mu", "parameters", "result", "data_type", "is_difference"):
        assert a[key] == b[key]
    assert a["source"]["options"]["plot_space"] == "E"
    assert b["source"]["options"]["plot_space"] == "k"


@pytest.mark.parametrize("invalid", [
    {"standard_id": "missing"}, {"standard_id": ""}, {"form": "chi"}, {"form": "flat"},
    {"multiplier": float("nan")}, {"multiplier": float("inf")}, {"multiplier": True},
    {"invert": 1}, {"integrate": "yes"}, {"renormalize": 1}, {"plot_inputs": 0},
    {"plot_space": "R"}, {"xmin": 5, "xmax": 5}, {"xmin": 20, "xmax": -20},
    {"xmin": float("inf")}, {"form": "norm", "unknown": "must reject"},
])
def test_invalid_options_fail_preview_and_save_without_storage_changes(store, project, invalid):
    disk = disk_snapshot(store, project)
    req = request(project, **invalid)
    for call in (store.preview_difference, store.command):
        with pytest.raises(WebInputError):
            call(project["id"], req)
        assert disk_snapshot(store, project) == disk
        assert_saved(store, project)


@pytest.mark.parametrize("kind", ["empty", "duplicate", "standard", "missing", "missing_standard", "wrong_action", "stale"])
def test_invalid_selection_or_revision_is_atomic(store, project, kind):
    req = request(project)
    if kind == "empty":
        req.group_ids = []
    elif kind == "duplicate":
        req.group_ids = [req.group_ids[0]] * 2
    elif kind == "standard":
        req.group_ids.append(req.options["standard_id"])
    elif kind == "missing":
        req.group_ids.append("missing-group")
    elif kind == "missing_standard":
        req.options = {"form": "norm"}
    elif kind == "wrong_action":
        req.action = "sum"
    else:
        req.version -= 1
    disk = disk_snapshot(store, project)
    calls = (store.preview_difference,) if kind == "wrong_action" else (store.preview_difference, store.command)
    for call in calls:
        with pytest.raises(WebInputError):
            call(project["id"], req)
        assert disk_snapshot(store, project) == disk


def test_save_recomputes_current_curves_and_rejects_old_preview_revision(store, project):
    old_preview = preview(store, project)
    target = project["groups"][1]["id"]
    edited = run(store, project, "parameters", [target], step=1.7)
    with pytest.raises(WebInputError) as stale:
        save_difference(store, project)
    assert stale.value.code == "stale_revision"
    current = preview(store, edited)
    assert not np.allclose(current["results"][0]["difference"], old_preview["results"][0]["difference"])
    saved = save_difference(store, edited)
    assert saved["groups"][:3] == edited["groups"]
    assert saved["groups"][3]["mu"] == current["results"][0]["difference"]


def test_concurrent_edit_invalidates_preview_at_final_version_check(store, project, monkeypatch):
    import xraylarch_web.athena_difference as difference
    calculate = difference.difference_spectrum
    committed = []
    def compute_then_edit(*args, **kwargs):
        result = calculate(*args, **kwargs)
        if not committed:
            committed.append(run(store, project, "metadata", [project["groups"][0]["id"]], notes="Concurrent edit"))
        return result
    monkeypatch.setattr(difference, "difference_spectrum", compute_then_edit)
    with pytest.raises(WebInputError) as error:
        preview(store, project)
    assert error.value.code == "stale_revision"
    assert_saved(store, committed[0])
    assert len(committed[0]["groups"]) == 3


def test_chi_excluded_from_full_panel_but_legacy_difference_still_works(store, project):
    k = np.arange(0, 12.0001, .05)
    initial = deepcopy(project)
    for amplitude in (.03, .01):
        group = store.make_group("Shell", k, amplitude * np.sin(4.6 * k) * np.exp(-.1 * k), data_type="chi")
        assert group["processing_error"] is None
        initial["groups"].append(group)
    prepared = store.save(initial, project, "Legacy chi spectra")
    ids = [g["id"] for g in prepared["groups"][-2:]]
    disk = disk_snapshot(store, prepared)
    for selected, options in (([ids[0]], {}), ([prepared["groups"][1]["id"]], {"standard_id": ids[0]})):
        with pytest.raises(WebInputError):
            preview(store, prepared, selected, **options)
        with pytest.raises(WebInputError):
            save_difference(store, prepared, selected, **options)
    assert disk_snapshot(store, prepared) == disk
    legacy = run(store, prepared, "difference", ids)
    derived = legacy["groups"][-1]
    assert derived["data_type"] == "chi" and derived["is_difference"] is True
    np.testing.assert_allclose(derived["mu"], np.asarray(prepared["groups"][-2]["mu"]) - prepared["groups"][-1]["mu"], atol=1e-14)


@pytest.mark.parametrize("form,renormalize", [("xmu", True), ("xmu", False), ("norm", True), ("norm", False)])
@pytest.mark.parametrize("format", ["json", "prj"])
def test_undo_redo_and_exchange_preserve_processing_mode_not_just_origin(store, project, form, renormalize, format, tmp_path):
    saved = save_difference(store, project, [project["groups"][1]["id"]], form=form,
                            multiplier=.2, renormalize=renormalize)
    derived = saved["groups"][-1]
    undone = run(store, saved, "undo")
    assert undone["groups"] == project["groups"]
    redone = run(store, undone, "redo")
    assert redone["groups"] == saved["groups"]
    payload = store.export_project(redone["id"], format)
    if format == "prj":
        path = tmp_path / "difference.prj"
        path.write_bytes(payload)
        independent = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
        native = independent.groups[derived["id"]].athena_params
        assert int(native.is_diff) == int(not renormalize)
        assert int(native.is_nor) == int(not renormalize)
        assert int(native.is_xanes) == int(form != "xmu")
        assert int(native.is_xmu) == int(form == "xmu")
        assert native.bkg.z == derived["source"]["edge_identity"]["element"]
        text = gzip.decompress(payload).decode()
        sidecar = json.loads(next(line.removeprefix('# Athena-Web ') for line in text.splitlines() if line.startswith('# Athena-Web ')))
        metadata = next(g for g in sidecar["groups"] if g["id"] == derived["id"])
        assert metadata["is_difference"] is (not renormalize)
    target = store.create()
    restored = store.restore(target["id"], 0, payload, "difference." + format)
    actual = restored["groups"][-1]
    for key in ("energy", "mu", "parameters", "data_type", "is_difference", "source", "result", "processing_error"):
        assert actual[key] == derived[key], key
    assert actual["source"]["operation"] == "difference"
    assert actual["is_difference"] is (not renormalize)
    assert_saved(store, restored)


def test_original_pt_project_raw_preview_preserves_native_arrays_and_failed_recipes(store):
    # The pinned demo has bkg_kwindow=kaiser, bkg_dk=0, which currently fails
    # recipe validation. This tests raw preview only, not native preprocessing
    # fidelity, and must continue to work if that separate limitation is fixed.
    path = Path(__file__).parent / "fixtures" / "demeter-diff.prj"
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    empty = store.create()
    imported = store.restore(empty["id"], empty["version"], path.read_bytes(), path.name)
    assert len(imported["groups"]) == len(native.groups) == 21
    for group, original in zip(imported["groups"], native.groups.values(), strict=True):
        assert len(group["energy"]) == 161
        np.testing.assert_array_equal(group["energy"], original.energy)
        np.testing.assert_array_equal(group["mu"], original.mu)
    before = deepcopy(imported)
    disk = disk_snapshot(store, imported)
    shown = preview(store, imported, form="xmu", integrate=False)
    assert len(shown["results"]) == 20
    standard = imported["groups"][0]
    sx = physical(standard)
    for target, result in zip(imported["groups"][1:], shown["results"], strict=True):
        expected = interp(physical(target), np.asarray(target["mu"]), sx, kind="linear")
        np.testing.assert_array_equal(result["energy"], sx)
        np.testing.assert_allclose(result["difference"], expected - standard["mu"], rtol=1e-12, atol=1e-12)
        assert result["area"] is result["integration"] is None
        assert result["k"] == result["weighted_chi"] == []
    assert imported == before
    assert_saved(store, imported)
    assert disk_snapshot(store, imported) == disk


def test_http_preview_save_and_validation_have_same_contract(store, project):
    asyncio.run(http_preview_save_and_validation(store, project))


async def http_preview_save_and_validation(store, project):
    path = f"/api/athena/projects/{project['id']}"
    req = request(project, [project["groups"][1]["id"]], plot_space="k", multiplier=.2)
    disk = disk_snapshot(store, project)
    transport = httpx.ASGITransport(app=create_app(store.settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        shown = await client.post(path + "/difference/preview", json=req.model_dump())
        assert shown.status_code == 200, shown.text
        response = shown.json()
        assert response["version"] == project["version"]
        assert response["results"][0]["k_error"] is None
        assert response["results"][0]["k"]
        assert disk_snapshot(store, project) == disk
        invalid = req.model_dump()
        invalid["group_ids"] = [invalid["options"]["standard_id"]]
        rejected = await client.post(path + "/difference/preview", json=invalid)
        assert rejected.status_code == 400 and rejected.json()["error"]["recovery"]
        assert disk_snapshot(store, project) == disk
        saved = await client.post(path + "/command", json=req.model_dump())
        assert saved.status_code == 200, saved.text
        assert saved.json()["groups"][-1]["mu"] == response["results"][0]["difference"]
        stale = await client.post(path + "/difference/preview", json=req.model_dump())
        assert stale.status_code == 409
        assert (await client.get(path)).json() == saved.json()
