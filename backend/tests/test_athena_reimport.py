"""Reopening import columns replaces one spectrum atomically and on demand."""
import copy
from io import StringIO

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def imported(tmp_path, xas_arrays, *, reverse=False, rebin=False, is_reference=False):
    x, mu = xas_arrays
    table = np.column_stack([x / 1000, np.full(len(x), 10000), 10000 * np.exp(-mu), 20000 * mu])
    output = StringIO()
    np.savetxt(output, table[::-1] if reverse else table, header='energy i0 it ifluor', fmt='%.17g')
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    info = store.inspect(project['id'], output.getvalue().encode(), 'detectors.dat')
    ids = {column['name']: column['column_id'] for column in info['columns']}
    request = ImportRequest(version=0, upload_id=info['upload_id'], energy_column=ids['energy'],
        units='keV', numerator=[ids['i0']], denominator=ids['it'], mode='transmission',
        sort=reverse, data_type='xanes', rebin={'e0': 8980} if rebin else None, is_reference=is_reference)
    return store, store.import_data(project['id'], request), info, ids


def replacement(store, project, ids):
    group = project['groups'][0]
    info = store.inspect_group_columns(project['id'], group['id'])
    request = ImportRequest.model_validate(info['current_mapping'] | {
        'version': info['version'], 'upload_id': info['upload_id'], 'mode': 'fluorescence',
        'numerator': [ids['ifluor']], 'denominator': ids['i0']})
    return group, info, request


def test_reimport_preserves_identity_and_presentation_with_one_undo(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays, is_reference=True)
    original = project['groups'][0]
    original.update(label='My spectrum', notes='keep me', marked=False, multiplier=3.0, offset=2.0)
    other = store.make_group('Other', *xas_arrays, data_type='xanes')
    project['groups'].append(other)
    store.storage.write_json(project['id'], 'project.json', project)
    before = copy.deepcopy(project)
    group, info, request = replacement(store, project, ids)
    assert store.load(project['id']) == before  # Opening the dialog has no project mutation.
    assert info['row_count'] == len(xas_arrays[0])
    preview = store.preview_columns(project['id'], request)
    result = store.import_data(project['id'], request, replace_group_id=group['id'])
    assert result['version'] == project['version'] + 1
    assert len(result['undo']) == len(before['undo']) + 1
    assert len(result['groups']) == 2 and result['groups'][1] == other
    updated = result['groups'][0]
    for key in ('id', 'label', 'notes', 'marked', 'multiplier', 'offset'):
        assert updated[key] == group[key]
    np.testing.assert_allclose(updated['mu'], 2 * xas_arrays[1], atol=1e-14)
    assert updated['mu'] == preview['traces'][0]['y']
    assert updated['result'] != group['result'] and updated['can_reimport_columns']
    assert updated['source']['mapping']['is_reference'] is True
    undone = store.command(project['id'], Command(version=result['version'], action='undo'))
    assert undone['groups'] == before['groups']
    redone = store.command(project['id'], Command(version=undone['version'], action='redo'))
    assert redone['groups'] == result['groups']


@pytest.mark.parametrize('rebin', [False, True])
def test_retained_columns_work_after_upload_cache_is_removed(tmp_path, xas_arrays, rebin):
    store, project, upload, ids = imported(tmp_path, xas_arrays, reverse=True, rebin=rebin)
    for extension in ('npz', 'json', 'source'):
        store.storage.path(project['id'], f"upload-{upload['upload_id']}.{extension}").unlink(missing_ok=True)
    group, info, request = replacement(store, project, ids)
    assert info['row_count'] == len(xas_arrays[0])
    request.rebin = None
    result = store.import_data(project['id'], request, replace_group_id=group['id'])
    np.testing.assert_allclose(result['groups'][0]['energy'], xas_arrays[0], atol=1e-10)
    np.testing.assert_allclose(result['groups'][0]['mu'], 2 * xas_arrays[1], atol=1e-14)


@pytest.mark.parametrize('invalid', ['version', 'frozen', 'multiple', 'unbound', 'invalid_column', 'ordinary_import'])
def test_invalid_reimport_leaves_project_unchanged(tmp_path, xas_arrays, invalid):
    store, project, upload, ids = imported(tmp_path, xas_arrays)
    group, info, request = replacement(store, project, ids)
    if invalid == 'version':
        request.version -= 1
    elif invalid == 'frozen':
        project['groups'][0]['frozen'] = True
        store.storage.write_json(project['id'], 'project.json', project)
    elif invalid == 'multiple':
        request.individual_channels = True
    elif invalid == 'unbound':
        request.upload_id = upload['upload_id']
    elif invalid == 'invalid_column':
        request.numerator = ['missing']
    before = store.load(project['id'])
    with pytest.raises(ValueError):
        store.import_data(project['id'], request, replace_group_id=None if invalid == 'ordinary_import' else group['id'])
    assert store.load(project['id']) == before


def test_derived_and_source_less_groups_are_not_available(tmp_path, xas_arrays):
    store, project, _, _ = imported(tmp_path, xas_arrays)
    source = copy.deepcopy(project['groups'][0]['source']) | {'operation': 'smooth'}
    for group in (store.make_group('Derived', *xas_arrays, data_type='xanes', source=source),
                  store.make_group('No table', *xas_arrays, data_type='xanes')):
        assert group['can_reimport_columns'] is False
        project['groups'].append(group)
        store.storage.write_json(project['id'], 'project.json', project)
        with pytest.raises(ValueError, match='unavailable'):
            store.inspect_group_columns(project['id'], group['id'])


def test_background_dependents_reprocessed_and_frozen_dependents_rejected(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays)
    standard = project['groups'][0]
    standard['data_type'] = 'mu'
    store.process(standard, project)
    dependent = store.make_group('Dependent', *xas_arrays, background_standard_id=standard['id'], project=project)
    project['groups'].append(dependent)
    store.storage.write_json(project['id'], 'project.json', project)
    group, _, request = replacement(store, project, ids)
    request.data_type = 'mu'
    dependent['frozen'] = True
    store.storage.write_json(project['id'], 'project.json', project)
    with pytest.raises(ValueError, match='Unfreeze'):
        store.import_data(project['id'], request, replace_group_id=group['id'])
    assert store.load(project['id']) == project
    dependent['frozen'] = False
    store.storage.write_json(project['id'], 'project.json', project)
    result = store.import_data(project['id'], request, replace_group_id=group['id'])
    assert result['group_versions'][dependent['id']] == result['version']
    assert result['groups'][1]['background_standard_id'] == group['id']
    assert result['groups'][1]['result'] != dependent['result']


def test_group_reimport_api(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays)
    client = TestClient(create_app(store.settings))
    group = project['groups'][0]
    prefix = f"/api/athena/projects/{project['id']}/groups/{group['id']}"
    response = client.get(prefix + '/columns')
    assert response.status_code == 200
    info = response.json()
    assert 'column_arrays' not in info
    source = client.get(f"/api/athena/projects/{project['id']}/uploads/{info['upload_id']}/file")
    assert source.status_code == 200 and b'energy i0 it ifluor' in source.content
    request = info['current_mapping'] | {'version': info['version'], 'upload_id': info['upload_id'],
        'mode': 'fluorescence', 'numerator': [ids['ifluor']], 'denominator': ids['i0']}
    response = client.post(prefix + '/reimport', json=request)
    assert response.status_code == 200
    assert len(response.json()['groups']) == 1
    assert response.json()['groups'][0]['id'] == group['id']


def test_reimport_keeps_reference_links_and_shared_shift(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays)
    sample = project['groups'][0]
    reference = store.make_group('Reference', *xas_arrays, data_type='xanes')
    sample['reference_id'] = reference['id']
    sample['parameters']['energy_shift'] = reference['parameters']['energy_shift'] = 4.5
    reference['frozen'] = True
    project['groups'].append(reference)
    store.storage.write_json(project['id'], 'project.json', project)
    group, _, request = replacement(store, project, ids)
    result = store.import_data(project['id'], request, replace_group_id=group['id'])
    assert result['groups'][1] == reference
    assert result['groups'][0]['reference_id'] == reference['id']
    assert result['groups'][0]['parameters']['energy_shift'] == 4.5
    np.testing.assert_allclose(result['groups'][0]['result']['arrays']['energy'], xas_arrays[0] + 4.5)
    group, _, request = replacement(store, result, ids)
    request.data_type = 'chi'
    with pytest.raises(ValueError, match='Untie'):
        store.import_data(project['id'], request, replace_group_id=group['id'])


def test_inspection_token_stays_bound_to_its_project_revision(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays)
    group, _, request = replacement(store, project, ids)
    changed = store.command(project['id'], Command(version=project['version'], action='project', options={'name': 'New name'}))
    request.version = changed['version']
    with pytest.raises(ValueError, match='another tab'):
        store.import_data(project['id'], request, replace_group_id=group['id'])
    assert store.load(project['id']) == changed


def test_original_cached_columns_restore_points_removed_since_import(tmp_path, xas_arrays):
    store, project, _, ids = imported(tmp_path, xas_arrays)
    group = project['groups'][0]
    group['energy'] = group['energy'][20:]
    group['mu'] = group['mu'][20:]
    for key in ('column_arrays', 'raw_arrays'):
        group['source'][key] = {name: values[20:] for name, values in group['source'][key].items()}
    store.storage.write_json(project['id'], 'project.json', project)
    group, info, request = replacement(store, project, ids)
    assert info['row_count'] == len(xas_arrays[0])
    result = store.import_data(project['id'], request, replace_group_id=group['id'])
    assert len(result['groups'][0]['energy']) == len(xas_arrays[0])


def test_reopening_same_revision_reuses_staging_without_reading_arrays(tmp_path, xas_arrays, monkeypatch):
    store, project, _, _ = imported(tmp_path, xas_arrays)
    group = project['groups'][0]
    first = store.inspect_group_columns(project['id'], group['id'])
    directory = store.storage.workspace_dir(project['id'])
    files = {path.name for path in directory.iterdir()}
    monkeypatch.setattr(store.storage, 'read_arrays', lambda *args: pytest.fail('Cached inspection must not read detector arrays.'))
    for _ in range(3):
        assert store.inspect_group_columns(project['id'], group['id']) == first
        assert {path.name for path in directory.iterdir()} == files
    assert store.load(project['id']) == project


@pytest.mark.parametrize('metadata', [
    {'mapping': 'legacy value'}, {'mapping': ['legacy']},
    {'rebin_original': 'legacy value'}, {'rebin_original': []}, {'rebin_original': None},
    {'columns': 'legacy columns'},
])
def test_legacy_source_metadata_does_not_break_project_load_or_save(tmp_path, xas_arrays, metadata):
    store, project, _, _ = imported(tmp_path, xas_arrays)
    group = project['groups'][0]
    group['source'].update(metadata)
    store.storage.write_json(project['id'], 'project.json', project)
    loaded = store.load(project['id'])
    assert loaded['groups'][0]['can_reimport_columns'] is False
    saved = store.command(project['id'], Command(version=loaded['version'], action='project', options={'name': 'Legacy project'}))
    assert saved['name'] == 'Legacy project'
    assert saved['groups'][0]['can_reimport_columns'] is False
    with pytest.raises(ValueError, match='unavailable'):
        store.inspect_group_columns(project['id'], group['id'])
