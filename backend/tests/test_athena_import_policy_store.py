"""Import-only edge enforcement through real parsing, Larch and persistence.

Policies belong to each import request. Saved source snapshots describe how a
group was created; project exchange and previews must not execute them again.
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

from xraylarch_web.athena import AthenaStore, Command, ImportRequest, RestoreUploadRequest
from xraylarch_web.athena_science import ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError


EXAMPLES = Path(__file__).parents[2] / "examples" / "xafsdata"
CU_POLICY = {"element": "Cu", "edge": "K", "fraction": 0.65}
SOURCE_KEYS = ("edge_identity", "edge_policy", "e0_fraction", "e0_selection", "import_defaults")


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture(scope="module")
def copper():
    data = np.loadtxt(EXAMPLES / "cu_rt01.xmu")
    return data[:, 0], data[:, 1]


@pytest.fixture(scope="module")
def iron():
    # The measured X-11A foil fixture has an 18-line XDAC header.
    data = np.loadtxt(EXAMPLES / "fe.060", skiprows=18)
    return data[:, 0], np.log(data[:, 1] / data[:, 2])


def inspect(store, project, filename="scan.dat", **columns):
    stream = StringIO()
    np.savetxt(stream, np.column_stack(list(columns.values())),
               header=" ".join(columns), fmt="%.17g")
    result = store.inspect(project["id"], stream.getvalue().encode(), filename)
    ids = {column["name"]: column["column_id"] for column in result["columns"]}
    return result["upload_id"], ids


def mu_request(store, project, arrays, *, filename="scan.dat", **options):
    upload, ids = inspect(store, project, filename, energy=arrays[0], mu=arrays[1])
    return ImportRequest(version=project["version"], upload_id=upload,
                         energy_column=ids["energy"], numerator=[ids["mu"]], **options)


def import_mu(store, project, arrays, **options):
    return store.import_data(project["id"], mu_request(store, project, arrays, **options))


def command(store, project, action, ids=(), **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
                         group_ids=list(ids), options=options))


def persisted_files(store, project):
    """Capture project/history state, excluding separately staged input files."""
    root = store.storage.workspace_dir(project["id"])
    return {p.name: p.read_bytes() for p in root.glob("*.json")
            if not p.name.startswith(("upload-", "project-upload-"))}


def assert_saved(store, project):
    assert AthenaStore(store.settings).load(project["id"]) == project


def assert_enforced(group, fraction=0.65):
    assert group["processing_error"] is None
    assert group["source"]["edge_identity"] == {
        "element": "Cu", "edge": "K", "origin": "enforced"}
    assert group["source"]["edge_policy"] == {
        "element": "Cu", "edge": "K", "fraction": fraction}
    assert group["source"]["e0_fraction"] == fraction
    assert "edge_policy" not in group["source"]["mapping"]
    report = group["source"]["e0_selection"]
    assert report["method"] == "fraction"
    assert report["seed_e0"] == 8979.0
    assert report["e0"] == group["parameters"]["e0"]
    assert 0 < report["iterations"] <= 5
    assert isinstance(group["source"]["import_defaults"], dict)
    assert group["source"]["import_defaults"]
    result = group["result"]
    assert result["effective"]["e0"] == group["parameters"]["e0"]
    assert (result["effective"]["element"], result["effective"]["edge"]) == ("Cu", "K")
    assert group["parameters"]["energy_shift"] == 0
    # Resolved normalization windows must remain usable on the actual scan.
    effective = result["effective"]
    e0 = effective["e0"]
    assert effective["pre1"] < effective["pre2"] < 0
    assert 0 < effective["norm1"] < effective["norm2"]
    assert e0 + effective["pre1"] >= group["energy"][0] - 1e-6
    assert e0 + effective["norm2"] <= group["energy"][-1] + 1e-6
    assert len(result["arrays"]["norm"]) == len(group["energy"])


@pytest.mark.parametrize("frozen", [False, True])
def test_policy_import_preserves_existing_groups_even_when_frozen(store, copper, frozen):
    before = import_mu(store, store.create(), copper, filename="existing-cu.dat")
    if frozen:
        before = command(store, before, "metadata", [before["groups"][0]["id"]], frozen=True)
    untouched = deepcopy(before["groups"])
    after = import_mu(store, before, copper, filename="enforced-cu.dat", edge_policy=CU_POLICY)
    assert after["version"] == before["version"] + 1
    assert after["groups"][:-1] == untouched
    added = after["groups"][-1]
    assert_enforced(added)
    np.testing.assert_array_equal(added["energy"], copper[0])
    np.testing.assert_array_equal(added["mu"], copper[1])
    assert 8979 < added["parameters"]["e0"] < 9000
    assert_saved(store, after)


def test_omitted_policy_fraction_resolves_to_half_step(store, copper):
    after = import_mu(store, store.create(), copper, edge_policy={"element": "Cu", "edge": "K"})
    assert_enforced(after["groups"][0], fraction=0.5)
    assert_saved(store, after)


@pytest.mark.parametrize("off", [{}, {"edge_policy": None}], ids=["omitted", "null"])
def test_copper_policy_does_not_leak_into_later_iron_import(store, copper, iron, off):
    cu = import_mu(store, store.create(), copper, filename="cu.dat", edge_policy=CU_POLICY)
    before = deepcopy(cu["groups"])
    mixed = import_mu(store, cu, iron, filename="fe.dat", **off)
    assert mixed["groups"][:-1] == before
    fe = mixed["groups"][-1]
    assert fe["processing_error"] is None
    assert 7105 < fe["result"]["effective"]["e0"] < 7130
    assert fe["parameters"]["e0"] is None
    assert not fe["source"].get("edge_policy")
    assert fe["source"]["edge_identity"] == {"element": "Fe", "edge": "K", "origin": "inferred"}
    assert (fe["result"]["effective"]["element"], fe["result"]["effective"]["edge"]) == ("Fe", "K")
    assert "edge_policy" not in fe["source"]["mapping"]
    assert_saved(store, mixed)


@pytest.mark.parametrize("policy", [
    {"element": "Cu"}, {"edge": "K"},
    {"element": "Cu", "edge": "K", "enabled": True},
    {"element": "Cu", "edge": "K", "fraction": "0.5"},
    {"element": "Cu", "edge": "K", "fraction": True},
    {"element": "Cu", "edge": "K", "fraction": 0},
    {"element": "Cu", "edge": "K", "fraction": 1.01},
    {"element": "Cu", "edge": "K", "fraction": float("nan")},
    {"element": "Cu", "edge": "K", "fraction": float("inf")},
])
def test_invalid_policy_is_rejected_before_project_state_changes(store, copper, policy):
    project = store.create()
    request = mu_request(store, project, copper)
    before = persisted_files(store, project)
    with pytest.raises(ValidationError):
        ImportRequest.model_validate(request.model_dump() | {"edge_policy": policy})
    assert_saved(store, project)
    assert persisted_files(store, project) == before


@pytest.mark.parametrize("policy", [
    {"element": "Fe", "edge": "K"},
    {"element": "Cu", "edge": "L3"},
    {"element": "Unobtainium", "edge": "K"},
])
def test_wrong_or_unavailable_edge_rejects_atomically_and_upload_can_be_retried(store, copper, policy):
    project = store.create()
    base = mu_request(store, project, copper)
    before = persisted_files(store, project)
    with pytest.raises((ValidationError, ScientificError, WebInputError), match="(?i)element|edge|range|energy"):
        request = ImportRequest.model_validate(base.model_dump() | {"edge_policy": policy})
        store.import_data(project["id"], request)
    assert_saved(store, project)
    assert persisted_files(store, project) == before
    repaired = ImportRequest.model_validate(base.model_dump() | {"edge_policy": CU_POLICY})
    after = store.import_data(project["id"], repaired)
    assert after["version"] == 1 and len(after["groups"]) == 1
    assert_enforced(after["groups"][0])


def detector_request(store, project, x, y, reference_mu, *, reverse=False):
    i0 = np.linspace(800_000, 1_200_000, len(x))
    transmitted = i0 * np.exp(-y)
    reference = transmitted * np.exp(-reference_mu)
    order = slice(None, None, -1) if reverse else slice(None)
    upload, ids = inspect(store, project, "detectors-kev.dat",
        energy=(x / 1000)[order], i0=i0[order], it=transmitted[order], ir=reference[order])
    request = ImportRequest(version=project["version"], upload_id=upload,
        energy_column=ids["energy"], numerator=[ids["i0"]], denominator=ids["it"],
        mode="transmission", units="keV", sort=reverse,
        reference_numerator=ids["it"], reference_denominator=ids["ir"], edge_policy=CU_POLICY)
    return request, i0, transmitted, reference


def test_policy_applies_independently_to_sorted_kev_sample_and_reference(store, xas_arrays):
    x, y = xas_arrays
    reference_mu = np.interp(x - 4, x, y)
    project = store.create()
    request, i0, transmitted, reference_counts = detector_request(
        store, project, x, y, reference_mu, reverse=True)
    after = store.import_data(project["id"], request)
    assert after["version"] == 1 and len(after["groups"]) == 2
    sample = next(g for g in after["groups"] if g["reference_id"])
    reference = next(g for g in after["groups"] if g["id"] == sample["reference_id"])
    for group, expected_mu in ((sample, y), (reference, reference_mu)):
        assert_enforced(group)
        np.testing.assert_allclose(group["energy"], x, atol=2e-12, rtol=0)
        np.testing.assert_allclose(group["mu"], expected_mu, atol=1e-14, rtol=0)
        assert group["source"]["mapping"]["units"] == "keV"
        assert group["source"]["row_order"] == list(range(len(x) - 1, -1, -1))
    # Each channel must get its own fractional edge, not a copied sample E0.
    assert reference["parameters"]["e0"] - sample["parameters"]["e0"] == pytest.approx(4, abs=0.1)
    np.testing.assert_allclose(sample["source"]["raw_arrays"]["i0"], i0)
    np.testing.assert_allclose(sample["source"]["raw_arrays"]["signal"], transmitted)
    np.testing.assert_allclose(reference["source"]["raw_arrays"]["i0"], transmitted)
    np.testing.assert_allclose(reference["source"]["raw_arrays"]["signal"], reference_counts)
    assert sample["marked"] is True and reference["marked"] is False
    assert_saved(store, after)


def test_unusable_reference_rolls_back_an_otherwise_valid_sample(store, xas_arrays):
    x, y = xas_arrays
    project = store.create()
    # All detector counts are valid, but log(It/Ir)=0 has no absorption edge.
    request, *_ = detector_request(store, project, x, y, np.zeros_like(y))
    before = persisted_files(store, project)
    with pytest.raises((ScientificError, WebInputError), match="(?i)reference|constant|edge"):
        store.import_data(project["id"], request)
    assert_saved(store, project)
    assert persisted_files(store, project) == before


def test_chi_ignores_valid_policy_and_keeps_original_k_axis_and_transform(store):
    k = np.arange(0, 12.05, 0.05)
    chi = np.sin(2.2 * k) * np.exp(-0.15 * k)
    control = import_mu(store, store.create(), (k, chi), data_type="chi", units="keV")
    enforced = import_mu(store, store.create(), (k, chi), data_type="chi", units="keV", edge_policy=CU_POLICY)
    plain, policy = control["groups"][0], enforced["groups"][0]
    assert policy["processing_error"] is None
    assert policy["parameters"] == plain["parameters"]
    assert policy["result"]["arrays"] == plain["result"]["arrays"]
    assert policy["result"]["effective"] == plain["result"]["effective"]
    assert not policy["source"].get("e0_selection")
    assert policy["source"].get("edge_identity", {}).get("origin") != "enforced"
    np.testing.assert_array_equal(policy["energy"], k)
    np.testing.assert_array_equal(policy["mu"], chi)
    assert_saved(store, enforced)


@pytest.mark.parametrize("format", ["json", "prj"])
def test_exchange_and_lazy_preview_preserve_recipe_without_reexecuting_policy(store, copper, iron, format):
    source = import_mu(store, store.create(), copper, edge_policy=CU_POLICY)
    group = source["groups"][0]
    # A later E0 edit must survive old import provenance unchanged. Decreasing
    # E0 keeps the resolved spline maximum inside the available post-edge data.
    edited_e0 = group["parameters"]["e0"] - 3
    source = command(store, source, "parameters", [group["id"]], e0=edited_e0)
    saved = source["groups"][0]
    assert saved["source"]["e0_selection"]["e0"] != edited_e0
    payload = store.export_project(source["id"], format)
    target = import_mu(store, store.create(), iron, edge_policy={"element": "Fe", "edge": "K", "fraction": 0.4})
    before = deepcopy(target)
    preview = store.preview_project(target["id"], payload, f"saved.{format}")
    record = preview["groups"][0]
    assert record["id"] == saved["id"]
    assert record["points"] == len(saved["energy"])
    for mode in ("mu", "norm", "dmude"):
        curve = store.preview_project_group(target["id"], preview["upload_id"], saved["id"], mode)
        assert not curve.get("processing_error")
        arrays = saved["result"]["arrays"]
        indices = np.linspace(0, len(arrays["energy"]) - 1, min(800, len(arrays["energy"])), dtype=int)
        np.testing.assert_allclose(curve["x"], np.asarray(arrays["energy"])[indices], atol=1e-10)
        np.testing.assert_allclose(curve["y"], np.asarray(arrays[mode])[indices], atol=1e-10)
    assert_saved(store, before)
    restored = store.restore_upload(target["id"], RestoreUploadRequest(
        version=target["version"], upload_id=preview["upload_id"]))
    assert restored["groups"][:-1] == before["groups"]
    added = restored["groups"][-1]
    assert added["parameters"] == saved["parameters"]
    assert added["parameters"]["e0"] == edited_e0
    for key in SOURCE_KEYS:
        assert added["source"][key] == saved["source"][key]
    np.testing.assert_array_equal(added["energy"], saved["energy"])
    np.testing.assert_array_equal(added["mu"], saved["mu"])
    np.testing.assert_allclose(added["result"]["arrays"]["norm"], saved["result"]["arrays"]["norm"], atol=1e-10)
    # Neither the destination's earlier Fe request nor restored Cu provenance
    # becomes a default for an ordinary later request.
    after = import_mu(store, restored, iron)
    assert after["groups"][:-1] == restored["groups"]
    assert after["groups"][-1]["parameters"]["e0"] is None
    assert not after["groups"][-1]["source"].get("edge_policy")
    assert_saved(store, after)


def test_independent_larch_reader_sees_native_identity_fraction_and_actual_e0(store, copper, tmp_path):
    project = import_mu(store, store.create(), copper, edge_policy=CU_POLICY)
    group = project["groups"][0]
    path = tmp_path / "enforced-cu.prj"
    path.write_bytes(store.export_project(project["id"], "prj"))
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    assert list(native.groups) == [group["id"]]
    read = native.groups[group["id"]]
    assert read.athena_params.bkg.z == "Cu"
    assert read.athena_params.fft.edge.upper() == "K"
    assert read.athena_params.bkg.e0_fraction == 0.65
    assert read.athena_params.bkg.e0 == group["parameters"]["e0"]
    np.testing.assert_array_equal(read.energy, group["energy"])
    np.testing.assert_array_equal(read.mu, group["mu"])


def test_native_args_without_web_sidecar_are_metadata_not_future_policy(store, copper, iron):
    source = import_mu(store, store.create(), copper, edge_policy=CU_POLICY)
    saved = source["groups"][0]
    text = gzip.decompress(store.export_project(source["id"], "prj")).decode()
    payload = gzip.compress("\n".join(line for line in text.splitlines()
        if not line.startswith("# Athena-Web ")).encode())
    target = store.create()
    restored = store.restore(target["id"], 0, payload, "native-only.prj")
    group = restored["groups"][0]
    assert group["processing_error"] is None
    assert group["parameters"]["e0"] == saved["parameters"]["e0"]
    args = group["source"]["native"]["args"]
    assert args["bkg_z"] == "Cu" and args["fft_edge"].upper() == "K"
    assert float(args["bkg_e0_fraction"]) == 0.65
    after = import_mu(store, restored, iron)
    assert after["groups"][0] == group
    assert after["groups"][-1]["processing_error"] is None
    assert 7105 < after["groups"][-1]["result"]["effective"]["e0"] < 7130
    assert after["groups"][-1]["parameters"]["e0"] is None
    assert not after["groups"][-1]["source"].get("edge_policy")
    assert_saved(store, after)


def test_undo_redo_restores_imported_data_and_provenance_without_setting_policy(store, copper, iron):
    initial = store.create()
    imported = import_mu(store, initial, copper, edge_policy=CU_POLICY)
    undone = command(store, imported, "undo")
    assert undone["groups"] == initial["groups"] == []
    redone = command(store, undone, "redo")
    assert redone["groups"] == imported["groups"]
    after = import_mu(store, redone, iron)
    assert after["groups"][0] == imported["groups"][0]
    assert after["groups"][-1]["parameters"]["e0"] is None
    assert not after["groups"][-1]["source"].get("edge_policy")
    assert [p["version"] for p in (initial, imported, undone, redone, after)] == [0, 1, 2, 3, 4]
    assert_saved(store, after)
    json.dumps(after, allow_nan=False)
