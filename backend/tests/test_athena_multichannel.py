"""Native multichannel project readers: measured arrays, staging and exchange."""
import gzip
import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient
import numpy as np
from pydantic import ValidationError
import pytest

from xraylarch_web.athena import AthenaStore, Command, RestoreUploadRequest
from xraylarch_web.athena_file_plugins import prepare_file, PreparedProject
from xraylarch_web.athena_plugin_config import ConfigurationRequest, TenBMParameters, default_configuration
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
MANIFEST = json.loads((FIXTURES / 'athena-multichannel-fixtures.json').read_text())
CASES = MANIFEST['references']
READERS = ['10BMMultiChannel', 'X23A2MultiChannel']


def raw(ref):
    return (FIXTURES / ref['input']).read_bytes()


def oracle(ref):
    return json.loads(gzip.decompress((FIXTURES / ref['file']).read_bytes()))


def prepare(ref, **limits):
    return prepare_file(raw(ref), **(dict(max_bytes=50_000_000, max_points=250_000, max_columns=64,
        read_configuration=lambda reader: dict(values=ref['values'], session_id='test', version=0)
        if reader == ref['reader'] and 'values' in ref else default_configuration(reader)) | limits))


def store(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{name}': True for name in READERS}))
    return s


def configure(s, values):
    c = s.plugin_configurations.read('10BMMultiChannel')
    return s.plugin_configurations.apply('10BMMultiChannel', ConfigurationRequest(
        version=c['version'], session_id=c['session_id'], values=values))


def test_all_retained_inputs_oracles_and_harness_match_manifest():
    for item in [*MANIFEST['files'], *CASES]:
        data = (FIXTURES / item['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        if 'git_blob_sha1' in item:
            assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() == item['git_blob_sha1']
    assert hashlib.sha256((Path(__file__).parent / 'reference/multichannel_native_reference.py').read_bytes()).hexdigest() == MANIFEST['harness_sha256']


@pytest.mark.parametrize('ref', CASES, ids=[r['name'] for r in CASES])
def test_every_native_expression_result_and_sorted_source_column(ref):
    result = prepare(ref); expected = oracle(ref)
    assert isinstance(result, PreparedProject) and len(result.groups) == len(expected['groups'])
    assert result.metadata['id'] == ref['reader'] and expected['recognized']
    assert result.journal == expected['journal']
    for g, e in zip(result.groups, expected['groups'], strict=True):
        label = ref['input']+' - '+g['label'] if g['prefix_filename'] else g['label']
        assert label == e['label']
        assert g['data_type'] == ('mu' if e['data_type'] == 'xmu' else e['data_type'])
        for field in ['energy', 'mu']:
            np.testing.assert_allclose(g[field], e[field], rtol=1e-14, atol=1e-13)
        for field in ['i0', 'signal']:
            np.testing.assert_allclose(g['source']['raw_arrays'][field], e[field], rtol=1e-14)
        for actual, column in zip(g['source']['column_arrays'].values(), expected['source_columns'].values(), strict=True):
            np.testing.assert_allclose(actual, column, rtol=1e-14)
    if ref['name'] == '10bm-unsorted':
        c = result.metadata['conversion']
        assert c['source_points'] == 389 and c['output_points'] == 387
        assert len(set(c['retained_source_rows'])) == 387
    if 'high-edge' in ref['name']:
        assert result.metadata['conversion']['temperature']['row'] == 386


@pytest.mark.parametrize('ref', [CASES[0], CASES[3]], ids=['X23','10BM'])
def test_project_preview_all_channels_processing_selection_exchange_undo_and_restart(tmp_path, ref):
    s = store(tmp_path); p = s.create(); expected = oracle(ref)
    preview = s.inspect(p['id'], raw(ref), ref['input'])
    assert preview['kind'] == 'project'; preview = preview['preview']
    assert s.load(p['id']) == p
    assert s.project_upload_file(p['id'], preview['upload_id'], 'source') == (raw(ref), ref['input'])
    converted, name = s.project_upload_file(p['id'], preview['upload_id'], 'converted')
    assert name.endswith('.athena.json')
    document = json.loads(converted); assert document['format'] == 'athena-web'
    for g, e in zip(preview['groups'], expected['groups'], strict=True):
        np.testing.assert_allclose(g['x'], e['energy'], atol=1e-13)
        np.testing.assert_allclose(g['y'], e['mu'], atol=1e-13)
        assert g['parameters']['energy_shift'] == 0
        trace = s.preview_project_group(p['id'], preview['upload_id'], g['id'], 'norm')
        assert not trace.get('processing_error') and len(trace['y']) == ref['points']
        assert np.isfinite(trace['y']).all()
        assert s.load(p['id']) == p
    subset = [preview['groups'][0]['id'], preview['groups'][-1]['id']]
    imported = s.restore_upload(p['id'], RestoreUploadRequest(version=0, upload_id=preview['upload_id'], group_ids=subset))
    assert len(imported['groups']) == 2 and imported['version'] == 1
    for group in imported['groups']:
        assert group['processing_error'] is None and group['reference_id'] is None
        assert all(group['result']['arrays'][field] for field in ['norm','chi','chir_mag','chiq_mag'])
    assert AthenaStore(s.settings).load(p['id']) == imported
    for fmt in ['json','prj']:
        destination = s.create()
        pr = s.preview_project(destination['id'], s.export_project(p['id'], fmt), 'export.'+fmt)
        assert not pr.get('file_plugin')
        restored = s.restore_upload(destination['id'], RestoreUploadRequest(version=0, upload_id=pr['upload_id']))
        for a,b in zip(restored['groups'], imported['groups'], strict=True):
            for field in ['energy','mu','source','parameters','result']: assert a[field] == b[field]
    assert s.command(p['id'], Command(version=1, action='undo'))['groups'] == []
    assert s.command(p['id'], Command(version=2, action='redo'))['groups'] == imported['groups']


def test_staged_configuration_does_not_change_until_reinspection(tmp_path):
    s = store(tmp_path); p = s.create(); ref = CASES[3]
    initial = s.inspect(p['id'], raw(ref), ref['input'])['preview']
    changed = configure(s, CASES[4]['values'])
    staged = s.project_upload_file(p['id'], initial['upload_id'], 'converted')[0]
    next_preview = s.preview_project(p['id'], raw(ref), ref['input'])
    assert len(initial['groups']) == 5 and len(next_preview['groups']) == 4
    assert next_preview['file_plugin']['configuration']['values'] == changed['values']
    assert next_preview['groups'][0]['x'][0] == initial['groups'][0]['x'][0] + 2.5
    imported = s.restore_upload(p['id'], RestoreUploadRequest(version=0, upload_id=initial['upload_id']))
    assert len(imported['groups']) == 5
    assert s.project_upload_file(p['id'], initial['upload_id'], 'converted')[0] == staged
    assert AthenaStore(s.settings).plugin_configurations.read('10BMMultiChannel')['values']['reference'] is True


@pytest.mark.parametrize('ref', [CASES[0], CASES[3]], ids=['X23','10BM'])
@pytest.mark.parametrize('limit', ['bytes','points','columns'])
def test_conversion_limits_and_disabled_recognition(ref, limit):
    limits = dict(max_bytes=len(raw(ref))-1) if limit=='bytes' else dict(max_points=386) if limit=='points' else dict(max_columns=11)
    with pytest.raises(WebInputError): prepare(ref, **limits)
    with pytest.raises(WebInputError, match='file plugin is disabled'):
        prepare_file(raw(ref), max_bytes=50_000_000, max_points=250_000, max_columns=64, enabled={})


@pytest.mark.parametrize('damage', ['short','text','nan','zero','few','bad-column'])
def test_bad_channel_never_creates_partial_groups_or_staged_files(tmp_path, damage):
    s=store(tmp_path); p=s.create(); ref=CASES[3]; data=raw(ref)
    if damage=='bad-column': configure(s, TenBMParameters().model_dump() | {'denom4':100})
    else:
        lines=data.splitlines(); start=next(i for i,l in enumerate(lines) if l.strip().startswith(b'-----'))+2
        if damage=='few': lines=lines[:start+7]
        else:
            fields=lines[-1].split()
            if damage=='short': fields.pop()
            else: fields[8]={'text':b'broken','nan':b'nan','zero':b'0'}[damage]
            lines[-1]=b' '.join(fields)
        data=b'\n'.join(lines)
    before=list(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], data, ref['input'])
    assert s.load(p['id']) == p and list(s.storage.workspace_dir(p['id']).iterdir()) == before


def test_failed_staging_and_cache_eviction_remove_original_bytes(tmp_path, monkeypatch):
    s=store(tmp_path); p=s.create(); ref=CASES[0]; directory=s.storage.workspace_dir(p['id'])
    with monkeypatch.context() as patch:
        write=s.storage.write_json
        def fail_metadata(ident,name,value):
            if name.startswith('project-upload-'): raise OSError('disk full')
            return write(ident,name,value)
        patch.setattr(s.storage,'write_json',fail_metadata)
        with pytest.raises(OSError): s.inspect(p['id'],raw(ref),ref['input'])
    assert list(directory.glob('project-upload-*')) == []
    uploads=[s.inspect(p['id'],raw(ref),ref['input'])['preview']['upload_id'] for _ in range(11)]
    assert len(list(directory.glob('project-upload-*.bin'))) == 10
    assert len(list(directory.glob('project-upload-*.source'))) == 10
    with pytest.raises(WebInputError,match='expired'): s.project_upload_file(p['id'], uploads[0], 'source')
    with pytest.raises(WebInputError,match='another workspace'): s.project_upload_file(s.create()['id'], uploads[-1], 'converted')
    assert s.load(p['id']) == p


@pytest.mark.parametrize('field,value', [('reference',1),('reference','false'),('numer1',0),('denom1',True),('denomref',101),('eshift3',float('inf')),('type','chi'),('temperature_column',None)])
def test_configuration_rejects_ambiguous_values(field,value):
    with pytest.raises(ValidationError): TenBMParameters.model_validate({field:value})


def test_real_http_raw_to_project_preview_download_and_restore(tmp_path):
    s=store(tmp_path); ref=CASES[0]
    with TestClient(create_app(s.settings)) as client:
        p=client.post('/api/athena/projects',json={}).json(); base=f"/api/athena/projects/{p['id']}"
        inspected=client.post(base+'/inspect',files={'file':(ref['input'],raw(ref))})
        assert inspected.status_code == 200, inspected.text
        preview=inspected.json()['preview']; path=base+'/preview-project/'+preview['upload_id']
        for variant in ['source','converted']:
            response=client.get(path+'/file',params={'variant':variant})
            assert response.status_code == 200 and 'attachment;' in response.headers['content-disposition']
            if variant=='source': assert response.content == raw(ref)
            else: assert len(response.json()['groups']) == 4
        assert client.get(path+'/groups/channel-2?mode=norm').status_code == 200
        imported=client.post(base+'/restore-upload',json=dict(version=0,upload_id=preview['upload_id'],group_ids=['channel-2']))
        assert imported.status_code == 200, imported.text
        assert len(imported.json()['groups']) == 1 and imported.json()['groups'][0]['label'] == 'channel 2'
