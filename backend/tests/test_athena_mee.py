"""Native MEE equations, measured project workflow and atomic HTTP behavior."""
from copy import deepcopy
import gzip
import json
from pathlib import Path

from fastapi.testclient import TestClient
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_mee import MEEOptions, subtract
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
NATIVE = json.loads(gzip.decompress((FIXTURES / 'athena-mee-native.json.gz').read_bytes()))


@pytest.mark.parametrize('case', NATIVE['cases'], ids=lambda c: c['id'])
def test_models_against_executed_native_templates_and_perl_padding(case):
    before = deepcopy(case)
    out = subtract(case['energy'], case['norm'], case['e0'], MEEOptions(**case['options']))
    if case['options']['amplitude'] == 0:
        # Native `amp ||= 1` turns explicit zero into one. Keep the documented
        # disabled-removal meaning instead of reproducing that upstream bug.
        assert case['native_amplitude'] == 1
        np.testing.assert_array_equal(out['mu'], case['norm'])
    else:
        np.testing.assert_allclose(out['mu'], case['corrected'], atol=2e-14, rtol=2e-14)
        np.testing.assert_allclose(out['details']['excitation'],
            case['native_amplitude'] * np.array(case['model']), atol=2e-14, rtol=2e-14)
    assert out['details']['width'] == case['native_width']
    assert case == before


@pytest.fixture
def workspace(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    project = store.restore(project['id'], 0, (FIXTURES/'demeter-mee-LaCoO3.prj').read_bytes(), 'LaCoO3.prj')
    return store, project


def request(project, ids=None, **options):
    return Command(version=project['version'], action='multi_electron',
        group_ids=ids if ids is not None else [project['groups'][1]['id']],
        options={'shift': 122., 'amplitude': .014, 'width': 2., **options})


@pytest.mark.parametrize('method', ['reflection', 'arctangent'])
def test_measured_preview_save_normalized_scale_and_native_insertion(workspace, method):
    store, project = workspace
    parent = project['groups'][0]
    project = store.command(project['id'], Command(version=project['version'], action='metadata',
        group_ids=[parent['id']], options={'frozen': True, 'notes': 'La L3 measurement'}))
    parent = project['groups'][0]
    req = request(project, [parent['id']], method=method)
    preview = store.preview_mee(project['id'], req)
    assert store.load(project['id']) == project
    row = preview['results'][0]
    assert all(len(row['traces'][space]) == 2 for space in ('E','k','R'))
    expected = np.array(parent['result']['arrays']['norm']) - np.array(row['details']['excitation'])
    np.testing.assert_allclose(row['corrected_mu'], expected, atol=1e-15)
    assert parent['result']['effective']['edge_step'] > 30  # Detect raw/normalized scale mixups.
    after = store.command(project['id'], req)
    child = after['groups'][1]
    assert [after['groups'][0], after['groups'][2]] == project['groups']
    assert child['label'] == parent['label'] + ' (MEE)' and child['frozen'] is False
    assert child['notes'] == parent['notes']
    assert child['processing_error'] is None and child['data_type'] == parent['data_type']
    np.testing.assert_array_equal(child['mu'], row['corrected_mu'])
    for space, ykey in [('E','norm'),('k','weighted_chi'),('R','chir_mag')]:
        np.testing.assert_array_equal(child['result']['arrays'][ykey], row['traces'][space][1]['y'])
    undo = store.command(project['id'], Command(version=after['version'],action='undo'))
    assert undo['groups'] == project['groups']
    redo = store.command(project['id'], Command(version=undo['version'],action='redo'))
    assert redo['groups'] == after['groups']
    target = store.create()
    restored = store.restore(target['id'],0,store.export_project(project['id'],'prj'),'corrected.prj')
    np.testing.assert_array_equal(restored['groups'][1]['mu'],child['mu'])
    assert restored['groups'][1]['source']['details'] == child['source']['details']


def test_shift_materialized_once_and_xanes_has_energy_preview(workspace):
    store, project = workspace
    parent = project['groups'][1]
    project = store.command(project['id'],Command(version=project['version'],action='parameters',group_ids=[parent['id']],options={'energy_shift':3.25}))
    shifted = project['groups'][1]
    preview = store.preview_mee(project['id'], request(project))['results'][0]
    assert preview['parameters']['energy_shift'] == 0
    np.testing.assert_array_equal(preview['traces']['E'][1]['x'],shifted['result']['arrays']['energy'])
    assert preview['details']['e0'] == shifted['result']['effective']['e0']
    project = store.command(project['id'],Command(version=project['version'],action='change_datatype',group_ids=[parent['id']],options={'data_type':'xanes'}))
    preview = store.preview_mee(project['id'], request(project))['results'][0]
    assert len(preview['traces']['E']) == 2
    assert preview['traces']['k'] == [] and preview['errors']['k']


def test_preview_rechecks_revision_after_calculation(workspace, monkeypatch):
    store, project = workspace
    real = store._mee_results
    def concurrent(p, req):
        output = real(p,req)
        store.command(p['id'],Command(version=p['version'],action='project',options={'name':'Another tab'}))
        return output
    monkeypatch.setattr(store,'_mee_results',concurrent)
    with pytest.raises(WebInputError,match='changed in another tab'):
        store.preview_mee(project['id'],request(project))
    assert store.load(project['id'])['groups'] == project['groups']


def test_invalid_later_group_is_atomic_and_valid_batch_uses_list_order(workspace):
    store, project = workspace
    ids = [g['id'] for g in reversed(project['groups'])]
    bad = deepcopy(project); bad['groups'][1]['processing_error']='Repair normalization'
    store.storage.write_json(project['id'],'project.json',bad)
    with pytest.raises(ValueError,match='successfully'):
        store.command(bad['id'],request(bad,ids))
    assert store.load(bad['id']) == bad
    store.storage.write_json(project['id'],'project.json',project)
    after = store.command(project['id'],request(project,ids))
    assert [g['id'] for g in after['groups'][::2]] == list(reversed(ids))
    assert [g['source']['parent'] for g in after['groups'][1::2]] == list(reversed(ids))


def test_native_clamps_high_amplitude_and_work_limit():
    x = np.linspace(5400,5800,401); y = np.ones(len(x))
    out = subtract(x,y,5488,MEEOptions(method='arctangent',shift=122,amplitude=-1,width=0))
    np.testing.assert_array_equal(out['mu'],y)
    assert len(out['details']['warnings']) == 2
    assert subtract(x,y,5488,MEEOptions(method='arctangent',shift=122,amplitude=1.2))['mu']
    x[1]=x[0]+.0001
    with pytest.raises(ValueError,match='work limit'):
        subtract(x,y,5488,MEEOptions(shift=122))


def test_http_preview_conflict_invalid_controls_and_real_save(workspace):
    store, p = workspace
    with TestClient(create_app(store.settings)) as client:
        base = f'/api/athena/projects/{p["id"]}'
        payload = request(p).model_dump()
        response = client.post(base+'/mee/preview',json=payload)
        assert response.status_code == 200, response.text
        assert client.get(base).json() == p
        for options in [{'shift':True},{'shift':0},{'shift':122,'width':True},{'shift':122,'method':'typo'},{'shift':122,'edge_step':33}]:
            response=client.post(base+'/mee/preview',json=dict(payload,options=options))
            assert response.status_code == 400,response.text
        saved=client.post(base+'/command',json=payload)
        assert saved.status_code == 200,saved.text
        assert client.post(base+'/command',json=payload).status_code == 409
        assert client.post(base+'/mee/preview',json=payload).status_code == 409
        assert len(client.get(base).json()['groups']) == 3
