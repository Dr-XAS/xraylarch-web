"""Engine tests for the MapsTorch fitting option.

Each test is named for one failure, listed in the table at the end of
docs/athena-xrf-mapstorch.md. The spectra are synthesised from the engines'
own bases, so nothing here depends on measured data.

MapsTorch is optional: it pulls in PyTorch, it is not in the server's
requirements, and the tests that need it skip when it is absent. The one test
that does not skip is the one about it being absent.
"""
import numpy as np
import pytest

from test_athena_xrf_xas import (CHANNELS, E0, TRUE_SHAPE, make_options,
                                 mu_true, scan_energies, synthetic_scan)
from xraylarch_web import athena_xrf_mapstorch as mt
from xraylarch_web import athena_xrf_xas as engine
from xraylarch_web.athena_science import ScientificError

FE_EDGE_KEV = 7.112
CR_EDGE_KEV = 5.989

needs_mapstorch = pytest.mark.skipif(
    not mt.available(), reason='the optional mapstorch package is not installed')


def make_fitter(options=None, points=40, channels=CHANNELS, **overrides):
    options = options or make_options(engine='mapstorch', **overrides)
    return mt.MapsTorchFitter(channels, scan_energies(points) / 1000.0,
                              options.target, options.matrix_elements, options)


@pytest.fixture(scope='module')
def fitter():
    return make_fitter()


@pytest.fixture(scope='module')
def start(fitter):
    return fitter.initial_parameters().valuesdict()


# ------------------------------------------------------- being optional


def test_an_absent_mapstorch_is_refused_in_words_not_in_a_traceback(monkeypatch):
    """The package is not in requirements.txt, so a server that has never
    installed it will be asked for this engine sooner or later. An ImportError
    out of a route is a 500 with no advice in it."""
    import builtins

    real = builtins.__import__

    def refuse(name, *args, **kwargs):
        if name.startswith('mapstorch') or name == 'torch':
            raise ImportError('no mapstorch here')
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', refuse)
    with pytest.raises(ScientificError) as caught:
        mt._mapstorch()
    assert 'not installed' in str(caught.value)
    assert 'Larch' in str(caught.value)


@needs_mapstorch
def test_an_element_mapstorch_has_no_line_table_for_is_refused_in_words():
    """MapsTorch fits a fixed list of line families. Sodium is on none of
    them, and an empty basis would otherwise reach the solve as a singular
    system rather than as an explanation."""
    options = make_options(engine='mapstorch', target='Na', matrix_elements=[])
    with pytest.raises(ScientificError) as caught:
        make_fitter(options)
    assert 'Na' in str(caught.value)


# ------------------------------------------------- basis and edge gating


@needs_mapstorch
def test_the_target_column_survives_below_its_own_edge(fitter, start):
    """MapsTorch masks every line of an element whose edge lies above the
    incident energy it is given (_binding_energy_mask). Built per point, the
    target's column would be identically zero through the whole pre-edge --
    and the null test that certifies the extraction would pass on a column of
    zeros without measuring anything at all."""
    energy_ev = scan_energies()
    _, basis = fitter.basis(start, np.arange(energy_ev.size))

    below = energy_ev < E0 - 100.0
    assert below.sum() > 2
    target = basis[:, fitter.target_indices[0], :].sum(axis=1)
    assert (target[below] > 0).all()
    assert fitter.gates[('Mn', 'K')] == 0.0


@needs_mapstorch
def test_a_matrix_element_is_gated_off_below_its_edge(fitter, start):
    """The project's gates have to replace the ones neutralised above, or a
    matrix element absorbs intensity at energies that cannot excite it."""
    energy_ev = scan_energies()
    _, basis = fitter.basis(start, np.arange(energy_ev.size))

    assert fitter.gates[('Fe', 'K')] == pytest.approx(FE_EDGE_KEV, abs=0.01)
    assert fitter.gates[('Cr', 'K')] == pytest.approx(CR_EDGE_KEV, abs=0.01)
    iron = basis[:, fitter.names.index('Fe K'), :].sum(axis=1)
    below = energy_ev / 1000.0 <= FE_EDGE_KEV
    assert below.any() and (~below).any()
    assert (iron[below] == 0.0).all()
    assert (iron[~below] > 0.0).all()
    # Chromium's edge is below the scan, so it is lit at every point.
    assert (basis[:, fitter.names.index('Cr K'), :].sum(axis=1) > 0).all()


@needs_mapstorch
def test_an_element_column_does_not_change_shape_across_the_scan(fitter, start):
    """Everything in MapsTorch's element model that depends on the incident
    energy is the mask. If the columns were rebuilt per point they would
    change scale at the gate rather than switch on, and the fitted amplitude
    -- which is the extracted signal -- would jump there."""
    _, basis = fitter.basis(start, np.arange(scan_energies().size))
    for name in ('Mn K', 'Cr K'):
        column = basis[:, fitter.names.index(name), :]
        assert np.allclose(column, column[0], rtol=0, atol=0)


@needs_mapstorch
def test_a_line_lands_where_the_shared_calibration_says_it_does(fitter, start):
    """MapsTorch ships a non-zero ENERGY_QUADRATIC, and its own axis is
    offset + slope*channel + quadratic*channel^2. Left at its shipped value
    the peaks would sit off the abscissa that the viewer, the Larch engine
    and the panel all draw, by about a channel at the top of the window."""
    energy, basis = fitter.basis(start, np.array([0]))
    # The centroid bound is for the complete K family. K-beta is now fitted
    # separately, so recombine its unit column for this unchanged axis check.
    column = (basis[0, fitter.names.index('Mn K'), :]
              + basis[0, fitter.names.index('Mn Kbeta'), :])
    centroid = float(np.sum(energy * column) / np.sum(column))
    # Mn Ka1 is at 5.899 keV, Ka2 at 5.888, Kb at 6.49; the centroid of the
    # family sits a little above the Ka pair.
    assert 5.88 < centroid < 6.05
    assert energy[0] == pytest.approx(
        engine.channel_energy(CHANNELS[0], start['cal_offset'], start['cal_slope']))


@needs_mapstorch
def test_the_scatter_peaks_follow_the_incident_energy(fitter, start):
    """These are built batched over scan points, with one incident energy per
    point. A mis-broadcast would give every point the same pair of peaks, and
    the moving scatter -- the whole reason to fit rather than integrate a
    window -- would be modelled as stationary."""
    energy_ev = scan_energies()
    energy, basis = fitter.basis(start, np.arange(energy_ev.size))
    elastic = energy[np.argmax(basis[:, fitter.names.index('elastic'), :], axis=1)]
    compton = energy[np.argmax(basis[:, fitter.names.index('compton'), :], axis=1)]

    assert np.all(np.diff(elastic) >= 0)
    assert elastic[-1] - elastic[0] > 0.5
    assert np.allclose(elastic, energy_ev / 1000.0, atol=0.02)
    # Compton scattering costs the photon energy, by more at a larger angle.
    assert np.all(compton < elastic)


@needs_mapstorch
def test_the_two_engines_fit_the_same_families_at_the_same_gates(fitter):
    """The claim this engine is offered under is that it changes the peak
    shapes and nothing else. If the two disagreed about which lines are in
    the model, or about when they switch on, a difference between their
    results would not be a difference of peak shape."""
    larch = engine.Fitter(CHANNELS, scan_energies() / 1000.0, 'Mn',
                          ['Fe', 'Cr'], make_options())
    assert fitter.names == larch.names
    assert fitter.keys == larch.keys
    assert fitter.gates == larch.gates
    assert fitter.target_indices == larch.target_indices
    assert fitter.reference_kev == larch.reference_kev


@needs_mapstorch
def test_the_continuum_cannot_curl_up_into_a_line(fitter, start):
    """The continuum columns are shared with the Larch engine but reach this
    basis without its detector-absorbance factor. They are only safe while
    they stay monotone: a continuum that can make a bump can absorb the
    target's own line and take the edge step with it."""
    _, basis = fitter.basis(start, np.array([0]))
    for term in range(fitter.background_terms):
        column = basis[0, fitter.names.index(f'continuum {term + 1}'), :]
        assert (np.diff(column) <= 0).all()
        assert column[0] > column[-1]


# --------------------------------------------------------------- escape


@needs_mapstorch
def test_the_missing_escape_model_is_declared_where_it_could_matter():
    """Larch models detector escape and this engine does not. Silence would
    be a silent substitution; a note on every result would be noise. The note
    belongs on the results where an escape peak could exist at all -- that is,
    where the fit window reaches above the detector's own fluorescence line."""
    # Germanium escapes at 9.886 keV, above this 3.8-7.7 keV window: there is
    # no parent intensity up there for escape to move, so nothing is missing.
    assert make_fitter(detector_material='Ge').notes == []

    # Silicon escapes at 1.74 keV, below the window: escape peaks exist here.
    loud = make_fitter(detector_material='Si')
    assert len(loud.notes) == 1
    assert 'escape' in loud.notes[0].lower()

    # Switched off in the request, there is nothing to declare either.
    assert make_fitter(detector_material='Si', escape_amp=0.0).notes == []


# --------------------------------------------------------- the whole fit


@needs_mapstorch
def test_an_injected_target_amplitude_is_recovered(fitter, start):
    """The end-to-end check of this engine's own basis: draw a scan from it
    with known amplitudes and Poisson noise, and the linear solve must give
    them back. A column built at the wrong amplitude convention -- MapsTorch
    holds them as base-ten logarithms, so a unit column means setting zero,
    not one -- would come back scaled by a factor of ten.

    The tolerance matches the Larch engine's version of this test, and for
    the same reason: weighting by the variance of the measured counts biases
    every amplitude low by a couple of per cent, in both engines alike."""
    points = scan_energies().size
    indices = np.arange(points)
    _, basis = fitter.basis(start, indices)
    truth = np.zeros((points, len(fitter.names)))
    truth[:, fitter.names.index('Mn K')] = 3.0e3 * mu_true(scan_energies())
    truth[:, fitter.names.index('Cr K')] = 5.0e2
    truth[:, fitter.names.index('elastic')] = 2.0e3
    truth[:, fitter.names.index('compton')] = 4.0e3
    clean = np.einsum('pk,pkc->pc', truth, basis)
    counts = np.random.default_rng(3).poisson(np.clip(clean, 0.0, None)).astype(float)

    solved = fitter.solve(start, indices, counts)
    injected = truth[:, fitter.names.index('Mn K')]
    found = solved['amplitudes'][:, fitter.names.index('Mn K')]

    above = injected > 0.5 * injected.max()
    assert np.median(np.abs(found[above] / injected[above] - 1.0)) < 0.05
    assert np.corrcoef(found, injected)[0, 1] > 0.999
    assert 0.5 < float(np.median(solved['redchi'])) < 2.0


@needs_mapstorch
def test_the_other_engines_spectra_are_fitted_back_to_the_injected_edge():
    """The point of a second engine. The scan is drawn from Larch's peak
    shapes and fitted with MapsTorch's: a result that still recovers mu(E)
    says the extracted edge is a property of the data and not of one line
    table. This is the test that fails if the engines share gating in name
    only -- a mis-gated matrix element shows up here as a step in the
    pre-edge, not as a worse chi-square.

    What is checked is the normalised curve, because that is what the user
    reads off. The absolute pre-edge level is *not* checked here: fitting one
    model's peaks with another's leaves a constant false target amplitude
    below the edge, which normalisation removes and which the quality block
    reports in its own right (see the next test)."""
    scan, counts, _, _ = synthetic_scan(points=24, detectors=1,
                                        continuum=200.0, shape=TRUE_SHAPE)
    options = make_options(engine='mapstorch', calibration_points=3)
    result = engine.extract(scan, counts, options)

    assert result['metadata']['engine'] == 'mapstorch'
    energy = np.asarray(result['energy_ev'])
    norm = np.asarray(result['fit_norm'])
    truth = mu_true(energy)
    above, below = energy > E0 + 60.0, energy < E0 - 60.0
    assert np.abs(norm[below]).max() < 0.05
    assert np.abs(norm[above] - truth[above]).max() < 0.15
    assert np.corrcoef(norm, truth)[0, 1] > 0.99


@needs_mapstorch
def test_the_pre_edge_pedestal_of_a_mismatched_peak_model_is_reported():
    """Fitted with the other engine's peak shapes, the target column takes up
    the residual the shapes cannot explain, and the extracted signal sits on
    a constant pedestal below the edge -- about a fifth of the edge jump on
    this synthetic scan, against a few per cent when the shapes match.

    Normalisation hides it, so the danger is that it is never seen. The null
    test has to measure it and the verdict has to be carried out of the
    extraction, or an engine swap looks free when it is not."""
    scan, counts, _, _ = synthetic_scan(points=24, detectors=1,
                                        continuum=200.0, shape=TRUE_SHAPE)
    options = make_options(engine='mapstorch', calibration_points=3)
    quality = engine.extract(scan, counts, options)['quality']['fit']

    assert quality['null_test'] is not None
    assert quality['checks']['pre_edge_null'] is False
    assert quality['null_test']['mean_frac_of_jump'] > 0.05
    # The *shape* of the pre-edge is still flat: it is an offset, not drift.
    assert quality['null_test']['detrended_rms_frac_of_jump'] < 0.02


@needs_mapstorch
def test_a_result_carries_the_engine_that_made_it_and_its_caveats():
    """A saved group has to say which spectral model produced it: the two are
    not interchangeable, and a number compared across them without knowing is
    a comparison of models dressed up as a comparison of samples."""
    scan, counts, _, _ = synthetic_scan(points=12, detectors=1)
    options = make_options(engine='mapstorch', calibration_points=2,
                           detector_material='Si')
    meta = engine.extract(scan, counts, options)['metadata']

    assert meta['engine'] == 'mapstorch'
    assert meta['request']['engine'] == 'mapstorch'
    assert any('escape' in note.lower() for note in meta['engine_notes'])


def test_the_larch_engine_declares_nothing_and_still_names_itself():
    """The default engine is the one the others are described against, so it
    carries no notes -- but a result still has to say so rather than leave the
    field out, or a reader cannot tell an old result from a Larch one."""
    scan, counts, _, _ = synthetic_scan(points=12, detectors=1)
    meta = engine.extract(scan, counts, make_options(calibration_points=2))['metadata']
    assert meta['engine'] == 'larch'
    assert meta['engine_notes'] == []
