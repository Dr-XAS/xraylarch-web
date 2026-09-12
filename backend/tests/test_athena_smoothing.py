"""Executed native kernels, real Larch group lifecycle and preview contracts."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient
import numpy as np
from pydantic import ValidationError
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_smoothing import SmoothOptions, smooth
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
NATIVE = json.loads(gzip.decompress((FIXTURES/'athena-smoothing-native.json.gz').read_bytes()))
METHODS = [dict(method='boxcar', window=8), dict(method='gaussian', window=11, sigma=2.),
           dict(method='savitzky_golay', window=31, order=4), dict(method='three_point', repetitions=11)]


def test_recorded_reference_provenance():
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((FIXTURES/'athena-smoothing-fixtures.json').read_text())
    catalog = {row['file']:row['sha256'] for row in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    for path, sha in manifest['sha256'].items():
        assert hashlib.sha256((root/path).read_bytes()).hexdigest() == sha
    for path, sha in NATIVE['sources'].items():
        assert catalog['demeter-'+manifest['demeter_revision']+'/'+path] == sha
    assert NATIVE['fortran_sources'] == manifest['fortran_sources']
    for name, sha in NATIVE['fortran_sources'].items():
        assert catalog['ifeffit-1.2.11d/src/lib/'+name] == sha
    assert len(NATIVE['cases']) == manifest['case_count'] == 36
    for row in NATIVE['cases']:
        assert row['native']['modules'] == manifest['native_modules']
        assert row['native']['pdl_version'] == manifest['pdl_version']
        if row['input_sha256']:
            assert hashlib.sha256((FIXTURES/row['fixture']).read_bytes()).hexdigest() == row['input_sha256']


@pytest.mark.parametrize('row', NATIVE['cases'], ids=[r['id'] for r in NATIVE['cases']])
def test_every_observation_matches_actual_native_filters_and_boundaries(row):
    v = row['input']
    choice = SmoothOptions(**{k:v[k] for k in ('method','window','sigma','order','repetitions')})
    actual = smooth(v['x'], v['y'], choice)
    np.testing.assert_array_equal(actual['energy'], row['native']['x'])
    np.testing.assert_allclose(actual['mu'], row['native']['y'], atol=2e-14, rtol=2e-14)
    assert actual['details']['output_points'] == len(row['native']['y'])
    if choice.method in ('boxcar', 'gaussian'):
        size = choice.window if choice.window > 0 else 11
        size += size % 2 == 0
        assert len(actual['energy']) == len(v['x']) - size
    elif choice.method == 'savitzky_golay':
        assert len(row['native']['calls']) == 1


@pytest.mark.parametrize('values', [dict(method='unknown'), dict(window=1.5), dict(window=True), dict(order=-1),
    dict(sigma=float('nan')), dict(sigma=float('inf')), dict(repetitions='3'), dict(unknown=2)])
def test_bad_smoothing_choices_are_not_silently_ignored(values):
    with pytest.raises(ValidationError):
        SmoothOptions(**values)


def test_native_coercions_and_larch_defaults_are_reported():
    x = np.arange(51.); y = np.sin(x)
    choice = SmoothOptions(method='savitzky_golay')
    assert (choice.window, choice.order) == (31, 9)
    for opts, expected in [(dict(method='boxcar', window=0), dict(window=11)),
                           (dict(method='gaussian', window=8, sigma=0.), dict(window=9, sigma=4)),
                           (dict(method='savitzky_golay', window=3, order=7), dict(window=5, order=2)),
                           (dict(method='three_point', repetitions=0), dict(repetitions=1))]:
        result = smooth(x, y, SmoothOptions(**opts))
        assert {k:result['details'][k] for k in expected} == expected
        assert result['details']['warnings']


def test_limits_precede_filter_work_and_never_coarsen_the_source(monkeypatch):
    x = np.arange(51.); y = np.sin(x)
    with pytest.raises(ValueError, match='smaller smoothing kernel'):
        smooth(x, y, SmoothOptions(window=43))
    assert len(smooth(x, y, SmoothOptions(window=41))['mu']) == 10
    with pytest.raises(ValueError, match='fit inside'):
        smooth(x, y, SmoothOptions(method='savitzky_golay', window=101))
    monkeypatch.setattr('xraylarch_web.athena_smoothing.MAX_WORK', 100)
    for opts in METHODS:
        with pytest.raises(ValueError, match='work limit'):
            smooth(x, y, SmoothOptions(**opts))


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def imported(store, data_type='mu'):
    p = store.create(); name = 'xdi-official-cu_metal_rt.xdi'
    i = store.inspect(p['id'], (FIXTURES/name).read_bytes(), name)
    cols = {v['name']:v['column_id'] for v in i['columns']}
    p = store.import_data(p['id'], ImportRequest(version=0, upload_id=i['upload_id'],
        energy_column=cols['energy'], numerator=[cols['mutrans']], mode='mu'))
    if data_type != 'mu':
        original = p['groups'][0]
        x, y = (original['result']['arrays']['k'], original['result']['arrays']['chi']) if data_type == 'chi' else (original['energy'], original['result']['arrays']['norm'])
        # A new normalized/chi input has no matching original detector table.
        source = {k:copy.deepcopy(original['source'][k]) for k in ('xdi_metadata', 'edge_identity')}
        p['groups'] = [store.make_group('Cu '+data_type, x, y, data_type=data_type, source=source)]
        store.storage.write_json(p['id'], 'project.json', p)
    return p


def request(p, options, ids=None):
    return Command(version=p['version'], action='smooth', group_ids=ids or [p['groups'][0]['id']], options=options)


@pytest.mark.parametrize('options', METHODS)
@pytest.mark.parametrize('data_type', ['mu', 'norm', 'chi'])
def test_preview_saved_arrays_identity_history_and_bare_prj_agree(store, options, data_type):
    p = imported(store, data_type); parent = copy.deepcopy(p['groups'][0])
    p = store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=[parent['id']], options=dict(frozen=True, notes='Source note')))
    parent = copy.deepcopy(p['groups'][0]); before = copy.deepcopy(p)
    command = request(p, options)
    preview = store.preview_smoothing(p['id'], command)
    assert store.load(p['id']) == before
    result = preview['results'][0]
    after = store.command(p['id'], command); child = after['groups'][1]
    assert after['groups'][0] == parent and len(after['groups']) == 2
    assert child['data_type'] == parent['data_type'] and child['is_normalized'] == parent['is_normalized']
    assert child['mu'] == result['smoothed_mu'] and child['energy'] == result['smoothed_energy']
    assert child['source']['edge_identity'] == parent['source']['edge_identity']
    assert child['processing_error'] is None and not child['frozen'] and child['notes'] == 'Source note'
    assert 'raw_arrays' not in child['source'] and 'column_arrays' not in child['source']
    assert child['source']['xdi_metadata']['comments_text'] == parent['source']['xdi_metadata']['comments_text']
    expected_history = {'boxcar':'Smoothed data by boxcar average', 'gaussian':'Smoothed data by Gaussian filter',
        'savitzky_golay':'Smoothed data by Savitzky-Golay filter', 'three_point':'Smoothed data by three-point filter (11 repetitions)'}[options['method']]
    assert child['source']['xdi_metadata']['attributes']['scan']['process'] == expected_history
    if data_type != 'chi':
        assert result['traces']['E'][1]['y'] == child['mu']
    for space, xkey, ykey in [('k','k','weighted_chi'), ('R','r','chir_mag')]:
        assert result['traces'][space][1]['x'] == child['result']['arrays'][xkey]
        assert result['traces'][space][1]['y'] == child['result']['arrays'][ykey]
    undone = store.command(p['id'], Command(version=after['version'], action='undo'))
    assert undone['groups'] == before['groups']
    after = store.command(p['id'], Command(version=undone['version'], action='redo'))
    assert after['groups'][1] == child and AthenaStore(store.settings).load(p['id']) == after
    native = b'\n'.join(line for line in gzip.decompress(store.export_project(p['id'], 'prj')).splitlines() if not line.startswith(b'# Athena-Web '))
    reopened = store.restore(store.create()['id'], 0, native, 'smoothed.prj')['groups'][1]
    assert reopened['mu'] == child['mu'] and reopened['energy'] == child['energy']
    assert reopened['data_type'] == child['data_type']
    assert reopened['source']['xdi_metadata']['attributes']['scan']['process'] == expected_history


def test_calibration_is_materialized_once_and_batch_failure_is_atomic(store):
    p = imported(store)
    p = store.command(p['id'], Command(version=p['version'], action='parameters', group_ids=[p['groups'][0]['id']], options=dict(energy_shift=3.5)))
    parent = p['groups'][0]
    after = store.command(p['id'], request(p, dict(method='three_point', repetitions=1)))
    np.testing.assert_array_equal(after['groups'][1]['energy'], np.asarray(parent['energy']) + 3.5)
    assert after['groups'][1]['parameters']['energy_shift'] == 0
    short = store.make_group('Too short for this kernel', parent['energy'][:12], parent['mu'][:12], data_type='xanes')
    after['groups'].append(short); store.storage.write_json(p['id'], 'project.json', after)
    before = copy.deepcopy(after)
    with pytest.raises(ValueError, match='smaller smoothing kernel'):
        store.command(p['id'], request(after, dict(method='boxcar', window=11), [parent['id'], short['id']]))
    assert store.load(p['id']) == before


@pytest.mark.parametrize('options', METHODS)
@pytest.mark.parametrize('kind', ['xanes', 'detector', 'difference'])
def test_restricted_plot_spaces_retain_signal_meaning(store, options, kind):
    p = imported(store); parent = p['groups'][0]
    y = np.asarray(parent['mu'])
    if kind == 'difference':
        y = .1*np.sin(np.arange(len(y)))
    p['groups'] = [store.make_group(kind, parent['energy'], y, data_type='mu' if kind == 'difference' else kind,
                                  is_difference=kind == 'difference')]
    store.storage.write_json(p['id'], 'project.json', p)
    preview = store.preview_smoothing(p['id'], request(p, options))['results'][0]
    assert len(preview['traces']['E']) == 2
    assert preview['traces']['k'] == preview['traces']['R'] == []
    assert preview['errors']['k'] and preview['errors']['R']
    after = store.command(p['id'], request(p, options)); child = after['groups'][1]
    assert child['data_type'] == p['groups'][0]['data_type']
    assert child['is_difference'] == (kind == 'difference')
    assert child['mu'] == preview['smoothed_mu']
    assert child['result']['effective']['exafs'] is False
    if kind in ('difference', 'detector'):
        assert child['result']['effective']['edge_step'] is None
        assert child['result']['arrays']['mu'] == child['mu']
        assert child['result']['arrays']['norm'] == ([] if kind == 'detector' else child['mu'])


@pytest.mark.parametrize('options', METHODS)
def test_batch_insertion_marking_and_native_names_follow_project_order(store, options):
    p = imported(store)
    p = store.command(p['id'], Command(version=p['version'], action='duplicate', group_ids=[p['groups'][0]['id']]))
    ids = [g['id'] for g in p['groups']]
    p = store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=ids, options={'marked':True}))
    after = store.command(p['id'], request(p, options, ids[::-1]))
    assert [after['groups'][0], after['groups'][2]] == p['groups']
    for i in range(2):
        child, parent = after['groups'][i*2+1], p['groups'][i]
        assert child['source']['parent'] == parent['id']
        assert child['marked'] == (i == 1 and options['method'] in ('three_point', 'savitzky_golay'))
        suffix = {'boxcar':', boxcar size 9', 'gaussian':', Gaussian filter 11, 2',
                  'savitzky_golay':' Savitzky-Golay', 'three_point':' smoothed 11 times'}[options['method']]
        assert child['label'] == parent['label'] + suffix


def test_http_rejects_unbound_algorithms_and_invalid_kernels_without_writes(tmp_path):
    settings = Settings(data_root=tmp_path); store = AthenaStore(settings); p = imported(store)
    client = TestClient(create_app(settings)); base = f"/api/athena/projects/{p['id']}"
    for options in ({}, {'method':'wrong'}, {'method':'boxcar', 'window':401}, {'method':'boxcar', 'window':True}):
        payload = request(p, options).model_dump()
        for route in ('/smooth/preview', '/command'):
            if route == '/command' and not options:  # Established method-less API is a separate legacy SG operation.
                continue
            response = client.post(base+route, json=payload)
            assert response.status_code in (400, 422), response.text
        assert store.load(p['id']) == p


def test_http_revision_binding_and_mid_calculation_conflict(tmp_path, monkeypatch):
    settings = Settings(data_root=tmp_path); store = AthenaStore(settings); p = imported(store)
    client = TestClient(create_app(settings)); path = f"/api/athena/projects/{p['id']}/smooth/preview"
    command = request(p, dict(method='boxcar', window=11))
    response = client.post(path, json=command.model_dump())
    assert response.status_code == 200 and response.json()['version'] == p['version']
    assert client.post(path, json=command.model_dump() | {'version':0}).status_code == 409
    def concurrent(*args):
        out = smooth(*args)
        store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=[p['groups'][0]['id']], options=dict(notes='Other window')))
        return out
    monkeypatch.setattr('xraylarch_web.athena_smoothing.smooth', concurrent)
    assert client.post(path, json=command.model_dump()).status_code == 409
    assert len(store.load(p['id'])['groups']) == 1
