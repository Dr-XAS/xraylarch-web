import copy
import json

from fastapi.testclient import TestClient
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_quality import QualityReport, duplicate_inputs, prepare_quality_report
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def group(ident="one", **updates):
    parameters = AthenaParameters(e0=7112, pre1=-200, norm2=800).model_dump()
    value = dict(
        id=ident, label="Repeated label", data_type="mu", marked=True, frozen=False,
        energy=[7000., 7112., 7800.], mu=[0., 1., 1.2], source={},
        is_normalized=False, is_difference=False, reference_id=None, background_standard_id=None,
        parameters=parameters, processing_error=None,
        result={"effective": dict(parameters, e0=7112., edge_step=1., exafs=True,
                                  pre1=-112., norm2=688., kmax=12., available_kmax=13.),
                "arrays": {"energy": [7000., 7112., 7800.]}, "warnings": []},
    )
    value.update(updates)
    return value


def report(*groups, scope="all"):
    return prepare_quality_report(
        dict(id="project", name="Review test", version=7, groups=list(groups)),
        QualityReport(version=7, scope=scope),
    )


def test_review_keeps_project_order_ids_and_exact_duplicate_inputs_outside_marks():
    first = group("one", frozen=True)
    second = group("two", marked=False)
    second["parameters"]["energy_shift"] = 2
    second["parameters"]["kweight"] = 3
    third = group("three", mu=[0., 1., 1.2000000001])
    project = dict(id="project", name="Review test", version=7, groups=[first, second, third])
    before = copy.deepcopy(project)
    result = prepare_quality_report(project, QualityReport(version=7, scope="marked"))
    assert [row["id"] for row in result["groups"]] == ["one", "three"]
    assert result["groups"][0]["duplicate_inputs"] == [{"id": "two", "label": "Repeated label"}]
    assert result["groups"][0]["frozen"] is True
    assert result["groups"][1]["duplicate_inputs"] == []
    assert result["counts"]["with_duplicate_inputs"] == 1
    assert project == before


@pytest.mark.parametrize("updates", [
    {"data_type": "detector"}, {"data_type": "xmudat"},
    {"source": {"tags": ["theory"]}}, {"source": {"operation": "difference"}},
    {"is_difference": True}, {"data_type": "chi"}, {"energy": []},
])
def test_duplicate_detection_excludes_nonmeasurement_signals_and_different_axes(updates):
    assert duplicate_inputs([group(), group("other", **updates)]) == {"one": [], "other": []}


def test_matching_measured_chi_inputs_are_duplicates_but_simulations_are_not():
    first, second = group(data_type="chi"), group("other", data_type="chi")
    assert duplicate_inputs([first, second])["one"] == [{"id": "other", "label": "Repeated label"}]
    second["source"]["tags"] = ["theory"]
    assert duplicate_inputs([first, second]) == {"one": [], "other": []}


def test_adjustments_show_explicit_applicable_ranges_and_omit_auto_and_roundoff():
    spectrum = group()
    spectrum["parameters"].update(kmin=3, kmax=None, bkg_kmax=13, rmin=1)
    spectrum["result"]["effective"].update(kmin=2.5, kmax=12, bkg_kmax=12.5, rmin=1 + 1e-12)
    row = report(spectrum)["groups"][0]
    assert row["adjustments"] == [
        {"parameter": "pre1", "requested": -200., "effective": -112., "unit": "eV relative to E0"},
        {"parameter": "norm2", "requested": 800., "effective": 688., "unit": "eV relative to E0"},
        {"parameter": "bkg_kmax", "requested": 13, "effective": 12.5, "unit": "Å⁻¹"},
        {"parameter": "kmin", "requested": 3, "effective": 2.5, "unit": "Å⁻¹"},
    ]


@pytest.mark.parametrize("updates", [{"data_type": "detector"}, {"is_difference": True},
                                      {"data_type": "norm"}, {"is_normalized": True}])
def test_inactive_normalization_settings_are_not_reported_as_adjustments(updates):
    assert report(group(**updates))["groups"][0]["adjustments"] == []


def test_failed_processing_never_claims_stale_effective_values_are_current():
    failed = group(processing_error="Invalid normalization window")
    failed["result"]["warnings"] = ["An old processing warning"]
    unprocessed = group("other", result=None)
    result = report(failed, unprocessed)
    row = result["groups"][0]
    assert row["status"] == "failed"
    assert row["processing_error"] == "Invalid normalization window"
    assert row["e0"] is row["edge_step"] is row["available_kmax"] is None
    assert row["exafs"] is False
    assert row["adjustments"] == row["warnings"] == []
    assert result["groups"][1]["status"] == "unprocessed"
    assert result["counts"]["failed"] == result["counts"]["unprocessed"] == 1
    assert result["counts"]["processed"] == 0


def test_shifted_energy_range_and_chi_axis_keep_their_units():
    energy, chi = group(), group("chi", data_type="chi", energy=[2., 4., 8.])
    energy["parameters"]["energy_shift"] = 3
    chi["parameters"]["energy_shift"] = 17
    rows = report(energy, chi)["groups"]
    assert rows[0]["axis"] == "energy" and rows[0]["range"] == [7003., 7803.]
    assert rows[1]["axis"] == "k" and rows[1]["range"] == [2., 8.]


def test_notices_and_xanes_intent_are_distinct_from_failed_processing():
    spectrum = group(data_type="xanes")
    spectrum["result"]["effective"]["exafs"] = False
    spectrum["result"]["warnings"] = ["Saved processing notice"]
    result = report(spectrum)
    assert result["groups"][0]["status"] == "processed"
    assert result["groups"][0]["warnings"] == ["Saved processing notice"]
    assert any("XANES processing is selected" in note for note in result["groups"][0]["notes"])
    assert result["counts"]["failed"] == 0 and result["counts"]["with_warnings"] == 1
    assert "not a quality score" in " ".join(result["notes"])


def test_saved_source_notices_are_preserved_without_duplicates_or_arbitrary_metadata():
    spectrum = group(source={"warnings": ["Input notice", "Input notice", {"arbitrary": [1, 2]}]})
    spectrum["result"]["warnings"] = ["Input notice", "Processing notice"]
    assert report(spectrum)["groups"][0]["warnings"] == ["Input notice", "Processing notice"]
    spectrum["source"]["warnings"] = "Unstructured imported metadata"
    assert report(spectrum)["groups"][0]["warnings"] == ["Input notice", "Processing notice"]


def test_empty_scope_has_zero_counts_and_report_contains_no_spectrum_arrays():
    empty = report(group(marked=False), scope="marked")
    assert empty["groups"] == [] and set(empty["counts"].values()) == {0}
    assert "Mark at least one" in empty["notes"][-1]
    exported = json.loads(json.dumps(report(group()), allow_nan=False))
    assert "arrays" not in exported["groups"][0]
    assert not {"energy", "mu", "parameters", "source"}.intersection(exported["groups"][0])


def test_real_processing_adjustments_use_saved_larch_values_without_reprocessing(tmp_path, xas_arrays, monkeypatch):
    store = AthenaStore(Settings(data_root=tmp_path))
    spectrum = store.make_group("Synthetic copper", *xas_arrays, parameters={"pre1": -1000., "norm2": 1000.})
    assert not spectrum["processing_error"]
    def forbidden(*args, **kwargs):
        raise AssertionError("Review must not process spectra")
    monkeypatch.setattr(store, "process", forbidden)
    row = report(spectrum)["groups"][0]
    assert {item["parameter"] for item in row["adjustments"]} == {"pre1", "norm2"}
    for item in row["adjustments"]:
        assert item["effective"] == spectrum["result"]["effective"][item["parameter"]]


def test_http_version_scope_validation_read_only_and_generation_conflict(tmp_path, xas_arrays, monkeypatch):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    project["groups"] = [store.make_group("Synthetic copper", *xas_arrays)]
    store.storage.write_json(project["id"], "project.json", project)
    route = f"/api/athena/projects/{project['id']}/quality-report"
    saved = store.storage.read_json(project["id"], "project.json")
    with TestClient(create_app(store.settings)) as client:
        for invalid in ({"version": False}, {"version": -1}, {"version": 0, "scope": "current"},
                        {"version": 0, "extra": True}):
            assert client.post(route, json=invalid).status_code == 422
        assert client.post(route, json={"version": 1}).status_code == 409
        response = client.post(route, json={"version": 0})
        assert response.status_code == 200, response.text
        assert response.json()["counts"]["groups"] == 1
        assert response.json()["groups"][0]["id"] == project["groups"][0]["id"]
        assert store.storage.read_json(project["id"], "project.json") == saved
        assert store.transcript.read(project["id"]) == []
        from xraylarch_web import athena_quality
        original = athena_quality.prepare_quality_report
        def changed(snapshot, request):
            result = original(snapshot, request)
            store.command(project["id"], Command(version=0, action="project", options={"name": "Changed during review"}))
            return result
        monkeypatch.setattr(athena_quality, "prepare_quality_report", changed)
        assert client.post(route, json={"version": 0}).status_code == 409


def test_duplicate_warning_survives_merge_preview_command_and_saved_review(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    project["groups"] = [store.make_group(label, *xas_arrays) for label in ("Scan", "Scan copy")]
    store.storage.write_json(project["id"], "project.json", project)
    base = f"/api/athena/projects/{project['id']}"
    request = dict(version=0, action="merge", group_ids=[group["id"] for group in project["groups"]],
                   options={"method": "demeter-larch", "merge_references": False})
    with TestClient(create_app(store.settings)) as client:
        preview = client.post(f"{base}/merge/preview?view=summary", json=request)
        assert preview.status_code == 200, preview.text
        warnings = preview.json()["outputs"][0]["result"]["warnings"]
        duplicate_warning = next(message for message in warnings if "identical input arrays" in message)
        assert store.load(project["id"])["version"] == 0
        saved = client.post(f"{base}/command?view=summary", json=request)
        assert saved.status_code == 200, saved.text
        merged = store.load(project["id"])["groups"][-1]
        assert duplicate_warning in merged["source"]["warnings"]
        review = client.post(f"{base}/quality-report", json={"version": saved.json()["version"]})
        assert review.status_code == 200, review.text
        row = next(group for group in review.json()["groups"] if group["id"] == merged["id"])
        assert duplicate_warning in row["warnings"]
