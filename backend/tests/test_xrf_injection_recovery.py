"""Does the extraction recover a chi(k) it was never shown?

The other engine tests build their spectra from the same Larch model the
engine fits with, so a wrong peak shape or a wrong continuum cancels on both
sides. These tests use `xrf_injection_fixture`, which is written against no
part of Larch or of the engine: a different peak shape, a different continuum,
a quadratic channel axis, and a known single-shell EXAFS chi(k) driving the
target element's fluorescence. The question each one asks is whether the
number that comes out the far end -- after the same pre_edge and autobk any
user would run -- is the chi(k) that went in.

Every test is named for one failure in the table at the end of
docs/athena-xrf-xas-reference.md. Nothing here is measured data.
"""
import numpy as np
import pytest

import xrf_injection_fixture as fx
from xraylarch_web import athena_xrf_xas as engine

pytestmark = pytest.mark.xrf_slow

E0 = fx.E0_EV
POINTS = 280
# The comparison window. Its top is well below the Fe K edge at E0 + 573 eV,
# so what the tests measure there is the target's own oscillation.
KGRID = np.arange(3.0, 10.0001, 0.05)

# Reference error from processing the exactly known mu(E), at this scan length
# and knot density. This is a control, not a mathematical lower bound: extraction
# and background errors can partially cancel.
DOWNSTREAM_FLOOR = 0.07


def options(**over):
    base = dict(version=1, scan_id='injection_recovery_0001', detector='ge',
                target='Mn', matrix_elements=['Fe', 'Cr'], i0_channel='i0',
                channel_range=[int(fx.CHANNELS[0]), int(fx.CHANNELS[-1]) + 1],
                roi_range=[560, 620], cal_offset=0.0, cal_slope=0.010,
                compton_angle=118.0, calibration_points=8, e0=E0,
                norm2=880.0, include_window_sum=True)
    base.update(over)
    return engine.XrfXasOptions(**base)


def chi_of(energy_ev, mu):
    """Compare in edge-step units, including the processed-truth control."""
    from larch import Group
    from larch.xafs import autobk, pre_edge

    group = Group(energy=np.asarray(energy_ev, dtype=float),
                  mu=np.asarray(mu, dtype=float))
    pre_edge(group, e0=E0, pre1=-170, pre2=-40, norm1=100, norm2=880, nnorm=2)
    group = Group(energy=group.energy, mu=group.mu/group.edge_step)
    autobk(group, e0=E0, edge_step=1., rbkg=1.0, kweight=2, kmin=0.0, kmax=14.0)
    return np.interp(KGRID, group.k, group.chi)


def misfit(chi, reference=None):
    """RMS difference in k^2 chi, as a fraction of the reference's own RMS."""
    reference = fx.injected_chi(KGRID) if reference is None else reference
    weight = KGRID ** 2
    return float(np.sqrt(np.mean(((chi - reference) * weight) ** 2))
                 / np.sqrt(np.mean((reference * weight) ** 2)))


def pre_edge_fraction(energy_ev, mu):
    """The pre-edge level as a fraction of the edge jump."""
    energy_ev = np.asarray(energy_ev, dtype=float)
    below, above = energy_ev < E0 - 40.0, energy_ev > E0 + 100.0
    mu = np.asarray(mu, dtype=float)
    return float(np.mean(mu[below]) / (np.mean(mu[above]) - np.mean(mu[below])))


def run(**generator):
    scan, counts, truth = fx.scan_and_counts(points=POINTS, **generator)
    matrix = generator.get('matrix', ('Fe', 'Cr'))
    opts = options(matrix_elements=list(matrix),
                   open_gates=[] if generator.get('gated', True) else list(matrix))
    result = engine.extract(scan, counts, opts)
    print('Detector calibration:', [dict(response_model=r['response_model'],
                                         success=r['success'], at_bounds=r['at_bounds'])
                                    for r in result['detector_reports']])
    return result, np.array(result['energy_ev']), np.array(result['fit_over_i0']), truth


@pytest.fixture(scope='module')
def measured():
    """The honest case: two matrix elements, counting statistics, everything on."""
    return run(noise=True)


@pytest.fixture(scope='module')
def quiet():
    """The same scan with the statistics switched off, so what is left is bias."""
    return run(noise=False)


@pytest.fixture(scope='module')
def ungated():
    """Fe excited at every point, so its lines overlap the target's but its own
    absorption edge makes no step inside the scan."""
    return run(noise=False, gated=False)


@pytest.fixture(scope='module')
def no_matrix():
    """Only the target, the scatter and the continuum: the detector response is
    still one the engine's model cannot reach, but nothing else competes."""
    return run(noise=False, matrix=())


def test_a_chi_the_model_never_saw_comes_back_out(measured):
    """Fails if the extraction only reproduces spectra its own basis made.

    Nothing in the scan is drawn from the engine's model, and the injected
    chi(k) is known exactly, so this is the only test that can say whether the
    method works on a detector rather than on itself.
    """
    _, energy, fit, truth = measured
    assert misfit(chi_of(energy, fit)) < 0.20
    # And against what a perfect extraction of this very scan would have
    # returned, which removes the downstream floor from the comparison.
    assert misfit(chi_of(energy, fit), chi_of(energy, truth)) < 0.20


def test_a_second_charge_collection_tail_does_not_become_exafs():
    """A two-population tail remains outside the fitter's response family."""
    detector = dict(fx.DETECTOR, secondary_tail_frac=0.04, secondary_tail_kev=0.75)
    result, energy, fit, truth = run(noise=True, seed=17, detector=detector)
    assert all(report['success'] for report in result['detector_reports'])
    assert misfit(chi_of(energy, fit)) < 0.20
    assert misfit(chi_of(energy, fit), chi_of(energy, truth)) < 0.20


@pytest.mark.parametrize('noise_kev,fano', [(0.068, 0.000385), (0.04, 0.0004209)],
                         ids=['germanium_width', 'silicon_drift_like_width'])
@pytest.mark.parametrize('matrix', [('Fe', 'Cr'), ('Cr',)], ids=['gated_iron', 'no_iron'])
@pytest.mark.parametrize('noise', [False, True], ids=['noiseless', 'poisson'])
def test_realistic_detector_widths_recover_the_injected_signal(noise_kev, fano, matrix, noise):
    """Physical Fano broadening must work with and without the overlapping Fe line."""
    detector = dict(fx.DETECTOR, noise_kev=noise_kev, fano=fano)
    result, energy, fit, truth = run(noise=noise, detector=detector, matrix=matrix)
    assert all(report['success'] for report in result['detector_reports'])
    assert misfit(chi_of(energy, fit)) < 0.20
    assert misfit(chi_of(energy, fit), chi_of(energy, truth)) < 0.20


def test_the_window_sum_does_not_recover_what_the_fit_recovers(measured):
    """Fails if the fitting buys nothing over summing a fixed channel window.

    The scatter peaks sweep through the window as the mono scans; if a plain
    ROI sum came back with the same chi(k), this whole module would be
    unnecessary work.
    """
    result, energy, fit, _ = measured
    fitted = misfit(chi_of(energy, fit))
    summed = misfit(chi_of(energy, np.array(result['roi_over_i0'])))
    assert summed > 10.0 * fitted


def test_nothing_fluoresces_below_the_target_edge(no_matrix):
    """Fails if scatter or continuum leaks into the target column.

    The generator gives the target element no absorption below its own edge,
    so a perfect extraction returns zero there. A leak fills the pre-edge,
    inflates the jump it is divided by, and shrinks every amplitude after it.
    """
    result, energy, fit, _ = no_matrix
    assert abs(pre_edge_fraction(energy, fit)) < 0.01
    null = result['quality']['fit']['null_test']
    assert abs(null['mean_frac_of_jump']) < engine.NULL_MEAN_LIMIT
    assert null['detrended_rms_frac_of_jump'] < engine.NULL_RMS_LIMIT
    # No level leaks in, but the extraction is not flat below the edge: it
    # tilts by about one percent of the jump across the pre-edge window, and
    # carried over the whole scan, which is how a tilt reaches the
    # normalisation, that is past the drift limit. The verdict says so
    # rather than calling the baseline clean.
    assert abs(null['drift_over_scan_frac_of_jump']) > engine.NULL_DRIFT_LIMIT
    assert result['quality']['fit']['checks']['pre_edge_null'] is False


def test_a_pre_edge_leak_is_reported_rather_than_hidden(quiet):
    """A known added leak must be displayed and must fail the null check."""
    result, energy, fit, _ = quiet
    # Requiring matrix contamination to exceed another fit's error rewards a
    # defect; inject a known offset instead of requiring that defect to exist.
    fit = fit + 0.1 * result['quality']['fit']['edge_step']
    quality = engine._quality(energy, fit, np.asarray(result['roi_over_i0']), fit[None, :], options())
    leak = pre_edge_fraction(energy, fit)
    assert quality['fit']['checks']['pre_edge_null'] is False
    shown = quality['fit']['null_test']['mean_frac_of_jump']
    assert shown == pytest.approx(leak, rel=0.15)
    assert quality['fit']['checks']['pre_edge_null'] is (abs(shown) < engine.NULL_MEAN_LIMIT and abs(
        quality['fit']['null_test']['drift_over_scan_frac_of_jump']) < engine.NULL_DRIFT_LIMIT)


def test_detectors_of_unequal_gain_agree_after_their_own_calibrations(no_matrix):
    """Fails if a detector's calibration is fitted on the wrong detector.

    The two detectors differ by 28 % in gain and by their deadtime. Their edge
    jumps must differ; their normalised shapes must not.
    """
    result, _, _, _ = no_matrix
    agreement = result['quality']['detector_agreement']
    assert agreement['detectors'] == 2
    assert agreement['edge_step_spread'] > 0.05
    assert agreement['worst_pairwise_rms'] < engine.SHAPE_RMS_LIMIT
    assert agreement['checks']['shape_agreement'] is True


def test_an_ungated_matrix_recovers_but_an_added_leak_is_reported(quiet, ungated):
    """Overlap permits recovery; a deliberately added leak is not hidden."""
    _, energy, fit, truth = ungated
    without_step = misfit(chi_of(energy, fit))
    assert without_step < 1.6 * DOWNSTREAM_FLOOR
    assert misfit(chi_of(energy, fit), chi_of(energy, truth)) < 0.05
    # A required twofold error increase forbids a correct matrix extraction;
    # retain the recovery limits and explicitly inject the bias to be reported.
    result, quiet_energy, quiet_fit, _ = quiet
    contaminated = quiet_fit + 0.1 * result['quality']['fit']['edge_step']
    quality = engine._quality(quiet_energy, contaminated, np.asarray(result['roi_over_i0']),
                              contaminated[None, :], options())
    assert quality['fit']['null_test']['mean_frac_of_jump'] > engine.NULL_MEAN_LIMIT
