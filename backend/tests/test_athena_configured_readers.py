from io import StringIO
from pathlib import Path
import gzip
import hashlib
import json
import struct

from fastapi.testclient import TestClient
from larch.io import read_ascii
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_file_plugins import prepare_file
from xraylarch_web.athena_plugin_config import ConfigurationRequest
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
MANIFESTS = {name: json.loads((FIXTURES / f'athena-{name.lower()}-fixtures.json').read_text()) for name in ['X15B', 'X23A2MED']}
CASES = [(name, ref) for name, manifest in MANIFESTS.items() for ref in manifest['references']]


def raw(reader):
    return (FIXTURES / MANIFESTS[reader]['file']['file']).read_bytes()


def oracle(reader, ref):
    value = json.loads(gzip.decompress((FIXTURES / ref['file']).read_bytes()))
    return (raw(reader), value) if reader == 'X15B' else (value.get('input', '').encode() or raw(reader), value['columns'])


def config(ref):
    return {k: v for k, v in ref['values'].items() if k != 'multiedge_regex'}


def prepare(data, values, **limits):
    return prepare_file(data, **(dict(max_bytes=50_000_000, max_points=250_000, max_columns=64,
        read_configuration=lambda _: dict(values=values, session_id='test', version=0)) | limits))


def store(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{name}':True for name in MANIFESTS}))
    return s


def apply(s, reader, ref, save=False):
    state = s.plugin_configurations.read(reader)
    return s.plugin_configurations.apply(reader, ConfigurationRequest(version=state['version'], session_id=state['session_id'], values=config(ref), save=save))


def test_retained_source_and_reference_identities():
    for manifest in MANIFESTS.values():
        for item in [manifest['file'], *manifest['references']]:
            data = (FIXTURES / item['file']).read_bytes()
            assert hashlib.sha256(data).hexdigest() == item['sha256']
            if 'git_blob_sha1' in item:
                assert len(data) == item['bytes']
                assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() == item['git_blob_sha1']


@pytest.mark.parametrize('reader,ref', CASES, ids=[r+'-'+v['name'] for r,v in CASES])
def test_every_native_column_suggestion_and_detector_diagnostic(tmp_path, reader, ref):
    data, expected = oracle(reader, ref)
    if not expected:
        with pytest.raises(WebInputError, match='Every X23A2MED slow channel'): prepare(data, config(ref))
        assert not ref['native']['produced_output']
        return
    result = prepare(data, config(ref)); path = tmp_path / 'converted.dat'; path.write_bytes(result.data)
    g = read_ascii(str(path)); np.testing.assert_array_equal(g.data.T, expected)
    native = ref['native']
    for mode, suggestion in [('default', next(iter(result.suggestions.values()))), *result.suggestions.items()]:
        assert suggestion['energy_column'] == int(native[mode]['energy'][1:])-1
        assert suggestion['numerator'] == [int(v[1:])-1 for v in native[mode]['numerator'].split('+')]
        assert suggestion['denominator'] == int(native[mode]['denominator'][1:])-1
        assert (suggestion['mode'] == 'transmission') == bool(native[mode]['ln'])
    if reader == 'X23A2MED':
        assert g.array_labels == [v.lower() for v in native['labels']]
        for a, b in [('med_nchannels','nelements'), ('med_deadtime','dts'), ('med_maxiterations','maxints')]:
            assert result.metadata['detector'][a] == native['attrs'][b]
    else:
        assert g.array_labels == ['energy','i0','narrow','wide','trans']
    assert result.metadata['configuration']['values'] == config(ref)


@pytest.mark.parametrize('reader', ['X15B', 'X23A2MED'])
def test_live_configured_preview_processing_exchange_restart_and_staged_independence(tmp_path, reader):
    s = store(tmp_path); p = s.create(); initial, changed = MANIFESTS[reader]['references'][:2]
    i = s.inspect(p['id'], raw(reader), 'renamed.dat'); original_source = i['file_plugin']
    mapping = i['athena_suggestion']; expected = np.asarray(oracle(reader, initial)[1])
    x = expected[:,0]; y = sum(expected[:, int(v[-4:])-1] for v in mapping['numerator']) / expected[:,1]
    # Staged bytes and configuration must not be reinterpreted by a later Apply.
    current = apply(s, reader, changed)
    req = ImportRequest(version=0, upload_id=i['upload_id'], **mapping)
    preview = s.preview_columns(p['id'], req)
    np.testing.assert_array_equal(preview['traces'][0]['x'], x); np.testing.assert_array_equal(preview['traces'][0]['y'], y)
    assert s.load(p['id']) == p
    imported = s.import_data(p['id'], req); g = imported['groups'][0]
    assert g['processing_error'] is None and g['source']['file_plugin'] == original_source
    np.testing.assert_array_equal(g['mu'], y)
    for key in ['norm','chi','chir_mag','chiq_mag']: assert len(g['result']['arrays'][key]) > 10
    again = s.inspect(p['id'], raw(reader), 'renamed.dat')
    assert again['file_plugin']['configuration']['values'] == current['values']
    converted = s.inspected_file(p['id'], again['upload_id'], 'converted')[0]
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.decode())), oracle(reader, changed)[1])
    assert s.inspected_file(p['id'], i['upload_id'], 'source') == (raw(reader), 'renamed.dat')
    restarted = AthenaStore(s.settings); assert restarted.load(p['id']) == imported
    assert restarted.plugin_configurations.read(reader)['values'] == config(initial)
    for fmt in ['json','prj']:
        restored = s.restore(s.create()['id'], 0, s.export_project(p['id'], fmt), 'saved.'+fmt)['groups'][0]
        assert restored['source'] == g['source'] and restored['result']['arrays'] == g['result']['arrays']
    assert s.command(p['id'], Command(version=1, action='undo'))['groups'] == []
    assert s.command(p['id'], Command(version=2, action='redo'))['groups'][0]['source'] == g['source']


@pytest.mark.parametrize('reader', ['X15B','X23A2MED'])
@pytest.mark.parametrize('limit', ['bytes','points','columns'])
def test_limits_reject_before_any_project_write(tmp_path, reader, limit):
    ref = MANIFESTS[reader]['references'][0]; expected = oracle(reader, ref)[1]
    limits = {'max_bytes':len(raw(reader))-1} if limit == 'bytes' else {'max_points':len(expected)-1} if limit == 'points' else {'max_columns':len(expected[0])-1}
    with pytest.raises(WebInputError): prepare(raw(reader), config(ref), **limits)
    assert prepare(raw(reader), config(ref), max_columns=len(expected[0]))


@pytest.mark.parametrize('length', [4, 64, 211, 212, 213, 275])
def test_x15b_incomplete_header_or_record_is_explicit_and_atomic(tmp_path, length):
    s = store(tmp_path); p = s.create(); before = sorted(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], raw('X15B')[:length], 'truncated.dat')
    assert sorted(s.storage.workspace_dir(p['id']).iterdir()) == before and s.load(p['id']) == p


@pytest.mark.parametrize('position', [0,160,320])
def test_x15b_selected_nonfinite_cannot_hide_in_late_records(position):
    data = bytearray(raw('X15B')); struct.pack_into('<f', data, 212+position*64+4, float('nan'))
    with pytest.raises(WebInputError) as e: prepare(bytes(data), config(MANIFESTS['X15B']['references'][0]))
    assert e.value.code == 'upload_nonfinite'


def test_x15b_unused_nonfinite_is_diagnostic_and_original_binary_is_preserved():
    data = bytearray(raw('X15B')); struct.pack_into('<f', data, 212+14*4, float('inf'))
    ref = MANIFESTS['X15B']['references'][0]; result = prepare(bytes(data), config(ref))
    np.testing.assert_array_equal(np.loadtxt(StringIO(result.data.decode())), oracle('X15B', ref)[1])
    assert result.metadata['conversion']['source_columns'][13]['preview'][0] is None
    assert result.metadata['conversion']['source_nonfinite']['count'] == 1
    json.dumps(result.metadata, allow_nan=False)


@pytest.mark.parametrize('position', [0,211,421])
@pytest.mark.parametrize('damage', ['width','text','nan'])
def test_med_damaged_records_never_drop_points_or_mutate_project(tmp_path, position, damage):
    lines = raw('X23A2MED').splitlines(); index = next(i for i,l in enumerate(lines) if b'Energy' in l and b'Ifslow1' in l)+1+position
    fields = lines[index].split()
    if damage == 'width': fields.pop()
    else: fields[2] = b'broken' if damage == 'text' else b'nan'
    lines[index] = b' '.join(fields)
    s = store(tmp_path); p = s.create(); before = sorted(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], b'\n'.join(lines), 'damaged.dat')
    assert s.load(p['id']) == p and sorted(s.storage.workspace_dir(p['id']).iterdir()) == before


def test_med_configured_recognition_does_not_capture_ordinary_xdac():
    data = raw('X23A2MED').replace(b'Ifslow1', b'customslow1')
    ref = MANIFESTS['X23A2MED']['references'][0]
    assert prepare(data, config(ref)) is None
    changed = prepare(data, config(ref) | {'slow1':'customslow1'})
    np.testing.assert_array_equal(np.loadtxt(StringIO(changed.data.decode())), oracle('X23A2MED',ref)[1])
    with pytest.raises(WebInputError) as e: prepare(data, config(ref) | {'slow1':'customslow1'}, enabled={})
    assert e.value.code == 'file_plugin_disabled'


@pytest.mark.parametrize('reader', ['X15B','X23A2MED'])
def test_real_http_configuration_is_used_by_reinspection_and_not_old_upload(tmp_path, reader):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        p = client.post('/api/athena/projects').json(); base = f'/api/athena/projects/{p["id"]}'
        r = client.post(base+'/inspect', files={'file':('sample',raw(reader))}); assert r.status_code == 400 and 'disabled' in r.text
        client.put('/api/athena/preferences/plugins', json={'version':0,'enabled':{f'Demeter::Plugins::{reader}':True}})
        original = client.post(base+'/inspect', files={'file':('sample',raw(reader))}).json()
        path = f'/api/athena/preferences/plugins/{reader}/configuration'; c = client.get(path).json()
        changed = MANIFESTS[reader]['references'][1]
        applied = client.put(path, json={'version':c['version'],'session_id':c['session_id'],'values':config(changed),'save':True})
        assert applied.status_code == 200
        again = client.post(base+'/inspect', files={'file':('sample',raw(reader))}).json()
        assert again['file_plugin']['configuration']['values'] == config(changed)
        req = dict(version=0,upload_id=original['upload_id'],**original['athena_suggestion'])
        assert client.post(base+'/preview-columns', json=req).status_code == 200
        accepted = client.post(base+'/import', json=req).json()
        assert accepted['groups'][0]['source']['file_plugin'] == original['file_plugin']
