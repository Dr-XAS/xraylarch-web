"""Executed native convolution/noise references and usable project workflow."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_convolution import ConvolutionOptions, broaden, add_noise
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIX = Path(__file__).parent/'fixtures'
NATIVE = json.loads(gzip.decompress((FIX/'athena-convolution-native.json.gz').read_bytes()))


@pytest.mark.parametrize('row',NATIVE['rows'],ids=lambda r:r['name'])
def test_unchanged_native_ui_methods_and_larch_output(row):
    src=NATIVE['inputs'][row['input']]
    choice=ConvolutionOptions(form=row['form'],width=max(0,row['width']),noise=max(0,row['noise']),seed=row['seed'])
    conv=broaden(src['energy'],src['mu'],choice)
    result,details=add_noise(conv['mu'],choice,row['edge_step'],chi=row.get('chi',False))
    assert conv['energy']==src['energy']
    np.testing.assert_allclose(result,row['modified_mu'],atol=2e-14,rtol=2e-14)
    if row.get('noise_values'):
        np.testing.assert_allclose(np.asarray(result)-conv['mu'],row['noise_values'],atol=2e-14,rtol=2e-14)
    assert details['noise_sigma']==choice.noise*(1 if row.get('chi') else row['edge_step'])
    if not row.get('chi'):
        assert row['label']==f"Measured source: {choice.width:.2f} eV {choice.form.capitalize()}, {choice.noise:.3f} noise"


@pytest.fixture
def store(tmp_path):return AthenaStore(Settings(data_root=tmp_path))


def project(store,dtype='mu',shift=0):
    p=store.create();src=NATIVE['inputs']['Cu']
    if dtype=='chi':
        x=np.linspace(0,12,241);mu=np.sin(x*3)*np.exp(-x/6)
    else:x,mu=src['energy'],src['mu']
    group=store.make_group('Measured Cu',x,mu,data_type=dtype,parameters=dict(energy_shift=shift))
    p['groups']=[group];return store.save(p,store.load(p["id"]),"Test fixture")


def command(p,**options):return Command(version=p['version'],action='convolve',group_ids=[p['groups'][0]['id']],options=options)


@pytest.mark.parametrize('form',['gaussian','lorentzian'])
def test_frozen_source_preview_save_exact_noise_calibration_order_undo_and_exchange(store,form):
    p=project(store,shift=2.3);p['groups'][0]['frozen']=True;p=store.save(p,store.load(p["id"]),"Test fixture")
    original=copy.deepcopy(p)
    clean=store.preview_convolution(p['id'],command(p,form=form,width=1))
    preview=store.preview_convolution(p['id'],command(p,form=form,width=1,noise=.01))
    row=preview['results'][0];assert store.load(p['id'])==original
    assert row['details']['edge_step']==clean['results'][0]['details']['edge_step']
    assert isinstance(preview['options']['seed'],int)
    assert row['modified_energy']==[x+2.3 for x in original['groups'][0]['energy']]
    assert row['parameters']['energy_shift']==0
    expected=np.asarray(clean['results'][0]['modified_mu'])+np.random.RandomState(preview['options']['seed']).normal(size=len(row['modified_mu']),scale=row['details']['edge_step']*.01)
    np.testing.assert_array_equal(row['modified_mu'],expected)
    saved=store.command(p['id'],command(p,**preview['options']))
    assert saved['groups'][0]==original['groups'][0]
    child=saved['groups'][1];assert not child['frozen']
    assert child['mu']==row['modified_mu'] and child['energy']==row['modified_energy']
    assert child['source']['options']['seed']==preview['options']['seed']
    assert f"seed {preview['options']['seed']}" in child['source']['xdi_metadata']['attributes']['scan']['process']
    assert child['result']['arrays']['mu']==row['modified_mu']
    for space in ['E','k','R']:assert len(row['traces'][space])==2
    exported=store.export_project(p['id'],'prj')
    bare='\n'.join(l for l in gzip.decompress(exported).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    restored=store.restore(store.create()['id'],0,bare,'native.prj')
    assert restored['groups'][1]['energy']==child['energy']
    assert restored['groups'][1]['mu']==child['mu']
    assert restored['groups'][1]['source']['xdi_metadata']['attributes']['scan']['process']==child['source']['xdi_metadata']['attributes']['scan']['process']
    undone=store.command(p['id'],Command(version=saved['version'],action='undo'))
    assert undone['groups']==original['groups']
    redo=store.command(p['id'],Command(version=undone['version'],action='redo'))
    assert redo['groups']==saved['groups']


def test_noise_seed_stream_is_private_repeatable_and_no_global_randomness_changes():
    state=np.random.get_state();choice=ConvolutionOptions(noise=.02,seed=123)
    def run(_):return add_noise(np.ones(10000),choice,2.5)[0]
    with ThreadPoolExecutor(max_workers=3) as pool:result=list(pool.map(run,range(3)))
    assert result[0]==result[1]==result[2]
    after=np.random.get_state();assert after[0]==state[0] and after[2:]==state[2:]
    np.testing.assert_array_equal(after[1],state[1])
    noise=np.asarray(result[0])-1
    assert abs(noise.mean())<.05*.05
    assert abs(noise.std()-.05)<.003


def test_zero_width_noise_is_exact_copy_and_new_previews_draw_new_noise(store):
    p=project(store);raw=p['groups'][0]
    clean=store.preview_convolution(p['id'],command(p))
    assert clean['results'][0]['modified_mu']==raw['mu']
    assert clean['options']['seed'] is None
    a=store.preview_convolution(p['id'],command(p,noise=.01));b=store.preview_convolution(p['id'],command(p,noise=.01))
    assert a['options']['seed']!=b['options']['seed']
    assert a['results'][0]['modified_mu']!=b['results'][0]['modified_mu']
    repeated=store.preview_convolution(p['id'],command(p,**a['options']))
    assert repeated['results']==a['results']


@pytest.mark.parametrize('dtype',['norm','xanes','chi','detector'])
def test_type_preservation_and_noise_eligibility(store,dtype):
    p=project(store,dtype=dtype)
    opts=dict(width=0 if dtype=='chi' else 1,noise=0 if dtype=='detector' else .01,seed=7)
    preview=store.preview_convolution(p['id'],command(p,**opts));row=preview['results'][0]
    saved=store.command(p['id'],command(p,**preview['options']));child=saved['groups'][1]
    assert child['data_type']==dtype and child['is_normalized']==p['groups'][0]['is_normalized']
    assert child['mu']==row['modified_mu']
    if dtype=='chi':
        assert row['details']['noise_sigma']==.01 and row['traces']['E']==[]
        with pytest.raises(ValueError,match='zero width'):store.preview_convolution(p['id'],command(saved,width=1))
    if dtype=='detector':
        assert row['traces']['k']==row['traces']['R']==[]
        with pytest.raises(ValueError,match='edge step'):store.preview_convolution(p['id'],command(saved,noise=.01))


@pytest.mark.parametrize('options',[dict(width=-1),dict(noise=-1),dict(width=True),dict(noise='0.01'),dict(seed=True),dict(seed=-1),dict(seed=2**32),dict(form='voigt'),dict(width=float('inf')),dict(extra=1)])
def test_invalid_options_reject_before_mutation(store,options):
    p=project(store)
    with pytest.raises(ValidationError):store.preview_convolution(p['id'],command(p,**options))
    assert store.load(p['id'])==p


def test_pathological_grid_rejects_before_larch_and_noise_alone_does_not_regrid(monkeypatch):
    from xraylarch_web import athena_convolution as module
    x=np.r_[0,1e-8,np.arange(1,10000)];y=np.ones(len(x))
    def forbidden(*args,**kwargs):pytest.fail('must reject before Larch allocation')
    monkeypatch.setattr(module,'larch_smooth',forbidden)
    with pytest.raises(ValueError,match='work limit'):broaden(x,y,ConvolutionOptions(width=1))
    assert broaden(x,y,ConvolutionOptions())['mu']==y.tolist()


def test_batch_order_distinct_noise_streams_and_atomic_failure(store):
    p=project(store);g=copy.deepcopy(p['groups'][0]);g['id']='second';p['groups'].append(g);p=store.save(p,store.load(p["id"]),"Test fixture")
    req=Command(version=p['version'],action='convolve',group_ids=[g['id'],p['groups'][0]['id']],options=dict(noise=.01,seed=10))
    preview=store.preview_convolution(p['id'],req)
    assert [r['details']['seed'] for r in preview['results']]==[10,11]
    assert preview['results'][0]['modified_mu']!=preview['results'][1]['modified_mu']
    after=store.command(p['id'],req)
    assert [q['source'].get('parent') for q in after['groups']]==[None,p['groups'][0]['id'],None,g['id']]
    p=project(store);g=store.make_group('counts',p['groups'][0]['energy'],p['groups'][0]['mu'],data_type='detector');p['groups'].append(g);p=store.save(p,store.load(p["id"]),"Test fixture")
    with pytest.raises(ValueError,match='edge step'):store.command(p['id'],Command(version=p['version'],action='convolve',group_ids=[q['id'] for q in p['groups']],options=dict(noise=.01)))
    assert store.load(p['id'])==p


def test_http_stale_preview_save_and_noise_seed_capture(tmp_path):
    client=TestClient(create_app(Settings(data_root=tmp_path)));p=client.post('/api/athena/projects',json={}).json()
    path=f'/api/athena/projects/{p["id"]}'
    p=client.post(path+'/command',json=dict(version=p['version'],action='example')).json()
    req=command(p,width=1,noise=.01).model_dump()
    response=client.post(path+'/convolve/preview',json=req);assert response.status_code==200,response.text
    preview=response.json();req['options']=preview['options']
    response=client.post(path+'/command',json=req);assert response.status_code==200,response.text
    assert response.json()['groups'][1]['mu']==preview['results'][0]['modified_mu']
    assert client.post(path+'/convolve/preview',json=req).status_code==409
    assert client.post(path+'/command',json=req).status_code==409


def test_pinned_reference_manifest():
    root=Path(__file__).resolve().parents[2];manifest=json.loads((FIX/'athena-convolution-fixtures.json').read_text())
    assert manifest['source_sha256']==NATIVE['sources']
    assert manifest['case_count']==len(NATIVE['rows'])==25
    for name,sha in manifest['sha256'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==sha
    catalog={r['file']:r['sha256'] for r in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    for name,sha in NATIVE['sources'].items():assert catalog['demeter-'+manifest['demeter_revision']+'/'+name]==sha
