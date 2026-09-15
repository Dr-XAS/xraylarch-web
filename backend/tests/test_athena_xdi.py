"""Measured XDI input and actual native Perl/XDI project exchange contracts."""
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, ImportRequest, _native_perl_document
from xraylarch_web.athena_xdi import from_native, identity, project_statement
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload

FIXTURES = Path(__file__).parent / 'fixtures'
NATIVE = json.loads(gzip.decompress((FIXTURES/'athena-xdi-native.json.gz').read_bytes()))
INPUTS = json.loads((FIXTURES/'athena-xdi-fixtures.json').read_text())['inputs']


def without_sidecar(data):
    return b'\n'.join(line for line in gzip.decompress(data).splitlines() if not line.startswith(b'# Athena-Web '))


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def restored(store, data):
    return store.restore(store.create()['id'], 0, data, 'native.prj')['groups'][0]


@pytest.mark.parametrize('filename,bom', [('renamed.dat', False), ('renamed.xmu', False),
    ('renamed.nor', False), ('renamed.chik', False), ('renamed.csv', False), ('renamed.txt', True)])
def test_xdi_signature_retains_metadata_and_values_independently_of_extension(filename, bom):
    raw = (FIXTURES/'xdi-official-cu_metal_rt.xdi').read_bytes()
    expected = parse_upload(raw, 'original.xdi')
    source = (b'\xef\xbb\xbf' if bom else b'') + raw
    parsed = parse_upload(source, filename)
    assert parsed.display_name == filename and parsed.source_bytes == source
    assert parsed.xdi_metadata['attributes'] == expected.xdi_metadata['attributes']
    assert parsed.xdi_metadata['source_sha256'] == hashlib.sha256(source).hexdigest()
    assert parsed.xdi_metadata['comments_text'] == expected.xdi_metadata['comments_text']
    assert parsed.columns == expected.columns
    for column, values in expected.arrays.items():
        np.testing.assert_array_equal(parsed.arrays[column], values)


def test_later_comment_mentioning_xdi_does_not_change_ascii_parser():
    raw = b'# Ordinary absorption data\n# XDI/1.0 mentioned in notes\n# energy mu\n7000 1\n7001 2\n7002 3\n'
    parsed = parse_upload(raw, 'sample.dat')
    assert parsed.xdi_metadata is None and parsed.row_count == 3
    assert [column.name for column in parsed.columns] == ['energy', 'mu']


@pytest.mark.parametrize('item', INPUTS, ids=[r['fixture'] for r in INPUTS])
def test_official_xdi_all_observations_and_acquisition_fields(store, item):
    raw = (FIXTURES/item['fixture']).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == item['sha256']
    rows = np.loadtxt(io.BytesIO(raw))
    parsed = parse_upload(raw, item['fixture'])
    np.testing.assert_array_equal(np.array(list(parsed.arrays.values())).T, rows)
    p = store.create(); i = store.inspect(p['id'], raw, item['fixture'])
    q = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
    preview = store.preview_columns(p['id'], q)
    expected = np.log(rows[:, 1]/rows[:, 2]) if 'cu_metal' in item['fixture'] else rows[:, 1]
    np.testing.assert_allclose(preview['traces'][0]['y'], expected)
    np.testing.assert_array_equal(preview['traces'][0]['x'], rows[:, 0])
    alternate = ImportRequest.model_validate(dict(q.model_dump(), mode='mu',
        numerator=[i['columns'][-1]['column_id']], denominator=None))
    changed = store.preview_columns(p['id'], alternate)
    np.testing.assert_allclose(changed['traces'][0]['y'], rows[:, -1])
    assert store.load(p['id']) == p
    g = store.import_data(p['id'], q)['groups'][0]
    assert g['processing_error'] is None and len(g['result']['arrays']['norm']) == len(rows)
    assert g['source']['xdi_metadata'] == parsed.xdi_metadata == i['xdi_metadata']
    assert g['source']['edge_identity'] == identity(i['xdi_metadata'])
    assert g['source']['edge_identity']['origin'] == 'xdi'
    np.testing.assert_array_equal(np.array(list(g['source']['column_arrays'].values())).T, rows)
    assert store.inspected_file(p['id'], i['upload_id'], 'source')[0] == raw
    obj = next(r['native']['object'] for r in NATIVE if r['fixture'] == item['fixture'])
    # Native C adds a separator blank line; Larch's Python reader omits it.
    assert g['source']['xdi_metadata']['comments_text'].strip() == obj['comments'].strip()
    assert g['source']['xdi_metadata']['attributes'] == {
        f.lower(): {k.lower(): str(v) for k, v in fields.items()} for f, fields in obj['metadata'].items()}
    for fmt in ['json', 'prj']:
        exact = restored(store, store.export_project(p['id'], fmt))
        assert exact['source'] == g['source']
        np.testing.assert_array_equal(exact['mu'], g['mu'])
    native = restored(store, without_sidecar(store.export_project(p['id'], 'prj')))
    assert native['source']['xdi_metadata']['attributes'] == g['source']['xdi_metadata']['attributes']
    assert native['source']['xdi_metadata']['comments_text'] == g['source']['xdi_metadata']['comments_text']
    np.testing.assert_array_equal(native['mu'], g['mu'])


@pytest.mark.parametrize('row', NATIVE, ids=[r['name'] for r in NATIVE])
def test_actual_native_writer_objects_without_web_sidecars(store, row):
    native = row['native']; text = native['prj']
    assert '# Athena-Web ' not in text and '$xdi = bless(' in text
    g = restored(store, text.encode())
    assert g['processing_error'] is None
    np.testing.assert_array_equal(g['energy'], native['arrays']['energy'])
    np.testing.assert_array_equal(g['mu'], native['arrays']['xmu'])
    for key in ['i0', 'signal']:
        if key in native['arrays']:
            np.testing.assert_array_equal(g['source']['raw_arrays'][key], native['arrays'][key])
    meta = g['source']['xdi_metadata']
    assert meta['comments_text'] == native['object']['comments']
    assert meta['native_object']['data'] == {}
    assert meta['native_object']['array_labels'] == native['object']['array_labels']
    assert meta['native_object']['metadata'] == native['object']['metadata']
    assert not any('xdi' in w.lower() for w in g['source']['warnings'])
    p = store.create(); p = store.restore(p['id'], 0, text.encode(), 'official.prj')
    output = without_sidecar(store.export_project(p['id'], 'prj'))
    reread = restored(store, output)
    assert reread['source']['xdi_metadata']['attributes'] == meta['attributes']
    assert reread['source']['xdi_metadata']['comments_text'] == meta['comments_text']
    assert reread['source']['xdi_metadata']['native_object']['metadata'] == meta['native_object']['metadata']


def test_declared_identity_is_retained_while_explicit_import_policy_wins(store):
    raw = (FIXTURES/INPUTS[0]['fixture']).read_bytes().replace(b'Element.symbol: Cu', b'Element.symbol: Fe')
    p = store.create(); i = store.inspect(p['id'], raw, 'declared.xdi')
    q = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'])
    g = store.import_data(p['id'], q)['groups'][0]
    assert g['source']['edge_identity'] == {'element': 'Fe', 'edge': 'K', 'origin': 'xdi'}
    assert g['parameters']['energy_shift'] == 0
    assert g['result']['effective']['e0'] > 8900
    q = q.model_copy(update={'version': 1, 'edge_policy': {'element': 'Cu', 'edge': 'K', 'fraction': .5}})
    p = store.import_data(p['id'], q); g = p['groups'][-1]
    assert g['source']['edge_identity']['element'] == 'Cu'
    assert g['source']['xdi_metadata']['attributes']['element']['symbol'] == 'Fe'
    native = restored(store, without_sidecar(store.export_project(p['id'], 'prj', group_ids=[g['id']])))
    assert native['source']['edge_identity']['element'] == 'Cu'
    assert native['source']['xdi_metadata']['attributes']['element']['symbol'] == 'Cu'


def test_mixed_case_fields_do_not_duplicate_when_identity_changes():
    obj = copy.deepcopy(NATIVE[0]['native']['object'])
    obj['metadata']['ELEMENT'] = {'Symbol': 'Fe', 'EDGE': 'L3'}
    del obj['metadata']['Element']
    metadata = from_native({'__perl_class__': 'Xray::XDI', '__perl_value__': obj})
    statement = project_statement({'xdi_metadata': metadata}, {'element': 'Cu', 'edge': 'K'})
    text = NATIVE[0]['native']['prj']
    text = text[:text.index('$xdi =')] + statement + '\n[record]\n1;'
    obj = _native_perl_document(text)[0][0]['xdi']['__perl_value__']
    assert obj['metadata']['ELEMENT'] == {'Symbol': 'Cu', 'EDGE': 'K'}
    assert obj['element'] == 'Cu' and obj['edge'] == 'K'
    assert metadata['attributes']['element'] == {'symbol': 'Fe', 'edge': 'L3'}


@pytest.mark.parametrize('payload', [[], {'comments': []}, {'metadata': []}, {'metadata': {'Mono': []}},
    {'metadata': {'Element': {'symbol': 'Cu'}, 'element': {'symbol': 'Fe'}}},
    {'metadata': {'Mono': {'Name': 'Si', 'name': 'Ge'}}}])
def test_malformed_xdi_objects_remain_inert_and_do_not_block_spectra(store, payload):
    from xraylarch_web.athena_xdi import _literal
    text = NATIVE[0]['native']['prj']; text = text[:text.index('$xdi =')]
    text += '$xdi = bless('+_literal(payload)+", 'Xray::XDI');\n[record]\n1;"
    g = restored(store, text.encode())
    assert 'xdi_metadata' not in g['source']
    assert g['source']['native']['fields']['xdi']['__perl_value__'] == payload
    assert any('retained without applying' in w for w in g['source']['warnings'])


def test_unknown_class_is_never_promoted(store):
    text = NATIVE[0]['native']['prj'].replace("'Xray::XDI'", "'Untrusted::Class'")
    g = restored(store, text.encode())
    assert 'xdi_metadata' not in g['source']
    assert g['source']['native']['fields']['xdi']['__perl_class__'] == 'Untrusted::Class'


@pytest.mark.parametrize('expression', ["system('touch /tmp/athena-xdi-untrusted')", "do { die 'bad' }", "bless({comments=>qx(id)}, 'Xray::XDI')"])
def test_executable_native_fields_are_rejected_atomically(store, expression):
    text = NATIVE[0]['native']['prj']; text = text[:text.index('$xdi =')] + '$xdi = '+expression+';\n[record]\n1;'
    p = store.create()
    with pytest.raises(WebInputError):
        store.restore(p['id'], 0, text.encode(), 'bad.prj')
    assert store.load(p['id']) == p


def test_conflicting_native_metadata_cannot_be_silently_exported():
    meta = from_native({'__perl_class__': 'Xray::XDI', '__perl_value__': NATIVE[0]['native']['object']})
    meta['attributes']['facility']['name'] = 'Changed'
    with pytest.raises(ValueError, match='disagree'):
        project_statement({'xdi_metadata': meta})


def test_conflicting_saved_xdi_is_a_recoverable_export_error(store):
    p = store.create(); p = store.restore(p['id'], 0, NATIVE[0]['native']['prj'].encode(), 'native.prj')
    p['groups'][0]['source']['xdi_metadata']['attributes']['facility']['name'] = 'Changed'
    with pytest.raises(WebInputError, match='XDI acquisition metadata could not be exported'):
        store.export_prj(p)
    assert store.load(p['id'])['groups'][0]['source']['xdi_metadata']['attributes']['facility']['name'] == 'APS'


def test_beamline_metadata_is_available_to_native_project_readers(store):
    p = store.create(); raw = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    i = store.inspect(p['id'], raw, 'cu.012')
    p = store.import_data(p['id'], ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion']))
    g = restored(store, without_sidecar(store.export_project(p['id'], 'prj')))
    expected = dict(i['beamline_metadata']['attributes'], element={'symbol': 'Cu', 'edge': 'K'})
    assert g['source']['xdi_metadata']['attributes'] == expected
    assert g['source']['xdi_metadata']['comments_text'] == '\n'.join(i['beamline_metadata']['comments'])
    np.testing.assert_array_equal(g['mu'], p['groups'][0]['mu'])


def test_comment_literal_backslash_n_matches_native_restore_and_sidecar_is_exact(store):
    g = restored(store, NATIVE[0]['native']['prj'].encode())
    source = copy.deepcopy(g['source']); source['xdi_metadata']['comments_text'] = r'literal\ntext'
    statement = project_statement(source)
    text = NATIVE[0]['native']['prj']; text = text[:text.index('$xdi =')] + statement+'\n[record]\n1;'
    assert restored(store, text.encode())['source']['xdi_metadata']['comments_text'] == 'literal\ntext'
    # The native Prj.pm substitution is ambiguous. Web sidecars retain exact data.
    p = store.create(); p['groups'] = [dict(g, source=source)]
    exact = restored(store, store.export_prj(p))
    assert exact['source']['xdi_metadata']['comments_text'] == r'literal\ntext'
