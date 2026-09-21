"""Native context commands and read-only scientific diagnostics over HTTP."""
from copy import deepcopy
import gzip

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import estimate_noise, xftf

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_context import edge_step_uncertainty
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def workspace(tmp_path, xas_arrays):
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    old = store.create()
    project = deepcopy(old)
    x, y = xas_arrays
    for i in range(3):
        project['groups'].append(store.make_group(f'Scan {i}', x, y * (1 + i * .2)))
    project = store.save(project, old, 'Three spectra')
    with TestClient(create_app(settings)) as client:
        yield store, project, client


def command(client, p, action, indices=(0,), **options):
    return client.post(f"/api/athena/projects/{p['id']}/command", json={
        'version': p['version'], 'action': action,
        'group_ids': [p['groups'][i]['id'] for i in indices], 'options': options})


def accepted(response):
    assert response.status_code == 200, response.text
    return response.json()


def test_paired_parameter_copy_is_atomic_and_does_not_change_other_values(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'parameters', (1,), pre1=-200, pre2=-120))
    before = deepcopy(p)
    # Setting pre1 first by itself would be invalid; the complete pair is valid.
    p = accepted(command(client, p, 'copy_parameters', (1,), source_id=p['groups'][0]['id'],
                         parameters=['pre1', 'pre2'], values={'pre1': -100, 'pre2': -50}))
    assert p['version'] == before['version'] + 1
    expected = before['groups'][1]['parameters'] | {'pre1': -100, 'pre2': -50}
    assert p['groups'][1]['parameters'] == expected
    assert p['groups'][0] == before['groups'][0]
    p = accepted(command(client, p, 'reset_parameters', (1,), parameters=['pre1', 'pre2']))
    assert p['groups'][1]['parameters']['pre1'] is None
    assert p['groups'][1]['parameters']['pre2'] is None


@pytest.mark.parametrize('selection', [[], ['pre1', 'pre1'], ['pre1', 'nope'], 'pre1', [1], None])
def test_bad_parameter_lists_do_not_write(workspace, selection):
    store, p, client = workspace
    response = command(client, p, 'reset_parameters', parameters=selection)
    assert response.status_code == 400
    assert store.load(p['id']) == p


def test_parameter_selection_conflict_and_invalid_pair_roll_back(workspace):
    store, p, client = workspace
    for options in ({'parameters': ['pre1'], 'section': 'all'},
                    {'parameters': ['pre1'], 'parameter': 'pre1'},
                    {'parameters': ['pre1', 'pre2'], 'values': {'pre1': -20, 'pre2': -50}}):
        response = command(client, p, 'copy_parameters', (0, 1), source_id=p['groups'][2]['id'], **options)
        assert response.status_code == 400
        assert store.load(p['id']) == p


@pytest.mark.parametrize('section', ['background', 'forward', 'all'])
@pytest.mark.parametrize('scope', ['all', 'marked'])
def test_example_section_copy_preserves_automatic_k_limits_and_exact_scope(tmp_path, monkeypatch, section, scope):
    """The 10 K foil reaches k=25; the room-temperature targets stop earlier."""
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    p = store.create()
    p = store.command(p['id'], Command(version=p['version'], action='example'))
    with TestClient(create_app(settings)) as client:
        p = accepted(command(client, p, 'parameters', rbkg=1.2, kweight=3))
        p = accepted(command(client, p, 'metadata', (0, 2), marked=False))
        before = deepcopy(p)
        indices = tuple(range(4)) if scope == 'all' else tuple(
            i for i, group in enumerate(p['groups']) if group['marked'])
        changed = {p['groups'][i]['id'] for i in indices if i != 0}
        calls = []
        process = AthenaStore.process

        def counted_process(self, group, project=None):
            calls.append(group['id'])
            return process(self, group, project)

        monkeypatch.setattr(AthenaStore, 'process', counted_process)
        p = accepted(command(client, p, 'context_parameters', indices,
                             source_id=p['groups'][0]['id'], section=section,
                             values=p['groups'][0]['parameters']))
        assert set(calls) == changed and len(calls) == len(changed)
        assert p['version'] == before['version'] + 1
        assert len(p['history']) == len(before['history']) + 1
        assert len(p['undo']) == len(before['undo']) + 1
        assert not p['last_operation']['skipped_group_ids']
        for index, group in enumerate(p['groups']):
            if group['id'] not in changed:
                assert group == before['groups'][index]
                continue
            assert group['parameters']['bkg_kmax'] is None
            assert group['parameters']['kmax'] is None
            assert group['parameters']['rbkg'] == (1.2 if section in ('background', 'all') else 1.)
            assert group['parameters']['kweight'] == (3 if section in ('forward', 'all') else 2.)
            assert group['energy'] == before['groups'][index]['energy']
            assert group['mu'] == before['groups'][index]['mu']
            assert group['processing_error'] is None
            effective = group['result']['effective']
            assert effective['kmax'] < effective['available_kmax'] <= effective['bkg_kmax']
            if index >= 2:
                assert effective['bkg_kmax'] < before['groups'][0]['result']['effective']['bkg_kmax']
        assert store.load(p['id'])['groups'] == p['groups']
        restored = accepted(command(client, p, 'undo', ()))
        assert restored['groups'] == before['groups']


@pytest.mark.parametrize(('section', 'key'), [('background', 'bkg_kmax'), ('forward', 'kmax')])
def test_example_section_copy_never_relaxes_explicit_invalid_limits(tmp_path, section, key):
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings)
    p = store.create()
    p = store.command(p['id'], Command(version=p['version'], action='example'))
    with TestClient(create_app(settings)) as client:
        p = accepted(command(client, p, 'parameters', **{key: 24.}))
        response = command(client, p, 'context_parameters', (1, 2, 3),
                           source_id=p['groups'][0]['id'], section=section,
                           values=p['groups'][0]['parameters'])
        assert response.status_code == 400
        assert store.load(p['id']) == p


@pytest.mark.parametrize('draft_auto', [False, True])
def test_automatic_section_limits_replace_explicit_destination_limits(workspace, draft_auto):
    store, p, client = workspace
    p = accepted(command(client, p, 'parameters', (1,), bkg_kmax=7, kmax=6))
    if draft_auto:
        p = accepted(command(client, p, 'parameters', bkg_kmax=8, kmax=7))
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (1,),
                         source_id=p['groups'][0]['id'], section='all',
                         **({'values': {'bkg_kmax': None, 'kmax': None}} if draft_auto else {})))
    target = p['groups'][1]
    assert target['parameters']['bkg_kmax'] is None
    assert target['parameters']['kmax'] is None
    assert target['result']['effective']['bkg_kmax'] > 8
    assert target['result']['effective']['kmax'] > 7
    assert p['groups'][0] == before['groups'][0]
    assert p['groups'][2] == before['groups'][2]


def test_native_all_copies_exact_supported_sections_skips_source_and_frozen(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'parameters', (0,), step=.9, energy_shift=-2, rbkg=1.2,
                         bkg_dk=2, nclamp=8, kweight=3, bkg_window='parzen'))
    p = accepted(command(client, p, 'metadata', (0,), multiplier=2, offset=.25))
    p = accepted(command(client, p, 'edge_identity', (0,), element='Fe', edge='K'))
    p = accepted(command(client, p, 'metadata', (2,), frozen=True))
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (0, 1, 2), source_id=p['groups'][0]['id'],
                         section='all', values=p['groups'][0]['parameters'], metadata={'importance': 2.5}))
    source, target = p['groups'][:2]
    assert source == before['groups'][0]
    assert p['groups'][2] == before['groups'][2]
    assert p['last_operation']['skipped_group_ids'] == [p['groups'][2]['id']]
    assert target['parameters']['rbkg'] == 1.2
    assert target['parameters']['kweight'] == 3
    assert target['parameters']['pre1'] == source['result']['effective']['pre1']
    assert target['parameters']['norm2'] == source['result']['effective']['norm2']
    # Native copies fixed/automatic mode but does not copy the source's step.
    assert target['parameters']['step'] == before['groups'][1]['result']['effective']['edge_step']
    assert target['parameters']['step'] != source['parameters']['step']
    for key in ('energy_shift', 'bkg_dk', 'bkg_window', 'nclamp', 'fnorm', 'kstep', 'nfft'):
        assert target['parameters'][key] == before['groups'][1]['parameters'][key]
    assert target['source']['importance'] == 2.5
    assert target['source']['edge_identity']['element'] == 'Fe'
    assert target['result']['effective']['element'] == 'Fe'
    assert target['multiplier'] == 2 and target['offset'] == .25
    assert target['energy'] == before['groups'][1]['energy']
    assert target['mu'] == before['groups'][1]['mu']


def test_native_group_and_plot_only_copy_dont_reprocess_and_reset(workspace):
    store, p, client = workspace
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'],
                         section='plot', metadata={'multiplier': 4, 'offset': -.5}))
    assert p['groups'][1]['result'] == before['groups'][1]['result']
    assert p['groups'][1]['parameters'] == before['groups'][1]['parameters']
    p = accepted(command(client, p, 'context_parameters', (1,), mode='reset', section='plot'))
    assert p['groups'][1]['multiplier'] == 1 and p['groups'][1]['offset'] == 0
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'],
                         section='group', metadata={'element': 'Zn', 'edge': 'K', 'importance': 3}))
    assert p['groups'][1]['source']['importance'] == 3
    assert p['groups'][1]['result']['effective']['element'] == 'Zn'
    p = accepted(command(client, p, 'context_parameters', (1,), mode='reset', section='group'))
    assert p['groups'][1]['source']['importance'] == 1
    assert p['groups'][1]['source']['edge_identity']['element'] == 'Cu'


def test_native_copy_dependency_guards_and_validation_roll_back(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'background_standard', (2,), standard_id=p['groups'][1]['id']))
    p = accepted(command(client, p, 'metadata', (2,), frozen=True))
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'],
                         section='all', values={'rbkg': 1.3}, metadata={'importance': 4}))
    assert p['groups'] == before['groups']
    assert p['last_operation']['skipped_group_ids'] == [p['groups'][1]['id']]
    for options in ({'metadata': {'importance': -1}}, {'metadata': {'element': 'Cu'}},
                    {'metadata': {'element': 'fake', 'edge': 'K'}}, {'values': {'bogus': 2}},
                    {'section': 'invalid'}, {'mode': 'reset', 'values': {'rbkg': 1.3}}):
        response = command(client, p, 'context_parameters', (0,), source_id=p['groups'][1]['id'], **options)
        assert response.status_code == 400, response.text
        assert store.load(p['id']) == p


def test_single_metadata_fields_and_fix_step_are_independent(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'metadata', importance=4, multiplier=3, offset=.4))
    p = accepted(command(client, p, 'parameters', step=.95))
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'], field='importance'))
    expected = deepcopy(before['groups'][1])
    expected['source']['importance'] = 4.
    assert p['groups'][1] == expected
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'], field='multiplier'))
    assert p['groups'][1]['multiplier'] == 3 and p['groups'][1]['offset'] == 0
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'], field='fix_step'))
    assert p['groups'][1]['parameters']['step'] == before['groups'][1]['result']['effective']['edge_step']
    assert p['groups'][1]['parameters']['step'] != .95
    p = accepted(command(client, p, 'parameters', step=None))
    p = accepted(command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'], field='fix_step'))
    assert p['groups'][1]['parameters']['step'] is None
    p = accepted(command(client, p, 'context_parameters', (1,), mode='reset', field='importance'))
    assert p['groups'][1]['source']['importance'] == 1
    bad = command(client, p, 'context_parameters', (1,), source_id=p['groups'][0]['id'], field='importance', section='group')
    assert bad.status_code == 400
    assert store.load(p['id']) == p


def test_importance_http_validates_frozen_state_and_native_export(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'metadata', importance=2.75))
    content = b'\n'.join(line for line in gzip.decompress(store.export_prj(p)).splitlines() if not line.startswith(b'# Athena-Web '))
    parsed = store._parse_project(content, 'test.prj')
    assert parsed['groups'][0]['source']['native']['args']['importance'] == 2.75
    for value in (-1, True, '3'):
        assert command(client, p, 'metadata', importance=value).status_code == 400
        assert store.load(p['id']) == p
    p = accepted(command(client, p, 'metadata', frozen=True))
    assert command(client, p, 'metadata', importance=4).status_code == 400
    assert store.load(p['id']) == p


def test_bla_ratios_use_explicit_xdi_metadata_skip_missing_and_frozen(workspace):
    store, p, client = workspace
    for group, value in zip(p['groups'], ('0.75', 'nan', '0.5')):
        group['source']['xdi_metadata'] = {'attributes': {'bla': {'pixel_ratio': value}}}
    p['groups'][2]['frozen'] = True
    store.storage.write_json(p['id'], 'project.json', p)
    before = deepcopy(p)
    p = accepted(command(client, p, 'context_parameters', (0, 1, 2), mode='pixel_ratio', field='importance'))
    assert p['groups'][0]['source']['importance'] == .75
    assert p['groups'][1:] == before['groups'][1:]
    assert set(p['last_operation']['skipped_reasons']) == {g['id'] for g in p['groups'][1:]}
    p = accepted(command(client, p, 'context_parameters', (0,), mode='pixel_ratio', field='multiplier'))
    assert p['groups'][0]['multiplier'] == .75
    assert p['groups'][0]['parameters'] == before['groups'][0]['parameters']
    assert p['groups'][0]['result'] == before['groups'][0]['result']
    assert command(client, p, 'context_parameters', mode='pixel_ratio', field='offset').status_code == 400
    assert store.load(p['id']) == p


def report(client, p, kind, indices=(0,), **extra):
    return client.post(f"/api/athena/projects/{p['id']}/context-report", json={
        'version': p['version'], 'kind': kind,
        'group_ids': [p['groups'][i]['id'] for i in indices], **extra})


def test_noise_diagnostics_match_native_template_without_mutation(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'metadata', (0,), frozen=True))
    data = accepted(report(client, p, 'measurement_uncertainty', (0, 1, 2)))
    assert len(data['results']) == 3 and not data['skipped']
    for group, result in zip(p['groups'], data['results']):
        arrays, effective, params = group['result']['arrays'], group['result']['effective'], group['parameters']
        expected = Group()
        estimate_noise(np.asarray(arrays['k']), np.asarray(arrays['chi']), group=expected,
                       kmin=effective['kmin'], kmax=effective['kmax'], dk=params['dk'], dk2=params['dk'],
                       window=params['window'], kweight=params['kweight'])
        assert result['epsilon_k'] == float(f'{expected.epsilon_k:.3e}')
        assert result['epsilon_r'] == float(f'{expected.epsilon_r:.3e}')
        assert result['nidp'] == pytest.approx(2 * (effective['kmax'] - effective['kmin']) * 2 / np.pi)
    assert store.load(p['id']) == p
    stale = report(client, p | {'version': p['version'] - 1}, 'measurement_uncertainty')
    assert stale.status_code == 409
    assert store.load(p['id']) == p


def test_edge_step_sampling_is_reproducible_read_only_and_fixed_step_is_zero(workspace):
    store, p, client = workspace
    response = accepted(report(client, p, 'edge_step_uncertainty'))
    result = response['results'][0]
    assert result['samples'] == 21
    assert 2 <= result['retained_samples'] <= 21
    assert result['standard_deviation'] > 0
    assert abs(result['mean'] - result['edge_step']) < .05
    assert response == accepted(report(client, p, 'edge_step_uncertainty'))
    assert store.load(p['id']) == p
    p = accepted(command(client, p, 'parameters', step=.85))
    fixed = accepted(report(client, p, 'edge_step_uncertainty'))['results'][0]
    assert fixed['standard_deviation'] == pytest.approx(0, abs=1e-15)
    assert fixed['mean'] == pytest.approx(.85)
    assert fixed['warnings']
    assert store.load(p['id']) == p


def test_edge_step_native_outlier_pass_runs_even_when_initial_mean_is_close(workspace, monkeypatch):
    _, p, _ = workspace
    group = deepcopy(p['groups'][0])
    group['result']['effective']['edge_step'] = 1.
    sample_values = [.99, 1.01] * 9 + [.99, 1.7]
    calls = []
    def sampled_normalization(energy, mu, *, group, **kwargs):
        calls.append(kwargs)
        group.edge_step = sample_values[len(calls) - 1]
    monkeypatch.setattr('xraylarch_web.athena_context.pre_edge', sampled_normalization)
    result = edge_step_uncertainty(group)
    assert len(calls) == 20
    assert result['retained_samples'] == 20
    assert result['mean'] == pytest.approx(.9995)
    assert result['standard_deviation'] == pytest.approx(np.std([1.] + sample_values[:-1], ddof=1))
    assert 'margin = 2.5' in result['report']
    for call in calls:
        for key, bubble in zip(('pre1', 'pre2', 'norm1', 'norm2'), (20, 10, 15, 30)):
            assert abs(call[key] - group['result']['effective'][key]) <= bubble


def test_report_skips_unavailable_arrays_without_invented_noise(workspace):
    store, p, client = workspace
    p = accepted(command(client, p, 'change_datatype', (0,), data_type='xanes'))
    data = accepted(report(client, p, 'measurement_uncertainty', (0, 1)))
    assert len(data['results']) == 1 and data['results'][0]['group_id'] == p['groups'][1]['id']
    assert len(data['skipped']) == 1 and data['skipped'][0]['reason']
    assert store.load(p['id']) == p


def test_r123_recomputes_three_transforms_without_changing_saved_arrays(workspace):
    store, p, client = workspace
    group = p['groups'][0]
    response = client.post(f"/api/athena/projects/{p['id']}/context-plot", json={
        'version': p['version'], 'group_id': group['id'], 'kind': 'r123'})
    result = accepted(response)
    assert [curve['kweight'] for curve in result['curves']] == [1, 2, 3]
    source = group['result']['arrays']
    effective, params = group['result']['effective'], group['parameters']
    for curve in result['curves']:
        expected = Group()
        k = np.asarray(source['k'])
        xftf(k, np.asarray(source['chi']) * k**curve['kweight'], group=expected, kweight=0,
             kmin=effective['kmin'], kmax=effective['kmax'], dk=params['dk'], window=params['window'],
             nfft=params['nfft'], kstep=params['kstep'], rmax_out=effective['rmax_out'])
        np.testing.assert_allclose(curve['arrays']['r'], expected.r)
        np.testing.assert_allclose(curve['arrays']['chir_mag'], expected.chir_mag)
        assert all(len(values) == len(expected.r) for values in curve['arrays'].values())
    assert store.load(p['id']) == p


def test_source_text_only_reads_original_retained_upload(workspace, synthetic_xmu_bytes):
    store, p, client = workspace
    prefix = f"/api/athena/projects/{p['id']}"
    inspected = accepted(client.post(prefix + '/inspect', files={'file': ('scan.dat', synthetic_xmu_bytes)}))
    ids = [col['column_id'] for col in inspected['columns']]
    p = accepted(client.post(prefix + '/import', json={'version': p['version'],
        'upload_id': inspected['upload_id'], 'energy_column': ids[0], 'numerator': [ids[1]]}))
    imported = p['groups'][-1]
    result = accepted(client.get(prefix + f"/groups/{imported['id']}/source-text"))
    assert result == {'filename': 'scan.dat', 'kind': 'original', 'text': synthetic_xmu_bytes.decode()}
    assert client.get(prefix + f"/groups/{p['groups'][0]['id']}/source-text").status_code == 400
    assert store.load(p['id']) == p
    # A restored native OS pathname must never grant access to that path.
    forged = deepcopy(p)
    forged['groups'][0]['source']['filename'] = '/etc/passwd'
    forged['groups'][0]['source']['source_file'] = '/etc/passwd'
    forged['groups'][0]['source']['native'] = {'args': {'file': '/etc/passwd'}}
    store.storage.write_json(p['id'], 'project.json', forged)
    assert client.get(prefix + f"/groups/{p['groups'][0]['id']}/source-text").status_code == 400
    assert store.load(p['id']) == forged
