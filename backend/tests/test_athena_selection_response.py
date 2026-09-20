"""Selection replies omit spectra without changing persistence or undo semantics."""

from copy import deepcopy
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import xraylarch_web.athena as athena
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture(scope="module")
def spectrum(tmp_path_factory):
    store = AthenaStore(Settings(data_root=tmp_path_factory.mktemp("selection-spectrum")))
    data = np.loadtxt(Path(__file__).parents[2] / "examples/xafsdata/cu_rt01.xmu")
    return store.make_group("Copper", data[:, 0], data[:, 1])


@pytest.fixture
def workspace(tmp_path, spectrum, monkeypatch):
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    initial = store.create()
    groups = [dict(deepcopy(spectrum), id=f"group-{index}", marked=False, frozen=False)
              for index in range(2)]
    project = store.save({**initial, "groups": groups}, initial, "Test spectra")

    def forbidden(*args, **kwargs):
        pytest.fail("Marking or freezing must not recalculate scientific arrays")
    monkeypatch.setattr(AthenaStore, "process", forbidden)
    monkeypatch.setattr(athena, "process_spectrum", forbidden)
    with TestClient(create_app(settings)) as client:
        yield store, client, project


def command(client, project, **changes):
    payload = {"version": project["version"], "action": "metadata",
               "group_ids": [project["groups"][0]["id"]], "options": {"marked": True},
               "response_mode": "selection", **changes}
    return client.post(f"/api/athena/projects/{project['id']}/command", json=payload)


def files(store, project):
    return {path.name: path.read_bytes()
            for path in store.storage.workspace_dir(project["id"]).glob("*.json")}


def test_compact_reply_preserves_arrays_and_contains_complete_merge_state(workspace):
    store, client, before = workspace
    response = command(client, before, options={"marked": True, "frozen": True})
    assert response.status_code == 200, response.text
    delta = response.json()
    assert delta["kind"] == "selection"
    assert delta["base_version"] == before["version"]
    assert delta["version"] == before["version"] + 1
    assert delta["groups"] == [
        {"id": "group-0", "marked": True, "frozen": True},
        {"id": "group-1", "marked": False, "frozen": False},
    ]
    saved = store.load(before["id"])
    expected_groups = deepcopy(before["groups"])
    expected_groups[0].update(marked=True, frozen=True)
    assert saved["groups"] == expected_groups
    reconstructed = {**before, **{k: v for k, v in delta.items()
                                  if k not in {"kind", "base_version", "groups"}},
                     "groups": [{**g, **row} for g, row in zip(before["groups"], delta["groups"])]}
    assert reconstructed == saved
    assert len(response.content) < len(json.dumps(saved)) / 20


def test_default_response_and_undo_redo_remain_full_projects(workspace):
    store, client, before = workspace
    marked = command(client, before).json()
    frozen = command(client, marked, action="selection",
                     group_ids=[row["id"] for row in marked["groups"]],
                     options={"field": "frozen", "mode": "invert"}).json()
    assert all(row["frozen"] for row in frozen["groups"])
    undone = command(client, frozen, action="undo", options={}, group_ids=[],
                     response_mode="project").json()
    assert "kind" not in undone
    assert not any(group["frozen"] for group in undone["groups"])
    assert undone["groups"][0]["marked"]
    redone = command(client, undone, action="redo", options={}, group_ids=[],
                     response_mode="project").json()
    assert all(group["frozen"] for group in redone["groups"])
    assert redone == store.load(before["id"])
    default = client.post(f"/api/athena/projects/{before['id']}/command", json={
        "version": redone["version"], "action": "metadata", "group_ids": ["group-0"],
        "options": {"marked": False},
    })
    assert default.status_code == 200
    assert default.json() == store.load(before["id"])
    assert "result" in default.json()["groups"][0]


def test_stale_compact_edit_does_not_mutate(workspace):
    store, client, project = workspace
    assert command(client, project).status_code == 200
    saved = files(store, project)
    response = command(client, project, options={"marked": False})
    assert response.status_code == 409
    assert files(store, project) == saved


def test_compact_reply_refreshes_analyses_saved_without_a_project_revision(workspace):
    store, client, project = workspace
    analysis = store._persist_analysis(project["id"], {
        "kind": "pca", "project_version": project["version"],
        "group_ids": [group["id"] for group in project["groups"]],
        "options": {}, "result": {"explained_variance_ratio": [1.0]},
    })
    assert store.load(project["id"])["version"] == project["version"]
    response = command(client, project)
    assert response.status_code == 200, response.text
    delta = response.json()
    assert delta["analyses"] == [analysis]
    reconstructed = {**project, **{k: v for k, v in delta.items()
                                   if k not in {"kind", "base_version", "groups"}},
                     "groups": [{**g, **row} for g, row in zip(project["groups"], delta["groups"])]}
    assert reconstructed == store.load(project["id"])


@pytest.mark.parametrize("changes", [
    {"action": "parameters", "options": {"e0": 8980}},
    {"options": {"label": "Renamed"}},
    {"options": {"marked": True, "offset": 1}},
    {"options": {}},
    {"action": "undo", "options": {}},
    {"response_mode": "unknown"},
])
def test_invalid_compact_request_is_rejected_before_any_mutation(workspace, changes):
    store, client, project = workspace
    saved = files(store, project)
    response = command(client, project, **changes)
    assert response.status_code == 422, response.text
    assert files(store, project) == saved


def test_json_serialization_failure_preserves_previous_file_and_cleans_temp(workspace):
    store, _, project = workspace
    before = files(store, project)
    with pytest.raises(ValueError):
        store.storage.write_json(project["id"], "project.json", {"value": float("nan")})
    assert files(store, project) == before
    assert not list(store.storage.workspace_dir(project["id"]).glob(".*.tmp"))
