"""Measured native file-plugin inputs, full-row oracles and import exchange."""
from io import StringIO
import hashlib
import json
from pathlib import Path
import re

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch.io import read_ascii

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_file_plugins import prepare_file, plugin_catalog
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'


def enabled_store(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(PluginRegistry(enabled={p['id']: True for p in plugin_catalog()}))
    return AthenaStore(settings)


def raw_file(name):
    return (FIXTURES / f'demeter-{name}.dat').read_bytes()


def rows(name):
    lines = raw_file(name).replace(b'\0', b'').decode().splitlines()
    start = next(i for i, line in enumerate(lines) if 'DATA START' in line) + 1 if name == 'x10c' else 7
    return np.loadtxt(StringIO('\n'.join(re.sub(r'(?<=[0-9])-(?=\d+\.\d+E)', ' -', line)
                                        for line in lines[start:])))


def expected(name):
    values = rows(name).copy()
    if name == 'lytle':
        # Independently vectorized native-energy oracle. The native writer
        # emits six significant digits, using the pinned HC and R2D values.
        energy = 12398.61 / (3.84034 * np.sin(values[:, 0] / (4000 * 57.29577951)))
        values[:, 0] = [float(f'{e:.6g}') for e in energy]
    return values


def prepare(data, **limits):
    return prepare_file(data, **dict(max_bytes=50_000_000, max_points=250_000, max_columns=64) | limits)


def test_fixtures_match_pinned_upstream_hashes():
    for item in json.loads((FIXTURES / 'athena-file-plugin-fixtures.json').read_text())['files']:
        data = (FIXTURES / item['file']).read_bytes()
        assert len(data) == item['bytes']
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == item['git_blob_sha1']


@pytest.mark.parametrize('name,count,columns', [('x10c', 547, 8), ('lytle', 480, 5)])
def test_converted_file_matches_every_measured_row_and_direct_larch(tmp_path, name, count, columns):
    data = raw_file(name); original = bytes(data); prepared = prepare(data)
    path = tmp_path / 'converted.dat'; path.write_bytes(prepared.data)
    direct = read_ascii(str(path))
    assert direct.data.shape == (columns, count)
    np.testing.assert_array_equal(direct.data.T, expected(name))
    assert data == original
    assert prepared.metadata['source_sha256'] == hashlib.sha256(data).hexdigest()
    assert prepared.metadata['converted_sha256'] == hashlib.sha256(prepared.data).hexdigest()
    if name == 'x10c':
        assert np.count_nonzero(direct.data[4] < 0) == 446
        assert direct.data[4, 0] == -1


@pytest.mark.parametrize('name', ['x10c', 'lytle'])
@pytest.mark.parametrize('filename', ['renamed.dat', 'beamline.csv', 'beamline.xdi'])
def test_source_recognition_precedes_extension_and_import_preview_matches_counts(tmp_path, name, filename):
    s = enabled_store(tmp_path); p = s.create()
    data = raw_file(name); i = s.inspect(p['id'], data, filename)
    assert i['display_name'] == filename and i['file_plugin']['id'].lower() == name
    req = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
    numerator, denominator = (3, 5) if name == 'x10c' else (1, 2)
    values = expected(name); mu = np.log(values[:, numerator] / values[:, denominator])
    preview = s.preview_columns(p['id'], req)
    assert s.load(p['id']) == p
    np.testing.assert_array_equal(preview['traces'][0]['x'], values[:, 0])
    np.testing.assert_array_equal(preview['traces'][0]['y'], mu)
    imported = s.import_data(p['id'], req); g = imported['groups'][0]
    assert g['processing_error'] is None
    assert g['source']['file_plugin'] == i['file_plugin']
    np.testing.assert_array_equal(g['energy'], values[:, 0])
    np.testing.assert_array_equal(g['mu'], mu)
    for j in range(values.shape[1]):
        np.testing.assert_array_equal(g['source']['column_arrays'][f'column_{j+1:04d}'], values[:, j])
    for key in ('norm', 'chi', 'chir_mag', 'chiq_mag'):
        assert len(g['result']['arrays'][key]) > 10
    restart = AthenaStore(s.settings)
    assert restart.load(p['id']) == imported
    assert restart.inspected_file(p['id'], i['upload_id'], 'source') == (data, filename)
    remembered = restart.inspect(p['id'], data, 'again.dat')['remembered_columns']['mapping']
    assert remembered['numerator'] == req.numerator and remembered['denominator'] == req.denominator
    for format in ('json', 'prj'):
        exported = s.export_project(p['id'], format)
        dest = s.create(); restored = s.restore(dest['id'], 0, exported, 'native.' + format)['groups'][0]
        assert restored['source'] == g['source'] and restored['energy'] == g['energy'] and restored['mu'] == g['mu']
    undone = s.command(p['id'], Command(version=imported['version'], action='undo'))
    assert undone['groups'] == []
    assert s.inspected_file(p['id'], i['upload_id'], 'source')[0] == data


@pytest.mark.parametrize('name', ['x10c', 'lytle'])
@pytest.mark.parametrize('position', [0, 100, -1])
@pytest.mark.parametrize('bad', ['broken', '# damaged observation', '1 2', 'nan 2 3 4 5'])
def test_damaged_observations_are_not_swallowed_as_headers(name, position, bad):
    lines = raw_file(name).splitlines()
    boundary = next(i for i, line in enumerate(lines) if b'DATA START' in line) + 1 if name == 'x10c' else 7
    index = position if position < 0 else boundary + position
    lines[index] = bad.encode()
    with pytest.raises(WebInputError): prepare(b'\n'.join(lines))


@pytest.mark.parametrize('name,count,columns', [('x10c', 547, 8), ('lytle', 480, 5)])
def test_limits_apply_to_original_bytes_and_all_converted_observations(name, count, columns):
    data = raw_file(name)
    for limits, code in [({'max_bytes': len(data)-1}, 'upload_too_large'),
                         ({'max_points': count-1}, 'upload_too_many_points'),
                         ({'max_columns': columns-1}, 'upload_too_many_columns')]:
        with pytest.raises(WebInputError) as err: prepare(data, **limits)
        assert err.value.code == code
    assert prepare(data, max_points=count, max_columns=columns)


@pytest.mark.parametrize('index,value', [(4, '0'), (4, '-1'), (4, 'nan'), (5, '0'), (5, 'inf'), (5, 'unknown')])
def test_lytle_invalid_monochromator_parameters_reject(index, value):
    lines = raw_file('lytle').decode().splitlines(); fields = lines[1].split(); fields[index] = value
    lines[1] = ' '.join(fields)
    with pytest.raises(WebInputError, match='DSPACE and STPDEG'): prepare('\n'.join(lines).encode())


@pytest.mark.parametrize('encoder', ['0', '-1', '360000'])
def test_lytle_impossible_bragg_angle_rejects(encoder):
    lines = raw_file('lytle').decode().splitlines(); fields = lines[7].split(); fields[0] = encoder
    lines[7] = ' '.join(fields)
    with pytest.raises(WebInputError, match='Bragg angles'): prepare('\n'.join(lines).encode())


def test_lytle_joined_negative_count_keeps_its_sign():
    data = raw_file('lytle').replace(b'2.17205E+05 1.49807E+04', b'2.17205E+05-1.49807E+04', 1)
    assert b'2.17205E+05 -1.49807E+04' in prepare(data).data


def test_x10c_requires_one_actual_data_boundary():
    data = raw_file('x10c')
    for changed in (data.replace(b'DATA START', b'MISSING'), data + b'\n DATA START\n'):
        with pytest.raises(WebInputError, match='DATA START'): prepare(changed)


def test_nonmatching_input_is_not_transformed():
    assert prepare(b'# energy mu\n1 2\n') is None
    assert prepare(b'\x00generic binary\n') is None


@pytest.mark.parametrize('name', ['x10c', 'lytle'])
def test_real_http_inspection_and_byte_identical_downloads(tmp_path, name):
    store = enabled_store(tmp_path)
    with TestClient(create_app(store.settings)) as client:
        p = client.post('/api/athena/projects').json(); base = f'/api/athena/projects/{p["id"]}'
        data = raw_file(name)
        response = client.post(base + '/inspect', files={'file': (name+'.dat', data)})
        assert response.status_code == 200
        i = response.json(); file = base + f'/uploads/{i["upload_id"]}/file'
        original = client.get(file); assert original.status_code == 200 and original.content == data
        assert f'filename="{name}.dat"' in original.headers['content-disposition']
        converted = client.get(file+'?variant=converted')
        assert converted.status_code == 200
        assert hashlib.sha256(converted.content).hexdigest() == i['file_plugin']['converted_sha256']
        assert client.get(file+'?variant=other').status_code == 422
        other = client.post('/api/athena/projects').json()
        assert client.get(file.replace(p['id'], other['id'])).status_code == 400
        assert client.get(base).json()['version'] == 0


def test_generic_original_download_and_unavailable_conversion(tmp_path):
    s=AthenaStore(Settings(data_root=tmp_path)); p=s.create(); data=b'# energy mu\n1 2\n2 3\n'
    i=s.inspect(p['id'],data,'../data.dat')
    assert 'file_plugin' not in i
    assert s.inspected_file(p['id'],i['upload_id'],'source')==(data,'data.dat')
    with pytest.raises(WebInputError,match='unavailable'): s.inspected_file(p['id'],i['upload_id'],'converted')
