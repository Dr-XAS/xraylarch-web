"""Engine tests for the scan-resolved XRF-to-XAS extraction.

Every test is named for one failure in the table at the end of
docs/athena-xrf-xas-reference.md, which was written before any of them. The
spectra are synthesised from Larch's own XRF model, so nothing here depends
on measured data.
"""
import numpy as np
import pytest

from xraylarch_web import athena_xrf_xas as engine
from xraylarch_web.athena_science import ScientificError

pytestmark = pytest.mark.xrf_slow

CHANNELS = np.arange(380, 771)
E0 = 6539.0                      # Mn K edge, eV
FE_EDGE_KEV = 7.112              # sits inside the scan, so Fe switches on
CR_EDGE_KEV = 5.989              # sits below the scan, so Cr is always on

# The shape parameters the synthetic detector really has. Calibration has to
# find these from a start that deliberately disagrees with them.
TRUE_SHAPE = dict(cal_offset=0.004, cal_slope=0.0101, det_noise=0.065,
                  peak_step=1.5e-3, peak_tail=0.06,
                  elastic_sigmax=1.1, elastic_step=0.006, elastic_tail=0.35,
                  compton_sigmax=2.8, compton_step=0.006, compton_tail=1.2,
                  compton_angle=118.0)

# Keyed by component name, not by element: a component is one element's lines
# from one excitation subshell, and the scan sees only the K lines of these
# three inside the fit window.
AMPLITUDES = {'Mn K': 3.0, 'Fe K': 1.0, 'Cr K': 0.5,
              'elastic': 1.0e3, 'compton': 2.0e3}


def mu_true(energy_ev):
    """An arctan edge with one damped oscillation: ~0 below, ~1 above."""
    step = 0.5 + np.arctan((energy_ev - E0) / 4.0) / np.pi
    wiggle = np.where(energy_ev > E0,
                      0.12 * np.sin((energy_ev - E0) / 22.0)
                      * np.exp(-(energy_ev - E0) / 400.0), 0.0)
    return step + wiggle


def make_options(points=40, **overrides):
    settings = dict(
        version=0, scan_id='synthetic-mn-scan-0001', detector='ge', target='Mn',
        matrix_elements=['Fe', 'Cr'], i0_channel='i0',
        channel_range=[int(CHANNELS[0]), int(CHANNELS[-1]) + 1],
        roi_range=[566, 608], detector_material='Ge', detector_thickness=1.0,
        cal_offset=0.0, cal_slope=0.010, compton_angle=110.0,
        calibration_points=4, background='smooth', background_terms=4, e0=E0,
        pre1=-170.0, pre2=-40.0, norm1=100.0, norm2=560.0)
    settings.update(overrides)
    return engine.XrfXasOptions(**settings)


def scan_energies(points=40):
    return np.linspace(E0 - 180.0, E0 + 620.0, points)


def make_fitter(options, energy_ev):
    return engine.Fitter(CHANNELS, energy_ev / 1000.0, options.target,
                         options.matrix_elements, options)


def target_index(fitter):
    """The one target component this scan's edges switch on."""
    assert len(fitter.target_indices) == 1
    return fitter.target_indices[0]


def synthetic_scan(points=40, detectors=2, seed=7, target_scale=None,
                   deadtime_slope=0.001, continuum=0.0, shape=None,
                   poisson=True, **option_overrides):
    """A whole energy scan built from Larch's model, with optional Poisson noise."""
    rng = np.random.default_rng(seed)
    energy_ev = scan_energies(points)
    options = make_options(points=points, **option_overrides)
    fitter = make_fitter(options, energy_ev)
    axis, basis = fitter.basis(shape or TRUE_SHAPE, np.arange(points))

    i0 = 1.0e5 * (1.0 + 0.05 * np.cos(np.linspace(0.0, 3.0, points)))
    target = mu_true(energy_ev) if target_scale is None else target_scale
    # A smooth continuum that is the same at every point: bremsstrahlung and
    # sample scatter, the thing the background column is there to absorb.
    smooth = continuum * np.exp(-axis / 3.0)
    counts = np.zeros((points, detectors, CHANNELS.size))
    deadtime = np.zeros((points, detectors))
    for d in range(detectors):
        gain = 1.0 + 0.3 * d
        deadtime[:, d] = 1.0 + 0.02 * d + deadtime_slope * np.arange(points)
        clean = np.zeros((points, CHANNELS.size)) + gain * smooth[None, :]
        for k, name in enumerate(fitter.names):
            if name not in AMPLITUDES:      # the fitted continuum: injected below
                continue
            scale = AMPLITUDES[name] * gain * (i0 / 1.0e5)
            if name == fitter.names[target_index(fitter)]:
                scale = scale * target
            clean += scale[:, None] * basis[:, k, :]
        expected = np.clip(clean / deadtime[:, d][:, None], 0.0, None)
        counts[:, d, :] = rng.poisson(expected) if poisson else expected

    scan = dict(filename='synthetic.h5', energy_ev=energy_ev,
                detectors={'ge': (points, detectors, CHANNELS.size)},
                channels={'i0': i0}, deadtime={'ge': deadtime},
                deadtime_corrected={'ge': detectors},
                order=np.arange(points), reordered=False, entry='/synthetic')
    return scan, counts, options, fitter


def small_scan(points=12, detectors=2, **overrides):
    """Cheap real fits for transport/assembly tests, not recovery acceptance.

    Exact model counts avoid spending the test budget fitting counting noise.
    The full channel array is retained for the synthetic HDF5 writer.
    """
    recipe = dict(calibration_points=2, channel_range=[550, 730],
                  matrix_elements=[], background='none')
    recipe.update(overrides)
    shape = dict(engine.initial_parameters(make_options(**recipe)).valuesdict(), peak_gamma=0.)
    return synthetic_scan(points=points, detectors=detectors, shape=shape,
                          poisson=False, **recipe)


@pytest.fixture(scope='module')
def extracted():
    scan, counts, options, fitter = synthetic_scan()
    return engine.extract(scan, counts, options), scan, counts, options, fitter


# ------------------------------------------------- basis and edge gating


def test_target_column_survives_below_its_own_edge():
    """Larch drops edges above the incident energy, so a target rebuilt at
    every point would have no lines at all below its own edge and the whole
    pre-edge -- where the null test lives -- would be identically zero."""
    energy_ev = scan_energies()
    options = make_options()
    fitter = make_fitter(options, energy_ev)
    _, basis = fitter.basis(TRUE_SHAPE, np.arange(energy_ev.size))

    below = energy_ev < E0 - 100.0
    assert below.sum() > 2
    target = basis[:, target_index(fitter), :].sum(axis=1)
    assert (target[below] > 0).all()
    assert fitter.gates[('Mn', 'K')] == 0.0


def test_matrix_element_is_gated_off_below_its_edge():
    """A matrix element must appear only once the incident energy passes its
    edge; a missing or mis-signed gate lets Fe absorb intensity everywhere."""
    energy_ev = scan_energies()
    options = make_options()
    fitter = make_fitter(options, energy_ev)
    _, basis = fitter.basis(TRUE_SHAPE, np.arange(energy_ev.size))

    assert fitter.gates[('Fe', 'K')] == pytest.approx(FE_EDGE_KEV, abs=0.01)
    assert fitter.gates[('Cr', 'K')] == pytest.approx(CR_EDGE_KEV, abs=0.01)
    iron = basis[:, fitter.names.index('Fe K'), :].sum(axis=1)
    below = energy_ev / 1000.0 <= FE_EDGE_KEV
    assert below.any() and (~below).any()
    assert (iron[below] == 0.0).all()
    assert (iron[~below] > 0.0).all()
    # Chromium's edge is below the scan, so it is on throughout.
    assert (basis[:, fitter.names.index('Cr K'), :].sum(axis=1) > 0).all()


def test_k_lines_stay_dark_below_the_k_edge_although_the_l_lines_are_lit():
    """One gate per element is one too few. Iron's L edges lie far below this
    scan, so iron's L lines are excited at every point; a single gate placed
    at the element's lowest edge would inherit that and switch iron's *K*
    lines on 400 eV below the iron K edge -- inside the target's pre-edge,
    where the null test that certifies the extraction is measured."""
    energy_ev = scan_energies()
    # A window from 0.5 to 8 keV: wide enough to hold iron's L lines as well
    # as its K lines, which is what makes the two gates distinguishable.
    options = make_options(channel_range=[50, 800], roi_range=[566, 608])
    fitter = engine.Fitter(np.arange(50, 800), energy_ev / 1000.0,
                           options.target, options.matrix_elements, options)

    assert 'Fe K' in fitter.names and 'Fe L3' in fitter.names
    assert fitter.gates[('Fe', 'K')] == pytest.approx(FE_EDGE_KEV, abs=0.01)
    # The L edges are below the scan, so those lines are never gated off --
    # and that fact must not travel to the K lines of the same element.
    assert fitter.gates[('Fe', 'L3')] == pytest.approx(0.7068, abs=0.01)
    assert fitter.gates[('Fe', 'L3')] < energy_ev.min() / 1000.0

    _, basis = fitter.basis(TRUE_SHAPE, np.arange(energy_ev.size))
    below = energy_ev / 1000.0 <= FE_EDGE_KEV
    assert below.any() and (~below).any()
    assert (basis[below, fitter.names.index('Fe K'), :].sum(axis=1) == 0.0).all()
    assert (basis[:, fitter.names.index('Fe L3'), :].sum(axis=1) > 0.0).all()


def test_element_column_scale_is_constant_across_the_scan():
    """elem.mu is evaluated at the model's incident energy. Rebuilding the
    element per point would make the column scale -- and so the fitted
    amplitude -- jump mid-scan, exactly at the target's own edge."""
    energy_ev = scan_energies()
    options = make_options()
    fitter = make_fitter(options, energy_ev)
    _, basis = fitter.basis(TRUE_SHAPE, np.arange(energy_ev.size))

    for name in ('Mn K', 'Cr K'):
        column = basis[:, fitter.names.index(name), :]
        assert np.allclose(column, column[0], rtol=0, atol=0)


def test_scatter_centres_track_the_incident_energy():
    """If the centres came from the model's fixed xray_energy, or the Compton
    formula were inverted, the peaks would not move with the monochromator."""
    # The formula itself: the scattered photon always loses energy, by more at
    # a larger angle, and the shift is nothing at all in the forward direction.
    assert engine.compton_center(6.5, 0.0) == pytest.approx(6.5)
    assert engine.compton_center(6.5, 118.0) < engine.compton_center(6.5, 90.0) < 6.5
    assert engine.compton_center(6.5, 180.0) == pytest.approx(
        6.5 / (1.0 + 2.0 * 6.5 / engine.ELECTRON_REST_KEV))

    energy_ev = scan_energies()
    options = make_options()
    fitter = make_fitter(options, energy_ev)
    axis, basis = fitter.basis(TRUE_SHAPE, np.arange(energy_ev.size))

    elastic = axis[basis[:, fitter.names.index('elastic'), :].argmax(axis=1)]
    compton = axis[basis[:, fitter.names.index('compton'), :].argmax(axis=1)]
    incident = energy_ev / 1000.0
    expected = np.array([engine.compton_center(e, TRUE_SHAPE['compton_angle'])
                         for e in incident])

    # Both peaks sweep the detector as the monochromator scans, one channel of
    # peak for one channel of incident energy. The peaks are asymmetric and sit
    # on a falling detector efficiency, so the maximum is a few channels off the
    # centre; what must hold is that it moves with it, not that it coincides.
    assert np.ptp(elastic) > 0.5
    assert (compton < elastic).all()
    assert np.polyfit(incident, elastic, 1)[0] == pytest.approx(1.0, abs=0.02)
    assert np.polyfit(expected, compton, 1)[0] == pytest.approx(1.0, abs=0.05)
    assert np.abs(elastic - incident).max() < 3 * TRUE_SHAPE['cal_slope']
    assert np.std(compton - expected) < 2 * TRUE_SHAPE['cal_slope']


def test_escape_copies_a_line_below_itself_without_erasing_the_parent():
    """Larch's escape term interpolates the parent onto a shifted axis and,
    with the default fill of NaN, writes NaN wherever the shift leaves the
    window -- which the next line turns into zero, deleting the component
    itself. A silicon detector puts the escape copy inside a window that holds
    the parent too, so both halves of the failure are visible at once."""
    energy = np.linspace(1.0, 8.0, 701)
    common = dict(material='Si', thickness=0.5, det_noise=0.06,
                  peak_step=1e-3, peak_tail=0.05)
    plain = engine.build_model(['Fe'], 8.0, (1.0, 8.0), escape_amp=0.0, **common)
    escaping = engine.build_model(['Fe'], 8.0, (1.0, 8.0), escape_amp=1.0, **common)

    without = engine.element_columns(plain, energy)[('Fe', 'K')]
    with_escape = engine.element_columns(escaping, energy)[('Fe', 'K')]
    assert escaping.escape_energy == pytest.approx(1.74, abs=0.05)

    # The parent survives: nothing is NaN, and the Ka peak is where it was.
    assert np.isfinite(with_escape).all()
    assert with_escape.sum() > without.sum()
    parent = energy[without.argmax()]
    assert parent == pytest.approx(6.40, abs=0.05)
    assert with_escape[without.argmax()] == pytest.approx(without[without.argmax()],
                                                          rel=1e-6)
    # And a copy of it appears one detector Ka lower, on top of a baseline
    # that was four orders of magnitude below the parent peak.
    shifted = np.abs(energy - (parent - escaping.escape_energy)).argmin()
    assert without[shifted] < 1e-4 * without.max()
    assert with_escape[shifted] > 20 * without[shifted]


def test_escape_is_silent_below_the_detector_k_edge():
    """A germanium detector cannot escape a photon it has no K vacancy to
    make. Reporting an escape response for this manganese scan would invent a
    component, and blaming the parity difference on one would be wrong."""
    energy = np.linspace(3.8, 7.8, 401)
    common = dict(material='Ge', thickness=1.0, det_noise=0.06,
                  peak_step=1e-3, peak_tail=0.05)
    plain = engine.build_model(['Mn'], 7.2, (3.8, 7.8), escape_amp=0.0, **common)
    asked = engine.build_model(['Mn'], 7.2, (3.8, 7.8), escape_amp=1.0, **common)

    without = engine.element_columns(plain, energy)[('Mn', 'K')]
    with_escape = engine.element_columns(asked, energy)[('Mn', 'K')]
    assert asked.use_escape is True
    assert np.all(np.asarray(asked.escape_scale) == 0.0)
    assert np.allclose(with_escape, without, rtol=1e-12, atol=0.0)


# ------------------------------------------------------------- the solve


def test_injected_target_amplitude_is_recovered():
    """A wrong column normalisation, a ridge on an absolute rather than a
    relative scale, or weights applied to one side of the system only would
    each leave the fitted amplitude biased away from the injected one."""
    scan, counts, options, fitter = synthetic_scan()
    energy_ev = scan['energy_ev']
    i0, deadtime = scan['channels']['i0'], scan['deadtime']['ge']

    solved = fitter.solve(TRUE_SHAPE, np.arange(energy_ev.size), counts[:, 0, :])
    injected = AMPLITUDES['Mn K'] * mu_true(energy_ev) * (i0 / 1.0e5) / deadtime[:, 0]
    fitted = solved['amplitudes'][:, target_index(fitter)]

    above = energy_ev > E0 + 50.0
    assert np.median(np.abs(fitted[above] / injected[above] - 1.0)) < 0.05
    assert np.corrcoef(fitted, injected)[0, 1] > 0.999


def test_reduced_chi_square_matches_the_counting_noise_model():
    """The weights must be the variance of the counts that are actually
    fitted. Subtracting a background estimate first and then weighting by the
    remainder claims a precision the data do not have: what is left after
    removing an estimate is not Poisson with variance equal to itself, and the
    reduced chi-square runs to tens or hundreds while the fit looks fine."""
    points = 16
    # The generating model is the fitted model, so the only thing left in the
    # residual is the counting noise, and the statistic has nowhere to hide.
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1)
    solved = fitter.solve(TRUE_SHAPE, np.arange(points), counts[:, 0, :])

    redchi = np.asarray(solved['redchi'])
    assert redchi.shape == (points,)
    # Poisson data fitted with its own generating model: order unity, both ways.
    assert 0.5 < float(np.median(redchi)) < 2.0
    assert float(redchi.max()) < 4.0


def test_the_continuum_does_not_take_a_share_of_the_target_edge():
    """Scaling one background shape by each point's *total* counts ties the
    continuum to the target's own edge and oscillations, so a fraction of the
    signal is removed before the fit ever sees it -- and on this scan almost
    all of it is. Fitted as columns instead, the continuum answers to the
    data, and the recovered edge is the injected one."""
    points = 20
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1,
                                                   continuum=400.0)
    measured = counts[:, 0, :]
    energy_ev = scan['energy_ev']
    i0, deadtime = scan['channels']['i0'], scan['deadtime']['ge']
    scale = (i0 / 1.0e5) / deadtime[:, 0]
    above, below = energy_ev > E0 + 50.0, energy_ev < E0 - 50.0
    injected = AMPLITUDES['Mn K'] * mu_true(energy_ev)

    def edge_step(amplitudes):
        curve = amplitudes / scale
        return curve[above].mean() - curve[below].mean()

    solved = fitter.solve(TRUE_SHAPE, np.arange(points), measured)
    fitted = solved['amplitudes'][:, target_index(fitter)]
    # The injected continuum is not in the span of the fitted columns -- a
    # real one never is -- so a few per cent of shape mismatch is expected.
    assert abs(edge_step(fitted) / edge_step(injected) - 1.0) < 0.05

    # The alternative, built here the way the subtracting version built it:
    # one clipped continuum shape, scaled point by point by the total counts.
    from larch.xrf.xrf_bgr import xrf_background
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))
    shape = np.asarray(xrf_background(energy, measured.mean(axis=0)), dtype=float)
    total = measured.sum(axis=1)
    net = np.clip(measured - shape[None, :] * (total / total.mean())[:, None], 0.0, None)
    lines = basis[:, :len(fitter.keys) + 2, :]
    scaled_away = engine.solve_amplitudes(
        lines, net, ridge=options.ridge,
        free_mask=fitter.free_mask[:lines.shape[1]])['amplitudes'][:, target_index(fitter)]
    assert edge_step(scaled_away) < 0.5 * edge_step(injected)


def test_the_continuum_basis_cannot_curl_up_into_a_line():
    """A flexible continuum that can make a bump will make one where a
    fluorescence line is, and take a share of it. Every column falls
    monotonically and every amplitude is nonnegative, so their sum falls
    monotonically too -- once the detector's own absorbance is divided out."""
    energy = np.linspace(3.8, 7.8, 401)
    model = engine.build_model(['Mn'], 7.2, (3.8, 7.8), material='Ge',
                               thickness=1.0, det_noise=0.06, peak_step=1e-3,
                               peak_tail=0.05)
    model.calc_spectrum(energy)
    columns = engine.background_columns(model, energy, 4)

    assert columns.shape == (4, energy.size)
    response = np.asarray(model.atten) * model.count_time
    for weights in ([1, 0, 0, 0], [0, 0, 0, 1], [1, 2, 3, 4], [0.1, 5, 0, 2]):
        total = np.einsum('k,kc->c', np.asarray(weights, dtype=float), columns)
        assert (np.diff(total / response) <= 1e-12 * total.max()).all()
    # And they are steep enough to be worth having: the steepest column has to
    # fall over the window, or the basis cannot follow a real continuum.
    assert columns[-1][-1] < 0.2 * columns[-1][0]


def test_signed_target_keeps_the_pre_edge_unbiased():
    """Clamping the target at zero censors the signed model-mismatch baseline,
    so every pre-edge point can only be pushed up. The bias is what breaks the
    null test, and it is the reason the target column alone is left signed."""
    points = 30
    scan, counts, options, fitter = synthetic_scan(
        points=points, detectors=1, target_scale=np.zeros(points))
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))

    signed = engine.solve_amplitudes(basis, counts[:, 0, :], ridge=options.ridge,
                                     free_mask=fitter.free_mask)['amplitudes']
    clamped = engine.solve_amplitudes(
        basis, counts[:, 0, :], ridge=options.ridge,
        free_mask=np.zeros_like(fitter.free_mask))['amplitudes']

    k = target_index(fitter)
    assert (clamped[:, k] >= 0.0).all()
    assert (signed[:, k] < 0.0).any(), 'no point went negative: nothing to censor'
    assert clamped[:, k].mean() > signed[:, k].mean()
    assert abs(signed[:, k].mean()) < abs(clamped[:, k].mean())


def test_nuisance_amplitudes_stay_nonnegative():
    """Negative fluorescence is unphysical, and a negative column lets a bright
    neighbour be cancelled rather than fitted."""
    points = 20
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1)
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))

    # Punch a hole where chromium radiates, so the solve is pushed to answer
    # with a negative Cr amplitude if it is allowed to.
    hurt = counts[:, 0, :].copy()
    peak = basis[0, fitter.names.index('Cr K')].argmax()
    hurt[:, peak - 6:peak + 7] = 0.0

    solved = engine.solve_amplitudes(basis, hurt, ridge=options.ridge,
                                     free_mask=fitter.free_mask)
    for k, name in enumerate(fitter.names):
        if k != target_index(fitter):
            assert (solved['amplitudes'][:, k] >= 0.0).all(), f'{name} went negative'


def test_the_bounded_solve_beats_clipping_the_unconstrained_one():
    """Clipping a negative amplitude to zero is not the constrained optimum
    when the columns overlap: the other amplitudes have to move to take up
    what the clipped one was carrying. The difference is a real misfit, and
    the solver has to be asked for the optimum rather than handed a guess."""
    points = 20
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1)
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))

    hurt = counts[:, 0, :].copy()
    peak = basis[0, fitter.names.index('Cr K')].argmax()
    hurt[:, peak - 6:peak + 7] = 0.0

    solved = engine.solve_amplitudes(basis, hurt, ridge=options.ridge,
                                     free_mask=fitter.free_mask)
    assert solved['diagnostics']['bounded_points'] > 0
    assert solved['diagnostics']['unconverged_points'] == 0

    # The clipped alternative, built the way the naive solve would build it.
    unconstrained = engine.solve_amplitudes(
        basis, hurt, ridge=options.ridge,
        free_mask=np.ones(len(fitter.names), dtype=bool))['amplitudes']
    clipped = np.where(fitter.free_mask[None, :], unconstrained,
                       np.clip(unconstrained, 0.0, None))

    weights = 1.0 / np.clip(hurt, 1.0, None)
    def misfit(amplitudes):
        residual = hurt - np.einsum('pk,pkc->pc', amplitudes, basis)
        return float(np.einsum('pc,pc,pc->', residual, weights, residual))

    assert misfit(solved['amplitudes']) < misfit(clipped)


def test_a_nonnegative_solver_failure_is_a_scientific_error(monkeypatch):
    from scipy import optimize

    def exhausted(*args, **kwargs):
        raise RuntimeError('Maximum number of iterations reached.')
    monkeypatch.setattr(optimize, 'nnls', exhausted)
    # The unconstrained nuisance amplitude is negative, requiring NNLS.
    basis = np.array([[[1., 1.], [1., 0.]]])
    with pytest.raises(ScientificError, match='amplitude solve did not converge'):
        engine.solve_amplitudes(basis, np.array([[0., 1.]]), ridge=0.,
                                free_mask=np.array([True, False]))


def test_poisson_weighting_downweights_the_loud_channels():
    """Uniform weighting lets the brightest channels -- which are also the
    noisiest, being Poisson -- set the answer for the faint target line."""
    points = 8
    # Chromium only: iron is gated off over most of the scan, and an unweighted
    # comparison has no way to exclude a dead column from its normal equations.
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1,
                                                   matrix_elements=['Cr'])
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))
    measured = counts[:, 0, :]

    # A 10% excursion on the loudest channel: a fluctuation a Poisson-weighted
    # fit should barely notice, because that channel's variance is huge.
    loud = measured.sum(axis=0).argmax()
    disturbed = measured.copy()
    disturbed[:, loud] *= 1.10

    k = target_index(fitter)

    def poisson(data):
        return engine.solve_amplitudes(basis, data, ridge=options.ridge,
                                       free_mask=fitter.free_mask)['amplitudes'][:, k]

    def uniform(data):
        flat = np.einsum('pkc,plc->pkl', basis, basis)
        rhs = np.einsum('pkc,pc->pk', basis, data)
        return np.linalg.solve(flat, rhs[:, :, None])[:, k, 0]

    poisson_shift = np.abs(poisson(disturbed) - poisson(measured)).mean()
    uniform_shift = np.abs(uniform(disturbed) - uniform(measured)).mean()
    assert poisson_shift < 0.5 * uniform_shift


def test_ridge_does_not_shrink_a_well_determined_amplitude():
    """A ridge scaled wrongly -- absolutely, rather than against each column's
    own Gram diagonal -- would quietly return its own answer instead of the
    data's, and nothing downstream would show it."""
    points = 12
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1)
    energy, basis = fitter.basis(TRUE_SHAPE, np.arange(points))

    def amplitudes(ridge):
        solved = engine.solve_amplitudes(basis, counts[:, 0, :], ridge=ridge,
                                         free_mask=fitter.free_mask)
        return solved['amplitudes'][:, target_index(fitter)]

    plain, regularised = amplitudes(0.0), amplitudes(options.ridge)
    # Above the edge the target amplitude is well determined by thousands of
    # counts; the ridge must leave it where the data put it.
    above = scan['energy_ev'] > E0 + 50.0
    assert above.sum() > 4
    assert np.allclose(regularised[above], plain[above], rtol=1e-3)
    # It must also not be so large that it flattens the edge away.
    below = scan['energy_ev'] < E0 - 100.0
    assert regularised[above].mean() > 20 * abs(regularised[below].mean())


# ------------------------------------------------------------ calibration


def test_calibration_subset_is_deterministic():
    """A subset drawn from dict ordering or an unseeded generator would make
    every rerun of the same scan give slightly different detector parameters."""
    assert engine.calibration_indices(40, 4).tolist() == [0, 13, 26, 39]
    assert engine.calibration_indices(40, 4).tolist() == \
        engine.calibration_indices(40, 4).tolist()
    # Asking for more points than the scan holds must not repeat a point.
    indices = engine.calibration_indices(3, 10)
    assert indices.tolist() == [0, 1, 2]


def test_quadratic_calibration_cannot_reverse_channel_order():
    """A free quadratic coefficient can fold an otherwise positive gain."""
    fitter = make_fitter(make_options(), scan_energies())
    parameters = fitter.initial_parameters()
    values = parameters.valuesdict()
    values['cal_slope'] = parameters['cal_slope'].min
    for curvature in [parameters['cal_curvature'].min, parameters['cal_curvature'].max]:
        axis = fitter.channel_energy(dict(values, cal_curvature=curvature))
        assert np.all(np.diff(axis) > 0)


def test_calibration_recovers_a_perturbed_gain():
    """Free scatter centres stop the peaks from pinning the energy axis, and
    the gain then walks off to whatever the line tails prefer."""
    points = 24
    scan, counts, options, fitter = synthetic_scan(
        points=points, detectors=1, calibration_points=4)
    indices = engine.calibration_indices(points, options.calibration_points)

    # The start is 1% off in gain and has the offset at zero.
    assert options.cal_slope != TRUE_SHAPE['cal_slope']
    values, _ = engine.calibrate(fitter, counts[:, 0, :], indices)

    assert values['cal_slope'] == pytest.approx(TRUE_SHAPE['cal_slope'], rel=5e-3)
    assert values['det_noise'] == pytest.approx(TRUE_SHAPE['det_noise'], rel=0.15)
    # Offset and slope are correlated; what must be right is where the peaks land.
    recovered = engine.channel_energy(CHANNELS, values['cal_offset'], values['cal_slope'])
    truth = engine.channel_energy(CHANNELS, TRUE_SHAPE['cal_offset'],
                                  TRUE_SHAPE['cal_slope'])
    assert np.abs(recovered - truth).max() < 0.02


def test_calibration_reports_whether_the_optimizer_finished():
    """Discarding the optimizer's own verdict means a calibration that stopped
    at its iteration limit is indistinguishable from one that converged, and
    every number downstream inherits the difference silently."""
    points = 12
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1,
                                                   calibration_points=3)
    indices = engine.calibration_indices(points, options.calibration_points)

    _, good = engine.calibrate(fitter, counts[:, 0, :], indices)
    assert good['success'] is True
    assert good['ier'] in (1, 2, 3, 4)
    assert good['nfev'] > 1
    # The subset statistic must be labelled as one, not read as a fit quality.
    assert good['calibration_subset_only'] is True

    _, stopped = engine.calibrate(fitter, counts[:, 0, :], indices, max_nfev=3)
    assert stopped['success'] is False
    assert stopped['message']


@pytest.mark.parametrize('mean', [5., 10.])
@pytest.mark.parametrize('seed', [101, 203, 307, 409])
def test_poisson_noise_alone_does_not_release_extra_response_parameters(mean, seed):
    """Observed-count chi-square is biased high at these count rates."""
    fitter = make_fitter(make_options(calibration_points=8), scan_energies(8))
    values = fitter.initial_parameters().valuesdict()
    values['peak_gamma'] = 0.
    _, basis = fitter.basis(values, np.arange(8))
    norm = basis.sum(axis=2)
    profile = (basis / np.where(norm > 0, norm, 1.)[:, :, None]).sum(axis=1)
    counts = np.random.default_rng(seed).poisson(profile / profile.mean() * mean)
    _, report = engine.calibrate(fitter, counts, np.arange(8))
    print('Low-count model comparison:', mean, seed, report['model_selection'])
    assert report['success']
    assert report['model_selection']['candidate_converged']
    assert report['response_model'] == 'intrinsic'


def test_a_scatter_tail_longer_than_the_peak_inflates_the_target_until_told():
    """In Larch's hypermet the tail falls as exp((E - centre) / (beta*sigma)),
    so beta at its 0.5 default makes the longest scatter tail the model can
    draw about half the peak's own width. Real scatter tails run much longer
    -- charge lost at the edges of the pixel, scattering in the sample and the
    cryostat -- and intensity the scatter columns cannot reach has only the
    target's column to land in, which lifts the pre-edge and the edge step
    together. scatter_beta is the request field that lets a user say so."""
    points = 24
    # A tail sixteen times the default length, everything else unchanged.
    scan, counts, options, matched = synthetic_scan(
        points=points, detectors=1, calibration_points=3, scatter_beta=8.0)
    energy_ev = scan['energy_ev']
    injected = (AMPLITUDES['Mn K'] * mu_true(energy_ev)
                * (scan['channels']['i0'] / 1.0e5) / scan['deadtime']['ge'][:, 0])
    indices = engine.calibration_indices(points, options.calibration_points)
    column = target_index(matched)

    def solved(fitter):
        values, _ = engine.calibrate(fitter, counts[:, 0, :], indices)
        return fitter.solve(values, np.arange(points),
                            counts[:, 0, :])['amplitudes'][:, column]

    told = solved(matched)
    # The identical extraction, with only the tail slope left at the default.
    default = make_options(points=points, calibration_points=3)
    assert default.scatter_beta == 0.5
    untold = solved(make_fitter(default, energy_ev))

    pre = energy_ev < E0 - 60.0
    assert pre.sum() > 3
    assert np.median(np.abs(told / injected - 1.0)) < 0.10
    # Left at the default, the unreachable tail is absorbed by the target,
    # worst where the target is weakest: the pre-edge the null test measures.
    assert np.median(untold[pre] / injected[pre]) > 1.5
    assert np.median(np.abs(untold / injected - 1.0)) > \
        3.0 * np.median(np.abs(told / injected - 1.0))


def test_a_shape_parameter_left_on_its_bound_is_reported():
    """A bound reached is the optimizer saying it wanted to go further, and
    the shape it settled on is the bound's rather than the data's: whatever
    the data wanted past it has been pushed into the other columns, the
    target's among them. lmfit calls such a fit converged, so unreported the
    only trace is a slightly worse redchi, and the detector looks sound."""
    points = 12
    scan, counts, options, fitter = synthetic_scan(points=points, detectors=1,
                                                   calibration_points=3)
    indices = engine.calibration_indices(points, options.calibration_points)

    _, report = engine.calibrate(fitter, counts[:, 0, :], indices)
    # Nothing in this fixture is against a limit: the generating shape sits
    # well inside every one of them.
    assert report['at_bounds'] == []

    # A scan taken in a forward-scattering geometry the fit is not allowed to
    # reach: nothing else in the model can shift the Compton peak, so the
    # angle can only run down to its limit and stop there.
    floor = engine.initial_parameters(options)['compton_angle'].min
    forward = dict(TRUE_SHAPE, compton_angle=floor - 20.0)
    scan, counts, options, fitter = synthetic_scan(
        points=points, detectors=1, shape=forward, calibration_points=3)
    indices = engine.calibration_indices(points, options.calibration_points)
    values, report = engine.calibrate(fitter, counts[:, 0, :], indices)

    assert 'compton_angle' in report['at_bounds']
    assert values['compton_angle'] == pytest.approx(floor, abs=0.15)
    assert report['success'] in (True, False)   # it still calls itself done


# -------------------------------------------------------------- assembly


def test_deadtime_is_applied_per_detector_before_summing(extracted):
    """The factor is per detector and per point. Summing the detectors first
    and correcting afterwards silently reweights them by their live times."""
    result, scan, counts, options = extracted[:4]
    deadtime = scan['deadtime']['ge']
    i0 = scan['channels']['i0']

    per_detector = np.asarray(result['per_detector'])
    assert per_detector.shape == (deadtime.shape[1], i0.size)
    assert np.allclose(np.asarray(result['fit_over_i0']), per_detector.sum(axis=0))

    # Detectors differ in deadtime, so the correct sum differs from correcting
    # the summed areas by any single factor.
    raw_step = result['metadata']['raw_edge_steps']['fit']
    areas = per_detector * raw_step * i0[None, :] / deadtime.T
    naive = (areas * deadtime.mean(axis=1)[None, :]).sum(axis=0)
    assert not np.allclose(np.asarray(result['fit_counts']), naive)


def test_fit_and_roi_share_the_same_deadtime_and_i0_arithmetic(extracted):
    """Only identical arithmetic makes the two comparable; a difference in
    either correction would show up as a spurious gap between them."""
    result, scan, counts, options = extracted[:4]
    deadtime = scan['deadtime']['ge']
    i0 = scan['channels']['i0']

    lo, _ = options.channel_range
    rlo, rhi = options.roi_range
    window = counts[:, :, rlo - lo:rhi - lo].sum(axis=2)
    expected = (window * deadtime).sum(axis=1)
    steps = result['metadata']['raw_edge_steps']
    assert np.allclose(np.asarray(result['roi_counts']), expected)
    assert np.allclose(np.asarray(result['roi_over_i0']) * steps['roi'], expected / i0)
    assert np.allclose(np.asarray(result['fit_over_i0']) * steps['fit'],
                       np.asarray(result['fit_counts']) / i0)


def test_flux_monitor_units_do_not_change_exafs_from_exported_yields():
    """Arbitrary I0 units must not change ordinary pre_edge + AUTOBK output."""
    from larch.xafs import autobk

    # Unit invariance needs a real extraction and AUTOBK, not matrix-line separation.
    scan, counts, options, _ = small_scan(points=40, detectors=1)
    lo, hi = options.channel_range
    counts = counts[:, :, lo-CHANNELS[0]:hi-CHANNELS[0]]
    reference = engine.extract(scan, counts, options)
    processed = {}
    for role in ('fit', 'roi'):
        group = engine.normalize(scan['energy_ev'], reference[f'{role}_over_i0'], options)
        assert group.edge_step == pytest.approx(1.0, rel=1e-10)
        autobk(group, rbkg=1., kweight=2, kmax=12., clamp_lo=1., clamp_hi=1.)
        processed[role] = group.chi
    for factor in (.01, 100.):
        scaled_scan = dict(scan, channels=dict(scan['channels'], i0=scan['channels']['i0']*factor))
        result = engine.extract(scaled_scan, counts, options)
        for role in ('fit', 'roi'):
            assert result['metadata']['raw_edge_steps'][role] == pytest.approx(
                reference['metadata']['raw_edge_steps'][role]/factor, rel=1e-10)
            group = engine.normalize(scan['energy_ev'], result[f'{role}_over_i0'], options)
            autobk(group, rbkg=1., kweight=2, kmax=12., clamp_lo=1., clamp_hi=1.)
            np.testing.assert_allclose(group.chi, processed[role], atol=2e-7, rtol=2e-5)


def test_an_edgeless_window_is_not_divided_by_larch_minimum_step():
    scan, counts, options, _ = synthetic_scan(points=24, detectors=1,
        calibration_points=3, roi_range=[int(CHANNELS[0]), int(CHANNELS[0])+1])
    counts[:, :, 0] = 0.
    with pytest.raises(ScientificError, match='edge-step scale'):
        engine.extract(scan, counts, options)


def test_nonpositive_i0_is_rejected_with_a_readable_message():
    """A zero or negative I0 point would make the extraction infinite or sign
    flipped, and the panel would draw a spike rather than report a problem."""
    scan, counts, options, _ = synthetic_scan(points=12, detectors=1)
    scan['channels']['i0'][4] = 0.0
    with pytest.raises(ScientificError) as raised:
        engine.extract(scan, counts, options)
    assert 'I0' in str(raised.value)
    assert 'choose another channel' in str(raised.value).lower()


def test_moving_scatter_biases_the_window_sum_but_not_the_fit(extracted):
    """This is the whole point of the method. The Compton tail sweeps across
    the target's window as the monochromator scans, so the window sum reports
    absorption structure that is not there; the fit must not."""
    result = extracted[0]
    fit = result['quality']['fit']['null_test']
    roi = result['quality']['roi']['null_test']

    assert abs(fit['mean_frac_of_jump']) < 0.05
    assert abs(fit['drift_frac_of_jump']) < 0.10
    assert abs(roi['mean_frac_of_jump']) > 1.0
    assert abs(roi['drift_frac_of_jump']) > 10 * abs(fit['drift_frac_of_jump'])

    # And the fit, not the window sum, is the one that matches the truth.
    truth = mu_true(np.asarray(result['energy_ev']))
    fit_rms = np.sqrt(np.mean((np.asarray(result['fit_norm']) - truth) ** 2))
    roi_rms = np.sqrt(np.mean((np.asarray(result['roi_norm']) - truth) ** 2))
    assert fit_rms < 0.1
    assert roi_rms > 10 * fit_rms


def test_detector_agreement_is_reported_for_a_multi_element_detector(extracted):
    """Normalised mu from each detector must agree; a disagreement is how a
    shadowed or miscalibrated element of the array announces itself."""
    agreement = extracted[0]['quality']['detector_agreement']
    assert agreement['detectors'] == 2
    assert agreement['worst_pairwise_rms'] < 0.1
    assert agreement['checks']['shape_agreement'] is True


# ---------------------------------------------------- what the checks catch


def _indicators(energy_ev, signal, options, per_detector=()):
    return engine._quality(energy_ev, signal, signal, list(per_detector), options)


def test_an_inverted_edge_is_reported_although_larch_takes_its_absolute_value():
    """Larch returns edge_step as an absolute value, so a curve that falls
    across the edge -- a target column driven negative above it -- has a
    perfectly healthy-looking edge_step. Only the signed jump can tell."""
    energy_ev = scan_energies(160)
    options = make_options()
    upright = mu_true(energy_ev)

    good = _indicators(energy_ev, upright, options)['fit']
    bad = _indicators(energy_ev, -upright, options)['fit']

    assert good['edge_step'] > 0 and bad['edge_step'] > 0
    assert good['signed_jump'] > 0 and bad['signed_jump'] < 0
    assert good['checks']['edge_direction'] is True
    assert bad['checks']['edge_direction'] is False


def test_a_negative_post_edge_is_flagged():
    """The target column is signed, so an over-subtracted extraction can end
    up negative where the fluorescence yield must be largest. Nothing in the
    pre-edge null test or the edge step sees it."""
    energy_ev = scan_energies(160)
    options = make_options()
    signal = mu_true(energy_ev).copy()
    above = energy_ev > E0 + 300.0
    signal[above] = -0.4

    indicators = _indicators(energy_ev, signal, options)['fit']
    assert indicators['post_edge']['negative_fraction'] > 0.1
    assert indicators['post_edge']['min_frac_of_jump'] < 0.0
    assert indicators['checks']['post_edge_positive'] is False
    assert _indicators(energy_ev, mu_true(energy_ev), options)[
        'fit']['checks']['post_edge_positive'] is True


def test_pre_edge_verdict_reads_the_residual_it_displays():
    """A pre-edge that scatters wildly about a mean of zero passes any test
    built on the mean alone, and the panel showed the residual RMS beside a
    verdict that had not looked at it."""
    rng = np.random.default_rng(3)
    energy_ev = scan_energies(160)
    options = make_options()
    noisy = mu_true(energy_ev).copy()
    pre = (energy_ev >= E0 + options.pre1) & (energy_ev <= E0 + options.pre2)
    noise = rng.normal(0.0, 0.08, pre.sum())
    noisy[pre] = noise - noise.mean()

    indicators = _indicators(energy_ev, noisy, options)['fit']
    assert abs(indicators['null_test']['mean_frac_of_jump']) < engine.NULL_MEAN_LIMIT
    assert indicators['null_test']['detrended_rms_frac_of_jump'] > engine.NULL_RMS_LIMIT
    assert indicators['checks']['pre_edge_null'] is False


def test_detector_agreement_judges_shape_not_the_size_of_the_jump():
    """Detector elements differ in solid angle, so their edge jumps differ by
    design and a spread in them is no fault; a bias they all share is a real
    fault and changes no spread at all."""
    energy_ev = scan_energies(160)
    options = make_options()
    truth = mu_true(energy_ev)
    # Same shape, very different scale: nothing is wrong here.
    scaled = _indicators(energy_ev, truth, options,
                         per_detector=[truth, 3.0 * truth])['detector_agreement']
    assert scaled['edge_step_spread'] > 0.4
    assert scaled['checks']['shape_agreement'] is True

    # Same scale, different shape: one element is reporting another curve.
    warped = truth + 0.25 * np.exp(-((energy_ev - E0 - 250.0) / 60.0) ** 2)
    bent = _indicators(energy_ev, truth, options,
                       per_detector=[truth, warped])['detector_agreement']
    assert bent['edge_step_spread'] < 0.05
    assert bent['checks']['shape_agreement'] is False


# ------------------------------------------------- what a request may ask for


def test_a_detector_outside_the_inspected_table_is_refused():
    """read_scan is what bounds the element and channel counts. A request that
    names a detector it rejected would allocate whatever the file holds, and a
    compressed file small enough to upload can hold a great deal."""
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    data = scan_file(scan, counts)
    loaded = engine.read_scan(data, 'synthetic.h5')

    assert 'ge' in loaded['detectors']
    with pytest.raises(ScientificError) as raised:
        engine.load_counts(data, 'i0', [380, 771], allowed=loaded['detectors'])
    assert 'no usable detector' in str(raised.value)


def test_an_oversized_count_block_is_refused_before_it_is_read(monkeypatch):
    """The point, detector and channel limits bound each dimension on its own;
    their product is tens of gigabytes, and the check has to be on the product."""
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    data = scan_file(scan, counts)
    loaded = engine.read_scan(data, 'synthetic.h5')

    monkeypatch.setattr(engine, 'MAX_COUNTS_VALUES', 100)
    with pytest.raises(ScientificError) as raised:
        engine.load_counts(data, 'ge', [380, 771], allowed=loaded['detectors'])
    assert 'narrow the channel range' in str(raised.value).lower()


def test_an_oversized_fit_basis_is_refused(monkeypatch):
    """The basis is larger than the counts by the number of components, and it
    is built per detector; nothing upstream bounds it."""
    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    monkeypatch.setattr(engine, 'MAX_BASIS_VALUES', 1000)
    with pytest.raises(ScientificError) as raised:
        engine.extract(scan, counts, options)
    assert 'fewer calibration points' in str(raised.value).lower()


# -------------------------------------------------------------- provenance


def test_a_wrong_length_deadtime_array_is_refused():
    """A deadtime array of the wrong length silently became unity, so a file
    written with a truncated stream was extracted as if it had no deadtime at
    all -- and reported as corrected."""
    import h5py
    import io as _io
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    data = scan_file(scan, counts)
    buffer = _io.BytesIO(data)
    with h5py.File(buffer, 'a') as handle:
        node = handle['synthetic/instrument/bluesky/streams/primary']
        del node['ge-element0-deadtime_factor/value']
        node['ge-element0-deadtime_factor/value'] = np.ones(7)
    loaded = engine.read_scan(buffer.getvalue(), 'synthetic.h5')
    assert loaded['deadtime_corrected']['ge'] == 0
    with pytest.raises(ScientificError) as raised:
        engine.extract(loaded, counts, options)
    assert '7 values for a 10-point scan' in str(raised.value)


def test_a_nonpositive_deadtime_factor_is_refused():
    """A zero erases a detector element's whole contribution and a negative
    inverts it, and both produce a plausible-looking spectrum."""
    import h5py
    import io as _io
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    data = scan_file(scan, counts)
    for bad in (0.0, -1.0, np.nan):
        buffer = _io.BytesIO(data)
        with h5py.File(buffer, 'a') as handle:
            node = handle['synthetic/instrument/bluesky/streams/primary']
            node['ge-element0-deadtime_factor/value'][3] = bad
        loaded = engine.read_scan(buffer.getvalue(), 'synthetic.h5')
        with pytest.raises(ScientificError) as raised:
            engine.extract(loaded, counts, options)
        assert 'erase or invert' in str(raised.value)
        assert 'Leave element 1 out' in str(raised.value)


def test_one_dead_element_does_not_block_the_others():
    """An Xspress3 writes a disabled channel's deadtime factor as zero. When
    any unusable factor refused the whole file, one dead element blocked an
    eight-element extraction with no recovery short of editing the file. The
    element is refused only when it is chosen; left out, the rest extract,
    the fit and the window sum both use exactly the chosen set, and the
    result names what was left out."""
    import h5py
    import io as _io
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=16, detectors=2,
                                              calibration_points=3)
    buffer = _io.BytesIO(scan_file(scan, counts))
    with h5py.File(buffer, 'a') as handle:
        node = handle['synthetic/instrument/bluesky/streams/primary']
        node['ge-element0-deadtime_factor/value'][...] = 0.0
    data = buffer.getvalue()
    loaded = engine.read_scan(data, 'synthetic.h5')
    summary = engine.scan_summary(loaded)
    assert [entry['element'] for entry in summary['detectors'][0]['unusable_elements']] == [0]

    with pytest.raises(ScientificError):
        engine.extract(loaded, engine.load_counts(data, 'ge', options.channel_range),
                       options)
    only = options.model_copy(update=dict(elements=[1]))
    second = engine.load_counts(data, 'ge', only.channel_range, elements=[1])
    result = engine.extract(loaded, second, only)
    assert result['metadata']['elements'] == [1]
    assert result['metadata']['excluded_elements'] == [0]
    assert np.asarray(result['per_detector']).shape[0] == 1
    # The window sum is over the same single element as the fit.
    lo = only.channel_range[0]
    rlo, rhi = only.roi_range
    expected = (second[:, 0, rlo - lo:rhi - lo].sum(axis=1)
                * loaded['deadtime']['ge'][:, 1]) / loaded['channels']['i0']
    assert np.allclose(np.asarray(result['roi_over_i0']) * result['metadata']['raw_edge_steps']['roi'], expected)


def test_a_calibration_that_carries_the_target_line_out_of_the_window_is_refused(monkeypatch):
    """A real eight-element scan came back with most elements calibrated to a
    gain several times the true one: the Mn lines left the fit window, those
    elements contributed exactly zero, and the summed curve, normalised, still
    looked like an edge, with every summed check passing. Such a result is
    refused, naming the element, rather than returned."""
    scan, counts, options, _ = synthetic_scan(points=16, detectors=2, calibration_points=3)
    real, calls = engine.calibrate, []

    def runaway(fitter, spectra, indices, **kwargs):
        values, report = real(fitter, spectra, indices, **kwargs)
        calls.append(None)
        if len(calls) == 2:
            values = dict(values, cal_offset=0.0, cal_slope=5.5 * values['cal_slope'])
        return values, report

    monkeypatch.setattr(engine, 'calibrate', runaway)
    with pytest.raises(ScientificError, match=r'1 of the 2 .*element 2: 0 keV'):
        engine.extract(scan, counts, options)


def test_a_scan_without_deadtime_says_so_rather_than_claiming_a_correction():
    """Carrying a missing factor as unity is the right arithmetic and the
    wrong provenance: the result is uncorrected data, and the saved group has
    to say which of the two it is."""
    import h5py
    import io as _io
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    buffer = _io.BytesIO(scan_file(scan, counts))
    with h5py.File(buffer, 'a') as handle:
        del handle['synthetic/instrument/bluesky/streams/primary'
                   '/ge-element0-deadtime_factor']
    loaded = engine.read_scan(buffer.getvalue(), 'synthetic.h5')
    assert loaded['deadtime_corrected']['ge'] == 0
    assert np.all(loaded['deadtime']['ge'] == 1.0)

    full = engine.read_scan(scan_file(scan, counts), 'synthetic.h5')
    assert full['deadtime_corrected']['ge'] == 1


def test_a_descending_scan_is_sorted_before_it_is_paired():
    """Larch's pre_edge sorts the energy axis inside itself and hands the
    normalised curve back in that order. A scan written from high energy down
    would then be plotted, and exported, against the wrong energies."""
    from xrf_xas_scan_fixture import scan_file

    scan, counts, options, _ = small_scan(detectors=1)
    flipped = dict(scan, energy_ev=scan['energy_ev'][::-1],
                   channels={'i0': scan['channels']['i0'][::-1]},
                   deadtime={'ge': scan['deadtime']['ge'][::-1]})
    loaded = engine.read_scan(scan_file(flipped, counts[::-1]), 'synthetic.h5')
    lo, hi = options.channel_range
    counts = counts[:, :, lo-CHANNELS[0]:hi-CHANNELS[0]]

    assert loaded['reordered'] is True
    assert np.all(np.diff(loaded['energy_ev']) > 0)
    assert np.allclose(loaded['energy_ev'], scan['energy_ev'])
    assert np.allclose(loaded['channels']['i0'], scan['channels']['i0'])

    # And the counts follow the same permutation inside extract, so the point
    # that was measured at a given energy is still the one fitted there.
    result = engine.extract(loaded, counts[::-1], options)
    assert result['metadata']['energy_reordered'] is True
    straight = engine.extract(scan, counts, options)
    assert np.allclose(result['fit_over_i0'], straight['fit_over_i0'])


def test_metadata_records_every_option_of_the_request():
    """The saved group has to carry the recipe that made it. A hand-picked
    subset of the request leaves out whichever field was added last -- the
    detector material, the escape scale, the normalisation ranges -- and the
    extraction cannot be reproduced from what was saved."""
    scan, counts, options, _ = synthetic_scan(points=10, detectors=1)
    result = engine.extract(scan, counts, options)
    saved = result['metadata']['request']

    for name in engine.XrfXasOptions.model_fields:
        assert name in saved, f'{name} is not recorded in the saved metadata'
    # What was left automatic is saved as the value it resolved to, so the
    # recipe reproduces the result rather than re-deriving it.
    assert engine.XrfXasOptions(**saved) == engine.resolve_windows(scan, options)[0]
    assert saved['preview_point'] is not None
    assert result['metadata']['source_file'] == 'synthetic.h5'
    assert result['metadata']['deadtime_corrected'] == 1


def test_a_strided_preview_is_a_subset_of_the_full_extraction(monkeypatch):
    """A stride that subsamples before the calibration points are chosen, or
    before the mean background shape is estimated, gives a different fit of
    the points it keeps -- so the preview a reader judges is not the thing the
    export writes."""
    scan, counts, options, _ = synthetic_scan(points=36, detectors=1,
                                              calibration_points=3)
    full = engine.extract(scan, counts, options)
    # Force multiple final-solve batches while permitting the strided output.
    fitter = make_fitter(options, scan['energy_ev'])
    monkeypatch.setattr(engine, 'MAX_BASIS_VALUES', 12 * len(fitter.names) * CHANNELS.size)
    strided = engine.extract(scan, counts, make_options(
        points=36, calibration_points=3, point_stride=3))

    keep = np.arange(0, 36, 3)
    assert strided['metadata']['points'] == keep.size
    assert strided['metadata']['scan_points'] == 36
    assert strided['metadata']['calibration_points'] == \
        full['metadata']['calibration_points']
    assert np.allclose(np.asarray(strided['energy_ev']),
                       np.asarray(full['energy_ev'])[keep])
    assert np.allclose(np.asarray(strided['fit_over_i0']),
                       np.asarray(full['fit_over_i0'])[keep], rtol=1e-10)
    assert np.allclose(np.asarray(strided['roi_over_i0']),
                       np.asarray(full['roi_over_i0'])[keep], rtol=1e-10)


# ------------------------------------------------- choosing the I0 channel


def test_a_channel_that_is_not_strictly_positive_is_not_offered_as_i0():
    """The extraction divides by I0 and refuses a channel that touches zero,
    so offering one is offering a dead end. A real beamline writes a scaler's
    unused first channel as noise about zero, and it sorts ahead of the live
    one, so whatever picks the first name picks the dead channel."""
    scan, counts, options, _ = synthetic_scan(points=12, detectors=1)
    live = scan['channels']['i0']
    scan['channels'] = {
        'i0': live,
        'dead-channels-0-net_count': np.full(live.size, 1e-9) * (-1) ** np.arange(live.size),
        'grounded': np.zeros(live.size),
    }
    summary = engine.scan_summary(scan)

    assert set(summary['channels']) == {'i0', 'dead-channels-0-net_count', 'grounded'}
    assert summary['usable_i0'] == ['i0']
    # The offer and the refusal must agree, or the panel sends a request the
    # engine was always going to reject.
    for name in summary['channels']:
        if name in summary['usable_i0']:
            continue
        with pytest.raises(ScientificError):
            engine.extract(scan, counts, make_options(points=12, i0_channel=name))


def test_the_suggested_i0_is_not_a_channel_downstream_of_the_sample():
    """It and Iref measure what is left after the sample. Dividing the
    fluorescence by one of them gives a ratio of two absorptions, not mu(E),
    and the result looks enough like a spectrum to be believed."""
    names = ['It-mcs-scaler-channels-4-net_count',
             'Iref-mcs-scaler-channels-5-net_count',
             'IpreKB-mcs-scaler-channels-2-net_count']
    assert engine.suggest_i0(names) == 'IpreKB-mcs-scaler-channels-2-net_count'
    assert engine.suggest_i0(names[:2]) is None


def test_nothing_is_suggested_when_no_channel_looks_like_a_monitor():
    """Guessing wrong is worse than not guessing: the panel can ask, but a
    curve normalised by a motor position is a plausible-looking artefact."""
    assert engine.suggest_i0(['energy-monochromator-bragg', 'temperature']) is None


def test_the_suggestion_prefers_counts_to_the_same_signal_as_a_current():
    """A scaler reports one monitor several ways. The current is the counts
    times a gain, so both normalise correctly, but only one of them is the
    quantity the rest of the panel's numbers are expressed in."""
    assert engine.suggest_i0(['I0-net_current', 'I0-raw_count',
                              'I0-net_count']) == 'I0-net_count'


def test_the_i0_suggestion_is_the_same_whatever_order_the_channels_arrive_in():
    """HDF5 hands back names in file order, which differs between files from
    the same beamline. A suggestion that depends on it makes two scans of one
    sample normalise by different monitors."""
    names = ['Ipreslit-mcs-scaler-channels-1-net_count',
             'IpreKB-mcs-scaler-channels-2-net_count',
             'Imon-net_count']
    chosen = {engine.suggest_i0(order) for order in
              (names, names[::-1], [names[1], names[2], names[0]])}
    assert len(chosen) == 1


# ---------------------------------------- the APS 20-BM detector-file layout


def test_a_20bm_detector_file_is_read_as_one_multi_element_detector():
    """20-BM writes each element as its own 'MCA n' array beside the text
    scan, with the energy in 'X Positions' and the scalers under 'Detectors'.
    The reader looked only for a data group holding one 3-D cube, so every
    20-BM file was refused and a 20-BM fluorescence series could not be opened."""
    from xrf_xas_scan_fixture import twenty_bm_file

    scan, counts, options, _ = synthetic_scan(points=16, detectors=2,
                                              calibration_points=3)
    data = twenty_bm_file(scan, counts)
    loaded = engine.read_scan(data, 'insitu_sample.0001.hdf5')

    assert loaded['layout'] == 'aps-20bm'
    assert loaded['detectors'] == {'MCA': (16, 2, 800)}
    assert np.allclose(loaded['energy_ev'], scan['energy_ev'], atol=1e-3)
    # The trailing space LabVIEW pads labels with is not part of the name.
    assert {'I0', 'XMAP12B:DT Corr I0'} <= set(loaded['channels'])
    # No per-element deadtime is recorded, and the result must not claim one.
    assert loaded['deadtime_corrected']['MCA'] == 0
    assert np.all(loaded['deadtime']['MCA'] == 1.0)

    window = engine.load_counts(data, 'MCA', options.channel_range,
                                allowed=loaded['detectors'])
    assert np.array_equal(window, counts)
    result = engine.extract(loaded, window, options.model_copy(
        update=dict(detector='MCA', i0_channel='I0')))
    assert result['metadata']['layout'] == 'aps-20bm'
    assert result['metadata']['deadtime_corrected'] == 0
    assert any('deadtime' in note for note in result['metadata']['notes'])


def test_an_element_recorded_off_its_neighbours_is_read_back_in_line():
    """A beamline reduction may roll one element three channels before summing,
    because that element's spectrum sits three channels off the others. A fixed
    comparison window adds the misaligned element's line in partly outside
    the window; reading that element at its own shift puts it back."""
    from xrf_xas_scan_fixture import twenty_bm_file

    scan, counts, options, _ = synthetic_scan(points=16, detectors=2,
                                              calibration_points=3)
    data = twenty_bm_file(scan, counts, shifts={1: 3})
    loaded = engine.read_scan(data, 'insitu_sample.0001.hdf5')

    misaligned = engine.load_counts(data, 'MCA', options.channel_range)
    assert not np.array_equal(misaligned[:, 1], counts[:, 1])
    aligned = engine.load_counts(data, 'MCA', options.channel_range, shifts={1: 3})
    assert np.array_equal(aligned, counts)

    request = options.model_copy(update=dict(detector='MCA', i0_channel='I0',
                                             channel_shifts=[[1, 3]]))
    shifted, _ = engine.resolve_windows(loaded, request)
    assert shifted.channel_shifts == [[1, 3]]
    # A shift that would read past the last channel is refused, not wrapped.
    with pytest.raises(ScientificError) as raised:
        engine.load_counts(data, 'MCA', [700, 800], shifts={1: 3})
    assert 'shifted by 3 for element 2' in str(raised.value)


def test_a_missing_mca_dataset_cannot_renumber_the_elements_after_it():
    """'MCA 1' and 'MCA 3' with NMCAS = 3 were read as a two-element detector
    whose element 2 was physical MCA 3, so an exclusion or a channel shift
    typed for element 2 acted on another piece of hardware."""
    import h5py
    import io as _io
    from xrf_xas_scan_fixture import twenty_bm_file

    scan, counts, _, _ = synthetic_scan(points=16, detectors=3, calibration_points=3)
    buffer = _io.BytesIO(twenty_bm_file(scan, counts))
    with h5py.File(buffer, 'a') as handle:
        handle['1D Scan'].attrs['NMCAS'] = 3
        del handle['1D Scan/MCA 2']
    with pytest.raises(ScientificError, match='MCA 2 is missing'):
        engine.read_scan(buffer.getvalue(), 'insitu_sample.0001.hdf5')


# ------------------------------------------------------- automatic settings


def _full_size_scan():
    """A full-size 8-element Mn K scan: 560 points, 8 elements, 4096
    channels, 6340-7280 eV. No counts are needed to choose windows."""
    energy = np.linspace(6340.0, 7280.0, 560)
    return dict(filename='full.h5', energy_ev=energy,
                detectors={'ge': (560, 8, 4096)}, channels={'i0': np.ones(560)},
                deadtime={'ge': np.ones((560, 8))}, deadtime_corrected={'ge': 8},
                order=np.arange(560), reordered=False, entry='/full')


def test_the_default_fit_window_stays_inside_the_basis_limit_on_a_full_detector():
    """The panel used to default the fit window to every channel the detector
    has. On a 560 x 8 x 4096 scan with two matrix elements that basis is over
    the 20-million-value limit, so the first preview failed with 'narrow the
    channel range' before the reader had changed anything."""
    scan = _full_size_scan()
    options = make_options(points=560, matrix_elements=['Fe', 'Cr'], channel_range=None,
                           roi_range=None, cal_offset=-0.01, cal_slope=0.01)
    resolved, derived = engine.resolve_windows(scan, options)

    lo, hi = resolved.channel_range
    energy = lambda channel: -0.01 + 0.01 * channel  # noqa: E731
    # The window holds the Mn K lines and the elastic peak at the top energy...
    assert energy(lo) < 5.0 and energy(hi) > 7.280 + 0.3
    # ...and not the whole detector.
    fitter = engine.Fitter(np.arange(lo, hi), scan['energy_ev'] / 1000.0, 'Mn',
                           ['Fe', 'Cr'], resolved)
    assert 560 * len(fitter.names) * (hi - lo) < engine.MAX_BASIS_VALUES
    assert set(derived['automatic']) == {'channel_range', 'roi_range', 'preview_point'}


def test_the_default_comparison_window_is_the_target_line_not_the_whole_fit_window():
    """An empty comparison window used to mean the whole fit window, which sums
    the elastic and Compton peaks into the 'conventional' curve the fit is
    compared against -- a straw man no beamline records."""
    scan = _full_size_scan()
    options = make_options(points=560, channel_range=[400, 760], roi_range=None,
                           cal_offset=-0.01, cal_slope=0.01)
    resolved, derived = engine.resolve_windows(scan, options)
    rlo, rhi = resolved.roi_range
    energy = lambda channel: -0.01 + 0.01 * channel  # noqa: E731
    assert energy(rlo) < derived['line_kev'] < energy(rhi)
    # About the width a beamline ROI on Mn K-alpha is set to, well short of
    # the elastic peak at the lowest incident energy.
    assert 0.3 < energy(rhi) - energy(rlo) < 0.6
    assert energy(rhi) < 6.3


def test_the_default_preview_point_is_past_the_edge():
    """The preview spectrum used to be scan point 0, a pre-edge point where
    the target is dark and the plot shows scatter peaks and nothing else."""
    scan = _full_size_scan()
    options = make_options(points=560, channel_range=[400, 760], roi_range=[565, 610],
                           preview_point=None)
    resolved, _ = engine.resolve_windows(scan, options)
    assert scan['energy_ev'][resolved.preview_point] >= E0 + 20.0
    assert scan['energy_ev'][resolved.preview_point - 1] < E0 + 20.0


def test_a_linear_pre_edge_drift_is_not_called_a_clean_baseline():
    """The verdict read the mean and the scatter about a line, not the line's
    slope: a pre-edge running straight from -10% to +10% of the edge jump
    has mean zero and no scatter, and passed. Normalisation carries that line
    across the whole scan."""
    energy_ev = scan_energies(160)
    options = make_options()
    signal = mu_true(energy_ev).copy()
    pre = (energy_ev >= E0 + options.pre1) & (energy_ev <= E0 + options.pre2)
    signal[pre] = np.linspace(-0.1, 0.1, pre.sum())

    indicators = _indicators(energy_ev, signal, options)['fit']
    test = indicators['null_test']
    assert abs(test['mean_frac_of_jump']) < engine.NULL_MEAN_LIMIT
    assert test['detrended_rms_frac_of_jump'] < engine.NULL_RMS_LIMIT
    assert abs(test['drift_over_scan_frac_of_jump']) > engine.NULL_DRIFT_LIMIT
    assert indicators['checks']['pre_edge_null'] is False
