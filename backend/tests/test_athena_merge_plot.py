"""Stored/native PRJ scatter, real Perl plot arrays and read-only lifecycle."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_merge_plot import MergePlotOptions, saved_merge_plot
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIX=Path(__file__).parent/'fixtures'
ROOT=FIX.parents[2]
NATIVE=json.loads(gzip.decompress((FIX/'athena-merge-plot-native.json.gz').read_bytes()))


def probe(row):
    a=row['arrays'];chi=row['how']=='k'
    return dict(id='probe',label='Measured merge',energy=a['k'] if chi else a['energy'],mu=a['chi'] if chi else a['xmu'],
        data_type='chi' if chi else 'mu',multiplier=row['scale'],offset=row['offset'],
        parameters=dict(energy_shift=0 if chi else 2.375,flatten=row['display']=='flat',kweight=row['weight']),
        source=dict(native=dict(args=dict(is_merge=row['how'])),raw_arrays=dict(stddev=a['stddev'])),
        result=dict(arrays=dict(energy=(np.asarray(a['energy'])+2.375).tolist(),norm=a.get('norm',[]),flat=a.get('flat',[]))))


@pytest.mark.parametrize('row',NATIVE['rows'],ids=lambda r:str(r['id']))
def test_original_plot_dispatch_templates_and_points_writer(row):
    g=probe(row);before=copy.deepcopy(g)
    view=saved_merge_plot(g,MergePlotOptions(version=0,view=row['view'],energy_display=row['display'] if row['display'] in ('norm','flat') else 'mu'))
    assert g==before
    if row['native']['error']:
        assert row.get('zero') and row['view']=='variance'
        assert view['curves'][1]['y']==[g['offset']]*len(g['energy'])
        assert any('division by zero' in n for n in view['notes'])
    else:
        assert len(view['curves'])==len(row['native']['curves'])
        for got,want in zip(view['curves'],row['native']['curves']):
            np.testing.assert_allclose(np.array([got['x'],got['y']]).T,want,rtol=2e-13,atol=5e-11)
        assert row['native']['updates']==['fft']
        assert row['native']['templates'][0] in ('newe','newk')


@pytest.fixture
def store(tmp_path):return AthenaStore(Settings(data_root=tmp_path))


def merged_project(store,array='mu'):
    source=json.loads(gzip.decompress((FIX/'athena-merge-native.json.gz').read_bytes()))['rows'][0]['groups']
    p=store.create()
    for raw in source:
        p['groups'].append(store.make_group(raw['name'],raw['arrays']['energy'],raw['arrays']['xmu']))
    p=store.save(p,store.load(p['id']),'Measured Fe inputs')
    return store.command(p['id'],Command(version=p['version'],action='merge',group_ids=[g['id'] for g in p['groups']],options=dict(method='demeter-larch',array=array)))


@pytest.mark.parametrize('array',['mu','norm','chi'])
def test_close_restart_frozen_and_bare_native_prj_keep_saved_spread(store,array):
    p=merged_project(store,array);g=p['groups'][-1]
    g.update(frozen=True,multiplier=2.5,offset=.125)
    p=store.save(p,store.load(p['id']),'Plot settings');before=copy.deepcopy(p)
    baseline={view:store.plot_saved_merge(p['id'],g['id'],dict(version=p['version'],view=view))['result'] for view in ['stddev','variance']}
    again=AthenaStore(store.settings)
    assert again.plot_saved_merge(p['id'],g['id'],dict(version=p['version']))['result']==baseline['stddev']
    assert store.load(p['id'])==before
    data=store.export_project(p['id'],'prj')
    bare='\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    for payload in [data,bare]:
        target=store.create();restored=store.restore(target['id'],target['version'],payload,'merged.prj');new=restored['groups'][-1]
        for view in ['stddev','variance']:
            got=store.plot_saved_merge(restored['id'],new['id'],dict(version=restored['version'],view=view))['result']
            for c,old in zip(got['curves'],baseline[view]['curves']):
                np.testing.assert_allclose(c['x'],old['x'],rtol=0,atol=1e-12)
                np.testing.assert_allclose(c['y'],old['y'],rtol=2e-11,atol=1e-11)
        assert 'is_merge' not in new['source'].get('native',{}).get('unapplied_args',[])


def test_original_historical_project_spread_matches_saved_native_array(store):
    p=store.create();path=ROOT/'examples/xafsdata/AthenaProjectFiles/AsScorodite.prj'
    p=store.restore(p['id'],p['version'],path.read_bytes(),path.name);g=p['groups'][0];before=copy.deepcopy(p)
    got=store.plot_saved_merge(p['id'],g['id'],dict(version=p['version']))['result']
    sigma=np.asarray(g['source']['raw_arrays']['stddev']);mu=np.asarray(g['mu'])
    assert got['origin']=='native' and got['merge_space']=='mu'
    np.testing.assert_allclose(got['curves'][1]['y'],mu+sigma,rtol=0,atol=1e-14)
    assert store.load(p['id'])==before


@pytest.mark.parametrize('array',['mu','norm','chi'])
def test_new_merges_inherit_first_contributor_plot_settings_without_changing_saved_arrays(store,array):
    p=merged_project(store,array);p['groups'][0].update(multiplier=2.5,offset=.375)
    p=store.save(p,store.load(p['id']),'First-source plot settings');before=copy.deepcopy(p)
    req=Command(version=p['version'],action='merge',group_ids=[g['id'] for g in p['groups'][:3]],options=dict(method='demeter-larch',array=array))
    preview=store.preview_merge(p['id'],req)
    saved=store.command(p['id'],req);g=saved['groups'][-1]
    assert g['multiplier']==2.5 and g['offset']==.375
    assert g['energy']==preview['outputs'][0]['result']['x'] and g['mu']==preview['outputs'][0]['result']['y']
    assert saved['groups'][:-1]==before['groups']
    view=store.plot_saved_merge(p['id'],g['id'],dict(version=saved['version']))['result']
    assert view['multiplier']==2.5 and view['offset']==.375


@pytest.mark.parametrize('damage',['missing','length','negative','nonfinite','identity','type','processed-grid'])
def test_invalid_saved_scatter_or_identity_is_not_silently_reconstructed(damage):
    g=probe(next(r for r in NATIVE['rows'] if r['how']=='n'))
    if damage=='missing':g['source']['raw_arrays'].clear()
    if damage=='length':g['source']['raw_arrays']['stddev']=g['source']['raw_arrays']['stddev'][:-1]
    if damage=='negative':g['source']['raw_arrays']['stddev']=[-1]*len(g['energy'])
    if damage=='nonfinite':g['source']['raw_arrays']['stddev']=[float('nan')]*len(g['energy'])
    if damage=='identity':g['source']['native']['args']['is_merge']='q'
    if damage=='type':g['data_type']='chi'
    if damage=='processed-grid':g['result']['arrays']['energy'][0]+=1
    with pytest.raises(ValueError):saved_merge_plot(g,MergePlotOptions(version=0))


def test_legacy_population_scatter_is_labelled_and_never_reestimated():
    g=probe(NATIVE['rows'][0]);sigma=g['source']['raw_arrays']['stddev'];g['source']=dict(operation='merge',array='mu',stddev=sigma)
    got=saved_merge_plot(g,MergePlotOptions(version=0));assert got['origin']=='legacy-population'
    np.testing.assert_allclose(np.asarray(got['curves'][1]['y'])-np.asarray(got['curves'][0]['y']),sigma)
    assert any('population' in n for n in got['notes'])


def test_http_view_rejects_stale_revision_and_invalid_options_without_mutation(store):
    p=merged_project(store);g=p['groups'][-1]
    with TestClient(create_app(store.settings)) as client:
        url=f"/api/athena/projects/{p['id']}/groups/{g['id']}/merge/plot"
        assert client.post(url,json={'version':p['version']}).status_code==200
        assert client.post(url,json={'version':p['version']-1}).status_code==409
        for extra in [dict(kweight=-1),dict(kweight=5),dict(view='marked'),dict(flatten='true')]:
            assert client.post(url,json=dict(version=p['version'],**extra)).status_code==400
        assert store.load(p['id'])==p


def test_reference_manifest():
    manifest=json.loads((FIX/'athena-merge-plot-fixtures.json').read_text())
    assert manifest['case_count']==len(NATIVE['rows'])==46
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==sha
