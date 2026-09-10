"""Legacy detector records use measured counts, never XAS inference."""
from copy import deepcopy
import gzip
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command, RestoreUploadRequest
from xraylarch_web.athena_science import process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
PROBE = FIXTURES / 'athena-detector-probe.prj'


@pytest.fixture
def workspace(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    p = store.create()
    return store, store.restore(p['id'], p['version'], PROBE.read_bytes(), PROBE.name)


def run(store, p, action, ids=None, **options):
    return store.command(p['id'], Command(version=p['version'], action=action,
        group_ids=ids if ids is not None else [g['id'] for g in p['groups']], options=options))


def test_probe_is_exact_measured_i0_from_official_native_project():
    original = json.loads((FIXTURES / 'demeter-athena-json.prj').read_text())
    probe = json.loads(PROBE.read_text())['counts']
    assert probe['x'] == original['mslu']['x']
    assert probe['y'] == original['mslu']['i0']
    assert len(probe['x']) == 327
    assert probe['args']['datatype'] == 'detector'


@pytest.mark.parametrize('signal', ['constant', 'negative', 'measured'])
def test_counts_do_not_call_any_absorption_processing(monkeypatch, signal):
    raw = json.loads(PROBE.read_text())['counts']; x = np.array(raw['x'],float)
    y = np.array(raw['y'],float) if signal == 'measured' else np.full(len(x), 10 if signal == 'constant' else -8.)
    def forbidden(*args, **kwargs): pytest.fail('Detector counts must not call absorption science')
    for name in ('_edge','pre_edge','autobk','xftf','xftr'):
        monkeypatch.setattr('xraylarch_web.athena_science.'+name, forbidden)
    result = process_spectrum(x, y, {'energy_shift': 2.5}, 'detector')
    np.testing.assert_array_equal(result['arrays']['energy'], x+2.5)
    np.testing.assert_array_equal(result['arrays']['mu'], y)
    assert all(not value for key,value in result['arrays'].items() if key not in ('energy','mu'))
    assert result['effective']['e0'] is None and result['effective']['edge_step'] is None
    assert result['effective']['exafs'] is False


def test_native_detector_preview_restore_and_persistence(workspace):
    store,p = workspace; g=p['groups'][0]; raw=json.loads(PROBE.read_text())['counts']
    assert g['data_type']=='detector' and g['processing_error'] is None
    assert not g['is_normalized']
    np.testing.assert_array_equal(g['mu'], np.array(raw['y'],float))
    assert g['result']['arrays']['norm']==[]
    assert g['source']['native']['args']['datatype']=='detector'
    assert AthenaStore(store.settings).load(p['id'])==p
    empty=store.create(); preview=store.preview_project(empty['id'],PROBE.read_bytes(),PROBE.name)
    assert preview['groups'][0]['data_type']=='detector'
    np.testing.assert_array_equal(preview['groups'][0]['y'],g['mu'])
    curve=store.preview_project_group(empty['id'],preview['upload_id'],'counts','norm')
    assert curve['processing_error'] and not curve['x'] and not curve['y']
    assert store.load(empty['id'])==empty


@pytest.mark.parametrize('format',['json','prj','bare-prj'])
def test_project_roundtrip_preserves_counts_and_type(workspace,format):
    store,p=workspace; g=p['groups'][0]
    data=store.export_project(p['id'],'json' if format=='json' else 'prj')
    if format=='bare-prj':
        data='\n'.join(line for line in gzip.decompress(data).decode().splitlines() if not line.startswith('# Athena-Web ')).encode()
    dest=store.create(); restored=store.restore(dest['id'],dest['version'],data,'counts.'+format)
    actual=restored['groups'][0]
    assert actual['data_type']=='detector' and actual['processing_error'] is None
    assert actual['energy']==g['energy'] and actual['mu']==g['mu']
    assert actual['result']['arrays']==g['result']['arrays']


@pytest.mark.parametrize('target',['mu','xanes','norm'])
def test_frozen_detector_can_be_corrected_without_changing_counts(workspace,target):
    store,p=workspace; p=run(store,p,'metadata',frozen=True)
    g=p['groups'][0]; fixed=run(store,p,'change_datatype',data_type=target); after=fixed['groups'][0]
    assert after['data_type']==target
    for key in ('energy','mu','source','parameters','marked','frozen','label'):
        assert after[key]==g[key]
    if target=='norm': assert after['result']['arrays']['norm']==g['mu']
    undone=run(store,fixed,'undo',[]); assert undone['groups']==p['groups']
    redone=run(store,undone,'redo',[]); assert redone['groups']==fixed['groups']


def test_detector_quick_toggle_rejects_and_keeps_counts(workspace):
    store,p=workspace
    with pytest.raises(WebInputError,match='quick toggle'): run(store,p,'change_datatype',toggle=True)
    assert store.load(p['id'])==p


@pytest.mark.parametrize('action,options',[
    ('calibrate',{'target':8979}),('rebin',{}),('self_absorption',{'formula':'Fe2O3'}),
    ('deconvolve',{}),('multi_electron',{}),('parameters',{'fnorm':True}),
])
def test_absorption_operations_do_not_reinterpret_counts(workspace,action,options):
    store,p=workspace
    with pytest.raises((ValueError,WebInputError)): run(store,p,action,**options)
    assert store.load(p['id'])==p


def test_e0_skips_counts_and_energy_shift_only_moves_axis(workspace):
    store,p=workspace; g=p['groups'][0]
    skipped=run(store,p,'set_e0',method='manual',value=8979)
    assert skipped['groups']==p['groups']
    assert skipped['last_operation']['skipped_group_ids']==[g['id']]
    shifted=run(store,skipped,'parameters',energy_shift=g['parameters']['energy_shift']+3)
    after=shifted['groups'][0]
    assert after['energy']==g['energy'] and after['mu']==g['mu']
    np.testing.assert_allclose(after['result']['arrays']['energy'],np.array(g['result']['arrays']['energy'])+3,rtol=0,atol=1e-10)
    assert after['result']['effective']['e0'] is None


@pytest.mark.parametrize('action',['merge','sum'])
def test_detector_counts_can_be_combined_without_normalization(workspace,action):
    store,p=workspace; p=run(store,p,'duplicate'); original=deepcopy(p['groups'])
    merged=run(store,p,action); g=merged['groups'][-1]
    assert g['data_type']=='detector' and g['processing_error'] is None
    assert merged['groups'][:2]==original
    expected=np.interp(g['energy'],original[0]['result']['arrays']['energy'],original[0]['mu'])
    np.testing.assert_allclose(g['mu'],expected*(2 if action=='sum' else 1),rtol=1e-12)
    assert g['result']['arrays']['norm']==[]
    with pytest.raises(WebInputError,match='detector counts'):
        run(store,merged,action,[item['id'] for item in original],array='mu')


def test_dormant_invalid_native_recipe_does_not_hide_counts(workspace):
    store,p=workspace; raw=json.loads(PROBE.read_text()); args=raw['counts']['args']
    args.update(bkg_e0=0,bkg_nor2=-20,fft_kmax=0)
    dest=store.create(); changed=store.restore(dest['id'],dest['version'],json.dumps(raw).encode(),'inactive.prj')
    g=changed['groups'][0]
    assert g['processing_error'] is None and g['result']['arrays']['mu']==p['groups'][0]['mu']
    assert g['source']['native']['args']['bkg_nor2']==-20


def test_real_http_export_has_only_energy_counts_and_no_ft(workspace):
    store,p=workspace; g=p['groups'][0]
    with TestClient(create_app(store.settings)) as client:
        base=f'/api/athena/projects/{p["id"]}/groups/{g["id"]}/export'
        response=client.get(base+'?space=E'); assert response.status_code==200
        assert response.text.splitlines()[0]=='energy,detector_signal'
        for space in ('k','R','q'): assert client.get(base+'?space='+space).status_code==400


def test_explicit_detector_calibration_does_not_find_an_edge(workspace,monkeypatch):
    store,p=workspace; g=p['groups'][0]; observed=g['energy'][20]
    def forbidden(*args,**kwargs): pytest.fail('Explicit detector calibration must not infer an edge')
    monkeypatch.setattr('xraylarch_web.athena_science._edge',forbidden)
    shifted=run(store,p,'calibrate',observed=observed,target=observed+2)
    assert shifted['groups'][0]['parameters']['energy_shift']==2
    assert shifted['groups'][0]['mu']==g['mu']
    assert shifted['groups'][0]['result']['effective']['e0'] is None


def test_detector_cannot_be_an_absorption_alignment_or_background_standard(workspace):
    store,p=workspace; detector=p['groups'][0]
    p=run(store,p,'example',[]); sample=p['groups'][-1]
    for action,options in [('align',{'reference_id':detector['id']}), ('background_standard',{'standard_id':detector['id']})]:
        with pytest.raises((ValueError,WebInputError)):
            run(store,p,action,[sample['id']],**options)
        assert store.load(p['id'])==p


@pytest.mark.parametrize('action', ['smooth', 'truncate', 'convolve', 'dispersive'])
def test_raw_detector_transformations_keep_signal_type_and_original(workspace, action):
    store,p=workspace; g=deepcopy(p['groups'][0])
    options={'smooth':{'window':7,'order':2},
             'truncate':{'xmin':g['result']['arrays']['energy'][30],'xmax':g['result']['arrays']['energy'][280]},
             'convolve':{'form':'gaussian','width':5},
             'dispersive':{'offset':0,'linear':2,'quadratic':0}}[action]
    updated=run(store,p,action,**options); child=updated['groups'][-1]
    assert updated['groups'][0]==g
    assert child['data_type']=='detector' and child['processing_error'] is None
    assert child['result']['arrays']['mu']==child['mu']
    assert child['result']['arrays']['norm']==[] and child['result']['arrays']['chi']==[]
    assert child['result']['effective']['e0'] is None
    if action=='truncate':
        assert child['mu']==g['mu'][30:281]
        assert child['energy']==g['result']['arrays']['energy'][30:281]
        assert child['parameters']['energy_shift']==0
    elif action=='dispersive':
        assert child['mu']==g['mu']
        np.testing.assert_array_equal(child['energy'],np.array(g['energy'])*2)
