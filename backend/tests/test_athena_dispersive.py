"""Real pixel files, independent interpolation checks, project and HTTP flows.

Measured-file fitting checks convergence and physical ranges, not an unmeasured
claim of agreement with the Ifeffit optimizer. Fixture bytes are pinned upstream.
"""
import copy
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch.io import read_athena
from pydantic import ValidationError
from scipy.interpolate import BarycentricInterpolator

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_dispersive import (
    Coefficients, DispersiveDefaults, DispersiveRequest, PixelNormalization,
    apply, decode_calibration, encode_calibration, guess, parse_pixels,
    qinterp, refine, smooth_derivative,
)
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES=Path(__file__).parent/'fixtures'
SLRI='Demeter::Plugins::SLRIBL4'


def fixture(metal,kind):
    return FIXTURES/f'demeter-dxas-{metal}-{kind}.{ "csv" if (metal,kind)==("pd","pixels") else "dat"}'


def table(x,y):
    out=io.StringIO();np.savetxt(out,np.column_stack((x,y)),header='pixel signal',fmt='%.17g')
    return out.getvalue().encode()


def standards(tmp_path,metal='cu'):
    store=AthenaStore(Settings(data_root=tmp_path));p=store.create()
    path=fixture(metal,'standard');i=store.inspect(p['id'],path.read_bytes(),path.name)
    ids=[c['column_id'] for c in i['columns']]
    p=store.import_data(p['id'],ImportRequest(version=0,upload_id=i['upload_id'],energy_column=ids[0],numerator=[ids[1]],units='keV' if metal=='cu' else 'eV'))
    path=fixture(metal,'pixels');i=store.inspect_dispersive(p['id'],path.read_bytes(),path.name)
    ids=[c['column_id'] for c in i['columns']]
    req=DispersiveRequest(version=p['version'],upload_id=i['upload_id'],standard_id=p['groups'][0]['id'],
        columns=dict(pixel_column=ids[0],numerator=[ids[1]],reverse_signal=metal=='pd'),
        normalization=PixelNormalization(pre1=-410,pre2=-120,norm1=150,norm2=600) if metal=='pd' else PixelNormalization())
    return store,p,i,req


def test_downloads_match_upstream_blob_and_digest():
    for f in json.loads((FIXTURES/'athena-dispersive-fixtures.json').read_text())['files']:
        data=(FIXTURES/f['file']).read_bytes()
        assert len(data)==f['bytes']
        assert hashlib.sha256(data).hexdigest()==f['sha256']
        assert hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==f['git_blob_sha1']


@pytest.mark.parametrize('metal,count,first', [('cu',1241,0),('pd',1024,1)])
def test_official_headers_and_every_numeric_observation(metal,count,first):
    path=fixture(metal,'pixels');data=path.read_bytes()
    p=parse_pixels(data,path.name,50000,2000,4)
    actual=np.column_stack(list(p.arrays.values()))
    expected=np.loadtxt(io.BytesIO(data),skiprows=12 if metal=='cu' else 1,delimiter=None if metal=='cu' else ',')
    np.testing.assert_array_equal(actual,expected)
    assert actual.shape==(count,2) and actual[0,0]==first
    assert [c.name for c in p.columns]==['pixel','signal_1']


@pytest.mark.parametrize('bad', [b'9999 broken\n',b':metadata after data\n',b'9999 nan\n',b'9999 2 3\n'])
def test_colon_reader_does_not_hide_damaged_observations(bad):
    data=fixture('cu','pixels').read_bytes()+b'\n'+bad
    with pytest.raises((ValueError,WebInputError)):
        parse_pixels(data,'pixel.dat',50000,2000,8)


@pytest.mark.parametrize('limit', ['bytes','points','columns'])
def test_pixel_limits_are_checked_before_calibration(limit):
    data=fixture('cu','pixels').read_bytes()
    with pytest.raises((ValueError,WebInputError)):
        parse_pixels(data,'pixel.dat',10 if limit=='bytes' else 50000,10 if limit=='points' else 2000,1 if limit=='columns' else 8)


def test_native_qinterp_against_independent_local_polynomial_interpolation():
    rng=np.random.default_rng(317);x=np.cumsum(rng.uniform(.1,2,23));y=rng.normal(size=23)
    points=np.r_[x[0]-2,np.linspace(x[0],x[-1],503),x,x[-1]+2]
    expected=[]
    for p in points:
        j=int(np.clip(np.searchsorted(x,p,side='right')-1,0,len(x)-2))
        ids=range(j-1,j+3) if 4<=j<len(x)-5 else [j,j+1]
        expected.append(float(BarycentricInterpolator(x[list(ids)],y[list(ids)])(p)))
    np.testing.assert_allclose(qinterp(x,y,points),expected,rtol=2e-12,atol=2e-12)


@pytest.mark.parametrize('count',[0,1,4,10])
def test_smoothing_matches_native_stencil_matrix(count):
    y=np.array([1,3,-8,10,6,-2,7.]);a=np.diag(np.full(7,.5))+np.diag(np.full(6,.25),1)+np.diag(np.full(6,.25),-1)
    a[0,0]=a[-1,-1]=.75
    np.testing.assert_allclose(smooth_derivative(y,count),np.linalg.matrix_power(a,count)@y)
    np.testing.assert_array_equal(y,[1,3,-8,10,6,-2,7])


def test_refinement_recovers_independent_affine_edge_and_oscillations():
    pixel=np.arange(1201.);energy=8950+.5*pixel
    signal=.2+1/(1+np.exp(-(pixel-180)/7))+.02*np.sin(pixel/11)*np.exp(-((pixel-400)/350)**2)
    actual,fit=refine(pixel,signal,energy,signal,Coefficients(offset=8951,linear=.497),nsmooth=0)
    assert actual.offset==pytest.approx(8950,abs=.02)
    assert actual.linear==pytest.approx(.5,abs=.0002)
    assert abs(actual.quadratic)<2e-7
    assert fit['sum_squares']<fit['initial_sum_squares']*1e-5
    assert fit['scale']==pytest.approx(2,abs=.01)


@pytest.mark.parametrize('metal,edge', [('cu',8980),('pd',24350)])
def test_measured_guess_refine_apply_readonly_and_processing(tmp_path,metal,edge):
    s,p,i,req=standards(tmp_path,metal);original=copy.deepcopy(p)
    before=s.dispersive(p['id'],req,'guess')
    assert before['coefficients']['linear']>0
    req=DispersiveRequest.model_validate(req.model_dump()|dict(coefficients=before['coefficients']))
    after=s.dispersive(p['id'],req,'refine');fit=after['details']
    assert fit['sum_squares']<fit['initial_sum_squares']*.25
    assert fit['points']>200 and fit['extrapolated_points']==0
    assert fit['nsmooth']==4
    assert fit['sum_squares']==pytest.approx(np.dot(fit['residual'],fit['residual']))
    np.testing.assert_allclose(np.array(fit['fitted_derivative'])+fit['residual'],fit['standard_derivative'])
    assert after['calibrated']['x'][0]<edge<after['calibrated']['x'][-1]
    if metal=='cu':
        # A separately published upstream calibrated axis, rounded to 1e-5
        # keV. Its signal is preprocessed, so only the energy axis is compared.
        published=np.loadtxt(FIXTURES/'demeter-dxas-cu-published-calibration.dat')[:,0]*1000
        delta=np.asarray(after['calibrated']['x'])-published
        assert np.sqrt(np.mean(delta**2))<.5 and np.max(np.abs(delta))<1
    assert np.isfinite(after['normalized']['y']).all() and np.isfinite(after['standard']['y']).all()
    assert s.load(p['id'])==original
    assert AthenaPreferences(s.settings).read_dispersive()['version']==0
    req=DispersiveRequest.model_validate(req.model_dump()|dict(coefficients=after['coefficients']))
    made=s.make_dispersive(p['id'],req)
    g=made['groups'][1]
    assert made['version']==p['version']+1 and made['groups'][0]==p['groups'][0]
    assert g['energy']==after['calibrated']['x'] and g['mu']==after['calibrated']['y']
    assert not g['marked'] and g['processing_error'] is None
    assert all(g['result']['arrays'][k] for k in ('energy','chi','chir_mag','chiq_mag'))


def test_make_roundtrip_native_reader_and_undo_preserve_source(tmp_path):
    s,p,i,req=standards(tmp_path);req=req.model_copy(update={'coefficients':Coefficients(offset=8952,linear=.29)})
    made=s.make_dispersive(p['id'],req);g=made['groups'][1];source=g['source']
    assert source['source_sha256']==hashlib.sha256(fixture('cu','pixels').read_bytes()).hexdigest()
    original=s.storage.read_arrays(p['id'],f'upload-{req.upload_id}.npz')
    assert source['column_arrays']=={k:v.tolist() for k,v in original.items()}
    assert source['row_order']==list(range(1241))
    for fmt in ('json','prj'):
        data=s.export_project(p['id'],fmt);other=s.create()
        restored=s.restore(other['id'],0,data,'calibration.'+fmt)
        assert restored['groups'][1]['source']==source
        assert restored['groups'][1]['energy']==g['energy']
        assert restored['groups'][1]['mu']==g['mu']
        if fmt=='prj':
            path=tmp_path/'independent.prj';path.write_bytes(data)
            native=read_athena(str(path),do_preedge=False,do_bkg=False,do_fft=False)
            group=list(native.groups.values())[1]
            np.testing.assert_allclose(group.energy,g['energy'],rtol=1e-10)
            np.testing.assert_allclose(group.mu,g['mu'],rtol=1e-10)
    undone=s.command(p['id'],Command(version=made['version'],action='undo'))
    assert undone['groups']==p['groups']
    redone=s.command(p['id'],Command(version=undone['version'],action='redo'))
    assert redone['groups']==made['groups']


@pytest.mark.parametrize('normalized', [False,True])
def test_conventional_overlay_uses_existing_group_normalization_and_auto_degree(tmp_path,normalized):
    s,p,i,req=standards(tmp_path)
    g=p['groups'][0]
    # Process a genuine supplied-normalization group or use automatic degree
    # and window resolution from the existing ordinary group.
    if normalized:
        g['mu']=g['result']['arrays']['norm'];g['data_type']='norm';g['is_normalized']=True
    g['parameters']['energy_shift']=2.5
    s.process(g,p);s.storage.write_json(p['id'],'project.json',p)
    result=s.dispersive(p['id'],req.model_copy(update={'coefficients':Coefficients(offset=8954,linear=.29)}))
    np.testing.assert_array_equal(result['standard']['x'],g['result']['arrays']['energy'])
    np.testing.assert_allclose(result['standard']['y'],g['result']['arrays']['norm'],rtol=1e-12,atol=1e-12)
    before=copy.deepcopy(p)
    result=s.dispersive(p['id'],req,'guess')
    assert len(result['details']['standard_fractions'])==2
    assert s.load(p['id'])==before


@pytest.mark.parametrize('reverse', [False,True])
def test_sorting_signal_reversal_and_decreasing_calibration_keep_distinct_provenance(tmp_path,reverse):
    s=AthenaStore(Settings(data_root=tmp_path));p=s.create()
    x=np.arange(100.);y=x*x+3;permutation=np.random.default_rng(3).permutation(100)
    i=s.inspect_dispersive(p['id'],table(x[permutation],y[permutation]),'unordered.dat')
    ids=[c['column_id'] for c in i['columns']]
    req=DispersiveRequest(version=0,upload_id=i['upload_id'],columns=dict(pixel_column=ids[0],numerator=[ids[1]],sort=True,reverse_signal=reverse),coefficients=Coefficients(offset=9000,linear=-.4))
    preview=s.dispersive(p['id'],req)
    np.testing.assert_allclose(preview['calibrated']['x'],(9000-.4*x)[::-1])
    np.testing.assert_array_equal(preview['calibrated']['y'],y if reverse else y[::-1])
    g=s.make_dispersive(p['id'],req)['groups'][0]
    order=g['source']['row_order']
    np.testing.assert_array_equal(np.array(permutation)[order],x[::-1])
    np.testing.assert_array_equal(g['source']['column_arrays'][ids[1]],y[::-1])
    assert g['source']['pixel_columns']['reverse_signal']==reverse


@pytest.mark.parametrize('bad', [dict(linear=0),dict(offset=-10000),dict(quadratic=-.001)])
def test_nonphysical_calibration_does_not_mutate_project(tmp_path,bad):
    s,p,i,req=standards(tmp_path);req=req.model_copy(update={'coefficients':Coefficients(**bad)})
    with pytest.raises(ValueError):s.make_dispersive(p['id'],req)
    assert s.load(p['id'])==p


def test_upload_namespace_version_and_retained_value_budget(tmp_path,monkeypatch):
    s,p,i,req=standards(tmp_path);req=req.model_copy(update={'coefficients':Coefficients(offset=8952,linear=.29)})
    other=s.create()
    with pytest.raises(FileNotFoundError):s.dispersive(other['id'],req.model_copy(update={'version':0}),'columns')
    with pytest.raises(WebInputError):s.make_dispersive(p['id'],req.model_copy(update={'version':0}))
    monkeypatch.setattr('xraylarch_web.athena._EXCHANGE_MAX_VALUES',100)
    with pytest.raises(WebInputError,match='retained data'):s.make_dispersive(p['id'],req)
    assert s.load(p['id'])==p


@pytest.mark.parametrize('data', [b'',b'[]',b'offset: 1',b'offset: 1\nlinear: 2\nlinear: 3',
    b'offset: 1\nlinear: 2\nquadratic: .nan',b'offset: {}\nlinear: 2\nquadratic: 3',
    b'offset: &a 1\nlinear: *a\nquadratic: 0',b'!!python/object:danger {}',
    b'offset: 1\nlinear: 2\nother: 0',b'offset: 1\nlinear: 2\nquadratic: 0\n---\n{}',b'\xff',b' '*4097])
def test_invalid_native_calibration_is_rejected(data):
    with pytest.raises((ValueError,UnicodeError)):decode_calibration(data)


def test_calibration_restart_conflict_failed_write_and_project_isolation(tmp_path,monkeypatch):
    settings=Settings(data_root=tmp_path);prefs=AthenaPreferences(settings)
    s=AthenaStore(settings);p=s.create()
    c=decode_calibration(b'---\noffset: 8.952E3\nlinear: 0.286\nquadratic: 5.51e-06\n')
    saved=prefs.save_dispersive(DispersiveDefaults(coefficients=c))
    assert saved==AthenaPreferences(settings).read_dispersive()
    assert decode_calibration(encode_calibration(saved['coefficients']))==c
    with pytest.raises(WebInputError) as e:prefs.save_dispersive(DispersiveDefaults(coefficients=c))
    assert e.value.code=='stale_revision'
    with monkeypatch.context() as patch:
        def failed(*args):raise OSError('disk full')
        patch.setattr('xraylarch_web.storage.os.replace',failed)
        with pytest.raises(OSError):prefs.save_dispersive(DispersiveDefaults(version=1,coefficients=c))
    assert prefs.read_dispersive()==saved and s.load(p['id'])==p
    assert AthenaPreferences(Settings(data_root=tmp_path/'isolated')).read_dispersive()=={'version':0,'coefficients':None}


def test_slri_signature_missing_calibration_live_columns_and_reinspection(tmp_path):
    s=AthenaStore(Settings(data_root=tmp_path));p=s.create();prefs=AthenaPreferences(s.settings)
    data=fixture('cu','pixels').read_bytes()
    with pytest.raises(WebInputError) as e:s.inspect(p['id'],data,'cu_08')
    assert e.value.code=='file_plugin_disabled'
    prefs.save_plugins(PluginRegistry(enabled={SLRI:True}))
    with pytest.raises(WebInputError) as e:s.inspect(p['id'],data,'cu_08')
    assert e.value.code=='dispersive_calibration_missing'
    # Calibration inspection still reads raw pixels with the reader enabled.
    assert s.inspect_dispersive(p['id'],data,'cu_08')['columns'][0]['preview'][0]==0
    prefs.save_dispersive(DispersiveDefaults(coefficients=Coefficients(offset=8952,linear=.29)))
    i=s.inspect(p['id'],data,'cu_08');choice=i['athena_suggestion']
    assert i['file_plugin']['id']=='SLRIBL4' and choice['mode']=='mu' and choice['denominator']==''
    assert s.storage.path(p['id'],f'upload-{i["upload_id"]}.source').read_bytes()==data
    req=ImportRequest(version=0,upload_id=i['upload_id'],**choice)
    preview=s.preview_columns(p['id'],req)
    expected=np.loadtxt(io.BytesIO(data),skiprows=12)
    np.testing.assert_allclose(preview['traces'][0]['x'],8952+.29*expected[:,0],atol=1e-10)
    np.testing.assert_array_equal(preview['traces'][0]['y'],expected[:,1])
    prefs.save_dispersive(DispersiveDefaults(version=1,coefficients=Coefficients(offset=8955,linear=.29)))
    fresh=s.inspect(p['id'],data,'cu_08')
    assert fresh['file_plugin']['calibration']['offset']==8955
    assert s.preview_columns(p['id'],req)==preview
    made=s.import_data(p['id'],req)
    assert made['groups'][0]['source']['file_plugin']['calibration']['offset']==8952


def test_real_http_routes_calibration_exchange_errors_and_atomic_make(tmp_path):
    s,p,i,req=standards(tmp_path)
    with TestClient(create_app(s.settings)) as client:
        base=f'/api/athena/projects/{p["id"]}/dispersive'
        data=fixture('cu','pixels').read_bytes()
        inspected=client.post(base+'/inspect',files={'file':('cu_08',data)})
        assert inspected.status_code==200 and inspected.json()['row_count']==1241
        request=req.model_dump()|dict(upload_id=inspected.json()['upload_id'])
        assert client.post(base+'/columns',json=request).status_code==200
        result=client.post(base+'/guess',json=request)
        assert result.status_code==200,result.text
        request['coefficients']=result.json()['coefficients']
        assert client.post(base+'/preview',json=request).status_code==200
        assert client.post(base+'/invalid',json=request).status_code==422
        assert client.post(base+'/refine',json=request|dict(nsmooth=11)).status_code==422
        made=client.post(base+'/make',json=request)
        assert made.status_code==200 and len(made.json()['groups'])==2
        assert client.post(base+'/make',json=request).status_code==409
        pref='/api/athena/preferences/dispersive'
        assert client.get(pref).json()=={'version':0,'coefficients':None}
        assert client.get(pref+'/file').status_code==400
        native=encode_calibration(request['coefficients'])
        response=client.post(pref+'/import?version=0',files={'file':('athena.dxas',native)})
        assert response.status_code==200 and response.json()['version']==1
        assert client.get(pref+'/file').content==native
        assert client.post(pref+'/import?version=0',files={'file':('athena.dxas',native)}).status_code==409
        oversized=client.post(pref+'/import?version=1',files={'file':('athena.dxas',b' '*4097)})
        assert oversized.status_code==400 and 'upload_too_large' in oversized.text
        assert client.put(pref,json={'version':1,'coefficients':{'offset':True}}).status_code==422
