"""Native scalar grid + PDL conv1d oracle, real quick scan and import lifecycle.

Demeter 06afc8da Data/Process.pm and process/larch/rebin.tmpl;
PDL 2.083 Primitive/primitive.pd conv1d (periodic, forward-centered even widths).
The interpolation oracle is the local Larch function invoked by that template.
"""
import copy
import hashlib
import json
import math
from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch.math import interp
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command, ImportRequest, ImportEdgePolicy, _exchange_source, _exchange_budget
from xraylarch_web.athena_preprocessing import ImportPreprocessing
from xraylarch_web.athena_rebin import ImportRebin, RebinPlan
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
SCAN = FIXTURES / 'demeter-uhup.101'


def native_grid(x, e0, r):
    lo, hi = sorted([r.emin, r.emax]); grid = []
    en = float(x[0])
    while en < e0 + lo:
        grid.append(en); en += r.pre
    en = e0 + lo
    while en < e0 + hi:
        grid.append(en); en += r.xanes
    en, k = e0 + hi, math.sqrt(hi * .262468292)
    while en < x[-1]:
        grid.append(en); k += r.exafs; en = k*k / .262468292 + e0
    grid.append(x[-1])
    return np.array(grid)


def native_values(x, y, grid, width):
    # Scalar transcription of the C loop, independent of vectorized np.roll.
    n = len(y); center = (width - 1) // 2
    smooth = np.array([sum(y[(i + j - center) % n] * (1 / width)
                           for j in range(width)) for i in range(n)])
    return interp(x[1:-1], smooth[1:-1], grid, fill_value=0.)[1:-1]


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def inspected(store, p, *, x=None, columns=None):
    data = SCAN.read_bytes(); name = 'uhup.101'
    if x is not None:
        buf = StringIO()
        np.savetxt(buf, np.column_stack([x, *columns.values()]), header='energy ' + ' '.join(columns), fmt='%.17g')
        data, name = buf.getvalue().encode(), 'detectors.dat'
    info = store.inspect(p['id'], data, name)
    ids = {c['name']: c['column_id'] for c in info['columns']}
    return ImportRequest(version=p['version'], upload_id=info['upload_id'], energy_column=ids['energy'],
        numerator=[ids[next(iter(columns))]] if columns else [ids['mcs3']],
        denominator=None if columns else ids['mcs4'], mode='mu' if columns else 'transmission',
        rebin=ImportRebin(), preprocessing=ImportPreprocessing()), ids


@pytest.mark.parametrize('width', range(1, 12))
@pytest.mark.parametrize('reversed_bounds', [False, True])
def test_native_grid_boxcar_endpoints_and_even_widths(width, reversed_bounds):
    x = np.linspace(8750, 9350, 1201); y = np.random.default_rng(8).normal(size=len(x))
    r = ImportRebin(width=width, emin=50 if reversed_bounds else -30, emax=-30 if reversed_bounds else 50)
    plan = RebinPlan(x, r, 8980); grid = native_grid(x, 8980, r)
    np.testing.assert_array_equal(plan.energy, grid[1:-1])
    np.testing.assert_allclose(plan.apply(y), native_values(x, y, grid, width), rtol=3e-14, atol=3e-14)
    assert len(plan.energy) < len(x) and plan.energy[0] > x[0] and plan.energy[-1] < x[-1]


@pytest.mark.parametrize('width', [1, 2, 3, 4, 11])
@pytest.mark.parametrize('duplicates', [False, True])
def test_uncertainty_matches_full_independent_linear_operator(width, duplicates):
    x = np.linspace(8750, 9350, 45)
    if duplicates:
        x[2] = x[1]; x[20] = x[19]; x[-2] = x[-3]
    r = ImportRebin(width=width, pre=1., xanes=2., exafs=.3)
    plan = RebinPlan(x, r, 8980)
    grid = native_grid(x, 8980, r)
    # Matrix oracle independently smooths/interpolates each observation's
    # unit vector, exposing overlap correlations and extrapolation weights.
    matrix = np.column_stack([native_values(x, row, grid, width) for row in np.eye(len(x))])
    sigma = np.linspace(.001, .03, len(x))
    expected = np.sqrt((matrix**2) @ (sigma**2))
    np.testing.assert_allclose(plan.uncertainty(sigma), expected, rtol=3e-10, atol=3e-12)


def test_exact_repeated_grid_energy_uses_last_smoothed_reading():
    x = np.arange(8750., 9351., 10.); x[25] = x[24]
    y = np.arange(len(x), dtype=float)**2
    r = ImportRebin(); plan = RebinPlan(x, r, 8980)
    at = np.flatnonzero(plan.energy == x[24])[0]
    assert plan.apply(y)[at] == pytest.approx((y[24] + y[25] + y[26]) / 3)
    grid = native_grid(x, 8980, r)
    matrix = np.column_stack([native_values(x, row, grid, 3) for row in np.eye(len(x))])
    sigma = np.linspace(.1, 1, len(x))
    np.testing.assert_allclose(plan.uncertainty(sigma), np.sqrt((matrix**2) @ (sigma**2)), rtol=1e-11)


@pytest.mark.parametrize('options', [{'pre': 0}, {'exafs': -1}, {'xanes': float('nan')}, {'width': 2.5},
    {'width': True}, {'width': 12}, {'width': 0}, {'e0': -1}, {'e0': '8980'}, {'typo': 2}])
def test_invalid_rebin_contract(options):
    with pytest.raises(ValidationError): ImportRebin(**options)


@pytest.mark.parametrize('options,match', [({'e0': 8700}, 'inside'), ({'emin': 50, 'emax': 50}, 'boundaries'),
    ({'emax': -10}, 'boundaries'), ({'emin': -500}, 'boundaries'), ({'pre': 1e-30}, 'precision'),
    ({'xanes': .00001}, '100,000'), ({'pre': 100, 'xanes': 50, 'exafs': 5}, 'ten distinct')])
def test_invalid_grids_fail_without_large_allocation(options, match):
    r = ImportRebin(**options)
    with pytest.raises(ValueError, match=match): RebinPlan(np.linspace(8750, 9350, 100), r, r.e0 or 8980)


def test_real_quick_scan_preview_import_roundtrip_and_undo(store):
    manifest = json.loads((FIXTURES / 'athena-rebin-fixtures.json').read_text())
    assert hashlib.sha256(SCAN.read_bytes()).hexdigest() == manifest['files'][0]['sha256']
    p = store.create(); r, _ = inspected(store, p)
    preview = store.preview_columns(p['id'], r)
    assert store.load(p['id']) == p
    details = preview['rebin_results'][0]
    assert details['source_points'] == 2006 and details['output_points'] == 396
    assert details['e0'] == 17168.101
    assert not any('must be repaired' in w for w in preview['warnings'])
    result = store.import_data(p['id'], r); g = result['groups'][0]
    assert g['processing_error'] is None and not g['marked']
    assert g['energy'] == preview['traces'][1]['x'] and g['mu'] == preview['traces'][1]['y']
    original = g['source']['rebin_original']; x, y = np.array(original['energy']), np.array(original['mu'])
    assert len(x) == 2006 and np.count_nonzero(np.diff(x) == 0) == 24
    assert len(original['column_arrays']) == 5
    np.testing.assert_allclose(y, np.log(np.array(original['column_arrays']['column_0002']) / original['column_arrays']['column_0003']), rtol=1e-14)
    grid = native_grid(x, details['e0'], r.rebin)
    np.testing.assert_allclose(g['mu'], native_values(x, y, grid, 3), atol=1e-14)
    for key in ['i0', 'signal']:
        np.testing.assert_allclose(g['source']['raw_arrays'][key], native_values(x, original['raw_arrays'][key], grid, 3), rtol=1e-14)
    for fmt in ['json', 'prj']:
        other = store.create()
        out = store.restore(other['id'], other['version'], store.export_project(p['id'], format=fmt), 'saved.' + fmt)['groups'][0]
        assert out['source']['rebin_original'] == original and out['source']['rebin'] == g['source']['rebin']
        np.testing.assert_allclose(out['mu'], g['mu'], rtol=1e-12)
        assert out['processing_error'] is None
    undone = store.command(p['id'], Command(version=result['version'], action='undo'))
    assert undone['groups'] == []


@pytest.mark.parametrize('mode', ['mu', 'transmission', 'fluorescence'])
@pytest.mark.parametrize('dtype', ['mu', 'xanes', 'norm'])
@pytest.mark.parametrize('individual', [False, True])
def test_rebin_selected_arithmetic_keV_sort_and_independent_reference(store, xas_arrays, mode, dtype, individual):
    x, y = xas_arrays; p = store.create()
    a = np.exp(y) if mode == 'transmission' else y
    r, ids = inspected(store, p, x=x[::-1]/1000, columns={'a': a[::-1], 'b': a[::-1],
        'den': np.ones(len(x)), 'ref': np.interp(x - 7, x, y)[::-1], 'stddev': np.full(len(x), .02)})
    r.numerator = [ids['a'], ids['b']]; r.denominator = ids['den']; r.mode = mode
    r.data_type = dtype; r.units = 'keV'; r.sort = True; r.individual_channels = individual
    r.reference_numerator = ids['ref']; r.reference_log = False; r.reference_same_element = False
    r.rebin = ImportRebin(e0=8980, width=4)
    preview = store.preview_columns(p['id'], r); out = store.import_data(p['id'], r)
    assert len(out['groups']) == (4 if individual else 2)
    traces = [t for t in preview['traces'] if t['stage'] == 'rebinned']
    for g, trace in zip(out['groups'], traces, strict=True):
        assert g['energy'] == trace['x'] and g['mu'] == trace['y'] and g['data_type'] == dtype
        assert g['processing_error'] is None
        original = g['source']['rebin_original']
        assert original['row_order'] == list(range(len(x)))[::-1]
        np.testing.assert_array_equal(original['column_arrays']['column_0001'], x/1000)
    sample, ref = out['groups'][:2]
    assert sample['source']['rebin']['e0'] == 8980
    assert ref['source']['rebin']['e0'] == pytest.approx(8987, abs=1)
    assert sample['energy'] != ref['energy']
    expected = RebinPlan(x, r.rebin, 8980).uncertainty(np.full(len(x), .02))
    np.testing.assert_allclose(sample['source']['raw_arrays']['stddev'], expected)


@pytest.mark.parametrize('failure', ['unsorted', 'chi', 'late_channel', 'boundaries'])
def test_rebin_failed_import_is_atomic_and_can_retry(store, xas_arrays, failure):
    x, y = xas_arrays; p = store.create()
    r, ids = inspected(store, p, x=x[::-1] if failure == 'unsorted' else x, columns={'mu': y, 'flat': np.ones(len(x))})
    if failure == 'chi': r.data_type = 'chi'
    if failure == 'late_channel': r.numerator = [ids['mu'], ids['flat']]; r.individual_channels = True
    if failure == 'boundaries': r.rebin.emin = -10000
    with pytest.raises(ValueError): store.import_data(p['id'], r)
    assert store.load(p['id']) == p
    r.sort = True; r.data_type = 'mu'; r.numerator = [ids['mu']]; r.rebin = ImportRebin(e0=8980)
    assert len(store.import_data(p['id'], r)['groups']) == 1


@pytest.mark.parametrize('field', ['energy', 'mu', 'raw_arrays', 'column_arrays', 'row_order'])
def test_retained_original_validation_rejects_corruption(store, xas_arrays, field):
    x, y = xas_arrays
    source = {'rebin_original': {'energy': x.tolist(), 'mu': y.tolist(), 'raw_arrays': {'signal': y.tolist()},
        'column_arrays': {'column_0001': x.tolist()}, 'row_order': list(range(len(x)))}}
    original = source['rebin_original']
    if field in ('energy', 'mu'): original[field][2] = float('nan')
    elif field == 'row_order': original[field][2] = 0
    else: original[field][next(iter(original[field]))].pop()
    with pytest.raises(ValueError): _exchange_source(source, 400, store.settings)


def test_real_quickscan_http_preview_and_import(tmp_path):
    settings = Settings(data_root=tmp_path); store = AthenaStore(settings)
    p = store.create(); r, _ = inspected(store, p)
    with TestClient(create_app(settings)) as client:
        base = f"/api/athena/projects/{p['id']}"
        preview = client.post(base + '/preview-columns', json=r.model_dump())
        assert preview.status_code == 200, preview.text
        response = client.post(base + '/import', json=r.model_dump())
        assert response.status_code == 200, response.text
        assert response.json()['groups'][0]['energy'] == preview.json()['traces'][1]['x']


@pytest.mark.parametrize('use_reference', [False, True])
def test_rebin_precedes_standard_copy_and_alignment_preserving_original_arrays(store, xas_arrays, use_reference):
    x, y = xas_arrays; p = store.create()
    std = store.make_group('standard', x, y, parameters={'energy_shift': 1.5, 'e0': 8981.5, 'rbkg': 1.2})
    p['groups'] = [std]
    if use_reference:
        ref = store.make_group('foil', x, y, parameters={'energy_shift': 1.5, 'e0': 8981.5})
        p['groups'].append(ref); std['reference_id'] = ref['id']
    p = store.save(p, store.load(p['id']), 'standard')
    moving = np.interp(x - 6, x, y) if use_reference else y
    r, ids = inspected(store, p, x=x+3, columns={'sample': moving, 'ref': y})
    r.preprocessing = ImportPreprocessing(standard_id=std['id'], mark=True, copy_parameters=True, align=True)
    if use_reference:
        r.reference_numerator = ids['ref']; r.reference_log = False
    preview = store.preview_columns(p['id'], r)
    out = store.import_data(p['id'], r); sample = out['groups'][len(p['groups'])]
    assert out['groups'][:len(p['groups'])] == p['groups']
    assert sample['parameters']['energy_shift'] == pytest.approx(-1.5, abs=.06)
    assert sample['parameters']['e0'] == std['parameters']['e0']
    assert sample['parameters']['rbkg'] == 1.2 and sample['marked']
    assert sample['processing_error'] is None
    assert sample['energy'] == next(t['x'] for t in preview['traces'] if t.get('stage') == 'rebinned')
    assert sample['source']['rebin_original']['energy'] == (x+3).tolist()
    assert sample['source']['rebin_original']['mu'] == moving.tolist()
    if use_reference:
        ref = out['groups'][-1]
        assert ref['parameters']['energy_shift'] == sample['parameters']['energy_shift']
        assert sample['source']['rebin']['e0'] - ref['source']['rebin']['e0'] == pytest.approx(6, abs=1)


def test_reference_rebin_grid_uses_native_same_element_25ev_safeguard(store, xas_arrays):
    x, y = xas_arrays; p = store.create()
    r, ids = inspected(store, p, x=x, columns={'mu': y, 'ref': np.interp(x-50, x, y)})
    r.reference_numerator = ids['ref']; r.reference_log = False; r.reference_same_element = True
    preview = store.preview_columns(p['id'], r)
    ref = preview['rebin_results'][1]
    assert ref['e0_method'] == 'reference-atomic-safeguard' and ref['e0'] == 8979
    assert len(store.import_data(p['id'], r)['groups']) == 2


def test_retained_original_values_count_toward_project_budget(store):
    original = {'energy': [1.] * 200000, 'mu': [1.] * 200000,
        'column_arrays': {str(i): [1.] * 200000 for i in range(9)}}
    with pytest.raises(ValueError, match='2,000,000 retained'):
        _exchange_budget([{'energy': [1.] * 10, 'mu': [1.] * 10, 'source': {'rebin_original': original}}], store.settings)


def test_retained_original_order_and_point_limit_validation(store):
    for original in [
        {'energy': list(range(10)), 'mu': [1.] * 10, 'column_order': 'upload'},
        {'energy': list(range(10))[::-1], 'mu': [1.] * 10},
        {'energy': list(range(11)), 'mu': [1.] * 11},
    ]:
        with pytest.raises(ValueError):
            _exchange_source({'rebin_original': original}, 10, Settings(data_root=store.settings.data_root, max_points=10))


@pytest.mark.parametrize('fraction', [.4, .7])
def test_enforced_real_quickscan_refines_grid_fraction_before_rebin_and_final_fraction_after(store, fraction):
    from larch import Group
    from larch.xafs import pre_edge
    from xraylarch_web.athena_import_policy import initialize_import
    p = store.create(); r, _ = inspected(store, p)
    r.edge_policy = ImportEdgePolicy(element='U', edge='L3', fraction=fraction)
    preview = store.preview_columns(p['id'], r); g = store.import_data(p['id'], r)['groups'][0]
    original = g['source']['rebin_original']
    x, y = np.asarray(original['energy']), np.asarray(original['mu'])
    seed = initialize_import(x, y, policy=r.edge_policy.model_dump(), _for_rebin=True)
    e0 = preview['rebin_results'][0]['e0']
    assert e0 == seed['e0_selection']['e0'] and abs(e0 - 17166) > .1
    assert preview['rebin_results'][0]['e0_method'] == 'enforced-fraction'
    # Independently normalize at the converged grid E0, then linearly bracket
    # the selected fraction on the original measured energies.
    pars = seed['parameters']; norm = Group()
    pre_edge(x, y, group=norm, e0=e0, pre1=pars['pre1'], pre2=pars['pre2'],
             norm1=pars['norm1'], norm2=pars['norm2'], nnorm=pars['nnorm'], make_flat=False)
    hi = np.flatnonzero(norm.norm >= fraction)[0]; lo = hi - 1
    expected = x[lo] + (x[hi]-x[lo]) * (fraction-norm.norm[lo]) / (norm.norm[hi]-norm.norm[lo])
    assert e0 == pytest.approx(expected, abs=.001)
    final = initialize_import(g['energy'], g['mu'], policy=r.edge_policy.model_dump())
    assert g['parameters']['e0'] == final['e0_selection']['e0']
    assert g['source']['edge_identity']['element'] == 'U' and g['processing_error'] is None


def test_enforced_dense_grid_uses_all_readings_without_atomic_fallback(store):
    p = store.create(); x = np.linspace(8750, 9350, 100001)
    y = .1 + .85 / (1 + np.exp(-(x-8980)/2.5))
    r, _ = inspected(store, p, x=x, columns={'mu': y})
    r.edge_policy = ImportEdgePolicy(element='Cu', edge='K', fraction=.7)
    preview = store.preview_columns(p['id'], r)
    assert preview['rebin_results'][0]['source_points'] == 100001
    assert preview['rebin_results'][0]['e0'] == pytest.approx(8980 + 2.5 * np.log(.7/.3), abs=.05)
    g = store.import_data(p['id'], r)['groups'][0]
    assert len(g['source']['rebin_original']['energy']) == 100001
    assert g['processing_error'] is None
