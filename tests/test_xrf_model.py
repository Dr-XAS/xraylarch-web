"""Regression tests for larch.xrf.xrf_model component construction."""
import numpy as np
import pytest

from larch.xrf.xrf_model import XRF_Model


def build_model(escape=None):
    model = XRF_Model(xray_energy=6.8, energy_min=1.5, energy_max=7.5)
    model.set_detector(material='Ge', thickness=1.0, cal_offset=0.0, cal_slope=0.010)
    model.add_element('Mn')
    model.add_scatter_peak('elastic', center=6.8)
    if escape is not None:
        model.add_escape(scale=escape)
    return model, 0.010 * np.arange(380, 771)


def build_silicon_model(escape=None):
    """A detector whose escape energy is small enough that both the parent
    line and its escape copy fall inside the recorded window."""
    model = XRF_Model(xray_energy=8.5, energy_min=1.0, energy_max=8.0)
    model.set_detector(material='Si', thickness=0.5, cal_offset=0.0, cal_slope=0.010)
    model.add_element('Fe')
    if escape is not None:
        model.add_escape(scale=escape)
    return model, 0.010 * np.arange(100, 800)


def test_calc_spectrum_without_escape_peaks_does_not_need_escape_energy():
    """Every component added the escape term unconditionally, but escape_energy
    is only assigned inside calc_escape_scale(), which runs only when escape
    peaks are enabled. Any model built with the default use_escape=False raised
    AttributeError instead of returning a spectrum."""
    model, energy = build_model()
    assert not model.use_escape
    spectrum = model.calc_spectrum(energy)
    assert np.isfinite(spectrum).all()
    assert spectrum.sum() > 0


def test_escape_does_not_erase_the_components_it_shifts_out_of_the_window():
    """The escape term interpolates each component onto an axis shifted down
    by the detector's Ka energy. Outside the recorded window there is nothing
    to escape from, but the interpolation filled that region with NaN and the
    next line replaced every NaN by zero -- deleting the component itself. A
    germanium detector recording below its own K edge makes the damage total:
    the escape fraction there is zero, so the spectrum must come back exactly
    as it was, and instead it came back empty."""
    plain, energy = build_model()
    escaping, _ = build_model(escape=0.5)
    assert escaping.use_escape

    spectrum = escaping.calc_spectrum(energy)
    assert np.isfinite(spectrum).all()
    assert spectrum.sum() > 0
    assert np.allclose(spectrum, plain.calc_spectrum(energy), rtol=1e-12, atol=0.0)
    for name in ('Mn', 'elastic'):
        assert escaping.comps[name].sum() > 0


def test_escape_adds_a_copy_of_each_line_one_detector_ka_lower():
    """The point of the term: a photon that ionises the detector and lets the
    detector's own Ka out is recorded at E - E_Ka. A silicon detector can do
    this for iron, and the copy has to land there and nowhere else."""
    plain, energy = build_silicon_model()
    escaping, _ = build_silicon_model(escape=1.0)

    without = plain.calc_spectrum(energy)
    with_escape = escaping.calc_spectrum(energy)
    assert escaping.escape_energy == pytest.approx(1.74, abs=0.05)
    assert np.isfinite(with_escape).all()

    # The parent Ka peak is untouched, in place and in size.
    parent = int(without.argmax())
    assert energy[parent] == pytest.approx(6.40, abs=0.05)
    assert with_escape[parent] == pytest.approx(without[parent], rel=1e-6)

    # A new peak stands where the escape copy belongs, on a baseline that was
    # four orders of magnitude below the parent.
    shifted = int(np.abs(energy - (energy[parent] - escaping.escape_energy)).argmin())
    assert without[shifted] < 1e-4 * without.max()
    assert with_escape[shifted] > 20 * without[shifted]
    added = with_escape - without
    assert (added >= -1e-9 * without.max()).all()
    assert abs(int(added.argmax()) - shifted) <= 2


@pytest.mark.parametrize('xray_energy, expected_edges',
                         [(6.2, []), (6.6, ['K']), (7.2, ['K'])])
def test_element_lines_are_gated_by_the_incident_energy(xray_energy, expected_edges):
    """The Mn K edge sits at 6.539 keV. Larch drops edges above the incident
    energy, so a model built below the edge must contribute no Mn lines at all
    -- the behaviour the scan-resolved fit relies on to gate matrix elements."""
    model = XRF_Model(xray_energy=xray_energy, energy_min=1.5, energy_max=7.5)
    model.set_detector(material='Ge', thickness=1.0, cal_offset=0.0, cal_slope=0.010)
    model.add_element('Mn')
    assert model.elements[0].edges == expected_edges
    energy = 0.010 * np.arange(380, 771)
    model.calc_spectrum(energy)
    assert (model.comps['Mn'].sum() > 0) == bool(expected_edges)
