import copy
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_xdi_controls import (
    REQUIRED, RECOMMENDED, XDIValidation, captured, metadata_view, validate_fields,
)
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app
from xraylarch_web.parsing import parse_upload

FIXTURES = Path(__file__).parent/'fixtures'
NATIVE = json.loads((FIXTURES/'athena-xdi-controls-native.json').read_text())['native']


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def imported(store, filename='xdi-official-cu_metal_rt.xdi'):
    p = store.create(); i = store.inspect(p['id'], (FIXTURES/filename).read_bytes(), filename)
    return store.import_data(p['id'], ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion']))


@pytest.mark.parametrize('row', NATIVE['cases'], ids=[f"{r['family']}.{r['tag']}:{r['value']}:{r['mode']}" for r in NATIVE['cases']])
def test_actual_native_field_status_and_message(row):
    f, t, v = row['family'], row['tag'], row['value']
    metadata = {'attributes': {f: {t: v}}, 'extra_version': 'GSE/1.0', 'family_names': {f.lower(): f}}
    original = copy.deepcopy(metadata)
    result = validate_fields(metadata, *( (f, t) if row['mode'] == 'field' else () ))['results'][0]
    assert (result['code'], result['message']) == (row['code'], row['message'])
    assert result['value'] == v and result['valid'] == (row['code'] == 0)
    assert metadata == original


def test_native_presence_lists_and_larch_extension_context(store):
    assert list(REQUIRED) == NATIVE['required']; assert list(RECOMMENDED) == NATIVE['recommended']
    p = imported(store); g = p['groups'][0]
    view = store.xdi_metadata(p['id'], g['id'])
    assert all(row['present'] for row in view['required'] + view['recommended'])
    report = store.validate_xdi(p['id'], g['id'], XDIValidation(version=p['version']))
    assert report['valid'] and any(r['family'] == 'GSE' for r in report['results'])
    assert store.load(p['id']) == p
    raw = b'\n'.join(l for l in gzip.decompress(store.export_project(p['id'], 'prj')).splitlines() if not l.startswith(b'# Athena-Web '))
    native = store.restore(store.create()['id'], 0, raw, 'saved.prj')
    reread = store.validate_xdi(native['id'], native['groups'][0]['id'], XDIValidation(version=native['version']))
    assert reread['valid'] and any(r['family'] == 'GSE' for r in reread['results'])


def test_comment_text_cannot_change_captured_extension_family_spelling():
    raw = (FIXTURES/'xdi-official-cu_metal_rt.xdi').read_bytes().replace(b'# ///', b'# ///\n# gse.extra: this is a comment')
    metadata = parse_upload(raw, 'source.xdi').xdi_metadata
    assert metadata['family_names']['gse'] == 'GSE'
    assert 'gse.extra: this is a comment' in metadata['comments_text']
    assert validate_fields(metadata, 'gse', 'extra')['valid']


@pytest.mark.parametrize('row', NATIVE['comments'], ids=['empty', 'unicode', 'crlf', 'literal-backslash'])
def test_native_comment_text_freeze_undo_redo_and_exchange(store, row, monkeypatch):
    p = imported(store); gid = p['groups'][0]['id']
    p = store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=[gid], options={'frozen': True, 'notes': 'Separate group notes'}))
    original = copy.deepcopy(p['groups'][0]); source = original['source']
    def no_science(*args, **kwargs):
        raise AssertionError('Metadata controls must not recompute science')
    with monkeypatch.context() as patch:
        patch.setattr('xraylarch_web.athena.process_spectrum', no_science)
        patch.setattr(store, '_process_groups', no_science)
        p = store.command(p['id'], Command(version=p['version'], action='xdi_comments', group_ids=[gid], options={'comments': row['text']}))
        g = p['groups'][0]
        assert g['source']['xdi_metadata']['comments_text'] == row['text']
        assert g['source']['xdi_metadata']['comments'] == row['text'].splitlines()
        assert {k: v for k, v in g.items() if k != 'source'} == {k: v for k, v in original.items() if k != 'source'}
        expected = copy.deepcopy(source); expected['xdi_metadata'].update(comments_text=row['text'], comments=row['text'].splitlines())
        assert g['source'] == expected
        undone = store.command(p['id'], Command(version=p['version'], action='undo'))
        assert undone['groups'][0] == original
        p = store.command(p['id'], Command(version=undone['version'], action='redo'))
        assert p['groups'][0] == g
    assert AthenaStore(store.settings).xdi_metadata(p['id'], gid)['comments'] == row['text']
    for fmt in ['json', 'prj', 'native_prj']:
        data = store.export_project(p['id'], 'prj' if fmt == 'native_prj' else fmt)
        if fmt == 'native_prj':
            data = b'\n'.join(l for l in gzip.decompress(data).splitlines() if not l.startswith(b'# Athena-Web '))
        restored = store.restore(store.create()['id'], 0, data, 'comments.prj')['groups'][0]
        expected_text = row['text'].replace('\\n', '\n') if fmt == 'native_prj' else row['text']
        assert captured(restored)['comments_text'] == expected_text
        assert restored['notes'] == 'Separate group notes'
        assert restored['mu'] == original['mu'] and restored['energy'] == original['energy']


def test_beamline_capture_stays_original_and_new_xdi_comments_are_separate(store):
    p = imported(store, 'demeter-x11a-cu.012'); g = p['groups'][0]; original = copy.deepcopy(g['source']['beamline_metadata'])
    view = metadata_view(g)
    assert next(f for f in view['families'] if f['name'] == 'Element')['fields'] == {'symbol': 'Cu', 'edge': 'K'}
    p = store.command(p['id'], Command(version=p['version'], action='xdi_comments', group_ids=[g['id']], options={'comments': 'Reviewed Cu foil'}))
    assert p['groups'][0]['source']['beamline_metadata'] == original
    assert captured(p['groups'][0])['comments_text'] == 'Reviewed Cu foil'
    assert store.xdi_metadata(p['id'], g['id'])['comments'] == 'Reviewed Cu foil'


def test_current_absorber_supplies_element_without_rewriting_acquisition(store):
    p = imported(store); g = p['groups'][0]; original = copy.deepcopy(g['source']['xdi_metadata'])
    p = store.command(p['id'], Command(version=p['version'], action='edge_identity', group_ids=[g['id']], options={'element': 'Fe', 'edge': 'L3'}))
    view = store.xdi_metadata(p['id'], g['id'])
    assert next(f for f in view['families'] if f['name'] == 'Element')['fields'] == {'symbol': 'Fe', 'edge': 'L3'}
    assert p['groups'][0]['source']['xdi_metadata'] == original
    p = store.command(p['id'], Command(version=p['version'], action='xdi_comments', group_ids=[g['id']], options={'comments': 'Selected edge'}))
    assert p['groups'][0]['source']['xdi_metadata']['attributes'] == original['attributes']


def test_groups_without_header_metadata_have_current_identity_and_saved_comments(store):
    p = store.create(); p = store.command(p['id'], Command(version=0, action='example')); g = p['groups'][0]
    view = store.xdi_metadata(p['id'], g['id'])
    assert sum(r['present'] for r in view['required']) == 2
    assert not any(r['present'] for r in view['recommended'])
    assert view['comments'] == ''
    p = store.command(p['id'], Command(version=p['version'], action='xdi_comments', group_ids=[g['id']], options={'comments': 'Example comments'}))
    assert p['groups'][0]['source']['xdi_metadata']['attributes']['element'] == {'symbol': 'Cu', 'edge': 'K'}


def test_parallel_validation_has_independent_buffers_and_diagnostics():
    rows = NATIVE['cases'] * 2
    def run(row):
        metadata = {'attributes': {row['family']: {row['tag']: row['value']}}, 'extra_version': 'GSE/1.0'}
        result = validate_fields(metadata, *((row['family'], row['tag']) if row['mode'] == 'field' else ()))['results'][0]
        return result['code'], result['message']
    with ThreadPoolExecutor(max_workers=6) as pool:
        assert list(pool.map(run, rows)) == [(row['code'], row['message']) for row in rows]


@pytest.mark.parametrize('metadata', [
    {'attributes': {'Facility': {'name': 'bad\0tail'}}},
    {'attributes': {'Facility': {'name': 'x'*8193}}},
    {'attributes': {'bad.*name': {'field': 'text'}}},
])
def test_unrepresentable_c_values_are_reported_without_truncation(metadata):
    result = validate_fields(metadata)['results'][0]
    assert result['code'] is None and not result['valid'] and result['message']


def test_stale_validation_before_and_during_work_does_not_return_old_results(store, monkeypatch):
    p = imported(store); gid = p['groups'][0]['id']
    with pytest.raises(WebInputError):
        store.validate_xdi(p['id'], gid, XDIValidation(version=0))
    def concurrent(*args):
        store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=[gid], options={'notes': 'Other window'}))
        return {'results': []}
    monkeypatch.setattr('xraylarch_web.athena_xdi_controls.validate_fields', concurrent)
    with pytest.raises(WebInputError):
        store.validate_xdi(p['id'], gid, XDIValidation(version=p['version']))
    assert store.load(p['id'])['groups'][0]['notes'] == 'Other window'


def test_missing_larch_shared_library_has_an_actionable_error(monkeypatch):
    from xraylarch_web.athena_xdi_controls import _validator
    _validator.cache_clear()
    def missing():
        raise TypeError('expected str, bytes or os.PathLike object, not NoneType')
    monkeypatch.setattr('larch.io.xdi.get_xdilib', missing)
    try:
        with pytest.raises(ValueError, match='Larch XDI validator is unavailable'):
            validate_fields({'attributes': {'Element': {'symbol': 'Cu'}}})
    finally:
        _validator.cache_clear()


def test_http_boundaries_failed_saves_are_atomic_and_validator_absence_is_explicit(store, monkeypatch):
    p = imported(store); gid = p['groups'][0]['id']; base = f"/api/athena/projects/{p['id']}"
    with TestClient(create_app(store.settings)) as client:
        assert client.get(f'{base}/groups/{gid}/xdi').json()['version'] == p['version']
        for options in [{'comments': 5}, {'comments': 'x'*50001}, {'comments': 'ok', 'notes': 'wrong'}, {}]:
            response = client.post(base+'/command', json={'version': p['version'], 'action': 'xdi_comments', 'group_ids': [gid], 'options': options})
            assert response.status_code == 400
            assert store.load(p['id']) == p
        for choice, status in [({'version': True}, 422), ({'version': p['version'], 'family': 'Element'}, 400),
                               ({'version': p['version'], 'family': 'Missing', 'tag': 'name'}, 400)]:
            assert client.post(f'{base}/groups/{gid}/xdi/validate', json=choice).status_code == status
        def absent():
            raise ValueError('The Larch XDI validator is unavailable in this installation.')
        monkeypatch.setattr('xraylarch_web.athena_xdi_controls._validator', absent)
        response = client.post(f'{base}/groups/{gid}/xdi/validate', json={'version': p['version']})
        assert response.status_code == 400 and 'unavailable' in response.text
        assert client.get(f'{base}/groups/{gid}/xdi').status_code == 200
        response = client.post(base+'/command', json={'version': p['version'], 'action': 'xdi_comments', 'group_ids': [gid], 'options': {'comments': 'Saved independently'}})
        assert response.status_code == 200
        assert client.post(base+'/command', json={'version': p['version'], 'action': 'xdi_comments', 'group_ids': [gid], 'options': {'comments': 'Stale'}}).status_code == 409
