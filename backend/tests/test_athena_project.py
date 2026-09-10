"""User flows through AthenaStore, with real parsing, science and persistence.

No ASGI client or event loop is needed. Native exchange is also checked against
the local Larch reader, rather than relying exclusively on our own exporter.
"""

from copy import deepcopy
import gzip
from io import StringIO
import json
from pathlib import Path

import numpy as np
import pytest
from larch.io import read_athena
from larch.io.athena_project import AthenaProject

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_science import ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


EXAMPLES = Path(__file__).parents[2] / "examples" / "xafsdata"
AUTOMATIC_FIELDS = ("e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm", "bkg_kmax", "kmax")


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def table_bytes(**columns):
    output = StringIO()
    np.savetxt(output, np.column_stack(list(columns.values())),
               header=" ".join(columns), fmt="%.17g")
    return output.getvalue().encode()


def inspect_columns(store, project, filename="scan.dat", **columns):
    inspection = store.inspect(project["id"], table_bytes(**columns), filename)
    ids = {column["name"]: column["column_id"] for column in inspection["columns"]}
    return inspection, ids


def import_mu(store, project, x, y, *, filename="scan.dat", data_type="mu"):
    inspection, ids = inspect_columns(store, project, filename, energy=x, mu=y)
    return store.import_data(project["id"], ImportRequest(
        version=project["version"], upload_id=inspection["upload_id"],
        energy_column=ids["energy"], numerator=[ids["mu"]], data_type=data_type))


def command(store, project, action, groups=(), **options):
    return store.command(project["id"], Command(
        version=project["version"], action=action, group_ids=list(groups), options=options))


def group(project, ident):
    return next(g for g in project["groups"] if g["id"] == ident)


def import_detectors(store, project, x, y, *, shift=0, reverse=False):
    i0 = np.linspace(800_000, 1_200_000, len(x))
    transmitted = i0 * np.exp(-y)
    reference_mu = 0.6 * y + 0.03
    reference = transmitted * np.exp(-reference_mu)
    order = slice(None, None, -1) if reverse else slice(None)
    inspection, ids = inspect_columns(store, project, "detectors.dat",
        energy=((x + shift) / 1000)[order], i0=i0[order], it=transmitted[order], ir=reference[order])
    request = ImportRequest(version=project["version"], upload_id=inspection["upload_id"],
        energy_column=ids["energy"], numerator=[ids["i0"]], denominator=ids["it"],
        reference_numerator=ids["it"], reference_denominator=ids["ir"],
        mode="transmission", units="keV", sort=reverse)
    return store.import_data(project["id"], request), reference_mu


@pytest.fixture
def two_groups(store, xas_arrays):
    x, y = xas_arrays
    project = import_mu(store, store.create(), x, y, filename="first.dat")
    return import_mu(store, project, x + 4.2, y, filename="shifted.dat")


def test_create_inspect_and_import_persist_across_store_instances(store, xas_arrays):
    x, y = xas_arrays
    created = store.create()
    assert created["version"] == 0
    assert created["groups"] == []
    inspection, ids = inspect_columns(store, created, energy=x, mu=y)
    assert inspection["row_count"] == len(x)
    assert set(ids) == {"energy", "mu"}
    # Inspection alone must not create a group or consume an edit version.
    assert store.load(created["id"]) == created
    imported = store.import_data(created["id"], ImportRequest(version=0,
        upload_id=inspection["upload_id"], energy_column=ids["energy"], numerator=[ids["mu"]]))
    assert imported["version"] == 1
    assert len(imported["groups"]) == 1
    g = imported["groups"][0]
    np.testing.assert_array_equal(g["energy"], x)
    np.testing.assert_array_equal(g["mu"], y)
    assert g["processing_error"] is None
    assert g["result"]["arrays"]["chi"]
    assert g["result"]["effective"]["e0"] == pytest.approx(8980)
    assert all(g["parameters"][key] is None for key in AUTOMATIC_FIELDS)
    reopened = AthenaStore(store.settings)
    assert reopened.load(imported["id"]) == imported
    assert next(p for p in reopened.list() if p["id"] == imported["id"])["count"] == 1


@pytest.mark.parametrize("reverse", [False, True])
def test_transmission_reference_kev_sorting_and_multiple_imports(store, xas_arrays, reverse):
    x, y = xas_arrays
    p, reference_mu = import_detectors(store, store.create(), x, y, reverse=reverse)
    assert len(p["groups"]) == 2 and p["version"] == 1
    sample = next(g for g in p["groups"] if g["reference_id"] is not None)
    reference = group(p, sample["reference_id"])
    np.testing.assert_allclose(sample["energy"], x, atol=2e-12)
    np.testing.assert_allclose(sample["mu"], y, atol=1e-14)
    np.testing.assert_allclose(reference["energy"], x, atol=2e-12)
    np.testing.assert_allclose(reference["mu"], reference_mu, atol=1e-14)
    assert reference["marked"] is False and sample["marked"] is True
    assert sample["processing_error"] is reference["processing_error"] is None
    assert sample["source"]["mapping"]["units"] == "keV"
    before = deepcopy(p["groups"])
    p = import_mu(store, p, x, y * 1.2, filename="second.dat")
    assert p["groups"][:2] == before
    assert len({g["id"] for g in p["groups"]}) == 3
    assert len(p["history"]) == 2


def test_fluorescence_sums_selected_detector_channels_before_division(store, xas_arrays):
    x, y = xas_arrays
    p = store.create()
    i0 = np.linspace(900_000, 1_100_000, len(x))
    inspection, ids = inspect_columns(store, p, energy=x, i0=i0,
        fluorescence1=0.3 * y * i0, fluorescence2=0.7 * y * i0,
        excluded_detector=50 * y * i0)
    p = store.import_data(p["id"], ImportRequest(version=0, upload_id=inspection["upload_id"],
        energy_column=ids["energy"], numerator=[ids["fluorescence1"], ids["fluorescence2"]],
        denominator=ids["i0"], mode="fluorescence"))
    np.testing.assert_allclose(p["groups"][0]["mu"], y, atol=1e-14)
    assert p["groups"][0]["processing_error"] is None


@pytest.mark.parametrize("invalid", ["zero_denominator", "zero_numerator", "duplicate_numerator", "bad_reference"])
def test_invalid_detector_mapping_leaves_project_unchanged(store, xas_arrays, invalid):
    x, y = xas_arrays
    p = store.create()
    i0, it = np.ones_like(x), np.exp(-y)
    ir = it * np.exp(-0.5 * y)
    if invalid == "zero_denominator":
        it[50] = 0
    elif invalid == "zero_numerator":
        i0[50] = 0
    elif invalid == "bad_reference":
        ir[50] = 0
    inspection, ids = inspect_columns(store, p, energy=x, i0=i0, it=it, ir=ir)
    selected = [ids["i0"]] * (2 if invalid == "duplicate_numerator" else 1)
    with pytest.raises(WebInputError):
        store.import_data(p["id"], ImportRequest(version=0, upload_id=inspection["upload_id"],
            energy_column=ids["energy"], numerator=selected, denominator=ids["it"], mode="transmission",
            reference_numerator=ids["it"], reference_denominator=ids["ir"]))
    assert store.load(p["id"]) == p


@pytest.mark.parametrize("operation", ["command", "import", "restore"])
def test_stale_versions_cannot_overwrite_a_newer_project(store, xas_arrays, operation):
    x, y = xas_arrays
    original = store.create()
    inspection, ids = inspect_columns(store, original, energy=x, mu=y)
    current = command(store, original, "project", name="Newer title", journal="Keep this journal")
    with pytest.raises(WebInputError) as error:
        if operation == "command":
            store.command(original["id"], Command(version=0, action="project", options={"name": "Stale title"}))
        elif operation == "import":
            store.import_data(original["id"], ImportRequest(version=0, upload_id=inspection["upload_id"],
                energy_column=ids["energy"], numerator=[ids["mu"]]))
        else:
            store.restore(original["id"], 0, json.dumps(original).encode(), "old.json")
    assert error.value.code == "stale_revision"
    assert store.load(original["id"]) == current


def test_parameter_batch_is_atomic_when_second_spectrum_cannot_use_e0(store, xas_arrays):
    x, y = xas_arrays
    p = import_mu(store, store.create(), x, y)
    p = import_mu(store, p, x + 1000, y)
    ids = [g["id"] for g in p["groups"]]
    # e0=8980 is valid for the first spectrum and outside the second scan.
    # In particular, the first group's successful recalculation must not persist.
    with pytest.raises(ScientificError, match="e0"):
        command(store, p, "parameters", ids, e0=8980, rbkg=1.2)
    assert store.load(p["id"]) == p
    successful = command(store, p, "parameters", ids, rbkg=1.2, kweight=3)
    assert successful["version"] == p["version"] + 1
    assert all(g["parameters"]["rbkg"] == 1.2 for g in successful["groups"])
    assert all(g["processing_error"] is None for g in successful["groups"])


def test_parameter_batch_skips_frozen_and_direct_frozen_edit_rejects(store, two_groups):
    ids = [g["id"] for g in two_groups["groups"]]
    p = command(store, two_groups, "metadata", [ids[1]], frozen=True)
    changed = command(store, p, "parameters", ids, rbkg=1.2)
    assert changed["version"] == p["version"] + 1
    assert group(changed, ids[0])["parameters"]["rbkg"] == 1.2
    assert group(changed, ids[0])["result"]["effective"]["rbkg"] == 1.2
    assert group(changed, ids[1]) == group(p, ids[1])
    assert changed["last_operation"]["skipped_group_ids"] == [ids[1]]
    assert store.load(p["id"]) == changed
    with pytest.raises(WebInputError, match="Unfreeze"):
        command(store, changed, "parameters", [ids[1]], rbkg=1.2)
    assert store.load(p["id"]) == changed
    p = command(store, changed, "metadata", [ids[1]], frozen=False)
    changed = command(store, p, "parameters", [ids[1]], rbkg=1.2)
    assert all(g["parameters"]["rbkg"] == 1.2 for g in changed["groups"])
    assert all(not g["frozen"] for g in changed["groups"])


def test_undo_redo_restores_recipes_results_and_metadata_with_new_versions(store, two_groups):
    ids = [g["id"] for g in two_groups["groups"]]
    edited = command(store, two_groups, "parameters", ids, kweight=3, rbkg=1.2)
    named = command(store, edited, "project", name="Analysis", journal="Measured before annealing")
    undo_name = command(store, named, "undo")
    assert undo_name["name"] == two_groups["name"]
    assert undo_name["journal"] == two_groups["journal"]
    assert undo_name["groups"] == edited["groups"]
    undo_parameters = command(store, undo_name, "undo")
    assert undo_parameters["groups"] == two_groups["groups"]
    redo_parameters = command(store, undo_parameters, "redo")
    assert redo_parameters["groups"] == edited["groups"]
    redo_name = command(store, redo_parameters, "redo")
    assert redo_name["name"] == named["name"] and redo_name["journal"] == named["journal"]
    assert redo_name["groups"] == named["groups"]
    versions = [p["version"] for p in (two_groups, edited, named, undo_name, undo_parameters, redo_parameters, redo_name)]
    assert versions == list(range(versions[0], versions[0] + len(versions)))
    assert store.load(redo_name["id"]) == redo_name


def test_new_edit_after_undo_discards_redo_history(store, two_groups):
    renamed = command(store, two_groups, "project", name="Discard this title")
    undone = command(store, renamed, "undo")
    replacement = command(store, undone, "project", name="Replacement title")
    with pytest.raises(WebInputError, match="nothing to redo"):
        command(store, replacement, "redo")
    assert store.load(replacement["id"]) == replacement


def test_example_import_uses_measured_copper_files_and_processes_all_groups(store):
    created = store.create()
    p = command(store, created, "example")
    expected = ["cu_10k.xmu", "cu_50k.xmu", "cu_rt01.xmu"]
    assert len(p["groups"]) == 3 and p["version"] == 1
    for g, filename in zip(p["groups"], expected, strict=True):
        measured = np.loadtxt(EXAMPLES / filename)
        np.testing.assert_array_equal(g["energy"], measured[:, 0])
        np.testing.assert_array_equal(g["mu"], measured[:, 1])
        assert g["source"]["filename"] == filename
        assert g["source"]["citation"]
        assert g["processing_error"] is None
        assert g["result"]["arrays"]["chi"] and g["result"]["arrays"]["chir_mag"]
    assert command(store, p, "undo")["groups"] == []


def test_calibrate_updates_shifted_results_without_changing_measured_energy(store, two_groups):
    sample = two_groups["groups"][0]
    p = command(store, two_groups, "calibrate", [sample["id"]], target=8983, observed=8980)
    calibrated = group(p, sample["id"])
    assert calibrated["energy"] == sample["energy"] and calibrated["mu"] == sample["mu"]
    assert calibrated["parameters"]["energy_shift"] == 3
    assert calibrated["parameters"]["e0"] == 8983
    np.testing.assert_allclose(calibrated["result"]["arrays"]["energy"], np.asarray(sample["energy"]) + 3)
    assert calibrated["result"]["effective"]["e0"] == 8983
    assert p["groups"][1] == two_groups["groups"][1]


def test_alignment_composes_with_calibrated_reference_axis(store, two_groups):
    reference, moving = two_groups["groups"]
    p = command(store, two_groups, "calibrate", [reference["id"]], target=8982, observed=8980)
    expected_reference = deepcopy(group(p, reference["id"]))
    p = command(store, p, "align", [reference["id"], moving["id"]], reference_id=reference["id"])
    aligned = group(p, moving["id"])
    assert group(p, reference["id"]) == expected_reference
    assert aligned["parameters"]["energy_shift"] == pytest.approx(-2.2, abs=0.005)
    assert aligned["parameters"]["e0"] == 8982
    np.testing.assert_allclose(aligned["result"]["arrays"]["energy"],
                               expected_reference["result"]["arrays"]["energy"], atol=0.005)
    assert aligned["energy"] == moving["energy"]


def test_alignment_can_use_linked_reference_detector_spectra(store, xas_arrays):
    x, y = xas_arrays
    p, _ = import_detectors(store, store.create(), x, y)
    p, _ = import_detectors(store, p, x, y, shift=5.25)
    reference, moving = [g for g in p["groups"] if g["reference_id"]]
    p = command(store, p, "align", [moving["id"]], reference_id=reference["id"], use_reference=True)
    aligned = group(p, moving["id"])
    assert aligned["parameters"]["energy_shift"] == pytest.approx(-5.25, abs=0.005)
    np.testing.assert_allclose(aligned["result"]["arrays"]["energy"], x, atol=0.005)
    assert aligned["reference_id"] == moving["reference_id"]


@pytest.mark.parametrize("action", ["merge", "sum", "difference"])
def test_derived_combination_uses_overlap_and_preserves_parents(store, xas_arrays, action):
    x, y = xas_arrays
    p = import_mu(store, store.create(), x, y, filename="first.dat")
    # A coarser, shorter scan exercises interpolation and forbids extrapolation.
    other_x, other_y = x[40:-40:2], 0.5 * y[40:-40:2]
    p = import_mu(store, p, other_x, other_y, filename="second.dat")
    parents = deepcopy(p["groups"])
    ids = [g["id"] for g in parents]
    result = command(store, p, action, ids, label="Combined result")
    assert result["groups"][:2] == parents
    derived = result["groups"][-1]
    grid = x[(x >= other_x[0]) & (x <= other_x[-1])]
    first, second = np.interp(grid, x, y), np.interp(grid, other_x, other_y)
    expected = {"merge": (first + second) / 2, "sum": first + second, "difference": first - second}[action]
    np.testing.assert_array_equal(derived["energy"], grid)
    np.testing.assert_allclose(derived["mu"], expected, atol=1e-14)
    if action == "merge":
        np.testing.assert_allclose(derived["source"]["stddev"], np.abs(first - second) / 2)
    else:
        assert "stddev" not in derived["source"]
    assert derived["source"]["parents"] == ids
    assert derived["source"]["operation"] == action
    assert derived["label"] == "Combined result"
    assert derived["parameters"]["energy_shift"] == 0
    assert derived["data_type"] == ("norm" if action == "difference" else "mu")
    assert derived["processing_error"] is None
    if action == "difference":
        assert derived["result"]["effective"]["e0"] is None
        assert derived["result"]["effective"]["exafs"] is False
        assert derived["result"]["arrays"]["chi"] == []
        np.testing.assert_allclose(derived["result"]["arrays"]["norm"], expected)
    undone = command(store, result, "undo")
    assert undone["groups"] == parents


def test_merge_uses_calibrated_axes_without_applying_shift_twice(store, two_groups):
    reference, moving = two_groups["groups"]
    p = command(store, two_groups, "calibrate", [moving["id"]], target=8980, observed=8984.2)
    parents = deepcopy(p["groups"])
    result = command(store, p, "merge", [moving["id"], reference["id"]])
    merged = result["groups"][-1]
    np.testing.assert_allclose(merged["energy"], reference["energy"], atol=2e-12)
    np.testing.assert_allclose(merged["mu"], reference["mu"], atol=1e-12)
    assert merged["parameters"]["energy_shift"] == 0
    assert result["groups"][:2] == parents


def test_delete_reference_clears_links_and_undo_restores_them(store, xas_arrays):
    p, _ = import_detectors(store, store.create(), *xas_arrays)
    sample = next(g for g in p["groups"] if g["reference_id"])
    deleted = command(store, p, "delete", [sample["reference_id"]])
    assert len(deleted["groups"]) == 1
    assert deleted["groups"][0]["reference_id"] is None
    restored = command(store, deleted, "undo")
    assert restored["groups"] == p["groups"]


@pytest.fixture
def exchange_project(store, xas_arrays):
    x, y = xas_arrays
    p, _ = import_detectors(store, store.create(), x, y)
    sample, reference = p["groups"]
    # This roundtrip fixture deliberately exercises automatic reference
    # parameters as well as the explicitly configured sample below.
    p = command(store, p, "parameters", [reference["id"]], e0=None)
    p = command(store, p, "parameters", [sample["id"]], e0=8982.5, energy_shift=2.5,
        step=0.85, pre1=-200, pre2=-40, norm1=35, norm2=300, nnorm=1,
        flatten=False, rbkg=1.2, bkg_kmin=0.5, bkg_kmax=9, bkg_kweight=1,
        clamp_lo=0.1, clamp_hi=2, kmin=2, kmax=8, kweight=3, dk=0.5,
        window="parzen", rmin=0.5, rmax=4, dr=0.25, rwindow="welch", nfft=4096, kstep=0.04)
    p = command(store, p, "metadata", [sample["id"]], label="Cu α 'sample'", notes="Detector A\nQuote: 'edge' and C:\\data",
                marked=False, frozen=True, multiplier=1.5, offset=-0.2)
    p = command(store, p, "metadata", [reference["id"]], label="Reference foil", notes="Shared reference")
    p = import_mu(store, p, x, y, filename="near-edge.dat", data_type="xanes")
    p = import_mu(store, p, x, np.asarray(reference["result"]["arrays"]["norm"]), filename="normalized.dat", data_type="norm")
    p = command(store, p, "metadata", [p["groups"][-1]["id"]], reference_id=reference["id"])
    k = np.arange(0, 12.0001, 0.05)
    p = import_mu(store, p, k, np.sin(4.6 * k) * np.exp(-0.1 * k), filename="shell.chi", data_type="chi")
    p = command(store, p, "reorder", ids=[g["id"] for g in reversed(p["groups"])])
    return command(store, p, "project", name="Copper exchange α", journal="Before annealing\n\nAfter annealing: 300 K")


def assert_exchange_preserved(original, restored):
    assert restored["name"] == original["name"]
    assert restored["journal"] == original["journal"]
    assert len(restored["groups"]) == len(original["groups"])
    old_ids = {g["id"] for g in original["groups"]}
    new_ids = {g["id"] for g in restored["groups"]}
    assert old_ids.isdisjoint(new_ids)
    idmap = {a["id"]: b["id"] for a, b in zip(original["groups"], restored["groups"], strict=True)}
    for expected, actual in zip(original["groups"], restored["groups"], strict=True):
        for key in ("label", "data_type", "parameters", "marked", "frozen", "multiplier", "offset", "notes", "source"):
            assert actual[key] == expected[key], (expected["label"], key)
        assert actual["reference_id"] == idmap.get(expected["reference_id"])
        np.testing.assert_array_equal(actual["energy"], expected["energy"])
        np.testing.assert_array_equal(actual["mu"], expected["mu"])
        assert actual["processing_error"] is None
        assert actual["result"]["effective"] == expected["result"]["effective"]
        for key in ("norm", "chi", "chir_mag", "chiq_re"):
            np.testing.assert_allclose(actual["result"]["arrays"][key], expected["result"]["arrays"][key], atol=1e-11)
    automatic_reference = next(g for g in restored["groups"] if g["label"] == "Reference foil")
    assert all(automatic_reference["parameters"][key] is None for key in AUTOMATIC_FIELDS)


@pytest.mark.parametrize("format", ["json", "prj", "uncompressed_prj"])
def test_project_round_trip_preserves_groups_recipes_references_notes_and_journal(store, exchange_project, format):
    original = exchange_project
    if format == "json":
        data = json.dumps(store.load(original["id"]), allow_nan=False).encode()
    else:
        data = store.export_prj(original)
        assert data.startswith(b"\x1f\x8b")
        if format == "uncompressed_prj":
            data = gzip.decompress(data)
    destination = store.create()
    restored = store.restore(destination["id"], destination["version"], data, f"exchange.{format}")
    assert restored["id"] == destination["id"]
    assert restored["version"] == 1
    assert_exchange_preserved(original, restored)
    assert store.load(original["id"]) == original
    assert store.load(destination["id"]) == restored


def test_prj_export_is_readable_by_local_larch(store, exchange_project, tmp_path):
    p = exchange_project
    path = tmp_path / "native-reader.prj"
    path.write_bytes(store.export_prj(p))
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    assert len(native.groups) == len(p["groups"])
    for expected in p["groups"]:
        actual = native.groups[expected["id"]]
        if expected["data_type"] == "chi":
            np.testing.assert_array_equal(actual.k, expected["energy"])
            np.testing.assert_array_equal(actual.chi, expected["mu"])
        else:
            np.testing.assert_array_equal(actual.energy, expected["energy"])
            np.testing.assert_array_equal(actual.mu, expected["mu"])
            assert actual.athena_params.bkg.e0 == expected["result"]["effective"]["e0"]
        assert actual.label == expected["label"]
        assert actual.athena_params.bkg.fixstep == int(expected["parameters"]["step"] is not None)
    assert native.journal == p["journal"]


def test_native_demeter_project_import_matches_independent_larch_reader(store):
    path = EXAMPLES / "fe_athena.prj"
    native = AthenaProject()
    native.read(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    p = store.create()
    restored = store.restore(p["id"], 0, path.read_bytes(), path.name)
    assert len(restored["groups"]) == len(native.groups) == 3
    for actual, expected in zip(restored["groups"], native.groups.values(), strict=True):
        assert actual["label"] == expected.label
        np.testing.assert_array_equal(actual["energy"], expected.energy)
        np.testing.assert_array_equal(actual["mu"], expected.mu)
        assert actual["parameters"]["e0"] == expected.athena_params.bkg.e0
        assert actual["parameters"]["rbkg"] == expected.athena_params.bkg.rbkg
        assert actual["parameters"]["step"] is None
    assert restored["groups"][0]["processing_error"] is None
    assert restored["groups"][2]["processing_error"] is None
    # A saved range beyond the measured scan is retained for explicit repair.
    assert restored["groups"][1]["energy"]


def test_native_legacy_project_accepts_perl_undef_in_unrelated_peak_settings(store):
    path = EXAMPLES / "AthenaProjectFiles" / "athena1.prj"
    p = store.create()
    # This is a genuine Athena 0.8.061 project, not our export dialect. Its
    # irrelevant peak_fit1/peak_fit2 fields contain bare Perl undef literals.
    restored = store.restore(p["id"], 0, path.read_bytes(), path.name)
    assert restored["groups"]
    assert restored["groups"][0]["label"] == "AII_-25"
    assert len(restored["groups"][0]["energy"]) > 100


@pytest.mark.parametrize("format", ["json", "prj"])
def test_restore_appends_groups_remaps_internal_references_and_is_undoable(store, xas_arrays, format):
    original, _ = import_detectors(store, store.create(), *xas_arrays)
    original = command(store, original, "project", journal="Imported journal")
    data = store.export_prj(original) if format == "prj" else json.dumps(original).encode()
    destination = import_mu(store, store.create(), *xas_arrays, filename="existing.dat")
    destination = command(store, destination, "project", journal="Existing journal")
    restored = store.restore(destination["id"], destination["version"], data, f"restore.{format}")
    assert restored["groups"][0] == destination["groups"][0]
    imported = restored["groups"][1:]
    sample = next(g for g in imported if g["reference_id"])
    assert sample["reference_id"] in {g["id"] for g in imported}
    assert restored["journal"] == "Existing journal\nImported journal"
    assert command(store, restored, "undo")["groups"] == destination["groups"]


def test_restore_batch_failure_cannot_partially_append_groups(store, two_groups):
    document = deepcopy(two_groups)
    document["groups"][1]["energy"] = [1, 2]
    original = command(store, store.create(), "project", name="Keep me", journal="Keep my notes")
    with pytest.raises(WebInputError, match="paired data points"):
        store.restore(original["id"], original["version"], json.dumps(document).encode(), "broken.json")
    assert store.load(original["id"]) == original


@pytest.mark.parametrize("kind", ["signed", "zero"])
@pytest.mark.parametrize("format", ["json", "prj"])
def test_signed_or_zero_difference_needs_no_edge_and_survives_exchange(store, xas_arrays, kind, format):
    x, y = xas_arrays
    delta = np.zeros_like(y) if kind == "zero" else 0.08 * np.sin((x - 8980) / 12) * np.exp(-((x - 8980) / 40) ** 2)
    p = import_mu(store, store.create(), x, y)
    p = import_mu(store, p, x, y - delta)
    p = command(store, p, "difference", [g["id"] for g in p["groups"]])
    difference = p["groups"][-1]
    assert difference["processing_error"] is None
    assert difference["result"]["effective"]["e0"] is None
    assert difference["result"]["effective"]["exafs"] is False
    arrays = difference["result"]["arrays"]
    for key in ("mu", "norm", "flat"):
        np.testing.assert_allclose(arrays[key], delta, atol=1e-15)
    for key in ("k", "chi", "r", "chir_mag", "q", "chiq_re", "bkg", "pre_edge", "post_edge"):
        assert arrays[key] == []
    if kind == "signed":
        assert min(arrays["norm"]) < 0 < max(arrays["norm"])
    data = store.export_prj(p) if format == "prj" else json.dumps(p).encode()
    destination = store.create()
    restored = store.restore(destination["id"], 0, data, f"difference.{format}")
    imported_difference = restored["groups"][-1]
    assert imported_difference["source"]["operation"] == "difference"
    assert imported_difference["result"] == difference["result"]
    assert imported_difference["processing_error"] is None


@pytest.mark.parametrize("size", [8, 9, 100_001])
def test_processing_size_limit_does_not_discard_accepted_raw_upload(store, size):
    # AthenaStore currently accepts 8..250000 points; the science layer
    # requires 10..100000 for energy spectra. Until these limits are unified,
    # accepted scans must remain inspectable even when processing is rejected.
    x = np.linspace(8750, 9350, size)
    y = 0.2 + 1 / (1 + np.exp(-(x - 8980) / 2.5))
    p = import_mu(store, store.create(), x, y)
    accepted = p["groups"][0]
    np.testing.assert_array_equal(accepted["energy"], x)
    np.testing.assert_array_equal(accepted["mu"], y)
    assert accepted["processing_error"] is not None
    assert "10 to 100000" in accepted["processing_error"]
    assert accepted["result"] is None
    assert store.load(p["id"]) == p


def test_native_undef_token_does_not_change_quoted_undef_text(store, two_groups):
    p = command(store, two_groups, "metadata", [two_groups["groups"][0]["id"]], label="undef")
    p = command(store, p, "project", journal="undef\nQuoted undef is text")
    lines = gzip.decompress(store.export_prj(p)).decode().splitlines()
    lines = [line for line in lines if not line.startswith("# Athena-Web ")]
    for i, line in enumerate(lines):
        if line.startswith("@args = ("):
            lines[i] = line.replace("@args = (", "@args = ('peak_fit1', undef, 'peak_fit2', undef, ", 1)
    target = store.create()
    restored = store.restore(target["id"], 0, "\n".join(lines).encode(), "literal-undef.prj")
    assert restored["groups"][0]["label"] == "undef"
    assert restored["journal"] == "undef\nQuoted undef is text"
    assert all(g["processing_error"] is None for g in restored["groups"])


@pytest.mark.parametrize("expression", ["write_marker", "(lambda: 'executed')()", "[v for v in (1, 2)]", "object.__class__"])
def test_native_project_rejects_executable_expressions_without_side_effects(store, two_groups, tmp_path, expression):
    marker = tmp_path / "must-not-exist.txt"
    if expression == "write_marker":
        expression = f"__import__('pathlib').Path({str(marker)!r}).write_text('executed')"
    lines = gzip.decompress(store.export_prj(two_groups)).decode().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("@args = ("):
            lines[i] = f"@args = ('label', {expression});"
            break
    with pytest.raises(ValueError):
        store.restore(two_groups["id"], two_groups["version"], "\n".join(lines).encode(), "malicious.prj")
    assert not marker.exists()
    assert store.load(two_groups["id"]) == two_groups


def test_restore_rejects_nonobject_source_metadata_atomically(store, two_groups):
    document = deepcopy(two_groups)
    document["groups"][1]["source"] = "not an object"
    with pytest.raises(WebInputError, match="Source metadata"):
        store.restore(two_groups["id"], two_groups["version"], json.dumps(document).encode(), "invalid-source.json")
    assert store.load(two_groups["id"]) == two_groups


def test_copy_series_reprocesses_each_setting_and_preserves_original_groups(store, two_groups):
    originals = deepcopy(two_groups["groups"])
    ids = [g["id"] for g in originals]
    result = command(store, two_groups, "copy_series", ids, parameter="rbkg", start=0.8, stop=1.2, count=3)
    assert result["groups"][:2] == originals
    assert result["version"] == two_groups["version"] + 1
    assert len(result["groups"]) == 8
    assert len({g["id"] for g in result["groups"]}) == 8
    for parent in originals:
        copies = [g for g in result["groups"][2:] if g["source"]["parent"] == parent["id"]]
        assert [g["parameters"]["rbkg"] for g in copies] == pytest.approx([0.8, 1, 1.2])
        for g in copies:
            assert g["energy"] == parent["energy"] and g["mu"] == parent["mu"]
            assert g["processing_error"] is None and not g["frozen"]
            assert g["result"]["effective"]["rbkg"] == g["parameters"]["rbkg"]
            assert g["source"]["value"] == g["parameters"]["rbkg"]
        assert not np.allclose(copies[0]["result"]["arrays"]["chi"], copies[-1]["result"]["arrays"]["chi"])
    assert command(store, result, "undo")["groups"] == originals


def test_copy_series_later_invalid_setting_cannot_save_partial_copies(store, two_groups):
    with pytest.raises(ValueError, match="rbkg"):
        command(store, two_groups, "copy_series", [two_groups["groups"][0]["id"]],
                parameter="rbkg", start=0.8, stop=0, count=3)
    assert store.load(two_groups["id"]) == two_groups


@pytest.mark.parametrize("rwindow", ["hanning", "kaiser"])
def test_identical_copper_spectra_have_zero_log_amplitude_and_phase(store, rwindow):
    p = command(store, store.create(), "example")
    copper = p["groups"][0]
    p = command(store, p, "duplicate", [copper["id"]])
    ids = [copper["id"], p["groups"][-1]["id"]]
    p = command(store, p, "parameters", ids, e0=copper["result"]["effective"]["e0"], kmax=8, rwindow=rwindow, dr=0)
    analysis = store.analyze(p["id"], Command(version=p["version"], action="log_ratio", group_ids=ids,
        options={"kmin": 3, "kmax": 7, "array": "norm"}))
    assert analysis["kind"] == "log_ratio"
    assert analysis["project_version"] == p["version"]
    assert analysis["result"]["k"]
    np.testing.assert_allclose(analysis["result"]["log_amplitude_ratio"], 0, atol=1e-14)
    np.testing.assert_allclose(analysis["result"]["phase_difference"], 0, atol=1e-14)
    persisted = store.load(p["id"])
    assert persisted["version"] == p["version"]
    assert persisted["groups"] == p["groups"]
    assert persisted["analyses"][-1] == analysis
    p = persisted
    incompatible = command(store, p, "parameters", [ids[1]], dk=0.5)
    with pytest.raises(WebInputError, match="common limits"):
        store.analyze(p["id"], Command(version=incompatible["version"], action="log_ratio", group_ids=ids))
    assert store.load(p["id"]) == incompatible


def test_analysis_of_unavailable_empty_array_is_actionable(store):
    k = np.arange(0, 12.0001, 0.05)
    p = import_mu(store, store.create(), k, np.sin(4.6 * k), data_type="chi")
    p = command(store, p, "duplicate", [p["groups"][0]["id"]])
    with pytest.raises(WebInputError, match="not available"):
        store.analyze(p["id"], Command(version=p["version"], action="pca",
            group_ids=[g["id"] for g in p["groups"]], options={"array": "norm"}))
    assert store.load(p["id"]) == p


def read_native_json_fixture(filename):
    data = (EXAMPLES / "AthenaProjectFiles" / filename).read_bytes()
    return json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)


@pytest.mark.parametrize("filename", ["json_unzipped.prj", "FeFoil_QXAFS_Compare.prj", "athena3.prj", "Ni_FeNiS20_RT.prj"])
@pytest.mark.parametrize("compressed", [False, True])
def test_real_native_json_preserves_arrays_and_independent_larch_values(store, tmp_path, filename, compressed):
    document = read_native_json_fixture(filename)
    data = json.dumps(document).encode()
    if compressed:
        data = gzip.compress(data)
    path = tmp_path / filename
    # Local Larch leaks the failed gzip probe's file handle on plain files.
    # Its independent read uses gzip; our importer still exercises both forms.
    path.write_bytes(gzip.compress(json.dumps(document).encode()))
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    destination = store.create()
    p = store.restore(destination["id"], 0, data, filename)
    assert len(p["groups"]) == len(document["_____order"])
    for g, key in zip(p["groups"], document["_____order"], strict=True):
        raw, independent = document[key], native.groups[key]
        np.testing.assert_array_equal(g["energy"], independent.energy)
        np.testing.assert_array_equal(g["mu"], independent.mu)
        assert g["label"] == raw["args"]["label"]
        assert g["source"]["native"]["args"] == raw["args"]
        for name in ("i0", "signal", "stddev"):
            if name in raw:
                retained = g["source"]["raw_arrays"].get(name, g["source"]["native"].get("unaligned_arrays", {}).get(name))
                if any(v is None for v in raw[name]):
                    assert retained == raw[name]
                else:
                    np.testing.assert_array_equal(retained, np.asarray(raw[name], dtype=float))
        assert g["source"]["warnings"]
    assert p["import_warnings"]
    assert p["native_projects"][0]["metadata"]["_____order"] == document["_____order"]
    assert p["journal"] == "\n".join(document["_____journal"])
    destination = store.create()
    reread = store.restore(destination["id"], 0, store.export_prj(p), "native-roundtrip.prj")
    for before, after in zip(p["groups"], reread["groups"], strict=True):
        assert after["source"] == before["source"]
        assert after["parameters"] == before["parameters"]
        assert after["energy"] == before["energy"] and after["mu"] == before["mu"]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_detector_counts_and_uploaded_columns_survive_exchange(store, xas_arrays, tmp_path, format):
    x, y = xas_arrays
    p, _ = import_detectors(store, store.create(), x, y, reverse=True)
    sample, reference = p["groups"]
    columns = {c["name"]: c["column_id"] for c in sample["source"]["columns"]}
    saved = sample["source"]["column_arrays"]
    np.testing.assert_allclose(saved[columns["energy"]], x / 1000)
    np.testing.assert_allclose(sample["source"]["raw_arrays"]["i0"], saved[columns["i0"]])
    np.testing.assert_allclose(sample["source"]["raw_arrays"]["signal"], saved[columns["it"]])
    np.testing.assert_allclose(reference["source"]["raw_arrays"]["i0"], saved[columns["it"]])
    np.testing.assert_allclose(reference["source"]["raw_arrays"]["signal"], saved[columns["ir"]])
    assert sample["source"]["row_order"] == list(range(len(x) - 1, -1, -1))
    data = store.export_prj(p) if format == "prj" else json.dumps(p).encode()
    destination = store.create()
    imported = store.restore(destination["id"], 0, data, f"detectors.{format}")
    for before, after in zip(p["groups"], imported["groups"], strict=True):
        assert after["source"] == before["source"]
    if format == "prj":
        path = tmp_path / "detectors.prj"
        path.write_bytes(data)
        independent = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
        for g in p["groups"]:
            np.testing.assert_array_equal(independent.groups[g["id"]].i0, g["source"]["raw_arrays"]["i0"])
            np.testing.assert_array_equal(independent.groups[g["id"]].signal, g["source"]["raw_arrays"]["signal"])


def test_export_stddev_background_controls_and_metadata_without_sidecar(store, xas_arrays, tmp_path):
    x, y = xas_arrays
    p = store.create()
    sigma = np.linspace(0.001, 0.002, len(x))
    inspection, ids = inspect_columns(store, p, energy=x, mu=y, stddev=sigma)
    p = store.import_data(p["id"], ImportRequest(version=0, upload_id=inspection["upload_id"],
        energy_column=ids["energy"], numerator=[ids["mu"]]))
    gid = p["groups"][0]["id"]
    p = command(store, p, "parameters", [gid], bkg_dk=0.4, bkg_window="welch", nclamp=4, bkg_kweight=1.5, kweight=2.5)
    p = command(store, p, "metadata", [gid], notes="Native annotation; a=>b stays text")
    text = gzip.decompress(store.export_prj(p)).decode()
    text = "\n".join(line for line in text.splitlines() if not line.startswith("# Athena-Web "))
    path = tmp_path / "native-no-sidecar.prj"
    path.write_bytes(gzip.compress(text.encode()))
    direct = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True).groups[gid]
    np.testing.assert_array_equal(direct.stddev, sigma)
    assert direct.athena_params.bkg.dk == 0.4
    assert direct.athena_params.bkg.kwindow == "welch"
    assert direct.athena_params.bkg.nclamp == 4
    destination = store.create()
    result = store.restore(destination["id"], 0, text.encode(), path.name)["groups"][0]
    for key in ("bkg_dk", "bkg_window", "nclamp", "bkg_kweight", "kweight"):
        assert result["parameters"][key] == p["groups"][0]["parameters"][key]
    assert result["notes"] == p["groups"][0]["notes"]
    np.testing.assert_array_equal(result["source"]["raw_arrays"]["stddev"], sigma)


def test_native_json_links_and_unapplied_fit_properties_are_retained(store):
    document = read_native_json_fixture("FeFoil_QXAFS_Compare.prj")
    ids = document["_____order"][:2]
    document = {k: v for k, v in document.items() if k.startswith("_____") or k in ids}
    document["_____order"] = ids
    document[ids[0]]["args"]["referencegroup"] = ids[1]
    document[ids[0]]["args"]["annotation"] = "Foil reference attached"
    document[ids[0]]["properties"] = {"peak_fit": {"amplitude": 1.25}}
    document["_____fits"] = {"lcf": {"weights": [0.3, 0.7]}}
    p = store.create()
    restored = store.restore(p["id"], 0, json.dumps(document).encode(), "properties.prj")
    assert restored["groups"][0]["reference_id"] == restored["groups"][1]["id"]
    assert restored["groups"][0]["notes"] == "Foil reference attached"
    assert restored["groups"][0]["source"]["native"]["fields"]["properties"] == document[ids[0]]["properties"]
    assert restored["native_projects"][0]["metadata"]["_____fits"] == document["_____fits"]
    assert any("_____fits" in warning for warning in restored["import_warnings"])
    assert restored["analyses"] == []


@pytest.mark.parametrize("malformation", ["duplicate_order", "missing_record", "oversized_array", "nonfinite", "too_many_groups", "oversized_metadata"])
def test_native_json_validation_fails_before_mutation(store, malformation):
    document = read_native_json_fixture("athena3.prj")
    key = document["_____order"][0]
    if malformation == "duplicate_order":
        document["_____order"] *= 2
    elif malformation == "missing_record":
        del document[key]
    elif malformation == "oversized_array":
        document[key]["i0"] = [1] * 250_001
    elif malformation == "nonfinite":
        document[key]["y"][0] = float("nan")
    elif malformation == "too_many_groups":
        document["_____order"] = [str(i) for i in range(101)]
    else:
        document[key]["args"]["properties"] = "a" * 1_000_001
    p = store.create()
    with pytest.raises(ValueError):
        store.restore(p["id"], 0, json.dumps(document).encode(), "invalid.prj")
    assert store.load(p["id"]) == p


def test_expanded_native_gzip_byte_limit_is_enforced(tmp_path):
    limited = AthenaStore(Settings(data_root=tmp_path, max_upload_bytes=1000))
    p = limited.create()
    with pytest.raises(WebInputError, match="Expanded project"):
        limited.restore(p["id"], 0, gzip.compress(b" " * 1001), "oversized.prj")
    assert limited.load(p["id"]) == p


@pytest.mark.parametrize("format", ["json", "prj"])
def test_saved_analyses_roundtrip_remaps_groups_and_preserves_freshness(store, two_groups, format):
    p = two_groups
    ids = [g["id"] for g in p["groups"]]
    stale = store.analyze(p["id"], Command(version=p["version"], action="pca", group_ids=ids, options={"array": "mu"}))
    p = command(store, store.load(p["id"]), "parameters", ids, kweight=3)
    current = store.analyze(p["id"], Command(version=p["version"], action="pca", group_ids=ids, options={"array": "mu"}))
    p = store.load(p["id"])
    data = store.export_prj(p) if format == "prj" else json.dumps(p).encode()
    destination = store.create()
    restored = store.restore(destination["id"], 0, data, f"analyses.{format}")
    assert store.load(destination["id"])["analyses"] == restored["analyses"]
    old, fresh = restored["analyses"]
    assert old["project_version"] != restored["version"]
    assert fresh["project_version"] == restored["version"]
    for original, imported in ((stale, old), (current, fresh)):
        assert imported["id"] != original["id"]
        assert imported["group_ids"] == [g["id"] for g in restored["groups"]]
        assert imported["result"] == original["result"]
        assert imported["options"] == original["options"]


def test_append_restore_keeps_existing_reports_stale(store, two_groups):
    ids = [g["id"] for g in two_groups["groups"]]
    existing = store.analyze(two_groups["id"], Command(version=two_groups["version"], action="pca", group_ids=ids, options={"array": "mu"}))
    p = store.load(two_groups["id"])
    restored = store.restore(p["id"], p["version"], json.dumps(p).encode(), "append.json")
    assert restored["analyses"][0] == existing
    assert restored["analyses"][0]["project_version"] != restored["version"]
    assert restored["analyses"][1]["project_version"] == restored["version"]
    assert restored["analyses"][1]["group_ids"] == [g["id"] for g in restored["groups"][2:]]


@pytest.mark.parametrize("format", ["json", "prj"])
def test_old_web_exchange_preserves_effective_background_defaults(store, two_groups, format):
    original = deepcopy(two_groups)
    for g in original["groups"]:
        for key in ("bkg_dk", "bkg_window", "nclamp"):
            g["parameters"].pop(key)
        g["result"]["effective"].update(bkg_dk=0.1, bkg_window="hanning", nclamp=3)
    data = store.export_prj(original) if format == "prj" else json.dumps(original).encode()
    target = store.create()
    restored = store.restore(target["id"], 0, data, f"historical.{format}")
    for g in restored["groups"]:
        assert g["parameters"]["bkg_dk"] == 0.1
        assert g["parameters"]["nclamp"] == 3
        assert g["result"]["effective"]["bkg_dk"] == 0.1
        assert g["result"]["effective"]["nclamp"] == 3


@pytest.fixture
def native_reference_project(store, xas_arrays):
    x, y = xas_arrays
    document = {"_____header": "# Athena project file -- Demeter version 0.9.26",
                "_____order": ["sample", "reference"]}
    for index, key in enumerate(document["_____order"]):
        # Different explicit E0 values must retain their difference when tied.
        # Both normalization windows end exactly at the final measured point.
        document[key] = {"args": {"label": key, "is_xmu": 1,
            "referencegroup": "reference" if index == 0 else "",
            "bkg_eshift": 2.5, "bkg_e0": 8982.5 + index,
            "bkg_nor1": 25, "bkg_nor2": 370 - index},
            "x": x.tolist(), "y": y.tolist()}
    p = store.create()
    restored = store.restore(p["id"], 0, gzip.compress(json.dumps(document).encode()), "references.prj")
    assert all(g["processing_error"] is None for g in restored["groups"])
    return restored


@pytest.mark.parametrize("format", ["native_json", "web_json", "sidecar_prj", "legacy_prj"])
def test_native_explicit_e0_shift_survives_exchange_in_both_directions(store, native_reference_project, format):
    p = native_reference_project
    if format != "native_json":
        data = json.dumps(p).encode() if format == "web_json" else store.export_prj(p)
        if format == "legacy_prj":
            data = gzip.compress(b"\n".join(line for line in gzip.decompress(data).splitlines()
                                           if not line.startswith(b"# Athena-Web ")))
        target = store.create()
        p = store.restore(target["id"], 0, data, f"references.{format}")
        assert {g["id"] for g in p["groups"]}.isdisjoint(g["id"] for g in native_reference_project["groups"])
    sample, reference = p["groups"]
    assert sample["reference_id"] == reference["id"] and reference["reference_id"] is None
    for selected, shift in ((reference["id"], -1.25), (sample["id"], 4.0)):
        before = deepcopy(p)
        p = command(store, p, "parameters", [selected], energy_shift=shift)
        for old, actual in zip(before["groups"], p["groups"], strict=True):
            delta = shift - old["parameters"]["energy_shift"]
            assert actual["parameters"]["e0"] == old["parameters"]["e0"] + delta
            assert actual["parameters"]["energy_shift"] == shift
            assert actual["parameters"]["norm2"] == old["parameters"]["norm2"]
            assert actual["energy"] == old["energy"] and actual["mu"] == old["mu"]
            assert actual["reference_id"] == old["reference_id"]
            assert actual["processing_error"] is None
            arrays = actual["result"]["arrays"]
            effective = actual["result"]["effective"]
            assert effective["e0"] + effective["norm2"] == pytest.approx(arrays["energy"][-1])
            np.testing.assert_allclose(arrays["energy"], np.asarray(actual["energy"]) + shift)
            for name in ("norm", "chi"):
                np.testing.assert_allclose(arrays[name], old["result"]["arrays"][name], atol=1e-10)
        assert store.load(p["id"]) == p


def test_copy_energy_shift_moves_native_e0_once_and_skips_frozen_pair(store, native_reference_project):
    p = native_reference_project
    ids = [g["id"] for g in p["groups"]]
    p = command(store, p, "duplicate", [ids[0]])
    source_id = p["groups"][-1]["id"]
    p = command(store, p, "parameters", [source_id], energy_shift=-1.25)
    source = deepcopy(group(p, source_id))
    p = command(store, p, "copy_parameters", ids, source_id=source_id, parameter="energy_shift")
    assert group(p, source_id) == source
    assert [g["parameters"]["energy_shift"] for g in p["groups"]] == [-1.25] * 3
    assert [g["parameters"]["e0"] for g in p["groups"]] == [8978.75, 8979.75, 8978.75]
    p = command(store, p, "metadata", [ids[1]], frozen=True)
    frozen_pair = deepcopy(p["groups"][:2])
    changed = command(store, p, "copy_parameters", [*ids, source_id], source_id=source_id,
                      parameter="energy_shift", values={"energy_shift": 4})
    assert changed["groups"][:2] == frozen_pair
    assert changed["last_operation"]["skipped_group_ids"] == sorted(ids)
    assert group(changed, source_id)["parameters"]["e0"] == 8984
    assert group(changed, source_id)["processing_error"] is None
    with pytest.raises(WebInputError, match="Unfreeze"):
        command(store, changed, "parameters", [ids[0]], energy_shift=4)
    assert store.load(p["id"]) == changed


@pytest.mark.parametrize("reference_shift", [2.5, 1.5])
def test_unchanged_native_reference_link_preserves_shared_topology_and_data(store, native_reference_project, reference_shift):
    document = deepcopy(native_reference_project)
    sample, reference = document["groups"]
    other = deepcopy(sample)
    other.update(id="other-native-sample", label="Other sample")
    document["groups"].append(other)
    # Historical native links may have unequal shifts. A notes save must leave
    # those recipes alone, including a frozen reference's cached calculation.
    reference["parameters"]["e0"] += reference_shift - reference["parameters"]["energy_shift"]
    reference["parameters"]["energy_shift"] = reference_shift
    reference["frozen"] = True
    target = store.create()
    p = store.restore(target["id"], 0, json.dumps(document).encode(), "shared.json")
    sample, reference, other = p["groups"]
    assert sample["reference_id"] == other["reference_id"] == reference["id"]
    expected = deepcopy(p["groups"])
    expected[0]["notes"] = "Only edited notes"
    changed = command(store, p, "metadata", [sample["id"]], notes="Only edited notes",
                      reference_id=sample["reference_id"])
    assert changed["groups"] == expected
    retied = command(store, changed, "tie_reference", [sample["id"], reference["id"]])
    assert retied["groups"] == expected
    assert store.load(p["id"]) == retied


def test_new_reference_link_moves_reference_e0_without_rewriting_frozen_sample(store, native_reference_project):
    p = native_reference_project
    ids = [g["id"] for g in p["groups"]]
    p = command(store, p, "untie_reference", [ids[0]])
    p = command(store, p, "parameters", [ids[0]], energy_shift=4)
    p = command(store, p, "metadata", [ids[0]], frozen=True)
    sample = deepcopy(p["groups"][0])
    sample["reference_id"] = ids[1]
    changed = command(store, p, "tie_reference", ids)
    assert changed["groups"][0] == sample
    reference = changed["groups"][1]
    assert reference["parameters"]["energy_shift"] == 4
    assert reference["parameters"]["e0"] == 8985
    assert reference["processing_error"] is None


@pytest.mark.parametrize("e0", [8985, None])
def test_shift_respects_explicit_e0_or_automatic_reset(store, native_reference_project, e0):
    p = native_reference_project
    sample, reference = p["groups"]
    changed = command(store, p, "parameters", [sample["id"]], energy_shift=4, e0=e0, norm2=300)
    assert changed["groups"][0]["parameters"]["e0"] == e0
    assert changed["groups"][0]["result"]["effective"]["e0"] == (8984 if e0 is None else e0)
    assert changed["groups"][1]["parameters"]["e0"] == reference["parameters"]["e0"] + 1.5
    assert all(g["processing_error"] is None for g in changed["groups"])


def test_calibration_and_alignment_keep_explicit_targets_on_native_linked_groups(store, native_reference_project, xas_arrays):
    p = native_reference_project
    ids = [g["id"] for g in p["groups"]]
    p = command(store, p, "calibrate", [ids[0]], observed=8980, target=8985)
    assert [g["parameters"]["e0"] for g in p["groups"]] == [8985, 8986]
    x, y = xas_arrays
    p = import_mu(store, p, x + 4.2, y, filename="standard.dat")
    standard_id = p["groups"][-1]["id"]
    p = command(store, p, "calibrate", [standard_id], observed=8984.2, target=8984)
    standard = deepcopy(p["groups"][-1])
    changed = command(store, p, "align", [ids[0]], reference_id=standard_id)
    assert changed["groups"][0]["parameters"]["e0"] == 8984
    assert changed["groups"][1]["parameters"]["e0"] == pytest.approx(8985, abs=.005)
    assert changed["groups"][-1] == standard
    assert all(g["processing_error"] is None for g in changed["groups"])
