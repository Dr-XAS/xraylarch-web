"""Original Demeter merge arithmetic, filtering, references and native exchange."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_merge import MergeOptions, merge, noise
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIX=Path(__file__).parent/'fixtures'
NATIVE=json.loads(gzip.decompress((FIX/'athena-merge-native.json.gz').read_bytes()))


def group(raw):
    arrays=copy.deepcopy(raw['arrays']);shift=raw['bkg_eshift']
    return dict(id=raw['group'],label=raw['name'],energy=arrays['energy'],mu=arrays['xmu'],data_type='mu',source={'importance':raw['importance']},
        parameters=AthenaParameters(e0=raw['bkg_e0'],energy_shift=shift,kmin=3,kmax=12,dk=1,kweight=2,window='hanning').model_dump(),
        result=dict(arrays=dict(energy=(np.asarray(arrays['energy'])+shift).tolist(),norm=arrays['norm'],k=arrays['k'],chi=arrays['chi']),effective=dict(edge_step=raw['bkg_step'],kmax=12)))


@pytest.mark.parametrize('row',NATIVE['rows'],ids=lambda r:r['name'])
def test_original_perl_dispatch_and_larch_merge_arrays_weights_scatter_short_scan_boundary(row):
    case=row['case'];groups=[group(r) for r in row['groups']];before=copy.deepcopy(groups)
    choice=MergeOptions(array={'e':'mu','n':'norm','k':'chi'}[case['how']],weightby=case['weightby'],exclude_short_data=case['exclude'],short_data_margin=case['margin'])
    got=merge(groups,choice)
    np.testing.assert_allclose(got['x'],row['x'],rtol=0,atol=2e-12)
    np.testing.assert_allclose(got['y'],row['y'],rtol=2e-12,atol=2e-13)
    np.testing.assert_allclose(got['stddev'],row['stddev'],rtol=2e-10,atol=2e-13)
    used=[r for r in row['native']['members'] if r['weight']!=0 or r['group'] in [g['group_id'] for g in got['members']]]
    assert [g['group_id'] for g in got['members']]==[g['group'] for g in used]
    np.testing.assert_allclose([g['coefficient'] for g in got['members']],[g['weight'] for g in used],rtol=1e-14)
    assert row['native']['config']['ndata']==got['details']['count']
    assert row['native']['defaults']==dict(exclude_short_data='1',short_data_margin=10,weightby='importance',push_metadata='1')
    assert row['native']['merged']['bkg_e0']==groups[0]['parameters']['e0'] and row['native']['merged']['bkg_eshift']==0
    assert groups==before
    if case['weightby']=='noise':
        assert [noise(g) for g in groups]==[r['epsk'] for r in row['groups']]
        assert 'larger noise receives more weight' in got['warnings'][0]


@pytest.fixture
def store(tmp_path):return AthenaStore(Settings(data_root=tmp_path))


def project(store,refs=False):
    p=store.create()
    for src in NATIVE['rows'][0]['groups']:
        raw=group(src)
        g=store.make_group(src['name'],raw['energy'],raw['mu'],parameters=raw['parameters'],source={'importance':src['importance']})
        assert g['processing_error'] is None;p['groups'].append(g)
    if refs:
        for g in p['groups'].copy():
            ref=copy.deepcopy(g);ref['id']='ref-'+g['id'];ref['label']='Ref '+g['label'];ref['marked']=False
            ref['reference_id']=g['id'];g['reference_id']=ref['id'];p['groups'].append(ref)
    return store.save(p,store.load(p['id']),'Measured Fe merge inputs')


def command(p,**options):return Command(version=p['version'],action='merge',group_ids=[g['id'] for g in p['groups'] if g['marked']],options={'method':'demeter-larch',**options})


@pytest.mark.parametrize('array',['mu','norm','chi'])
@pytest.mark.parametrize('weightby',['importance','step','noise'])
def test_preview_exact_save_source_immutability_reference_creation_undo_and_bare_prj(store,array,weightby):
    p=project(store,refs=True);before=copy.deepcopy(p);req=command(p,array=array,weightby=weightby)
    preview=store.preview_merge(p['id'],req);assert store.load(p['id'])==before
    n=1 if array=='chi' else 2;assert len(preview['outputs'])==n
    assert all(len(row['curves'])==3 for row in preview['outputs'])
    saved=store.command(p['id'],Command(version=p['version'],action='merge',group_ids=req.group_ids,options=preview['options']))
    assert saved['groups'][:6]==p['groups']
    for g,row in zip(saved['groups'][6:],preview['outputs']):
        assert g['energy']==row['result']['x'] and g['mu']==row['result']['y']
        assert g['source']['raw_arrays']['stddev']==row['result']['stddev']
        assert g['parameters']['energy_shift']==0
    if n==2:
        a,b=saved['groups'][-2:];assert a['reference_id']==b['id'] and b['reference_id']==a['id'];assert a['marked'] and not b['marked']
    undo=store.command(p['id'],Command(version=saved['version'],action='undo'));assert undo['groups']==p['groups']
    redo=store.command(p['id'],Command(version=undo['version'],action='redo'));assert redo['groups']==saved['groups']
    data=store.export_project(p['id'],'prj');bare='\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    for content in [data,bare]:
        imported=store.restore(store.create()['id'],0,content,'merged.prj')['groups']
        for g,old in zip(imported[6:],saved['groups'][6:]):
            assert g['energy']==old['energy'] and g['mu']==old['mu'] and g['source']['raw_arrays']['stddev']==old['source']['raw_arrays']['stddev']
        if n==2:assert imported[-2]['reference_id']==imported[-1]['id']


def test_saved_merge_preferences_capture_reload_conflict_and_project_independence(store):
    p=project(store);first=store.preferences.read_merge();assert first['values']['exclude_short_data']
    first['values'].update(weightby='step',short_data_margin=15,plot='variance',push_metadata=False)
    saved=store.preferences.save_merge(first);assert AthenaStore(store.settings).preferences.read_merge()==saved
    with pytest.raises(WebInputError):store.preferences.save_merge(first)
    r=store.preview_merge(p['id'],command(p));assert r['options']['weightby']=='step' and r['options']['plot']=='variance'
    assert len(r['outputs'][0]['curves'])==2
    assert store.load(p['id'])==p


def test_short_scan_filtering_reference_counts_and_partial_refs_notice(store):
    p=project(store,refs=True);g=p['groups'][2]
    g['energy']=g['energy'][:-11];g['mu']=g['mu'][:-11];store.process(g,p);p=store.save(p,store.load(p['id']),'Short scan')
    v=store.preview_merge(p['id'],command(p,reference_weights={g['id']:1 for g in p['groups'] if not g['marked']}));assert len(v['outputs'][0]['result']['members'])==2
    assert len(v['outputs'][1]['result']['members'])==2 and v['outputs'][0]['result']['excluded'][0]['group_id']==g['id']
    p['groups'][1]['reference_id']=None;p=store.save(p,store.load(p['id']),'Missing ref')
    v=store.preview_merge(p['id'],command(p));assert len(v['outputs'])==1 and 'no linked reference' in v['notes'][0]


def test_frozen_inputs_can_be_read_and_missing_chi_or_invalid_weights_cannot_mutate(store):
    p=project(store);p['groups'][0]['frozen']=True;p=store.save(p,store.load(p['id']),'Frozen source')
    v=store.preview_merge(p['id'],command(p));assert v['outputs']
    for opts in [dict(weights={g['id']:0 for g in p['groups']}),dict(weights={'unknown':1}),dict(array='xmu'),dict(method='other'),dict(weightby='inverse_noise')]:
        with pytest.raises(ValueError):store.preview_merge(p['id'],command(p,**opts))
    p['groups'][1]['result']=None;p=store.save(p,store.load(p['id']),'Unprocessed input')
    with pytest.raises(ValueError):store.preview_merge(p['id'],command(p,array='chi'))
    assert store.load(p['id'])==p


def test_http_preview_preferences_validation_stale_revision_and_native_scatter_column(store):
    p=project(store)
    with TestClient(create_app(store.settings)) as client:
        url=f"/api/athena/projects/{p['id']}";req=command(p)
        v=client.post(url+'/merge/preview',json=req.model_dump());assert v.status_code==200,v.text
        saved=client.post(url+'/command',json=req.model_dump());assert saved.status_code==200,saved.text
        assert client.post(url+'/merge/preview',json=req.model_dump()).status_code==409
        g=saved.json()['groups'][-1];csv=client.get(url+f"/groups/{g['id']}/export?space=E")
        assert csv.status_code==200 and 'merge_stddev' in csv.text.splitlines()[0] and 'population_stddev' not in csv.text
        defaults=client.get('/api/athena/preferences/merge');assert defaults.status_code==200
        bad=defaults.json();bad['values']['short_data_margin']=-1;assert client.put('/api/athena/preferences/merge',json=bad).status_code==400


def test_native_merge_hash_manifest():
    root=FIX.parents[2];manifest=json.loads((FIX/'athena-merge-fixtures.json').read_text())
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((root/path).read_bytes()).hexdigest()==sha
    assert manifest['case_count']==len(NATIVE['rows'])==30
