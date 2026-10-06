"""Normalization status and EXAFS processing are independent energy settings."""
from copy import deepcopy
from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import pre_edge
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def workspace(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path))
    raw = np.loadtxt(Path(__file__).parents[2] / 'examples/xafsdata/cu_rt01.xmu')
    return store, store.create(), raw[:, 0], raw[:, 1]


def change(store, project, **options):
    return store.command(project['id'], Command(version=project['version'], action='change_datatype',
        group_ids=[g['id'] for g in project['groups']], options=options))


def inspect(store, project, x, y):
    stream = StringIO()
    np.savetxt(stream, np.column_stack([x, y]), header='energy mu', fmt='%.17g')
    info = store.inspect(project['id'], stream.getvalue().encode(), 'normalized-copper.dat')
    return info, {column['name']: column['column_id'] for column in info['columns']}


@pytest.mark.parametrize('normalized', [False, True])
@pytest.mark.parametrize('exafs', [False, True])
def test_independent_settings_preserve_state_and_undo(workspace, normalized, exafs, monkeypatch):
    store, project, x, y = workspace
    group = store.make_group('Copper', x, y, data_type='xanes', parameters={
        'e0': 8980.25, 'energy_shift': 1.25, 'pre1': -150, 'pre2': -30, 'norm1': 100, 'norm2': 300},
        source={'filename': 'copper.dat', 'raw_arrays': {'i0': np.ones(len(x)).tolist()}})
    group.update(frozen=True, notes='Preserve original acquisition', marked=False)
    project['groups'].append(group)
    project = store.save(project, store.load(project['id']), 'Fixture')
    before = deepcopy(project)
    if normalized:
        def forbidden(*args, **kwargs):
            pytest.fail('Already-normalized input must not refit pre_edge')
        monkeypatch.setattr('xraylarch_web.athena_science.pre_edge', forbidden)

    updated = change(store, project, is_normalized=normalized, exafs=exafs)
    actual = updated['groups'][0]
    expected_type = ('norm' if normalized else 'mu') if exafs else 'xanes'
    assert actual['data_type'] == expected_type
    assert actual['is_normalized'] is normalized
    assert actual['processing_error'] is None
    for key in ('energy', 'mu', 'parameters', 'source', 'reference_id', 'background_standard_id',
                'frozen', 'marked', 'notes', 'multiplier', 'offset'):
        assert actual[key] == group[key]
    assert actual['result']['effective']['exafs'] is exafs
    for array in ('chi', 'chir_mag', 'chiq_mag'):
        assert bool(actual['result']['arrays'][array]) is exafs
    if normalized:
        np.testing.assert_array_equal(actual['result']['arrays']['norm'], y)
        assert actual['result']['effective']['edge_step'] == 1
    else:
        direct = Group()
        pre_edge(x + 1.25, y, group=direct, e0=8980.25, pre1=-150, pre2=-30, norm1=100, norm2=300)
        np.testing.assert_allclose(actual['result']['arrays']['norm'], direct.norm, rtol=1e-12, atol=1e-12)
    undone = store.command(project['id'], Command(version=updated['version'], action='undo'))
    assert undone['groups'] == before['groups']


@pytest.mark.parametrize('options', [
    {'is_normalized': True}, {'exafs': False}, {'is_normalized': 1, 'exafs': True},
    {'is_normalized': True, 'exafs': 'false'},
    {'is_normalized': True, 'exafs': False, 'data_type': 'xanes'},
    {'is_normalized': True, 'exafs': False, 'toggle': False},
])
def test_ambiguous_processing_requests_are_atomic(workspace, options):
    store, project, x, y = workspace
    project['groups'].append(store.make_group('Copper', x, y))
    project = store.save(project, store.load(project['id']), 'Fixture')
    with pytest.raises(WebInputError):
        change(store, project, **options)
    assert store.load(project['id']) == project


@pytest.mark.parametrize('data_type,normalized,exafs', [
    ('mu', False, True), ('norm', True, True), ('xanes', False, False), ('xanes', True, False)])
def test_import_and_preview_accept_all_energy_settings(workspace, data_type, normalized, exafs):
    store, project, x, y = workspace
    info, ids = inspect(store, project, x, y)
    request = ImportRequest(version=0, upload_id=info['upload_id'], energy_column=ids['energy'],
                            numerator=[ids['mu']], data_type=data_type, is_normalized=normalized, exafs=exafs)
    with TestClient(create_app(store.settings)) as client:
        preview = client.post(f'/api/athena/projects/{project["id"]}/preview-columns', json=request.model_dump())
        response = client.post(f'/api/athena/projects/{project["id"]}/import', json=request.model_dump())
    assert preview.status_code == 200, preview.text
    assert response.status_code == 200, response.text
    actual = response.json()['groups'][0]
    assert actual['data_type'] == data_type and actual['is_normalized'] is normalized
    assert actual['processing_error'] is None
    assert actual['result']['effective']['exafs'] is exafs
    assert preview.json()['traces'][0]['y'] == actual['mu']
    assert actual['source']['mapping']['is_normalized'] is normalized
    assert actual['source']['mapping']['exafs'] is exafs
    if normalized:
        np.testing.assert_array_equal(actual['result']['arrays']['norm'], y)
    remembered, _ = inspect(store, store.load(project['id']), x, y)
    assert remembered['remembered_columns']['mapping']['is_normalized'] is normalized
    assert remembered['remembered_columns']['mapping']['exafs'] is exafs


@pytest.mark.parametrize('enforced', [False, True])
@pytest.mark.parametrize('rebinned', [False, True])
def test_normalized_xanes_import_and_rebin_never_refit(workspace, enforced, rebinned, monkeypatch):
    store, project, x, y = workspace
    direct = Group()
    pre_edge(x, y, group=direct)
    normalized = direct.norm
    info, ids = inspect(store, project, x, normalized)
    request = ImportRequest(version=0, upload_id=info['upload_id'], energy_column=ids['energy'],
        numerator=[ids['mu']], data_type='xanes', is_normalized=True, exafs=False,
        edge_policy={'element': 'Cu', 'edge': 'K'} if enforced else None,
        rebin={} if rebinned else None,
        reference_numerator=ids['mu'], reference_log=False)
    def forbidden(*args, **kwargs):
        pytest.fail('Normalized XANES must not fit normalization during preview, E0 selection, or import')
    monkeypatch.setattr('xraylarch_web.athena_import_policy._normalized', forbidden)
    monkeypatch.setattr('xraylarch_web.athena_science.pre_edge', forbidden)
    preview = store.preview_columns(project['id'], request)
    imported = store.import_data(project['id'], request)
    assert len(imported['groups']) == 2
    for actual in imported['groups']:
        assert actual['data_type'] == 'xanes' and actual['is_normalized'] is True
        assert actual['processing_error'] is None
        assert actual['result']['arrays']['norm'] == actual['mu']
        assert actual['result']['arrays']['chi'] == []
    sample = imported['groups'][0]
    if rebinned:
        trace = next(trace for trace in preview['traces'] if trace['role'] == 'sample' and trace['stage'] == 'rebinned')
        assert trace['y'] == sample['mu']
    else:
        np.testing.assert_array_equal(sample['mu'], normalized)
    if enforced:
        assert sample['source']['e0_selection']['method'] == 'fraction'
        assert sample['parameters']['norm1'] is None


def test_reimport_keeps_current_normalization_after_processing_change(workspace, monkeypatch):
    store, project, x, y = workspace
    info, ids = inspect(store, project, x, y)
    project = store.import_data(project['id'], ImportRequest(version=0, upload_id=info['upload_id'],
        energy_column=ids['energy'], numerator=[ids['mu']]))
    def forbidden(*args, **kwargs):
        pytest.fail('Reimport must retain the current normalized-input setting')
    monkeypatch.setattr('xraylarch_web.athena_science.pre_edge', forbidden)
    project = change(store, project, is_normalized=True, exafs=False)
    original = project['groups'][0]
    info = store.inspect_group_columns(project['id'], original['id'])
    assert info['current_mapping']['is_normalized'] is True
    assert info['current_mapping']['data_type'] == 'xanes'
    assert info['current_mapping']['exafs'] is False
    request = ImportRequest.model_validate(info['current_mapping'] | {
        'version': project['version'], 'upload_id': info['upload_id']})
    project = store.import_data(project['id'], request, replace_group_id=original['id'])
    actual = project['groups'][0]
    assert actual['id'] == original['id'] and actual['data_type'] == 'xanes'
    assert actual['is_normalized'] is True and actual['processing_error'] is None
    assert actual['result']['arrays']['norm'] == original['mu']


@pytest.mark.parametrize('data_type,flag', [('norm', False), ('xmudat', False), ('chi', True), ('xanes', 'true')])
def test_import_rejects_inconsistent_normalization(data_type, flag):
    with pytest.raises(ValidationError):
        ImportRequest(version=0, upload_id='upload', energy_column='energy', numerator=['mu'],
                      data_type=data_type, is_normalized=flag)


@pytest.mark.parametrize('data_type,flag', [('mu', False), ('norm', False), ('xanes', True),
    ('chi', True), ('xmudat', True), ('mu', 'true')])
def test_import_rejects_inconsistent_exafs(data_type, flag):
    with pytest.raises(ValidationError):
        ImportRequest(version=0, upload_id='upload', energy_column='energy', numerator=['mu'],
                      data_type=data_type, exafs=flag)


def test_explicit_exafs_short_scan_keeps_mode_with_usable_recipe():
    from scipy.special import expit
    from xraylarch_web.athena_import_policy import initialize_import
    from xraylarch_web.athena_science import process_spectrum
    x = np.linspace(8779, 9059, 561)
    y = .2 + 1.8 * expit((x - 8982) / 2.5)
    params = {'norm1': 15, 'norm2': 70, 'kmin': 0, 'kmax': 3}
    policy = {'element': 'Cu', 'edge': 'K'}
    legacy = initialize_import(x, y, params, policy=policy)
    explicit = initialize_import(x, y, params, policy=policy, exafs=True)
    assert legacy['data_type'] == 'xanes'
    assert explicit['data_type'] == 'mu' and explicit['defaults']['short_scan']
    result = process_spectrum(x, y, explicit['parameters'], explicit['data_type'])
    assert result['effective']['exafs'] and result['arrays']['chi']


def test_explicit_exafs_short_import_reports_unusable_defaults_without_changing_mode(workspace):
    from scipy.special import expit
    store, project, _, _ = workspace
    x = np.linspace(8779, 9059, 561)
    y = .2 + 1.8 * expit((x - 8982) / 2.5)
    info, ids = inspect(store, project, x, y)
    request = ImportRequest(version=0, upload_id=info['upload_id'], energy_column=ids['energy'],
        numerator=[ids['mu']], data_type='mu', is_normalized=False, exafs=True,
        edge_policy={'element': 'Cu', 'edge': 'K'})
    with pytest.raises(WebInputError, match='Import normalization ranges'):
        store.import_data(project['id'], request)
    assert store.load(project['id']) == project
    legacy = store.import_data(project['id'], request.model_copy(update={'exafs': None}))
    assert legacy['groups'][0]['data_type'] == 'xanes'


@pytest.mark.parametrize('normalized', [False, True])
@pytest.mark.parametrize('enforced', [False, True])
@pytest.mark.parametrize('end,expected_exafs', [(9049, False), (9479, True)])
def test_automatic_import_uses_each_spectrums_range_and_preserves_input(workspace, normalized, enforced, end, expected_exafs):
    from scipy.special import expit
    store, project, _, _ = workspace
    x = np.linspace(8779, end, 1001)
    y = expit((x - 8983) / 2.5)
    if not normalized:
        y = .2 + 1.8 * y
    info, ids = inspect(store, project, x, y)
    request = ImportRequest(version=0, upload_id=info['upload_id'], energy_column=ids['energy'],
        numerator=[ids['mu']], data_type='norm' if normalized else 'mu',
        edge_policy={'element': 'Cu', 'edge': 'K'} if enforced else None)
    imported = store.import_data(project['id'], request)
    actual = imported['groups'][0]
    assert actual['data_type'] == (('norm' if normalized else 'mu') if expected_exafs else 'xanes')
    assert actual['is_normalized'] is normalized
    assert actual['processing_error'] is None
    assert actual['result']['effective']['exafs'] is expected_exafs
    assert bool(actual['result']['arrays']['chi']) is expected_exafs
    np.testing.assert_array_equal(actual['energy'], x)
    np.testing.assert_array_equal(actual['mu'], y)
    assert actual['source']['mapping']['exafs'] is None
    if normalized:
        np.testing.assert_array_equal(actual['result']['arrays']['norm'], y)
    if not expected_exafs:
        assert any('EXAFS' in warning and 'XANES' in warning for warning in actual['result']['warnings'])
    assert store.load(project['id']) == imported


def test_automatic_import_keeps_normalization_when_sampling_cannot_support_autobk(workspace):
    from scipy.special import expit
    store, _, _, _ = workspace
    # Long support, but a gap leaves multiple requested spline knots at the
    # same measured point. The pre/post-edge fits remain well supported.
    x = np.r_[np.linspace(8779, 9030, 503), np.linspace(9470, 9479, 20)]
    y = .2 + 1.8 * expit((x - 8983) / 2.5)
    explicit = store.make_import_group('Sparse', x, y, exafs=True)
    assert 'spline knots' in explicit['processing_error']
    assert explicit['data_type'] == 'mu'
    automatic = store.make_import_group('Sparse', x, y)
    assert automatic['processing_error'] is None
    assert automatic['data_type'] == 'xanes'
    assert automatic['result']['arrays']['norm']
    assert automatic['result']['arrays']['chi'] == []
    assert automatic['result']['effective']['exafs'] is False
    warning = next(w for w in automatic['result']['warnings'] if 'Automatic EXAFS' in w)
    assert 'spline knots' in warning and warning in automatic['source']['warnings']
    np.testing.assert_array_equal(automatic['energy'], x)
    np.testing.assert_array_equal(automatic['mu'], y)


def test_automatic_import_does_not_hide_invalid_normalization(workspace):
    store, _, _, _ = workspace
    x = np.linspace(8779, 9479, 1001)
    invalid = store.make_import_group('Constant', x, np.ones_like(x))
    assert invalid['data_type'] == 'mu'
    assert 'constant' in invalid['processing_error']
    assert invalid['result'] is None
    with pytest.raises(WebInputError, match='normalization flag'):
        store.make_import_group('Invalid normalized flag', x, np.ones_like(x), data_type='norm', is_normalized=False)


def test_automatic_short_import_can_enable_exafs_later(workspace):
    from scipy.special import expit
    store, project, _, _ = workspace
    x = np.linspace(8779, 9049, 1001)
    y = .2 + 1.8 * expit((x - 8983) / 2.5)
    group = store.make_import_group('Near edge', x, y)
    assert group['data_type'] == 'xanes'
    project['groups'].append(group)
    project = store.save(project, store.load(project['id']), 'Fixture')
    changed = change(store, project, is_normalized=False, exafs=True)['groups'][0]
    assert changed['data_type'] == 'mu' and changed['processing_error'] is None
    assert changed['result']['effective']['exafs'] is True
    assert changed['energy'] == group['energy'] and changed['mu'] == group['mu']
    assert not any('Automatic EXAFS' in w for w in changed['result']['warnings'])


@pytest.mark.parametrize('enforced', [False, True])
def test_automatic_import_notice_survives_import_parameter_copy(workspace, enforced):
    from scipy.special import expit
    store, project, _, _ = workspace
    x = np.linspace(8779, 9049, 1001)
    y = .2 + 1.8 * expit((x - 8983) / 2.5)
    standard = store.make_group('Standard', x, y, data_type='xanes', parameters={'norm1': 15, 'norm2': 50})
    project['groups'].append(standard)
    project = store.save(project, store.load(project['id']), 'Fixture')
    info, ids = inspect(store, project, x, y)
    request = ImportRequest(version=project['version'], upload_id=info['upload_id'],
        energy_column=ids['energy'], numerator=[ids['mu']],
        edge_policy={'element': 'Cu', 'edge': 'K'} if enforced else None,
        preprocessing={'standard_id': standard['id'], 'copy_parameters': True})
    group = store.import_data(project['id'], request)['groups'][-1]
    assert group['data_type'] == 'xanes' and group['processing_error'] is None
    assert group['parameters']['norm2'] == 50
    notes = [w for w in group['result']['warnings'] if w.startswith('Automatic EXAFS')]
    assert len(notes) == 1 and notes[0] in group['source']['warnings']
