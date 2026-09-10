"""Import preprocessing against native contracts and independent edge shifts."""
import copy
from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_preprocessing import ImportPreprocessing, import_alignment
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def staged(store, p, x, **columns):
    buf = StringIO()
    np.savetxt(buf, np.column_stack([x, *columns.values()]), header='energy ' + ' '.join(columns), fmt='%.17g')
    info = store.inspect(p['id'], buf.getvalue().encode(), 'detectors.dat')
    ids = {c['name']: c['column_id'] for c in info['columns']}
    return ImportRequest(version=p['version'], upload_id=info['upload_id'], energy_column=ids['energy'],
        numerator=[ids[next(iter(columns))]]), ids


def standard_project(store, x, y, *, ref=False, shift=0):
    p = store.create()
    g = store.make_group('standard', x, y, parameters={'energy_shift': shift, 'e0': 8980 + shift, 'rbkg': 1.2})
    p['groups'] = [g]
    if ref:
        r = store.make_group('standard reference', x, y, parameters={'energy_shift': shift, 'e0': 8980 + shift})
        g['reference_id'] = r['id']; r['marked'] = False
        p['groups'].append(r)
    return store.save(p, store.load(p['id']), 'test standard')


@pytest.mark.parametrize('mark', [False, True])
@pytest.mark.parametrize('individual', [False, True])
def test_marking_samples_only_and_one_atomic_undo(store, xas_arrays, mark, individual):
    x, y = xas_arrays; p = store.create()
    req, ids = staged(store, p, x, a=y, b=2*y, ref=y)
    req.numerator = [ids['a'], ids['b']]; req.individual_channels = individual
    req.reference_numerator = ids['ref']; req.reference_log = False
    req.preprocessing = ImportPreprocessing(mark=mark)
    before = copy.deepcopy(p)
    assert store.preview_columns(p['id'], req)['traces']
    assert store.load(p['id']) == before
    result = store.import_data(p['id'], req)
    assert result['version'] == p['version'] + 1
    for sample, ref in zip(result['groups'][::2], result['groups'][1::2]):
        assert sample['marked'] is mark and ref['marked'] is False
        assert sample['reference_id'] == ref['id']
        assert ref['source']['mapping']['preprocessing'] == ImportPreprocessing().model_dump()
    undone = store.command(p['id'], Command(version=result['version'], action='undo'))
    assert undone['groups'] == before['groups']


@pytest.mark.parametrize('dtype', ['mu', 'xanes', 'norm'])
def test_copy_parameters_uses_frozen_standard_without_copying_shift_or_mutating_it(store, xas_arrays, dtype):
    x, y = xas_arrays; p = standard_project(store, x, y, shift=1.25)
    standard = p['groups'][0]; standard['frozen'] = True
    standard['multiplier'], standard['offset'] = 2.5, 0.7
    p = store.save(p, store.load(p['id']), 'freeze standard')
    req, _ = staged(store, p, x, mu=y)
    req.data_type = dtype
    req.preprocessing = ImportPreprocessing(standard_id=standard['id'], copy_parameters=True)
    result = store.import_data(p['id'], req); g = result['groups'][-1]
    assert result['groups'][0] == p['groups'][0]
    assert g['parameters'] == standard['parameters'] | {'energy_shift': 0.}
    assert g['data_type'] == dtype and not g['frozen'] and not g['marked']
    assert (g['multiplier'], g['offset']) == (2.5, .7)
    assert g['source']['edge_identity'] == standard['source']['edge_identity']
    assert g['source']['import_preprocessing']['copied_parameters']['rbkg'] == 1.2
    assert g['processing_error'] is None
    assert g['energy'] == x.tolist() and g['mu'] == y.tolist()


@pytest.mark.parametrize('refs', ['neither', 'both', 'moving', 'standard', 'reverse_link'])
@pytest.mark.parametrize('copy_parameters', [False, True])
def test_alignment_uses_paired_references_preserves_chemical_edge_offsets_and_standard(store, xas_arrays, refs, copy_parameters):
    x, y = xas_arrays
    use_ref = refs in ('both', 'reverse_link')
    p = standard_project(store, x, y, ref=refs in ('both', 'standard', 'reverse_link'), shift=1.5)
    standard = p['groups'][0]
    if refs == 'reverse_link':
        standard['reference_id'] = None; p['groups'][1]['reference_id'] = standard['id']
        p = store.save(p, store.load(p['id']), 'reverse native link')
    # +3 eV scan-axis error and +6 eV real sample chemistry; the foil is unchanged.
    sample = np.interp(x - 6, x, y)
    req, ids = staged(store, p, x + 3, sample=sample, ref=y)
    if refs in ('both', 'moving', 'reverse_link'):
        req.reference_numerator = ids['ref']; req.reference_log = False
    req.preprocessing = ImportPreprocessing(mark=True, standard_id=standard['id'], copy_parameters=copy_parameters, align=True)
    before = copy.deepcopy(p)
    preview = store.preview_columns(p['id'], req)
    assert any('original energy axis' in w for w in preview['warnings'])
    assert store.load(p['id']) == before
    result = store.import_data(p['id'], req)
    assert result['groups'][:len(p['groups'])] == before['groups']
    g = result['groups'][len(p['groups'])]
    alignment = g['source']['import_preprocessing']['alignment']
    assert alignment['used_references'] is use_ref
    assert alignment['energy_shift'] == pytest.approx(-1.5 if use_ref else -7.5, abs=.03)
    assert g['parameters']['energy_shift'] == alignment['energy_shift']
    assert g['energy'] == (x + 3).tolist() and g['mu'] == sample.tolist()
    if g['reference_id']:
        ref = next(a for a in result['groups'] if a['id'] == g['reference_id'])
        assert ref['parameters']['energy_shift'] == g['parameters']['energy_shift']
        assert not ref['marked'] and ref['processing_error'] is None
    if copy_parameters:
        assert g['parameters']['e0'] == standard['parameters']['e0']
    else:
        assert g['result']['effective']['e0'] - standard['result']['effective']['e0'] == pytest.approx(6 if use_ref else 0, abs=1)
    assert g['processing_error'] is None


def test_med_alignment_fits_once_and_reuses_shift(store, xas_arrays):
    x, y = xas_arrays; p = standard_project(store, x, y)
    req, ids = staged(store, p, x + 2, first=y, second=np.interp(x - 3, x, y))
    req.numerator = [ids['first'], ids['second']]; req.individual_channels = True
    req.preprocessing = ImportPreprocessing(standard_id=p['groups'][0]['id'], align=True)
    result = store.import_data(p['id'], req); a, b = result['groups'][-2:]
    assert a['parameters']['energy_shift'] == b['parameters']['energy_shift'] == -2
    assert a['source']['import_preprocessing']['alignment'] == b['source']['import_preprocessing']['alignment']
    assert b['result']['effective']['e0'] - a['result']['effective']['e0'] == pytest.approx(3, abs=.5)


@pytest.mark.parametrize('invalid', ['missing', 'chi', 'difference', 'unprocessed', 'flat_reference', 'far_away', 'invalid_copy'])
def test_invalid_preprocessing_is_atomic_and_retry_keeps_the_upload(store, xas_arrays, invalid):
    x, y = xas_arrays; p = standard_project(store, x, y, ref=invalid == 'flat_reference')
    std = p['groups'][0]
    if invalid == 'chi': std['data_type'] = 'chi'
    if invalid == 'difference': std['is_difference'] = True
    if invalid == 'unprocessed': std['processing_error'] = 'repair me'
    if invalid == 'invalid_copy': std['parameters']['fnorm'] = True
    p = store.save(p, store.load(p['id']), 'invalid fixture')
    req, ids = staged(store, p, x + (1000 if invalid == 'far_away' else 3), mu=y, ref=np.ones(len(x)))
    if invalid == 'far_away':
        # Explicitly choose a different edge to make the fit's edge window unsupported.
        req.numerator = [ids['ref']]
    if invalid == 'flat_reference': req.reference_numerator = ids['ref']; req.reference_log = False
    if invalid == 'invalid_copy': req.data_type = 'norm'
    req.preprocessing = ImportPreprocessing(standard_id='not-here' if invalid == 'missing' else std['id'], align=True,
        copy_parameters=invalid == 'invalid_copy')
    with pytest.raises(ValueError): store.import_data(p['id'], req)
    assert store.load(p['id']) == p
    req.preprocessing = ImportPreprocessing(mark=True)
    assert len(store.import_data(p['id'], req)['groups']) > len(p['groups'])


def test_preprocessing_roundtrips_saved_recipe_diagnostics_and_raw_columns(store, xas_arrays):
    x, y = xas_arrays; p = standard_project(store, x, y)
    req, _ = staged(store, p, x + 2.25, mu=y)
    req.preprocessing = ImportPreprocessing(mark=True, standard_id=p['groups'][0]['id'], align=True, copy_parameters=True)
    result = store.import_data(p['id'], req); g = result['groups'][-1]
    for data, filename in [(store.export_project(p['id'], format='json'), 'saved.json'), (store.export_project(p['id'], format='prj'), 'saved.prj')]:
        other = store.create(); restored = store.restore(other['id'], other['version'], data, filename)
        out = restored['groups'][-1]
        assert out['source']['import_preprocessing'] == g['source']['import_preprocessing']
        assert out['source']['column_arrays'] == g['source']['column_arrays']
        assert out['parameters'] == g['parameters'] and out['marked'] is True
        np.testing.assert_allclose(out['result']['arrays']['norm'], g['result']['arrays']['norm'], rtol=1e-10)


def test_background_standard_link_is_copied_as_a_dependency(store, xas_arrays):
    x, y = xas_arrays; p = standard_project(store, x, y)
    background = store.make_group('background foil', x, y)
    p['groups'].append(background); p['groups'][0]['background_standard_id'] = background['id']
    p = store.save(p, store.load(p['id']), 'linked standard')
    req, _ = staged(store, p, x, mu=y)
    req.preprocessing = ImportPreprocessing(standard_id=p['groups'][0]['id'], copy_parameters=True)
    result = store.import_data(p['id'], req)
    assert result['groups'][-1]['background_standard_id'] == background['id']
    assert result['groups'][-1]['result']['effective']['background_standard'] is True
    assert result['groups'][:2] == p['groups']


@pytest.mark.parametrize('options', [{'align': True}, {'copy_parameters': True}, {'mark': 'false'}, {'align': 1}, {'standard_id': 1}, {'unknown': 2}])
def test_preprocessing_contract_rejects_invalid_options(options):
    with pytest.raises(ValidationError): ImportPreprocessing.model_validate(options)


def test_chi_marking_allowed_but_standard_operations_rejected(store):
    p = store.create(); k = np.arange(0, 14, .05)
    req, _ = staged(store, p, k, chi=np.sin(k)); req.data_type = 'chi'
    req.preprocessing = ImportPreprocessing(standard_id='not-even-queried', align=True)
    with pytest.raises(ValueError, match='energy data'): store.import_data(p['id'], req)
    assert store.load(p['id']) == p
    req.preprocessing = ImportPreprocessing(mark=False)
    assert store.import_data(p['id'], req)['groups'][0]['marked'] is False


def test_http_preprocessing_and_stale_version(tmp_path, xas_arrays):
    settings = Settings(data_root=tmp_path); store = AthenaStore(settings)
    x, y = xas_arrays; p = standard_project(store, x, y)
    req, _ = staged(store, p, x + 3, mu=y)
    req.preprocessing = ImportPreprocessing(standard_id=p['groups'][0]['id'], align=True)
    with TestClient(create_app(settings)) as client:
        url = f"/api/athena/projects/{p['id']}/import"
        invalid = req.model_dump() | {'preprocessing': {'align': True}}
        assert client.post(url, json=invalid).status_code == 422
        response = client.post(url, json=req.model_dump())
        assert response.status_code == 200, response.text
        assert response.json()['groups'][-1]['parameters']['energy_shift'] == -3
        assert client.post(url, json=req.model_dump()).status_code == 409


@pytest.mark.parametrize('offset,amplitude', [(-4.3214, .2), (3.1254, 2.), (7.6544, 1.5)])
def test_native_larch_alignment_template_on_measured_copper(store, offset, amplitude):
    # Compare against a known rigid translation of real measured Cu data, not
    # a second call to our mapping or an expected value read from its output.
    table = np.loadtxt(Path(__file__).parents[2] / 'examples/xafsdata/cu_10k.xmu')
    assert len(table) == 612
    x, y = table[:, 0], table[:, 1]
    std = store.make_group('measured Cu', x, y)
    moving = store.make_group('translated Cu', x + offset, y * amplitude)
    before = copy.deepcopy([moving, std])
    result = import_alignment(moving, std)
    assert result['fitted_shift'] == pytest.approx(-offset, abs=.003)
    assert result['energy_shift'] == float(f'{-offset:.3f}')
    assert result['derivative_scale'] == pytest.approx(1 / amplitude, rel=1e-4)
    assert result['shift_stderr'] is not None
    assert [moving, std] == before


def test_failed_later_med_channel_rolls_back_already_processed_sample_and_reference(store, xas_arrays):
    x, y = xas_arrays; p = standard_project(store, x, y, ref=True)
    req, ids = staged(store, p, x, first=y, invalid=np.ones(len(x)), ref=y)
    req.numerator = [ids['first'], ids['invalid']]; req.individual_channels = True
    req.reference_numerator = ids['ref']; req.reference_log = False
    req.preprocessing = ImportPreprocessing(standard_id=p['groups'][0]['id'], align=True, copy_parameters=True)
    with pytest.raises(ValueError): store.import_data(p['id'], req)
    assert store.load(p['id']) == p
