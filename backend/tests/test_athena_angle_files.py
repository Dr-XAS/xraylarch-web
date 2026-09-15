"""Official angle/MED acquisitions and source-declared SRS energy records."""
from pathlib import Path
from io import StringIO
import gzip
import hashlib
import json
import re

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
SAMPLES = ['srs9', 'srs32', 'dubble', 'pfbl12c', 'srsc']
READERS = ['SRS', 'DUBBLE', 'PFBL12C']


def raw(name):
    return (FIXTURES / f'demeter-{name}.dat').read_bytes()


def reference(name):
    if name == 'srsc':
        return np.asarray([list(map(float, line.split())) for line in raw(name).decode().splitlines()
                           if re.match(r'^\s*\d+\.\d+\s', line)])
    return np.asarray(json.loads(gzip.decompress((FIXTURES / f'{name}-native-columns.json.gz').read_bytes())))


def prepare(data, **limits):
    return prepare_file(data, **dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | limits)


def store(tmp_path):
    s = AthenaStore(Settings(data_root=tmp_path))
    AthenaPreferences(s.settings).save_plugins(PluginRegistry(enabled={f'Demeter::Plugins::{name}': True for name in READERS}))
    return s


def data_indices(lines, name):
    boundary = next(i for i, line in enumerate(lines) if re.match(rb'^\s*(?:&END|Offset)', line, re.I))
    return [i for i in range(boundary+1, len(lines)) if re.match(rb'^\s*\d', lines[i])]


def test_retained_hashes_and_source_identities():
    m = json.loads((FIXTURES / 'athena-angle-fixtures.json').read_text())
    assert sum(np.prod(v['shape']) for v in m['references']) == 29114
    for item in m['files'] + m['references']:
        data = (FIXTURES / item['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        if 'git_blob_sha1' in item:
            assert len(data) == item['bytes']
            assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == item['git_blob_sha1']


@pytest.mark.parametrize('name', SAMPLES)
def test_all_columns_and_native_suggestions_through_real_larch(tmp_path, name):
    result = prepare(raw(name)); output = tmp_path / 'columns.dat'; output.write_bytes(result.data)
    expected = reference(name)
    group = read_ascii(str(output))
    np.testing.assert_array_equal(group.data.T, expected)
    if name == 'pfbl12c':
        assert group.array_labels == ['energy_requested','energy_attained','time','i0','i1']
        assert getattr(group, 'energy_units', 'eV') == 'eV'
    if name != 'srsc':
        native = next(r for r in json.loads((FIXTURES / 'athena-angle-fixtures.json').read_text())['references'] if r['sample'] == name)['native']['transmission']
        suggestion = next(iter(result.suggestions.values()))
        assert suggestion['energy_column'] == int(native['energy'][1:]) - 1
        assert suggestion['numerator'] == [int(v[1:])-1 for v in native['numerator'].split('+')]
        assert suggestion['denominator'] == int(native['denominator'][1:])-1
        assert (suggestion['mode'] == 'transmission') == bool(native['ln'])
    assert result.metadata['conversion']['offsets_applied'] is False


@pytest.mark.parametrize('name', SAMPLES)
def test_live_arithmetic_processing_download_restart_exchange_and_undo(tmp_path, name):
    s = store(tmp_path); p = s.create(); inspected = s.inspect(p['id'], raw(name), 'renamed.xdi')
    mapping = inspected['athena_suggestion']
    if name == 'pfbl12c':
        assert [c['name'] for c in inspected['columns']] == ['energy_requested','energy_attained','time','i0','i1']
    if name == 'srsc':
        # Explicitly choose SIGNAL1 / REFER for this energy-labelled measurement.
        mapping = dict(mapping, numerator=['column_0004'], denominator='column_0003', mode='fluorescence')
    req = ImportRequest(version=0, upload_id=inspected['upload_id'], **mapping)
    expected = reference(name); x = expected[:, int(mapping['energy_column'][-4:])-1]
    y = sum(expected[:, int(v[-4:])-1] for v in mapping['numerator']) / expected[:, int(mapping['denominator'][-4:])-1]
    if mapping['mode'] == 'transmission': y = np.log(np.abs(y))
    preview = s.preview_columns(p['id'], req)
    np.testing.assert_array_equal(preview['traces'][0]['x'], x)
    np.testing.assert_array_equal(preview['traces'][0]['y'], y)
    assert s.load(p['id']) == p
    imported = s.import_data(p['id'], req); g = imported['groups'][0]
    assert g['processing_error'] is None
    np.testing.assert_array_equal(g['energy'], x); np.testing.assert_array_equal(g['mu'], y)
    for key in ['norm', 'chi', 'chir_mag', 'chiq_mag']: assert len(g['result']['arrays'][key]) > 10
    for i in range(expected.shape[1]):
        np.testing.assert_array_equal(g['source']['column_arrays'][f'column_{i+1:04d}'], expected[:, i])
    assert s.inspected_file(p['id'], inspected['upload_id'], 'source') == (raw(name), 'renamed.xdi')
    converted = s.inspected_file(p['id'], inspected['upload_id'], 'converted')[0]
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.decode())), expected)
    assert AthenaStore(s.settings).load(p['id']) == imported
    for format in ['json', 'prj']:
        restored = s.restore(s.create()['id'], 0, s.export_project(p['id'], format), 'saved.'+format)['groups'][0]
        assert restored['source'] == g['source'] and restored['energy'] == g['energy'] and restored['mu'] == g['mu']
    assert s.command(p['id'], Command(version=1, action='undo'))['groups'] == []
    assert s.command(p['id'], Command(version=2, action='redo'))['groups'][0]['source'] == g['source']


@pytest.mark.parametrize('name', ['srs9', 'srs32', 'dubble'])
@pytest.mark.parametrize('position', ['first', 'middle', 'last'])
def test_incomplete_med_record_is_never_dropped_or_merged(tmp_path, name, position):
    lines = raw(name).splitlines(); indices = data_indices(lines, name)
    tails = [i for i in indices if len(lines[i].split()) < 6]
    index = tails[0 if position == 'first' else len(tails)//2 if position == 'middle' else -1]
    lines.pop(index)
    s = store(tmp_path); p = s.create(); before = set(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], b'\n'.join(lines), 'damaged.dat')
    assert s.load(p['id']) == p and set(s.storage.workspace_dir(p['id']).iterdir()) == before


@pytest.mark.parametrize('name', SAMPLES)
@pytest.mark.parametrize('position', ['first', 'middle', 'last'])
def test_nonfinite_values_cannot_hide_in_any_detector_or_late_record(name, position):
    lines = raw(name).splitlines(); indices = data_indices(lines, name)
    index = indices[0 if position == 'first' else len(indices)//2 if position == 'middle' else -1]
    fields = lines[index].split(); fields[-1] = b'nan'; lines[index] = b' '.join(fields)
    with pytest.raises(WebInputError) as error: prepare(b'\n'.join(lines))
    assert error.value.code == 'upload_nonfinite'


@pytest.mark.parametrize('name', SAMPLES)
@pytest.mark.parametrize('limit', ['max_points', 'max_columns'])
def test_converted_resource_limits_and_exact_boundary(name, limit):
    shape = reference(name).shape; n = shape[0 if limit == 'max_points' else 1]
    with pytest.raises(WebInputError) as error: prepare(raw(name), **{limit: n-1})
    assert error.value.code == ('upload_too_many_points' if limit == 'max_points' else 'upload_too_many_columns')
    assert prepare(raw(name), **{limit: n})


def test_specific_dubble_priority_and_generic_srs_fallback_preserve_different_native_choices():
    both = {f'Demeter::Plugins::{v}': True for v in ['DUBBLE','SRS']}
    specific = prepare(raw('dubble'), enabled=both)
    generic = prepare(raw('dubble'), enabled=dict(both, **{'Demeter::Plugins::DUBBLE':False}))
    assert specific.metadata['id'] == 'DUBBLE' and generic.metadata['id'] == 'SRS'
    assert specific.suggestions['fluorescence']['numerator'] == list(range(7,15))
    assert generic.suggestions['fluorescence']['numerator'] == [7,8,9,10,11,12,14]
    np.testing.assert_array_equal(np.loadtxt(StringIO(specific.data.decode())), np.loadtxt(StringIO(generic.data.decode())))
    with pytest.raises(WebInputError) as error: prepare(raw('dubble'), enabled={})
    assert error.value.code == 'file_plugin_disabled' and 'DUBBLE' in str(error.value)


@pytest.mark.parametrize('name', ['srs9','dubble'])
def test_non_med_records_comments_and_aborted_acquisition_keep_recorded_points(name):
    lines = raw(name).splitlines(); boundary = next(i for i,line in enumerate(lines) if b'&END' in line)
    records = [line for line in lines[boundary+1:] if len(line.split()) == 6]
    data = b'\n'.join(lines[:boundary+1] + [b' C Interrupted acquisition'] + records[:8] + [b'DATA ABORTED', b'unfinished instrument trailer'])
    result = prepare(data)
    assert result.metadata['conversion']['detector_channels'] == 0
    assert result.metadata['conversion']['terminator'] == 'DATA ABORTED'
    expected = reference(name)[:8,:6]
    np.testing.assert_array_equal(np.loadtxt(StringIO(result.data.decode())), expected)
    assert result.suggestions['transmission']['numerator'] == [2]


@pytest.mark.parametrize('change', ['negative_spacing','zero_spacing','zero_angle','negative_angle','underflow_angle','overflow_spacing','missing_offset','binary'])
def test_pf_geometry_and_boundary_errors_are_explicit(change):
    data = raw('pfbl12c')
    if change == 'negative_spacing': data = data.replace(b'D=  3.13551 A', b'D= -3.13551 A')
    elif change == 'zero_spacing': data = data.replace(b'D=  3.13551 A', b'D=  0.0 A')
    elif change == 'zero_angle': data = data.replace(b'9.44433', b'0.00000', 1)
    elif change == 'negative_angle': data = data.replace(b'9.44433', b'-9.44433', 1)
    elif change == 'underflow_angle': data = data.replace(b'9.44433', b'1e-323', 1)
    elif change == 'overflow_spacing': data = data.replace(b'D=  3.13551 A', b'D=  1e308 A')
    elif change == 'missing_offset': data = data.replace(b'Offset', b'Missing')
    else: data += b'\0'
    with pytest.raises(WebInputError): prepare(data)


@pytest.mark.parametrize('beamline', [b'KEK-PF NW10A', b'SPring-8 BL01B1', b'SAGA-LS 11', b'AichiSR BL5S1'])
def test_pf_facility_signatures_use_the_same_converter(beamline):
    # Constructed header substitutions, not independent public acquisitions.
    data = raw('pfbl12c').replace(b'KEK-PF   BL12C', beamline, 1)
    np.testing.assert_array_equal(np.loadtxt(StringIO(prepare(data).data.decode())), reference('pfbl12c'))


def test_pf_additional_detector_columns_are_retained_and_offsets_not_subtracted():
    lines = raw('pfbl12c').splitlines()
    for i in data_indices(lines, 'pfbl12c'): lines[i] += b' 10.12345 -4.1256'
    result = prepare(b'\n'.join(lines))
    rows = np.loadtxt(StringIO(result.data.decode()))
    np.testing.assert_array_equal(rows[:,:5], reference('pfbl12c'))
    np.testing.assert_array_equal(rows[:,5:], np.tile([10.123, -4.126], (818,1)))


def test_pf_native_spacing_fallback_is_visible_and_repeated_headers_use_the_last_value():
    m = json.loads((FIXTURES / 'athena-angle-fixtures.json').read_text())['pf_missing_spacing']
    encoded = (FIXTURES / m['file']).read_bytes()
    assert hashlib.sha256(encoded).hexdigest() == m['sha256']
    default = prepare(raw('pfbl12c').replace(b'D=  3.13551 A', b'monochromator spacing absent'))
    rows = np.loadtxt(StringIO(default.data.decode()))
    np.testing.assert_array_equal(rows[:,:2], json.loads(gzip.decompress(encoded)))
    np.testing.assert_array_equal(rows[:,2:], reference('pfbl12c')[:,2:])
    assert default.metadata['conversion']['d_spacing'] == .5
    assert default.metadata['conversion']['d_spacing_origin'] == 'native_default'
    assert '2d = 1 Å' in default.metadata['summary']
    repeated = prepare(raw('pfbl12c').replace(b'D=  3.13551 A', b'D=  2.0 A\n Mono : SI(111) D=  3.13551 A'))
    np.testing.assert_array_equal(np.loadtxt(StringIO(repeated.data.decode())), reference('pfbl12c'))


def test_srsc_explicit_energy_is_not_inferred_from_monotonicity(tmp_path):
    s = store(tmp_path); p = s.create(); inspected = s.inspect(p['id'], raw('srsc'), 'soft-xray.dat')
    assert inspected['file_plugin']['conversion']['source_axis'] == 'energy_eV'
    assert [c['name'] for c in inspected['columns']] == ['energy','time','refer','signal1','signal2','signal3','encoder']
    np.testing.assert_array_equal(reference('srsc')[:,0], np.loadtxt(StringIO(prepare(raw('srsc')).data.decode()))[:,0])
    assert 'C   ENERGY' in inspected['converted_preview']
    imported = s.import_data(p['id'], ImportRequest(version=0, upload_id=inspected['upload_id'], **inspected['athena_suggestion']))
    assert 'edge step is not positive' in imported['groups'][0]['processing_error']


def test_real_http_reader_recovery_preview_and_original_bytes(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        p = client.post('/api/athena/projects').json(); base = f'/api/athena/projects/{p["id"]}'
        response = client.post(base+'/inspect', files={'file':('input.dat',raw('dubble'))})
        assert response.status_code == 400 and 'disabled' in response.text
        client.put('/api/athena/preferences/plugins', json={'version':0,'enabled':{'Demeter::Plugins::DUBBLE':True}})
        i = client.post(base+'/inspect', files={'file':('input.dat',raw('dubble'))}).json()
        req = dict(version=0,upload_id=i['upload_id'],**i['athena_suggestion'])
        assert client.post(base+'/preview-columns',json=req).status_code == 200
        assert client.get(base+f'/uploads/{i["upload_id"]}/file').content == raw('dubble')
        accepted = client.post(base+'/import',json=req)
        assert accepted.status_code == 200 and accepted.json()['groups'][0]['processing_error'] is None
