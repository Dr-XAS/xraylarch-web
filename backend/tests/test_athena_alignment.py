"""Alignment against original Demeter execution and transactional workflows."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_alignment import display_curve, fit_alignment, saved_fit
from xraylarch_web.athena_preprocessing import import_alignment
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.athena_smoothing_preferences import SGPreferenceRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIX=Path(__file__).parent/'fixtures'
NATIVE=json.loads(gzip.decompress((FIX/'athena-alignment-native.json.gz').read_bytes()))


def raw(energy,mu,e0,shift=0,label='measured'):
    return dict(id=label,label=label,data_type='mu',energy=energy,mu=mu,source={},
        parameters=AthenaParameters(e0=e0,energy_shift=shift).model_dump(),result=dict(effective=dict(e0=e0)))


@pytest.mark.parametrize('row',NATIVE['rows'],ids=lambda r:r['name'])
def test_native_larch_template_entire_residual_shift_scale_covariance_rounding_and_fixed_e0(row):
    case=row['case'];std=NATIVE['inputs'][case['standard']];native=row['native'];commit=row['commit']
    moving=raw(row['moving_energy'],row['moving_mu'],case['moving_e0'],case['moving_shift'])
    standard=raw(std['energy'],std['mu'],case['standard_e0'],case['standard_shift'])
    before=copy.deepcopy([moving,standard]);prefs=native['effective']
    result=fit_alignment(moving,standard,smoothed=bool(case['smoothed']),sg_window=prefs['window'],sg_order=prefs['order'])
    s=result['summary']
    assert s['energy_shift']==float(commit['shift'])
    assert s['native_shift_stderr']==float(commit['stderr'])
    np.testing.assert_allclose([s['fitted_shift'],s['derivative_scale'],s['shift_stderr'],s['chisqr'],s['redchi']],
        [row['fitted_shift'],row['scale'],row['stderr'],row['chisqr'],row['redchi']],rtol=2e-8,atol=2e-11)
    # Exact rigid copies approach machine-zero residuals along slightly
    # different LM termination paths; measured worst difference is 2.93e-11.
    np.testing.assert_allclose(result['curve']['residual'],row['residual'],rtol=2e-8,atol=1e-10)
    assert commit['e0']==case['moving_e0'] and commit['ref_e0']==case['moving_e0']+.75
    assert commit['ref_shift']==commit['shift'] and commit['ref_stderr']==commit['stderr']
    assert native['display']==dict(window=21,order=9) and native['restored']==prefs
    assert native['factory']==dict(window=31,order=9)
    assert [moving,standard]==before
    if case['smoothed']:
        assert import_alignment(moving,standard,sg_window=prefs['window'],sg_order=prefs['order'])==s


@pytest.fixture
def store(tmp_path):return AthenaStore(Settings(data_root=tmp_path))


def project(store):
    p=store.create();source=NATIVE['inputs']['Cu'];x=np.asarray(source['energy']);y=np.asarray(source['mu'])
    for label,offset,gain in [('standard',0,1),('moving',3.1254,2)]:
        g=store.make_group(label,x+offset,y*gain,parameters=dict(e0=source['e0']+offset),source={'filename':source['fixture']})
        assert not g['processing_error'];p['groups'].append(g)
    return store.save(p,store.load(p['id']),'Measured alignment fixtures')


def command(p,ids=None,**options):
    return Command(version=p['version'],action='align',group_ids=ids or [p['groups'][1]['id']],
        options=dict(method='demeter-larch',standard_id=p['groups'][0]['id'],operation='auto',**options))


@pytest.mark.parametrize('display',['mu','norm','derivative','smoothed'])
@pytest.mark.parametrize('fit',['derivative','smoothed'])
def test_preview_save_undo_and_bare_native_prj_preserve_e0_measurements_and_uncertainty(store,display,fit):
    p=project(store);before=copy.deepcopy(p);req=command(p,display=display,fit=fit)
    preview=store.preview_alignment(p['id'],req);assert store.load(p['id'])==before
    row=preview['rows'][0];assert row['energy_shift']==-3.125 and row['fit']['summary']['derivative_scale']==pytest.approx(.5,rel=1e-5)
    for key in ['before','after','standard']:assert len(row[key]['x'])==len(row[key]['y'])==408
    saved=store.command(p['id'],req);std,g=saved['groups'];old=p['groups'][1]
    assert std==p['groups'][0] and g['parameters']['e0']==old['parameters']['e0']
    assert g['energy']==old['energy'] and g['mu']==old['mu']
    assert saved_fit(g)['energy_shift']==-3.125
    assert display_curve(g,display)==row['after']
    undone=store.command(p['id'],Command(version=saved['version'],action='undo'));assert undone['groups']==p['groups']
    redone=store.command(p['id'],Command(version=undone['version'],action='redo'));assert redone['groups']==saved['groups']
    data=store.export_project(p['id'],'prj')
    bare='\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    for content in [data,bare]:
        restored=store.restore(store.create()['id'],0,content,'aligned.prj')['groups'][1]
        assert restored['parameters']['energy_shift']==g['parameters']['energy_shift']
        assert restored['parameters']['e0']==g['parameters']['e0']
        assert saved_fit(restored)['native_shift_stderr']==saved_fit(g)['native_shift_stderr']


def test_manual_total_shift_keeps_distinct_reference_e0_clears_uncertainty_and_deduplicates_marked(store):
    p=project(store);sample=p['groups'][1];ref=copy.deepcopy(sample);ref['id']='linked-reference';ref['parameters']['e0']+=.75
    sample['reference_id']=ref['id'];p['groups'].append(ref);p=store.save(p,store.load(p['id']),'Link reference')
    req=command(p,ids=[g['id'] for g in p['groups']]);preview=store.preview_alignment(p['id'],req)
    assert len(preview['rows'])==1 and len(preview['changes'])==2 and len(preview['skipped_reasons'])==2
    saved=store.command(p['id'],req)
    req=command(saved);req.options.update(operation='manual',energy_shift=1.234567)
    manually=store.command(p['id'],req)
    for g,old in zip(manually['groups'][1:],p['groups'][1:]):
        assert g['parameters']['energy_shift']==1.234567 and g['parameters']['e0']==old['parameters']['e0']
        assert saved_fit(g)['shift_stderr'] is None
    frozen=copy.deepcopy(manually);frozen['groups'][2]['frozen']=True;frozen=store.save(frozen,manually,'Freeze ref')
    with pytest.raises(WebInputError,match='Unfreeze'):store.preview_alignment(p['id'],command(frozen))
    assert store.load(p['id'])==frozen


def test_two_reference_channels_are_used_only_when_both_present(store):
    p=project(store)
    for g in p['groups'].copy():
        ref=copy.deepcopy(g);ref['id']='ref-'+g['id'];ref['label']='Ref '+g['label'];g['reference_id']=ref['id'];p['groups'].append(ref)
    p=store.save(p,store.load(p['id']),'Pair refs')
    req=command(p,use_reference=True);preview=store.preview_alignment(p['id'],req);r=preview['rows'][0]
    assert r['used_references'] and r['moving_id']==p['groups'][1]['reference_id'] and r['standard_id']==p['groups'][0]['reference_id']
    after=store.command(p['id'],req)
    for index in [0,2]:assert after['groups'][index]==p['groups'][index]
    p['groups'][1]['reference_id']=None;p=store.save(p,after,'Missing reference')
    fallback=store.preview_alignment(p['id'],command(p,use_reference=True))['rows'][0]
    assert not fallback['used_references'] and fallback['moving_id']==p['groups'][1]['id'] and fallback['standard_id']==p['groups'][0]['id']


def test_fit_captures_preferences_display_is_independent_inspect_is_readonly_and_stale_edits_fail(store):
    p=project(store);req=command(p);req.options['operation']='inspect'
    preview=store.preview_alignment(p['id'],req);assert not preview['changes'] and not preview['rows'][0]['fit']
    with pytest.raises(WebInputError,match='before saving'):store.command(p['id'],req)
    first=store.preview_alignment(p['id'],command(p));pref=store.smoothing_preferences.read()
    store.smoothing_preferences.apply(SGPreferenceRequest(version=pref['version'],session_id=pref['session_id'],values=dict(window=21,order=9)))
    second=store.preview_alignment(p['id'],command(p))
    assert first['rows'][0]['before']==second['rows'][0]['before']
    assert first['rows'][0]['fit']['summary']['smoothing_window']==31 and second['rows'][0]['fit']['summary']['smoothing_window']==21
    req.options=first['options'];saved=store.command(p['id'],req)
    assert saved_fit(saved['groups'][1])['smoothing_window']==31
    with pytest.raises(WebInputError):store.preview_alignment(p['id'],command(p))
    changed=copy.deepcopy(saved['groups'][1]);changed['mu'][0]+=.001;assert saved_fit(changed) is None
    changed=copy.deepcopy(saved['groups'][1]);changed['parameters']['energy_shift']+=.01;assert saved_fit(changed) is None


@pytest.mark.parametrize('bad',[dict(method='other'),dict(energy_shift=float('inf')),dict(fit='mu'),dict(display='second'),dict(sg_order=4),dict(use_reference='yes'),dict(xmin=8980)])
def test_api_invalid_options_leave_project_unchanged(store,bad):
    p=project(store);req=command(p);req.options.update(bad)
    with TestClient(create_app(store.settings)) as client:
        # JSON cannot encode infinity; validate it directly.
        if bad.get('energy_shift')==float('inf'):
            with pytest.raises(ValueError):store.preview_alignment(p['id'],req)
        else:
            response=client.post(f"/api/athena/projects/{p['id']}/alignment/preview",json=req.model_dump())
            assert response.status_code==400,response.text
            assert response.json()['error']['code']=='athena_invalid'
    assert store.load(p['id'])==p


def test_api_healthy_preview_conflict_and_fixed_standard_dependency(store):
    p=project(store)
    with TestClient(create_app(store.settings)) as client:
        url=f"/api/athena/projects/{p['id']}/alignment/preview"
        response=client.post(url,json=command(p).model_dump());assert response.status_code==200,response.text
        req=command(p);req.version-=1;assert client.post(url,json=req.model_dump()).status_code==409
    p['groups'][0]['background_standard_id']=p['groups'][1]['id'];p=store.save(p,store.load(p['id']),'Dependency')
    with pytest.raises(WebInputError,match='fixed standard'):store.preview_alignment(p['id'],command(p))


def test_hashes_for_original_sources_inputs_driver_and_oracle():
    root=FIX.parents[2];manifest=json.loads((FIX/'athena-alignment-fixtures.json').read_text())
    catalog={r['file']:r['sha256'] for r in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((root/path).read_bytes()).hexdigest()==sha
    for path,sha in NATIVE['sources'].items():assert catalog['demeter-'+manifest['demeter_revision']+'/'+path]==sha
    assert len(NATIVE['rows'])==manifest['case_count']==31
