"""Native point-writer comparisons and persisted shortcut-plot lifecycle."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_plot_shortcuts import ShortcutOptions, detector_scale, shortcut_plot
from xraylarch_web.athena_science import AthenaParameters, ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIX = Path(__file__).parent / 'fixtures'
ROOT = FIX.parents[2]
NATIVE = json.loads(gzip.decompress((FIX / 'athena-shortcut-plot-native.json.gz').read_bytes()))
KINDS = ('normderiv', 'i0sig', 'i0', 'normscaled', 'e00', 'k123', 'r123')
MARKED = ('i0', 'e00', 'normscaled')


def probe(raw, row):
    a = copy.deepcopy(raw['arrays'])
    p = AthenaParameters(energy_shift=raw['bkg_eshift'], flatten=row['flatten'], e0=raw['bkg_e0'],
        pre1=-150, pre2=-30, norm1=150, norm2=800, nnorm=2, kweight=2, kmin=3, kmax=12, bkg_kmax=14).model_dump()
    a.update(raw['transforms']['2'])
    a['mu'] = a.pop('xmu'); a['dmude'] = a.pop('nder')
    a['energy'] = (np.asarray(a['energy']) + raw['bkg_eshift']).tolist()
    return dict(id=raw['group'], label=raw['name'], energy=raw['arrays']['energy'], mu=a['mu'], data_type='mu',
                multiplier=row['scale'], offset=row['offset'], parameters=p, marked=True, processing_error=None,
                source=dict(raw_arrays={key:copy.deepcopy(raw['arrays'][key]) for key in ('i0','signal')}, native=dict(args={
                    key:raw[key] for key in ('i0_scale','signal_scale')})),
                result=dict(arrays=a, effective=dict(exafs=True, kweight=2, e0=raw['bkg_e0'], edge_step=raw['edge_step'], bkg_kmax=14)))


@pytest.mark.parametrize('row', NATIVE['rows'], ids=lambda row: f'{row["id"]}-{row["kind"]}-{row["component"]}')
def test_unchanged_native_shortcut_handlers_templates_and_points(row):
    groups = [probe(g, row) for g in NATIVE['groups'][:2 if row['kind'] in MARKED else 1]]
    before = copy.deepcopy(groups)
    options = ShortcutOptions(version=0, kind=row['kind'], group_ids=[g['id'] for g in groups],
        energy_mode='norm' if row['energy_norm'] else 'mu', component=dict(m='mag',r='re',i='im',p='pha')[row['component']])
    result = shortcut_plot(groups, options)
    assert groups == before
    assert not result['skipped']
    assert len(result['curves']) == len(row['native']['curves'])
    for got, expected in zip(result['curves'], row['native']['curves']):
        np.testing.assert_allclose(np.array([got['x'], got['y']]).T, expected, atol=5e-11, rtol=3e-13)
    for g, restored in zip(groups, row['native']['restored']):
        assert restored == [g['id'], g['multiplier'], g['offset'], g['parameters']['energy_shift'], g['result']['effective']['e0']]
    if row['kind'] == 'normderiv':
        e0 = groups[0]['result']['effective']['e0']
        assert result['x_range'] == [e0-30, e0+70]
        assert row['native']['markers'] == [[groups[0]['id'], 'norm']]


def one(kind, g, **options):
    return shortcut_plot([g], ShortcutOptions(version=0, kind=kind, group_ids=[g['id']], **options))


@pytest.fixture
def g(): return probe(NATIVE['groups'][0], dict(flatten=True, scale=-1.2, offset=.375))


@pytest.mark.parametrize('kind', ['normderiv','k123'])
def test_native_comparison_factor_rounded_to_zero_still_means_unit_scale(g, kind):
    a = g['result']['arrays']
    if kind == 'normderiv':
        a['dmude'] = (np.asarray(a['dmude'])*1e6).tolist()
        curve = one(kind, g)['curves'][1]
        expected = a['dmude']; offset = g['offset']
    else:
        a.update(k=[0.,10000.,20000.,30000.], chi=[0.,1.,-1.,1.])
        curve = one(kind, g)['curves'][2]
        expected = np.asarray(a['chi'])*np.asarray(a['k'])**3
        offset = -1.2*9e8
    assert curve['scale'] == 0
    assert curve['effective_scale'] == 1
    np.testing.assert_allclose(curve['y'], np.asarray(expected)+offset)


def test_k123_uses_signed_maxima_and_replaces_group_modifiers(g):
    g['result']['arrays'].update(k=[1.,2.,3.,4.],chi=[-.01,-.02,-.03,-.04])
    result = one('k123', g)
    assert [c['scale'] for c in result['curves']] == [1.,1.,1.]
    assert [c['offset'] for c in result['curves']] == [-.012,0.,.012]


def test_legacy_project_scales_recompute_signed_maximum_and_json_retains_live_scales(g):
    g['mu'] = (-np.abs(g['mu'])).tolist()
    native = g['source']['native']; native['format'] = 'athena-perl'
    native['args']['i0_scale'] = 42
    expected = max(g['mu']) / max(g['source']['raw_arrays']['i0'])
    assert detector_scale(g, 'i0') == expected < 0
    native['format'] = 'athena-json'
    assert detector_scale(g, 'i0') == 42
    native['args']['i0_scale'] = 0
    curves = one('i0sig', g)['curves']
    assert curves[1]['scale'] == 0
    np.testing.assert_allclose(curves[1]['y'], np.asarray(g['source']['raw_arrays']['i0'])+g['offset'])


@pytest.mark.parametrize('damage', ['missing','short','nonfinite','zero-maximum'])
def test_detector_failures_skip_only_the_affected_channel(g, damage):
    del g['source']['native']
    raw = g['source']['raw_arrays']
    if damage == 'missing': del raw['i0']
    elif damage == 'short': raw['i0'] = raw['i0'][:-1]
    elif damage == 'nonfinite': raw['i0'][0] = float('nan')
    else: raw['i0'] = [0.] * len(raw['i0'])
    result = one('i0sig', g)
    assert len(result['curves']) == 2
    assert result['skipped'][0]['channel'] == 'i0'


def test_e00_disables_derivatives_and_follows_each_flatten_setting(g):
    for flatten in (False, True):
        g['parameters']['flatten'] = flatten
        for mode in ('norm','flat','dmude','d2mude'):
            curve = one('e00', g, energy_mode=mode)['curves'][0]
            np.testing.assert_allclose(curve['y'], np.asarray(g['result']['arrays']['flat' if flatten else 'norm'])*g['multiplier']+g['offset'])
    raw = one('e00', g, energy_mode='mu')['curves'][0]
    np.testing.assert_allclose(raw['y'], np.asarray(g['mu'])*g['multiplier']+g['offset'])


@pytest.mark.parametrize('kind', KINDS)
def test_invalid_types_and_incomplete_science_fail_explicitly(g, kind):
    g['data_type'] = 'chi' if kind not in ('k123','r123') else 'xanes'
    if kind in MARKED:
        got = one(kind, g)
        assert not got['curves'] and got['skipped']
    else:
        with pytest.raises(ScientificError): one(kind, g)


@pytest.fixture
def store(tmp_path): return AthenaStore(Settings(data_root=tmp_path))


def project(store):
    p = store.create()
    for raw in NATIVE['groups']:
        g = probe(raw, dict(flatten=True, scale=-1.2, offset=.375))
        made = store.make_group(g['label'], g['energy'], g['mu'], parameters=g['parameters'], source=g['source'])
        made.update(marked=True, multiplier=g['multiplier'], offset=g['offset'])
        p['groups'].append(made)
    return store.save(p, store.load(p['id']), 'Measured Fe detector scans')


def options(p, kind, **changes):
    return dict(version=p['version'], kind=kind,
        group_ids=[g['id'] for g in p['groups'][:None if kind in MARKED else 1]], **changes)


def test_http_all_shortcuts_scopes_validation_and_readonly_frozen_sources(store):
    p = project(store)
    for g in p['groups']: g['frozen'] = True
    p = store.save(p, store.load(p['id']), 'Freeze scans')
    with TestClient(create_app(store.settings)) as client:
        url = f'/api/athena/projects/{p["id"]}/plots/shortcut'
        for kind in KINDS:
            response = client.post(url, json=options(p,kind))
            assert response.status_code == 200, response.text
            assert response.json()['result']['curves']
        for change in [dict(kind='missing'),dict(component='complex'),dict(stack_offset=True),dict(energy_mode='k'),
                       dict(group_ids=[]),dict(group_ids=[p['groups'][0]['id']]*2),dict(group_ids=['missing']),dict(extra=1)]:
            assert client.post(url, json={**options(p,'normderiv'),**change}).status_code == 400
        assert client.post(url,json={**options(p,'normderiv'),'version':p['version']-1}).status_code == 409
        assert client.post(url,json={**options(p,'i0'),'group_ids':list(reversed(options(p,'i0')['group_ids']))}).status_code == 400
    assert store.load(p['id']) == p


def test_native_and_web_project_exchange_restart_and_detector_capture(store):
    p = project(store)
    baseline = {k:store.plot_shortcut(p['id'],options(p,k))['result'] for k in KINDS}
    restart = AthenaStore(store.settings)
    assert baseline == {k:restart.plot_shortcut(p['id'],options(p,k))['result'] for k in KINDS}
    for format in ('json','prj','bare-prj'):
        data = store.export_project(p['id'], 'json' if format=='json' else 'prj')
        if format == 'bare-prj':
            data = '\n'.join(line for line in gzip.decompress(data).decode().splitlines() if not line.startswith('# Athena-Web ')).encode()
            assert b'i0_string' in data and b'signal_string' in data
        target = store.create()
        restored = store.restore(target['id'],target['version'],data,'shortcut.'+('json' if format=='json' else 'prj'))
        for kind in KINDS:
            result = store.plot_shortcut(restored['id'],options(restored,kind))['result']
            assert len(result['curves']) == len(baseline[kind]['curves'])
            for got,expected in zip(result['curves'],baseline[kind]['curves']):
                np.testing.assert_allclose(got['x'],expected['x'],atol=1e-9,rtol=0)
                np.testing.assert_allclose(got['y'],expected['y'],atol=1e-8,rtol=1e-8)
    assert store.load(p['id']) == p


def test_import_detector_factors_are_copied_and_remain_fixed_after_point_removal(store,g):
    del g['source']['native']
    original = copy.deepcopy(g['source'])
    made = store.make_group(g['label'],g['energy'],g['mu'],source=g['source'])
    assert g['source'] == original
    factors = made['source']['detector_plot_scales'].copy()
    made['energy'] = made['energy'][:-20]; made['mu'] = made['mu'][:-20]
    for key in ('i0','signal'): made['source']['raw_arrays'][key] = made['source']['raw_arrays'][key][:-20]
    assert {key:detector_scale(made,key) for key in factors} == factors


def test_marked_stack_spacing_is_additive_and_reports_skipped_groups(g):
    other=copy.deepcopy(g);other['id']='other';other['label']='Second'
    invalid=copy.deepcopy(g);invalid['id']='bad';invalid['data_type']='chi'
    result=shortcut_plot([g,invalid,other],ShortcutOptions(version=0,kind='normscaled',group_ids=[g['id'],'bad','other'],stack_offset=2.))
    assert len(result['curves'])==2 and result['skipped'][0]['group_id']=='bad'
    assert result['curves'][1]['offset']==g['offset']+4


def test_concurrent_project_edit_discards_obsolete_calculation(store, monkeypatch):
    from xraylarch_web import athena_plot_shortcuts
    p=project(store); original=athena_plot_shortcuts.shortcut_plot
    def changed(groups, opts):
        value=original(groups, opts); updated=store.load(p['id']); before=copy.deepcopy(updated)
        updated['groups'][0]['label']='Renamed during plot';store.save(updated,before,'Rename')
        return value
    monkeypatch.setattr(athena_plot_shortcuts,'shortcut_plot',changed)
    with TestClient(create_app(store.settings)) as client:
        response=client.post(f'/api/athena/projects/{p["id"]}/plots/shortcut',json=options(p,'r123'))
        assert response.status_code==409
    assert store.load(p['id'])['groups'][0]['result']==p['groups'][0]['result']


def test_fixture_manifest():
    manifest=json.loads((FIX/'athena-shortcut-plot-fixtures.json').read_text())
    assert manifest['case_count']==len(NATIVE['rows'])==66
    for name, sha in manifest['sha256'].items():
        assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==sha
