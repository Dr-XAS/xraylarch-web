"""Project-owned Artemis models, scientific staleness, and inert fit archives."""
import copy
import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from test_artemis import model, spectrum
from xraylarch_web.artemis import PathInput, inspect_path
from xraylarch_web.artemis_persistence import input_fingerprint, validate_state
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


def draft(request):
    return {
        "revision": 0,
        "parameters": [{"id": f"parameter-{i}", **parameter,
            "value": str(parameter.get("value", 0)),
            "min": "" if parameter.get("min") is None else str(parameter["min"]),
            "max": "" if parameter.get("max") is None else str(parameter["max"]),
            "expression": parameter.get("expression", "")}
            for i, parameter in enumerate(request["parameters"])],
        "paths": [{**path, "metadata": inspect_path(PathInput(filename=path["filename"], content=path["content"]))["metadata"]}
                  for path in request["paths"]],
        "transform": {key: str(value) if key in ("kmin", "kmax", "dk", "rmin", "rmax", "dr") else value
                      for key, value in request["transform"].items()},
    }


@pytest.fixture
def workspace(tmp_path, spectrum):
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    old = store.create()
    project = copy.deepcopy(old)
    group = store.make_group("Copper", spectrum["result"]["arrays"]["k"],
                             spectrum["result"]["arrays"]["chi"], data_type="chi")
    assert group["processing_error"] is None
    project["groups"].append(group)
    project = store.save(project, old, "Imported synthetic reference")
    with TestClient(create_app(settings)) as client:
        yield store, client, project, group["id"]


def post(client, project, group_id, action, **values):
    response = client.post(f"/api/artemis/projects/{project['id']}/groups/{group_id}/{action}",
                           json={"version": project["version"], **values})
    assert response.status_code == 200, response.text
    return response.json()


def test_master_saved_fit_without_noise_statistic_opens_lists_and_exports(workspace, model):
    """a3ce60aff's exact archive/result shape, with synthetic values, not a new fit minus a key."""
    store, client, project, group_id = workspace
    saved_model = draft(model)
    for item in saved_model['paths']:
        item.update(enabled=True, s02='amp', e0='del_e0', deltar='del_r', sigma2='sig2')
    path = saved_model['paths'][0]
    result = dict(
        project_id=project['id'], group_id=group_id, group_label='Synthetic archive',
        version=project['version'], success=True, message='Synthetic', report='Synthetic', warnings=[],
        statistics=dict(n_varys=1, n_independent=10.0, n_data=20, nfev=5,
                        chi_square=1.0, reduced_chi_square=0.1, r_factor=0.01,
                        aic=2.0, bic=3.0, errorbars=True),
        parameters=[dict(name='amp', kind='guess', value=1.0, initial=0.9,
                         stderr=0.1, min=0.0, max=2.0, expression='')],
        correlations=[], transform=model['transform'],
        metadata=dict(engine='synthetic', kstep=0.05, nfft=2048, rwindow='hanning',
                      phase_corrected=False, noise='synthetic', background_refined=False,
                      r_residual='synthetic'),
        k=dict(x=[1.0, 2.0], data=[0.1, 0.2], model=[0.1, 0.2], residual=[0.0, 0.0], weight=2),
        r={'x': [1.0, 2.0], **{f'{curve}_{part}': [0.0, 0.0]
           for curve in ('data', 'model', 'residual') for part in ('mag', 're', 'im')}},
        paths=[dict(id=path['id'], label=path['label'], filename=path['filename'],
                    metadata=path['metadata'], sigma2_expression='sig2',
                    values=dict(s02=1.0, e0=0.0, deltar=0.0, sigma2=0.01),
                    k=dict(chi=[0.1, 0.2]), r=dict(mag=[0.0, 0.0], re=[0.0, 0.0], im=[0.0, 0.0]))],
        plot_source=dict(schema_version=1, data=[0.1, 0.2], model=[0.1, 0.2],
                         paths=[dict(id=path['id'], chi=[0.1, 0.2])]),
    )
    record = dict(id='legacy-fit', created='2026-01-01T00:00:00+00:00',
                  input_sha256=input_fingerprint(project['groups'][0]), imported=False,
                  origin=dict(project_id=project['id'], group_id=group_id,
                              project_version=project['version'], larch_version='2026.1.0'),
                  model=saved_model, result=result)
    project['groups'][0]['artemis'] = dict(schema_version=1, model=saved_model,
                                         history=[record], current_input_sha256=record['input_sha256'])
    store.storage.write_json(project['id'], 'project.json', project)
    opened = client.get(f"/api/athena/projects/{project['id']}")
    assert opened.status_code == 200, opened.text
    assert opened.json()['groups'][0]['artemis']['history'] == [record]
    listed = client.get('/api/athena/projects')
    assert listed.status_code == 200, listed.text
    assert project['id'] in listed.text
    exported = client.get(f"/api/athena/projects/{project['id']}/export?format=json")
    assert exported.status_code == 200, exported.text
    assert exported.json()['groups'][0]['artemis']['history'] == [record]
    assert AthenaStore(store.settings).load(project['id'])['groups'][0]['artemis']['history'] == [record]


def test_unfinished_model_survives_new_store_and_undo_redo(workspace, model):
    store, client, original, group_id = workspace
    value = draft(model)
    value["parameters"][0].update(value="-", name="", expression="unfinished(")
    value["paths"] = []
    saved = post(client, original, group_id, "model", model=value)
    restored = AthenaStore(store.settings).load(original["id"])
    assert restored["groups"][0]["artemis"]["model"] == value
    assert restored["version"] == original["version"] + 1
    for action, expected in (("undo", False), ("redo", True)):
        response = client.post(f"/api/athena/projects/{original['id']}/command", json={
            "version": saved["version"], "action": action, "group_ids": [], "options": {}})
        assert response.status_code == 200, response.text
        saved = response.json()
        assert ("artemis" in saved["groups"][0]) is expected


@pytest.mark.parametrize("action", ["fit", "fit-saved"])
def test_edge_mismatch_is_rejected_without_saving(workspace, model, action, monkeypatch):
    from xraylarch_web import artemis

    store, client, project, group_id = workspace
    group = store.group(project, group_id)
    group["source"]["edge_identity"] = dict(element="W", edge="L3", origin="selected")
    store.storage.write_json(project["id"], "project.json", project)
    before = store.load(project["id"])
    value = draft(model)
    # Saved metadata must never override the absorber/edge in the FEFF file.
    value["paths"][0]["metadata"].update(absorber="W", edge="L3")
    body = ({"model": value} if action == "fit-saved" else model) | {"version": project["version"]}

    def optimizer_must_not_run(*args, **kwargs):
        pytest.fail("Mismatched FEFF file reached optimizer through HTTP")

    monkeypatch.setattr(artemis, "feffit", optimizer_must_not_run)
    response = client.post(f"/api/artemis/projects/{project['id']}/groups/{group_id}/{action}", json=body)
    assert response.status_code == 400, response.text
    assert "calculated for Cu K, but the selected spectrum is W L3" in response.text
    assert store.load(project["id"]) == before


def test_fit_saves_complete_immutable_history_and_scientific_fingerprint(workspace, model):
    store, client, project, group_id = workspace
    first = post(client, project, group_id, "fit-saved", model=draft(model))
    project = first["project"]
    state = project["groups"][0]["artemis"]
    record = copy.deepcopy(state["history"][0])
    assert record["id"] == first["fit_id"]
    assert record["result"]["success"]
    assert record["origin"]["larch_version"]
    assert record["input_sha256"] == state["current_input_sha256"]
    assert record["model"]["paths"][0]["content"] == model["paths"][0]["content"]
    renamed = copy.deepcopy(project)
    renamed["groups"][0].update(label="Renamed", marked=True, multiplier=4, offset=2, notes="New note")
    project = store.save(renamed, project, "Metadata only")
    assert project["groups"][0]["artemis"]["current_input_sha256"] == record["input_sha256"]
    value = draft(model)
    value["parameters"][0]["value"] = "0.95"
    second = post(client, project, group_id, "fit-saved", model=value)
    project = second["project"]
    assert project["groups"][0]["artemis"]["history"][0] == record
    assert len(project["groups"][0]["artemis"]["history"]) == 2
    changed = copy.deepcopy(project)
    changed["groups"][0]["result"]["arrays"]["chi"][20] += 0.01
    project = store.save(changed, project, "Changed science")
    assert project["groups"][0]["artemis"]["current_input_sha256"] != record["input_sha256"]
    assert project["groups"][0]["artemis"]["history"][0] == record
    changed = copy.deepcopy(project)
    changed["groups"][0]["processing_error"] = "Missing background standard"
    assert input_fingerprint(changed["groups"][0]) is None


@pytest.mark.parametrize("format", ["json", "prj"])
def test_project_exchange_keeps_models_and_marks_imported_fits_as_archives(workspace, model, format, monkeypatch):
    from xraylarch_web import artemis_persistence as persistence
    store, client, project, group_id = workspace
    project = post(client, project, group_id, "fit-saved", model=draft(model))["project"]
    record = project["groups"][0]["artemis"]["history"][0]
    old = copy.deepcopy(project)
    other = copy.deepcopy(project['groups'][0])
    other.update(id='excluded-group', label='Not selected')
    other['artemis']['history'] = []
    project['groups'].append(other)
    project = store.save(project, old, 'Second model for partial export')
    output = store.export_project(project["id"], format=format, group_ids=[group_id])
    destination = store.create()
    populated = copy.deepcopy(destination)
    populated['groups'].append(copy.deepcopy(other))
    destination = store.save(populated, destination, 'Existing destination group')
    def no_feff_inspection(*args, **kwargs):
        pytest.fail('Project import must not inspect or execute saved FEFF contents')
    monkeypatch.setattr(persistence, 'inspect_path', no_feff_inspection)
    restored = store.restore(destination["id"], destination["version"], output, f"saved.{format}")
    assert len(restored['groups']) == 2
    assert restored['groups'][0] == destination['groups'][0]
    group = restored["groups"][1]
    assert group["id"] != group_id
    state = group["artemis"]
    assert state["history"][0] == {**record, "imported": True}
    assert state["model"] == project["groups"][0]["artemis"]["model"]
    assert state["current_input_sha256"] == record["input_sha256"]
    assert state["history"][0]["origin"]["group_id"] == group_id
    assert state["model"]["paths"][0]["content"] == model["paths"][0]["content"]


def test_saved_fit_removal_can_be_undone(workspace, model):
    store, client, project, group_id = workspace
    fitted = post(client, project, group_id, "fit-saved", model=draft(model))
    removed = post(client, fitted["project"], group_id, "remove-fit", fit_id=fitted["fit_id"])
    assert removed["groups"][0]["artemis"]["history"] == []
    response = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": removed["version"], "action": "undo", "group_ids": [], "options": {}})
    assert response.status_code == 200
    assert response.json()["groups"][0]["artemis"]["history"][0]["id"] == fitted["fit_id"]


def test_concurrent_fit_does_not_overwrite_newer_project(workspace, model, monkeypatch):
    from xraylarch_web import artemis_persistence as persistence
    store, client, project, group_id = workspace
    real_fit = persistence.fit_group

    def fit_and_edit(group, request):
        result = real_fit(group, request)
        old = store.load(project["id"])
        new = copy.deepcopy(old)
        new["groups"][0]["label"] = "Changed in another tab"
        store.save(new, old, "Concurrent edit")
        return result

    monkeypatch.setattr(persistence, "fit_group", fit_and_edit)
    response = client.post(f"/api/artemis/projects/{project['id']}/groups/{group_id}/fit-saved",
                           json={"version": project["version"], "model": draft(model)})
    assert response.status_code == 409, response.text
    current = store.load(project["id"])
    assert current["groups"][0]["label"] == "Changed in another tab"
    assert "artemis" not in current["groups"][0]


@pytest.mark.parametrize("action", ["model", "fit-saved", "remove-fit"])
def test_integration_projects_cannot_use_persistence_routes(workspace, model, action):
    store, client, project, group_id = workspace
    project["integration"] = True
    store.storage.write_json(project["id"], "project.json", project)
    values = {"fit_id": "unavailable"} if action == "remove-fit" else {"model": draft(model)}
    response = client.post(f"/api/artemis/projects/{project['id']}/groups/{group_id}/{action}",
                           json={"version": project["version"], **values})
    assert response.status_code in (400, 403, 404), response.text
    assert "artemis" not in store.load(project["id"])["groups"][0]


@pytest.mark.parametrize("damage", ["nonfinite", "unaligned", "axis", "history", "content", "duplicate", "unknown"])
def test_malformed_archives_are_rejected_atomically(workspace, model, damage):
    store, client, project, group_id = workspace
    project = post(client, project, group_id, "fit-saved", model=draft(model))["project"]
    document = json.loads(store.export_project(project["id"]))
    state = document["groups"][0]["artemis"]
    fit = state["history"][0]
    if damage == "nonfinite": fit["result"]["k"]["data"][0] = float("nan")
    if damage == "unaligned": fit["result"]["r"]["model_re"].pop()
    if damage == "axis": fit["result"]["k"]["x"][1] = fit["result"]["k"]["x"][0]
    if damage == "history": state["history"] *= 11
    if damage == "content": state["model"]["paths"][0]["content"] = "铜" * 500_000
    if damage == "duplicate": state["model"]["paths"] *= 2
    if damage == "unknown": state["model"]["server_path"] = "/private/data"
    destination = store.create()
    with pytest.raises((WebInputError, ValueError, ValidationError)):
        store.restore(destination["id"], destination["version"], json.dumps(document).encode(), "invalid.json")
    assert store.load(destination["id"]) == destination


def test_identical_model_save_is_idempotent(workspace, model):
    store, client, project, group_id = workspace
    first = post(client, project, group_id, 'model', model=draft(model))
    second = post(client, first, group_id, 'model', model=draft(model))
    assert second == first == store.load(project['id'])


def test_history_limit_rejects_without_pruning_and_recovers_after_removal(workspace, model):
    store, client, project, group_id = workspace
    first = post(client, project, group_id, 'fit-saved', model=draft(model))['project']
    full = copy.deepcopy(first)
    fit = full['groups'][0]['artemis']['history'][0]
    full['groups'][0]['artemis']['history'] = [copy.deepcopy(fit) | {'id': f'fit-{i}'} for i in range(10)]
    full = store.save(full, first, 'History fixture')
    response = client.post(f'/api/artemis/projects/{project["id"]}/groups/{group_id}/fit-saved',
                           json={'version': full['version'], 'model': draft(model)})
    assert response.status_code == 400
    assert store.load(project['id']) == full
    removed = post(client, full, group_id, 'remove-fit', fit_id='fit-0')
    final = post(client, removed, group_id, 'fit-saved', model=draft(model))['project']
    history = final['groups'][0]['artemis']['history']
    assert len(history) == 10
    assert history[:9] == full['groups'][0]['artemis']['history'][1:]


def test_aggregate_budget_and_invalid_fit_leave_project_unchanged(workspace, model, monkeypatch):
    from xraylarch_web import artemis_persistence as persistence
    store, client, project, group_id = workspace
    project = post(client, project, group_id, 'model', model=draft(model))
    invalid = draft(model)
    invalid['paths'][0]['sigma2'] = 'unknown_parameter'
    response = client.post(f'/api/artemis/projects/{project["id"]}/groups/{group_id}/fit-saved',
                           json={'version': project['version'], 'model': invalid})
    assert response.status_code == 400
    assert store.load(project['id']) == project
    size = len(persistence._json(project['groups'][0]['artemis']))
    monkeypatch.setattr(persistence, 'MAX_PROJECT_BYTES', size + 100)
    changed = copy.deepcopy(project)
    duplicate = copy.deepcopy(changed['groups'][0])
    duplicate['id'] = 'copied-group'
    changed['groups'].append(duplicate)
    with pytest.raises(WebInputError, match='20 MB'):
        store.save(changed, project, 'Exceeds aggregate limit')
    assert store.load(project['id']) == project


def test_reimport_columns_preserves_model_and_history(tmp_path, xas_arrays, model):
    from test_athena_reimport import imported, replacement
    store, project, _, ids = imported(tmp_path, xas_arrays)
    old = copy.deepcopy(project)
    project['groups'][0]['artemis'] = {'schema_version': 1, 'model': draft(model), 'history': []}
    project = store.save(project, old, 'Saved model')
    group, _, request = replacement(store, project, ids)
    changed = store.import_data(project['id'], request, replace_group_id=group['id'])
    assert changed['groups'][0]['artemis']['model'] == project['groups'][0]['artemis']['model']
    assert changed['groups'][0]['artemis']['history'] == []
    assert changed['groups'][0]['mu'] != project['groups'][0]['mu']


def test_large_integer_archive_is_a_validation_error(workspace, model):
    store, client, project, group_id = workspace
    project = post(client, project, group_id, 'fit-saved', model=draft(model))['project']
    state = copy.deepcopy(project['groups'][0]['artemis'])
    state['history'][0]['result']['k']['data'][0] = 10**400
    with pytest.raises(WebInputError):
        validate_state(state)
