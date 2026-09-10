"""Native type correction against measured copper, direct Larch, and project I/O."""
import gzip
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import pre_edge

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def workspace(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    p = store.create()
    raw = np.loadtxt(Path(__file__).parents[2] / 'examples/xafsdata/cu_rt01.xmu')
    for i, dtype in enumerate(('mu', 'xanes', 'norm')):
        g = store.make_group(dtype, raw[:, 0], raw[:, 1], data_type=dtype,
            parameters=dict(e0=8980.25, energy_shift=1.25, pre1=-150, pre2=-30, norm1=100, norm2=300, nnorm=2),
            source={'filename': 'cu_rt01.xmu', 'native': {'args': {'datatype': 'xanes', 'is_xanes': 1}},
                    'raw_arrays': {'i0': np.ones(len(raw)).tolist()}})
        g.update(marked=i != 1, frozen=i == 2, notes='retained notes', multiplier=1.7, offset=0.2)
        assert g['processing_error'] is None
        p['groups'].append(g)
    store.storage.write_json(p['id'], 'project.json', p)
    return store, p


def change(store, p, ids=None, **options):
    return store.command(p['id'], Command(version=p['version'], action='change_datatype',
        group_ids=ids if ids is not None else [g['id'] for g in p['groups']], options=options))


@pytest.mark.parametrize('source', ['mu', 'xanes', 'norm'])
@pytest.mark.parametrize('target', ['mu', 'xanes', 'norm'])
def test_current_conversion_preserves_data_and_recipe_and_matches_larch(workspace, source, target):
    store, p = workspace; old = next(g for g in p['groups'] if g['data_type'] == source)
    updated = change(store, p, [old['id']], data_type=target)
    g = store.group(updated, old['id'])
    for key in ('energy', 'mu', 'parameters', 'source', 'reference_id', 'frozen', 'marked', 'notes', 'multiplier', 'offset'):
        assert g[key] == old[key]
    assert g['data_type'] == target and g['is_normalized'] == (target == 'norm')
    assert g['processing_error'] is None
    for other in p['groups']:
        if other['id'] != old['id']: assert store.group(updated, other['id']) == other
    arrays = g['result']['arrays']; x = np.array(g['energy']) + 1.25
    if target == 'norm':
        np.testing.assert_array_equal(arrays['norm'], old['mu'])
        assert g['result']['effective']['edge_step'] == 1
    else:
        direct = Group()
        pre_edge(x, g['mu'], group=direct, e0=8980.25, pre1=-150, pre2=-30, norm1=100, norm2=300, nnorm=2)
        np.testing.assert_allclose(arrays['norm'], direct.norm, rtol=1e-12, atol=1e-12)
    assert bool(arrays['chi']) == (target != 'xanes')
    assert bool(arrays['chir_mag']) == (target != 'xanes')
    assert bool(arrays['chiq_mag']) == (target != 'xanes')
    np.testing.assert_array_equal(arrays['energy'], x)
    assert updated['version'] == p['version'] + 1


@pytest.mark.parametrize('scope', ['marked', 'all'])
def test_bulk_includes_frozen_energy_groups_skips_chi_and_feff(workspace, scope):
    store, p = workspace
    k = np.linspace(0, 15, 301)
    p['groups'].append(store.make_group('chi', k, np.sin(k), data_type='chi'))
    raw = np.loadtxt(Path(__file__).parent / 'fixtures/feff-copper-xmu.dat')
    p['groups'].append(store.make_group('FEFF', raw[:, 0], raw[:, 3], data_type='xmudat'))
    store.storage.write_json(p['id'], 'project.json', p)
    targets = [g['id'] for g in p['groups'] if scope == 'all' or g['marked']]
    updated = change(store, p, targets, data_type='xanes')
    assert len(updated['last_operation']['datatype_results']) == (3 if scope == 'all' else 2)
    assert updated['groups'][2]['frozen'] and updated['groups'][2]['data_type'] == 'xanes'
    assert updated['groups'][-2:] == p['groups'][-2:]
    assert updated['last_operation']['skipped_group_ids'] == targets[-2:]
    assert all('FEFF' in reason for reason in updated['last_operation']['skipped_reasons'].values())


@pytest.mark.parametrize('source', ['mu', 'norm'])
def test_quick_toggle_preserves_normalization_and_is_reversible(workspace, source, monkeypatch):
    store, p = workspace; g = next(g for g in p['groups'] if g['data_type'] == source)
    if source == 'norm':
        def forbidden(*args, **kwargs): pytest.fail('Normalized XANES must not fit pre_edge')
        monkeypatch.setattr('xraylarch_web.athena_science.pre_edge', forbidden)
    toggled = change(store, p, [g['id']], toggle=True); t = store.group(toggled, g['id'])
    assert t['data_type'] == 'xanes' and t['is_normalized'] == (source == 'norm')
    assert t['processing_error'] is None and t['result']['arrays']['chi'] == []
    np.testing.assert_array_equal(t['result']['arrays']['norm'], g['result']['arrays']['norm'])
    back = change(store, toggled, [g['id']], toggle=True)
    assert store.group(back, g['id']) == g


@pytest.mark.parametrize('fmt', ['json', 'prj', 'bare-prj'])
@pytest.mark.parametrize('target', ['mu', 'xanes', 'norm', 'normalized-xanes'])
def test_exchange_updates_native_flags_and_normalized_xanes(workspace, fmt, target):
    store, p = workspace
    g = p['groups'][2] if target == 'normalized-xanes' else p['groups'][0]
    options = dict(toggle=True) if target == 'normalized-xanes' else dict(data_type=target)
    p = change(store, p, [g['id']], **options); expected = store.group(p, g['id'])
    data = store.export_project(p['id'], format='json' if fmt == 'json' else 'prj')
    if fmt == 'bare-prj':
        data = '\n'.join(line for line in gzip.decompress(data).decode().splitlines() if not line.startswith('# Athena-Web ')).encode()
    new = store.create(); restored = store.restore(new['id'], new['version'], data, 'types.' + fmt)
    actual = next(group for group in restored['groups'] if group['label'] == g['label'])
    assert actual['data_type'] == expected['data_type']
    assert actual['is_normalized'] == expected['is_normalized']
    assert actual['processing_error'] is None
    np.testing.assert_allclose(actual['result']['arrays']['norm'], expected['result']['arrays']['norm'], atol=1e-10)
    assert actual['frozen'] == expected['frozen']


def test_background_chain_dormant_recipe_errors_recovery_and_undo(workspace):
    store, p = workspace
    a, b, c = p['groups']
    # A standard -> B -> C. Frozen C also receives a refreshed scientific result.
    for g in (b, c): g.update(data_type='mu', is_normalized=False)
    b['background_standard_id'] = a['id']; c['background_standard_id'] = b['id']
    a['parameters'].update(fnorm=True, nnorm=0, norm2=1000)
    store._process_groups(p, [a['id']]); store.storage.write_json(p['id'], 'project.json', p)
    changed = change(store, p, [a['id']], data_type='xanes')
    assert changed['groups'][0]['parameters']['fnorm'] is True
    assert changed['groups'][0]['result']['effective']['fnorm'] is False
    assert all(g['result'] is None and 'no usable chi' in g['processing_error'] for g in changed['groups'][1:])
    assert set(changed['last_operation']['processing_errors']) == {b['id'], c['id']}
    restored = change(store, changed, [a['id']], data_type='mu')
    assert restored['groups'] == p['groups']
    all_xanes = change(store, restored, data_type='xanes')
    assert all(g['processing_error'] is None for g in all_xanes['groups'])
    assert all_xanes['groups'][1]['background_standard_id'] == a['id']
    undone = store.command(p['id'], Command(version=all_xanes['version'], action='undo'))
    assert undone['groups'] == p['groups']
    redone = store.command(p['id'], Command(version=undone['version'], action='redo'))
    assert redone['groups'] == all_xanes['groups']


@pytest.mark.parametrize('options', [{}, {'data_type': 'chi'}, {'data_type': 'xmudat'}, {'data_type': 'detector'},
    {'data_type': 'xanes', 'unknown': 1}, {'toggle': 'yes'}, {'toggle': True, 'data_type': 'mu'}])
def test_invalid_requests_are_atomic(workspace, options):
    store, p = workspace
    with pytest.raises(WebInputError): change(store, p, **options)
    assert store.load(p['id']) == p


def test_stale_request_and_empty_selection_are_atomic(workspace):
    store, p = workspace
    with pytest.raises(WebInputError): change(store, p, [], data_type='xanes')
    changed = change(store, p, data_type='xanes')
    with pytest.raises(WebInputError): change(store, p, data_type='norm')
    assert store.load(p['id']) == changed


def test_real_http_command_returns_reprocessed_arrays(workspace):
    store, p = workspace
    with TestClient(create_app(store.settings)) as client:
        response = client.post(f'/api/athena/projects/{p["id"]}/command', json={
            'version': p['version'], 'action': 'change_datatype', 'group_ids': [p['groups'][0]['id']],
            'options': {'data_type': 'xanes'}})
    assert response.status_code == 200
    assert response.json()['groups'][0]['result']['arrays']['chi'] == []


def test_difference_identity_and_reference_calibration_survive_type_correction(workspace):
    store, p = workspace; a, b, _ = p['groups']
    a['is_difference'] = True; a['source']['operation'] = 'difference'
    a['reference_id'] = b['id']; b['reference_id'] = a['id']
    store.process(a, p); store.storage.write_json(p['id'], 'project.json', p)
    updated = change(store, p, [a['id']], data_type='xanes'); g = updated['groups'][0]
    assert g['is_difference'] and g['source'] == a['source']
    assert g['result']['arrays'] == a['result']['arrays']
    assert g['parameters'] == a['parameters']
    assert g['reference_id'] == b['id'] and updated['groups'][1] == b


def test_normalized_xanes_e0_uses_supplied_signal(workspace):
    store, p = workspace; g = p['groups'][2]; g['frozen'] = False
    store.storage.write_json(p['id'], 'project.json', p)
    p = change(store, p, [g['id']], toggle=True)
    updated = store.command(p['id'], Command(version=p['version'], action='set_e0',
        group_ids=[g['id']], options={'method': 'fraction', 'fraction': 0.5}))
    x, y = np.array(g['energy']) + g['parameters']['energy_shift'], np.array(g['mu'])
    hi = np.flatnonzero(y >= .5)[0]
    expected = x[hi-1] + (.5-y[hi-1]) * (x[hi]-x[hi-1]) / (y[hi]-y[hi-1])
    assert updated['last_operation']['e0_results'][0]['e0'] == pytest.approx(expected, abs=1e-9)
    assert store.group(updated, g['id'])['result']['arrays']['norm'] == g['mu']


def test_unsupported_only_selection_leaves_project_untouched(workspace):
    store, p = workspace; k = np.linspace(0, 15, 301)
    p['groups'] = [store.make_group('chi', k, np.sin(k), data_type='chi')]
    store.storage.write_json(p['id'], 'project.json', p)
    with pytest.raises(WebInputError, match='χ\\(k\\) and FEFF'):
        change(store, p, data_type='mu')
    assert store.load(p['id']) == p


def test_failed_science_accepts_type_and_retains_raw_for_repair(workspace):
    store, p = workspace; g = p['groups'][1]
    g['parameters']['kmax'] = 90  # dormant XANES setting; invalid for EXAFS
    store.process(g, p); store.storage.write_json(p['id'], 'project.json', p)
    updated = change(store, p, [g['id']], data_type='mu'); failed = updated['groups'][1]
    assert failed['data_type'] == 'mu' and failed['result'] is None
    assert 'kmax' in failed['processing_error']
    assert failed['energy'] == g['energy'] and failed['mu'] == g['mu']
    assert failed['parameters'] == g['parameters']
    repaired = change(store, updated, [g['id']], data_type='xanes')
    assert repaired['groups'][1] == g


@pytest.mark.parametrize('field,value', [('data_type', 'chi'), ('data_type', 'xmudat'), ('is_normalized', True), ('is_normalized', 'false')])
def test_sidecar_cannot_reinterpret_native_type_or_normalization(workspace, field, value):
    import json
    store, p = workspace
    payload = gzip.decompress(store.export_project(p['id'], 'prj')).decode()
    lines = payload.splitlines()
    for index, line in enumerate(lines):
        if line.startswith('# Athena-Web '):
            sidecar = json.loads(line.removeprefix('# Athena-Web '))
            sidecar['groups'][0][field] = value
            lines[index] = '# Athena-Web ' + json.dumps(sidecar)
    before = store.load(p['id'])
    with pytest.raises(WebInputError, match='sidecar'):
        store.restore(p['id'], p['version'], '\n'.join(lines).encode(), 'conflicting.prj')
    assert store.load(p['id']) == before
