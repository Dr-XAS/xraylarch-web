"""Native SPEC scan splitting, scalar preservation and staged import transactions."""
from io import StringIO
from pathlib import Path
import gzip
import hashlib
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch.io import read_ascii

from xraylarch_web.athena import AthenaStore, ImportRequest, Command
from xraylarch_web.athena_file_plugins import prepare_file, PreparedCollection
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
SPEC = 'Demeter::Plugins::SPEC'


def raw():
    return (FIXTURES / 'demeter-snbl.dat').read_bytes()


def native():
    return [np.asarray(s['columns']) for s in json.loads(gzip.decompress((FIXTURES / 'athena-spec-native.json.gz').read_bytes()))['scans']]


def prepare(data, **limits):
    return prepare_file(data, **(dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | limits))


def store(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(PluginRegistry(enabled={SPEC: True}))
    return AthenaStore(settings)


def request(inspection, version=0, **options):
    return ImportRequest(version=version, upload_id=inspection['upload_id'], **(inspection['athena_suggestion'] | options))


def test_source_and_native_reference_hashes():
    manifest = json.loads((FIXTURES / 'athena-spec-fixture.json').read_text())
    for item in (manifest['file'], manifest['reference']):
        data = (FIXTURES / item['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
    item = manifest['file']; data = raw()
    assert len(data) == item['bytes']
    assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == item['git_blob_sha1']


def test_all_24516_values_match_executed_native_converter_and_direct_larch(tmp_path):
    collection = prepare(raw()); assert isinstance(collection, PreparedCollection)
    assert collection.metadata['total_points'] == 1362
    assert collection.metadata['scan_count'] == 2
    for i, (scan, expected) in enumerate(zip(collection.scans, native(), strict=True)):
        converted = tmp_path / f'scan-{i}.dat'; converted.write_bytes(scan.data)
        actual = read_ascii(str(converted)).data.T
        np.testing.assert_array_equal(actual, expected)
        assert scan.metadata['scan']['number'] == str(i + 1)
        assert scan.metadata['source_sha256'] == hashlib.sha256(raw()).hexdigest()
    # Column 13 in this real file is a constant counter, not energy.
    assert np.ptp(native()[0][:, 12]) == 0


@pytest.mark.parametrize('filename', ['snbl.spec', 'renamed.csv', 'scan.xdi'])
def test_staging_suggests_labelled_energy_and_stores_original_once(tmp_path, filename):
    s = store(tmp_path); p = s.create(); result = s.inspect(p['id'], raw(), filename)
    assert result['kind'] == 'scan_list' and len(result['scans']) == 2
    workspace = s.storage.workspace_dir(p['id'])
    originals = list(workspace.glob('*.source'))
    assert len(originals) == 1 and originals[0].read_bytes() == raw()
    assert s.load(p['id']) == p
    for i, scan in enumerate(result['scans']):
        assert scan['row_count'] == (456 if i == 0 else 906)
        assert scan['athena_suggestion']['energy_column'] == 'column_0016'
        assert scan['athena_suggestion']['units'] == 'keV'
        assert scan['column_units']['column_0016'] == 'keV'
        assert s.inspected_file(p['id'], scan['upload_id'], 'source') == (raw(), filename)
        assert s.inspected_columns(p['id'], scan['upload_id']) == json.loads(json.dumps(scan))
        expected = native()[i]
        trace = s.preview_columns(p['id'], request(scan))['traces'][0]
        np.testing.assert_array_equal(trace['x'], expected[:, 15] * 1000)
        np.testing.assert_array_equal(trace['y'], np.log(expected[:, 7] / expected[:, 9]))


def test_corrected_polarity_two_scans_full_larch_processing_restart_and_exchange(tmp_path):
    s = store(tmp_path); p = s.create(); scans = s.inspect(p['id'], raw(), 'GeO2.spec')['scans']
    for i, scan in enumerate(scans):
        before = p; req = request(scan, p['version'], invert=True)
        trace = s.preview_columns(p['id'], req)['traces'][0]
        assert s.load(p['id']) == before
        p = s.import_data(p['id'], req); g = p['groups'][-1]
        assert g['energy'] == trace['x'] and g['mu'] == trace['y']
        np.testing.assert_array_equal(g['mu'], -np.log(native()[i][:, 7] / native()[i][:, 9]))
        assert g['processing_error'] is None
        for key in ('norm', 'chi', 'chir_mag', 'chiq_mag'): assert len(g['result']['arrays'][key]) > 10
        assert g['source']['file_plugin']['scan']['number'] == str(i+1)
        for j in range(18):
            np.testing.assert_array_equal(g['source']['column_arrays'][f'column_{j+1:04d}'], native()[i][:, j])
    assert p['version'] == 2 and len(p['groups']) == 2
    assert AthenaStore(s.settings).load(p['id']) == p
    for kind in ['json', 'prj']:
        restored = s.restore(s.create()['id'], 0, s.export_project(p['id'], kind), 'scans.' + kind)
        for old, new in zip(p['groups'], restored['groups'], strict=True):
            assert old['source'] == new['source'] and old['mu'] == new['mu'] and old['energy'] == new['energy']
    undone = s.command(p['id'], Command(version=p['version'], action='undo'))
    assert len(undone['groups']) == 1 and undone['groups'][0]['source'] == p['groups'][0]['source']
    redone = s.command(p['id'], Command(version=undone['version'], action='redo'))
    assert [g['source'] for g in redone['groups']] == [g['source'] for g in p['groups']]


def test_native_detector_ratio_is_not_implicitly_inverted(tmp_path):
    s = store(tmp_path); p = s.create(); scan = s.inspect(p['id'], raw(), 'snbl.dat')['scans'][0]
    p = s.import_data(p['id'], request(scan)); g = p['groups'][0]
    assert 'edge step is not positive' in g['processing_error'] and g['result'] is None
    np.testing.assert_array_equal(g['mu'], np.log(native()[0][:, 7] / native()[0][:, 9]))


def test_staged_choices_refresh_after_first_import_and_do_not_need_reader_enabled(tmp_path):
    s = store(tmp_path); p = s.create(); scans = s.inspect(p['id'], raw(), 'snbl.dat')['scans']
    assert 'remembered_columns' not in scans[1]
    s.import_data(p['id'], request(scans[0], invert=True))
    prefs = AthenaPreferences(s.settings); prefs.save_plugins(PluginRegistry(version=1, enabled={SPEC: False}))
    restarted = AthenaStore(s.settings); second = restarted.inspected_columns(p['id'], scans[1]['upload_id'])
    assert second['remembered_columns']['matching_columns']
    assert second['remembered_columns']['mapping']['invert']
    assert second['remembered_columns']['mapping']['energy_column'] == 'column_0016'
    p = restarted.import_data(p['id'], request(second, version=1, invert=True))
    assert p['groups'][1]['processing_error'] is None
    with pytest.raises(WebInputError): restarted.inspect(p['id'], raw(), 'again.dat')


@pytest.mark.parametrize('position', ['first', 'middle', 'last'])
@pytest.mark.parametrize('bad', [b'broken', b'1 2', b'nan', b'1e309'])
def test_damaged_second_scan_never_stages_a_partial_first_scan(tmp_path, position, bad):
    lines = raw().splitlines(); second = next(i for i, line in enumerate(lines) if line.startswith(b'#S 2'))
    numeric = [i for i in range(second, len(lines)) if lines[i] and not lines[i].startswith(b'#')]
    index = numeric[0 if position == 'first' else len(numeric)//2 if position == 'middle' else -1]
    if bad in (b'nan', b'1e309'):
        row = lines[index].split(); row[-1] = bad; lines[index] = b' '.join(row)
    else: lines[index] = bad
    s = store(tmp_path); p = s.create(); before = set(s.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError): s.inspect(p['id'], b'\n'.join(lines), 'bad.spec')
    assert s.load(p['id']) == p and set(s.storage.workspace_dir(p['id']).iterdir()) == before


def test_failed_second_scan_disk_write_cleans_only_this_staged_collection(tmp_path, monkeypatch):
    s = store(tmp_path); p = s.create(); existing = s.inspect(p['id'], raw(), 'before.spec')
    before = set(s.storage.workspace_dir(p['id']).iterdir()); write = s.storage.write_arrays; count = 0
    def fail_second(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 2: raise OSError('test disk full')
        return write(*args, **kwargs)
    monkeypatch.setattr(s.storage, 'write_arrays', fail_second)
    with pytest.raises(OSError): s.inspect(p['id'], raw(), 'failed.spec')
    assert set(s.storage.workspace_dir(p['id']).iterdir()) == before
    assert s.inspected_file(p['id'], existing['scans'][0]['upload_id'], 'source')[0] == raw()


@pytest.mark.parametrize('option,limit,code', [('max_points', 1361, 'upload_too_many_points'),
    ('max_columns', 17, 'upload_too_many_columns'), ('max_bytes', 118014, 'upload_too_large')])
def test_limits_cover_the_entire_source_not_only_one_scan(option, limit, code):
    with pytest.raises(WebInputError) as e: prepare(raw(), **{option: limit})
    assert e.value.code == code
    assert prepare(raw(), max_points=1362, max_columns=18, max_bytes=len(raw()))


def test_duplicate_numbers_are_distinct_entries_and_other_scans_are_reported():
    data = raw().replace(b'#S 2 ', b'#S 1 ')
    data += b'\n#S 3 ascan motor 1 2 1 1\n#N 2\n#L motor  counts\n1 2\n2 3\n#S 4 zapline mono 1 2 3 4\n#C Scan aborted without data\n'
    collection = prepare(data)
    assert [s.metadata['scan']['number'] for s in collection.scans] == ['1', '1']
    assert [s.metadata['scan']['ordinal'] for s in collection.scans] == [1, 2]
    assert [s['number'] for s in collection.metadata['skipped_scans']] == ['3', '4']
    assert collection.metadata['total_points'] == 1362
    for scan, expected in zip(collection.scans, native(), strict=True):
        np.testing.assert_array_equal(np.loadtxt(StringIO(scan.data.decode())), expected)


@pytest.mark.parametrize('change', ['missing_labels', 'missing_count', 'wrong_count', 'binary', 'overflow'])
def test_malformed_structure_is_explicit(change):
    data = raw()
    if change == 'missing_labels': data = data.replace(b'#L ', b'#C ', 1)
    elif change == 'missing_count': data = data.replace(b'#N 18', b'#C 18', 1)
    elif change == 'wrong_count': data = data.replace(b'#N 18', b'#N 17', 1)
    elif change == 'binary': data += b'\0'
    else: data = data.replace(b'11131 ', b'1e308 ', 1)
    with pytest.raises(WebInputError): prepare(data)


def test_real_http_collection_stage_reload_subset_preview_and_import(tmp_path):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as c:
        p = c.post('/api/athena/projects').json(); base = f'/api/athena/projects/{p["id"]}'
        assert c.post(base+'/inspect', files={'file':('input.spec', raw())}).status_code == 400
        c.put('/api/athena/preferences/plugins', json={'version':0, 'enabled':{SPEC:True}})
        response = c.post(base+'/inspect', files={'file':('input.spec', raw())})
        assert response.status_code == 200, response.text
        collection = response.json(); scan = collection['scans'][1]
        url = base+'/uploads/'+scan['upload_id']
        assert c.get(url+'/inspection').json() == scan
        assert c.get(url+'/file').content == raw()
        payload = request(scan, invert=True).model_dump()
        preview = c.post(base+'/preview-columns', json=payload)
        assert preview.status_code == 200
        imported = c.post(base+'/import', json=payload)
        assert imported.status_code == 200 and len(imported.json()['groups']) == 1
        assert imported.json()['groups'][0]['source']['file_plugin']['scan']['number'] == '2'
        other = c.post('/api/athena/projects').json()
        assert c.get(f'/api/athena/projects/{other["id"]}/uploads/{scan["upload_id"]}/inspection').status_code == 400
        assert c.get(f'/api/athena/projects/{other["id"]}/uploads/{scan["upload_id"]}/file').status_code == 400
