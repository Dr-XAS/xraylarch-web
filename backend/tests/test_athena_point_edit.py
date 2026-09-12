"""Original Demeter deletion, measured row alignment and in-place lifecycle."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_point_edit import PointEditOptions, select_points, selected_chie
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIX = Path(__file__).parent / 'fixtures'
NATIVE = json.loads(gzip.decompress((FIX / 'athena-point-edit-native.json.gz').read_bytes()))


def source_group(name='constructed', shift=0):
    src = NATIVE['inputs'][name]
    return dict(data_type='mu', energy=src['energy'], mu=src['xmu'], parameters=dict(energy_shift=shift),
                result=dict(effective=dict(e0=src['e0'] + shift), arrays={key: src[key] for key in ('pre_edge', 'post_edge')}))


@pytest.mark.parametrize('row', NATIVE['rows'], ids=lambda r: r['name'])
def test_original_perl_methods_and_larch_templates_match_retained_measurements(row):
    result = select_points(source_group(row['input']), PointEditOptions(**row['options']))
    assert result['energy'] == row['energy']
    assert result['mu'] == row['mu']
    assert result['kept_indices'] == row['kept_indices']
    if 'margins' in row:
        for key in ('x', 'upper', 'lower'):
            np.testing.assert_allclose(result['margins'][key], row['margins'][key], rtol=0, atol=1e-15)


def test_reference_inputs_methods_and_runtime_are_hash_pinned():
    root = FIX.parents[2]
    manifest = json.loads((FIX / 'athena-point-edit-fixtures.json').read_text())
    catalog = {r['file']: r['sha256'] for r in json.loads((root / 'docs/athena-primary-sources.json').read_text())['files']}
    for path, sha in manifest['sha256'].items():
        assert hashlib.sha256((root / path).read_bytes()).hexdigest() == sha
    for path, sha in manifest['source_sha256'].items():
        assert sha == catalog['demeter-' + manifest['demeter_revision'] + '/' + path]
    assert len(NATIVE['rows']) == manifest['case_count'] == 30
    for src in NATIVE['inputs'].values():
        if 'sha256' in src:
            assert hashlib.sha256((FIX / src['fixture']).read_bytes()).hexdigest() == src['sha256']


@pytest.mark.parametrize('options', [dict(mode='point', point=7012.5), dict(mode='truncate', side='before', value=7012.5),
    dict(mode='truncate', side='after', value=7032.5), dict(mode='margins', emin=-19, emax=-2, tolerance=.1)])
def test_calibration_applies_once_to_selection_and_margin_range(options):
    plain = select_points(source_group(), PointEditOptions(**options))
    shifted = dict(options)
    for key in ('point', 'value'):
        if key in shifted:
            shifted[key] += 2.75
    result = select_points(source_group(shift=2.75), PointEditOptions(**shifted))
    assert result['kept_indices'] == plain['kept_indices']
    assert result['energy'] == plain['energy'] and result['mu'] == plain['mu']
    assert result['selected_energy'] == [x + 2.75 for x in plain['selected_energy']]


def test_strict_margins_floor_bounds_and_duplicate_picks():
    group = source_group()
    group['mu'] = group['mu'].copy()
    line = group['result']['arrays']['pre_edge']
    group['mu'][4] = line[4] + .1  # Equality is retained.
    result = select_points(group, PointEditOptions(mode='margins', emin=-18.8, emax=-4.2, tolerance=.1))
    assert result['removed_indices'] == [2, 12, 15]
    assert result['margins']['indices'] == list(range(1, 16))
    assert select_points(group, PointEditOptions(mode='points', points=[7012., 7012., 7012.1]))['removed_indices'] == [12]


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def project(store, name='ORP5.000', dtype='mu', shift=2.75):
    src = NATIVE['inputs'][name]
    data = np.loadtxt(FIX / src['fixture'], delimiter=',')
    source = dict(operation='measured import', filename=src['fixture'], row_order=list(range(len(data))),
                  raw_arrays=dict(i0=data[:, 5].tolist(), signal=data[:, 6].tolist(), stddev=data[:, 7].tolist()),
                  column_arrays={f'column_{i}': data[:, i].tolist() for i in range(data.shape[1])})
    group = store.make_group(name, src['energy'], src['xmu'], data_type=dtype, source=source,
        parameters=dict(energy_shift=shift, e0=src['e0'], pre1=-190, pre2=-30, norm1=100, norm2=900, nnorm=2))
    p = store.create(); p['groups'] = [group]
    return store.save(p, store.load(p['id']), 'Measured fixture')


def request(p, options, ids=None):
    return Command(version=p['version'], action='truncate' if options['mode']=='truncate' else 'deglitch',
        group_ids=ids or [p['groups'][0]['id']], options=options)


@pytest.mark.parametrize('name', ['ORP5.000', 'ZT20.000'])
@pytest.mark.parametrize('mode', ['point', 'margins', 'before', 'after'])
def test_measured_inplace_preview_detector_rows_provenance_undo_redo_and_prj(store, name, mode):
    p = project(store, name); parent = copy.deepcopy(p['groups'][0]); shift = parent['parameters']['energy_shift']
    if mode == 'point': options = dict(mode=mode, point=parent['energy'][290] + shift)
    elif mode == 'margins': options = dict(mode=mode, emin=100, emax=900, tolerance=.002)
    else: options = dict(mode='truncate', side=mode, value=parent['energy'][20 if mode=='before' else 530] + shift + .01)
    before_bytes = (FIX / parent['source']['filename']).read_bytes()
    preview = store.preview_point_edit(p['id'], request(p, options)); row = preview['results'][0]
    assert store.load(p['id']) == p
    assert row['removed_indices']
    edited = store.command(p['id'], request(p, preview['options'])); group = edited['groups'][0]
    assert len(edited['groups']) == 1 and group['id'] == parent['id']
    assert group['parameters'] == parent['parameters']
    assert group['energy'] == row['energy'] and group['mu'] == row['mu']
    keep = row['kept_indices']
    for key in ('raw_arrays', 'column_arrays'):
        assert group['source'][key] == {k: [a[i] for i in keep] for k, a in parent['source'][key].items()}
    assert group['source']['row_order'] == keep
    assert group['source']['operation'] == 'measured import'
    assert group['source']['point_edits'][-1]['removed_mu'] == row['selected_mu']
    assert 'Removed ' in group['source']['xdi_metadata']['attributes']['scan']['process']
    assert (FIX / parent['source']['filename']).read_bytes() == before_bytes
    undone = store.command(p['id'], Command(version=edited['version'], action='undo'))
    assert undone['groups'] == p['groups']
    redone = store.command(p['id'], Command(version=undone['version'], action='redo'))
    assert redone['groups'] == edited['groups']
    data = store.export_project(p['id'], 'prj')
    for raw in (data, '\n'.join(l for l in gzip.decompress(data).decode().splitlines() if not l.startswith('# Athena-Web ')).encode()):
        restored = store.restore(store.create()['id'], 0, raw, 'edited.prj')['groups'][0]
        assert restored['energy'] == group['energy'] and restored['mu'] == group['mu']
        assert restored['source']['raw_arrays'] == group['source']['raw_arrays']
        assert restored['source']['xdi_metadata']['attributes']['scan']['process'] == group['source']['xdi_metadata']['attributes']['scan']['process']
        if raw == data:
            assert restored['source']['point_edits'] == group['source']['point_edits']


def test_native_detector_template_corruption_is_observed_and_not_reproduced():
    point = next(row for row in NATIVE['rows'] if row['name']=='ORP5.000-0-point')
    keep = np.asarray(point['kept_indices'])
    assert point['native_detectors']['i0'] == (keep + 1000).tolist()
    assert point['native_detectors']['signal'] != (keep * 3 + 17).tolist()
    assert len(point['native_detectors']['signal']) != len(keep)
    before = next(row for row in NATIVE['rows'] if row['name']=='ORP5.000-4-truncate')
    assert len(before['native_detectors']['i0']) == 586 > len(before['energy'])


@pytest.mark.parametrize('dtype', ['mu', 'norm', 'xanes', 'detector'])
def test_preserves_data_identity_and_clears_processing_when_recipe_no_longer_fits(store, dtype):
    p = project(store, dtype=dtype)
    row = p['groups'][0]
    options = dict(mode='truncate', side='after', value=row['energy'][40] + row['parameters']['energy_shift'])
    preview = store.preview_point_edit(p['id'], request(p, options))
    after = store.command(p['id'], request(p, options))['groups'][0]
    assert after['data_type'] == row['data_type'] and after['is_normalized'] == row['is_normalized']
    assert len(after['mu']) == 40
    if dtype != 'detector':
        assert after['result'] is None and after['processing_error']
        assert preview['results'][0]['modified']['chie'] is None


def test_inspect_and_chie_markers_are_readonly_and_no_preedge_extrapolation(store):
    p = project(store); g = p['groups'][0]
    assert g['processing_error'] is None
    row = store.preview_point_edit(p['id'], request(p, dict(mode='inspect')))['results'][0]
    assert row['kept_indices'] == list(range(586)) and row['removed_indices'] == []
    curve = row['original']['chie']; assert curve is not None
    selected = [g['energy'][0]+2.75, g['energy'][300]+2.75]
    marker = selected_chie(g, selected)
    assert marker['x'] == selected[1:]
    assert marker['y'] == np.interp(marker['x'], curve['x'], curve['y']).tolist()
    with pytest.raises((ValueError, WebInputError), match='No points'):
        store.command(p['id'], request(p, dict(mode='inspect')))
    assert store.load(p['id']) == p


def test_marked_truncate_skips_frozen_current_rejects_and_bad_batch_is_atomic(store):
    p = project(store); parent = p['groups'][0]
    second = copy.deepcopy(parent); second['id']='second'; second['frozen']=True
    p['groups'].append(second); p=store.save(p, store.load(p['id']), 'Second frozen group')
    options = dict(mode='truncate', side='after', value=parent['energy'][530]+2.75, scope='marked')
    req = request(p, options, ['second', parent['id']])
    preview = store.preview_point_edit(p['id'], req)
    assert list(preview['skipped_reasons']) == ['second']
    after = store.command(p['id'], req)
    assert after['groups'][1] == second and len(after['groups'][0]['mu']) == 530
    with pytest.raises((ValueError, WebInputError), match='Unfreeze'):
        store.command(p['id'], request(after, dict(options, scope='current'), ['second']))
    assert store.load(p['id']) == after


@pytest.mark.parametrize('options', [dict(mode='point', point=-1), dict(mode='indices', indices=[-1]),
    dict(mode='indices', indices=[586]), dict(mode='truncate', side='after', value=9460),
    dict(mode='margins', emin=-10, emax=10, tolerance=.1), dict(mode='margins', emin=10, emax=100, tolerance=-1),
    dict(mode='point', point=True), dict(mode='point', point='9659'), dict(mode='point', point=float('nan')),
    dict(mode='indices', indices=[True]), dict(mode='point'), dict(mode='point', point=9659, tolerance=1)])
def test_invalid_removal_cannot_mutate_project(store, options):
    p = project(store)
    with pytest.raises((ValueError, WebInputError, ValidationError)):
        store.command(p['id'], request(p, options))
    assert store.load(p['id']) == p


@pytest.mark.parametrize('bad', [None, {}, ['bad'], [dict(action='deglitch')]])
def test_malformed_history_rejects_project_restore_without_partial_import(store, bad):
    p = project(store)
    document = json.loads(store.export_project(p['id']))
    document['groups'][0]['source']['point_edits'] = bad
    destination = store.create()
    with pytest.raises((ValueError, WebInputError), match='Point-edit history'):
        store.restore(destination['id'], 0, json.dumps(document).encode(), 'bad.json')
    assert store.load(destination['id']) == destination


def test_http_revision_preview_and_apply_reject_stale_client(tmp_path):
    client=TestClient(create_app(Settings(data_root=tmp_path)))
    p=client.post('/api/athena/projects',json={}).json(); path=f'/api/athena/projects/{p["id"]}'
    p=client.post(path+'/command',json=dict(version=0,action='example')).json()
    req=request(p,dict(mode='point',point=p['groups'][0]['energy'][200])).model_dump()
    response=client.post(path+'/point-edit/preview',json=req)
    assert response.status_code==200
    assert client.get(path).json()==p
    saved=client.post(path+'/command',json=req); assert saved.status_code==200
    assert client.post(path+'/point-edit/preview',json=req).status_code==409
    assert client.post(path+'/command',json=req).status_code==409
    assert client.get(path).json()==saved.json()
