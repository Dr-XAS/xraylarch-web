"""Measured scalar acquisitions and executed native format conformance probes."""
from io import StringIO
from pathlib import Path
import gzip
import hashlib
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch.io import read_ascii

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_file_plugins import prepare_file
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
MANIFEST = json.loads((FIXTURES / 'athena-scalar-fixtures.json').read_text())
PROBES = json.loads(gzip.decompress((FIXTURES / MANIFEST['probes']['file']).read_bytes()))
SAMPLES = ['cmc', 'hxma', 'lnls']


def raw(name):
    return (FIXTURES / f'demeter-{name}.dat').read_bytes()


def reference(name):
    return np.asarray(json.loads(gzip.decompress((FIXTURES / f'{name}-native-columns.json.gz').read_bytes())))


def prepare(data, **limits):
    return prepare_file(data, **dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | limits)


def store(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{name.upper()}': True for name in SAMPLES}))
    return s


def chosen(inspected, name, mode=None):
    mode = mode or ('fluorescence' if name in ['cmc', 'lnls'] else 'transmission')
    mapping = inspected['plugin_suggestions'][mode]
    return dict(mapping, data_type='xanes') if name == 'cmc' else mapping


def signal(expected, mapping):
    x = expected[:, int(mapping['energy_column'][-4:])-1]
    y = sum(expected[:, int(v[-4:])-1] for v in mapping['numerator']) / expected[:, int(mapping['denominator'][-4:])-1]
    return x, np.log(np.abs(y)) if mapping['mode'] == 'transmission' else y


def assert_suggestion(choice, native):
    assert choice['energy_column'] == int(native['energy'][1:])-1
    assert choice['numerator'] == [int(v[1:])-1 for v in native['numerator'].split('+')]
    assert choice['denominator'] == int(native['denominator'][1:])-1
    assert (choice['mode'] == 'transmission') == bool(native['ln'])


def test_retained_official_and_native_identities():
    assert sum(np.prod(v['shape']) for v in MANIFEST['references']) == 13416
    assert len(PROBES) == MANIFEST['probes']['count'] == 12
    for item in [*MANIFEST['files'], *MANIFEST['references'], MANIFEST['probes']]:
        data = (FIXTURES / item['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        if 'git_blob_sha1' in item:
            assert len(data) == item['bytes']
            assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == item['git_blob_sha1']


@pytest.mark.parametrize('name', SAMPLES)
def test_all_native_columns_and_defaults_through_real_larch(tmp_path, name):
    result = prepare(raw(name)); output = tmp_path / 'columns.dat'; output.write_bytes(result.data)
    group = read_ascii(str(output)); expected = reference(name)
    np.testing.assert_array_equal(group.data.T, expected)
    assert group.array_labels == {
        'cmc': ['energy', 'i0', 'i1', 'i2', 'lytle'] + [f'mca{i}' for i in range(1, 9)],
        'hxma': ['energy', 'i0', 'it', 'ir', 'lytle'],
        'lnls': ['energia', 'curta', 'longa', 'media', 'ge15', 'amostra', 'referencia', 'fluorescencia'],
    }[name]
    native = next(r for r in MANIFEST['references'] if r['sample'] == name)['native']
    assert_suggestion(next(iter(result.suggestions.values())), native['default'])
    for mode, choice in result.suggestions.items(): assert_suggestion(choice, native[mode])
    assert result.metadata['conversion']['offsets_applied'] == (name == 'cmc')


@pytest.mark.parametrize('probe', PROBES, ids=lambda p: p['name'])
def test_executed_native_variants_not_inferred_from_the_web_implementation(probe):
    result = prepare(probe['input'].encode())
    np.testing.assert_array_equal(np.loadtxt(StringIO(result.data.decode())), probe['columns'])
    assert_suggestion(next(iter(result.suggestions.values())), probe['native']['default'])
    for mode, choice in result.suggestions.items(): assert_suggestion(choice, probe['native'][mode])
    if probe['name'] == 'lnls-transmission': assert list(result.suggestions) == ['transmission']
    if probe['name'] in ['cmc-missing-offsets', 'cmc-offset-case', 'cmc-missing-offsets-zero-time', 'cmc-uppercase']:
        assert not result.metadata['conversion']['offsets_applied']
        assert 'unchanged' in result.metadata['summary']
    if probe['name'] == 'cmc-nan':
        assert result.metadata['conversion']['nan_replacements']['count'] == 2
        assert result.metadata['conversion']['source_nonfinite']['count'] == 3
    if probe['name'] == 'cmc-first-nan':
        assert result.metadata['conversion']['nan_replacements']['count'] == 4
        assert result.metadata['conversion']['dark_currents_counts_per_second']['i0'] is None
    json.dumps(result.metadata, allow_nan=False)


@pytest.mark.parametrize('name', SAMPLES)
def test_live_arithmetic_processing_download_restart_exchange_and_undo(tmp_path, name):
    s = store(tmp_path); p = s.create(); inspected = s.inspect(p['id'], raw(name), 'renamed.xdi')
    mapping = chosen(inspected, name); expected = reference(name); x, y = signal(expected, mapping)
    req = ImportRequest(version=0, upload_id=inspected['upload_id'], **mapping)
    preview = s.preview_columns(p['id'], req)
    np.testing.assert_array_equal(preview['traces'][0]['x'], x)
    np.testing.assert_array_equal(preview['traces'][0]['y'], y)
    assert s.load(p['id']) == p
    imported = s.import_data(p['id'], req); g = imported['groups'][0]
    assert g['processing_error'] is None
    np.testing.assert_array_equal(g['energy'], x); np.testing.assert_array_equal(g['mu'], y)
    assert len(g['result']['arrays']['norm']) == len(x)
    for key in ['chi', 'chir_mag', 'chiq_mag']:
        assert (len(g['result']['arrays'][key]) == 0) if name == 'cmc' else (len(g['result']['arrays'][key]) > 10)
    for i in range(expected.shape[1]):
        np.testing.assert_array_equal(g['source']['column_arrays'][f'column_{i+1:04d}'], expected[:, i])
    if name == 'lnls':
        original = [line.split() for line in raw(name).decode().splitlines()[1:] if line.strip()]
        metadata = g['source']['file_plugin']['conversion']
        assert metadata['date_values'] == [row[0] for row in original]
        assert metadata['time_values'] == [row[1] for row in original]
    assert s.inspected_file(p['id'], inspected['upload_id'], 'source') == (raw(name), 'renamed.xdi')
    converted = s.inspected_file(p['id'], inspected['upload_id'], 'converted')[0]
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.decode())), expected)
    assert AthenaStore(s.settings).load(p['id']) == imported
    for fmt in ['json', 'prj']:
        restored = s.restore(s.create()['id'], 0, s.export_project(p['id'], fmt), 'saved.'+fmt)['groups'][0]
        assert restored['source'] == g['source'] and restored['energy'] == g['energy'] and restored['mu'] == g['mu']
        assert restored['result']['arrays'] == g['result']['arrays']
    assert s.command(p['id'], Command(version=1, action='undo'))['groups'] == []
    assert s.command(p['id'], Command(version=2, action='redo'))['groups'][0]['source'] == g['source']


def test_cmc_zero_transmission_and_explicit_xanes_recovery(tmp_path):
    s = store(tmp_path); p = s.create(); i = s.inspect(p['id'], raw('cmc'), 'cmc.dat')
    request = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
    for action in [s.preview_columns, s.import_data]:
        with pytest.raises(WebInputError, match='zero detector counts'): action(p['id'], request)
        assert s.load(p['id']) == p
    choice = chosen(i, 'cmc'); request = ImportRequest(version=0, upload_id=i['upload_id'], **choice)
    np.testing.assert_array_equal(s.preview_columns(p['id'], request)['traces'][0]['y'], signal(reference('cmc'), choice)[1])
    g = s.import_data(p['id'], request)['groups'][0]
    assert g['processing_error'] is None and g['data_type'] == 'xanes'
    assert g['source']['file_plugin']['conversion']['dark_currents_counts_per_second'] == {'i0':136., 'i1':0., 'i2':101.}


def test_cmc_large_nan_diagnostics_keep_counts_and_bounded_positions():
    lines = next(p for p in PROBES if p['name'] == 'cmc-variable-time')['input'].splitlines()
    records = []
    for row in lines[6:] * 20:
        fields = row.split(); fields[1:4] = ['nan'] * 3; records.append(' '.join(fields))
    result = prepare('\n'.join(lines[:6] + records).encode())
    for key in ['nan_replacements', 'source_nonfinite']:
        diagnostic = result.metadata['conversion'][key]
        assert diagnostic['count'] == 240 and diagnostic['truncated']
        assert len(diagnostic['first_positions']) == 32
        assert diagnostic['first_positions'][0] == {'row':1, 'column':2}
        assert diagnostic['first_positions'][-1] == {'row':11, 'column':3}
    assert 'Replaced 240 NaN' in result.metadata['summary']


@pytest.mark.parametrize('name', ['hxma', 'lnls'])
def test_alternative_native_detector_suggestion_changes_preview_without_mutation(tmp_path, name):
    s = store(tmp_path); p = s.create(); i = s.inspect(p['id'], raw(name), name+'.dat')
    for mode in ['transmission', 'fluorescence']:
        mapping = chosen(i, name, mode); x, y = signal(reference(name), mapping)
        actual = s.preview_columns(p['id'], ImportRequest(version=0, upload_id=i['upload_id'], **mapping))
        np.testing.assert_array_equal(actual['traces'][0]['x'], x)
        np.testing.assert_array_equal(actual['traces'][0]['y'], y)
    assert s.load(p['id']) == p


@pytest.mark.parametrize('name', SAMPLES)
@pytest.mark.parametrize('position', ['first', 'middle', 'last'])
@pytest.mark.parametrize('damage', ['width', 'text', 'infinity'])
def test_damaged_records_fail_without_silent_drops_or_workspace_mutation(tmp_path, name, position, damage):
    lines = raw(name).splitlines(); indices = [i for i, line in enumerate(lines) if line.strip() and not line.startswith((b'#', b'"'))]
    index = indices[0 if position == 'first' else len(indices)//2 if position == 'middle' else -1]
    fields = lines[index].replace(b',', b' ').split()
    if damage == 'width': fields.pop()
    else: fields[2 if name == 'lnls' else 0] = b'broken' if damage == 'text' else b'inf'
    lines[index] = b'\t'.join(fields)
    s = store(tmp_path); p = s.create(); before = sorted(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], b'\n'.join(lines), 'damaged.dat')
    assert s.load(p['id']) == p and sorted(s.storage.workspace_dir(p['id']).iterdir()) == before


@pytest.mark.parametrize('name', SAMPLES)
@pytest.mark.parametrize('kind', ['bytes', 'points', 'columns', 'binary', 'encoding'])
def test_resource_and_text_boundaries(name, kind):
    data = raw(name); limits = {}
    if kind == 'bytes': limits['max_bytes'] = len(data)-1
    elif kind == 'points': limits['max_points'] = len(reference(name))-1
    elif kind == 'columns': limits['max_columns'] = reference(name).shape[1]-1
    elif kind == 'binary': data += b'\0'
    else: data += b'\xff'
    with pytest.raises(WebInputError) as error: prepare(data, **limits)
    assert error.value.code == {'bytes':'upload_too_large', 'points':'upload_too_many_points',
        'columns':'upload_too_many_columns', 'binary':'upload_binary', 'encoding':'upload_encoding'}[kind]
    # Exact retained width is accepted even when raw files contain auxiliary PVs.
    assert prepare(raw(name), max_columns=reference(name).shape[1])


@pytest.mark.parametrize('change', ['zero-time', 'nan-time', 'missing-labels', 'repeat-labels', 'count'])
def test_cmc_invalid_dark_time_and_label_boundaries(change):
    probe = next(p for p in PROBES if p['name'] == 'cmc-variable-time'); lines = probe['input'].splitlines()
    if change in ['zero-time','nan-time']:
        fields = lines[6].split(); fields[-1] = '0' if change == 'zero-time' else 'nan'; lines[6] = ' '.join(fields)
    elif change == 'missing-labels': lines.pop(5)
    elif change == 'repeat-labels': lines.append(lines[5])
    else: lines[4] = '#N 999'
    with pytest.raises(WebInputError): prepare('\n'.join(lines).encode())


@pytest.mark.parametrize('pv', [b'Energy:sp', b'mcs04:fbk', b'mcs05:fbk', b'mcs06:fbk', b'mcs03:fbk'])
def test_hxma_missing_named_pv_never_uses_event_identifier_as_detector(pv):
    with pytest.raises(WebInputError, match='column in its Event-ID header'):
        prepare(raw('hxma').replace(pv, b'unavailable:pv'))


@pytest.mark.parametrize('name', SAMPLES)
def test_real_http_registry_recovery_preview_original_and_import(tmp_path, name):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        p = client.post('/api/athena/projects').json(); base = f'/api/athena/projects/{p["id"]}'
        response = client.post(base+'/inspect', files={'file':('input.dat', raw(name))})
        assert response.status_code == 400 and 'disabled' in response.text
        response = client.put('/api/athena/preferences/plugins', json={'version':0, 'enabled':{f'Demeter::Plugins::{name.upper()}':True}})
        assert response.status_code == 200
        i = client.post(base+'/inspect', files={'file':('input.dat', raw(name))}).json()
        if name == 'cmc':
            invalid = dict(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
            assert client.post(base+'/preview-columns', json=invalid).status_code == 400
            assert client.post(base+'/import', json=invalid).status_code == 400
        req = dict(version=0, upload_id=i['upload_id'], **chosen(i, name))
        preview = client.post(base+'/preview-columns', json=req); assert preview.status_code == 200
        assert client.get(base+f'/uploads/{i["upload_id"]}/file').content == raw(name)
        accepted = client.post(base+'/import', json=req)
        assert accepted.status_code == 200 and accepted.json()['groups'][0]['processing_error'] is None
        assert accepted.json()['groups'][0]['mu'] == preview.json()['traces'][0]['y']
