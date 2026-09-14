"""Independent mathematical and negative controls for native replay oracles."""
from fractions import Fraction
import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from reference.native_larch_replay import replay_alignment, replay_calibration, replay_smoothing


FIXTURES = Path(__file__).parent / 'fixtures'


def exact_smoothing_weights(window, order):
    """Solve integer normal equations exactly, without floating-point LAPACK."""
    xs = range(-(window // 2), window // 2 + 1)
    n = order + 1
    augmented = [[Fraction(sum(x ** (i + j) for x in xs)) for j in range(n)]
                 + [Fraction(i == 0)] for i in range(n)]
    for i in range(n):
        pivot = augmented[i][i]
        augmented[i] = [v / pivot for v in augmented[i]]
        for j in range(n):
            if i != j:
                scale = augmented[j][i]
                augmented[j] = [v - scale * u for v, u in zip(augmented[j], augmented[i])]
    coefficients = [row[-1] for row in augmented]
    return np.array([float(sum(c * x ** i for i, c in enumerate(coefficients))) for x in xs])


@pytest.mark.parametrize('window,order,budget', [(9, 2, 2e-15), (31, 4, 3e-14)])
def test_native_impulse_matches_exact_rational_coefficients(window, order, budget):
    # At (31,4), the raw Vandermonde condition number is 35946 and measured
    # OpenBLAS coefficient error is 2.09e-14. This separate mathematical test
    # has a 3e-14 absolute coefficient budget, not a relaxed spectrum golden.
    signal = np.zeros(3 * window)
    signal[len(signal) // 2] = 1.
    actual = replay_smoothing(f'h.xmu = savitzky_golay(g.xmu, {window}, {order})', signal)
    center = len(signal) // 2
    np.testing.assert_allclose(actual[center-window//2:center+window//2+1],
                               exact_smoothing_weights(window, order), atol=budget, rtol=0.)


@pytest.mark.parametrize('window,order,budget,recorded_name', [
    (31, 9, 1e-8, 'factory'),
    (39, 9, 1e-7, 'large-window-clamps'),
    (13, 11, 3e-9, 'apply-order'),
])
def test_high_order_native_and_archived_outputs_have_bounded_rational_error(window, order, budget, recorded_name):
    # Explicit coefficient regression budgets, not worst-case LAPACK bounds.
    # Against exact rational weights, Linux/OpenBLAS errors for these rows are
    # 2.664e-9, 2.446e-8, 6.608e-10. Coefficients recovered independently from
    # the archived Cu outputs give 8.948e-9, 1.068e-9, 1.123e-9. That recovery
    # has convolution design condition numbers below 6440 and reconstructs
    # archived samples within 7.1e-15. These fixed budgets cover BOTH observed
    # backends, while retaining a fail-closed ceiling for future drift.
    exact = exact_smoothing_weights(window, order)
    signal = np.zeros(3 * window)
    center, half = len(signal) // 2, window // 2
    signal[center] = 1.
    actual = replay_smoothing(f'h.xmu = savitzky_golay(g.xmu, {window}, {order})', signal)
    coefficients = actual[center-half:center+half+1]
    np.testing.assert_allclose(coefficients, exact, atol=budget, rtol=0.)
    corrupted = coefficients.copy()
    corrupted[half] += 3 * budget
    with pytest.raises(AssertionError):
        np.testing.assert_allclose(corrupted, exact, atol=budget, rtol=0.)

    fixture = json.loads(gzip.decompress((FIXTURES / 'athena-smoothing-preferences-native.json.gz').read_bytes()))
    row = next(row for row in fixture['rows'] if row['name'] == recorded_name)
    assert row['values'] == dict(window=window, order=order)
    y = np.asarray(fixture['input_mu'])
    # Native endpoint rule, followed by exact rational convolution weights.
    # For |coefficient error| <= budget, triangle inequality bounds each
    # output error by budget * sum(abs(local padded signal)). This tests the
    # immutable historical samples too, without regenerating native fixtures.
    padded = np.concatenate((y[0] - abs(y[1:half+1][::-1] - y[0]), y,
                             y[-1] + abs(y[-half-1:-1][::-1] - y[-1])))
    reference = np.convolve(exact, padded, mode='valid')
    local_magnitude = np.convolve(np.ones(window), abs(padded), mode='valid')
    # Account separately for rounding in the final floating-point convolution.
    convolution_roundoff = 4 * window * np.finfo(float).eps * local_magnitude
    assert np.all(abs(np.asarray(row['smoothed_mu']) - reference)
                  <= budget * local_magnitude + convolution_roundoff)


def test_native_smoothing_preserves_linear_interior_and_input():
    signal = np.arange(61, dtype=float) / 7.
    before = signal.copy()
    actual = replay_smoothing('h.xmu = savitzky_golay(g.xmu, 9, 2)', signal)
    np.testing.assert_allclose(actual[4:-4], signal[4:-4], atol=2e-14, rtol=2e-14)
    np.testing.assert_array_equal(signal, before)


def test_native_smoothing_rejects_wrong_order_and_padding_at_golden_tolerance():
    signal = np.zeros(61)
    signal[0], signal[28], signal[-1] = -1., 2., .5
    actual = replay_smoothing('h.xmu = savitzky_golay(g.xmu, 9, 2)', signal)
    wrong_order = replay_smoothing('h.xmu = savitzky_golay(g.xmu, 9, 4)', signal)
    wrong_padding = np.convolve(exact_smoothing_weights(9, 2), np.pad(signal, (4, 4)), mode='valid')
    for corrupted in (wrong_order, wrong_padding):
        with pytest.raises(AssertionError):
            np.testing.assert_allclose(actual, corrupted, atol=2e-14, rtol=2e-14)


def test_native_calibration_rejects_wrong_energy_derivative():
    energy = np.linspace(1., 5., 61) ** 2
    mu = np.sin(energy)
    correct = replay_calibration('g.smooth = deriv(g.xmu)/deriv(g.energy)', dict(energy=energy, xmu=mu))
    corrupted = replay_calibration('g.smooth = deriv(g.xmu)', dict(energy=energy, xmu=mu))
    with pytest.raises(AssertionError):
        np.testing.assert_allclose(correct, corrupted, rtol=2e-12, atol=2e-13)


@pytest.mark.parametrize('replay,args', [
    (replay_smoothing, ('h.xmu = missing_native_function(g.xmu)', np.arange(41.))),
    (replay_calibration, (['g.smooth = missing_native_function(g.xmu)'], {'xmu': np.arange(41.)})),
    (replay_alignment, ('missing_native_function()', np.arange(41.), np.arange(41.), np.arange(41.), np.arange(41.))),
])
def test_native_replay_fails_closed_on_command_errors(replay, args):
    with pytest.raises(AssertionError):
        replay(*args)


def test_recorded_alignment_replay_rejects_wrong_fitted_shift():
    fixture = json.loads(gzip.decompress((FIXTURES / 'athena-alignment-native.json.gz').read_bytes()))
    row = fixture['rows'][14]
    standard = fixture['inputs'][row['case']['standard']]
    result = replay_alignment(row['native']['command'], standard['energy'], standard['mu'],
                              row['moving_energy'], row['moving_mu'])
    corrupted = replay_alignment(row['native']['command'], standard['energy'], standard['mu'],
                                  np.asarray(row['moving_energy']) + .01, row['moving_mu'])
    # Misreading moving energies by 0.01 eV changes the inferred shift and
    # must remain detectable under the original strict scalar tolerance.
    with pytest.raises(AssertionError):
        np.testing.assert_allclose(result['fitted_shift'], corrupted['fitted_shift'],
                                   rtol=2e-8, atol=2e-11)


def test_native_alignment_uncertainty_matches_analytic_interpolation_jacobian():
    fixture = json.loads(gzip.decompress((FIXTURES / 'athena-alignment-native.json.gz').read_bytes()))
    row = fixture['rows'][19]
    case = row['case']
    standard = fixture['inputs'][case['standard']]
    result = replay_alignment(row['native']['command'], standard['energy'], standard['mu'],
                              row['moving_energy'], row['moving_mu'])
    x, y = np.asarray(row['moving_energy']), np.asarray(row['moving_mu'])
    rx = np.asarray(standard['energy']) + case['standard_shift']
    start, stop = [np.searchsorted(rx, case['standard_e0'] + offset, side='right') - 1
                   for offset in (-20, 50)]
    # Away from interpolation knots, d interp(x+shift,y,rx)/d shift is
    # minus the segment slope. Propagate that analytic derivative through
    # the linear interior gradient and exact rational SG convolution.
    # No finite difference step or web implementation enters this Jacobian.
    assert start > 16 and stop < len(rx) - 16
    weights = exact_smoothing_weights(31, 9)
    shifted = x + result['fitted_shift']
    segments = np.searchsorted(shifted, rx, side='right') - 1
    segments = np.clip(segments, 0, len(x) - 2)
    slopes = np.diff(y)[segments] / np.diff(x)[segments]
    def filtered_derivative(values):
        return np.convolve(weights, np.gradient(values) / np.gradient(rx), mode='same')[start:stop]
    jacobian = np.column_stack((result['scale'] * filtered_derivative(slopes),
                                -filtered_derivative(np.interp(rx, shifted, y))))
    analytic_stderr = np.sqrt(np.linalg.inv(jacobian.T @ jacobian)[0, 0] * result['redchi'])
    np.testing.assert_allclose(result['stderr'], analytic_stderr, rtol=1e-6, atol=0.)
    with pytest.raises(AssertionError):
        np.testing.assert_allclose(result['stderr'] * (1 + 4e-6), analytic_stderr,
                                   rtol=1e-6, atol=0.)
