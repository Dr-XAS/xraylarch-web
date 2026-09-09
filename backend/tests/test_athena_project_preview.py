"""Staged project selection, ephemeral scientific previews, and subset export."""
from copy import deepcopy
import gzip
import json

from fastapi import FastAPI
from larch.io import read_athena
import numpy as np
import pytest

import xraylarch_web.athena as athena
from xraylarch_web.athena import AthenaStore, Command, RestoreUploadRequest, build_athena_router
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from test_athena_project import command, store


@pytest.fixture
def native_document(xas_arrays):
    x, y = xas_arrays
    doc = {"_____header1": "# Athena project file -- Demeter version 0.9.26",
           "_____order": ["sample/A", "reference/B", "other/C"],
           "_____journal": ["Before annealing", "After annealing"],
           "_____lcf": {"fit": "retained native state"}}
    for index, key in enumerate(doc["_____order"]):
        doc[key] = {"args": {"label": "Same label", "datatype": "xmu", "bkg_eshift": 2.5,
            "bkg_e0": 8982.5, "bkg_nor1": 30, "bkg_nor2": 300,
            "annotation": f"Notes for {key}", "referencegroup": "reference/B" if index == 0 else ""},
            "x": x.tolist(), "y": (y * (1 + index / 10)).tolist(),
            "i0": (1e6 + np.arange(len(x))).tolist()}
    return doc


@pytest.fixture
def reported_project(store, native_document):
    document = deepcopy(native_document)
    # Larch's legacy reader indexes records by sanitized label before applying
    # use_hashkey, so its independent compatibility fixture needs unique labels.
    # The preview/selection fixtures above deliberately keep duplicate labels.
    for key in document["_____order"]:
        document[key]["args"]["label"] = key.replace("/", " ")
    empty = store.create()
    p = store.restore(empty["id"], 0, json.dumps(document).encode(), "native.prj")
    ids = [g["id"] for g in p["groups"]]
    store.analyze(p["id"], Command(version=p["version"], action="pca", group_ids=ids[:2], options={"array": "mu"}))
    store.analyze(p["id"], Command(version=p["version"], action="pca", group_ids=ids[1:], options={"array": "mu"}))
    return store.load(p["id"])


def restore_staged(store, p, preview, selected=None, version=None):
    return store.restore_upload(p["id"], RestoreUploadRequest(
        version=p["version"] if version is None else version, upload_id=preview["upload_id"], group_ids=selected))


@pytest.mark.parametrize("format", ["native_json", "gzip_json", "web_json", "perl", "gzip_perl"])
def test_preview_is_sampled_nonprocessing_and_does_not_edit_destination(store, native_document, monkeypatch, format):
    data = json.dumps(native_document).encode()
    source = None
    if format in ("web_json", "perl", "gzip_perl"):
        original = store.create()
        source = store.restore(original["id"], 0, data, "native.prj")
        data = json.dumps(source).encode() if format == "web_json" else store.export_prj(source)
        if format == "perl":
            data = gzip.decompress(data)
    elif format == "gzip_json":
        data = gzip.compress(data)
    destination = store.create()
    before = store.storage.path(destination["id"], "project.json").read_bytes()
    def forbidden(*args, **kwargs):
        pytest.fail("Inspection must not process spectra")
    monkeypatch.setattr(store, "make_group", forbidden)
    monkeypatch.setattr(store, "process", forbidden)
    preview = store.preview_project(destination["id"], data, "folder/scan.prj")
    assert preview["filename"] == "scan.prj"
    assert preview["format"] == {"web_json": "athena-web", "perl": "athena-perl", "gzip_perl": "athena-perl"}.get(format, "athena-json")
    expected_ids = [g["id"] for g in source["groups"]] if source else native_document["_____order"]
    assert [g["id"] for g in preview["groups"]] == expected_ids
    for item, key in zip(preview["groups"], native_document["_____order"], strict=True):
        full = native_document[key]
        assert item["points"] == len(full["x"]) == 1201
        assert len(item["x"]) == len(item["y"]) == 800
        assert item["x"][0] == full["x"][0] + 2.5 and item["x"][-1] == full["x"][-1] + 2.5
        assert item["y"][0] == full["y"][0] and item["y"][-1] == full["y"][-1]
        assert item["data_type"] == "mu" and item["notes"] == full["args"]["annotation"]
        assert "result" not in item and "source" not in item
    assert preview["journal"] == "Before annealing\nAfter annealing"
    assert store.load(destination["id"]) == destination
    assert store.storage.path(destination["id"], "project.json").read_bytes() == before
    staged, filename = store._read_project_upload(destination["id"], preview["upload_id"])
    assert staged == data and filename == "scan.prj"


@pytest.mark.parametrize("mode", ["norm", "flat", "dmude", "chi"])
def test_lazy_preview_processes_full_saved_data_and_ignores_cached_results(store, reported_project, monkeypatch, mode):
    original = reported_project["groups"][0]
    document = deepcopy(reported_project)
    document["groups"][0]["result"]["arrays"][mode] = [12345] * 800
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(document).encode(), "cached.json")
    processing = store.process
    calls = []
    def record_call(g, project=None):
        calls.append((len(g["energy"]), g["parameters"]))
        return processing(g, project)
    monkeypatch.setattr(store, "process", record_call)
    curve = store.preview_project_group(target["id"], preview["upload_id"], original["id"], mode)
    assert calls == [(1201, original["parameters"])]
    arrays = original["result"]["arrays"]
    full_x, full_y = arrays["k" if mode == "chi" else "energy"], arrays[mode]
    indices = np.linspace(0, len(full_x) - 1, min(800, len(full_x)), dtype=int)
    np.testing.assert_allclose(curve["x"], np.asarray(full_x)[indices])
    np.testing.assert_allclose(curve["y"], np.asarray(full_y)[indices], atol=1e-10)
    assert not curve.get("processing_error")
    assert curve["mode"] == mode and curve["label"] == original["label"]
    assert store.load(target["id"]) == target


@pytest.mark.parametrize("failure", ["invalid_recipe", "unusable_range", "xanes_chi"])
def test_lazy_processing_failures_preserve_raw_preview_and_destination(store, native_document, failure):
    args = native_document["sample/A"]["args"]
    if failure == "invalid_recipe":
        args["fft_kwindow"] = "unsupported-window"
    elif failure == "unusable_range":
        args["bkg_nor2"] = 1000
    else:
        args["datatype"] = "xanes"
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "incompatible.prj")
    curve = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "chi")
    assert curve["processing_error"] and curve["x"] == curve["y"] == []
    raw = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "mu")
    assert raw["x"] == preview["groups"][0]["x"] and raw["y"] == preview["groups"][0]["y"]
    assert store.load(target["id"]) == target


def test_native_chi_preview_preserves_k_axis_without_processing(store, native_document, monkeypatch):
    native_document["_____order"] = ["sample/A"]
    native_document = {k: v for k, v in native_document.items() if k.startswith("_____") or k == "sample/A"}
    record = native_document["sample/A"]
    k = np.arange(0, 12, .05)
    record.update(x=k.tolist(), y=np.sin(4*k).tolist(), i0=[1] * len(k))
    record["args"].update(datatype="chi", referencegroup="", bkg_eshift=10)
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "chi.prj")
    monkeypatch.setattr(store, "make_group", lambda *a, **kw: pytest.fail("Raw chi preview must not process"))
    curve = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "chi")
    assert curve["data_type"] == "chi"
    np.testing.assert_array_equal(curve["x"], k)
    assert curve["x"] == preview["groups"][0]["x"]


def test_subset_import_uses_original_ids_file_order_and_full_detector_arrays(store, native_document):
    target = command(store, store.create(), "project", name="Existing study", journal="Existing journal")
    preview = store.preview_project(target["id"], gzip.compress(json.dumps(native_document).encode()), "incoming.prj")
    restored = restore_staged(store, target, preview, ["other/C", "sample/A"])
    assert [g["notes"] for g in restored["groups"]] == ["Notes for sample/A", "Notes for other/C"]
    for g, key in zip(restored["groups"], ["sample/A", "other/C"], strict=True):
        np.testing.assert_array_equal(g["energy"], native_document[key]["x"])
        np.testing.assert_array_equal(g["mu"], native_document[key]["y"])
        np.testing.assert_array_equal(g["source"]["raw_arrays"]["i0"], native_document[key]["i0"])
        assert g["parameters"]["energy_shift"] == 2.5
    assert restored["groups"][0]["reference_id"] is None
    assert any("reference/B" in message and "not selected" in message for message in restored["import_warnings"])
    assert restored["name"] == "Existing study"
    assert restored["journal"] == "Existing journal\nBefore annealing\nAfter annealing"
    assert not restored.get("native_projects")
    assert command(store, restored, "undo")["groups"] == target["groups"]


@pytest.mark.parametrize("selection", [None, [], "all_reversed", "subset"])
def test_only_full_selection_restores_analyses_and_remaps_links(store, reported_project, selection):
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(reported_project).encode(), "reports.json")
    ids = [g["id"] for g in preview["groups"]]
    selected = list(reversed(ids)) if selection == "all_reversed" else ids[:2] if selection == "subset" else selection
    restored = restore_staged(store, target, preview, selected)
    assert restored["name"] == reported_project["name"]
    assert restored["groups"][0]["reference_id"] == restored["groups"][1]["id"]
    if selection == "subset":
        assert restored["analyses"] == [] and len(restored["groups"]) == 2
        assert any("Partial project import" in w for w in restored["import_warnings"])
    else:
        assert len(restored["groups"]) == 3 and len(restored["analyses"]) == 2
        assert all(record["project_version"] == restored["version"] for record in restored["analyses"])
        assert restored["analyses"][0]["group_ids"] == [g["id"] for g in restored["groups"][:2]]
        assert store.load(target["id"])["analyses"] == restored["analyses"]


def test_restore_conflict_keeps_upload_for_retry_at_current_version(store, native_document):
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "retry.prj")
    current = command(store, target, "project", name="Concurrent edit")
    with pytest.raises(WebInputError) as exc:
        restore_staged(store, target, preview)
    assert exc.value.code == "stale_revision" and store.load(target["id"]) == current
    restored = restore_staged(store, current, preview, ["sample/A", "reference/B"])
    assert restored["version"] == current["version"] + 1
    assert restored["name"] == "Concurrent edit"
    assert store._read_project_upload(target["id"], preview["upload_id"])[0]


@pytest.mark.parametrize("selection", [["missing"], ["sample/A", "sample/A"], [""]])
def test_invalid_selection_rejects_before_any_processing(store, native_document, monkeypatch, selection):
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "invalid-selection.prj")
    monkeypatch.setattr(store, "make_group", lambda *a, **kw: pytest.fail("Invalid selection reached processing"))
    with pytest.raises(WebInputError):
        restore_staged(store, target, preview, selection)
    assert store.load(target["id"]) == target


def test_upload_tokens_are_workspace_local_and_not_file_paths(store, native_document):
    target, other = store.create(), store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "private.prj")
    with pytest.raises(WebInputError, match="another workspace"):
        restore_staged(store, other, preview)
    with pytest.raises(ValueError):
        RestoreUploadRequest(version=0, upload_id="../../project.json")
    with pytest.raises(WebInputError, match="not present"):
        store.preview_project_group(target["id"], preview["upload_id"], "../../project.json")
    assert store.load(other["id"]) == other


@pytest.mark.parametrize("problem", ["duplicate_ids", "nonfinite", "mismatched_arrays", "bad_source", "bad_analyses"])
def test_invalid_preview_is_not_staged_or_imported(store, native_document, reported_project, problem):
    document = deepcopy(reported_project) if problem.startswith("bad_") else deepcopy(native_document)
    if problem == "duplicate_ids":
        document["_____order"] = ["sample/A", "sample/A"]
    elif problem == "nonfinite":
        document["sample/A"]["y"][0] = float("nan")
    elif problem == "mismatched_arrays":
        document["sample/A"]["x"].pop()
    elif problem == "bad_source":
        document["groups"][0]["source"] = []
    else:
        document["analyses"][0]["group_ids"] = "wrong type"
    target = store.create()
    with pytest.raises(ValueError):
        store.preview_project(target["id"], json.dumps(document).encode(), "bad.prj")
    assert not list(store.storage.workspace_dir(target["id"]).glob("project-upload-*"))
    assert store.load(target["id"]) == target


def test_preview_rejects_executable_perl_without_running_payload(store, reported_project, tmp_path):
    marker = tmp_path / "must-not-exist"
    payload = gzip.decompress(store.export_prj(reported_project))
    payload += f"\n$malicious = __import__('pathlib').Path({str(marker)!r}).touch();\n".encode()
    target = store.create()
    with pytest.raises(ValueError):
        store.preview_project(target["id"], payload, "malicious.prj")
    assert not marker.exists()
    assert not list(store.storage.workspace_dir(target["id"]).glob("project-upload-*"))


def test_preview_rejects_overflowing_json_metadata_before_staging(store, reported_project):
    document = deepcopy(reported_project)
    document["groups"][0]["source"]["counter"] = "overflow-marker"
    data = json.dumps(document).replace('"overflow-marker"', '1e999').encode()
    target = store.create()
    with pytest.raises(WebInputError, match="non-finite"):
        store.preview_project(target["id"], data, "overflow.json")
    assert not list(store.storage.workspace_dir(target["id"]).glob("project-upload-*"))
    assert store.load(target["id"]) == target


@pytest.mark.parametrize("pointer", ["reference_id", "background_standard_id"])
def test_full_import_keeps_reports_stale_when_a_missing_pointer_is_cleared(store, reported_project, pointer):
    document = deepcopy(reported_project)
    document["groups"][0][pointer] = "missing-reference"
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(document).encode(), "missing-reference.json")
    restored = restore_staged(store, target, preview)
    assert restored["groups"][0][pointer] is None
    assert restored["analyses"][0]["project_version"] != restored["version"]
    assert restored["analyses"][1]["project_version"] == restored["version"]


@pytest.mark.parametrize("bound", ["compressed_bytes", "expanded_bytes", "points", "total_values"])
def test_preview_enforces_resource_bounds_before_staging(tmp_path, native_document, monkeypatch, bound):
    settings = Settings(data_root=tmp_path, max_upload_bytes=1000) if "bytes" in bound else Settings(data_root=tmp_path, max_points=1000 if bound == "points" else 250000)
    limited = AthenaStore(settings)
    target = limited.create()
    data = json.dumps(native_document).encode()
    if bound == "expanded_bytes":
        data = gzip.compress(b" " * 1001)
    elif bound == "total_values":
        monkeypatch.setattr(athena, "_EXCHANGE_MAX_VALUES", 4000)
    with pytest.raises(WebInputError):
        limited.preview_project(target["id"], data, "too-large.prj")
    assert not list(limited.storage.workspace_dir(target["id"]).glob("project-upload-*"))


def test_staged_cache_has_explicit_count_and_byte_bounds(store, native_document, tmp_path):
    data = json.dumps(native_document).encode()
    target = store.create()
    uploads = [store.preview_project(target["id"], data, f"scan-{i}.prj") for i in range(11)]
    assert len(list(store.storage.workspace_dir(target["id"]).glob("project-upload-*.bin"))) == 10
    with pytest.raises(WebInputError, match="expired"):
        store._read_project_upload(target["id"], uploads[0]["upload_id"])
    assert store._read_project_upload(target["id"], uploads[-1]["upload_id"])[0] == data
    limited = AthenaStore(Settings(data_root=tmp_path / "limited", max_upload_bytes=len(data) + 100))
    target = limited.create()
    for i in range(3):
        limited.preview_project(target["id"], data, f"scan-{i}.prj")
    files = list(limited.storage.workspace_dir(target["id"]).glob("project-upload-*.bin"))
    assert len(files) == 2 and sum(p.stat().st_size for p in files) <= 2 * limited.settings.max_upload_bytes


@pytest.mark.parametrize("format", ["json", "prj"])
def test_selected_export_preserves_order_filters_reports_and_marks_retained_stale(store, reported_project, tmp_path, format):
    ids = [g["id"] for g in reported_project["groups"]]
    data = store.export_project(reported_project["id"], format, list(reversed(ids[:2])))
    target = store.create()
    preview = store.preview_project(target["id"], data, f"selected.{format}")
    assert [g["id"] for g in preview["groups"]] == ids[:2]
    restored = restore_staged(store, target, preview)
    assert len(restored["groups"]) == 2 and len(restored["analyses"]) == 1
    assert restored["analyses"][0]["project_version"] != restored["version"]
    assert restored["analyses"][0]["group_ids"] == [g["id"] for g in restored["groups"]]
    assert restored["groups"][0]["reference_id"] == restored["groups"][1]["id"]
    assert restored["analyses"][0]["result"] == reported_project["analyses"][0]["result"]
    assert store.load(reported_project["id"]) == reported_project
    if format == "prj":
        path = tmp_path / "independent-reader.prj"
        path.write_bytes(data)
        native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
        assert list(native.groups) == ids[:2]
        for key in ids[:2]:
            np.testing.assert_array_equal(native.groups[key].energy, store.group(reported_project, key)["energy"])


def test_selected_export_clears_omitted_reference_and_checks_nested_analysis_dependencies(store, reported_project):
    ids = [g["id"] for g in reported_project["groups"]]
    document = deepcopy(reported_project)
    document["analyses"][0]["options"]["reference_id"] = ids[2]
    selected = store.project_for_export(document, ids[:2])
    assert selected["analyses"] == []
    single = store.project_for_export(reported_project, [ids[0]])
    assert single["groups"][0]["reference_id"] is None
    assert any("reference" in w and "omitted" in w for w in single["import_warnings"])
    with pytest.raises(WebInputError):
        store.export_project(reported_project["id"], "json", ["unknown"])
    assert store.load(reported_project["id"]) == reported_project


def test_marked_export_does_not_turn_empty_marked_selection_into_all(store, reported_project):
    ids = [g["id"] for g in reported_project["groups"]]
    p = command(store, reported_project, "metadata", [ids[1]], marked=False)
    data = json.loads(store.export_project(p["id"], "json", marked_only=True))
    assert [g["id"] for g in data["groups"]] == [ids[0], ids[2]]
    p = command(store, p, "metadata", ids, marked=False)
    with pytest.raises(WebInputError, match="No marked"):
        store.export_project(p["id"], "json", marked_only=True)
    assert len(json.loads(store.export_project(p["id"], "json", []))["groups"]) == 3


def test_project_preview_endpoint_contract_and_slash_ids(tmp_path):
    app = FastAPI()
    router = build_athena_router(Settings(data_root=tmp_path))
    app.include_router(router)
    paths = app.openapi()["paths"]
    base = "/api/athena/projects/{ident}"
    assert "multipart/form-data" in paths[base + "/preview-project"]["post"]["requestBody"]["content"]
    assert "application/json" in paths[base + "/restore-upload"]["post"]["requestBody"]["content"]
    route = next(route for route in router.routes if "preview-project/{upload_id}/groups" in route.path)
    match = route.path_regex.fullmatch("/api/athena/projects/workspace/preview-project/upload/groups/sample/A")
    assert match and match.groupdict()["group_id"] == "sample/A"
    params = {p["name"]: p["schema"] for p in paths[base + "/export"]["get"]["parameters"]}
    assert any(schema.get("type") == "array" for schema in params["group_ids"]["anyOf"])


@pytest.mark.parametrize("value,expected", [("0", False), ("1", True), (0, False), (1, True)])
def test_native_fnorm_decodes_boolean_and_survives_prj_exchange(store, native_document, value, expected):
    native_document["sample/A"]["args"]["bkg_funnorm"] = value
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "fnorm.prj")
    assert preview["groups"][0]["parameters"]["fnorm"] is expected
    restored = restore_staged(store, target, preview)
    assert restored["groups"][0]["parameters"]["fnorm"] is expected
    assert restored["groups"][0]["result"]["effective"]["fnorm"] is expected
    data = store.export_prj(restored)
    # Check the native mapping independently of the web sidecar recipe.
    data = b"\n".join(line for line in gzip.decompress(data).splitlines() if not line.startswith(b"# Athena-Web "))
    destination = store.create()
    reread = store.restore(destination["id"], 0, data, "native-fnorm.prj")
    assert reread["groups"][0]["parameters"]["fnorm"] is expected


@pytest.mark.parametrize("value", ["2", 2, "falsey"])
def test_native_fnorm_rejects_non_boolean_numbers_and_strings(store, native_document, value):
    native_document["sample/A"]["args"]["bkg_funnorm"] = value
    target = store.create()
    with pytest.raises(WebInputError, match="boolean"):
        store.preview_project(target["id"], json.dumps(native_document).encode(), "bad-boolean.prj")
    assert store.load(target["id"]) == target


@pytest.mark.parametrize("format", ["web_json", "sidecar_prj", "native_prj"])
def test_background_standard_exchange_is_distinct_from_reference_and_processed_after_remapping(store, native_document, format):
    native_document["sample/A"]["args"]["bkg_stan"] = "other/C"
    target = store.create()
    source = store.restore(target["id"], 0, json.dumps(native_document).encode(), "standard.prj")
    sample, reference, standard = source["groups"]
    assert sample["reference_id"] == reference["id"]
    assert sample["background_standard_id"] == standard["id"]
    assert sample["processing_error"] is None
    assert sample["result"]["effective"]["background_standard"] is True
    data = json.dumps(source).encode() if format == "web_json" else store.export_prj(source)
    if format == "native_prj":
        data = b"\n".join(line for line in gzip.decompress(data).splitlines() if not line.startswith(b"# Athena-Web "))
    destination = store.create()
    preview = store.preview_project(destination["id"], data, "standard-roundtrip.prj")
    assert preview["groups"][0]["background_standard_id"] == standard["id"]
    restored = restore_staged(store, destination, preview)
    actual, actual_reference, actual_standard = restored["groups"]
    assert actual["reference_id"] == actual_reference["id"]
    assert actual["background_standard_id"] == actual_standard["id"]
    assert actual["result"]["effective"]["background_standard_id"] == actual_standard["id"]
    assert actual["processing_error"] is None
    np.testing.assert_allclose(actual["result"]["arrays"]["chi"], sample["result"]["arrays"]["chi"], atol=1e-10)
    assert store.load(destination["id"]) == restored


def test_lazy_preview_resolves_full_standard_chain_without_destination_edits(store, native_document, monkeypatch):
    from xraylarch_web.athena_science import process_spectrum
    native_document["sample/A"]["args"]["bkg_stan"] = "other/C"
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "chain.prj")
    records = store._parse_project(json.dumps(native_document).encode(), "chain.prj")["groups"]
    standard = process_spectrum(records[2]["energy"], records[2]["mu"], records[2]["parameters"])
    expected = process_spectrum(records[0]["energy"], records[0]["mu"], records[0]["parameters"],
        background_standard={key: standard["arrays"][key] for key in ("k", "chi")})
    calls = []
    processing = store.process
    def record_call(g, project=None):
        calls.append(g["id"])
        return processing(g, project)
    monkeypatch.setattr(store, "process", record_call)
    curve = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "chi")
    assert calls == ["other/C", "sample/A"]
    assert not curve.get("processing_error")
    np.testing.assert_allclose(curve["x"], expected["arrays"]["k"])
    np.testing.assert_allclose(curve["y"], expected["arrays"]["chi"], atol=1e-10)
    assert store.load(target["id"]) == target


@pytest.mark.parametrize("standard_id", ["missing", "sample/A"])
def test_lazy_preview_never_silently_ignores_missing_or_cyclic_standard(store, native_document, standard_id):
    native_document["sample/A"]["args"]["bkg_stan"] = standard_id
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(native_document).encode(), "broken-standard.prj")
    curve = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "chi")
    assert curve["processing_error"] and curve["x"] == curve["y"] == []
    raw = store.preview_project_group(target["id"], preview["upload_id"], "sample/A", "mu")
    assert raw["x"] == preview["groups"][0]["x"]
    if standard_id == "sample/A":
        with pytest.raises(WebInputError, match="cycle"):
            restore_staged(store, target, preview)
    assert store.load(target["id"]) == target


def test_subset_omitting_standard_clears_only_that_pointer_and_drops_analysis_state(store, reported_project):
    document = deepcopy(reported_project)
    sample, reference, standard = document["groups"]
    sample["background_standard_id"] = standard["id"]
    target = store.create()
    preview = store.preview_project(target["id"], json.dumps(document).encode(), "omit-standard.json")
    restored = restore_staged(store, target, preview, [sample["id"], reference["id"]])
    actual = restored["groups"][0]
    assert actual["background_standard_id"] is None
    assert actual["reference_id"] == restored["groups"][1]["id"]
    assert any("Background standard" in w and "not selected" in w for w in restored["import_warnings"])
    assert actual["result"]["effective"]["background_standard"] is False
    assert restored["analyses"] == []
    selected_export = store.project_for_export(document, [sample["id"], reference["id"]])
    assert selected_export["groups"][0]["background_standard_id"] is None
    assert selected_export["analyses"][0]["project_version"] != selected_export["version"]
