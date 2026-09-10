"""Post-import Athena workflow against scalar native and real Larch oracles."""
import copy
import gzip
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_rebin import PostRebin, rebin_unavailable
from xraylarch_web.athena_science import process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from test_athena_import_rebin import native_grid, native_values


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def project(store, xas_arrays, *, dtype='mu', shift=0, count=1):
    x, y = xas_arrays; p = store.create()
    for i in range(count):
        g = store.make_group(f'source {i}', x, y, data_type=dtype,
            parameters={'e0': 8980 + shift, 'energy_shift': shift, 'rbkg': 1.15, 'kweight': 3},
            source={'filename': 'original.dat', 'column_order': 'group',
                    'column_arrays': {'energy': x.tolist(), 'mu': y.tolist()},
                    'raw_arrays': {'signal': (y * 1000).tolist(), 'i0': [1000.] * len(x), 'stddev': [.02] * len(x)}})
        g.update(notes='keep my measurement note', offset=.4, multiplier=2.)
        p['groups'].append(g)
    return store.save(p, store.load(p['id']), 'fixture')


def request(p, ids=None, **options):
    return Command(version=p['version'], action='rebin', group_ids=ids or [p['groups'][0]['id']], options=options)


@pytest.mark.parametrize('dtype', ['mu', 'xanes', 'norm'])
@pytest.mark.parametrize('shift', [-2.5, 0., 3.])
def test_preview_and_created_group_use_native_values_calibration_once_and_originals(store, xas_arrays, dtype, shift):
    p = project(store, xas_arrays, dtype=dtype, shift=shift); parent = copy.deepcopy(p['groups'][0])
    req = request(p, width=4)
    preview = store.preview_rebin(p['id'], req)
    assert store.load(p['id']) == p
    choice = PostRebin(**req.options); x, y = xas_arrays
    grid = native_grid(x + shift, 8980 + shift, choice)
    expected = native_values(x + shift, y, grid, 4)
    data = preview['results'][0]
    np.testing.assert_array_equal(data['traces'][0]['x'], x + shift)
    np.testing.assert_allclose(data['traces'][1]['y'], expected, atol=1e-14)
    out = store.command(p['id'], req); child = out['groups'][1]
    assert out['groups'][0] == parent and child['data_type'] == dtype
    assert child['parameters']['energy_shift'] == 0 and child['parameters']['e0'] is None
    assert child['parameters']['rbkg'] == 1.15 and child['parameters']['kweight'] == 3
    assert child['processing_error'] is None
    assert child['source']['rebin_original']['energy'] == (x + shift).tolist()
    assert child['source']['rebin_original']['column_arrays'] == parent['source']['column_arrays']
    np.testing.assert_allclose(child['mu'], expected, atol=1e-14)
    assert child['energy'] == data['traces'][1]['x']
    assert child['notes'] == parent['notes'] and child['multiplier'] == 2 and child['offset'] == .4
    assert not child['marked'] and not child['frozen'] and child['reference_id'] is None
    for fmt in ('json', 'prj'):
        other = store.create(); saved = store.export_project(p['id'], format=fmt)
        restored = store.restore(other['id'], other['version'], saved, 'saved.' + fmt)
        restored_child = restored['groups'][1]
        assert restored_child['source'] == child['source'] and rebin_unavailable(restored_child)
        np.testing.assert_allclose(restored_child['mu'], child['mu'], rtol=1e-12)
        if fmt == 'prj': assert "'rebinned', 1" in gzip.decompress(saved).decode()


def test_k_preview_uses_real_larch_processing_and_saved_background_parameters(store, xas_arrays):
    p = project(store, xas_arrays); req = request(p, plot_space='k')
    preview = store.preview_rebin(p['id'], req)['results'][0]
    out = store.command(p['id'], req); child = out['groups'][1]
    expected = process_spectrum(child['energy'], child['mu'], child['parameters'])
    assert preview['errors'] == []
    for trace, result in zip(preview['traces'], [p['groups'][0]['result'], expected], strict=True):
        np.testing.assert_array_equal(trace['x'], result['arrays']['k'])
        np.testing.assert_array_equal(trace['y'], result['arrays']['weighted_chi'])
    assert preview['kweight'] == 3


def test_batch_inserts_after_each_source_in_list_order_with_skips_and_one_undo(store, xas_arrays):
    p = project(store, xas_arrays, count=3)
    p['groups'][0]['frozen'] = True  # Deriving data does not edit the frozen source.
    p['groups'][1]['source']['native'] = {'args': {'rebinned': '1'}}
    k = np.arange(0, 14, .05); chi = store.make_group('chi', k, np.sin(k), data_type='chi')
    p['groups'].append(chi); p = store.save(p, store.load(p['id']), 'mixed')
    req = request(p, [g['id'] for g in p['groups']][::-1], skip_ineligible=True)
    preview = store.preview_rebin(p['id'], req)
    assert list(preview['skipped_reasons']) == [p['groups'][1]['id'], chi['id']]
    out = store.command(p['id'], req)
    assert [g['label'] for g in out['groups']] == ['source 0', 'source 0 rebinned', 'source 1', 'source 2', 'source 2 rebinned', 'chi']
    assert [out['groups'][i] for i in (0, 2, 3, 5)] == p['groups']
    assert not out['groups'][1]['frozen']
    assert len(out['last_operation']['rebin_results']) == 2
    undo = store.command(p['id'], Command(version=out['version'], action='undo'))
    assert undo['groups'] == p['groups']
    redo = store.command(p['id'], Command(version=undo['version'], action='redo'))
    assert redo['groups'] == out['groups']


@pytest.mark.parametrize('failure', ['grid', 'second_group', 'rebinned', 'chi', 'duplicates', 'unknown', 'too_many'])
def test_invalid_or_late_batch_failure_is_atomic(store, xas_arrays, failure):
    p = project(store, xas_arrays, count=2)
    if failure == 'second_group': p['groups'][1]['parameters']['e0'] = 1000
    if failure == 'rebinned': p['groups'][0]['source']['rebin'] = {'width': 3}
    if failure == 'chi': p['groups'][0]['data_type'] = 'chi'
    if failure == 'too_many':
        for i in range(97):
            g = copy.deepcopy(p['groups'][0]); g['id'] = f'extra{i}'; p['groups'].append(g)
    p = store.save(p, store.load(p['id']), 'invalid fixture')
    req = request(p, [g['id'] for g in p['groups'][:2]])
    if failure == 'grid': req.options = {'pre': 0}
    if failure == 'duplicates': req.group_ids *= 2
    if failure == 'unknown': req.options = {'method': 'boxcar'}
    with pytest.raises(ValueError): store.command(p['id'], req)
    assert store.load(p['id']) == p


def test_xanes_k_error_keeps_energy_preview_and_creation_available(store, xas_arrays):
    p = project(store, xas_arrays, dtype='xanes')
    preview = store.preview_rebin(p['id'], request(p, plot_space='k'))['results'][0]
    assert len(preview['errors']) == 2 and preview['traces'] == []
    assert len(store.preview_rebin(p['id'], request(p))['results'][0]['traces']) == 2
    assert store.command(p['id'], request(p))['groups'][1]['processing_error'] is None


def test_preview_rechecks_version_after_calculation(store, xas_arrays, monkeypatch):
    p = project(store, xas_arrays); old = store._rebin_results
    def changed(*args):
        result = old(*args)
        store.command(p['id'], Command(version=p['version'], action='project', options={'name': 'changed'}))
        return result
    monkeypatch.setattr(store, '_rebin_results', changed)
    with pytest.raises(ValueError, match='changed'): store.preview_rebin(p['id'], request(p))


def test_http_preview_then_create_and_stale_command(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path)); p = project(store, xas_arrays)
    with TestClient(create_app(store.settings)) as client:
        base = f"/api/athena/projects/{p['id']}"
        preview = client.post(base + '/rebin/preview', json=request(p).model_dump())
        assert preview.status_code == 200, preview.text
        result = client.post(base + '/command', json=request(p).model_dump())
        assert result.status_code == 200, result.text
        assert result.json()['groups'][1]['mu'] == preview.json()['results'][0]['traces'][1]['y']
        assert client.post(base + '/command', json=request(p).model_dump()).status_code == 409


def test_background_standard_stays_linked_and_untouched(store, xas_arrays):
    p = project(store, xas_arrays, count=2)
    p['groups'][0]['background_standard_id'] = p['groups'][1]['id']
    store.process(p['groups'][0], p)
    p = store.save(p, store.load(p['id']), 'background link')
    out = store.command(p['id'], request(p))
    assert out['groups'][0] == p['groups'][0] and out['groups'][2] == p['groups'][1]
    assert out['groups'][1]['background_standard_id'] == p['groups'][1]['id']
    assert out['groups'][1]['result']['effective']['background_standard'] is True


def test_rebinned_marker_survives_native_prj_without_web_extension(store, xas_arrays):
    p = project(store, xas_arrays); out = store.command(p['id'], request(p))
    document = gzip.decompress(store.export_project(p['id'], format='prj')).decode()
    native = '\n'.join(line for line in document.splitlines() if not line.startswith('# Athena-Web '))
    other = store.create(); restored = store.restore(other['id'], other['version'], native.encode(), 'native.prj')
    child = restored['groups'][1]
    assert str(child['source']['native']['args']['rebinned']) == '1'
    assert rebin_unavailable(child)
    np.testing.assert_allclose(child['mu'], out['groups'][1]['mu'], rtol=1e-12)
