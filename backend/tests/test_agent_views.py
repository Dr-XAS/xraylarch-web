"""Projections that let a caller read a project without loading its arrays."""
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def example(client):
    """The bundled copper series (three foil temperatures and Cu2O), processed."""
    project = client.post("/api/athena/projects").json()
    response = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "example", "group_ids": [], "options": {}})
    assert response.status_code == 200, response.text
    return response.json()


def view(client, project, name):
    response = client.get(f"/api/athena/projects/{project['id']}", params={"view": name})
    assert response.status_code == 200, response.text
    return response.json()


def numeric_runs(value, path="$"):
    """Yield (path, length) for every list of numbers found anywhere below value."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from numeric_runs(item, f"{path}.{key}")
    elif isinstance(value, list):
        numbers = [item for item in value if isinstance(item, (int, float)) and not isinstance(item, bool)]
        if numbers:
            yield path, len(numbers)
        for index, item in enumerate(value):
            yield from numeric_runs(item, f"{path}[{index}]")


def test_summary_carries_no_spectra(client, example):
    summary = view(client, example, "summary")
    oversized = {path: length for path, length in numeric_runs(summary) if length > 2}
    assert not oversized, f"summary leaked array data at {oversized}"


def test_summary_is_a_fraction_of_the_full_record(client, example):
    full = client.get(f"/api/athena/projects/{example['id']}").json()
    summary = view(client, example, "summary")
    full_bytes = len(json.dumps(full))
    summary_bytes = len(json.dumps(summary))
    assert full_bytes > 300_000, "the copper example should still be the large payload"
    assert summary_bytes < full_bytes / 100
    assert summary_bytes / len(summary["groups"]) < 700


def test_summary_reports_what_processing_resolved(client, example):
    summary = view(client, example, "summary")
    assert summary["counts"] == {
        "marked": 4, "frozen": 0, "groups": 5, "processed": 5, "failed": 0}
    for group in summary["groups"]:
        assert group["element"] == "Cu" and group["edge"] == "K"
        assert 8970 < group["e0"] < 8990
        assert group["edge_step"] > 0
        assert group["exafs"] is True
        assert group["available_kmax"] > 10
        assert group["axis"] == "energy"
        assert group["range"][0] < group["e0"] < group["range"][1]
        assert group["points"] > 100


def test_range_follows_the_axis_e0_is_quoted_on(client, example):
    """energy_shift is folded into the reported range, so e0 and range agree."""
    target = example["groups"][0]
    shifted = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "parameters",
        "group_ids": [target["id"]], "options": {"energy_shift": 25.0}}).json()

    before = target["energy"][0]
    group = next(g for g in view(client, shifted, "summary")["groups"] if g["id"] == target["id"])
    assert group["energy_shift"] == 25.0
    assert group["range"][0] == pytest.approx(before + 25.0)


def test_parameters_view_keeps_requested_and_effective_apart(client, example):
    parameters = view(client, example, "parameters")
    group = parameters["groups"][0]
    assert group["requested"]["e0"] is None, "the example asks Larch to resolve e0"
    assert group["effective"]["e0"] > 0, "processing resolved it"
    assert not [path for path, length in numeric_runs(parameters) if length > 2]


def test_analyses_are_flagged_once_the_project_moves_on(client, example):
    ids = [group["id"] for group in example["groups"]]
    analysis = client.post(f"/api/athena/projects/{example['id']}/analyze", json={
        "version": example["version"], "action": "pca", "group_ids": ids, "options": {}})
    assert analysis.status_code == 200, analysis.text

    summary = view(client, example, "summary")
    assert [entry["stale"] for entry in summary["analyses"]] == [False]

    moved = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "project",
        "group_ids": [], "options": {"name": "renamed"}}).json()
    summary = view(client, moved, "summary")
    assert [entry["stale"] for entry in summary["analyses"]] == [True]
    assert not [path for path, length in numeric_runs(summary["analyses"]) if length > 2]


def test_full_remains_the_default(client, example):
    default = client.get(f"/api/athena/projects/{example['id']}").json()
    assert default["groups"][0]["energy"], "existing callers still receive arrays"
    assert default == client.get(
        f"/api/athena/projects/{example['id']}", params={"view": "full"}).json()


def test_an_unknown_view_is_rejected(client, example):
    response = client.get(f"/api/athena/projects/{example['id']}", params={"view": "sketch"})
    assert response.status_code == 422
    assert response.json()["error"]["fields"] == ["view"]


def command(client, project, action, group_ids=(), view=None, **options):
    response = client.post(
        f"/api/athena/projects/{project['id']}/command",
        params={"view": view} if view else None,
        json={"version": project["version"], "action": action,
              "group_ids": list(group_ids), "options": options})
    assert response.status_code == 200, response.text
    return response


def labelled(project, label):
    return next(group["id"] for group in project["groups"] if group["label"] == label)


def test_a_command_answers_in_the_view_it_was_asked_for(client, example):
    """The write that costs 500 KB to reply to is the one an agent makes most."""
    full = command(client, example, "project", name="renamed")
    summary = command(client, full.json(), "project", view="summary", name="again")

    body = summary.json()
    assert body["name"] == "again" and body["version"] == full.json()["version"] + 1
    assert body["last_operation"]["action"] == "project"
    assert len(summary.content) < len(full.content) / 100
    assert not [path for path, length in numeric_runs(body) if length > 2]


def test_a_command_without_a_view_still_answers_in_full(client, example):
    response = command(client, example, "project", name="renamed")
    assert response.json()["groups"][0]["energy"], "the browser still gets its arrays"


def test_a_truncate_reports_its_removed_points_as_a_shape(client, example):
    """last_operation lists every index a point edit removed; hundreds after a truncate."""
    target = labelled(example, "Cu foil · 10 K")
    body = command(client, example, "truncate", [target], view="summary",
                   mode="truncate", side="after", value=10146.0).json()

    removed = body["last_operation"]["point_edit_results"][0]["removed_indices"]
    assert removed.startswith("<") and "numbers" in removed
    assert not [path for path, length in numeric_runs(body) if length > 8]


def test_a_merge_says_which_groups_it_left_out(client, example):
    """Selecting three scans is not merging three scans.

    The default merge drops a spectrum more than ten points shorter than the
    first, and the 300 K scan is 204 shorter. A caller that checks the selection
    it sent will report three; the summary has to say two, and why.
    """
    scans = [labelled(example, f"Cu foil · {t}") for t in ("10 K", "50 K", "300 K")]
    body = command(client, example, "merge", scans, view="summary",
                   method="demeter-larch").json()

    merged = next(group for group in body["groups"] if group["derived"])
    assert merged["derived"]["operation"] == "merge"
    assert merged["derived"]["parents"] == scans[:2]
    [excluded] = merged["derived"]["excluded"]
    assert excluded["id"] == scans[2] and excluded["label"] == "Cu foil · 300 K"
    assert "shorter" in excluded["reason"]
    assert all(group["derived"] is None for group in body["groups"] if group is not merged)

    [sample] = body["last_operation"]["merge"]["outputs"]
    assert [item["label"] for item in sample["excluded"]] == ["Cu foil · 300 K"]


def test_a_preview_can_leave_its_curves_behind(client, example):
    scans = [labelled(example, f"Cu foil · {t}") for t in ("10 K", "50 K")]
    body = {"version": example["version"], "action": "merge",
            "group_ids": scans, "options": {"method": "demeter-larch"}}
    url = f"/api/athena/projects/{example['id']}/merge/preview"
    full = client.post(url, json=body)
    summary = client.post(url, json=body, params={"view": "summary"})

    assert full.status_code == summary.status_code == 200
    assert len(summary.content) < len(full.content) / 10
    assert "numbers," in summary.text, "the elision has to be visible"
    assert not [path for path, length in numeric_runs(summary.json()) if length > 8]
    assert summary.json()["version"] == full.json()["version"] == example["version"]

    log = client.get(f"/api/athena/projects/{example['id']}/transcript").json()
    assert [record["preview"] for record in log["records"][-2:]] == [True, True]


def test_a_preview_rejects_a_view_it_cannot_draw(client, example):
    response = client.post(
        f"/api/athena/projects/{example['id']}/merge/preview", params={"view": "parameters"},
        json={"version": example["version"], "action": "merge", "group_ids": [], "options": {}})
    assert response.status_code == 422


def test_an_oversized_operation_detail_is_described_not_sent(client, example):
    """The example attaches a 30 KB Artemis fit setup to last_operation."""
    operation = view(client, example, "summary")["last_operation"]
    assert operation["action"] == "example"
    marker = operation["artemis_example"]
    assert marker.startswith("<") and "KB omitted" in marker and "group_id" in marker
