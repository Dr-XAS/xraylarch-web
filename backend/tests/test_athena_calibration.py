"""Native calibration choices and real Larch project/preview lifecycle."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_calibration import CalibrationOptions, calibration_curve, calibration_shift, zero_crossing
from xraylarch_web.athena_smoothing_preferences import SGPreferenceRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIX=Path(__file__).parent/'fixtures'
NATIVE=json.loads(gzip.decompress((FIX/'athena-calibration-native.json.gz').read_bytes()))


def group(name='Cu',shift=0):
    src=NATIVE['inputs'][name]
    return dict(data_type='mu',is_normalized=False,is_difference=False,energy=src['arrays']['energy'],mu=src['arrays']['xmu'],
                parameters=dict(**src['parameters'],energy_shift=shift,flatten=True))


@pytest.mark.parametrize('row',NATIVE['rows'],ids=lambda r:r['name'])
def test_original_calibration_methods_and_display_kernels(row):
    case=row['case'];src=group(row['input'],case['shift']);native=row['native']
    assert native['restored_smoothing']==8
    assert native['draw']['emin']==-30 and native['draw']['emax']==50
    if case['action']=='calibrate':
        assert calibration_shift(case['observed'],case['target'],case['shift'])==float(native['shift'])
        assert float(native['e0'])==case['target'] and native['modified']==1
    elif case['action']=='zero':
        assert zero_crossing(src,case['observed'])==float(native['e0'])
    elif case['action']=='pluck':
        assert float(native['e0'])==case['observed']
    else:
        choice=CalibrationOptions(observed=case['observed'],target=case['target'],display=['mu','norm','derivative','second'][case['display']],
            smoothing=case['smoothing'],smoothing_method='three_point' if case['backend']=='ifeffit' else 'savitzky_golay',sg_window=31,sg_order=9)
        plotted=calibration_curve(src,choice)
        np.testing.assert_allclose(plotted['y'],row['plot_y'],rtol=2e-12,atol=2e-13)
        assert plotted['x']==src['energy']


def test_reference_hashes_and_measured_inputs_are_fixed():
    root=FIX.parents[2];manifest=json.loads((FIX/'athena-calibration-fixtures.json').read_text())
    catalog={r['file']:r['sha256'] for r in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((root/path).read_bytes()).hexdigest()==sha
    for path,sha in manifest['source_sha256'].items():assert sha==catalog['demeter-'+manifest['demeter_revision']+'/'+path]
    assert len(NATIVE['rows'])==manifest['case_count']==68
    for src in NATIVE['inputs'].values():assert hashlib.sha256((FIX/src['fixture']).read_bytes()).hexdigest()==src['sha256']


@pytest.fixture
def store(tmp_path):return AthenaStore(Settings(data_root=tmp_path))


def project(store,shift=2.75,name='Cu'):
    raw=group(name,shift);src=NATIVE['inputs'][name]
    source=dict(filename=src['fixture'],edge_identity=dict(element=name,edge='K',origin='native'),
        raw_arrays=dict(i0=[float(i+1000) for i in range(len(raw['energy']))]),column_arrays=dict(energy=raw['energy'].copy()))
    p=store.create();p['groups']=[store.make_group(name,raw['energy'],raw['mu'],parameters=dict(raw['parameters'],e0=src['e0']+shift),source=source)]
    assert p['groups'][0]['processing_error'] is None
    return store.save(p,store.load(p['id']),'Measured calibration fixture')


def command(p,**options):return Command(version=p['version'],action='calibrate',group_ids=[p['groups'][0]['id']],options=dict(coordinate='displayed',**options))


@pytest.mark.parametrize('name',['Cu','Fe'])
@pytest.mark.parametrize('shift',[0,2.75,-4.3])
def test_cumulative_shift_rounding_readonly_preview_exact_save_undo_redo_and_native_prj(store,name,shift):
    p=project(store,shift,name);before=copy.deepcopy(p);g=p['groups'][0]
    observed=g['parameters']['e0']+.12345;target=g['parameters']['e0']+1.98765
    preview=store.preview_calibration(p['id'],command(p,observed=observed,target=target))
    assert store.load(p['id'])==before
    expected=float(f'{target-observed+shift:.3f}')
    assert preview['energy_shift']==expected
    assert abs(preview['actual_reference']-target)<=.0005
    saved=store.command(p['id'],Command(version=p['version'],action='calibrate',group_ids=[g['id']],options=preview['options']))
    after=saved['groups'][0];assert after['parameters']['e0']==target and after['parameters']['energy_shift']==expected
    assert after['energy']==g['energy'] and after['mu']==g['mu'] and after['source']==g['source']
    assert saved['last_operation']['calibration']['energy_shift']==preview['energy_shift']
    undone=store.command(p['id'],Command(version=saved['version'],action='undo'));assert undone['groups']==p['groups']
    redone=store.command(p['id'],Command(version=undone['version'],action='redo'));assert redone['groups']==saved['groups']
    data=store.export_project(p['id'],'prj')
    bare='\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    for content in (data,bare):
        restored=store.restore(store.create()['id'],0,content,'calibrated.prj')['groups'][0]
        assert restored['energy']==g['energy'] and restored['mu']==g['mu']
        assert restored['parameters']['energy_shift']==expected and restored['parameters']['e0']==target


def test_linked_reference_moves_once_retains_distinct_e0_and_frozen_failure_is_atomic(store):
    p=project(store);sample=p['groups'][0]
    ref=copy.deepcopy(sample);ref['id']='reference';ref['parameters']['e0']+=.5
    sample['reference_id']=ref['id'];p['groups'].append(ref);p=store.save(p,store.load(p['id']),'Linked reference')
    req=command(p,observed=sample['parameters']['e0'],target=sample['parameters']['e0']+2.2)
    preview=store.preview_calibration(p['id'],req);assert len(preview['changes'])==2
    after=store.command(p['id'],req)
    assert after['groups'][1]['parameters']['energy_shift']==after['groups'][0]['parameters']['energy_shift']
    assert after['groups'][1]['parameters']['e0']==pytest.approx(ref['parameters']['e0']+2.2)
    frozen=store.command(p['id'],Command(version=after['version'],action='metadata',group_ids=['reference'],options=dict(frozen=True)))
    with pytest.raises(WebInputError,match='Unfreeze'):store.preview_calibration(p['id'],command(frozen,observed=sample['parameters']['e0'],target=8990))
    assert store.load(p['id'])==frozen


def test_zero_search_ignores_display_smoothing_and_never_commits_e0(store):
    p=project(store)
    rows=[store.preview_calibration(p['id'],command(p,display='second',smoothing=n),find_zero=True) for n in [0,1,10]]
    assert rows[0]['zero_crossing']==rows[1]['zero_crossing']==rows[2]['zero_crossing']
    assert rows[0]['curve']['y']!=rows[2]['curve']['y']
    assert store.load(p['id'])==p


def test_larch_smoothing_uses_captured_shared_preferences_and_raw_derivatives(store):
    p=project(store)
    a=store.preview_calibration(p['id'],command(p,smoothing_method='savitzky_golay',smoothing=1))
    b=store.preview_calibration(p['id'],command(p,smoothing_method='savitzky_golay',smoothing=10))
    assert a['curve']['y']==b['curve']['y']
    values=store.smoothing_preferences.read()
    store.smoothing_preferences.apply(SGPreferenceRequest(version=values['version'],session_id=values['session_id'],values=dict(window=21,order=9)))
    fresh=store.preview_calibration(p['id'],command(p,smoothing_method='savitzky_golay',smoothing=1))
    assert fresh['options']['sg_window']==21 and fresh['curve']['y']!=a['curve']['y']
    captured=store.preview_calibration(p['id'],Command(version=p['version'],action='calibrate',group_ids=[p['groups'][0]['id']],options=a['options']))
    assert captured['curve']==a['curve']
    x,y=np.asarray(p['groups'][0]['energy']),np.asarray(p['groups'][0]['mu'])
    np.testing.assert_allclose(a['curve']['unsmoothed'],np.gradient(y)/np.gradient(x),rtol=0,atol=1e-13)


def test_normalized_plot_uses_selected_reference_without_changing_recipe(store):
    p=project(store);g=p['groups'][0]
    a=store.preview_calibration(p['id'],command(p,display='norm',observed=g['parameters']['e0']))
    b=store.preview_calibration(p['id'],command(p,display='norm',observed=g['parameters']['e0']-3))
    assert a['curve']['y']!=b['curve']['y'] and store.load(p['id'])==p


def test_calibration_resolves_existing_outer_limit_and_refits_the_saved_overlay(store):
    p=project(store);observed=p['groups'][0]['parameters']['e0']+3
    preview=store.preview_calibration(p['id'],command(p,display='norm',observed=observed))
    assert preview['processing_errors']=={} and preview['curve']['normalization']
    assert store.load(p['id'])==p
    after=store.command(p['id'],command(p,display='norm',observed=observed))['groups'][0]
    assert after['processing_error'] is None
    assert after['parameters']['norm2']==p['groups'][0]['parameters']['norm2']
    assert after['result']['arrays']['flat']==preview['calibrated_curve']['y']


@pytest.mark.parametrize('options',[dict(observed=True),dict(target='8980'),dict(observed=-1),dict(observed=1e6),dict(target=float('inf')),
    dict(smoothing=True),dict(smoothing=11),dict(smoothing=1.5),dict(display='chi'),dict(extra=1)])
def test_invalid_choices_cannot_modify_workspace(store,options):
    p=project(store)
    with pytest.raises((ValueError,WebInputError)):store.command(p['id'],command(p,**options))
    assert store.load(p['id'])==p


@pytest.mark.parametrize('coordinate', ['raw', 'display', None, True])
def test_explicit_unknown_coordinate_cannot_fall_back_to_legacy_raw_calibration(store,coordinate):
    p=project(store)
    request=Command(version=p['version'],action='calibrate',group_ids=[p['groups'][0]['id']],
                    options=dict(coordinate=coordinate,observed=8980,target=8982))
    for operation in (store.preview_calibration,store.command):
        with pytest.raises(ValueError,match='coordinate'):operation(p['id'],request)
        assert store.load(p['id'])==p


def test_detector_explicit_calibration_does_not_infer_absorber(store):
    p=project(store);p['groups'][0]['data_type']='detector';p['groups'][0]['source'].pop('edge_identity');p['groups'][0]['parameters']['e0']=None
    store.process(p['groups'][0]);p=store.save(p,store.load(p['id']),'Detector counts')
    with pytest.raises(WebInputError,match='observed reference'):store.preview_calibration(p['id'],command(p))
    preview=store.preview_calibration(p['id'],command(p,observed=9000,target=9002,display='mu'))
    assert preview['atomic_target'] is None
    after=store.command(p['id'],command(p,observed=9000,target=9002,display='mu'))
    assert after['groups'][0]['data_type']=='detector' and after['groups'][0]['result']['arrays']['chi']==[]


def test_http_preview_zero_and_stale_apply_are_revision_checked(tmp_path):
    client=TestClient(create_app(Settings(data_root=tmp_path)));p=client.post('/api/athena/projects',json={}).json()
    path=f'/api/athena/projects/{p["id"]}';p=client.post(path+'/command',json=dict(version=0,action='example')).json()
    req=command(p,display='second').model_dump()
    preview=client.post(path+'/calibration/preview',json=req);assert preview.status_code==200
    zero=client.post(path+'/calibration/zero',json=req);assert zero.status_code==200
    assert client.get(path).json()==p
    req['options']=zero.json()['options'];saved=client.post(path+'/command',json=req);assert saved.status_code==200
    assert client.post(path+'/calibration/preview',json=req).status_code==409
    assert client.post(path+'/calibration/zero',json=req).status_code==409
    assert client.post(path+'/command',json=req).status_code==409
    assert client.get(path).json()==saved.json()
