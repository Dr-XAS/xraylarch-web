"""Measured native normalization dispatch, effective limits and project exchange."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_science import process_spectrum
from xraylarch_web.config import Settings

FIX=Path(__file__).parent/'fixtures'
ORACLE=json.loads(gzip.decompress((FIX/'athena-normalization-limits-native.json.gz').read_bytes()))


def parameters(fields):
    return dict(e0=fields['bkg_e0'],energy_shift=fields['bkg_eshift'],pre1=fields['bkg_pre1'],
                pre2=fields['bkg_pre2'],norm1=fields['bkg_nor1'],norm2=fields['bkg_nor2'],nnorm=fields['bkg_nnorm']-1)


@pytest.mark.parametrize('row',ORACLE['rows'],ids=lambda r:r['case']['name'])
@pytest.mark.parametrize('phase',[0,1],ids=['preview','saved'])
def test_all_fit_arrays_and_effective_bounds_match_original_template_dispatch(row,phase):
    source=ORACLE['inputs'][row['case']['input']];expected=row['phases'][phase]
    request=parameters(expected['fields']);before=copy.deepcopy(request)
    result=process_spectrum(source['energy'],source['mu'],request,'xanes')
    assert request==before
    for key,value in expected['effective'].items():assert result['effective'][key]==pytest.approx(value,rel=2e-12,abs=2e-12),key
    for key,values in expected['arrays'].items():np.testing.assert_allclose(result['arrays'][key],values,rtol=2e-12,atol=2e-13,err_msg=key)
    assert any('measured boundary' in w for w in result['warnings'])


def test_native_limit_reference_sources_inputs_and_harness_hashes():
    manifest=json.loads((FIX/'athena-normalization-limits-fixtures.json').read_text());root=FIX.parents[2]
    catalog={r['file']:r['sha256'] for r in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    assert len(ORACLE['rows'])==manifest['cases']==54 and sum(len(r['phases']) for r in ORACLE['rows'])==108
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((root/path).read_bytes()).hexdigest()==sha
    for path,sha in ORACLE['sources'].items():assert catalog['demeter-'+ORACLE['demeter_revision']+'/'+path]==sha


@pytest.mark.parametrize('element',['Cu','Fe'])
def test_requested_limits_survive_calibration_and_bare_prj_with_exact_refitted_overlay(tmp_path,element):
    src=ORACLE['inputs'][element];row=next(r for r in ORACLE['rows'] if r['case']['name']==f'{element}-2.75-3.12345-both')
    store=AthenaStore(Settings(data_root=tmp_path));p=store.create();original=copy.deepcopy(p)
    p['groups']=[store.make_group(element,src['energy'],src['mu'],parameters=parameters(row['case']['fields']))]
    assert not p['groups'][0]['processing_error'];p=store.save(p,original,'Measured endpoints')
    before=copy.deepcopy(p);g=p['groups'][0]
    request=Command(version=p['version'],action='calibrate',group_ids=[g['id']],options=dict(coordinate='displayed',display='norm',observed=g['parameters']['e0'],target=row['case']['target']))
    preview=store.preview_calibration(p['id'],request)
    assert store.load(p['id'])==before
    assert len(preview['curve']['normalization'])==2 and len(preview['normalization_limits'][0]['adjustments'])==2
    assert preview['curve']['y']!=preview['calibrated_curve']['y']
    saved=store.command(p['id'],request);after=saved['groups'][0]
    assert not after['processing_error']
    assert after['result']['arrays']['flat']==preview['calibrated_curve']['y']
    for key in ['pre1','pre2','norm1','norm2']:assert after['parameters'][key]==g['parameters'][key]
    for key in ['energy','mu','source']:assert after[key]==g[key]
    undone=store.command(p['id'],Command(version=saved['version'],action='undo'));assert undone['groups']==before['groups']
    redone=store.command(p['id'],Command(version=undone['version'],action='redo'));assert redone['groups']==saved['groups']
    data=store.export_project(p['id'],'prj')
    bare='\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()
    for content in [data,bare]:
        restored=store.restore(store.create()['id'],0,content,'measured-limits.prj')['groups'][0]
        assert not restored['processing_error']
        for key in ['pre1','pre2','norm1','norm2']:assert restored['parameters'][key]==after['parameters'][key]
        np.testing.assert_allclose(restored['result']['arrays']['flat'],after['result']['arrays']['flat'],rtol=2e-12,atol=2e-13)


def test_outer_limit_is_resolved_again_when_reference_returns_instead_of_permanently_shrinking():
    src=ORACLE['inputs']['Cu'];initial=ORACLE['rows'][0]['case']['fields']['bkg_e0']+3.12345
    requested=float(src['energy'][-1]-initial-1)
    values=[]
    for delta in [0,3,0]:
        result=process_spectrum(src['energy'],src['mu'],dict(e0=initial+delta,norm2=requested),'xanes')
        values.append(result)
    assert values[1]['effective']['norm2']<requested
    assert values[0]==values[2] and values[2]['effective']['norm2']==requested


def test_preview_reports_retained_outer_requests_for_linked_reference_too(tmp_path):
    src=ORACLE['inputs']['Cu'];row=next(r for r in ORACLE['rows'] if r['case']['name']=='Cu-2.75-3.12345-both')
    store=AthenaStore(Settings(data_root=tmp_path));p=store.create();old=copy.deepcopy(p)
    sample=store.make_group('sample',src['energy'],src['mu'],parameters=parameters(row['case']['fields']))
    reference=store.make_group('reference',src['energy'],src['mu'],parameters={**sample['parameters'],'e0':sample['parameters']['e0']+.5})
    sample['reference_id']=reference['id'];p['groups']=[sample,reference];p=store.save(p,old,'Linked measured scans')
    request=Command(version=p['version'],action='calibrate',group_ids=[sample['id']],options=dict(coordinate='displayed',display='norm',target=row['case']['target']))
    preview=store.preview_calibration(p['id'],request)
    assert store.load(p['id'])==p
    assert {r['group_id'] for r in preview['normalization_limits']}=={sample['id'],reference['id']}
    saved=store.command(p['id'],request)
    for row in preview['normalization_limits']:
        group=next(g for g in saved['groups'] if g['id']==row['group_id'])
        for a in row['adjustments']:
            assert group['parameters'][a['parameter']]==a['requested']
            assert group['result']['effective'][a['parameter']]==a['used']
