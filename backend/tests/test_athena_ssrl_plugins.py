"""Official SSRL acquisitions compared with actual pinned Perl converter output."""
from io import StringIO
import hashlib
import gzip
import json
from pathlib import Path
import struct

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
READERS = ['SSRLA', 'SSRLB', 'SSRLmicro']


def raw(name):
    return (FIXTURES / f'demeter-{name.lower()}.dat').read_bytes()


def oracle(name):
    with np.load(FIXTURES / f'demeter-{name.lower()}-native.npz') as f:
        return f['columns']


def prepare(data, **limits):
    return prepare_file(data, **dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | limits)


def enabled_store(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(PluginRegistry(enabled={'Demeter::Plugins::' + name: True for name in READERS}))
    return AthenaStore(settings)


def test_retained_upstream_and_native_output_fixtures():
    manifest = json.loads((FIXTURES / 'athena-ssrl-fixtures.json').read_text())
    for row in [*manifest['files'], *manifest['references']]:
        data = (FIXTURES / row['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == row['sha256']
        if 'git_blob_sha1' in row:
            assert len(data) == row['bytes']
            assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == row['git_blob_sha1']
        else:
            assert list(oracle(row['reader']).shape) == row['shape']
            browser = (FIXTURES / row['browser_file']).read_bytes()
            assert hashlib.sha256(browser).hexdigest() == row['browser_sha256']
            np.testing.assert_array_equal(json.loads(gzip.decompress(browser)), oracle(row['reader']))


@pytest.mark.parametrize('name', READERS)
def test_every_converted_value_matches_native_perl_and_actual_larch(tmp_path, name):
    data = raw(name); result = prepare(data)
    target = tmp_path / 'converted.dat'; target.write_bytes(result.data)
    group = read_ascii(str(target))
    np.testing.assert_array_equal(group.data.T, oracle(name))
    assert data == raw(name)
    assert result.metadata['source_sha256'] == hashlib.sha256(data).hexdigest()
    assert result.metadata['converted_sha256'] == hashlib.sha256(result.data).hexdigest()
    assert result.metadata['conversion']['offsets_applied'] is False
    if name == 'SSRLmicro':
        assert len(result.metadata['conversion']['source_columns']) == 69
        assert len(result.metadata['conversion']['omitted_column_indices']) == 32
        assert len(group.array_labels) == 37 and all('icr' not in label.lower() for label in group.array_labels)
        assert 's1_32' in group.array_labels
    elif name == 'SSRLB':
        assert result.metadata['conversion']['trailing_padding_bytes'] == 160
        assert result.metadata['binary'] is True


@pytest.mark.parametrize('name', READERS)
@pytest.mark.parametrize('mode', ['transmission', 'fluorescence'])
def test_actual_preview_import_exchange_and_downloads(tmp_path, name, mode):
    store = enabled_store(tmp_path); project = store.create(); data = raw(name)
    inspected = store.inspect(project['id'], data, 'renamed.xdi')
    expected = oracle(name)
    assert inspected['row_count'] == len(expected)
    assert inspected['file_plugin']['id'] == name
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], **inspected['plugin_suggestions'][mode])
    if name == 'SSRLmicro' and mode == 'transmission':
        # Real fixture records no I1 counts. The native default must be
        # recoverable by choosing the actual fluorescence channels.
        with pytest.raises(WebInputError): store.preview_columns(project['id'], request)
        with pytest.raises(WebInputError): store.import_data(project['id'], request)
        assert store.load(project['id']) == project
        return
    num, den = ((2, 3) if name == 'SSRLmicro' else (3, 4)) if mode == 'transmission' else (5, 2 if name == 'SSRLmicro' else 3)
    signal = expected[:, num] / expected[:, den]
    if mode == 'transmission': signal = np.log(np.abs(signal))
    preview = store.preview_columns(project['id'], request)
    np.testing.assert_array_equal(preview['traces'][0]['x'], expected[:, 0])
    np.testing.assert_array_equal(preview['traces'][0]['y'], signal)
    assert store.load(project['id']) == project
    imported = store.import_data(project['id'], request); group = imported['groups'][0]
    np.testing.assert_array_equal(group['energy'], expected[:, 0])
    np.testing.assert_array_equal(group['mu'], signal)
    if mode == 'fluorescence' and name != 'SSRLmicro':
        # These two fixtures use TRANS.DET: I2 is a transmitted/reference
        # detector, so the plugin's optional ratio is not an absorption step.
        assert 'edge step is not positive' in group['processing_error']
        assert group['result'] is None
    else:
        assert group['processing_error'] is None
        for key in ['norm', 'chi', 'chir_mag', 'chiq_mag']:
            assert len(group['result']['arrays'][key]) > 10
    assert group['source']['file_plugin'] == inspected['file_plugin']
    for i in range(expected.shape[1]):
        np.testing.assert_array_equal(group['source']['column_arrays'][f'column_{i+1:04d}'], expected[:, i])
    assert AthenaStore(store.settings).load(project['id']) == imported
    assert store.inspected_file(project['id'], inspected['upload_id'], 'source') == (data, 'renamed.xdi')
    for format in ['json', 'prj']:
        exported = store.export_project(project['id'], format)
        restored = store.restore(store.create()['id'], 0, exported, 'exchange.' + format)['groups'][0]
        assert restored['energy'] == group['energy'] and restored['mu'] == group['mu']
        assert restored['source'] == group['source']
    assert store.command(project['id'], Command(version=imported['version'], action='undo'))['groups'] == []


def test_micro_fluorescence_sum_and_individual_channels_keep_original_detector_data(tmp_path):
    s = enabled_store(tmp_path); p = s.create(); inspected = s.inspect(p['id'], raw('SSRLmicro'), 'scan.dat')
    options = dict(inspected['plugin_suggestions']['fluorescence'], numerator=[c['column_id'] for c in inspected['columns'][5:]])
    req = ImportRequest(version=0, upload_id=inspected['upload_id'], **options)
    measured = oracle('SSRLmicro'); expected = np.sum(measured[:, 5:], axis=1) / measured[:, 2]
    np.testing.assert_array_equal(s.preview_columns(p['id'], req)['traces'][0]['y'], expected)
    group = s.import_data(p['id'], req)['groups'][0]
    np.testing.assert_array_equal(group['mu'], expected)
    # Independent-channel mode is the same 32 original SCA arrays, before
    # division, with no automatic deadtime correction or ICR substitution.
    preview = s.preview_columns(p['id'], req.model_copy(update={'version': 1, 'individual_channels': True}))
    assert len(preview['traces']) == 32
    for i, trace in enumerate(preview['traces']):
        np.testing.assert_array_equal(trace['y'], measured[:, i + 5] / measured[:, 2])


@pytest.mark.parametrize('name', READERS)
def test_registry_and_http_original_binary_or_text_and_conversion(tmp_path, name):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as c:
        p = c.post('/api/athena/projects').json(); url = f'/api/athena/projects/{p["id"]}'
        data = raw(name); before = c.get(url).json()
        files = {'file': ('source.dat', data)}
        disabled = c.post(url + '/inspect', files=files)
        assert disabled.status_code == 400 and disabled.json()['error']['code'] == 'file_plugin_disabled'
        assert c.get(url).json() == before
        state = c.put('/api/athena/preferences/plugins', json={'version': 0, 'enabled': {'Demeter::Plugins::' + name: True}})
        assert state.status_code == 200
        response = c.post(url + '/inspect', files=files)
        assert response.status_code == 200, response.text
        inspected = response.json(); source_url = url + '/uploads/' + inspected['upload_id'] + '/file'
        assert c.get(source_url).content == data
        assert c.get(source_url + '?variant=converted').content == prepare(data).data
        if name == 'SSRLB':
            assert inspected['source_preview_format'] == 'hex'
            assert inspected['source_preview'].startswith('00000000  53 53 52 4c')
            assert len(inspected['source_preview'].splitlines()) == 32
            assert inspected['source_preview_truncated']


@pytest.mark.parametrize('name', READERS)
def test_resource_limits_apply_before_processing(tmp_path, name):
    data = raw(name); shape = oracle(name).shape
    for limits, code in [({'max_bytes': len(data)-1}, 'upload_too_large'),
                         ({'max_points': shape[0]-1}, 'upload_too_many_points'),
                         ({'max_columns': shape[1]-1}, 'upload_too_many_columns')]:
        with pytest.raises(WebInputError) as e: prepare(data, **limits)
        assert e.value.code == code
    assert prepare(data, max_points=shape[0], max_columns=shape[1])


@pytest.mark.parametrize('name', ['SSRLA', 'SSRLmicro'])
@pytest.mark.parametrize('position', [0, 100, -1])
@pytest.mark.parametrize('damage', ['broken', '# skipped?', '1 2 3', 'nan'])
def test_ascii_damaged_rows_are_not_skipped_even_in_omitted_icr(name, position, damage):
    lines = raw(name).decode().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'Data:') + 1
    start = next(i for i in range(start, len(lines)) if not lines[i].strip()) + 1
    index = start + position if position >= 0 else position
    if damage == 'nan':
        values = lines[index].split(); values[-1] = damage; lines[index] = ' '.join(values)
    else: lines[index] = damage
    with pytest.raises(WebInputError): prepare('\n'.join(lines).encode())


def test_ascii_native_zero_energy_rule_and_robl_latin1_header():
    data = raw('SSRLA') + b'\n0 0 0 0 0 0\n'
    converted = prepare(data.replace(b'Sun May', b'ROBL \xa9 \xb0 Sun May', 1))
    assert b'ROBL (c) deg' in converted.data
    assert converted.metadata['conversion']['omitted_energy_rows'] == [456]
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.data.decode())), oracle('SSRLA'))
    # The native threshold applies to achieved energy, not requested energy.
    lines = raw('SSRLA').splitlines(); i = 26
    fields = lines[i].split(); fields[2] = b'.0009'; lines[i] = b' '.join(fields)
    converted = prepare(b'\n'.join(lines))
    assert converted.metadata['conversion']['omitted_energy_rows'] == [1]


def test_micro_layout_with_only_i0_and_icr_has_no_out_of_range_suggestion(tmp_path):
    data = b'SSRL MicroEXAFS Data Collector 1.0\nData:\nReal Time Clock\nRequested Energy\nI0\nICR.1\n\n1 1000 20 30\n1 1001 21 32\n'
    s = enabled_store(tmp_path); p = s.create(); inspected = s.inspect(p['id'], data, 'short.dat')
    assert len(inspected['columns']) == 3
    assert inspected['plugin_suggestions'] == {}


@pytest.mark.parametrize('name', ['SSRLA', 'SSRLmicro'])
def test_converted_ascii_offsets_follow_retained_column_order_without_changing_counts(name):
    lines = raw(name).decode().splitlines()
    offset = next(i for i, line in enumerate(lines) if line.strip() == 'Offsets:') + 1
    # Construct a complete offset table: the public micro fixture has only
    # 67 offsets for its 69 labels, which must stay as source diagnostics.
    count = 69 if name == 'SSRLmicro' else 6
    lines[offset] = ' '.join(str(i) for i in range(count))
    converted = prepare('\n'.join(lines).encode())
    header = converted.data.decode().splitlines(); index = next(i for i, line in enumerate(header) if line.strip() == '# Offsets:') + 1
    assert [int(v) for v in header[index].removeprefix('# ').split()] == converted.metadata['conversion']['source_column_indices']
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.data.decode())), oracle(name))


def test_binary_legacy_offset_diagnostics_do_not_invalidate_real_observations():
    # Native reads these VAX-order diagnostics as IEEE without conversion.
    # They may be nonfinite under that interpretation, but are never applied.
    data = bytearray(raw('SSRLB')); data[800:804] = struct.pack('<f', float('nan'))
    converted = prepare(bytes(data))
    assert b'# Offsets: nan' in converted.data
    np.testing.assert_array_equal(np.loadtxt(StringIO(converted.data.decode())), oracle('SSRLB'))


@pytest.mark.parametrize('cut', [0, 39, 799, 900, 1000, 16223])
def test_binary_truncation_never_yields_partial_observations(cut):
    data = raw('SSRLB')[:cut]
    # Short signatures may no longer recognize a plugin; ordinary parsing
    # will reject those. Once recognized, the converter must reject truncation.
    if cut < 80: assert prepare(data) is None
    else:
        with pytest.raises(WebInputError): prepare(data)


@pytest.mark.parametrize('offset,replacement', [(80, b'PTS: -1 COLS: 6'), (968, struct.pack('<I', 634)),
                                               (984, b'\x80\x7f\0\0'), (16224, b'X')])
def test_binary_malformed_counts_nonfinite_and_nonzero_tail_reject(offset, replacement):
    data = bytearray(raw('SSRLB')); data[offset:offset+len(replacement)] = replacement
    with pytest.raises(WebInputError): prepare(bytes(data))


def test_constructed_version_2_ieee_encoding_of_the_measured_legacy_acquisition():
    data = bytearray(raw('SSRLB'))
    data[:40] = data[:40].replace(b'1.1', b'2.0')
    for i in range(984, 16224, 4):
        source = data[i:i+4]; value = struct.unpack('<f', source[2:4]+source[:2])[0]/4
        data[i:i+4] = struct.pack('<f', value)
    prepared = prepare(bytes(data))
    np.testing.assert_array_equal(np.loadtxt(StringIO(prepared.data.decode())), oracle('SSRLB'))
    assert prepared.metadata['conversion']['collector_version'] == '2.0'
    assert not prepared.metadata['conversion']['legacy_word_swap']
