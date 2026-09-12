import copy
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from reference.beamline_native_reference import cases
from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.athena_beamline_metadata import BeamlineDefaults, identify
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app
from xraylarch_web.parsing import parse_upload

FIXTURES = Path(__file__).parent/'fixtures'
CASES = list(cases())
NATIVE = {r['name']: r for r in json.loads((FIXTURES/'athena-beamline-native.json').read_text())}


@pytest.mark.parametrize('name,reader,raw,crystal', CASES, ids=[c[0] for c in CASES])
def test_executed_native_helpers(name, reader, raw, crystal):
    expected = copy.deepcopy(NATIVE[name]); native = expected['native']
    assert expected['input_sha256'] == hashlib.sha256(raw).hexdigest()
    actual = identify(raw, bl8_crystal=crystal)
    assert actual['reader'] == reader and actual['identified'] and native['recognized'] == 1
    assert actual['source_sha256'] == expected['input_sha256']
    # Native chomp leaves a CR in CRLF comments. Text display normalizes it.
    native['comments'] = [s.rstrip('\r') for s in native['comments']]
    corrections = {'x11a-four-digit-year': '1992-09-15T01:52:53',
                   'xdac-AM': '2009-02-28T00:00:00', 'xdac-PM': '2009-02-28T12:00:00'}
    if name in corrections:
        assert actual['native_values']['start_time'] == native['attributes']['scan']['start_time']
        assert actual['warnings']
        native['attributes']['scan']['start_time'] = corrections[name]
    else:
        assert actual['warnings'] == []
    for key in ['attributes', 'comments', 'daq', 'beamline', 'extra_version', 'ini_files']:
        assert actual[key] == native[key]


def test_measured_x11a_all_observations_labels_units_and_source_bytes():
    raw = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '53c258b4d8927bf266a5b074011c93ad2de9338c40ed501b723707dc3e78fc9d'
    rows = np.loadtxt(io.BytesIO(raw), skiprows=12)
    parsed = parse_upload(raw, 'cu.012')
    assert parsed.row_count == 612 and parsed.source_bytes == raw
    assert [c.name for c in parsed.columns] == ['energy', 'I0', 'I', 'If']
    assert parsed.columns[0].unit == 'eV' and parsed.columns[0].role_hint == 'energy'
    np.testing.assert_array_equal(np.array(list(parsed.arrays.values())).T, rows)
    assert '611 points; all 612 observed rows' in parsed.warnings[0]


@pytest.mark.parametrize('position', [12, 250, 623])
@pytest.mark.parametrize('bad', [b'8999 bad 10 20', b'8999 10 20', b'# damaged observation', b'8999 nan 10 20'])
def test_x11a_never_drops_damaged_first_middle_or_final_observations(position, bad):
    lines = (FIXTURES/'demeter-x11a-cu.012').read_bytes().splitlines()
    lines[position] = bad
    with pytest.raises(WebInputError) as exc:
        parse_upload(b'\n'.join(lines), 'cu.012')
    assert exc.value.code in ['upload_malformed_rows', 'upload_nonfinite']


@pytest.mark.parametrize('old,new', [(b'DETECTORS', b'MISSING'), (b'OFFSETS', b'UNKNOWN'),
                                   (b'EDC-5.02', b'EDC-bad'), (b'OFFSETS     51284', b'OFFSETS')])
def test_x11a_header_boundary_cannot_be_guessed(old, new):
    raw = (FIXTURES/'demeter-x11a-cu.012').read_bytes().replace(old, new)
    with pytest.raises(WebInputError, match='X11A EDC header'):
        parse_upload(raw, 'cu.012')


def test_x11a_point_and_column_limits_and_empty_table():
    raw = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    for limits, code in [({'max_points': 611}, 'upload_too_many_points'), ({'max_columns': 3}, 'upload_too_many_columns')]:
        with pytest.raises(WebInputError) as exc:
            parse_upload(raw, 'cu.012', **limits)
        assert exc.value.code == code
    with pytest.raises(WebInputError) as exc:
        parse_upload(b'\n'.join(raw.splitlines()[:12]), 'cu.012')
    assert exc.value.code == 'upload_empty'


@pytest.mark.parametrize('filename', ['demeter-x11a-cu.012', 'fe.060', 'constructed-bl8ar-trans.dat'])
def test_real_preview_edits_processing_and_project_round_trips(tmp_path, filename):
    store = AthenaStore(Settings(data_root=tmp_path)); p = store.create()
    AthenaPreferences(store.settings).save_plugins(PluginRegistry(enabled={'Demeter::Plugins::BL8Ar': True}))
    path = FIXTURES.parents[2]/'examples/xafsdata/fe.060' if filename == 'fe.060' else FIXTURES/filename
    raw = path.read_bytes(); inspected = store.inspect(p['id'], raw, filename)
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], **inspected['athena_suggestion'])
    before = store.preview_columns(p['id'], request)
    columns = store.storage.read_arrays(p['id'], f"upload-{inspected['upload_id']}.npz")
    edited = request.model_copy(update={'mode': 'fluorescence', 'numerator': [inspected['columns'][-1]['column_id']],
                                       'denominator': inspected['columns'][1]['column_id']})
    after = store.preview_columns(p['id'], edited)
    expected = columns[edited.numerator[0]] / columns[edited.denominator]
    np.testing.assert_allclose(after['traces'][0]['y'], expected)
    assert not np.allclose(before['traces'][0]['y'], after['traces'][0]['y'])
    assert store.load(p['id']) == p
    imported = store.import_data(p['id'], request); group = imported['groups'][0]
    assert group['processing_error'] is None and group['result']['arrays']['norm']
    assert group['source']['column_arrays'] == {k: v.tolist() for k, v in columns.items()}
    assert group['source']['beamline_metadata'] == inspected['beamline_metadata']
    assert store.inspected_file(p['id'], inspected['upload_id'], 'source')[0] == raw
    # Persistence is checked after rebuilding the service as well as both exchange formats.
    store = AthenaStore(store.settings)
    assert store.load(p['id'])['groups'][0]['source'] == group['source']
    for fmt in ['json', 'prj']:
        restored = store.restore(store.create()['id'], 0, store.export_project(p['id'], fmt), 'saved.'+fmt)
        assert restored['groups'][0]['source'] == group['source']
        np.testing.assert_array_equal(restored['groups'][0]['mu'], group['mu'])


def test_mx_quickscan_preview_keeps_duplicate_energies_and_metadata(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path)); p = s.create()
    i = s.inspect(p['id'], (FIXTURES/'demeter-uhup.101').read_bytes(), 'uhup.101')
    q = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
    preview = s.preview_columns(p['id'], q)
    x = preview['traces'][0]['x']
    assert len(x) == i['row_count'] and len(set(x)) < len(x)
    assert i['beamline_metadata']['attributes']['beamline']['name'] == '10ID'
    assert 'column' not in i['beamline_metadata']['attributes']  # Native MX early exit.


def test_bl8ar_identifies_converted_header_and_retains_corrected_step(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path)); p = s.create()
    prefs = AthenaPreferences(s.settings)
    prefs.save_plugins(PluginRegistry(enabled={'Demeter::Plugins::BL8Ar': True}))
    i = s.inspect(p['id'], (FIXTURES/'constructed-bl8ar-trans.dat').read_bytes(), 'bl8.dat')
    metadata = i['beamline_metadata']
    assert metadata['input_basis'] == 'converted'
    assert metadata['source_sha256'] == i['file_plugin']['converted_sha256']
    assert float(metadata['attributes']['slri']['arstep']) == pytest.approx(603.2)
    # The converter retains the uncorrected absorption in its sixth column.
    assert metadata['attributes']['column']['6'] == 'mu'


def test_global_preference_defaults_persistence_conflict_and_existing_metadata(tmp_path):
    settings = Settings(data_root=tmp_path); s = AthenaStore(settings); p = s.create()
    data = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    with TestClient(create_app(settings)) as client:
        path = '/api/athena/preferences/beamline'
        assert client.get(path).json() == {'version': 0, 'enabled': True}
        i = s.inspect(p['id'], data, 'cu.012')
        group = s.import_data(p['id'], ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion']))
        assert client.put(path, json={'version': 0, 'enabled': False}).json() == {'version': 1, 'enabled': False}
        assert client.put(path, json={'version': 0, 'enabled': True}).status_code == 409
        for payload in [{'version': True, 'enabled': True}, {'version': 1, 'enabled': 'false'}, {'version': 1, 'enabled': False, 'extra': 1}]:
            assert client.put(path, json=payload).status_code == 422
        disabled = s.inspect(p['id'], data, 'cu.012')
        assert 'beamline_metadata' not in disabled and disabled['row_count'] == 612
        assert s.load(p['id']) == group
        assert AthenaPreferences(settings).read_beamline() == {'version': 1, 'enabled': False}
        assert client.put(path, json={'version': 1, 'enabled': True}).json()['version'] == 2
        response = client.post(f"/api/athena/projects/{p['id']}/inspect", files={'file': ('cu.012', data)})
        assert response.status_code == 200 and response.json()['beamline_metadata']['reader'] == 'X11A'


def test_unrecognized_and_disabled_headers_and_invalid_dates():
    assert identify(b'# energy mu\n1 2\n') is None
    raw = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    assert identify(raw, enabled=False) is None
    bad = identify(raw.replace(b'15-Sep-92', b'15-Bad-92'))
    assert bad['warnings'] and 'start_time' not in bad['attributes']['scan']
    assert bad['source_sha256'] == hashlib.sha256(raw.replace(b'15-Sep-92', b'15-Bad-92')).hexdigest()
