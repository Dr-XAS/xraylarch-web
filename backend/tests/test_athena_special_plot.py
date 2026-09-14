"""Executed native panel/point comparisons and read-only Larch plot lifecycle."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import xftf, xftr

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_plot_shortcuts import ShortcutOptions, shortcut_plot
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.athena_special_plot import SpecialPlotOptions, special_plot
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIX = Path(__file__).parent / 'fixtures'
ROOT = FIX.parents[2]
NATIVE = json.loads(gzip.decompress((FIX / 'athena-special-plot-native.json.gz').read_bytes()))


def probe(raw, weight):
    a = copy.deepcopy(raw['arrays'])
    a['mu'] = a.pop('xmu')
    a['energy'] = (np.asarray(a['energy']) + raw['bkg_eshift']).tolist()
    p = AthenaParameters(energy_shift=raw['bkg_eshift'], kweight=weight, kmin=3, kmax=12, bkg_kmax=14).model_dump()
    return dict(id=raw['group'], label=raw['name'], energy=raw['arrays']['energy'], mu=a['mu'], data_type='mu',
                multiplier=raw['plot_multiplier'], offset=raw['y_offset'], parameters=p,
                result=dict(arrays=a, effective=dict(exafs=True, kweight=weight, e0=raw['bkg_e0'], bkg_kmax=14)))


@pytest.mark.parametrize('row', NATIVE['rows'], ids=lambda r: str(r['id']))
def test_original_quad_biquad_and_kq_templates_write_the_expected_curves(row):
    groups = [probe(g, row['weight']) for g in row['groups']]
    before = copy.deepcopy(groups)
    options = SpecialPlotOptions(version=0, view=row['view'], group_ids=[g['id'] for g in groups],
                                 q_component={'r': 're', 'i': 'im', 'm': 'mag'}[row['q_component']])
    got = special_plot(groups, options)
    assert groups == before
    curves = [c for p in got['panels'] for c in p['curves']]
    native = copy.deepcopy(row['native']['curves'])
    if row['view'] == 'quad':
        native[0], native[1] = native[1], native[0]  # Files: mu,bkg; plotted order: bkg,mu.
        assert row['native']['updates'] == [['g0', 'all']]
    if row['view'] == 'biquad':
        # Explicitly observe and correct the original second-axis shift bug.
        shift0, shift1 = [g['parameters']['energy_shift'] for g in groups]
        np.testing.assert_allclose(np.asarray(native[1])[:, 0], np.asarray(groups[1]['energy']) + shift0, atol=5e-11, rtol=0)
        for point in native[1]: point[0] += shift1 - shift0
        assert any('first group' in note for note in got['notes'])
        assert got['panels'][0]['x_range'] == [row['groups'][0]['bkg_e0'] - 60, row['groups'][0]['bkg_e0'] + 180]
        assert row['native']['updates'] == [['g0', 'all'], ['g1', 'all']]
    assert len(curves) == len(native)
    for c, expected in zip(curves, native):
        np.testing.assert_allclose(np.array([c['x'], c['y']]).T, expected, atol=5e-11, rtol=3e-13)


@pytest.mark.parametrize('weight', [0., 1., 1.5, 3., 4.])
def test_weight_override_recalculates_both_transforms_on_copies_with_larch(weight):
    row = next(r for r in NATIVE['rows'] if r['view'] == 'quad' and r['weight'] == 2)
    g = probe(row['groups'][0], 2)
    before = copy.deepcopy(g)
    result = special_plot([g], SpecialPlotOptions(version=0, group_ids=[g['id']], kweight=weight))
    a = g['result']['arrays']; reference = Group()
    k, chi = np.asarray(a['k']), np.asarray(a['chi'])
    xftf(k, chi * k ** weight, group=reference, kweight=0, kmin=3, kmax=12, dk=1, window='hanning', nfft=2048, kstep=.05, rmax_out=10)
    xftr(reference.r, reference.chir, group=reference, rmin=1, rmax=3, dr=0, window='hanning', nfft=2048, kstep=.05, qmax_out=k[-1])
    np.testing.assert_allclose(result['panels'][2]['curves'][0]['y'], reference.chir_mag, atol=1e-13, rtol=1e-13)
    np.testing.assert_allclose(result['panels'][3]['curves'][0]['y'], reference.chiq_re, atol=1e-13, rtol=1e-13)
    assert g == before


@pytest.fixture
def store(tmp_path): return AthenaStore(Settings(data_root=tmp_path))


def project(store):
    p = store.create()
    for raw in NATIVE['rows'][3]['groups']:
        g = store.make_group(raw['name'], raw['arrays']['energy'], raw['arrays']['xmu'])
        g['marked'] = True
        p['groups'].append(g)
    return store.save(p, store.load(p['id']), 'Measured Fe scans')


def test_http_scopes_invalid_requests_and_frozen_project_are_read_only(store):
    p = project(store)
    for g in p['groups']: g['frozen'] = True
    p = store.save(p, store.load(p['id']), 'Freeze scans')
    with TestClient(create_app(store.settings)) as client:
        url = f'/api/athena/projects/{p["id"]}/plots/special'
        options = dict(version=p['version'], group_ids=[g['id'] for g in p['groups']], view='biquad', kweight=1.5)
        response = client.post(url, json=options)
        assert response.status_code == 200, response.text
        assert len(response.json()['result']['panels']) == 4
        for bad in [dict(kweight=-1), dict(kweight=5), dict(kweight=True), dict(view='all'), dict(group_ids=[]),
                    dict(group_ids=[p['groups'][0]['id']]*2), dict(group_ids=[p['groups'][0]['id']])]:
            assert client.post(url, json={**options, **bad}).status_code == 400
        assert client.post(url, json={**options, 'version':p['version']-1}).status_code == 409
        assert store.load(p['id']) == p
        changed = copy.deepcopy(p); changed['groups'][1]['marked'] = False
        changed = store.save(changed, p, 'Unmark one group')
        assert client.post(url, json={**options, 'version':changed['version']}).status_code == 400
        assert store.load(p['id']) == changed


@pytest.mark.parametrize('damage', ['missing', 'short', 'grid', 'nonfinite', 'xanes', 'detector', 'chi'])
def test_incomplete_quad_is_rejected_with_recovery(damage):
    g = probe(NATIVE['rows'][0]['groups'][0], 0)
    if damage == 'missing': g['result'] = None
    elif damage == 'short': g['result']['effective']['exafs'] = False
    elif damage == 'grid': g['result']['arrays']['energy'][0] += 1
    elif damage == 'nonfinite': g['result']['arrays']['bkg'][0] = float('nan')
    else: g['data_type'] = damage
    with pytest.raises(ValueError): special_plot([g], SpecialPlotOptions(version=0, group_ids=[g['id']]))


def test_bare_native_prj_roundtrip_and_restart_keep_quad_arrays(store):
    p = project(store); ids = [g['id'] for g in p['groups']]
    baseline = store.plot_special(p['id'], dict(version=p['version'], view='biquad', group_ids=ids))
    assert AthenaStore(store.settings).plot_special(p['id'], baseline['options']) == baseline
    data = store.export_project(p['id'], 'prj')
    bare = '\n'.join(line for line in gzip.decompress(data).decode().splitlines() if not line.startswith('# Athena-Web ')).encode()
    target = store.create(); restored = store.restore(target['id'], target['version'], bare, 'diagnostics.prj')
    got = store.plot_special(restored['id'], dict(version=restored['version'], view='biquad', group_ids=[g['id'] for g in restored['groups']]))
    for new, old in zip(got['result']['panels'], baseline['result']['panels']):
        for a, b in zip(new['curves'], old['curves']):
            np.testing.assert_allclose(a['x'], b['x'], atol=1e-10, rtol=0)
            np.testing.assert_allclose(a['y'], b['y'], atol=1e-8, rtol=1e-8)
    assert store.load(p['id']) == p


def test_project_change_during_transform_discards_the_obsolete_plot(store, monkeypatch):
    from xraylarch_web import athena_special_plot
    p = project(store)
    original = athena_special_plot.special_plot
    def change_during_plot(groups, options):
        value = original(groups, options)
        newer = store.load(p['id']); before = copy.deepcopy(newer)
        newer['groups'][0]['label'] = 'Concurrent rename'
        store.save(newer, before, 'Concurrent rename')
        return value
    monkeypatch.setattr(athena_special_plot, 'special_plot', change_during_plot)
    with TestClient(create_app(store.settings)) as client:
        result = client.post(f'/api/athena/projects/{p["id"]}/plots/special', json=dict(
            version=p['version'], group_ids=[p['groups'][0]['id']], kweight=1.5))
        assert result.status_code == 409
    saved = store.load(p['id'])
    assert saved['groups'][0]['label'] == 'Concurrent rename'
    assert saved['groups'][0]['result'] == p['groups'][0]['result']


def test_chi_only_kq_uses_weighted_backtransform_once_and_remains_read_only(store):
    a = NATIVE['rows'][0]['groups'][0]['arrays']
    p = store.create(); g = store.make_group('Measured χ(k)', a['k'], a['chi'], data_type='chi')
    g.update(frozen=True, multiplier=2.5, offset=.3)
    p['groups'].append(g); p = store.save(p, store.load(p['id']), 'Measured χ(k)')
    options = dict(version=p['version'], view='kq', group_ids=[g['id']], q_component='re')
    result = store.plot_special(p['id'], options)['result']
    c = result['panels'][0]['curves'][1]
    np.testing.assert_allclose(c['y'], np.asarray(g['result']['arrays']['chiq_re']) * 2.5 + .3, atol=1e-14, rtol=0)
    assert store.load(p['id']) == p


def test_reference_manifest():
    m = json.loads((FIX / 'athena-special-plot-fixtures.json').read_text())
    assert m['case_count'] == len(NATIVE['rows']) == 90
    for name, sha in m['sha256'].items(): assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == sha


def shortcut_group(ident='shortcut', marked=True):
    parameters = AthenaParameters(energy_shift=2, kweight=2).model_dump()
    return dict(id=ident, label='Shortcut', marked=marked, data_type='mu', energy=[10., 20., 30.], mu=[1., 2., 3.],
                multiplier=2., offset=3., parameters=parameters,
                source=dict(raw_arrays=dict(i0=[10., 20., 30.], signal=[2., 4., 6.]),
                            native=dict(args=dict(i0_scale=.1, signal_scale=.2))),
                result=dict(effective=dict(e0=22., edge_step=4., exafs=True, kweight=2.), arrays=dict(
                    energy=[12., 22., 32.], mu=[1., 2., 3.], norm=[.1, .2, .3], flat=[.15, .25, .35],
                    dmude=[.1, .2, -.1], k=[0., 1., 2., 3.], chi=[0., 1., -1., .5])))


def test_shortcut_curves_apply_native_scales_without_mutating_saved_arrays():
    g = shortcut_group(); before = copy.deepcopy(g)
    i0sig = shortcut_plot([g], ShortcutOptions(version=0, kind='i0sig', group_ids=[g['id']]))
    assert [curve['name'] for curve in i0sig['curves']] == ['Shortcut · μ(E)', 'Shortcut · I₀ · scaled by 0.1', 'Shortcut · Signal · scaled by 0.2']
    np.testing.assert_allclose(i0sig['curves'][0]['x'], [12, 22, 32])
    np.testing.assert_allclose(i0sig['curves'][0]['y'], [5, 7, 9])
    np.testing.assert_allclose(i0sig['curves'][1]['y'], [5, 7, 9])
    scaled = shortcut_plot([g], ShortcutOptions(version=0, kind='normscaled', group_ids=[g['id']]))
    assert scaled['curves'][0]['scale'] == 4
    np.testing.assert_allclose(scaled['curves'][0]['y'], [3.6, 4.0, 4.4])
    e00 = shortcut_plot([g], ShortcutOptions(version=0, kind='e00', group_ids=[g['id']], energy_mode='flat'))
    np.testing.assert_allclose(e00['curves'][0]['x'], [-10, 0, 10])
    np.testing.assert_allclose(e00['curves'][0]['y'], [3.3, 3.5, 3.7])
    derivative = shortcut_plot([g], ShortcutOptions(version=0, kind='normderiv', group_ids=[g['id']]))
    np.testing.assert_allclose(derivative['curves'][1]['y'], [3.25, 3.5, 2.75])
    assert g == before


def test_shortcut_store_enforces_scope_and_remains_read_only(store):
    p = store.create(); current, second = shortcut_group(), shortcut_group('second')
    current.update(frozen=False, notes='', reference_id=None); second.update(frozen=False, notes='', reference_id=None)
    p['groups'].extend((current, second)); p = store.save(p, store.load(p['id']), 'Shortcut spectra')
    p = store.load(p['id'])
    before = copy.deepcopy(p)
    options = dict(version=p['version'], kind='k123', group_ids=[current['id']], energy_mode='norm', component='mag', stack_offset=0.)
    result = store.plot_shortcut(p['id'], options)
    assert result['options'] == options
    assert [curve['kweight'] for curve in result['result']['curves']] == [1, 2, 3]
    with pytest.raises(WebInputError):
        store.plot_shortcut(p['id'], {**options, 'kind': 'i0', 'group_ids': [current['id']]})
    with pytest.raises(WebInputError):
        store.plot_shortcut(p['id'], {**options, 'version': p['version'] - 1})
    assert store.load(p['id']) == before
