import copy
import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, ImportRequest, Command
from xraylarch_web.athena_preferences import AthenaPreferences, RebinDefaults, RebinGrid
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def data(arrays, labels='energy i0 it det det ref'):
    x, y = arrays
    return ('# ' + labels + '\n' + '\n'.join(' '.join(map(str, row)) for row in
            zip(x, np.full(len(x), 10000), 10000 * np.exp(-y), y * 10000, y * 5000, np.exp(-y) * 10000))).encode()


@pytest.fixture
def store(tmp_path): return AthenaStore(Settings(data_root=tmp_path))


def request(p, inspection, **extra):
    ids = [c['column_id'] for c in inspection['columns']]
    values = {'version': p['version'], 'upload_id': inspection['upload_id'], 'energy_column': ids[0],
              'numerator': [ids[3], ids[4]], 'denominator': [ids[1], ids[2]], 'mode': 'fluorescence',
              'data_type': 'xanes', **extra}
    for key in ('reference_numerator', 'reference_denominator'):
        if isinstance(values.get(key), str) and values[key].startswith('col_'):
            values[key] = ids[int(values[key][4:])]
    return ImportRequest(**values)


def import_one(store, arrays, **extra):
    p = store.create(); inspected = store.inspect(p['id'], data(arrays), 'detectors.dat')
    req = request(p, inspected, **extra)
    return store.import_data(p['id'], req), inspected, req


def as_request(project, inspection):
    m = copy.deepcopy(inspection['remembered_columns']['mapping'])
    enabled = m['rebin'].pop('enabled')
    m['rebin_grid'] = {k: v for k, v in m['rebin'].items() if k != 'e0'}
    if not enabled: m['rebin'] = None
    for key in ('reference_numerator', 'reference_denominator'):
        m[key] = m[key] or None
    return ImportRequest(version=project['version'], upload_id=inspection['upload_id'], **m)


def test_full_choices_survive_store_restart_and_real_preview_import(store, xas_arrays):
    first, _, req = import_one(store, xas_arrays, reference_numerator='col_1', reference_denominator='col_5',
        reference_log=False, reference_same_element=False, signal_multiplier=-2., invert=True,
        individual_channels=True, sort=True, preprocessing={'mark': True},
        rebin={'pre': 5, 'width': 4, 'e0': 8980})
    assert len(first['groups']) == 4
    assert 'e0' not in AthenaPreferences(store.settings).read_columns().mapping['rebin']
    restarted = AthenaStore(store.settings); other = restarted.create()
    inspect = restarted.inspect(other['id'], data(xas_arrays), 'next.dat')
    memory = inspect['remembered_columns']; m = memory['mapping']
    assert memory['matching_columns'] and memory['version'] == 1
    for key in ('energy_column', 'numerator', 'denominator', 'mode', 'units', 'data_type',
                'reference_numerator', 'reference_denominator', 'reference_log', 'reference_same_element',
                'signal_multiplier', 'invert', 'individual_channels', 'sort'):
        assert m[key] == getattr(req, key)
    assert m['rebin']['enabled'] and m['rebin']['pre'] == 5 and m['rebin']['e0'] is None
    assert m['preprocessing']['mark']
    preview = restarted.preview_columns(other['id'], as_request(other, inspect))
    assert restarted.load(other['id']) == other
    second = restarted.import_data(other['id'], as_request(other, inspect))
    assert [g['marked'] for g in second['groups']] == [True, False, True, False]
    rebinned = [t for t in preview['traces'] if t.get('stage') == 'rebinned']
    for group, trace in zip(second['groups'], rebinned, strict=True):
        np.testing.assert_allclose(group['mu'], trace['y'], atol=1e-14)
    assert AthenaPreferences(store.settings).read_columns().version == 2


def test_same_labels_restore_by_position_even_for_duplicate_names_and_different_ids(store, xas_arrays):
    p, inspected, _ = import_one(store, xas_arrays)
    changed = copy.deepcopy(inspected)
    for i, column in enumerate(changed['columns']): column['column_id'] = f'new_{i}'
    restored = AthenaPreferences(store.settings).column_choices(changed, p)
    assert restored['matching_columns']
    assert restored['mapping']['numerator'] == ['new_3', 'new_4']
    assert restored['mapping']['denominator'] == ['new_1', 'new_2']


@pytest.mark.parametrize('labels', ['energy i0 it det ref det', 'energy i0 it det det reference'])
def test_different_layout_uses_guesses_and_disables_references_med_and_rebin(store, xas_arrays, labels):
    p, _, _ = import_one(store, xas_arrays, reference_numerator='col_1', reference_denominator='col_5',
        individual_channels=True, rebin={'pre': 7}, preprocessing={'mark': True}, signal_multiplier=2.)
    new = store.inspect(p['id'], data(xas_arrays, labels), 'different.dat')
    m = new['remembered_columns']['mapping']
    assert not new['remembered_columns']['matching_columns']
    assert m['numerator'] == new['athena_suggestion']['numerator']
    assert not m['reference_numerator'] and not m['reference_denominator']
    assert not m['individual_channels'] and not m['rebin']['enabled']
    assert m['rebin']['pre'] == 7 and m['preprocessing']['mark'] and m['signal_multiplier'] == 2


def test_disabled_grid_and_zero_multiplier_are_remembered_without_file_specific_e0(store, xas_arrays):
    p, _, _ = import_one(store, xas_arrays, signal_multiplier=0., rebin_grid={'emin': 0, 'pre': 7, 'width': 2})
    preferences = AthenaPreferences(store.settings)
    preferences.save(RebinDefaults(grid=RebinGrid(pre=20, width=7)))
    result = store.inspect(p['id'], data(xas_arrays), 'next.dat')['remembered_columns']['mapping']
    assert result['signal_multiplier'] == 0 and not result['rebin']['enabled']
    assert result['rebin']['pre'] == 7 and result['rebin']['emin'] == 0
    assert result['rebin']['width'] == 7  # Native width is a global preference, not a remembered region field.
    assert preferences.read()['grid']['pre'] == 20


def test_only_accepted_imports_update_memory_and_undo_does_not_rewind_it(store, xas_arrays):
    p, _, _ = import_one(store, xas_arrays)
    prefs = AthenaPreferences(store.settings); original = prefs.read_columns()
    inspected = store.inspect(p['id'], data(xas_arrays), 'cancelled.dat')
    req = request(p, inspected, signal_multiplier=3)
    store.preview_columns(p['id'], req)
    assert prefs.read_columns() == original
    invalid = req.model_copy(update={'denominator': 'missing'})
    with pytest.raises(ValueError): store.import_data(p['id'], invalid)
    assert prefs.read_columns() == original and store.load(p['id']) == p
    accepted = store.import_data(p['id'], req)
    after = prefs.read_columns(); assert after.version == original.version + 1
    with pytest.raises(ValueError): store.import_data(p['id'], req)
    store.command(p['id'], Command(version=accepted['version'], action='undo'))
    assert prefs.read_columns() == after


def test_preferences_write_failure_does_not_turn_successful_import_into_retry(store, xas_arrays, monkeypatch):
    prefs = AthenaPreferences(store.settings)
    def broken(*args, **kwargs): raise OSError('disk full')
    monkeypatch.setattr(AthenaPreferences, 'remember_columns', broken)
    p, _, _ = import_one(store, xas_arrays)
    assert p['import_preferences_warning'].startswith('Spectra imported')
    assert len(store.load(p['id'])['groups']) == 1 and prefs.read_columns() is None


def test_corrupt_memory_is_reported_and_preserved_without_blocking_preview_or_import(store, xas_arrays):
    p, _, _ = import_one(store, xas_arrays)
    prefs = AthenaPreferences(store.settings); path = prefs.storage.path(prefs.ident, 'columns.json')
    path.write_text('{broken')
    inspected = store.inspect(p['id'], data(xas_arrays), 'next.dat')
    assert 'remembered_columns' not in inspected and 'could not be read' in inspected['warnings'][-1]
    req = request(p, inspected); assert store.preview_columns(p['id'], req)['traces']
    result = store.import_data(p['id'], req)
    assert result['import_preferences_warning'] and len(result['groups']) == 2
    assert path.read_text() == '{broken'


def test_standard_restores_first_matching_name_in_list_order_and_disables_missing_or_unusable(store, xas_arrays):
    p, _, _ = import_one(store, xas_arrays)
    standard = p['groups'][0]; standard['label'] = 'Reference standard'
    p = store.save(p, store.load(p['id']), 'rename')
    inspected = store.inspect(p['id'], data(xas_arrays), 'with-standard.dat')
    p = store.import_data(p['id'], request(p, inspected, preprocessing={'standard_id': standard['id'], 'copy_parameters': True}))
    prefs = AthenaPreferences(store.settings)
    same = copy.deepcopy(p); same['groups'][0]['label'] = 'Renamed'
    renamed = prefs.column_choices(inspected, same)
    assert renamed['warnings'] and renamed['mapping']['preprocessing']['standard_id'] is None
    assert not renamed['mapping']['preprocessing']['copy_parameters']
    other = store.create(); alternate = copy.deepcopy(standard); alternate['id'] = 'other-standard'
    other['groups'] = [alternate]
    assert prefs.column_choices(inspected, other)['mapping']['preprocessing']['standard_id'] == alternate['id']
    for groups in ([alternate, standard], [standard, alternate]):
        same['groups'] = groups
        choice = prefs.column_choices(inspected, same)
        assert choice['mapping']['preprocessing']['standard_id'] == groups[0]['id']
        assert choice['mapping']['preprocessing']['copy_parameters'] and not choice['warnings']
    for invalid in ([], [{**alternate, 'processing_error': 'bad range'}],
                    [{**alternate, 'data_type': 'detector'}],
                    [{**alternate, 'processing_error': 'bad range'}, standard]):
        other['groups'] = invalid
        restored = prefs.column_choices(inspected, other)
        assert restored['warnings'] and restored['mapping']['preprocessing']['standard_id'] is None
        assert not restored['mapping']['preprocessing']['copy_parameters']


def test_memory_contains_choices_only_and_concurrent_imports_serialize(store, xas_arrays):
    targets = [store.create(), store.create()]
    inspected = [store.inspect(p['id'], data(xas_arrays), f'file{i}.dat') for i, p in enumerate(targets)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        out = list(pool.map(lambda pair: store.import_data(pair[0]['id'], request(*pair)), zip(targets, inspected)))
    assert all(len(p['groups']) == 1 for p in out)
    memory = AthenaPreferences(store.settings).read_columns().model_dump()
    assert memory['version'] == 2
    assert not {'version', 'upload_id', 'edge_policy'} & memory['mapping'].keys()
    assert all(set(c) == {'column_id', 'name'} for c in memory['columns'])


def test_http_inspection_restores_accepted_choices_after_restart(tmp_path, xas_arrays):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as client:
        p = client.post('/api/athena/projects').json()
        inspected = client.post(f"/api/athena/projects/{p['id']}/inspect", files={'file': ('first.dat', data(xas_arrays))}).json()
        req = request(p, inspected, preprocessing={'mark': True})
        response = client.post(f"/api/athena/projects/{p['id']}/import", json=req.model_dump())
        assert response.status_code == 200
    with TestClient(create_app(settings)) as client:
        inspected = client.post(f"/api/athena/projects/{p['id']}/inspect", files={'file': ('next.dat', data(xas_arrays))})
        assert inspected.status_code == 200 and inspected.json()['remembered_columns']['mapping']['preprocessing']['mark']


@pytest.mark.parametrize('dtype', ['mu', 'xanes', 'norm'])
def test_saved_type_units_and_constant_reference_are_restored(store, xas_arrays, dtype):
    x, y = xas_arrays
    p = store.create(); inspected = store.inspect(p['id'], data((x / 1000, y)), 'kev.dat')
    req = request(p, inspected, units='keV', data_type=dtype, reference_numerator='col_1', reference_denominator='1', reference_log=False)
    p = store.import_data(p['id'], req)
    next_inspection = store.inspect(p['id'], data((x / 1000, y)), 'next.dat')
    m = next_inspection['remembered_columns']['mapping']
    assert m['units'] == 'keV' and m['data_type'] == dtype and m['reference_denominator'] == '1'
    restored_request = as_request(p, next_inspection)
    before = store.preview_columns(p['id'], restored_request)
    np.testing.assert_allclose(before['traces'][0]['x'], x, atol=1e-10)


def test_saved_chi_restores_k_and_disables_absorption_controls(store):
    k = np.linspace(.1, 15, 150); chi = np.sin(k) * np.exp(-k / 10)
    content = ('# k chi\n' + '\n'.join(f'{x} {y}' for x, y in zip(k, chi))).encode()
    p = store.create(); inspected = store.inspect(p['id'], content, 'first.chi')
    ids = [c['column_id'] for c in inspected['columns']]
    p = store.import_data(p['id'], ImportRequest(version=0, upload_id=inspected['upload_id'],
        energy_column=ids[0], numerator=[ids[1]], data_type='chi', preprocessing={'mark': True}))
    next_inspection = store.inspect(p['id'], content, 'next.chi'); m = next_inspection['remembered_columns']['mapping']
    assert m['data_type'] == 'chi' and m['mode'] == 'mu' and m['units'] == 'eV'
    assert not m['reference_numerator'] and not m['reference_denominator'] and not m['rebin']['enabled']
    assert m['preprocessing'] == {'mark': True, 'standard_id': None, 'align': False, 'copy_parameters': False}
    trace = store.preview_columns(p['id'], as_request(p, next_inspection))['traces'][0]
    np.testing.assert_array_equal(trace['x'], k); np.testing.assert_array_equal(trace['y'], chi)
