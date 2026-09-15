import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, ImportRequest, Command
from xraylarch_web.athena_file_plugins import prepare_file
from xraylarch_web.athena_bl8ar import AR_K_EV
from xraylarch_web.athena_plugin_config import BL8ArParameters, ConfigurationRequest, default_configuration
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent/'fixtures'


def raw(mode='trans'):
    return (FIXTURES/('constructed-spec-long.dat' if mode == 'spec' else f'constructed-bl8ar-{mode}.dat')).read_bytes()


def prepare(data, params=None, **bounds):
    return prepare_file(data, **(dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | bounds),
        read_configuration=lambda reader: default_configuration(reader) | {'values': BL8ArParameters(**(params or {})).model_dump()})


def store(root):
    s = AthenaStore(Settings(data_root=root))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{r}': True for r in ['BL8Ar', 'SpecFileLongLine']}))
    return s


def test_all_native_output_bytes_columns_and_suggestions():
    manifest = json.loads((FIXTURES/'athena-bl8ar-spec-long-fixtures.json').read_text())
    for ref in manifest['references']:
        data = (FIXTURES/ref['input']).read_bytes(); assert hashlib.sha256(data).hexdigest() == ref['input_sha256']
        encoded = (FIXTURES/ref['file']).read_bytes(); assert hashlib.sha256(encoded).hexdigest() == ref['sha256']
        expected = json.loads(gzip.decompress(encoded)); result = prepare(data, ref['parameters'])
        assert expected['native']['recognized'] == 1
        assert result.metadata['converted_sha256'] == expected['converted_sha256']
        choice = next(iter(result.suggestions.values())); native = expected['native']['default']
        assert choice['numerator'] == [int(v[1:])-1 for v in native['numerator'].split('+')]
        assert choice['denominator'] == int(native['denominator'][1:])-1
        assert (choice['mode'] == 'transmission') == bool(native['ln'])
        assert len(expected['columns']) == 211
        if ref['reader'] == 'BL8Ar':
            assert expected['native']['put']['parameters']['bkg_nnorm'] == 2
            assert result.preview['step_size'] == pytest.approx(expected['native']['attrs']['step_size'], abs=1e-10, rel=0)


@pytest.mark.parametrize('mode', ['trans', 'sidrift', 'ge', 'spec'])
def test_live_edit_source_retention_processing_and_project_exchange(tmp_path, mode):
    s = store(tmp_path); p = s.create(); i = s.inspect(p['id'], raw(mode), 'sample.dat')
    request = ImportRequest(version=0, upload_id=i['upload_id'], **(i['athena_suggestion'] | {'data_type': 'xanes'}))
    data = s.storage.read_arrays(p['id'], f"upload-{i['upload_id']}.npz")
    columns = [data[c['column_id']] for c in i['columns']]
    preview = s.preview_columns(p['id'], request)
    if mode == 'ge':
        assert len(request.numerator) == 4 and 'SCA0–SCA3' in i['file_plugin']['summary']
        request = request.model_copy(update={'numerator': [c['column_id'] for c in i['columns'][6:19]]})
    elif mode == 'spec':
        assert request.numerator == [i['columns'][55]['column_id']]
        request = request.model_copy(update={'denominator': i['columns'][54]['column_id']})
    else:
        request = request.model_copy(update={'reference_numerator': i['columns'][5]['column_id'], 'reference_log': False})
    edited = s.preview_columns(p['id'], request)
    y = sum(data[key] for key in request.numerator) / data[request.denominator]
    if request.mode == 'transmission': y = np.log(abs(y))
    np.testing.assert_allclose(edited['traces'][0]['y'], y)
    if mode in ['ge', 'spec']: assert not np.allclose(edited['traces'][0]['y'], preview['traces'][0]['y'])
    else: np.testing.assert_allclose(edited['traces'][1]['y'], columns[5])
    assert s.load(p['id']) == p
    imported = s.import_data(p['id'], request); group = imported['groups'][0]
    assert group['processing_error'] is None and group['result']['arrays']['norm']
    assert group['source']['column_arrays'] == {k: v.tolist() for k, v in data.items()}
    assert s.inspected_file(p['id'], i['upload_id'], 'source')[0] == raw(mode)
    for fmt in ['json', 'prj']:
        restored = s.restore(s.create()['id'], 0, s.export_project(p['id'], fmt), 'saved.'+fmt)
        assert restored['groups'][0]['source'] == group['source']
        np.testing.assert_allclose(restored['groups'][0]['mu'], group['mu'])
    assert s.command(p['id'], Command(version=imported['version'], action='undo'))['groups'] == []


@pytest.mark.parametrize('e0,expected', [(1402, False), (1403, True), (1559, True), (1602, True), (1603, False), (1700, False)])
def test_native_activation_uses_header_integer_and_exclusive_margin(e0, expected):
    result = prepare(raw().replace(b'= 1559', f'= {e0}'.encode()))
    assert (result is not None) == expected


def test_harmonic_and_margin_apply_to_next_inspection():
    assert prepare(raw(), {'harmonic': 1}) is None
    assert prepare(raw(), {'harmonic': 3}) is None
    assert prepare(raw(), {'margin': 40}) is None
    assert prepare(raw().replace(b'= 1559', b'= 1559.75')) is not None
    assert prepare(raw().replace(b'BL8:', b'BL9:')) is None


@pytest.mark.parametrize('key,value', [('harmonic', True), ('harmonic', 1.), ('harmonic', 0), ('harmonic', 4),
    ('plot', 1), ('margin', 0), ('margin', float('inf')), ('pre1', -5), ('pre2', 0), ('nor1', 35), ('nor2', float('nan'))])
def test_invalid_configurations(key, value):
    with pytest.raises(ValidationError): BL8ArParameters(**{key: value})


def test_step_boundary_precision_and_falling_edge_are_native_larch():
    data = raw().replace(b'1603 ', b'1602.95 ', 1)
    r = prepare(data); original = np.loadtxt(data.splitlines()[5:]); converted = np.loadtxt(r.data.splitlines())
    boundary = np.where(original[:, 0] == AR_K_EV/2)[0][0]
    assert converted[boundary, 3] == float(f'{original[boundary, 3]:.5E}')
    expected = original[:, 3] - (original[:, 0] > AR_K_EV/2)*r.preview['step_size']
    np.testing.assert_array_equal(converted[:, 3], [float(f'{v:.5E}') for v in expected])
    rows = original.copy(); rows[:, 3] = 22000 - rows[:, 3]
    falling = b'\n'.join(raw().splitlines()[:5]) + b'\n' + ('\n'.join(' '.join(str(v) for v in row) for row in rows)+'\n').encode()
    f = prepare(falling)
    assert f.preview['step_size'] > 0 and f.metadata['conversion']['signed_fit_jump'] < 0
    assert 'falling' in f.metadata['summary']


@pytest.mark.parametrize('mode', ['trans', 'sidrift', 'ge', 'spec'])
def test_every_row_and_resource_bound_is_checked(mode):
    data = raw(mode)
    for changed in [data+b'broken 1 2\n', data+b'1704 1 2 nan 3 4\n', data+b'1705 1 2\n']:
        with pytest.raises(WebInputError): prepare(changed)
    for bounds in [{'max_bytes': len(data)-1}, {'max_points': 210}, {'max_columns': 5}, {'enabled': {}}]:
        with pytest.raises(WebInputError): prepare(data, **bounds)


def test_incomplete_fit_ranges_duplicate_energy_and_bad_mode_fail_before_staging(tmp_path):
    s = store(tmp_path); p = s.create(); before = list(s.storage.workspace_dir(p['id']).iterdir())
    for changed in [raw().replace(b'Transmission-mode XAS', b'Unknown mode'), raw()+raw().splitlines()[-1]+b'\n', b'\n'.join(raw().splitlines()[:95])]:
        with pytest.raises(WebInputError): s.inspect(p['id'], changed, 'bad.dat')
        assert list(s.storage.workspace_dir(p['id']).iterdir()) == before


def test_spec_exact_length_first_label_comment_boundary_and_short_manual_columns(tmp_path):
    tail = b'1000 2 1\r\n1001 3 2\r\n'
    for size in [253, 254, 255, 256]:
        line = b'#L' + b'x'*(size-4) + b'\r\n'
        assert (prepare(b'#F file\r\n'+line+tail) is not None) == (size > 254)
    long = b'#L'+b'x'*255+b'\n'
    for prefix in [b'\n', b'comment\n', b'#L short\n']:
        assert prepare(prefix+long+tail) is None
    short = b'#F probe\r\n'+long+tail
    r = prepare(short)
    assert r.data == b'#F probe\r\n'+tail and r.suggestions == {}
    s = store(tmp_path); p = s.create(); i = s.inspect(p['id'], short, 'short.dat')
    assert i['row_count'] == 2 and i['plugin_suggestions'] == {}


def test_review_guard_http_and_staged_configuration_snapshot(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        base = '/api/athena'; prefs = base+'/preferences/plugins'
        state = client.get(prefs).json(); state = {k: state[k] for k in ['version', 'enabled']}
        state['enabled']['Demeter::Plugins::BL8Ar'] = True
        assert client.put(prefs, json=state).status_code == 200
        path = prefs+'/BL8Ar/configuration'; config = client.get(path).json()
        def update(values):
            current = client.get(path).json()
            response = client.put(path, json={k: current[k] for k in ['version', 'session_id']} | {'values': current['values'] | values, 'save': True})
            assert response.status_code == 200
            return response.json()
        update({'plot': True})
        p = client.post(base+'/projects').json(); project = base+'/projects/'+p['id']
        i = client.post(project+'/inspect', files={'file': ('bl8.dat', raw())}).json()
        request = dict(version=0, upload_id=i['upload_id'], **(i['athena_suggestion'] | {'data_type': 'xanes'}))
        assert client.post(project+'/preview-columns', json=request).status_code == 200
        blocked = client.post(project+'/import', json=request)
        assert blocked.status_code == 400 and 'reader_review_required' in blocked.text
        update({'plot': False, 'pre1': -40})
        assert client.post(project+'/import', json=request).status_code == 400
        assert client.get(project).json()['version'] == 0
        accepted = client.post(project+'/import', json=request | {'reader_reviewed': True})
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()['groups'][0]['source']['file_plugin']['configuration']['values']['plot'] is True
        fresh = client.post(project+'/inspect', files={'file': ('bl8.dat', raw())}).json()
        assert fresh['file_plugin']['review_required'] is False
        assert fresh['file_plugin']['configuration']['values']['pre1'] == -40
