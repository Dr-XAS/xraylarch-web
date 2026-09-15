"""Native XDI clone observations and real Larch-derived project exchanges."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

from larch.io import read_athena
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_dispersive import DispersiveRequest
from xraylarch_web.athena_export import DataExport
from xraylarch_web.athena_xdi import from_native
from xraylarch_web.athena_xdi_controls import captured
from xraylarch_web.athena_xdi_history import clone_metadata
from xraylarch_web.config import Settings

FIXTURES = Path(__file__).parent / 'fixtures'
NATIVE = json.loads(gzip.decompress((FIXTURES / 'athena-xdi-history-native.json.gz').read_bytes()))
COMMENTS = 'Reviewed μ 铜 "quoted" $literal @array\nSecond line'
START = '2001-06-26T22:27:31'
END = '2001-06-26T22:31:31'


def test_reference_manifest_matches_sources_fixtures_and_actual_native_modules():
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((FIXTURES / 'athena-xdi-history-fixtures.json').read_text())
    catalog = json.loads((root / 'docs/athena-primary-sources.json').read_text())['files']
    for path, sha in manifest['sha256'].items():
        assert hashlib.sha256((root / path).read_bytes()).hexdigest() == sha
    for path, sha in manifest['source_sha256'].items():
        assert sha == next(row['sha256'] for row in catalog if row['file'] == 'demeter-' + manifest['demeter_revision'] + '/' + path)
    assert len(NATIVE['cases']) == manifest['case_count'] == 30
    for row in NATIVE['cases']:
        assert row['modules'] == manifest['native_modules']
        assert row['version'] == manifest['xdi_version']


@pytest.mark.parametrize('row', NATIVE['cases'], ids=[r['id'] for r in NATIVE['cases']])
def test_every_native_clone_field_and_independence(row):
    metadata = from_native(dict(__perl_class__='Xray::XDI', __perl_value__=row['original']))
    before = copy.deepcopy(metadata)
    choice = row['input']
    child = clone_metadata(metadata, choice['element'], choice['edge'], choice['process'], choice['remove_times'])
    assert child['native_object'] == row['clone']
    assert child['comments_text'] == metadata['comments_text']
    assert metadata == before
    child['native_object']['array_labels'].append('only_child')
    child['attributes']['user']['only_child'] = 'change'
    assert metadata == before


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def command(store, p, action, groups=(), **options):
    return store.command(p['id'], Command(version=p['version'], action=action, group_ids=list(groups), options=options))


def imported(store, name='xdi-official-cu_metal_rt.xdi'):
    p = store.create()
    raw = (FIXTURES / name).read_bytes()
    if name.endswith('.xdi'):
        # Keep every measured observation. Explicitly controlled header fields
        # make the time/history behavior observable, not a new measured sample.
        raw = b'\n'.join(line for line in raw.splitlines() if not line.lower().startswith((b'# scan.start_time:', b'# scan.end_time:', b'# scan.process:')))
        raw = raw.replace(b'# ///', f'# Scan.start_time: {START}\n# Scan.end_time: {END}\n# Scan.process: Earlier processing\n# ///'.encode())
    inspection = store.inspect(p['id'], raw, name)
    p = store.import_data(p['id'], ImportRequest(version=0, upload_id=inspection['upload_id'], **inspection['athena_suggestion']))
    return command(store, p, 'xdi_comments', [p['groups'][0]['id']], comments=COMMENTS)


TRANSFORMS = [
    ('duplicate', {}, ''),
    ('copy_series', dict(parameter='rbkg', start=.8, stop=1.2, count=2), ''),
    ('smooth', dict(window=7, order=2), 'Smoothed data by Savitzky-Golay filter'),
    ('deglitch', dict(indices=[200]), 'Replaced selected glitches by interpolation'),
    ('truncate', dict(xmin=8800, xmax=9900), 'Truncated data to the selected interval'),
    ('rebin', dict(pre_step=2, xanes_step=.5, exafs_kstep=.1), 'Data rebinned onto a three-region energy grid'),
    ('convolve', dict(width=1), 'Convolved data with a broadening function'),
    ('deconvolve', dict(esigma=1, smooth=False), 'Deconvolved normalized data'),
    ('multi_electron', dict(method='arctangent', shift=30, amplitude=.01, width=2), 'Removed multi-electron excitation'),
    ('self_absorption', dict(formula='Cu', element='Cu', edge='K', norm2=200), 'Corrected fluorescence self-absorption'),
    ('dispersive', dict(offset=0, linear=1, quadratic=0), 'Calibrated dispersive energy scale'),
]


@pytest.mark.parametrize('action,options,message', TRANSFORMS)
def test_each_derived_path_preserves_acquisition_history_without_source_array_aliases(store, action, options, message):
    p = imported(store)
    parent = copy.deepcopy(p['groups'][0])
    result = command(store, p, action, [parent['id']], **options)
    inplace = action in ('deglitch','truncate')
    if inplace:
        assert result['groups'][0]['id'] == parent['id']
        count = len(result['groups'][0]['source']['point_edits'][-1]['removed_indices'])
        message = f'Removed {count} points by {action}'
    else:
        assert result['groups'][0] == parent
    children = result['groups'] if inplace else result['groups'][1:]
    assert len(children) == (2 if action == 'copy_series' else 1)
    expected = copy.deepcopy(captured(parent)['attributes'])
    expected['scan']['process'] = 'Earlier processing; ' + message
    for child in children:
        assert child['processing_error'] is None
        metadata = captured(child)
        assert metadata['attributes'] == expected
        assert metadata['comments_text'] == COMMENTS
        assert metadata['npts'] == captured(parent)['npts']
        assert metadata['array_labels'] == captured(parent)['array_labels']
        if action == 'rebin':
            # Rebin deliberately interpolates detector columns to its new grid.
            assert all(len(values) == len(child['energy']) for values in child['source']['raw_arrays'].values())
            assert 'column_arrays' not in child['source']
        elif inplace:
            assert all(len(a)==len(child['energy']) for a in child['source']['raw_arrays'].values())
            assert all(len(a)==len(child['energy']) for a in child['source']['column_arrays'].values())
        elif action != 'duplicate':
            assert 'raw_arrays' not in child['source'] and 'column_arrays' not in child['source']
        view = store.xdi_metadata(result['id'], child['id'])
        assert view['history'] == dict(process=expected['scan']['process'], start_time=START, end_time=END, inherited=True)


@pytest.mark.parametrize('action,message,remove_end', [('merge', 'Merge of 2 scans', True), ('sum', 'Weighted sum of 2 scans', False), ('difference', 'Difference spectrum', False)])
def test_combination_uses_primary_acquisition_and_native_merge_difference_times(store, action, message, remove_end):
    p = imported(store)
    p = command(store, p, 'duplicate', [p['groups'][0]['id']])
    parent = copy.deepcopy(p['groups'][0])
    p = command(store, p, 'xdi_comments', [p['groups'][1]['id']], comments='Second scan comments')
    before = copy.deepcopy(p)
    after = command(store, p, action, [g['id'] for g in p['groups']])
    assert after['groups'][:-1] == before['groups']
    child = after['groups'][-1]
    metadata = captured(child)
    expected = copy.deepcopy(captured(parent)['attributes'])
    expected['scan']['process'] = 'Earlier processing; ' + message
    if remove_end:
        expected['scan'].pop('end_time')
    assert metadata['attributes'] == expected
    assert metadata['comments_text'] == COMMENTS
    assert child['source']['parents'] == [g['id'] for g in before['groups']]


@pytest.mark.parametrize('name', ['xdi-official-cu_metal_rt.xdi', 'demeter-x11a-cu.012'])
def test_chain_comments_identity_undo_restart_native_prj_and_column_exports(store, name, tmp_path):
    p = imported(store, name)
    p = command(store, p, 'metadata', [p['groups'][0]['id']], frozen=True)
    parent = copy.deepcopy(p['groups'][0])
    p = command(store, p, 'multi_electron', [parent['id']], method='arctangent', shift=30, amplitude=.01, width=2)
    corrected = p['groups'][-1]
    p = command(store, p, 'rebin', [corrected['id']], pre_step=2, xanes_step=.5, exafs_kstep=.1)
    rebinned = p['groups'][-1]
    before_copy = copy.deepcopy(p)
    p = command(store, p, 'duplicate', [rebinned['id']])
    child = p['groups'][-1]
    history = captured(child)['attributes']['scan']['process']
    assert history.endswith('Removed multi-electron excitation; Data rebinned onto a three-region energy grid; ')
    assert captured(child)['comments_text'] == COMMENTS
    undone = command(store, p, 'undo')
    assert undone['groups'] == before_copy['groups']
    p = command(store, undone, 'redo')
    assert p['groups'][-1] == child and p['groups'][0] == parent
    assert AthenaStore(store.settings).load(p['id']) == p
    native = b'\n'.join(line for line in gzip.decompress(store.export_project(p['id'], 'prj')).splitlines() if not line.startswith(b'# Athena-Web '))
    assert b'$xdi = bless' in native
    path = tmp_path / 'derived-native.prj'; path.write_bytes(native)
    larch_groups = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False).groups
    assert len(larch_groups) == len(p['groups'])
    restored = store.restore(store.create()['id'], 0, native, path.name)
    reopened = restored['groups'][-1]
    assert captured(reopened)['attributes'] == captured(child)['attributes']
    assert captured(reopened)['comments_text'] == COMMENTS
    assert store.xdi_metadata(restored['id'], reopened['id'])['history']['process'] == history
    for project, group in [(p, child), (restored, reopened)]:
        _, _, raw = store.export_data(project['id'], DataExport(version=project['version'], group_id=group['id'], form='xmu'))
        assert ('# Scan.process: ' + history).encode() in raw
        assert 'Reviewed μ 铜 "quoted" $literal @array'.encode() in raw


def test_native_prj_source_clones_edited_comments_with_current_absorber(store):
    p = imported(store)
    native = b'\n'.join(line for line in gzip.decompress(store.export_project(p['id'], 'prj')).splitlines() if not line.startswith(b'# Athena-Web '))
    p = store.restore(store.create()['id'], 0, native, 'source.prj')
    p = command(store, p, 'edge_identity', [p['groups'][0]['id']], element='Fe', edge='L3')
    p = command(store, p, 'xdi_comments', [p['groups'][0]['id']], comments='New comments')
    parent = copy.deepcopy(p['groups'][0])
    after = command(store, p, 'duplicate', [parent['id']])
    assert after['groups'][0] == parent
    assert captured(after['groups'][-1])['attributes']['element'] == dict(symbol='Fe', edge='L3')
    assert captured(after['groups'][-1])['comments_text'] == 'New comments'
    raw = b'\n'.join(line for line in gzip.decompress(store.export_project(after['id'], 'prj')).splitlines() if not line.startswith(b'# Athena-Web '))
    restored = store.restore(store.create()['id'], 0, raw, 'clones.prj')
    assert captured(restored['groups'][-1])['comments_text'] == 'New comments'


def test_dispersive_uses_pixel_metadata_and_never_the_standard_acquisition(store):
    p = imported(store)
    inspection = store.inspect_dispersive(p['id'], (FIXTURES / 'xdi-official-cu_metal_rt.xdi').read_bytes(), 'pixel.xdi')
    ids = {col['name']: col['column_id'] for col in inspection['columns']}
    req = DispersiveRequest(version=p['version'], upload_id=inspection['upload_id'], standard_id=p['groups'][0]['id'],
        columns=dict(pixel_column=ids['energy'], numerator=[ids['mutrans']]), coefficients=dict(offset=0, linear=1, quadratic=0))
    after = store.make_dispersive(p['id'], req)
    assert after['groups'][0] == p['groups'][0]
    child = captured(after['groups'][-1])
    assert child['attributes']['scan']['process'] == 'Calibrated dispersive energy scale'
    assert child['comments_text'] == inspection['xdi_metadata']['comments_text']
    assert child['comments_text'] != COMMENTS
    assert 'end_time' not in child['attributes']['scan']


def test_later_invalid_native_metadata_rolls_back_entire_batch(store):
    p = imported(store)
    p = command(store, p, 'duplicate', [p['groups'][0]['id']])
    bad = p['groups'][1]['source']['xdi_metadata']
    bad['native_object'] = dict(metadata={'Element': {'symbol': 'Wrong'}})
    store.storage.write_json(p['id'], 'project.json', p)
    before = copy.deepcopy(p)
    with pytest.raises(ValueError, match='disagree'):
        command(store, p, 'duplicate', [g['id'] for g in p['groups']])
    assert store.load(p['id']) == before


def test_plain_example_starts_history_without_inventing_acquisition_times(store):
    p = command(store, store.create(), 'example')
    after = command(store, p, 'multi_electron', [p['groups'][0]['id']], method='arctangent', shift=30)
    child = next(g for g in after['groups'] if g['id'] not in {old['id'] for old in p['groups']})
    assert store.xdi_metadata(after['id'], child['id'])['history'] == dict(
        process='Removed multi-electron excitation', start_time=None, end_time=None, inherited=True)
    assert captured(child)['attributes']['element'] == dict(symbol='Cu', edge='K')


def test_column_import_rebin_records_history_for_sample_and_independent_reference(store):
    p = store.create()
    i = store.inspect(p['id'], (FIXTURES / 'xdi-official-cu_metal_rt.xdi').read_bytes(), 'cu.xdi')
    ids = {c['name']: c['column_id'] for c in i['columns']}
    request = ImportRequest(version=0, upload_id=i['upload_id'], **i['athena_suggestion'],
        reference_numerator=ids['i0'], reference_denominator=ids['itrans'], reference_log=True,
        reference_same_element=True, rebin=dict(e0=8980., pre=2., xanes=.5, exafs=.1))
    preview = store.preview_columns(p['id'], request)
    assert store.load(p['id']) == p
    after = store.import_data(p['id'], request)
    assert len(after['groups']) == 2
    for group in after['groups']:
        assert group['processing_error'] is None
        meta = captured(group)
        assert meta['attributes']['scan']['process'] == 'Data rebinned onto a three-region energy grid'
        assert meta['comments_text'] == i['xdi_metadata']['comments_text']
        assert meta['npts'] == i['row_count']
        assert len(group['energy']) != i['row_count']
    assert after['groups'][0]['reference_id'] == after['groups'][1]['id']
    assert any(trace.get('stage') == 'rebinned' for trace in preview['traces'])
