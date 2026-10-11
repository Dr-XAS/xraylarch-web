import copy
import json

from fastapi.testclient import TestClient
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_comparison import comparison_report
from xraylarch_web.athena_science import ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


PREFERENCES = {"sg_window": 31, "sg_order": 9}


@pytest.fixture
def project(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    project["groups"] = [store.make_group(label, *xas_arrays) for label in ("Reference", "Target", "Other")]
    project["groups"][0]["marked"] = False
    project["groups"][2]["marked"] = False
    assert not any(group["processing_error"] for group in project["groups"])
    return project


def run(project, scope="marked", reference=None):
    return comparison_report(project, reference or project["groups"][0]["id"], scope, PREFERENCES)


def test_explicit_unmarked_reference_order_duplicates_and_nonmutation(project):
    original = copy.deepcopy(project)
    report = run(project)
    assert report["reference_id"] == project["groups"][0]["id"]
    assert [row["id"] for row in report["groups"]] == [project["groups"][1]["id"]]
    row = report["groups"][0]
    assert row["e0_difference"] == 0 and row["edge_step_ratio"] == 1
    assert row["energy_shift"]["value"] == pytest.approx(0, abs=.001)
    assert row["xanes"]["max_difference"] == 0
    assert all(bin["ratio"] == 1 for bin in row["chi_amplitude"]["bins"])
    assert row["unavailable"] == {}
    assert [match["id"] for match in row["duplicate_inputs"]] == [project["groups"][0]["id"], project["groups"][2]["id"]]
    assert project == original
    assert "arrays" not in json.dumps(report)
    assert [row["id"] for row in run(project, "all", project["groups"][1]["id"])["groups"]] == [project["groups"][0]["id"], project["groups"][2]["id"]]


def test_xanes_reports_partial_interval_and_requires_three_points(project):
    reference, target = project["groups"][:2]
    e0 = reference["result"]["effective"]["e0"]
    energy = np.asarray(target["result"]["arrays"]["energy"])
    indices = np.flatnonzero((energy >= e0 - 5) & (energy < e0 + 12))
    for name in ("energy", "norm"):
        target["result"]["arrays"][name] = np.asarray(target["result"]["arrays"][name])[indices].tolist()
    row = run(project)["groups"][0]
    assert row["xanes"]["range"] == [energy[indices[0]], energy[indices[-1]]]
    assert row["xanes"]["points"] == len(indices) - 1
    assert any("clipped" in note for note in row["notes"])
    for name in ("energy", "norm"):
        target["result"]["arrays"][name] = target["result"]["arrays"][name][:2]
    row = run(project)["groups"][0]
    assert row["xanes"] is None and row["unavailable"]["xanes"]


def test_shift_range_records_evaluated_grid_and_actual_smoothing(project):
    from xraylarch_web.athena_alignment import fit_alignment
    reference, target = project["groups"][:2]
    prefs = {"sg_window": 10, "sg_order": 9}
    expected = fit_alignment(target, reference, smoothed=True, **prefs)
    report = comparison_report(project, reference["id"], "marked", prefs)
    row = report["groups"][0]
    assert row["energy_shift"]["range"] == [expected["curve"]["x"][0], expected["curve"]["x"][-1]]
    assert any(f"smoothing window {expected['summary']['smoothing_window']}" in note for note in row["notes"])
    assert any("window 10" in note for note in report["notes"])


@pytest.mark.parametrize("failed_index", [0, 1])
def test_failed_group_never_exposes_stale_calculated_metrics(project, failed_index):
    project["groups"][failed_index]["processing_error"] = "Failed with old result"
    report = run(project)
    row = report["groups"][0]
    for metric in ("e0_difference", "edge_step_ratio", "energy_shift", "xanes", "chi_amplitude"):
        assert row[metric] is None and row["unavailable"][metric]
    if failed_index == 0:
        assert report["reference"]["e0"] is None and report["reference"]["exafs"] is False


@pytest.mark.parametrize("kind", ["detector", "difference", "chi", "theory", "normalized", "different_edge"])
def test_applicability_and_edge_context_are_explicit(project, kind):
    reference, target = project["groups"][:2]
    if kind in ("detector", "chi"):
        target["data_type"] = kind
    elif kind == "difference": target["source"]["operation"] = "difference"
    elif kind == "theory": target["source"]["tags"] = ["theory"]
    elif kind == "normalized": target["is_normalized"] = True
    else:
        reference["source"]["edge_identity"] = {"element": "Cu", "edge": "K"}
        target["source"]["edge_identity"] = {"element": "Fe", "edge": "K"}
    row = run(project)["groups"][0]
    if kind in ("detector", "difference", "chi"):
        assert row["energy_shift"] is None and row["unavailable"]["energy_shift"]
    if kind in ("detector", "difference", "theory"):
        assert row["duplicate_inputs"] == []
    if kind in ("detector", "difference"):
        assert row["chi_amplitude"] is None
    if kind == "theory": assert any("calculated data" in note for note in row["notes"])
    if kind == "normalized": assert any("normalization convention" in note for note in row["notes"])
    if kind == "different_edge": assert any("Cu K" in note and "Fe K" in note for note in row["notes"])


def test_selection_validation_and_target_limit(project):
    with pytest.raises(ScientificError, match="not in this project"):
        run(project, reference="missing")
    with pytest.raises(ScientificError, match="all or marked"):
        run(project, scope="current")
    project["groups"][1]["marked"] = False
    with pytest.raises(ScientificError, match="at least one target"):
        run(project)
    template = copy.deepcopy(project["groups"][1])
    template.update(result=None, marked=True)
    project["groups"] = [project["groups"][0]] + [dict(copy.deepcopy(template), id=f"target-{i}") for i in range(100)]
    assert len(run(project)["groups"]) == 100
    project["groups"].append(dict(copy.deepcopy(template), id="target-101"))
    with pytest.raises(ScientificError, match="at most 100 target"):
        run(project)


def test_http_snapshot_validation_stale_revisions_and_no_writes(project, tmp_path, monkeypatch):
    store = AthenaStore(Settings(data_root=tmp_path))
    store.storage.write_json(project["id"], "project.json", project)
    original = copy.deepcopy(store.storage.read_json(project["id"], "project.json"))
    base = f"/api/athena/projects/{project['id']}"
    request = {"version": 0, "reference_id": project["groups"][0]["id"], "scope": "marked"}
    with TestClient(create_app(store.settings)) as client:
        for updates in ({"version": False}, {"version": -1}, {"reference_id": ""},
                        {"reference_id": "x" * 101}, {"scope": "current"}, {"extra": True}):
            assert client.post(f"{base}/comparison-report", json=request | updates).status_code == 422
        assert client.post(f"{base}/comparison-report", json=request | {"version": 1}).status_code == 409
        assert client.post(f"{base}/comparison-report", json=request | {"reference_id": "missing"}).status_code == 400
        response = client.post(f"{base}/comparison-report", json=request)
        assert response.status_code == 200, response.text
        assert response.json()["reference_id"] == request["reference_id"]
        assert store.storage.read_json(project["id"], "project.json") == original
        assert store.transcript.read(project["id"]) == []
        from xraylarch_web import athena_comparison
        original_report = athena_comparison.comparison_report
        def changed(*args, **kwargs):
            report = original_report(*args, **kwargs)
            store.command(project["id"], Command(version=0, action="project", options={"name": "Changed while comparing"}))
            return report
        monkeypatch.setattr(athena_comparison, "comparison_report", changed)
        assert client.post(f"{base}/comparison-report", json=request).status_code == 409


@pytest.mark.parametrize("identity", ["legacy unknown metadata", ["Cu", "K"]])
def test_restored_inert_edge_identity_preserves_metadata_and_supports_both_reports(project, tmp_path, identity):
    store = AthenaStore(Settings(data_root=tmp_path))
    project["groups"][0]["source"]["edge_identity"] = identity
    destination = store.create()
    restored = store.restore(destination["id"], 0, json.dumps(project).encode(), "synthetic-project.json")
    assert restored["groups"][0]["source"]["edge_identity"] == identity
    base = f"/api/athena/projects/{restored['id']}"
    with TestClient(create_app(store.settings), raise_server_exceptions=False) as client:
        summary = client.get(f"{base}?view=summary")
        assert summary.status_code == 200, summary.text
        assert summary.json()["groups"][0]["element"] is None
        response = client.post(f"{base}/comparison-report", json={"version": restored["version"],
                               "reference_id": restored["groups"][0]["id"], "scope": "all"})
        assert response.status_code == 200, response.text
        assert len(response.json()["groups"]) == 2
        review = client.post(f"{base}/quality-report", json={"version": restored["version"], "scope": "all"})
        assert review.status_code == 200, review.text
        assert len(review.json()["groups"]) == 3
    assert store.load(restored["id"])["groups"][0]["source"]["edge_identity"] == identity
