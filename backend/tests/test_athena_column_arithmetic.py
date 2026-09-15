"""Native column arithmetic: sums, constants, sign, scale and suggestions."""
from io import StringIO
import json

import numpy as np
import pytest
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.athena_columns import map_columns, suggest_columns
from xraylarch_web.config import Settings


def staged(tmp_path, xas_arrays):
    x, mu = xas_arrays
    # Log(I0/It) is negative, so native Invert produces a normal rising edge.
    arrays = dict(energy=x / 1000, i0=np.ones(len(x)), it=np.exp(mu), half=np.exp(mu) / 2,
                  ref=np.exp(-mu), mu=mu, sigma=np.full(len(x), .01))
    stream = StringIO()
    np.savetxt(stream, np.column_stack(list(arrays.values())), header='energy i0 it half ref mu stddev', fmt='%.17g')
    store = AthenaStore(Settings(data_root=tmp_path)); p = store.create()
    inspected = store.inspect(p['id'], stream.getvalue().encode(), 'detectors.dat')
    ids = {c['name']: c['column_id'] for c in inspected['columns']}
    return store, p, inspected, ids


@pytest.mark.parametrize('mode', ['mu', 'transmission', 'fluorescence'])
@pytest.mark.parametrize('scale,invert', [(2.5, False), (2.5, True), (-2., True), (0., False)])
def test_scale_inversion_summed_denominator_preview_import_and_exchange(tmp_path, xas_arrays, mode, scale, invert):
    store, p, inspected, ids = staged(tmp_path, xas_arrays)
    numerator = [ids['mu']] if mode == 'mu' else [ids['i0']]
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'], units='keV',
        numerator=numerator, denominator=[ids['it'], ids['half']], mode=mode, invert=invert, signal_multiplier=scale)
    preview = store.preview_columns(p['id'], request)
    imported = store.import_data(p['id'], request)
    g = imported['groups'][0]
    mu = xas_arrays[1]; factor = scale * (-1 if invert else 1)
    denominator = np.exp(mu) * 1.5
    original = mu if mode == 'mu' else -mu - np.log(1.5) if mode == 'transmission' else 1 / denominator
    np.testing.assert_allclose(preview['traces'][0]['y'], factor * original, atol=1e-14)
    assert preview['traces'][0]['y'] == g['mu']
    assert g['multiplier'] == 1 # imported amplitude is independent of plot scaling
    signal = denominator if mode == 'transmission' else np.ones(len(mu)) if mode == 'fluorescence' else mu
    np.testing.assert_allclose(g['source']['raw_arrays']['signal'], factor * signal, atol=1e-14)
    np.testing.assert_allclose(g['source']['raw_arrays']['stddev'], abs(factor) * .01)
    np.testing.assert_allclose(g['source']['column_arrays'][ids['it']], np.exp(mu))
    for format in ('json', 'prj'):
        data = json.dumps(imported).encode() if format == 'json' else store.export_prj(imported)
        destination = store.create()
        restored = store.restore(destination['id'], 0, data, 'roundtrip.' + format)['groups'][0]
        assert restored['mu'] == g['mu']
        assert restored['source'] == g['source']


@pytest.mark.parametrize('numerator', [[], ['1']])
@pytest.mark.parametrize('denominator', [None, [], '1', ['1']])
def test_constant_operands_and_separate_mode_are_valid(numerator, denominator):
    arrays = {'e': np.arange(1., 11.)}
    request = ImportRequest(version=0, upload_id='u', energy_column='e', numerator=numerator,
        denominator=denominator, mode='transmission', individual_channels=True)
    mapped = map_columns(arrays, request)
    assert len(mapped['samples']) == 1
    np.testing.assert_array_equal(mapped['samples'][0]['y'], np.zeros(10))


@pytest.mark.parametrize('negative', ['numerator', 'denominator', 'both'])
def test_native_log_of_absolute_ratio_retains_polarity_and_reports_it(negative):
    arrays = dict(e=np.arange(1., 11.), a=np.full(10, 4.), b=np.full(10, 2.))
    if negative in ('numerator', 'both'): arrays['a'] *= -1
    if negative in ('denominator', 'both'): arrays['b'] *= -1
    request = ImportRequest(version=0, upload_id='u', energy_column='e', numerator=['a'], denominator='b',
        mode='transmission', reference_numerator='a', reference_denominator='b')
    mapped = map_columns(arrays, request)
    np.testing.assert_allclose(mapped['samples'][0]['y'], np.log(2))
    np.testing.assert_allclose(mapped['reference']['y'], np.log(2))
    assert len(mapped['warnings']) == (0 if negative == 'both' else 2)


def test_reference_constants_are_independent_of_sample_scaling(tmp_path, xas_arrays):
    store, p, inspected, ids = staged(tmp_path, xas_arrays)
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'], units='keV',
        numerator=[], denominator=ids['it'], mode='transmission', signal_multiplier=2., invert=True,
        reference_numerator=None, reference_denominator=ids['ref'])
    preview = store.preview_columns(p['id'], request)
    sample, ref = store.import_data(p['id'], request)['groups']
    np.testing.assert_allclose(sample['mu'], 2 * xas_arrays[1], atol=1e-14)
    np.testing.assert_allclose(ref['mu'], xas_arrays[1], atol=1e-14)
    assert ref['mu'] == preview['traces'][1]['y']
    assert sample['processing_error'] is None and ref['processing_error'] is None
    assert ref['source']['mapping']['signal_multiplier'] == 1 and not ref['source']['mapping']['invert']


def test_chi_ignores_absorption_arithmetic_and_keeps_signed_k_signal(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path)); p = store.create()
    k = np.arange(0, 15, .05); chi = np.sin(k)
    stream = StringIO(); np.savetxt(stream, np.column_stack([k, chi]), header='k chi')
    inspected = store.inspect(p['id'], stream.getvalue().encode(), 'wave.chi')
    ids = [c['column_id'] for c in inspected['columns']]
    assert inspected['athena_suggestion']['data_type'] == 'chi'
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids[0], numerator=[ids[1]],
        data_type='chi', units='keV', mode='transmission', denominator='not-used', invert=True, signal_multiplier=12)
    preview = store.preview_columns(p['id'], request)
    g = store.import_data(p['id'], request)['groups'][0]
    np.testing.assert_allclose(g['mu'], chi)
    assert preview['traces'][0]['y'] == g['mu'] and preview['traces'][0]['x'] == g['energy']
    assert g['source']['mapping']['mode'] == 'mu'
    assert g['source']['mapping']['denominator'] is None
    assert g['source']['mapping']['signal_multiplier'] == 1


@pytest.mark.parametrize('denominator', [['b', 'b'], ['missing'], ['b'] * 65])
def test_invalid_denominator_selections_reject(denominator):
    with pytest.raises(ValueError):
        request = ImportRequest(version=0, upload_id='u', energy_column='e', numerator=['a'], denominator=denominator, mode='transmission')
        map_columns(dict(e=np.arange(10.), a=np.ones(10), b=np.ones(10)), request)


@pytest.mark.parametrize('scale', ['', '2', True, float('inf'), float('nan')])
def test_multiplier_must_be_finite_numeric(scale):
    with pytest.raises(ValidationError):
        ImportRequest(version=0, upload_id='u', energy_column='e', numerator=[], signal_multiplier=scale)


@pytest.mark.parametrize('labels, expected', [
    (['energy', 'I0', 'IT', 'IF'], ('transmission', ['c1'], 'c2')),
    (['energy', 'Io', 'I1'], ('transmission', ['c1'], 'c2')),
    (['energy', 'Io', 'IY'], ('fluorescence', ['c2'], 'c1')),
    (['energy', 'ifluor'], ('fluorescence', ['c1'], None)),
    (['energy', 'It'], ('transmission', [], 'c1')),
    (['energy', 'mu', 'i0', 'it'], ('mu', ['c1'], None)),
])
def test_native_detector_label_suggestions(labels, expected):
    columns = [dict(column_id=f'c{i}', name=name, preview=[8., 8.1, 8.2, 8.3, 8.4], unit=None) for i, name in enumerate(labels)]
    suggestion, units = suggest_columns(columns, 'scan.dat')
    assert (suggestion['mode'], suggestion['numerator'], suggestion['denominator']) == expected
    assert suggestion['units'] == 'keV'


@pytest.mark.parametrize('values, unit, expected', [
    ([100, 101, 102, 103, 104], None, 'keV'), ([101, 102, 103, 104, 105], None, 'eV'),
    ([10, 9, 8, 7, 6], None, None), ([1, 1, 1, 1, 1], None, None),
    ([8, 8.1, 8.2, 8.3, 8.4], 'eV', 'eV'), ([8000, 8001, 8002, 8003, 8004], 'keV', 'keV'),
])
def test_units_heuristic_boundaries_and_explicit_metadata(values, unit, expected):
    columns = [dict(column_id=f'c{i}', name=n, preview=values, unit=unit) for i, n in enumerate(['energy', 'mu'])]
    _, units = suggest_columns(columns, 'scan.dat')
    assert units['c0'] == expected


def test_single_column_inspection_stays_usable_with_constant_signal(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path)); p = store.create()
    inspected = store.inspect(p['id'], b'# energy\n9000\n9001\n9002\n9003\n9004\n9005\n9006\n9007\n', 'energy.dat')
    suggestion = inspected['athena_suggestion']
    assert suggestion['numerator'] == [] and suggestion['denominator'] is None
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], **suggestion)
    preview = store.preview_columns(p['id'], request)
    assert preview['traces'][0]['y'] == [1.] * 8
