"""A fluorescence scan built from a known chi(k), independently of the engine.

The engine's other tests synthesise their spectra from the same Larch model the
engine fits with. That makes them tests of the solve and the assembly, and only
of those: a wrong peak shape, a wrong continuum or a wrong calibration cancels
on both sides and cannot be seen. This module exists to break that symmetry.

Nothing here is imported from Larch or from the engine. The line energies and
relative intensities are tabulated K-line values, not Larch's fuller line list.
The peak is a pseudo-Voigt with a clipped one-sided exponential tail and an
erfc shelf; the engine fits a Voigt-based hypermet, not this shape. The
continuum is Kramers bremsstrahlung through a transmission window, not a sum
of decaying exponentials. The quadratic channel axis and energy-dependent
width are now calibrated by the engine but are generated independently here.
An optional second tail population supplies an additional response mismatch.

What is injected is an ordinary single-shell EXAFS chi(k) with a known radius,
disorder and amplitude. The absorption it rides on drives the target element's
fluorescence, and -- as in a real measurement -- also attenuates the elastic
and Compton scatter, so the nuisance peaks carry a copy of the edge and the
extraction has to tell the two apart.

`injected_chi` is the answer; `scan_and_counts` is the question.
"""
import numpy as np
from scipy.special import erfc

E0_EV = 6539.0                    # Mn K edge
# hbar^2 k^2 / 2m in eV A^2, inverted: k = sqrt(K_FACTOR * (E - E0))
K_FACTOR = 0.2624682917
ELECTRON_REST_KEV = 510.998950

CHANNELS = np.arange(380, 771)    # 3.8 - 7.7 keV at the nominal 10 eV/channel

# Tabulated K lines: energy in keV and intensity relative to Ka1.
K_LINES = {
    'Mn': ((5.89875, 1.00), (5.88765, 0.51), (6.49045, 0.17)),
    'Fe': ((6.40384, 1.00), (6.39084, 0.51), (7.05798, 0.17)),
    'Cr': ((5.41472, 1.00), (5.40551, 0.51), (5.94671, 0.15)),
}
K_EDGE_KEV = {'Mn': 6.539, 'Fe': 7.112, 'Cr': 5.989}

# The engine starts away from this independently specified response.
DETECTOR = dict(offset=0.0042, slope=0.010_07, quadratic=1.9e-7,
                noise_kev=0.068, fano=0.00385, eta=0.11,
                tail_frac=0.055, tail_kev=0.19, shelf_frac=0.0022)

# The single shell that is injected.
SHELL = dict(amplitude=0.78, radius=2.55, sigma2=0.0055, mfp=7.5,
             phase=-1.10, phase_slope=-0.28)


# ------------------------------------------------------------- the answer


def wavenumber(energy_ev, e0_ev=E0_EV):
    """k in inverse angstroms, zero at and below the edge."""
    above = np.clip(np.asarray(energy_ev, dtype=float) - e0_ev, 0.0, None)
    return np.sqrt(K_FACTOR * above)


def injected_chi(k, shell=SHELL):
    """One shell of EXAFS: amplitude, disorder, mean free path, linear phase.

    The k -> 0 limit is taken as zero rather than as the divergence of the
    1/k prefactor, which is what the physical amplitude does once the
    backscattering factor is included.
    """
    k = np.asarray(k, dtype=float)
    safe = np.where(k > 1e-9, k, 1.0)
    envelope = (shell['amplitude'] / (safe * shell['radius'] ** 2)
                * np.exp(-2.0 * shell['sigma2'] * safe ** 2)
                * np.exp(-2.0 * shell['radius'] / shell['mfp']))
    phase = 2.0 * safe * shell['radius'] + shell['phase'] + shell['phase_slope'] * safe
    return np.where(k > 1e-9, envelope * np.sin(phase), 0.0)


def injected_mu(energy_ev, shell=SHELL, e0_ev=E0_EV):
    """Returns (target, total): the target element's own absorption, and all of it.

    The target term is an edge step times (1 + chi), so a background removal
    that finds the smooth part returns the injected chi itself, with no
    amplitude factor to divide out. It is what drives the target element's
    fluorescence, and it is essentially zero below the edge -- the pre-edge
    null test has something real to test.

    The total adds the matrix absorption, which does not excite the target
    but does attenuate everything leaving the sample.
    """
    energy = np.asarray(energy_ev, dtype=float)
    relative = energy - e0_ev
    # A core-hole-broadened step, and an atomic post-edge that falls away as
    # the cross-section does. Both are smooth on the scale of the oscillation.
    step = 0.5 + np.arctan(relative / 1.6) / np.pi
    atomic = 1.0 - 0.18 * (1.0 - np.exp(-np.clip(relative, 0.0, None) / 420.0))
    chi = injected_chi(wavenumber(energy, e0_ev), shell)
    target = step * atomic * (1.0 + chi)
    matrix = 0.22 - 4.5e-5 * relative       # the matrix, falling with energy
    return target, target + matrix


# ----------------------------------------------------------- the detector


def channel_energy(channels, detector=DETECTOR):
    channels = np.asarray(channels, dtype=float)
    return (detector['offset'] + detector['slope'] * channels
            + detector['quadratic'] * channels ** 2)


def resolution(center_kev, detector=DETECTOR):
    """Electronic noise and Fano statistics, in keV."""
    return np.sqrt(detector['noise_kev'] ** 2
                   + detector['fano'] * np.asarray(center_kev, dtype=float))


def line_shape(energy_kev, center_kev, sigma_kev, detector=DETECTOR,
               tail_frac=None, tail_kev=None):
    """Unit-area pseudo-Voigt with a low-energy tail and a shelf.

    The Lorentzian wing supplies non-Gaussian response, and the tail and shelf
    represent incomplete charge collection. A Voigt-based hypermet is not this
    Gaussian/Lorentzian mixture and its convolved exponential is not this
    clipped tail, so the fixture remains independent of the fitted response.
    """
    tail_frac = detector['tail_frac'] if tail_frac is None else tail_frac
    tail_kev = detector['tail_kev'] if tail_kev is None else tail_kev
    delta = np.asarray(energy_kev, dtype=float) - center_kev
    eta = detector['eta']
    gauss = np.exp(-0.5 * (delta / sigma_kev) ** 2) / (sigma_kev * np.sqrt(2.0 * np.pi))
    gamma = sigma_kev * np.sqrt(2.0 * np.log(2.0))
    lorentz = gamma / (np.pi * (delta ** 2 + gamma ** 2))
    tail = (np.exp(np.clip(delta / tail_kev, -700.0, 0.0))
            * 0.5 * erfc(delta / (sigma_kev * np.sqrt(2.0))) / tail_kev)
    shelf = 0.5 * erfc(delta / (sigma_kev * np.sqrt(2.0)))
    # A second charge-collection population cannot be represented by the
    # fitter's single exponential tail, even when its decay is calibrated.
    secondary_scale = detector.get('secondary_tail_kev', 1.0)
    secondary = (np.exp(np.clip(delta / secondary_scale, -700.0, 0.0))
                 * 0.5 * erfc(delta / (sigma_kev * np.sqrt(2.0))) / secondary_scale)
    return ((1.0 - eta) * gauss + eta * lorentz
            + tail_frac * tail + detector['shelf_frac'] * shelf
            + detector.get('secondary_tail_frac', 0.0) * secondary)


def transmission(energy_kev):
    """Beryllium window, air path and detector dead layer, as one curve.

    Falls steeply at the low end of the window and flattens at the high end,
    which is the shape of a photoelectric absorption edge-free attenuation.
    """
    return np.exp(-6.4 / np.asarray(energy_kev, dtype=float) ** 3)


def bremsstrahlung(energy_kev, incident_kev):
    """Kramers' law source spectrum, cut off at the incident energy."""
    energy = np.asarray(energy_kev, dtype=float)
    shape = np.clip(incident_kev - energy, 0.0, None) / np.clip(energy, 1e-6, None)
    return shape * transmission(energy)


def compton_center(incident_kev, angle_deg):
    return incident_kev / (1.0 + (incident_kev / ELECTRON_REST_KEV)
                           * (1.0 - np.cos(np.radians(angle_deg))))


# ------------------------------------------------------------- the scan


def scan_energies(points):
    # k reaches 15 inverse angstroms at the top, which leaves room above the
    # 3-10 comparison window for a background spline to settle.
    return np.linspace(E0_EV - 200.0, E0_EV + 900.0, points)


def clean_spectra(energy_ev, i0, *, detectors=2, matrix=('Fe', 'Cr'),
                  target='Mn', shell=SHELL, detector=DETECTOR,
                  continuum=2.6e4, scatter=3.0e5, compton_angle=118.0,
                  target_yield=2.2e5, matrix_yield=None, self_absorption=1.35,
                  gated=True):
    """Noise-free counts, and the target counts that are the truth.

    Returns (clean, truth) where clean is (points, detectors, channels) and
    truth is (points, detectors): the target element's total K-line counts
    inside the window. K-alpha has the same absorption shape, but a smaller
    absolute yield; a K-alpha-only extraction must not be compared to this
    total as an absolute count calibration.
    """
    matrix_yield = matrix_yield or {'Fe': 1.1e5, 'Cr': 5.0e4}
    energy_ev = np.asarray(energy_ev, dtype=float)
    incident = energy_ev / 1000.0
    axis = channel_energy(CHANNELS, detector)
    mu_target, mu_total = injected_mu(energy_ev, shell)
    flux = i0 / float(np.mean(i0))

    points, nchan = energy_ev.size, axis.size
    clean = np.zeros((points, detectors, nchan))
    truth = np.zeros((points, detectors))

    # The elastic and Compton peaks leave through the same sample the
    # fluorescence does, so they are attenuated by the same absorption: the
    # scatter carries an inverted copy of the edge. Separating that copy from
    # the real edge is the whole difficulty the method exists to handle.
    escape_factor = 1.0 / (1.0 + self_absorption * mu_total)

    for element, lines in K_LINES.items():
        if element != target and element not in matrix:
            continue
        # A matrix element fluoresces only once the beam passes its edge --
        # unless it reaches the detector from outside the illuminated volume,
        # which is what `gated=False` describes and what the extraction's
        # open-gate option exists for.
        live = (np.ones(points) if element == target or not gated
                else (incident > K_EDGE_KEV[element]))
        strength = (target_yield * mu_target if element == target
                    else matrix_yield[element] * live)
        profile = np.zeros(nchan)
        for center, weight in lines:
            profile += weight * line_shape(axis, center, resolution(center, detector),
                                           detector) * transmission(center)
        profile /= sum(weight for _, weight in lines)
        for d in range(detectors):
            gain = 1.0 + 0.28 * d
            column = gain * (strength * flux)[:, None] * profile[None, :]
            clean[:, d, :] += column
            if element == target:
                truth[:, d] = column.sum(axis=1)

    for point, energy_in in enumerate(incident):
        elastic = line_shape(axis, energy_in, resolution(energy_in, detector), detector)
        centre = compton_center(float(energy_in), compton_angle)
        # The Compton peak is Doppler-broadened and more strongly tailed than
        # a fluorescence line, which is why it needs its own width here.
        wide = 2.7 * resolution(centre, detector)
        inelastic = line_shape(axis, centre, wide, detector,
                               tail_frac=0.34, tail_kev=0.55)
        source = bremsstrahlung(axis, float(energy_in))
        for d in range(detectors):
            gain = 1.0 + 0.28 * d
            clean[point, d, :] += gain * flux[point] * escape_factor[point] * (
                scatter * 0.35 * elastic * transmission(energy_in)
                + scatter * inelastic * transmission(centre)
                + continuum * source)
    return clean, truth


def scan_and_counts(points=280, detectors=2, seed=11, noise=True, **generator):
    """A whole scan: the engine's `scan` dict, the counts, and the truth.

    The truth is the target counts summed over detectors and divided by I0 --
    the total-K mu(E). The K-alpha-only observable has the same normalized
    shape because the generator's line ratios are fixed. The deadtime factor does not
    appear in it: the detector records `clean / deadtime` and the extraction
    multiplies the area it fits by `deadtime`, so the two cancel and the
    quantity recovered is the clean rate.
    """
    rng = np.random.default_rng(seed)
    energy_ev = scan_energies(points)
    i0 = 1.2e5 * (1.0 + 0.04 * np.cos(np.linspace(0.0, 3.4, points))
                  + 0.015 * np.sin(np.linspace(0.0, 11.0, points)))
    clean, truth = clean_spectra(energy_ev, i0, detectors=detectors, **generator)

    # Deadtime rises with the count rate, as a real detector's does.
    rate = clean.sum(axis=2)
    deadtime = 1.0 + 0.09 * rate / rate.max() + 0.015 * np.arange(detectors)[None, :]
    recorded = np.clip(clean / deadtime[:, :, None], 0.0, None)
    # Counting statistics are switchable so that a bias can be told from the
    # noise it hides in: with `noise=False` whatever is left is systematic.
    counts = rng.poisson(recorded).astype(float) if noise else recorded

    scan = dict(filename='injection.h5', energy_ev=energy_ev,
                detectors={'ge': counts.shape}, channels={'i0': i0},
                deadtime={'ge': deadtime}, deadtime_corrected={'ge': detectors},
                order=np.arange(points), reordered=False, entry='/injection')
    return scan, counts, truth.sum(axis=1) / i0
