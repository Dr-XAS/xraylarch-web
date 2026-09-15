"""B18/BM23 native conversion and live preview contracts, using labelled probes."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from larch.io import read_ascii

from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.athena_file_plugins import PreparedCollection, prepare_file
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError

FIXTURES=Path(__file__).parent/'fixtures'
MANIFEST=json.loads((FIXTURES/'athena-header-fixtures.json').read_text())
CASES=[r for r in MANIFEST['references'] if r['backend']=='larch']


def raw(ref): return (FIXTURES/ref['input']).read_bytes()

def expected(ref): return json.loads(gzip.decompress((FIXTURES/ref['file']).read_bytes()))

def prepare(data, **limits):
    return prepare_file(data, **(dict(max_bytes=50_000_000,max_points=250_000,max_columns=64)|limits))

def store(tmp_path):
    s=AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{r}':True for r in ['B18','BM23','SPEC']}))
    return s


def test_probe_and_native_oracle_identities():
    for item in MANIFEST['files']+MANIFEST['references']:
        assert hashlib.sha256((FIXTURES/item['file']).read_bytes()).hexdigest()==item['sha256']
    for item in MANIFEST['files']:
        assert item['kind']=='constructed probe'
        assert hashlib.sha256((FIXTURES/item['derived_from']).read_bytes()).hexdigest()==item['source_sha256']
    assert hashlib.sha256((Path(__file__).parent/'reference/header_native_reference.py').read_bytes()).hexdigest()==MANIFEST['harness_sha256']


@pytest.mark.parametrize('ref',CASES,ids=lambda r:r['reader'])
def test_full_native_columns_and_selected_detector_defaults(tmp_path,ref):
    result=prepare(raw(ref)); oracle=expected(ref)
    path=tmp_path/'converted.dat'; path.write_bytes(result.data); g=read_ascii(str(path))
    np.testing.assert_array_equal(g.data.T,oracle['columns'])
    assert g.array_labels==oracle['labels']
    choice=next(iter(result.suggestions.values())); native=oracle['native']['default']
    assert choice['energy_column']==int(native['energy'][1:])-1
    assert choice['numerator']==[int(v[1:])-1 for v in native['numerator'].split('+')]
    assert choice['denominator']==int(native['denominator'][1:])-1
    assert (choice['mode']=='transmission')==bool(native['ln'])
    assert result.metadata['conversion']['source_points']==result.metadata['conversion']['output_points']==387
    if ref['reader']=='B18':
        # The conditional is in unchanged native source. Larch must not take
        # the Ifeffit-only decimation path, even when both oracles are valid.
        reduced=expected(next(r for r in MANIFEST['references'] if r['backend']=='ifeffit'))
        assert len(reduced['columns'])==193
        np.testing.assert_array_equal(reduced['columns'],np.asarray(oracle['columns'])[1::2])
        assert not result.metadata['conversion']['decimated']


@pytest.mark.parametrize('ref',CASES,ids=lambda r:r['reader'])
def test_live_column_edit_processing_original_download_restart_and_prj(tmp_path,ref):
    s=store(tmp_path); p=s.create(); i=s.inspect(p['id'],raw(ref),ref['input'])
    req=ImportRequest(version=0,upload_id=i['upload_id'],**i['athena_suggestion'])
    data=np.asarray(expected(ref)['columns']); numer=[int(v[-4:])-1 for v in req.numerator]; denom=int(req.denominator[-4:])-1
    y=np.sum(data[:,numer],axis=1)/data[:,denom]
    if req.mode=='transmission': y=np.log(abs(y))
    preview=s.preview_columns(p['id'],req)
    np.testing.assert_array_equal(preview['traces'][0]['x'],data[:,0]); np.testing.assert_allclose(preview['traces'][0]['y'],y,atol=1e-13)
    assert i['column_units'][req.energy_column]=='eV' and req.units=='eV'
    if ref['reader']=='B18':
        req=req.model_copy(update={'numerator':[req.numerator[0]]})
        edited=s.preview_columns(p['id'],req)
        np.testing.assert_allclose(edited['traces'][0]['y'],data[:,7]/data[:,2])
        assert not np.allclose(edited['traces'][0]['y'],y)
    else:
        req=req.model_copy(update={'denominator':i['columns'][4]['column_id']})
        edited=s.preview_columns(p['id'],req)
        np.testing.assert_allclose(edited['traces'][0]['y'],np.log(abs(data[:,2]/data[:,4])))
    assert s.load(p['id'])==p
    imported=s.import_data(p['id'],req); g=imported['groups'][0]
    assert g['processing_error'] is None
    for key in ['norm','chi','chir_mag','chiq_mag']: assert g['result']['arrays'][key]
    assert s.inspected_file(p['id'],i['upload_id'],'source')==(raw(ref),ref['input'])
    restored=s.restore(s.create()['id'],0,s.export_project(p['id'],'prj'),'saved.prj')['groups'][0]
    assert restored['source']==g['source'] and restored['result']['arrays']==g['result']['arrays']
    assert AthenaStore(s.settings).load(p['id'])==imported


def test_bm23_multiscan_preview_keeps_independent_energy_sweeps_and_shared_source(tmp_path):
    s=store(tmp_path); p=s.create(); data=(FIXTURES/'constructed-bm23-multiscan.dat').read_bytes()
    converted=prepare(data); assert isinstance(converted,PreparedCollection) and len(converted.scans)==2
    assert converted.metadata['total_points']==774 and converted.metadata['skipped_scans']==[]
    inspected=s.inspect(p['id'],data,'multi.dat'); assert inspected['kind']=='scan_list'
    assert [i['file_plugin']['scan']['number'] for i in inspected['scans']]==['7','9']
    oracle=expected(CASES[1])['columns']
    for i in inspected['scans']:
        req=ImportRequest(version=p['version'],upload_id=i['upload_id'],**i['athena_suggestion'])
        trace=s.preview_columns(p['id'],req)['traces'][0]
        np.testing.assert_array_equal(trace['x'],np.asarray(oracle)[:,0])
        assert s.inspected_file(p['id'],i['upload_id'],'source')==(data,'multi.dat')
        p=s.import_data(p['id'],req)
    assert len(p['groups'])==2 and p['groups'][0]['energy']==p['groups'][1]['energy']
    assert len(list(s.storage.workspace_dir(p['id']).glob('upload-*.source')))==1


@pytest.mark.parametrize('reader', ['B18','BM23'])
@pytest.mark.parametrize('location',['first','middle','last'])
@pytest.mark.parametrize('damage',['width','text','nonfinite'])
def test_damaged_rows_are_rejected_before_staging(tmp_path,reader,location,damage):
    s=store(tmp_path); p=s.create(); ref=next(r for r in CASES if r['reader']==reader); lines=raw(ref).decode().splitlines()
    indices=[i for i,l in enumerate(lines) if l.strip() and not l.startswith('#')]
    index=indices[{'first':0,'middle':len(indices)//2,'last':-1}[location]]; fields=lines[index].split()
    if damage=='width': fields.pop()
    else: fields[1]='broken' if damage=='text' else 'nan'
    lines[index]=' '.join(fields); before=list(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'],'\n'.join(lines).encode(),ref['input'])
    assert list(s.storage.workspace_dir(p['id']).iterdir())==before and s.load(p['id'])==p


@pytest.mark.parametrize('reader',['B18','BM23'])
@pytest.mark.parametrize('kind',['bytes','points','columns'])
def test_limits_and_disabled_reader_are_explicit(reader,kind):
    ref=next(r for r in CASES if r['reader']==reader)
    bounds={'max_bytes':len(raw(ref))-1} if kind=='bytes' else {'max_points':386} if kind=='points' else {'max_columns':ref['shape'][1]-1}
    with pytest.raises(WebInputError): prepare(raw(ref),**bounds)
    with pytest.raises(WebInputError,match='plugin is disabled'): prepare(raw(ref),enabled={})


def test_multiscan_late_error_and_cumulative_budget_cannot_stage_first_scan(tmp_path):
    s=store(tmp_path); p=s.create(); data=(FIXTURES/'constructed-bm23-multiscan.dat').read_bytes()
    with pytest.raises(WebInputError): prepare(data,max_points=773)
    before=list(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'],data+b'10300 damaged 1 2 3\n','multi.dat')
    assert list(s.storage.workspace_dir(p['id']).iterdir())==before and s.load(p['id'])==p


def test_bm23_overflow_header_counts_and_damaged_first_energy_are_not_silently_skipped():
    ref=CASES[1]; data=raw(ref)
    for changed in [data.replace(b'#N 5',b'#N 6'),data.replace(b'#L',b'#?L'),data+b'1e308 1 2 3 4\n',data+b'broken 1 2 3 4\n',data+b'10300 1 2 3 -\n']:
        with pytest.raises(WebInputError): prepare(changed)


def test_reader_signatures_do_not_capture_unrelated_headers():
    assert prepare(raw(CASES[0]).replace(b'Diamond',b'Elsewhere')) is None
    assert prepare(raw(CASES[0]).replace(b'B18-CORE XAS',b'Other XAS')) is None
    assert prepare(raw(CASES[1]).replace(b'E.S.R.F.',b'Other')) is None


def test_reduced_bm23_manual_mapping_keeps_converted_ev_despite_original_kev_label(tmp_path):
    s=store(tmp_path); p=s.create(); source=raw(CASES[1]).decode().splitlines(); lines=[]
    for line in source:
        if line.startswith('#N'): line='#N 3'
        elif line.startswith('#L'): line='#L E_kev_  time  I0'
        elif line and not line.startswith('#'): line=' '.join(line.split()[:3])
        lines.append(line)
    i=s.inspect(p['id'],'\n'.join(lines).encode(),'reduced.dat')
    assert i['columns'][0]['name']=='e_kev'
    assert i['plugin_suggestions']=={}
    assert i['column_units'][i['columns'][0]['column_id']]=='eV'
    if i['athena_suggestion']['energy_column']==i['columns'][0]['column_id']:
        assert i['athena_suggestion']['units']=='eV'
    mapping=dict(energy_column=i['columns'][0]['column_id'],numerator=[i['columns'][2]['column_id']],denominator='',mode='mu',units='eV',data_type='mu')
    preview=s.preview_columns(p['id'],ImportRequest(version=0,upload_id=i['upload_id'],**mapping))
    np.testing.assert_array_equal(preview['traces'][0]['x'],np.asarray(expected(CASES[1])['columns'])[:,0])


@pytest.mark.parametrize('spacing',[' ','\t','  '])
def test_multiscan_whitespace_and_duplicate_scan_numbers_preserve_entry_identity(spacing):
    data=(FIXTURES/'constructed-bm23-multiscan.dat').read_bytes().replace(b'#S 9',b'#S 7').replace(b'#S ',('#S'+spacing).encode())
    result=prepare(data)
    assert [s.metadata['scan']['number'] for s in result.scans]==['7','7']
    assert [s.metadata['scan']['ordinal'] for s in result.scans]==[1,2]


def test_many_short_bm23_scans_use_total_point_budget_not_an_arbitrary_scan_cap():
    header='#F BM23 E.S.R.F.\n'
    scan='#S 1 exafs\n#N 4\n#L Energy I0 It Iref\n10.5 1 2 3\n'
    result=prepare((header+scan*101).encode(),max_points=101)
    assert len(result.scans)==101 and result.metadata['total_points']==101
    with pytest.raises(WebInputError): prepare((header+scan*101).encode(),max_points=100)
