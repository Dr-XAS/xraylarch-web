"""One detector upload can atomically create transmission and fluorescence."""
import copy
from io import StringIO

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_preferences import AthenaPreferences, ColumnMemory
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def staged(tmp_path, xas_arrays, *, reverse=False):
    x, mu = xas_arrays
    values = np.column_stack([x / 1000, np.full(len(x), 10000), 10000 * np.exp(-mu),
                              20000 * mu, 30000 * mu, 10000 * np.exp(-mu)])
    buf = StringIO()
    np.savetxt(buf, values[::-1] if reverse else values,
               header='energy i0 it if1 if2 ref', fmt='%.17g')
    store = AthenaStore(Settings(data_root=tmp_path)); project = store.create()
    inspected = store.inspect(project['id'], buf.getvalue().encode(), 'detectors.dat')
    ids = {c['name']: c['column_id'] for c in inspected['columns']}
    req = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'],
        units='keV', numerator=[ids['i0']], denominator=ids['it'], mode='transmission',
        additional_fluorescence={'numerator': [ids['if1']], 'denominator': ids['i0']}, sort=reverse)
    return store, project, inspected, req, ids


@pytest.mark.parametrize('dtype', ['mu', 'xanes', 'norm', 'xmudat'])
def test_dual_import_keeps_actual_modes_independent_arithmetic_and_one_undo(tmp_path, xas_arrays, dtype):
    store, p, info, req, ids = staged(tmp_path, xas_arrays, reverse=True)
    req.data_type = dtype
    req.signal_multiplier = 2
    req.additional_fluorescence.signal_multiplier = -3
    req.additional_fluorescence.invert = True
    before = copy.deepcopy(p)
    preview = store.preview_columns(p['id'], req)
    assert store.load(p['id']) == before
    assert [t['label'] for t in preview['traces']] == ['Transmission · Sample', 'Fluorescence · Sample']
    assert len({t['id'] for t in preview['traces']}) == 2
    imported = store.import_data(p['id'], req)
    assert imported['version'] == p['version'] + 1 and len(imported['undo']) == 1
    assert [g['label'] for g in imported['groups']] == ['detectors.dat · Transmission', 'detectors.dat · Fluorescence']
    for group, trace, mode, factor, numerator, denominator in zip(imported['groups'], preview['traces'],
            ['transmission', 'fluorescence'], [2, 6], [[ids['i0']], [ids['if1']]], [ids['it'], ids['i0']], strict=True):
        np.testing.assert_allclose(group['mu'], factor * xas_arrays[1], atol=1e-14)
        np.testing.assert_allclose(group['energy'], xas_arrays[0], atol=1e-10)
        assert group['mu'] == trace['y']
        mapping = group['source']['mapping']
        assert mapping['mode'] == mode and mapping['numerator'] == numerator and mapping['denominator'] == denominator
        assert 'additional_fluorescence' not in mapping and group['data_type'] == dtype
    undone = store.command(p['id'], Command(version=imported['version'], action='undo'))
    assert undone['groups'] == []
    redone = store.command(p['id'], Command(version=undone['version'], action='redo'))
    assert redone['groups'] == imported['groups']


def test_individual_fluorescence_rebin_references_and_preprocessing_match_preview(tmp_path, xas_arrays):
    store, p, info, req, ids = staged(tmp_path, xas_arrays)
    req = ImportRequest.model_validate(req.model_dump() | {
        'additional_fluorescence': {'numerator': [ids['if1'], ids['if2']], 'denominator': [ids['i0']], 'individual_channels': True},
        'reference_numerator': ids['i0'], 'reference_denominator': ids['ref'],
        'preprocessing': {'mark': True}, 'rebin': {'e0': 8980}})
    preview = store.preview_columns(p['id'], req)
    rebinned = [t for t in preview['traces'] if t.get('stage') == 'rebinned']
    assert len(rebinned) == len(preview['rebin_results']) == 6
    assert len({t['id'] for t in preview['traces']}) == len(preview['traces'])
    imported = store.import_data(p['id'], req)
    assert len(imported['groups']) == 6 and imported['version'] == 1
    for group, trace in zip(imported['groups'], rebinned, strict=True):
        np.testing.assert_allclose(group['mu'], trace['y'], atol=1e-14)
        np.testing.assert_allclose(group['energy'], trace['x'], atol=1e-10)
        assert 'rebin_original' in group['source']
    for sample, reference in zip(imported['groups'][::2], imported['groups'][1::2], strict=True):
        assert sample['reference_id'] == reference['id'] and sample['marked'] and not reference['marked']
        assert reference['source']['mapping']['mode'] == 'transmission'
    assert imported['groups'][2]['source']['mapping']['numerator'] == [ids['if1']]
    assert imported['groups'][4]['source']['mapping']['numerator'] == [ids['if2']]


@pytest.mark.parametrize('invalid', ['missing', 'duplicate', 'zero_denominator'])
def test_bad_second_recipe_leaves_no_partial_project_or_preferences(tmp_path, xas_arrays, invalid):
    store, p, info, req, ids = staged(tmp_path, xas_arrays)
    if invalid == 'missing': req.additional_fluorescence.numerator = ['missing']
    if invalid == 'duplicate': req.additional_fluorescence.numerator = [ids['if1'], ids['if1']]
    if invalid == 'zero_denominator':
        arrays = store.storage.read_arrays(p['id'], f"upload-{info['upload_id']}.npz")
        arrays[ids['i0']][500] = 0
        # Keep primary arithmetic valid while making only the second denominator zero.
        req.numerator = [ids['if1']]
        store.storage.write_arrays(p['id'], f"upload-{info['upload_id']}.npz", arrays)
    for operation in (store.preview_columns, store.import_data):
        with pytest.raises(ValueError): operation(p['id'], req)
        assert store.load(p['id']) == p
        assert not list(store.storage.workspace_dir(p['id']).glob('undo-*.json'))
        assert AthenaPreferences(store.settings).read_columns() is None


def test_combined_count_enforces_group_limit_before_building_groups(tmp_path, xas_arrays, monkeypatch):
    store, p, info, req, ids = staged(tmp_path, xas_arrays)
    group = store.make_group('existing', *xas_arrays, data_type='xanes')
    p['groups'] = [dict(group, id=f'group-{i}') for i in range(99)]
    monkeypatch.setattr(store, 'load', lambda ident: copy.deepcopy(p))
    monkeypatch.setattr(store, 'make_import_group', lambda *args, **kwargs: pytest.fail('Group construction must follow the combined count check.'))
    with pytest.raises(ValueError, match='at most 100'):
        store.import_data(p['id'], req)


@pytest.mark.parametrize('update', [
    {'mode': 'fluorescence'}, {'data_type': 'chi'}, {'numerator': []}, {'denominator': None},
    {'additional_fluorescence': {'numerator': [], 'denominator': 'i0'}},
    {'additional_fluorescence': {'numerator': ['if'], 'denominator': []}},
    {'additional_fluorescence': {'numerator': ['if'], 'denominator': 'i0', 'signal_multiplier': float('nan')}},
])
def test_combined_request_requires_both_explicit_energy_recipes(update):
    base = dict(version=0, upload_id='u', energy_column='energy', mode='transmission', numerator=['i0'], denominator='it',
                additional_fluorescence={'numerator': ['if'], 'denominator': 'i0'})
    with pytest.raises(ValidationError): ImportRequest.model_validate(base | update)


def test_both_modes_remember_remap_and_reset_for_new_layouts(tmp_path, xas_arrays):
    store, p, info, req, ids = staged(tmp_path, xas_arrays)
    p = store.import_data(p['id'], req)
    preferences = AthenaPreferences(store.settings)
    assert preferences.read_columns().mapping['additional_fluorescence'] == req.additional_fluorescence.model_dump()
    changed = copy.deepcopy(info)
    for i, col in enumerate(changed['columns']): col['column_id'] = f'new_{i}'
    restored = preferences.column_choices(changed, p)
    assert restored['matching_columns']
    assert restored['mapping']['numerator'] == ['new_1']
    assert restored['mapping']['additional_fluorescence']['numerator'] == ['new_3']
    assert restored['mapping']['additional_fluorescence']['denominator'] == 'new_1'
    changed['columns'][3]['name'] = 'different_detector'
    reset = preferences.column_choices(changed, p)
    assert not reset['matching_columns'] and reset['mapping']['additional_fluorescence'] is None
    memory = preferences.read_columns().model_dump()
    for selected in (['missing'], [ids['if1'], ids['if1']]):
        memory['mapping']['additional_fluorescence']['numerator'] = selected
        with pytest.raises(ValidationError): ColumnMemory.model_validate(memory)


def test_http_accepts_combined_preview_import_and_reader_review_gate(tmp_path, xas_arrays):
    store, p, info, req, ids = staged(tmp_path, xas_arrays)
    metadata = store.storage.read_json(p['id'], f"upload-{info['upload_id']}.json")
    metadata['file_plugin'] = {'review_required': True}
    store.storage.write_json(p['id'], f"upload-{info['upload_id']}.json", metadata)
    with TestClient(create_app(store.settings)) as client:
        base = f"/api/athena/projects/{p['id']}"
        preview = client.post(base + '/preview-columns', json=req.model_dump())
        assert preview.status_code == 200 and len(preview.json()['traces']) == 2
        blocked = client.post(base + '/import', json=req.model_dump())
        assert blocked.status_code == 400 and store.load(p['id']) == p
        req.reader_reviewed = True
        response = client.post(base + '/import', json=req.model_dump())
        assert response.status_code == 200 and len(response.json()['groups']) == 2
        assert response.json()['version'] == 1
