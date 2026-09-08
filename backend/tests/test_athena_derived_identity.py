"""Derived signal meaning survives operation history, processing and exchange.

These store regressions use real Larch. Absorber identity is descriptive metadata;
it must neither turn an energy difference into an absorption scan nor suppress
the Fourier transform of a difference already expressed as chi(k).
Energy differences exercise the web's current mode without renormalization;
Athena's additional representation and renormalization choices remain separate.
"""
from copy import deepcopy
import gzip
from io import StringIO
import json

from larch import Group
from larch.io import read_athena
from larch.xafs import xftf
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest, RestoreUploadRequest
from xraylarch_web.athena_operations import transform_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


CU_POLICY = {"element": "Cu", "edge": "K", "fraction": 0.65}
GEOMETRIC_TRANSFORMS = [
    ("smooth", {"window": 7, "order": 2}),
    ("deglitch", {"indices": [600]}),
    ("truncate", {"xmin": 8755, "xmax": 9345}),
    ("rebin", {"e0": 8980, "pre_step": 2, "xanes_step": 0.5, "exafs_kstep": 0.1}),
    ("convolve", {"width": 1}),
    ("dispersive", {"offset": 0, "linear": 1, "quadratic": 0}),
]
CORRECTION_TRANSFORMS = [
    ("deconvolve", {"esigma": 1, "smooth": False}),
    ("self_absorption", {"formula": "Cu", "element": "Cu", "edge": "K", "norm2": 200}),
    ("multi_electron", {"e0": 8980, "shift": 20, "amplitude": 0.01, "width": 2, "edge_step": 1}),
]


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def command(store, project, action, ids=(), **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
        group_ids=list(ids), options=options))


def group(project, ident):
    return next(item for item in project["groups"] if item["id"] == ident)


def import_scan(store, project, x, y, *, data_type="mu", policy=None):
    table = StringIO()
    np.savetxt(table, np.column_stack((x, y, np.linspace(1e6, 2e6, len(x)))),
               header="energy mu i0", fmt="%.17g")
    inspected = store.inspect(project["id"], table.getvalue().encode(), "scan.dat")
    columns = {item["name"]: item["column_id"] for item in inspected["columns"]}
    return store.import_data(project["id"], ImportRequest(version=project["version"],
        upload_id=inspected["upload_id"], energy_column=columns["energy"],
        numerator=[columns["mu"]], data_type=data_type, edge_policy=policy))


@pytest.fixture
def absorption(store, xas_arrays):
    project = import_scan(store, store.create(), *xas_arrays, policy=CU_POLICY)
    # Keep the saved recipe inside the smaller grids produced by truncation.
    return command(store, project, "parameters", [project["groups"][0]["id"]],
                   bkg_kmax=8, kmax=7, norm2=200)


def difference_project(store, arrays, *, zero=False, data_type="mu"):
    x, y = arrays
    project = import_scan(store, store.create(), x, y, data_type=data_type)
    project = import_scan(store, project, x, y if zero else 1.1 * y, data_type=data_type)
    return command(store, project, "difference", [item["id"] for item in project["groups"]])


def assert_signed(group, expected=None):
    assert group["is_difference"] is True
    assert group["processing_error"] is None, group["processing_error"]
    result = group["result"]
    assert result["effective"]["e0"] is None
    assert result["effective"]["edge_step"] is None
    assert result["effective"]["exafs"] is False
    arrays = result["arrays"]
    for name in ("mu", "norm", "flat"):
        np.testing.assert_array_equal(arrays[name], group["mu"])
    if expected is not None:
        np.testing.assert_allclose(group["mu"], expected, atol=2e-15, rtol=0)
    np.testing.assert_allclose(arrays["energy"],
        np.asarray(group["energy"]) + group["parameters"]["energy_shift"], atol=1e-12)
    for name in ("pre_edge", "post_edge", "bkg", "k", "chi", "r", "chir_mag", "q", "chiq_re"):
        assert arrays[name] == []


def assert_identity(child, parent):
    assert child["source"]["edge_identity"] == parent["source"]["edge_identity"]
    assert child["source"]["e0_fraction"] == 0.65
    assert child["processing_error"] is None, child["processing_error"]
    if not child["is_difference"]:
        assert (child["result"]["effective"]["element"], child["result"]["effective"]["edge"]) == ("Cu", "K")


@pytest.mark.parametrize("zero", [False, True], ids=["negative", "zero"])
def test_series_difference_keeps_its_meaning_after_apply_and_undo_redo(store, xas_arrays, zero):
    before = difference_project(store, xas_arrays, zero=zero)
    parent = before["groups"][-1]
    after = command(store, before, "copy_series", [parent["id"]],
                    parameter="rbkg", start=0.8, stop=1.2, count=2)
    copies = after["groups"][-2:]
    assert after["groups"][:-2] == before["groups"]
    for copy in copies:
        assert copy["source"]["operation"] == "copy_series"
        assert copy["source"]["parent"] == parent["id"]
        assert_signed(copy, parent["mu"])
    assert [copy["parameters"]["rbkg"] for copy in copies] == [0.8, 1.2]
    undone = command(store, after, "undo")
    assert undone["groups"] == before["groups"]
    redone = command(store, undone, "redo")
    assert redone["groups"] == after["groups"]
    applied = command(store, redone, "parameters", [copy["id"] for copy in copies])
    for copy in copies:
        current = group(applied, copy["id"])
        assert_signed(current, parent["mu"])
        assert current["result"] == copy["result"]
    assert AthenaStore(store.settings).load(applied["id"]) == applied


@pytest.mark.parametrize("zero", [False, True], ids=["negative", "zero"])
@pytest.mark.parametrize("action,options", GEOMETRIC_TRANSFORMS, ids=[item[0] for item in GEOMETRIC_TRANSFORMS])
def test_numeric_transform_of_difference_does_not_detect_an_absorption_edge(store, xas_arrays, zero, action, options):
    before = difference_project(store, xas_arrays, zero=zero)
    parent = before["groups"][-1]
    after = command(store, before, action, [parent["id"]], **options)
    child = after["groups"][-1]
    assert after["groups"][:-1] == before["groups"]
    assert child["source"]["operation"] == action
    assert child["source"]["parent"] == parent["id"]
    assert_signed(child)
    if zero:
        np.testing.assert_allclose(child["mu"], 0, atol=1e-15)
    else:
        assert min(child["mu"]) < -0.05
    applied = command(store, after, "parameters", [child["id"]])
    assert_signed(applied["groups"][-1], child["mu"])


@pytest.mark.parametrize("action", ["merge", "sum"])
def test_combining_only_differences_retains_signed_signal_and_numeric_result(store, xas_arrays, action):
    project = difference_project(store, xas_arrays)
    parent = project["groups"][-1]
    project = command(store, project, "duplicate", [parent["id"]])
    duplicate = project["groups"][-1]
    assert_signed(duplicate, parent["mu"])
    after = command(store, project, action, [parent["id"], duplicate["id"]])
    expected = np.asarray(parent["mu"]) * (2 if action == "sum" else 1)
    assert_signed(after["groups"][-1], expected)
    assert after["groups"][-1]["source"]["operation"] == action
    applied = command(store, after, "parameters", [after["groups"][-1]["id"]])
    assert_signed(applied["groups"][-1], expected)


@pytest.mark.parametrize("action,options", GEOMETRIC_TRANSFORMS + CORRECTION_TRANSFORMS,
                         ids=[item[0] for item in GEOMETRIC_TRANSFORMS + CORRECTION_TRANSFORMS])
def test_absorption_transforms_keep_identity_without_claiming_parent_detector_arrays(store, absorption, action, options):
    parent = absorption["groups"][0]
    assert parent["source"]["raw_arrays"]["i0"]
    assert parent["source"]["columns"]
    after = command(store, absorption, action, [parent["id"]], **options)
    child = after["groups"][-1]
    assert after["groups"][0] == parent
    assert child["is_difference"] is False
    assert_identity(child, parent)
    assert child["source"]["operation"] == action
    assert child["source"]["parent"] == parent["id"]
    assert "raw_arrays" not in child["source"] and "columns" not in child["source"]
    # An inherited material identity is not a new import-policy execution.
    for key in ("edge_policy", "import_defaults", "e0_selection"):
        assert key not in child["source"]
    applied = command(store, after, "parameters", [child["id"]])
    assert_identity(applied["groups"][-1], parent)


@pytest.mark.parametrize("action", ["merge", "sum", "difference"])
def test_combinations_keep_primary_absorber_identity_independent_of_difference_flag(store, absorption, action):
    parent = absorption["groups"][0]
    project = command(store, absorption, "duplicate", [parent["id"]])
    after = command(store, project, action, [item["id"] for item in project["groups"]])
    child = after["groups"][-1]
    assert_identity(child, parent)
    assert child["is_difference"] is (action == "difference")
    if action == "difference":
        assert_signed(child, np.zeros(len(child["mu"])))


def test_series_native_export_keeps_identity_fraction_and_latest_recipe(store, absorption, tmp_path):
    parent = absorption["groups"][0]
    # A later manual recipe edit must not be reset by historical enforcement.
    project = command(store, absorption, "parameters", [parent["id"]], e0=parent["parameters"]["e0"] - 3)
    parent = project["groups"][0]
    project = command(store, project, "copy_series", [parent["id"]],
                      parameter="rbkg", start=0.8, stop=1.2, count=2)
    copies = project["groups"][-2:]
    for child in copies:
        assert_identity(child, parent)
        assert child["parameters"]["e0"] == parent["parameters"]["e0"]
    path = tmp_path / "series.prj"
    path.write_bytes(store.export_project(project["id"], "prj", [child["id"] for child in copies]))
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    for child in copies:
        args = native.groups[child["id"]].athena_params
        assert args.is_diff == 0
        assert args.bkg.z == "Cu"
        assert args.fft.edge.upper() == "K"
        assert args.bkg.e0_fraction == 0.65
        assert args.bkg.e0 == parent["parameters"]["e0"]
    applied = command(store, project, "parameters", [child["id"] for child in copies])
    for child in copies:
        assert_identity(group(applied, child["id"]), parent)


def exchange_payload(store, project, ids, format):
    data = store.export_project(project["id"], "json" if format == "json" else "prj", ids)
    if format == "native-only":
        data = gzip.compress("\n".join(line for line in gzip.decompress(data).decode().splitlines()
            if not line.startswith("# Athena-Web ")).encode())
    return data


@pytest.mark.parametrize("format", ["json", "prj", "native-only"])
def test_difference_copy_subset_preview_and_restore_preserve_flag_without_its_parent(store, absorption, format, tmp_path):
    parent = absorption["groups"][0]
    project = command(store, absorption, "duplicate", [parent["id"]])
    project = command(store, project, "difference", [item["id"] for item in project["groups"]])
    difference = project["groups"][-1]
    project = command(store, project, "copy_series", [difference["id"]],
                      parameter="rbkg", start=0.8, stop=1.2, count=2)
    child = project["groups"][-1]
    data = exchange_payload(store, project, [child["id"]], format)
    if format != "json":
        path = tmp_path / "signed.prj"
        path.write_bytes(data)
        native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
        args = native.groups[child["id"]].athena_params
        assert args.is_diff == 1
        assert args.bkg.z == "Cu" and args.fft.edge.upper() == "K"
        assert args.bkg.e0_fraction == 0.65
    target = store.create()
    preview = store.preview_project(target["id"], data, f"signed.{format}")
    assert [record["id"] for record in preview["groups"]] == [child["id"]]
    for mode in ("mu", "norm", "flat", "dmude"):
        curve = store.preview_project_group(target["id"], preview["upload_id"], child["id"], mode)
        assert not curve.get("processing_error"), curve
        assert len(curve["x"]) == len(curve["y"]) == 800
        np.testing.assert_allclose(curve["y"], 0, atol=1e-15)
        assert curve["x"][0] == child["energy"][0]
        assert curve["x"][-1] == child["energy"][-1]
    chi = store.preview_project_group(target["id"], preview["upload_id"], child["id"], "chi")
    assert chi.get("processing_error") and chi["x"] == chi["y"] == []
    assert store.load(target["id"]) == target
    restored = store.restore_upload(target["id"], RestoreUploadRequest(
        version=target["version"], upload_id=preview["upload_id"], group_ids=[child["id"]]))
    assert len(restored["groups"]) == 1
    imported = restored["groups"][0]
    assert imported["id"] != child["id"]
    assert_signed(imported, child["mu"])
    identity = imported["source"]["edge_identity"]
    assert (identity["element"], identity["edge"]) == ("Cu", "K")
    assert imported["source"]["e0_fraction"] == 0.65
    if format != "native-only":
        assert imported["source"]["operation"] == "copy_series"
        assert_identity(imported, parent)
    applied = command(store, restored, "parameters", [imported["id"]])
    assert_signed(applied["groups"][0], child["mu"])


@pytest.mark.parametrize("path", ["load", "web-restore"])
def test_legacy_operation_marker_migrates_before_derivation_and_is_persisted(store, xas_arrays, path):
    project = difference_project(store, xas_arrays, zero=True)
    legacy = deepcopy(project)
    for item in legacy["groups"]:
        item.pop("is_difference", None)
    if path == "load":
        store.storage.write_json(project["id"], "project.json", legacy)
        migrated = AthenaStore(store.settings).load(project["id"])
        assert migrated["version"] == project["version"]
    else:
        target = store.create()
        migrated = store.restore(target["id"], 0, json.dumps(legacy).encode(), "legacy.json")
    assert [item["is_difference"] for item in migrated["groups"]] == [False, False, True]
    derived = command(store, migrated, "smooth", [migrated["groups"][-1]["id"]], window=7, order=2)
    assert_signed(derived["groups"][-1], np.zeros(len(xas_arrays[0])))
    saved = store.storage.read_json(derived["id"], "project.json")
    assert [item["is_difference"] for item in saved["groups"]] == [False, False, True, True]


@pytest.mark.parametrize("action,options", [
    ("deconvolve", {"form": "gaussian", "esigma": 1, "smooth": False}),
    ("deconvolve", {"form": "lorentzian", "esigma": 1, "smooth": False}),
    ("multi_electron", {"e0": 8980, "shift": 20, "amplitude": 0.01, "width": 2, "edge_step": 1}),
    ("multi_electron", {"e0": 8980, "shift": 20, "amplitude": 0, "width": 2, "edge_step": 1}),
], ids=["deconvolve-gaussian", "deconvolve-lorentzian", "specified-MEE", "zero-MEE"])
def test_difference_copy_corrections_match_direct_numeric_transform(store, xas_arrays, action, options):
    project = difference_project(store, xas_arrays)
    project = command(store, project, "copy_series", [project["groups"][-1]["id"]],
                      parameter="rbkg", start=0.8, stop=1.2, count=2)
    parent = project["groups"][-1]
    project = command(store, project, "parameters", [parent["id"]], energy_shift=2)
    parent = group(project, parent["id"])
    x = np.asarray(parent["energy"]) + parent["parameters"]["energy_shift"]
    expected = transform_spectrum(action, x, parent["mu"], options)
    after = command(store, project, action, [parent["id"]], **options)
    child = after["groups"][-1]
    assert after["groups"][:-1] == project["groups"]
    assert child["source"]["operation"] == action
    assert child["source"]["parent"] == parent["id"]
    np.testing.assert_array_equal(child["energy"], expected["energy"])
    assert child["parameters"]["energy_shift"] == 0
    assert_signed(child, expected["mu"])
    if action == "multi_electron":
        secondary = options["amplitude"] * options["edge_step"] * (
            0.5 + np.arctan((x - options["e0"] - options["shift"]) / options["width"]) / np.pi)
        np.testing.assert_allclose(child["mu"], np.asarray(parent["mu"]) - secondary, atol=1e-15)
    applied = command(store, after, "parameters", [child["id"]])
    assert_signed(group(applied, child["id"]), expected["mu"])


@pytest.mark.parametrize("action,options,message", [
    ("deconvolve", {"esigma": 0}, "greater than zero"),
    ("deconvolve", {"xmin": 8740, "xmax": 9200}, "interval inside the measured energy range"),
    ("multi_electron", {"e0": 8980, "shift": 20, "amplitude": -0.01, "width": 2, "edge_step": 1}, "fraction"),
    ("multi_electron", {"e0": 8980, "shift": 1000, "amplitude": 0.01, "width": 2, "edge_step": 1}, "inside the measured range"),
], ids=["deconvolve-width", "deconvolve-range", "MEE-amplitude", "MEE-range"])
def test_invalid_difference_correction_options_leave_project_unchanged(store, xas_arrays, action, options, message):
    project = difference_project(store, xas_arrays)
    with pytest.raises((ValueError, WebInputError), match=message):
        command(store, project, action, [project["groups"][-1]["id"]], **options)
    assert store.load(project["id"]) == project


@pytest.mark.parametrize("action", ["deconvolve", "multi_electron"])
def test_later_numeric_correction_failure_does_not_commit_earlier_batch_output(store, xas_arrays, action):
    project = difference_project(store, xas_arrays, zero=action == "deconvolve")
    if action == "deconvolve":
        # The first scan has a usable endpoint; the zero difference does not.
        options = {"esigma": 1, "smooth": False}
        message = "nonzero normalized post-edge endpoint"
    else:
        # The specified secondary step lies within the first scan but outside
        # the shorter difference's measured interval.
        project = command(store, project, "truncate", [project["groups"][-1]["id"]], xmax=9050)
        options = {"e0": 8980, "shift": 120, "amplitude": 0.01, "width": 2, "edge_step": 1}
        message = "inside the measured range"
    first, last = project["groups"][0], project["groups"][-1]
    input_y = first["result"]["arrays"]["norm"] if action == "deconvolve" else first["mu"]
    assert transform_spectrum(action, first["energy"], input_y, options)["mu"]
    with pytest.raises(ValueError, match=message):
        transform_spectrum(action, last["energy"], last["mu"], options)
    with pytest.raises((ValueError, WebInputError), match=message):
        command(store, project, action, [first["id"], last["id"]], **options)
    assert store.load(project["id"]) == project


@pytest.mark.parametrize("zero", [False, True], ids=["negative-step", "zero-step"])
def test_self_absorption_difference_failure_comes_from_numeric_step_and_is_atomic(store, xas_arrays, zero):
    project = difference_project(store, xas_arrays, zero=zero)
    project = command(store, project, "copy_series", [project["groups"][-1]["id"]],
                      parameter="rbkg", start=0.8, stop=1.2, count=2)
    first, last = project["groups"][0], project["groups"][-1]
    options = {"formula": "Cu", "element": "Cu", "edge": "K", "norm2": 200}
    assert transform_spectrum("self_absorption", first["energy"], first["mu"], options)["mu"]
    message = "positive, resolvable absorption edge step"
    with pytest.raises(ValueError, match=message):
        transform_spectrum("self_absorption", last["energy"], last["mu"], options)
    with pytest.raises((ValueError, WebInputError), match=message):
        command(store, project, "self_absorption", [first["id"], last["id"]], **options)
    assert store.load(project["id"]) == project


def test_difference_copy_retains_e0_and_background_standard_exclusions(store, xas_arrays):
    project = difference_project(store, xas_arrays)
    original = project["groups"][-1]
    project = command(store, project, "copy_series", [original["id"]],
                      parameter="rbkg", start=0.8, stop=1.2, count=2)
    ids = [original["id"], project["groups"][-1]["id"]]
    after = command(store, project, "set_e0", ids, method="manual", value=8980)
    assert set(after["last_operation"]["skipped_group_ids"]) == set(ids)
    assert after["groups"] == project["groups"]
    for ident in ids:
        with pytest.raises((ValueError, WebInputError), match="(?i)difference|absorption"):
            command(store, after, "parameters", [ident], background_standard_id=after["groups"][0]["id"])
        assert store.load(after["id"]) == after


@pytest.mark.parametrize("format", ["json", "prj"])
def test_chi_difference_series_still_has_the_real_larch_fourier_transform(store, format):
    k = np.arange(0, 14.0001, 0.05)
    chi = np.sin(4.6 * k) * np.exp(-0.015 * k**2)
    project = difference_project(store, (k, chi), data_type="chi")
    difference = project["groups"][-1]
    project = command(store, project, "copy_series", [difference["id"]],
                      parameter="kmax", start=10, stop=12, count=2)
    child = project["groups"][-1]
    applied = command(store, project, "parameters", [child["id"]])
    child = group(applied, child["id"])
    payload = store.export_project(applied["id"], format, [child["id"]])
    target = store.create()
    preview = store.preview_project(target["id"], payload, f"chi.{format}")
    curve = store.preview_project_group(target["id"], preview["upload_id"], child["id"], "chi")
    assert not curve.get("processing_error")
    np.testing.assert_allclose(curve["x"], k, atol=1e-12)
    np.testing.assert_allclose(curve["y"], -0.1 * chi, atol=1e-15)
    restored = store.restore_upload(target["id"], RestoreUploadRequest(version=0, upload_id=preview["upload_id"]))
    for item in (difference, child, restored["groups"][0]):
        assert item["is_difference"] is True and item["data_type"] == "chi"
        assert item["processing_error"] is None, item["processing_error"]
        arrays, effective = item["result"]["arrays"], item["result"]["effective"]
        assert arrays["energy"] == arrays["norm"] == []
        assert effective["e0"] is None
        np.testing.assert_allclose(arrays["chi"], -0.1 * chi, atol=1e-15)
        direct = Group()
        xftf(k, -0.1 * chi, group=direct, kmin=effective["kmin"], kmax=effective["kmax"],
             kweight=effective["kweight"], dk=effective["dk"], window=effective["window"],
             nfft=effective["nfft"], kstep=effective["kstep"], rmax_out=effective["rmax_out"])
        for key in ("r", "chir_re", "chir_im", "chir_mag"):
            np.testing.assert_allclose(arrays[key], getattr(direct, key), atol=1e-11)
        assert arrays["r"][np.argmax(arrays["chir_mag"])] == pytest.approx(2.3, abs=0.08)
