"""Native ZIP list output, heterogeneous contents and the real HTTP boundary."""
from io import BytesIO
import hashlib
import json
from pathlib import Path
import stat
import struct
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.athena_file_plugins import prepare_file
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_zip import read_archive
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES=Path(__file__).parent/'fixtures'
RAW=(FIXTURES/'demeter-data.zip').read_bytes()
ORACLE=json.loads((FIXTURES/'athena-zip-native.json').read_text())


def packed(entries, compression=zipfile.ZIP_DEFLATED):
    output=BytesIO()
    with zipfile.ZipFile(output,'w',compression=compression) as archive:
        for name,data in entries: archive.writestr(name,data)
    return output.getvalue()


def store(tmp_path):
    s=AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={'Demeter::Plugins::Zip':True,'Demeter::Plugins::BM23':True}))
    return s


def test_official_zip_native_order_every_byte_and_reference_identities():
    manifest=json.loads((FIXTURES/'athena-zip-fixture.json').read_text())
    for path,key in [(FIXTURES/manifest['file'],'sha256'),(FIXTURES/manifest['oracle'],'oracle_sha256'),
                     (Path(__file__).parent/'reference/zip_native_reference.py','harness_sha256')]:
        assert hashlib.sha256(path.read_bytes()).hexdigest()==manifest[key]
    prepared=prepare_file(RAW,max_bytes=100000,max_points=1000,max_columns=64)
    assert [dict(name=m['name'],bytes=m['bytes'],sha256=m['sha256']) for m in prepared.members]==ORACLE['members']
    assert prepared.metadata['expanded_bytes']==67095
    assert ORACLE['recognized'] and ORACLE['cleaned'] and not ORACLE['suggestion']
    for m in prepared.members:
        data,name=read_archive(RAW,100000,m['index'])
        assert hashlib.sha256(data).hexdigest()==m['sha256'] and name==m['name']


def test_three_measured_members_preview_processing_download_and_prj_restart(tmp_path):
    s=store(tmp_path); p=s.create(); a=s.inspect(p['id'],RAW,'data.zip')
    assert s.load(p['id'])==p and a['kind']=='archive_list'
    assert len(list(s.storage.workspace_dir(p['id']).glob('upload-*')))==2
    assert s.inspected_file(p['id'],a['upload_id'],'source')==(RAW,'data.zip')
    for m in a['members']:
        data,name=s.archive_member(p['id'],a['upload_id'],m['index'])
        i=s.inspect(p['id'],data,name)
        req=ImportRequest(version=p['version'],upload_id=i['upload_id'],energy_column=i['columns'][0]['column_id'],
            numerator=[i['columns'][1]['column_id']],denominator=i['columns'][2]['column_id'],mode='transmission')
        # Independent native Zip POD mapping: energy=$1, ln($2/$3).
        rows=np.asarray([[float(v) for v in line.split()] for line in data.decode().split('------------------------')[-1].splitlines()
                         if line.strip() and line.lstrip()[0].isdigit()])
        preview=s.preview_columns(p['id'],req)['traces'][0]
        np.testing.assert_array_equal(preview['x'],rows[:,0])
        np.testing.assert_allclose(preview['y'],np.log(abs(rows[:,1]/rows[:,2])),rtol=0,atol=1e-14)
        p=s.import_data(p['id'],req); g=p['groups'][-1]
        assert g['processing_error'] is None
        for key in ['norm','chi','chir_mag','chiq_mag']: assert g['result']['arrays'][key]
        assert s.inspected_file(p['id'],i['upload_id'],'source')==(data,name)
    assert len(p['groups'])==3
    restored=s.restore(s.create()['id'],0,s.export_project(p['id'],'prj'),'saved.prj')
    for left,right in zip(p['groups'],restored['groups'],strict=True):
        assert left['energy']==right['energy'] and left['mu']==right['mu']
        assert left['source']==right['source'] and left['result']['arrays']==right['result']['arrays']
    assert AthenaStore(s.settings).load(p['id'])==p
    assert AthenaStore(s.settings).archive_member(p['id'],a['upload_id'],2)==s.archive_member(p['id'],a['upload_id'],2)


def test_mixed_project_scan_text_and_nested_zip_are_independent(tmp_path):
    entries=[('readme.txt',b'Instructions'),('projects/re.prj',(FIXTURES/'demeter-athena-json.prj').read_bytes()),
             ('scans/bm23.dat',(FIXTURES/'constructed-bm23-multiscan.dat').read_bytes()),('nested.zip',RAW)]
    s=store(tmp_path); p=s.create(); a=s.inspect(p['id'],packed(entries),'mixed.zip')
    for m,(name,data) in zip(a['members'],entries,strict=True):
        content,filename=s.archive_member(p['id'],a['upload_id'],m['index'])
        assert content==data and filename==Path(name).name
    prj,name=s.archive_member(p['id'],a['upload_id'],1)
    assert s.preview_project(p['id'],prj,name)['groups']
    scans,name=s.archive_member(p['id'],a['upload_id'],2)
    assert s.inspect(p['id'],scans,name)['kind']=='scan_list'
    nested,name=s.archive_member(p['id'],a['upload_id'],3)
    assert s.inspect(p['id'],nested,name)['members']==s.inspect(p['id'],RAW,'again.zip')['members']
    assert s.load(p['id'])==p


def test_disabled_plugin_and_staged_independence(tmp_path):
    settings=Settings(data_root=tmp_path);s=AthenaStore(settings);p=s.create()
    with pytest.raises(WebInputError,match='Zip file plugin is disabled'):s.inspect(p['id'],RAW,'data.zip')
    assert not list(s.storage.workspace_dir(p['id']).glob('upload-*'))
    prefs=AthenaPreferences(settings);prefs.save_plugins(PluginRegistry(enabled={'Demeter::Plugins::Zip':True}))
    a=s.inspect(p['id'],RAW,'data.zip')
    prefs.save_plugins(PluginRegistry(version=1,enabled={}))
    assert s.archive_member(p['id'],a['upload_id'],0)[0]
    with pytest.raises(WebInputError,match='disabled'):s.inspect(p['id'],RAW,'again.zip')
    assert s.load(p['id'])==p


def test_namespace_index_and_wrong_upload_type(tmp_path):
    s=store(tmp_path);p=s.create();a=s.inspect(p['id'],RAW,'data.zip');other=s.create()
    with pytest.raises(WebInputError):s.archive_member(other['id'],a['upload_id'],0)
    for index in [-1,3,100000]:
        with pytest.raises(WebInputError):s.archive_member(p['id'],a['upload_id'],index)
    with pytest.raises(WebInputError):s.inspected_columns(p['id'],a['upload_id'])
    data,name=s.archive_member(p['id'],a['upload_id'],0);i=s.inspect(p['id'],data,name)
    with pytest.raises(WebInputError):s.archive_member(p['id'],i['upload_id'],0)


def test_atomic_failed_archive_staging(tmp_path,monkeypatch):
    s=store(tmp_path);p=s.create()
    monkeypatch.setattr(s.storage,'write_json',lambda *args: (_ for _ in ()).throw(OSError('full disk')))
    with pytest.raises(OSError,match='full disk'):s.inspect(p['id'],RAW,'data.zip')
    assert not list(s.storage.workspace_dir(p['id']).glob('upload-*'))


def test_directory_names_are_labels_never_paths_and_duplicate_members_stay_distinct(tmp_path):
    entries=[('folder/',b''),('folder/μ.dat',b'1'),('../outside.dat',b'2'),('/absolute.dat',b'3'),('same.dat',b'4'),('same.dat',b'5')]
    with pytest.warns(UserWarning,match='Duplicate name'):raw=packed(entries)
    s=store(tmp_path);p=s.create();a=s.inspect(p['id'],raw,'paths.zip')
    assert a['file_plugin']['directory_count']==1
    assert [m['index'] for m in a['members']]==[1,2,3,4,5]
    for m,(name,data) in zip(a['members'],entries[1:],strict=True):
        assert s.archive_member(p['id'],a['upload_id'],m['index'])[0]==data
    assert not (tmp_path/'outside.dat').exists()
    assert not list(s.storage.workspace_dir(p['id']).glob('*.dat'))


@pytest.mark.parametrize('compression',[zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED,zipfile.ZIP_BZIP2,zipfile.ZIP_LZMA])
def test_supported_compression_and_self_extracting_prefix(compression):
    data=b'source bytes'*100;raw=b'executable prefix'+packed([('data',data)],compression)
    result=prepare_file(raw,max_bytes=5000,max_points=100,max_columns=64)
    assert result.members[0]['bytes']==len(data)
    assert read_archive(raw,5000,0)==(data,'data')


@pytest.mark.parametrize('case',['empty','directory','corrupt_crc','truncated','expanded','entries','encrypted','symlink','control'])
def test_invalid_archives_leave_no_staging_or_project_change(tmp_path,case):
    raw=packed([('good.dat',b'valid'),('broken.dat',b'other')],zipfile.ZIP_STORED)
    if case=='empty':raw=packed([])
    if case=='directory':raw=packed([('folder/',b'')])
    if case=='corrupt_crc':raw=raw.replace(b'other',b'wrong')
    if case=='truncated':raw=raw[:-12]
    if case=='expanded':raw=packed([('bomb.dat',b'0'*100001)])
    if case=='entries':raw=packed([(str(n),b'') for n in range(1001)])
    if case=='encrypted':
        data=bytearray(raw)
        for start,offset in [(0,6),(raw.index(b'PK\x01\x02'),8)]:
            struct.pack_into('<H',data,start+offset,struct.unpack_from('<H',data,start+offset)[0]|1)
        raw=bytes(data)
    if case=='symlink':
        info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
        raw=packed([(info,b'../../source')])
    if case=='control':raw=packed([('line\nbreak.dat',b'1')])
    settings=Settings(data_root=tmp_path,max_upload_bytes=100000);s=AthenaStore(settings);p=s.create()
    AthenaPreferences(settings).save_plugins(PluginRegistry(enabled={'Demeter::Plugins::Zip':True}))
    with pytest.raises(WebInputError):s.inspect(p['id'],raw,'bad.zip')
    assert s.load(p['id'])==p and not list(s.storage.workspace_dir(p['id']).glob('upload-*'))


def test_real_http_member_source_selection_and_processing(tmp_path):
    s=store(tmp_path)
    with TestClient(create_app(s.settings)) as client:
        p=client.post('/api/athena/projects').json();base=f"/api/athena/projects/{p['id']}"
        response=client.post(base+'/inspect',files={'file':('data.zip',RAW)})
        assert response.status_code==200,response.text
        a=response.json();path=f"{base}/archives/{a['upload_id']}/members/1"
        download=client.get(path);assert download.status_code==200 and 'fe.061' in download.headers['content-disposition']
        assert hashlib.sha256(download.content).hexdigest()==ORACLE['members'][1]['sha256']
        assert client.get(f"{base}/uploads/{a['upload_id']}/file").content==RAW
        assert client.get(path[:-1]+'999').status_code==400
        i=client.post(base+'/inspect',files={'file':('fe.061',download.content)}).json()
        req=dict(version=0,upload_id=i['upload_id'],energy_column=i['columns'][0]['column_id'],numerator=[i['columns'][1]['column_id']],denominator=i['columns'][2]['column_id'],mode='transmission')
        preview=client.post(base+'/preview-columns',json=req);assert preview.status_code==200,preview.text
        imported=client.post(base+'/import',json=req);assert imported.status_code==200,imported.text
        g=imported.json()['groups'][0]
        assert g['energy']==preview.json()['traces'][0]['x'] and g['processing_error'] is None


@pytest.mark.parametrize('method',[zipfile.ZIP_DEFLATED,zipfile.ZIP_BZIP2,zipfile.ZIP_LZMA,99])
def test_damaged_compression_streams_are_recoverable_errors(method):
    raw=bytearray(packed([('data',b'measured observations'*50)],method if method!=99 else zipfile.ZIP_STORED))
    start=30+struct.unpack_from('<H',raw,26)[0]+struct.unpack_from('<H',raw,28)[0]
    if method==99:
        struct.pack_into('<H',raw,8,99)
        struct.pack_into('<H',raw,raw.index(b'PK\x01\x02')+10,99)
    elif method==zipfile.ZIP_LZMA:
        raw[start+4]=255  # Invalid LZMA filter properties: LZMAError, not OSError.
    else:raw[start:start+8]=b'\xff'*8
    with pytest.raises(WebInputError) as exc:read_archive(bytes(raw),100000)
    assert exc.value.code=='archive_invalid' and exc.value.recovery


@pytest.mark.parametrize('marker',['order','gds.yaml','HORAE'])
def test_native_athena_boundary_rejects_fitting_projects_without_extracting_them(tmp_path,marker):
    s=store(tmp_path);p=s.create()
    with pytest.raises(WebInputError) as exc:s.inspect(p['id'],packed([(marker,b'project state')]),'fit.zip')
    assert exc.value.code=='archive_project_unsupported'
    assert not list(s.storage.workspace_dir(p['id']).glob('upload-*'))
    assert s.load(p['id'])==p
    # Native memberNamed uses exact root names, not basenames or substrings.
    nested=s.inspect(p['id'],packed([('notes/'+marker,b'data')]),'nested-label.zip')
    assert nested['members'][0]['name']=='notes/'+marker
