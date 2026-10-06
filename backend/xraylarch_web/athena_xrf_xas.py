"""Fluorescence XAS extracted by fitting the XRF spectrum at every scan point.

An energy dispersive detector returns a whole fluorescence spectrum at each
incident energy. A fixed channel window around the target line also collects
the elastic and Compton scatter peaks, which move with the incident energy and
so imprint a structured background on mu(E). Fitting the full spectrum at
every point separates the stationary fluorescence lines from the moving
scatter.

The model is Larch's own: XRF_Element line tables, the Fano-broadened
det_sigma width, the hypermet line shape and XRF_Material detector absorbance,
all from larch.xrf.xrf_model, plus larch.xafs.pre_edge for normalisation.
The continuum is a small basis of smooth columns fitted with the rest, not a
peak-clipped estimate subtracted first. Only NumPy, SciPy and lmfit are
used around them. docs/athena-xrf-xas-reference.md records the method and the
failure each test is named for.
"""
from __future__ import annotations

import io
import math
import re
from collections import OrderedDict

import numpy as np
from lmfit import Parameters, minimize
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import ScientificError

# Electron rest energy, keV. Sets the Compton shift for a given angle.
ELECTRON_REST_KEV = 510.998950

MAX_SCAN_POINTS = 4000
MAX_DETECTORS = 64
MAX_CHANNELS = 8192
MAX_ELEMENTS = 24
MAX_CALIBRATION_POINTS = 32

# The three limits above bound each dimension on its own; their product does
# not fit in memory, and a compressed HDF5 file small enough to upload can
# still hold it. These bound the arrays the extraction actually materialises:
# the counts it reads, and the basis it builds for one detector element.
MAX_COUNTS_VALUES = 20_000_000
MAX_BASIS_VALUES = 20_000_000

DEADTIME_PATTERN = re.compile(r'^(?P<detector>.+)-element(?P<index>\d+)-deadtime_factor$')


# ---------------------------------------------------------------- options


class XrfXasOptions(BaseModel):
    """Everything the extraction needs beyond the scan itself."""

    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)

    version: int = Field(ge=0)
    scan_id: str = Field(pattern=r'^[A-Za-z0-9_-]{16,128}$')
    detector: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=3)
    matrix_elements: list[str] = Field(default_factory=list, max_length=MAX_ELEMENTS)
    # Matrix elements whose edge gate is forced open, so their lines are fitted
    # even below the incident energy that would excite them. The target's gate
    # is always open; this is for lines that reach the detector from outside
    # the illuminated sample volume and so are not gated by the monochromator.
    open_gates: list[str] = Field(default_factory=list, max_length=MAX_ELEMENTS)
    i0_channel: str = Field(min_length=1, max_length=120)

    # Which spectral model draws the unit columns. 'larch' is the model
    # described at the top of this file; 'mapstorch' is the MAPS model as
    # MapsTorch implements it -- an alternative spectral model, whose line
    # tables, detector response, continuum response and escape treatment all
    # differ from Larch's. What is shared -- the line families fitted, the
    # gates, the continuum family, the amplitude solve, the deadtime and I0
    # handling and every quality check -- keeps the comparison like for like
    # around the model; a disagreement measures sensitivity to the model and
    # bounds the error of neither.
    engine: str = Field(default='larch', pattern=r'^(larch|mapstorch)$')

    # Pairs, not tuples: JSON has no tuple, and this model is strict, so a
    # tuple annotation would reject every request the browser can send. Upper
    # bounds are exclusive. None asks for the automatic window that
    # `resolve_windows` derives from the target line, the top incident energy
    # and the calibration below; the resolved numbers are what the result
    # records, so a saved group never says "automatic" without saying what.
    channel_range: list[int] | None = Field(default=None, min_length=2, max_length=2)
    roi_range: list[int] | None = Field(default=None, min_length=2, max_length=2)

    # Detector elements to extract from, numbered from zero, in increasing
    # order; empty means every element. The fit, the deadtime correction and
    # the window sum all use exactly this set, and the result names the ones
    # left out, so a dead or shadowed element can be dropped without editing
    # the file.
    elements: list[int] = Field(default_factory=list, max_length=MAX_DETECTORS)
    # [element, shift] pairs: that element's spectra are read `shift` channels
    # higher, so a spectrum recorded a few channels off its neighbours lines up
    # with them before the window sum adds it in. Each element is calibrated
    # on its own for the fit, so the fit itself barely notices; the fixed
    # comparison window does.
    channel_shifts: list[list[int]] = Field(default_factory=list, max_length=MAX_DETECTORS)

    detector_material: str = Field(default='Ge', pattern=r'^(Ge|Si)$')
    detector_thickness: float = Field(default=1.0, gt=0, le=10)
    # The detector's starting energy calibration, E = offset + slope * channel
    # in keV. Left empty, it is read from the scan file (the beamline's own
    # line windows, the elastic peak), which is what places the automatic
    # windows; a value entered here is used as given.
    cal_offset: float | None = Field(default=None, ge=-0.5, le=0.5)
    cal_slope: float | None = Field(default=None, gt=1e-4, le=0.1)
    compton_angle: float = Field(default=110.0, ge=30.0, le=180.0)
    # The decay length of the scatter peaks' low-energy tail, in units of their
    # own width: the tail falls as exp((E - centre) / (scatter_beta * sigma)).
    # Larch's own default is 0.5, which ties the tail to the peak. That is
    # right for a fluorescence line, whose tail comes from charge lost at the
    # edges of the pixel, but a scatter peak also carries intensity from
    # scattering inside the sample and inside the cryostat, which can run much
    # further down. If the pre-edge null test fails and the detector spectrum
    # shows the model falling away faster than the data below the elastic
    # line, raise this: the tail has to go somewhere, and otherwise it goes
    # into the target element's column as a false pre-edge signal.
    #
    # Held fixed rather than fitted. The free parameter trades against
    # compton_angle -- intensity below the elastic line can be there either
    # because the Compton peak moved down or because the tail runs long -- and
    # on a real eight-element scan the fit took the wrong branch and lost half
    # the edge step. See docs/athena-xrf-xas-reference.md.
    scatter_beta: float = Field(default=0.5, gt=0.0, le=20.0)

    calibration_points: int = Field(default=6, ge=2, le=MAX_CALIBRATION_POINTS)
    point_stride: int = Field(default=1, ge=1, le=64)
    include_window_sum: bool = Field(default=False, strict=True)
    background: str = Field(default='smooth', pattern=r'^(smooth|none)$')
    background_terms: int = Field(default=4, ge=1, le=8)
    ridge: float = Field(default=1e-4, ge=0, le=1)
    # Escape peaks, as a multiple of the physical escape fraction Larch
    # computes for the detector material: 1.0 is that fraction, 0 switches
    # the response off. Below the detector's own K edge the fraction is zero
    # and this does nothing whatever it is set to.
    escape_amp: float = Field(default=1.0, ge=0, le=10)

    # Normalisation, passed straight to Larch's pre_edge.
    e0: float | None = Field(default=None, gt=0)
    pre1: float = Field(default=-170.0, lt=0)
    pre2: float = Field(default=-40.0, lt=0)
    norm1: float = Field(default=100.0, gt=0)
    norm2: float = Field(default=700.0, gt=0)
    nnorm: int = Field(default=2, ge=0, le=3)

    # A scan point index; None is the first point past the target's edge,
    # where the target lines are lit and the spectrum shows what was fitted.
    preview_point: int | None = Field(default=None, ge=0, lt=MAX_SCAN_POINTS)
    # A detector element index; one that is not extracted from falls back to
    # the first element that is.
    preview_detector: int = Field(default=0, ge=0, lt=MAX_DETECTORS)

    @model_validator(mode='after')
    def _ordered(self):
        if self.channel_range is not None:
            lo, hi = self.channel_range
            if not 0 <= lo < hi <= MAX_CHANNELS:
                raise ValueError('channel_range must be an increasing pair inside the detector.')
            if hi - lo < 32:
                raise ValueError('The fit window needs at least 32 channels.')
            if self.roi_range is not None:
                rlo, rhi = self.roi_range
                if not lo <= rlo < rhi <= hi:
                    raise ValueError('roi_range must be an increasing pair inside channel_range.')
        elif self.roi_range is not None and not 0 <= self.roi_range[0] < self.roi_range[1]:
            raise ValueError('roi_range must be an increasing pair.')
        if sorted(set(self.elements)) != self.elements or (self.elements and self.elements[0] < 0):
            raise ValueError('Detector elements must be listed once each, in increasing order, '
                             'numbered from zero.')
        if any(len(pair) != 2 for pair in self.channel_shifts):
            raise ValueError('channel_shifts must be [element, shift] pairs, one per element.')
        shifted = [pair[0] for pair in self.channel_shifts]
        if len(set(shifted)) != len(shifted):
            raise ValueError('channel_shifts must be [element, shift] pairs, one per element.')
        if any(not -64 <= pair[1] <= 64 or pair[0] < 0 for pair in self.channel_shifts):
            raise ValueError('A channel shift must lie between -64 and 64 channels.')
        if self.pre2 <= self.pre1 or self.norm2 <= self.norm1:
            raise ValueError('Normalisation ranges must increase.')
        if self.target in self.matrix_elements:
            raise ValueError('The target element must not be repeated among the matrix elements.')
        stray = [s for s in self.open_gates if s not in self.matrix_elements]
        if stray:
            raise ValueError('open_gates may only name matrix elements: ' + ', '.join(stray))
        return self


# ---------------------------------------------------------------- reading


def _entry(handle):
    for name in handle:
        node = handle[name]
        if hasattr(node, 'keys') and 'data' in node:
            return node
    raise ScientificError('This file has no scan entry with a data group, and is not an '
                          'APS 20-BM detector file either. Select a fluorescence energy '
                          'scan written by the beamline.')


# APS 20-BM's LabVIEW control program writes a scan's detector file beside the
# text scan: one '1D Scan' group holding each detector element's spectra as a
# separate 'MCA n' array of shape (1, points, channels), the positioners in
# 'X Positions' (1, points, motors) and every scaler and ROI sum under
# 'Detectors' as (1, points). The panels read it as one detector, 'MCA', whose
# element n-1 is 'MCA n', so the elements line up with the beamline's own
# numbering.
TWENTY_BM_SCAN = '1D Scan'
TWENTY_BM_DETECTOR = 'MCA'
MCA_PATTERN = re.compile(r'^MCA (?P<index>\d+)$')


def _twenty_bm(handle):
    """The 20-BM '1D Scan' group and its MCA dataset names in element order,
    or None for any other layout."""
    scan = handle.get(TWENTY_BM_SCAN) if hasattr(handle, 'get') else None
    if scan is None or not hasattr(scan, 'keys'):
        return None
    found = sorted((int(match['index']), name) for name in scan
                   if (match := MCA_PATTERN.match(name)))
    if not found:
        return None
    # Element n-1 is read as 'MCA n'. A missing dataset would renumber every
    # element after it, and exclusions and channel shifts would then act on
    # the wrong hardware element, so the numbering has to be complete.
    numbers = [index for index, _ in found]
    declared = scan.attrs.get('NMCAS')
    expected = list(range(1, (int(declared) if declared is not None else len(found)) + 1))
    if numbers != expected:
        missing = sorted(set(expected) - set(numbers))
        raise ScientificError(
            f'This 20-BM file numbers its MCA datasets {", ".join(map(str, numbers))}'
            + (f' and declares NMCAS = {int(declared)}' if declared is not None else '')
            + (f'; MCA {", ".join(map(str, missing))} is missing' if missing else '')
            + '. Elements are matched to MCA numbers by position, so the file is refused '
              'rather than renumbered.')
    return scan, [name for _, name in found]


def _twenty_bm_shape(scan, names):
    shapes = {scan[name].shape for name in names}
    if len(shapes) != 1:
        raise ScientificError('The MCA arrays in this 20-BM file have different shapes, so '
                              'they cannot be read as elements of one detector.')
    shape = shapes.pop()
    if len(shape) != 3 or shape[0] != 1:
        raise ScientificError('The MCA arrays in this 20-BM file are not shaped '
                              '(1, points, channels).')
    return (int(shape[1]), len(names), int(shape[2]))


def _twenty_bm_energy(scan):
    """The monochromator energy, from the positioner whose name says so."""
    if 'X Positions' not in scan:
        return None
    positions = scan['X Positions']
    info = positions.attrs.get('Motor Info')
    names = [str(row[0]) if np.ndim(row) else str(row) for row in info] if info is not None else []
    column = next((i for i, name in enumerate(names) if 'energy' in name.lower()), None)
    if column is None or positions.ndim != 3:
        return None
    return np.asarray(positions[0, :, column], dtype=float)


def _twenty_bm_scalars(scan, points):
    found = {}
    detectors = scan.get('Detectors')
    if detectors is None or not hasattr(detectors, 'keys'):
        return found
    for name in detectors:
        node = detectors[name]
        if not hasattr(node, 'shape') or node.shape != (1, points):
            continue
        values = np.asarray(node[0], dtype=float)
        if np.isfinite(values).all():
            # LabVIEW pads some labels with a trailing space ('DT Corr I0 ').
            found[name.strip()] = values
    return found


def detector_tables(handle, points_ok):
    """Every multi-element detector the file holds, as name -> (points,
    elements, channels), for either layout. `points_ok` decides which point
    counts are acceptable to the caller."""
    twenty = _twenty_bm(handle)
    if twenty is not None:
        scan, names = twenty
        shape = _twenty_bm_shape(scan, names)
        if (shape[1] <= MAX_DETECTORS and shape[2] <= MAX_CHANNELS and points_ok(shape[0])):
            return {TWENTY_BM_DETECTOR: shape}
        return {}
    group = _entry(handle)['data']
    tables = {}
    for name in group:
        node = group[name]
        if not hasattr(node, 'shape') or node.ndim != 3:
            continue
        if node.shape[1] > MAX_DETECTORS or node.shape[2] > MAX_CHANNELS:
            continue
        if not points_ok(node.shape[0]):
            continue
        tables[name] = tuple(int(size) for size in node.shape)
    return tables


def read_window(handle, detector, lo, hi, *, elements=None, shifts=None, limit):
    """One channel window of one detector: (points, elements, hi - lo).

    `elements` picks detector elements by index, in increasing order; None is
    all of them. `shifts` maps an element to a whole number of channels: that
    element is read from [lo + shift, hi + shift), so a spectrum recorded a
    few channels off its neighbours is put back in line with them before
    anything is summed. `limit` bounds the values materialised.
    """
    twenty = _twenty_bm(handle)
    if twenty is not None:
        if detector != TWENTY_BM_DETECTOR:
            raise ScientificError(f'This 20-BM file has no detector named {detector}.')
        scan, names = twenty
        points, count, width = _twenty_bm_shape(scan, names)
        read = lambda index, a, b: scan[names[index]][0, :, a:b]  # noqa: E731
    else:
        node = _entry(handle)['data']
        if detector not in node:
            raise ScientificError(f'The scan has no detector named {detector}.')
        dataset = node[detector]
        if dataset.ndim != 3:
            raise ScientificError(f'{detector} is not a multi-channel detector array.')
        points, count, width = dataset.shape
        read = lambda index, a, b: dataset[:, index, a:b]  # noqa: E731
    chosen = list(range(count)) if elements is None else list(elements)
    stray = [index for index in chosen if not 0 <= index < count]
    if stray:
        raise ScientificError(
            f'{detector} has {count} elements, numbered from 1; element ' +
            ', '.join(str(index + 1) for index in stray) + ' does not exist.')
    shifts = shifts or {}
    for index in chosen:
        shift = shifts.get(index, 0)
        if lo + shift < 0 or hi + shift > width:
            raise ScientificError(
                f'{detector} has {width} channels; the window {lo}–{hi}'
                + (f' shifted by {shift} for element {index + 1}' if shift else '')
                + ' runs past them. Narrow the channel range.')
    values = points * len(chosen) * (hi - lo)
    if values > limit:
        raise ScientificError(
            f'{detector} would expand to {values / 1e6:.0f} million counts over '
            f'this window, above the {limit / 1e6:.0f} million supported. '
            'Narrow the channel range, or choose fewer elements.')
    out = np.empty((points, len(chosen), hi - lo))
    for position, index in enumerate(chosen):
        shift = shifts.get(index, 0)
        out[:, position, :] = read(index, lo + shift, hi + shift)
    return out


def read_scan(data: bytes, filename: str) -> dict:
    """Read a multi-element XRF energy scan out of an HDF5 file in memory."""
    import h5py

    try:
        handle = h5py.File(io.BytesIO(data), 'r')
    except OSError as exc:
        raise ScientificError('This file is not readable as HDF5. '
                              'Select the original scan file.') from exc
    with handle:
        twenty = _twenty_bm(handle)
        if twenty is not None:
            return _read_twenty_bm(twenty, filename)
        entry = _entry(handle)
        group = entry['data']
        if 'energy' not in group:
            raise ScientificError('The scan has no energy array. '
                                  'Select an energy scan, not a map or a single spectrum.')
        energy = _checked_energy(group['energy'][()])

        channels = {}
        for name in group:
            node = group[name]
            if not hasattr(node, 'shape'):
                continue
            if node.ndim == 1 and node.shape[0] == energy.size and name != 'energy':
                values = np.asarray(node[()], dtype=float)
                if np.isfinite(values).all():
                    channels[name] = values
        detectors = detector_tables(handle, lambda points: points == energy.size)
        for name, values in _stream_channels(entry, energy.size).items():
            channels.setdefault(name, values)
        if not detectors:
            raise ScientificError('The scan has no multi-channel detector array of the '
                                  'right length. Select a fluorescence energy scan.')
        if not channels:
            raise ScientificError('The scan has no scalar channel that could serve as I0.')
        deadtime, corrected, unusable = _deadtime(entry, detectors, energy.size)
        return _ordered(dict(filename=filename, energy_ev=_in_ev(energy), detectors=detectors,
                             channels=channels, deadtime=deadtime, deadtime_corrected=corrected,
                             deadtime_unusable=unusable, layout='nexus', entry=entry.name,
                             notes=[]))


def _checked_energy(values):
    energy = np.asarray(values, dtype=float).reshape(-1)
    if energy.size < 8:
        raise ScientificError('An energy scan needs at least 8 points.')
    if energy.size > MAX_SCAN_POINTS:
        raise ScientificError(f'This scan has {energy.size} points; at most '
                              f'{MAX_SCAN_POINTS} are supported. Truncate the scan.')
    if not np.isfinite(energy).all():
        raise ScientificError('The energy array contains non-finite values.')
    return energy


def _in_ev(energy):
    # Beamline files write eV; the XRF model works in keV.
    return energy if energy.max() > 100 else energy * 1000.0


def _ordered(scan):
    # Larch's pre_edge sorts the energy axis inside itself and returns the
    # normalised curve in that order. A descending or shuffled scan would
    # therefore be paired point for point with the wrong energies, so the
    # whole scan is put in ascending order here, once, together.
    order = np.argsort(scan['energy_ev'], kind='stable')
    reordered = bool(np.any(np.diff(order) != 1))
    if reordered:
        scan['energy_ev'] = scan['energy_ev'][order]
        scan['channels'] = {name: values[order] for name, values in scan['channels'].items()}
        scan['deadtime'] = {name: table[order] for name, table in scan['deadtime'].items()}
    return dict(scan, order=order, reordered=reordered)


def _read_twenty_bm(twenty, filename):
    scan, names = twenty
    energy = _twenty_bm_energy(scan)
    if energy is None:
        raise ScientificError('This 20-BM file has no monochromator energy among its '
                              'positioners. Select an energy scan, not a map.')
    energy = _checked_energy(energy)
    detectors = detector_tables(scan.file, lambda points: points == energy.size)
    if not detectors:
        raise ScientificError('The MCA arrays in this 20-BM file do not match its energy '
                              'axis, or exceed the supported detector size.')
    channels = _twenty_bm_scalars(scan, energy.size)
    if not channels:
        raise ScientificError('The scan has no scalar channel that could serve as I0.')
    elements = detectors[TWENTY_BM_DETECTOR][1]
    # The file carries no per-element deadtime factor. 'AUTODTCORR' says
    # whether the control program applied its own correction to the ROI sums;
    # the MCA spectra the fit reads are raw either way, so they are carried
    # uncorrected and labelled so, and 'DT Corr I0' -- I0 scaled by the
    # detector's live fraction -- is offered as a monitor like any other.
    auto = str(scan.attrs.get('AUTODTCORR', '')).strip()
    notes = ['APS 20-BM detector file: no per-element deadtime factors are recorded, so '
             'the MCA spectra are used uncorrected' + (f' (AUTODTCORR {auto})' if auto else '')
             + '. Dividing by XMAP12B:DT Corr I0 instead of I0 applies the detector\'s '
             'own whole-detector live-time correction.']
    return _ordered(dict(
        filename=filename, energy_ev=_in_ev(energy), detectors=detectors, channels=channels,
        deadtime={TWENTY_BM_DETECTOR: np.ones((energy.size, elements))},
        deadtime_corrected={TWENTY_BM_DETECTOR: 0}, deadtime_unusable={TWENTY_BM_DETECTOR: {}},
        layout='aps-20bm', entry=scan.name, notes=notes))


def _primary(entry):
    node = entry
    for step in ('instrument', 'bluesky', 'streams', 'primary'):
        if not hasattr(node, 'keys') or step not in node:
            return None
        node = node[step]
    return node


def _stream_channels(entry, points):
    primary = _primary(entry)
    found = {}
    if primary is None:
        return found
    for name in primary:
        node = primary[name]
        if not hasattr(node, 'keys') or 'value' not in node:
            continue
        values = node['value']
        if getattr(values, 'ndim', 0) != 1 or values.shape[0] != points:
            continue
        if DEADTIME_PATTERN.match(name):
            continue
        array = np.asarray(values[()], dtype=float)
        if np.isfinite(array).all():
            found[name] = array
    return found


def _deadtime(entry, detectors, points):
    """Per-detector-element deadtime correction factors.

    A missing factor means the element was recorded without a correction, and
    is carried as 1.0 -- the raw counts, honestly labelled by the count of
    corrected elements that comes back alongside. A factor that is present but
    unusable is a different thing: a zero, a negative, a NaN or a
    wrong-length array would erase, invert or distort that element's
    contribution before the detectors are summed. Such an element is recorded
    here with the reason, its factors set to NaN, and the extraction refuses
    it unless it is left out -- a disabled channel is what an Xspress3 writes
    this way, and one dead element must not block the other seven.
    """
    primary = _primary(entry)
    factors, corrected, unusable = {}, {}, {}
    for detector, shape in detectors.items():
        table = np.ones((points, shape[1]))
        found, bad = 0, {}
        for index in range(shape[1]):
            name = f'{detector}-element{index}-deadtime_factor'
            if primary is None or name not in primary or 'value' not in primary[name]:
                continue
            column = np.asarray(primary[name]['value'][()], dtype=float).reshape(-1)
            if column.shape != (points,):
                bad[index] = (f'The deadtime factor {name} has {column.size} values for a '
                              f'{points}-point scan, so element {index + 1} cannot be '
                              'deadtime corrected.')
            elif not np.isfinite(column).all() or np.any(column <= 0):
                bad[index] = (f'The deadtime factor {name} contains values that are not '
                              'positive and finite, which would erase or invert detector '
                              f'element {index + 1}.')
            else:
                table[:, index] = column
                found += 1
                continue
            table[:, index] = np.nan
        factors[detector] = table
        corrected[detector] = found
        unusable[detector] = bad
    return factors, corrected, unusable


# A beamline names its scalers after the hardware that carries them --
# 'IpreKB', 'Ipreslit' -- not after the role they play in the experiment, so
# looking for the string 'i0' finds the incident monitor on some files and
# nothing at all on others.
I0_MONITOR_HINTS = ('i0', 'io', 'ipre', 'imon', 'mon', 'iflux')
# Downstream of the sample. Whatever else these are good for, dividing the
# fluorescence by one of them does not give mu(E).
I0_MONITOR_VETOES = ('it', 'i1', 'i2', 'iref', 'itrans', 'ifluo', 'if')
# One scaler is reported several ways. Counts are what the extraction wants;
# a current in amps is the same signal times a gain, and a raw count is the
# same signal before its own background is taken off.
I0_SUFFIX_ORDER = ('net_count', 'raw_count', 'net_current', 'raw_current')


def suggest_i0(names) -> str | None:
    """Which channel is most likely the incident-flux monitor.

    None when nothing looks like one, so the panel can ask instead of
    normalising the scan by whichever channel happens to sort first.
    """
    def rank(name: str):
        token = name.split('-')[0].lower()
        if token in I0_MONITOR_VETOES:
            return None
        if not any(token.startswith(hint) for hint in I0_MONITOR_HINTS):
            return None
        for position, suffix in enumerate(I0_SUFFIX_ORDER):
            if name.endswith(suffix):
                return position
        return len(I0_SUFFIX_ORDER)

    scored = [(rank(name), name) for name in sorted(names)]
    usable = [pair for pair in scored if pair[0] is not None]
    return min(usable)[1] if usable else None


def scan_summary(scan: dict) -> dict:
    """What the panel needs to offer a choice of detector, channels and I0."""
    energy = scan['energy_ev']
    # The extraction divides by I0 and refuses a channel that is not strictly
    # positive. Offering such a channel is offering a dead end, so the usable
    # ones are named here under the same test the extraction applies.
    usable = sorted(name for name, values in scan['channels'].items()
                    if np.all(values > 0))
    return dict(
        filename=scan['filename'], points=int(energy.size),
        energy_min=float(energy.min()), energy_max=float(energy.max()),
        layout=scan.get('layout', 'nexus'), notes=scan.get('notes', []),
        detectors=[dict(name=name, elements=int(shape[1]), channels=int(shape[2]),
                        # Elements whose deadtime factor the extraction would
                        # refuse, with why, so the panel can leave them out
                        # before the first fit instead of after a refusal.
                        unusable_elements=[dict(element=index, reason=reason) for index, reason
                                           in sorted(scan.get('deadtime_unusable', {})
                                                     .get(name, {}).items())])
                   for name, shape in sorted(scan['detectors'].items())],
        channels=sorted(scan['channels']),
        usable_i0=usable,
        suggested_i0=suggest_i0(usable),
    )


def load_counts(handle_bytes: bytes, detector: str, channel_range, *,
                allowed=None, elements=None, shifts=None) -> np.ndarray:
    """Read one detector's counts for the fit window only, for the chosen
    elements, each read at its own channel shift.

    `allowed` is the detector table from `read_scan`. Only a detector that
    survived that inspection may be read: it is the inspection that bounded
    the element and channel counts, and the byte size of a compressed file
    says nothing about what it expands to.
    """
    import h5py

    lo, hi = channel_range
    if allowed is not None and detector not in allowed:
        raise ScientificError(f'The scan has no usable detector named {detector}. '
                              'Choose one of the detectors the scan file offers.')
    with h5py.File(io.BytesIO(handle_bytes), 'r') as handle:
        return read_window(handle, detector, lo, hi, elements=elements, shifts=shifts,
                           limit=MAX_COUNTS_VALUES)


# ------------------------------------------------------ automatic windows

# The automatic fit window runs from this far below the target line, so the
# line's low-energy tail, the continuum under it and any matrix line just
# below are inside, to this far above the highest incident energy, so the
# elastic peak and its high side are whole at every point.
AUTO_FIT_BELOW_KEV = 1.2
AUTO_FIT_ABOVE_KEV = 0.5
# The automatic comparison window is the target line plus and minus this many
# detector FWHM, at the engine's starting detector noise -- the width a
# beamline ROI on a Kα line is usually set to.
AUTO_ROI_HALF_WIDTH_FWHM = 1.2
# The automatic preview point is the first one this far past the edge, where
# the target lines are lit and the spectrum shows what the fit is separating.
AUTO_PREVIEW_ABOVE_EDGE_EV = 20.0


def target_line(target, low_ev, high_ev):
    """The target edge this scan crosses, its energy in eV, and the energy in
    keV of the strongest line family that edge feeds (intensity-weighted over
    the lines within 0.1 keV of the strongest, so Kα is Kα1 and Kα2)."""
    from xraydb import xray_lines

    edges = subshell_edges(target)
    crossed = [(kev, name) for name, kev in edges.items() if low_ev <= 1000 * kev < high_ev]
    if not crossed:
        # A scan that starts above the edge still measures it.
        crossed = [max(((kev, name) for name, kev in edges.items() if 1000 * kev < high_ev),
                       default=None)]
    if not crossed or crossed[0] is None:
        raise ScientificError(f'This scan crosses no absorption edge of {target}. '
                              'Check the target element and the energy range.')
    edge_kev, edge = min(crossed)
    lines = [line for line in xray_lines(target, initial_level=edge).values()
             if line.intensity > 0]
    if not lines:
        raise ScientificError(f'{target} has no tabulated emission line from its {edge} edge.')
    strongest = max(lines, key=lambda line: line.intensity)
    family = [line for line in lines if abs(line.energy - strongest.energy) <= 100.0]
    weight = sum(line.intensity for line in family)
    line_kev = 0.001 * sum(line.energy * line.intensity for line in family) / weight
    return edge, 1000.0 * edge_kev, line_kev


def with_default_calibration(options):
    """The options with an empty starting calibration set to the fixed default."""
    from .xrf_calibration import DEFAULT_OFFSET_KEV, DEFAULT_SLOPE_KEV

    update = {key: value for key, value in (('cal_offset', DEFAULT_OFFSET_KEV), ('cal_slope', DEFAULT_SLOPE_KEV))
              if getattr(options, key) is None}
    return options.model_copy(update=update) if update else options


def resolve_windows(scan: dict, options: XrfXasOptions):
    """Fill in whichever of the fit window, the comparison window and the
    preview point were left automatic, through the calibration in the request.

    Returns the completed options and a record of what was derived. The
    calibration is the request's starting one: if it is wrong, so are these
    windows. The web routes fill an empty calibration from the scan file before
    this runs; anything still empty here takes the old fixed default.
    """
    from larch.xrf.xrf_model import FanoFactors

    options = with_default_calibration(options)

    if options.detector not in scan['detectors']:
        raise ScientificError(f'The scan has no usable detector named {options.detector}. '
                              'Choose one of the detectors the scan file offers.')
    channels = scan['detectors'][options.detector][2]
    energy = scan['energy_ev']
    edge, edge_ev, line_kev = target_line(options.target, float(energy.min()),
                                          float(energy.max()))
    to_channel = lambda kev: (kev - options.cal_offset) / options.cal_slope  # noqa: E731
    shifts = [pair[1] for pair in options.channel_shifts] or [0]
    first, last = max(0, -min(shifts)), channels - max(0, max(shifts))
    update, derived = {}, dict(edge=edge, edge_ev=edge_ev, line_kev=line_kev)

    fit = options.channel_range
    if fit is None:
        lo = max(first, int(math.floor(to_channel(line_kev - AUTO_FIT_BELOW_KEV))))
        hi = min(last, int(math.ceil(to_channel(0.001 * energy.max() + AUTO_FIT_ABOVE_KEV))))
        if hi - lo < 32:
            raise ScientificError(
                f'The automatic fit window, from {line_kev - AUTO_FIT_BELOW_KEV:.2f} keV to '
                f'{0.001 * energy.max() + AUTO_FIT_ABOVE_KEV:.2f} keV, falls outside this '
                f'detector\'s {channels} channels at an energy offset of {options.cal_offset} keV '
                f'and {options.cal_slope} keV per channel. Enter the detector\'s calibration, '
                'or set the fit window by hand.')
        fit = update['channel_range'] = [lo, hi]
    if options.roi_range is None:
        half = AUTO_ROI_HALF_WIDTH_FWHM * 2.3548 * math.sqrt(
            FanoFactors[options.detector_material] * line_kev + 0.06 ** 2)
        rlo = max(fit[0], int(round(to_channel(line_kev - half))))
        rhi = min(fit[1], int(round(to_channel(line_kev + half))) + 1)
        if rhi - rlo < 2:
            raise ScientificError(
                f'The {options.target} line at {line_kev:.3f} keV is not inside the fit window '
                f'at this calibration. Check the calibration, or set the comparison window by hand.')
        update['roi_range'] = [rlo, rhi]
    if options.preview_point is None:
        past = np.flatnonzero(energy >= edge_ev + AUTO_PREVIEW_ABOVE_EDGE_EV)
        update['preview_point'] = int(past[0]) if past.size else int(energy.size - 1)
    derived['automatic'] = sorted(update)
    if update:
        options = XrfXasOptions.model_validate(options.model_dump() | update)
    return options, derived


# ------------------------------------------------------- the Larch basis


def compton_center(incident_kev, angle_deg):
    """Compton-shifted energy for a photon scattered through angle_deg."""
    shift = 1.0 - math.cos(math.radians(angle_deg))
    return incident_kev / (1.0 + incident_kev * shift / ELECTRON_REST_KEV)


def channel_energy(channels, cal_offset, cal_slope):
    return cal_offset + cal_slope * np.asarray(channels, dtype=float)


def build_model(symbols, xray_energy_kev, energy_window, *, material, thickness,
                det_noise, peak_step, peak_tail, escape_amp=0.0,
                peak_gamma=0.0, peak_beta=0.5, det_variance_slope=None):
    """A Larch XRF_Model holding the elements, with no scatter peaks."""
    from larch.xrf.xrf_model import XRF_Model

    model = XRF_Model(xray_energy=xray_energy_kev,
                      energy_min=float(energy_window[0]),
                      energy_max=float(energy_window[1]))
    model.set_detector(material=material, thickness=thickness, noise=det_noise,
                       peak_step=peak_step, peak_tail=peak_tail,
                       peak_gamma=peak_gamma, peak_beta=peak_beta)
    if det_variance_slope is not None:
        # Effective energy-dependent broadening includes charge collection
        # and electronics, not only the material's intrinsic Fano statistics.
        model.efano = det_variance_slope
    if escape_amp > 0:
        model.add_escape(scale=escape_amp, vary=False)
    for symbol in symbols:
        model.add_element(symbol)
    return model


def detected(model, energy_kev, column):
    """Detector absorbance, live time and the escape response, as Larch applies
    them: an escaping detector re-emits part of what it absorbed one detector
    Ka lower, so a line at E leaves a copy at E - E_Ka. Outside the recorded
    window there is no parent intensity to escape from, hence fill_value=0."""
    from larch.math.utils import interp1d

    column = column * model.atten * model.count_time
    if model.use_escape:
        shifted = interp1d(energy_kev - model.escape_energy, column, energy_kev,
                           fill_value=0.0)
        column = column + model.escape_amp * shifted
    return np.nan_to_num(column, nan=0.0, posinf=0.0, neginf=0.0)


class _Values:
    """Parameter values in the form XRF_Model.calc_spectrum reads them."""

    def __init__(self, values):
        self.values = values

    def valuesdict(self):
        return self.values


def element_columns(model, energy_kev, split_kbeta=()):
    """Unit-amplitude columns, optionally separating a target's K-beta.

    Larch sums an element's whole line set into a single component. That is
    one column too coarse here: the K and the L lines of the same element are
    excited by different edges, so a scan that crosses only one of them must
    be able to switch one on without the other. The construction below is
    Larch's own -- its line table, subshell strengths, Fano width, hypermet
    shape, detector absorbance and escape response -- split by the initial
    level each line falls from. The target's K-beta has its own amplitude:
    overlapping matrix lines must not set the reported K-alpha yield. Matrix
    K-beta/K-alpha ratios remain tabulated, so an unresolved matrix K-beta
    cannot trade against the target or moving scatter. This assumes negligible
    differential sample absorption; it is not a self-absorption correction.
    For a split element 'K' denotes K-alpha, 'Kbeta' the other K lines.
    Their sum reproduces Larch's component.
    """
    from larch.math.lineshapes import hypermet

    # Larch's calc_spectrum fills model.atten and the escape scale. It would
    # also draw every line a second time into per-element components that
    # nothing here reads; it skips an element whose amplitude it is not
    # given, so it is given the values without the element amplitudes.
    pars = model.params.valuesdict()
    model.calc_spectrum(energy_kev, params=_Values(
        {name: value for name, value in pars.items() if not name.startswith('amp_')}))
    peaks = {}
    for elem in model.elements:
        for name, line in elem.lines.items():
            level = line.initial_level
            center = 0.001 * line.energy
            amplitude = (line.intensity * elem.mu
                         * elem.fyields[level] * elem.taus[level])
            peak = hypermet(energy_kev, amplitude=amplitude, center=center,
                            sigma=model.det_sigma(center, pars['det_noise']),
                            step=pars['peak_step'], tail=pars['peak_tail'],
                            beta=pars['peak_beta'], gamma=pars['peak_gamma'])
            split = elem.symbol in split_kbeta and name.startswith('Kb')
            key = (elem.symbol, 'Kbeta' if split else level)
            peaks[key] = peaks.get(key, 0.0) + peak
    return {key: detected(model, energy_kev, peak) for key, peak in peaks.items()}


def subshell_edges(symbol):
    """Every subshell edge of an element that Larch can give lines for, keV."""
    from larch.xrf.xrf_model import XRAY_EDGES
    from xraydb import xray_edges

    table = xray_edges(symbol)
    return {name: 0.001 * table[name].energy for name in XRAY_EDGES if name in table}


def scatter_column(model, energy_kev, center_kev, *, sigmax, step, tail, beta, det_noise):
    """One unit-amplitude scatter peak, built exactly as XRF_Model builds its own."""
    from larch.math.lineshapes import hypermet

    sigma = sigmax * model.det_sigma(center_kev, det_noise)
    column = hypermet(energy_kev, amplitude=1.0, center=center_kev, sigma=sigma,
                      step=step, tail=tail, beta=beta,
                      gamma=model.params['peak_gamma'].value)
    return detected(model, energy_kev, column)


# ------------------------------------------- exact reuse inside calibration
#
# The calibration evaluates the basis thousands of times, and a finite-
# difference Jacobian moves one parameter at a time, so most of what one
# evaluation computes is identical to what an earlier one computed. What is
# reused below is looked up by the bit pattern of every input it depends on,
# so a reused array is the array a fresh evaluation would have produced; no
# value is interpolated or approximated.


def exact_key(*parts):
    """A dictionary key equal only for bit-identical floating-point inputs."""
    return tuple(np.ascontiguousarray(part, dtype=float).tobytes() for part in parts)


class ExactMemo:
    """The few most recent results, keyed by `exact_key`."""

    def __init__(self, size):
        self.size = size
        self.entries = OrderedDict()

    def get(self, key, compute):
        if key in self.entries:
            self.entries.move_to_end(key)
            return self.entries[key]
        value = compute()
        self.entries[key] = value
        if len(self.entries) > self.size:
            self.entries.popitem(last=False)
        return value


def readonly(array):
    """A cached array, protected from in-place changes by whoever reuses it."""
    if array is not None:
        array.setflags(write=False)
    return array


def escape_constants(material):
    """What Larch's XRF_Model.calc_escape_scale reads from xraydb that does not
    depend on the channel energies: the detector material's K-alpha energy,
    its attenuation there and its K edge. Larch looks them up again on every
    call; they belong to the material, so they are looked up once."""
    from xraydb import material_mu, xray_edge, xray_line

    escape_energy_ev = xray_line(material, 'Ka').energy
    edge = xray_edge(material, 'K')
    return dict(escape_energy_ev=escape_energy_ev,
                mu_emit=material_mu(material, escape_energy_ev),
                fyield=edge.fyield, edge_ev=edge.energy)


def detector_response(detector, energy_kev, escape):
    """The detector's total attenuation and escape scale on a channel axis.

    These are the arrays Larch's XRF_Material.calc_mu and
    XRF_Model.calc_escape_scale compute, by the same xraydb calls in the same
    arithmetic order. Both of Larch's functions evaluate the same
    material_mu(material, 1000 * energy) total attenuation; here it is
    evaluated once and used for both. The photoabsorption-only attenuation
    calc_mu also computes is not: nothing on the extraction's path reads it.
    `escape` is `escape_constants(...)`, or None when the model has no escape.
    """
    from xraydb import material_mu

    mu_total = material_mu(detector.material, 1000 * energy_kev,
                           density=detector.density, kind='total')
    scale = None
    if escape is not None:
        mu_input = (mu_total if detector.density is None
                    else material_mu(detector.material, 1000 * energy_kev))
        scale = escape['fyield'] * np.exp(-escape['mu_emit'] / (2 * mu_input))
        scale[np.where(energy_kev < 0.001 * escape['edge_ev'])] = 0.0
    return readonly(mu_total), readonly(scale)


def scatter_block(model, energy_kev, centers_kev, **shape):
    """One scatter column per point, `scatter_column` at each centre."""
    if len(centers_kev) == 0:
        return np.zeros((0, energy_kev.size))
    return np.vstack([scatter_column(model, energy_kev, float(center), **shape)
                      for center in centers_kev])


# --------------------------------------------------------------- the solve


def solve_amplitudes(basis, counts, *, ridge, free_mask, variance=None):
    """Poisson-weighted, box-constrained least squares at every scan point.

    basis is (points, components, channels) of unit-amplitude columns; counts
    is (points, channels). Components outside free_mask are held nonnegative;
    the target, which is inside it, is signed so that model mismatch in the
    pre-edge is not censored into a positive bias.

    Inverse-variance weights estimate variance from the *measured* counts,
    with a floor of one count; this is not an exact Poisson likelihood. Nothing is
    subtracted from the data first: a continuum estimate is a column of the
    model like any other, so that the calibration outside and the amplitude
    solve inside minimise the same weighted misfit, and so that a
    background-dominated channel is not handed the weight of an empty one.

    Every point is solved to the constrained optimum, not clipped towards it.
    Where the unconstrained solution is already feasible it *is* the
    constrained optimum, since the gradient vanishes there; the remaining
    points go to a bounded solver, and its optimality is reported.
    """
    points, ncomp, nchan = basis.shape
    weights = 1.0 / np.clip(counts if variance is None else variance, 1.0, None)

    # Column normalisation keeps the Gram matrix conditioned when one line is
    # orders of magnitude brighter than another.
    norms = np.sqrt(np.einsum('pkc,pc,pkc->pk', basis, weights, basis))
    live = norms > 0
    safe = np.where(live, norms, 1.0)
    scaled = basis / safe[:, :, None]

    gram = np.einsum('pkc,pc,plc->pkl', scaled, weights, scaled)
    rhs = np.einsum('pkc,pc,pc->pk', scaled, weights, counts)

    diagonal = np.einsum('pkk->pk', gram).copy()
    floor = 1e-8 * diagonal.mean(axis=1, keepdims=True) + 1e-12
    # Regularize overlapping nuisance columns, never the measured signal.
    # Even a small target penalty can turn a changing neighbour into an edge.
    penalty = np.where(free_mask[None, :], 0.0, ridge * diagonal + floor)
    system = gram + np.einsum('pk,kl->pkl', penalty, np.eye(ncomp))
    # A dead column must not be reachable: keep it at exactly zero.
    system[~live[:, :, None] | ~live[:, None, :]] = 0.0
    index = np.arange(ncomp)
    system[:, index, index] = np.where(live, system[:, index, index], 1.0)
    rhs = np.where(live, rhs, 0.0)

    amplitudes = np.linalg.solve(system, rhs[:, :, None])[:, :, 0]
    bounded = np.where(np.any((amplitudes < 0) & ~free_mask[None, :], axis=1))[0]
    optimality = 0.0
    if bounded.size:
        from scipy.linalg import qr, solve_triangular
        from scipy.optimize import nnls

        def nonnegative(design, target):
            try:
                return nnls(design, target)[0]
            except RuntimeError as exc:
                raise ScientificError(
                    'The constrained XRF amplitude solve did not converge. '
                    'Check the fit window and overlapping matrix lines.') from exc

        root = np.sqrt(weights)
        for point in bounded:
            design = np.vstack([scaled[point].T * root[point][:, None],
                                np.diag(np.sqrt(penalty[point]))])
            target = np.concatenate([counts[point] * root[point], np.zeros(ncomp)])
            # Eliminate the signed columns with QR, solve the remaining
            # nonnegative least squares, then recover the signed amplitudes.
            # This is the same constrained objective without repeated SVD
            # solves of near-collinear continuum columns inside BVLS.
            signed = free_mask & live[point]
            if np.any(signed):
                q, r = qr(design[:, signed], mode='economic')
                nuisance = design[:, ~free_mask]
                reduced = nuisance - q @ (q.T @ nuisance)
                rhs_reduced = target - q @ (q.T @ target)
                amplitudes[point, ~free_mask] = nonnegative(reduced, rhs_reduced)
                amplitudes[point, signed] = solve_triangular(
                    r, q.T @ (target - nuisance @ amplitudes[point, ~free_mask]))
            else:
                amplitudes[point] = nonnegative(design, target)
            gradient = design.T @ (design @ amplitudes[point] - target)
            kkt = np.where(free_mask | (amplitudes[point] > 0),
                           gradient, np.minimum(gradient, 0.0))
            optimality = max(optimality, float(np.max(np.abs(kkt))))

    penalty_residual = amplitudes * np.sqrt(penalty)
    amplitudes = np.where(live, amplitudes / safe, 0.0)
    areas = amplitudes * basis.sum(axis=2)
    model = np.einsum('pk,pkc->pc', amplitudes, basis)
    residual = counts - model
    dof = max(nchan - ncomp, 1)
    return dict(amplitudes=amplitudes, areas=areas, model=model,
                penalty_residual=penalty_residual,
                redchi=np.einsum('pc,pc,pc->p', residual, weights, residual) / dof,
                diagnostics=dict(bounded_points=int(bounded.size),
                                 unconverged_points=0,  # nnls raises if it cannot converge.
                                 max_optimality=float(optimality)))


# ---------------------------------------------------------- the assembly


def background_columns(model, energy_kev, terms):
    """A smooth continuum basis: decaying exponentials seen by the detector.

    The continuum under a fluorescence spectrum is bremsstrahlung and sample
    scatter -- a smooth, falling source spectrum -- multiplied by the same
    detector absorbance every line goes through. A positive combination of
    decaying exponentials is a completely monotone function, so with the
    amplitudes held nonnegative this basis stays smooth and falling before
    detector attenuation. This restricts its ability to mimic fluorescence
    peaks; it does not eliminate overlap or guarantee an unbiased yield.

    What it replaces is a peak-clipping estimate of the continuum. That was
    wrong twice over: subtracting it broke the noise model, because what is
    left after removing an estimate is not Poisson with variance equal to
    itself; and as a single fixed column it is a poor shape, because the
    clipping follows the line tails it was meant to exclude. On synthetic
    scans carrying a known continuum the clipped column biased the recovered
    edge by about ten per cent and left a reduced chi-square near six, while
    this basis recovers the edge to under one per cent at a chi-square of one.
    """
    energy = np.asarray(energy_kev, dtype=float)
    return np.vstack([detected(model, energy, row)
                      for row in continuum_shapes(energy, terms)])


def continuum_shapes(energy_kev, terms):
    """The decaying exponentials themselves, before any detector response.

    Split out so that a fitting engine with a different detector model can
    carry the same continuum family. What restricts the basis is the shape --
    completely monotone, so a nonnegative combination can fall but never curl
    up into a peak -- and that is a property of these rows, not of whatever
    is multiplied onto them afterwards.
    """
    energy = np.asarray(energy_kev, dtype=float)
    width = float(energy[-1] - energy[0])
    # Decay lengths spanning the window, from flat to steep. Two per octave is
    # enough: the ridge and the nonnegativity handle what overlap remains.
    taus = width / 2.0 ** np.arange(terms)
    return np.exp(-(energy - energy[0])[None, :] / taus[:, None])


# The thresholds the quality verdicts use, as fractions of the edge jump.
# They live here, not in the browser, so that one number is both displayed
# and tested.
NULL_MEAN_LIMIT = 0.02
NULL_RMS_LIMIT = 0.02
# The drift is judged extrapolated over the whole scan, because that is what
# normalisation does with it: the pre-edge line is carried across every point,
# so a slope that is small over the pre-edge window becomes a tilt of the
# whole normalised spectrum if the leak behind it does not continue the same
# way above the edge.
NULL_DRIFT_LIMIT = 0.05
POST_NEGATIVE_LIMIT = 0.02
SHAPE_RMS_LIMIT = 0.05


def _null_test(energy_ev, signal, e0, pre1, pre2, edge_step):
    """How far the pre-edge departs from a flat zero, as a fraction of the
    edge jump: mean level, straight-line drift over the pre-edge window and
    the same line carried over the whole scan, and RMS about the line."""
    window = (energy_ev >= e0 + pre1) & (energy_ev <= e0 + pre2)
    if window.sum() < 4 or not edge_step:
        return None
    x, y = energy_ev[window], signal[window]
    slope, intercept = np.polyfit(x, y, 1)
    line = slope * x + intercept
    return dict(
        points=int(window.sum()),
        mean_frac_of_jump=float(y.mean() / edge_step),
        drift_frac_of_jump=float(slope * (x[-1] - x[0]) / edge_step),
        drift_over_scan_frac_of_jump=float(slope * (energy_ev[-1] - energy_ev[0]) / edge_step),
        detrended_rms_frac_of_jump=float(np.sqrt(np.mean((y - line) ** 2)) / edge_step),
    )


def _post_edge_test(energy_ev, signal, norm, e0, norm1, norm2, jump):
    """What the extraction does above the edge. A fluorescence yield cannot be
    negative there, and an extraction that pushes it negative has taken signal
    away from the target and given it to something else; the normalised
    scatter about unity is the oscillation amplitude, reported, not judged."""
    window = (energy_ev >= e0 + norm1) & (energy_ev <= e0 + norm2)
    if window.sum() < 4 or not jump:
        return None
    above = np.asarray(signal)[window]
    return dict(
        points=int(window.sum()),
        negative_fraction=float(np.mean(above < 0.0)),
        min_frac_of_jump=float(above.min() / abs(jump)),
        normalized_rms_about_one=float(np.sqrt(np.mean((norm[window] - 1.0) ** 2))),
    )


def _signed_jump(group):
    """The fitted edge jump with its sign. Larch's edge_step is an absolute
    value, so an extraction that produces an upside-down edge -- a target
    column driven negative above the edge -- passes any test built on it."""
    index = int(np.argmin(np.abs(np.asarray(group.energy) - float(group.e0))))
    return float(group.post_edge[index] - group.pre_edge[index])


def normalize(energy_ev, signal, options):
    """Larch's pre_edge, with the ranges the caller asked for."""
    from larch import Group
    from larch.xafs import pre_edge

    group = Group(energy=np.asarray(energy_ev, dtype=float),
                  mu=np.asarray(signal, dtype=float))
    pre_edge(group, e0=options.e0, pre1=options.pre1, pre2=options.pre2,
             norm1=options.norm1, norm2=options.norm2, nnorm=options.nnorm)
    return group


def _quality(energy_ev, fit, roi, per_detector, options):
    indicators = {}
    for name, signal in (('fit', fit), ('roi', roi)):
        try:
            group = normalize(energy_ev, signal, options)
        except (ValueError, IndexError, TypeError) as exc:
            raise ScientificError(
                'The extraction could not be normalised. Check e0 and the '
                'pre-edge and normalisation ranges.') from exc
        norm = np.asarray(group.norm, dtype=float)
        jump = _signed_jump(group)
        null = _null_test(energy_ev, signal, float(group.e0),
                          options.pre1, options.pre2, float(group.edge_step))
        post = _post_edge_test(energy_ev, signal, norm, float(group.e0),
                               options.norm1, options.norm2, jump)
        indicators[name] = dict(
            e0=float(group.e0), edge_step=float(group.edge_step), signed_jump=jump,
            null_test=null, post_edge=post, norm=norm,
            checks=dict(
                # Each verdict names what would have to be true for it to pass,
                # and is None when the measurement it needs is missing. The
                # pre-edge one is a baseline diagnostic: necessary, not
                # sufficient -- a bias shared above and below the edge, or a
                # real pre-edge pedestal from harmonics, is invisible to it.
                edge_direction=jump > 0,
                pre_edge_null=None if null is None else bool(
                    abs(null['mean_frac_of_jump']) < NULL_MEAN_LIMIT
                    and abs(null['drift_over_scan_frac_of_jump']) < NULL_DRIFT_LIMIT
                    and null['detrended_rms_frac_of_jump'] < NULL_RMS_LIMIT),
                post_edge_positive=None if post is None else bool(
                    post['negative_fraction'] <= POST_NEGATIVE_LIMIT),
            ),
        )

    steps, curves, edgeless = [], [], []
    for row, column in enumerate(per_detector):
        try:
            group = normalize(energy_ev, column, options)
        except (ValueError, IndexError, TypeError):
            edgeless.append(row)
            continue
        jump = _signed_jump(group)
        if np.isfinite(jump) and jump > 0:
            steps.append(jump)
            curves.append(np.asarray(group.norm, dtype=float))
        else:
            edgeless.append(row)
    agreement = None
    if len(steps) > 1:
        # Detectors differ in solid angle and efficiency, so their edge jumps
        # differ by design; what has to agree is the shape after
        # normalisation. A spread in jumps is reported, not judged, and a
        # bias shared by every detector shows in neither.
        worst = max(float(np.sqrt(np.mean((a - b) ** 2)))
                    for i, a in enumerate(curves) for b in curves[i + 1:])
        agreement = dict(detectors=len(steps),
                         edge_step_spread=float(np.std(steps) / np.mean(steps)),
                         worst_pairwise_rms=worst,
                         checks=dict(shape_agreement=bool(worst < SHAPE_RMS_LIMIT)))
    indicators['detector_agreement'] = agreement
    # Rows of per_detector, not element numbers; extract() translates them.
    indicators['edgeless_rows'] = edgeless
    return indicators


# ------------------------------------------------------------ calibration


CALIBRATION_PARAMETERS = (
    ('cal_offset', -0.5, 0.5),
    ('cal_slope', 1e-4, 0.1),
    ('det_noise', 1e-3, 0.5),
    ('det_variance_slope', 0.0, 0.02),
    ('cal_curvature', -0.1, 0.1),
    ('peak_gamma', 0.0, 1.0),
    ('peak_beta', 0.1, 10.0),
    ('peak_step', 0.0, 10.0),  # Hypermet divides step by 100; native Larch bounds.
    ('peak_tail', 0.0, 2.0),
    ('elastic_sigmax', 0.3, 5.0),
    ('elastic_step', 0.0, 10.0),
    ('elastic_tail', 0.0, 5.0),
    ('compton_sigmax', 0.5, 12.0),
    ('compton_step', 0.0, 10.0),
    ('compton_tail', 0.0, 8.0),
    ('compton_angle', 60.0, 175.0),
)


def calibration_indices(points, count):
    """Evenly spaced scan points, deterministically chosen."""
    return np.unique(np.linspace(0, points - 1, min(count, points)).round().astype(int))


def initial_parameters(options):
    options = with_default_calibration(options)
    from larch.xrf.xrf_model import FanoFactors

    values = dict(cal_offset=options.cal_offset, cal_slope=options.cal_slope,
                  cal_curvature=0.0,
                  det_variance_slope=FanoFactors[options.detector_material],
                  peak_gamma=0.01, peak_beta=0.5,
                  det_noise=0.06, peak_step=1e-3, peak_tail=0.05,
                  elastic_sigmax=1.0, elastic_step=0.005, elastic_tail=0.3,
                  compton_sigmax=2.5, compton_step=0.005, compton_tail=1.0,
                  compton_angle=options.compton_angle)
    params = Parameters()
    for name, low, high in CALIBRATION_PARAMETERS:
        params.add(name, value=values[name], min=low, max=high)
    # Additional broadening may exceed, but cannot remove, intrinsic charge
    # creation statistics in the specified detector material.
    params['det_variance_slope'].min = values['det_variance_slope']
    return params


# ------------------------------------------------- gating, shared by engines


def reference_energy(edges, opened, low, high):
    """The incident energy the stationary line columns are built at.

    An edge at or above the lowest incident energy is one this scan crosses.
    Those are the edges the extraction is about: the target's signal comes
    from the lines they feed, and an open gate on a matrix element is a
    statement about them. Edges below the scan are excited at every point
    already, so their lines are gated by nothing -- which is why the gate
    belongs to the line family, not to the element. One gate per element
    would switch an element's K lines on at its L edge.

    A line model gives an element no lines at all below its lowest included
    edge, so the reference the columns are built at has to clear the edges
    whose gates are open as well as the scan itself.
    """
    reference = high
    for symbol in opened:
        crossed = [kev for kev in edges[symbol].values() if kev >= low]
        if crossed:
            reference = max(reference, 1.001 * min(crossed))
    return reference


def gate_plan(edges, symbols, target, opened, low, high, present):
    """Which line families the fit carries, their gates, and the target's own.

    `present` is the subset of (symbol, subshell) keys that have a non-empty
    column in the fit window. Both fitting engines come through here, so
    whatever else differs between their spectral models, the same families
    are fitted, switched on at the same incident energies, and the same ones
    are summed into the target's signal.
    """
    edge_of = lambda key: edges[key[0]].get('K' if key[1] == 'Kbeta' else key[1], 0.0)  # noqa: E731
    order = {symbol: position for position, symbol in enumerate(symbols)}
    keys = sorted(present, key=lambda key: (order[key[0]], edge_of(key)))
    if not keys:
        raise ScientificError(
            'None of these elements has a fluorescence line inside the fit '
            'window. Widen the channel range, or check the calibration.')
    # An open gate is a statement about the edges this scan crosses: those
    # lines stay in the model below their edge, so pre-edge intensity is
    # measured rather than clipped to zero. It says nothing about lines the
    # beam excites everywhere, which are never gated anyway.
    gates = {key: (0.0 if key[0] in opened and edge_of(key) >= low else edge_of(key))
             for key in keys}

    crossed = [key for key in keys if key[0] == target and edge_of(key) >= low]
    if not crossed:
        # A scan that starts above the edge still measures it; fall back to
        # the highest edge of the target the incident beam ever excites.
        below = [key for key in keys if key[0] == target and edge_of(key) < high]
        crossed = [max(below, key=edge_of)] if below else []
    if not crossed:
        raise ScientificError(
            f'This scan crosses no absorption edge of {target} that the fit '
            'window can see. Check the target element and the energy range.')
    # K-beta is fitted independently, but the reported K-edge yield comes
    # from K-alpha alone. Keep K-beta as a fallback for a K-beta-only window.
    crossed = [key for key in crossed if key[1] != 'Kbeta'] or crossed
    return keys, gates, crossed


class Fitter:
    """Builds the basis and solves one detector's spectra for a parameter set."""

    # Other engines use this field to describe departures from this response.
    notes: list[str] = []

    def __init__(self, channels, incident_kev, target, matrix_elements, options):
        self.channels = np.asarray(channels, dtype=float)
        self.incident = np.asarray(incident_kev, dtype=float)
        self.target = target
        self.symbols = [target, *matrix_elements]
        self.options = options
        low, high = float(self.incident.min()), float(self.incident.max())

        edges = {symbol: subshell_edges(symbol) for symbol in self.symbols}
        opened = {target, *options.open_gates}
        self.reference_kev = reference_energy(edges, opened, low, high)

        # Exact reuse during calibration; see ExactMemo. A three-point
        # Jacobian visits each axis or scatter shape at most a few times
        # in close succession, so a few entries catch every repeat.
        self._responses = ExactMemo(8)
        self._scatter = ExactMemo(8)
        self._continuum = ExactMemo(4)

        # The column set is fixed here, once, from the starting calibration:
        # the fitted calibration moves the window by a channel or so, and the
        # basis may not change shape underneath the solve when it does.
        _, columns = self._build(initial_parameters(options).valuesdict())[1:]
        present = [key for key, column in columns.items() if np.any(column > 0)]
        self.keys, self.gates, self.target_keys = gate_plan(
            edges, self.symbols, target, opened, low, high, present)

        self.names = [f'{symbol} {level}' for symbol, level in self.keys]
        self.names += ['elastic', 'compton']
        self.background_terms = (0 if options.background == 'none'
                                 else options.background_terms)
        self.names += [f'continuum {term + 1}' for term in range(self.background_terms)]
        self.target_indices = [self.keys.index(key) for key in self.target_keys]
        self.free_mask = np.zeros(len(self.names), dtype=bool)
        self.free_mask[self.target_indices] = True

    def initial_parameters(self):
        return initial_parameters(self.options)

    def channel_energy(self, values):
        energy = channel_energy(self.channels, values['cal_offset'], values['cal_slope'])
        half_range = 0.5 * (self.channels[-1] - self.channels[0])
        position = (self.channels - self.channels.mean()) / max(half_range, 1.0)
        # A fractional endpoint deflection keeps the derivative at 0.8--1.2
        # times the positive linear gain, even at the curvature bounds.
        energy += (values.get('cal_curvature', 0.0) * values['cal_slope']
                   * half_range * position**2)
        return energy

    def _build(self, values):
        energy = self.channel_energy(values)
        column_key = tuple(values.get(name) for name in (
            'cal_offset', 'cal_slope', 'cal_curvature', 'det_noise',
            'det_variance_slope', 'peak_gamma', 'peak_beta', 'peak_step', 'peak_tail'))
        if column_key == getattr(self, '_column_key', None):
            return energy, self._model, self._columns
        if not hasattr(self, '_model'):
            self._model = build_model(
                self.symbols, self.reference_kev, (float(energy[0]), float(energy[-1])),
                material=self.options.detector_material,
                thickness=self.options.detector_thickness,
                det_noise=values['det_noise'], peak_step=values['peak_step'],
                peak_tail=values['peak_tail'], escape_amp=self.options.escape_amp)
            self._intrinsic_variance = self._model.efano
            self._escape = None
            if self._model.use_escape:
                self._escape = escape_constants(self._model.detector.material)
                self._model.escape_energy = 0.001 * self._escape['escape_energy_ev']
            self._response_key = None
        model = self._model
        for name in ('det_noise', 'peak_step', 'peak_tail'):
            model.params[name].value = values[name]
        model.params['peak_gamma'].value = values.get('peak_gamma', 0.0)
        model.params['peak_beta'].value = values.get('peak_beta', 0.5)
        model.efano = values.get('det_variance_slope', self._intrinsic_variance)
        # Atomic line data are fixed throughout calibration. Detector attenuation
        # and escape, in contrast, must follow every changed channel-energy axis.
        # They depend on nothing else, so a Jacobian that returns to an axis
        # it has already visited reuses what that axis gave.
        energy_key = exact_key(energy)
        if energy_key != self._response_key:
            mu_total, escape_scale = self._responses.get(
                energy_key, lambda: detector_response(model.detector, energy, self._escape))
            model.detector.mu_total, model.detector.mu_photo = mu_total, None
            model.escape_scale = escape_scale
            self._response_key = energy_key
        self._columns = element_columns(model, energy, split_kbeta={self.target})
        self._column_key = column_key
        return energy, model, self._columns

    def basis(self, values, indices):
        energy, model, columns = self._build(values)
        empty = np.zeros(energy.size)
        incident = self.incident[indices]
        basis = np.zeros((len(indices), len(self.names), energy.size))
        for position, key in enumerate(self.keys):
            live = incident > self.gates[key]
            basis[:, position, :] = np.where(live[:, None],
                                             columns.get(key, empty)[None, :], 0.0)
        elastic, compton = len(self.keys), len(self.keys) + 1
        compton_centers = np.array([compton_center(float(energy_in), values['compton_angle'])
                                    for energy_in in incident])
        for position, prefix, centers in ((elastic, 'elastic', incident),
                                          (compton, 'compton', compton_centers)):
            shape = dict(sigmax=values[f'{prefix}_sigmax'], step=values[f'{prefix}_step'],
                         tail=values[f'{prefix}_tail'], beta=self.options.scatter_beta,
                         det_noise=values['det_noise'])
            compute = lambda: scatter_block(model, energy, centers, **shape)  # noqa: E731
            if len(indices) > MAX_CALIBRATION_POINTS:
                # A full-scan batch: built once, too large to keep.
                basis[:, position, :] = compute()
                continue
            # Besides its own shape, a scatter column depends on the axis
            # (through the detector response too), the Fano slope and the
            # Voigt gamma the model now holds -- nothing else.
            key = exact_key(energy, centers, [
                shape['sigmax'], shape['step'], shape['tail'], shape['beta'],
                shape['det_noise'], model.efano, model.params['peak_gamma'].value])
            basis[:, position, :] = self._scatter.get(key, lambda: readonly(compute()))
        if self.background_terms:
            continuum = self._continuum.get(exact_key(energy), lambda: readonly(
                background_columns(model, energy, self.background_terms)))
            basis[:, -self.background_terms:, :] = continuum[None, :, :]
        return energy, basis

    def solve(self, values, indices, counts, *, variance=None):
        energy, basis = self.basis(values, indices)
        solved = solve_amplitudes(basis, counts, ridge=self.options.ridge,
                                  free_mask=self.free_mask, variance=variance)
        return dict(solved, energy=energy, basis=basis)

    def target_area(self, solved):
        """The deadtime-uncorrected target signal, using K-alpha for K edges.
        Other shells retain their edge-specific line families. Lines the
        target emits from a shell far below the scan are excited at every
        point alike and carry no absorption structure, so they stay out."""
        return solved['areas'][:, self.target_indices].sum(axis=1)


def calibrate(fitter, counts, indices, *, max_nfev=12000):
    """Stage A: fit the shared detector parameters on a few scan points.

    The linear amplitudes are never lmfit parameters. At each iteration the
    shape parameters fix the basis, stage B solves the constrained linear
    amplitudes, and the penalized misfit is returned -- variable projection.
    """
    subset = counts[indices]
    # Start with count weights, then estimate variance from the intrinsic
    # model. Inner amplitudes and outer calibration always share the weights.
    variance = subset
    weights = 1.0 / np.sqrt(np.clip(subset, 1.0, None))
    def residual(params):
        solved = fitter.solve(params.valuesdict(), indices, subset, variance=variance)
        return np.concatenate([((subset - solved['model']) * weights).ravel(),
                               solved['penalty_residual'].ravel()])

    # Some peaks have zero amplitude at the starting calibration, so their
    # shape derivatives are zero. Bounded trust-region steps handle this
    # rank deficiency without the periodic bound transform used by leastsq.
    # Central differences and column scaling keep the inner solve's roundoff
    # from steering the much differently scaled shape parameters.
    parameters = fitter.initial_parameters()
    expanded = isinstance(fitter, Fitter)
    basic = parameters.copy()
    if expanded:
        for name in ('det_variance_slope', 'cal_curvature', 'peak_gamma', 'peak_beta'):
            basic[name].vary = False
        basic['peak_gamma'].value = 0.0
        basic['peak_step'].max = 0.1
        basic['elastic_step'].max = basic['compton_step'].max = 0.5

    def optimize(params, budget):
        # Differentiate in physical characteristic units. A purely relative
        # step collapses near a zero tail/step parameter, while a unit step
        # on the raw gain (keV/channel) moves peaks by many channels.
        units = dict(cal_offset=0.1, cal_slope=0.01, cal_curvature=0.01,
                     det_noise=0.1, det_variance_slope=0.001, det_fano=0.001)
        scaled, physical = params.copy(), params.copy()
        scales = {name: units.get(name, 1.0) for name, par in params.items() if par.vary}
        for name, unit in scales.items():
            par = params[name]
            scaled[name].set(value=par.value/unit, min=par.min/unit, max=par.max/unit)

        def dimensionless_residual(trial):
            for name, unit in scales.items():
                physical[name].value = trial[name].value*unit
            return residual(physical)

        fitted = minimize(dimensionless_residual, scaled, method='least_squares',
                          jac='3-point', x_scale='jac', ftol=1e-10, xtol=1e-10,
                          gtol=1e-8, max_nfev=budget)
        for name, unit in scales.items():
            par = fitted.params[name]
            par.set(value=par.value*unit, min=par.min*unit, max=par.max*unit)
        return fitted

    result = optimize(basic, max_nfev)
    intrinsic = result
    evaluations = int(result.nfev)
    response_model = 'intrinsic'
    selection = None
    if expanded and result.success:
        # Feasible GLS: unlike observed-count weights, model variances do not
        # overweight downward Poisson fluctuations at low count rates.
        for _ in range(2):
            if not result.success or evaluations >= max_nfev:
                break
            preliminary = fitter.solve(result.params.valuesdict(), indices, subset, variance=variance)
            variance = np.clip(preliminary['model'], 1.0, None)
            weights = 1.0 / np.sqrt(variance)
            result = optimize(result.params, max_nfev-evaluations)
            evaluations += int(result.nfev)
        preliminary = fitter.solve(result.params.valuesdict(), indices, subset, variance=variance)
        if result.success and evaluations < max_nfev:
            for name in parameters:
                parameters[name].value = result.params[name].value
            candidate = optimize(parameters, max_nfev-evaluations)
            evaluations += int(candidate.nfev)
            alternative = fitter.solve(candidate.params.valuesdict(), indices, subset, variance=variance)
            # Both nested fits use the same intrinsic-model variance. Count
            # newly released parameters and expanded bounds conservatively;
            # boundary constraints can only reduce the null degrees of freedom.
            from scipy.stats import chi2
            added = sum(par.vary and not basic[name].vary for name, par in parameters.items())
            added += sum(par.vary and basic[name].vary and
                         (par.min != basic[name].min or par.max != basic[name].max)
                         for name, par in parameters.items())
            improvement = float(np.sum(((subset-preliminary['model'])*weights)**2)
                                - np.sum(((subset-alternative['model'])*weights)**2))
            threshold = float(chi2.isf(0.001, max(added, 1)))
            accepted = bool(candidate.success and improvement > threshold
                            and evaluations < max_nfev)
            selection = dict(statistic='fixed_model_variance_delta_chi_square',
                             improvement=improvement, added_parameters=int(added),
                             threshold=threshold, nominal_tail_probability=0.001,
                             candidate_converged=bool(candidate.success), accepted=accepted)
            # Model selection uses model-variance statistics. Once chosen,
            # retain the production estimator's common count-weighted
            # calibration/amplitude objective; do not mix two estimators.
            variance = subset
            weights = 1.0 / np.sqrt(np.clip(subset, 1.0, None))
            result = intrinsic
            if accepted and evaluations < max_nfev:
                for name in parameters:
                    parameters[name].value = intrinsic.params[name].value
                result = optimize(parameters, max_nfev-evaluations)
                evaluations += int(result.nfev)
                response_model = 'calibrated'
        else:
            result = intrinsic
            variance = subset
            weights = 1.0 / np.sqrt(np.clip(subset, 1.0, None))
    values = result.params.valuesdict()
    solved = fitter.solve(values, indices, subset, variance=variance)
    # Report only the data misfit, not the ridge penalty. The denominator
    # counts shape parameters but not eliminated amplitudes, as before:
    # this is a relative calibration statistic, not a goodness of fit.
    redchi = np.sum(((subset - solved['model']) * weights)**2)
    redchi /= max(subset.size - result.nvarys, 1)
    report = dict(redchi=float(redchi), nfev=evaluations,
                  success=bool(result.success), ier=int(getattr(result, 'status', 0)),
                  message=str(getattr(result, 'message', '') or ''),
                  calibration_subset_only=True,
                  response_model=response_model,
                  model_selection=selection,
                  at_bounds=parameters_at_bounds(result.params), **solved['diagnostics'])
    return values, report


def parameters_at_bounds(params, tol=1e-3):
    """The shape parameters the fit left resting on a limit.

    A parameter on its bound is the optimizer saying it wanted to go further.
    The shape it settled on is then the bound's, not the data's, and whatever
    the data wanted beyond it has been pushed into the other columns -- on
    this model, into the target's. lmfit reports such a fit as converged, so
    without this the only trace is a redchi that is merely a little worse.

    Zero floors and the intrinsic Fano variance floor are left out: reaching
    them means no extra response contribution, not running out of room.
    """
    resting = []
    for name, par in params.items():
        if not par.vary:
            continue
        span = par.max - par.min
        if not np.isfinite(span) or span <= 0:
            continue
        if par.value - par.min <= tol * span:
            if par.min != 0.0 and name != 'det_variance_slope':
                resting.append(name)
        elif par.max - par.value <= tol * span:
            resting.append(name)
    return resting


# --------------------------------------------------------------- the whole


def available_engines():
    """The engines this server can actually run, in the order to offer them.

    MapsTorch is optional -- it is not in the server's requirements, because it
    brings PyTorch with it -- so the panel is told which engines exist here
    rather than offering one that would fail at the first fit.
    """
    from .athena_xrf_mapstorch import available
    return ['larch'] + (['mapstorch'] if available() else [])


def make_fitter(channels, incident_kev, options):
    """The fitter for the requested engine.

    MapsTorch is imported here rather than at module scope: it pulls in
    PyTorch, which costs a second of start-up, and a server whose users only
    ever ask for the Larch engine should never pay it.
    """
    # Every fitter starts from a calibration: an empty one takes the fixed default
    # here too, for callers that build a fitter without the routes or `extract`.
    options = with_default_calibration(options)
    if options.engine == 'mapstorch':
        from .athena_xrf_mapstorch import MapsTorchFitter
        return MapsTorchFitter(channels, incident_kev, options.target,
                               options.matrix_elements, options)
    return Fitter(channels, incident_kev, options.target,
                  options.matrix_elements, options)


def chosen_elements(scan: dict, options: XrfXasOptions) -> list[int]:
    """The detector elements the request extracts from, checked against the
    file: every one exists, and none carries a deadtime factor the extraction
    would have to refuse."""
    available = scan['detectors'][options.detector][1]
    chosen = options.elements or list(range(available))
    stray = [index for index in chosen if index >= available]
    if stray:
        raise ScientificError(
            f'{options.detector} has {available} elements, numbered from 1; element ' +
            ', '.join(str(index + 1) for index in stray) + ' does not exist.')
    unusable = scan.get('deadtime_unusable', {}).get(options.detector, {})
    for index in chosen:
        if index in unusable:
            raise ScientificError(
                unusable[index] + f' Leave element {index + 1} out of the extraction, '
                'or repair the scan file.')
    return chosen


def fit_detector(fitter, spectra, indices, batch_size, preview_index):
    """Independent calibration and full-scan solve for one detector element."""
    values, report = calibrate(fitter, spectra, indices)
    areas = np.empty(len(spectra))
    preview = None
    diagnostics = dict(bounded_points=0, unconverged_points=0, max_optimality=0.0)
    for start in range(0, len(spectra), batch_size):
        selected = np.arange(start, min(start + batch_size, len(spectra)))
        solved = fitter.solve(values, selected, spectra[selected])
        areas[selected] = fitter.target_area(solved)
        for name in ('bounded_points', 'unconverged_points'):
            diagnostics[name] += solved['diagnostics'][name]
        diagnostics['max_optimality'] = max(
            diagnostics['max_optimality'], solved['diagnostics']['max_optimality'])
        if preview_index is not None and selected[0] <= preview_index <= selected[-1]:
            preview = detector_preview(solved, preview_index-start)
    return dict(values=values, report=report | diagnostics, areas=areas,
                energy=solved['energy'], preview=preview, preview_index=preview_index)


def detector_preview(solved, local):
    preview = {name: solved[name][local].copy()
               for name in ('basis', 'amplitudes', 'model', 'redchi')}
    preview['energy'] = solved['energy'].copy()
    return preview


def extract(scan: dict, counts: np.ndarray, options: XrfXasOptions,
            windows: dict | None = None, *, fit_provider=None) -> dict:
    """Run the three stages over the chosen detector elements and assemble
    mu(E) in each yield's own edge-step units. `counts` holds those elements
    only, in order, already shifted;
    `windows` is what `resolve_windows` derived, recorded with the result."""
    energy_ev = scan['energy_ev']
    if counts.shape[0] != energy_ev.size:
        raise ScientificError('The detector array and the energy array disagree in length.')
    if options.channel_range is None:
        raise ScientificError('Resolve the automatic fit window before reading the counts.')
    options = with_default_calibration(options)
    if options.roi_range is None or options.preview_point is None:
        options, derived = resolve_windows(scan, options)
        automatic = sorted({*(windows or {}).get('automatic', []), *derived['automatic']})
        windows = {**(windows or {}), **derived, 'automatic': automatic}
    elements = chosen_elements(scan, options)
    if counts.shape[1] != len(elements):
        raise ScientificError('The counts read do not match the detector elements chosen.')

    i0 = scan['channels'].get(options.i0_channel)
    if i0 is None:
        raise ScientificError(f'The scan has no channel named {options.i0_channel}. '
                              'Choose one of the scalar channels it does carry.')
    if not np.all(i0 > 0):
        raise ScientificError('The chosen I0 channel has non-positive points, so the '
                              'extraction cannot be normalised by it. Choose another channel.')
    deadtime = scan['deadtime'][options.detector][:, elements]
    # read_scan sorted the scan into ascending energy; the counts were read
    # straight from the file and have to follow, or every point is paired
    # with another point's spectrum.
    counts = counts[scan['order']]

    total_points, ndet, _ = counts.shape
    lo, hi = options.channel_range
    channels = np.arange(lo, hi)
    incident_kev = energy_ev / 1000.0
    fitter = make_fitter(channels, incident_kev, options)

    # Calibration and yield units use the whole scan. A stride only selects
    # returned points, so a preview remains a subset of the eventual group.
    keep = np.arange(0, total_points, options.point_stride)
    indices = calibration_indices(total_points, options.calibration_points)
    points = keep.size

    values_count = len(indices) * len(fitter.names) * channels.size
    if values_count > MAX_BASIS_VALUES:
        raise ScientificError(
            f'This request would build a {values_count:,}-value fit basis per '
            f'detector during calibration. Narrow the channel range, use '
            f'fewer calibration points, or fit fewer matrix elements. '
            f'Preview stride changes output size, not calibration work.')

    preview_detector = (elements.index(options.preview_detector)
                        if options.preview_detector in elements else 0)
    point = min(options.preview_point // options.point_stride, points - 1)
    preview_index = keep[point]
    batch_size = max(1, MAX_BASIS_VALUES // (len(fitter.names) * channels.size))
    _, _, line_kev = target_line(options.target, float(energy_ev.min()), float(energy_ev.max()))
    per_detector, parameters, reports, lost = [], [], [], []
    preview = None
    fits = (fit_provider(fitter, counts, indices, batch_size, preview_index, preview_detector)
            if fit_provider is not None else
            (fit_detector(fitter, counts[:, detector, :], indices, batch_size,
                          preview_index if detector == preview_detector else None)
             for detector in range(ndet)))
    for detector, fitted_detector in enumerate(fits):
        values, areas = fitted_detector['values'], fitted_detector['areas']
        if detector == preview_detector:
            preview = fitted_detector['preview']
            if fitted_detector['preview_index'] != preview_index:
                # Repeat exactly the original batch, not a differently sized
                # linear solve, when a cached fit draws a different point.
                start = (preview_index // batch_size) * batch_size
                selected = np.arange(start, min(start + batch_size, total_points))
                solved = fitter.solve(values, selected, counts[selected, detector, :])
                preview = detector_preview(solved, preview_index-start)
        parameters.append(values)
        reports.append(fitted_detector['report'])
        # Deadtime is a per-detector, per-point correction and must be applied
        # to that detector's own area before the detectors are summed.
        per_detector.append(areas * deadtime[:, detector])
        # A calibration that ran away can carry the target line out of the
        # fit window; that element then adds nothing, and the summed curve,
        # normalised, still looks like an edge. Seen on a real multi-element
        # scan, where most of the elements were lost this way.
        fitted_axis = fitted_detector['energy']
        if not fitted_axis[0] <= line_kev <= fitted_axis[-1] or not np.any(per_detector[-1] != 0):
            lost.append((elements[detector], values))

    if lost:
        axes = {}
        for element, values in lost:
            axis = f'{values["cal_offset"]:.3g} keV + {values["cal_slope"]:.4g} keV per channel'
            if values.get('cal_curvature', 0.0):
                axis += f', quadratic deflection {values["cal_curvature"]:.3g} of the half-span'
            axes.setdefault(axis, []).append(str(element + 1))
        fitted = '; '.join(f'element{"s" if len(names) > 1 else ""} {", ".join(names)}: {axis}'
                           for axis, names in axes.items())
        raise ScientificError(
            f'The calibration of {len(lost)} of the {ndet} chosen detector elements lost the '
            f'{options.target} line at {line_kev:.3f} keV: it falls outside the fit window '
            f'(channels {lo} to {hi}), or the element contributes nothing to it. Fitted energy '
            f'axes: {fitted}; entered: {options.cal_offset:.3g} keV + {options.cal_slope:.4g} keV '
            'per channel. No extraction is returned from a fit that has lost part of its detector. '
            'Leave those elements out, correct the starting calibration, or use the other engine.')

    per_detector = np.vstack(per_detector)
    fit_counts = per_detector.sum(axis=0)

    roi_lo, roi_hi = options.roi_range
    window = slice(roi_lo - lo, roi_hi - lo)
    roi_counts = (counts[:, :, window].sum(axis=2) * deadtime).sum(axis=1)

    fit_over_i0 = fit_counts / i0
    roi_over_i0 = roi_counts / i0
    indicators = _quality(energy_ev, fit_over_i0, roi_over_i0,
                          per_detector / i0[None, :], options)
    raw_steps = {name: indicators[name]['edge_step'] for name in ('fit', 'roi')}
    raw_signals = dict(fit=fit_over_i0, roi=roi_over_i0)
    # pre_edge clamps its reported step to 1e-12 even for a flat curve.
    # Test the unclamped jump against numerical resolution in the raw units.
    if not all(np.isfinite(step) and step > 1e-12 and
               abs(indicators[name]['signed_jump']) >
               100*np.finfo(float).eps*np.max(np.abs(raw_signals[name]))
               for name, step in raw_steps.items()):
        raise ScientificError('The fluorescence yields have no finite positive edge-step '
                              'scale. Check the extraction and normalization ranges.')
    # A pure unit change, not pre-edge subtraction or flattening. AUTOBK's
    # endpoint clamp depends on absolute mu units in upstream Larch.
    fit_over_i0 = fit_over_i0 / raw_steps['fit']
    roi_over_i0 = roi_over_i0 / raw_steps['roi']
    per_detector = per_detector / i0[None, :] / raw_steps['fit']
    for name in ('fit', 'roi'):
        indicators[name]['edge_step'] = 1.0
        indicators[name]['signed_jump'] /= raw_steps[name]
        indicators[name]['norm'] = indicators[name]['norm'][keep]

    energy_ev, counts = energy_ev[keep], counts[keep]
    drawn = preview['basis'] * preview['amplitudes'][:, None]
    fitted = {name: drawn[k].tolist() for k, name in enumerate(fitter.names)}
    # The continuum is a handful of fitted columns among the others, and no
    # one of them means anything on its own; the panel draws their sum, apart
    # from the lines, as the continuum under the spectrum.
    terms = fitter.background_terms
    for term in range(terms):
        fitted.pop(f'continuum {term + 1}')
    background = (drawn[len(fitter.names) - terms:].sum(axis=0) if terms
                  else np.zeros(channels.size)).tolist()
    spectrum = dict(
        point=point, detector=elements[preview_detector],
        incident_ev=float(energy_ev[point]),
        energy_kev=preview['energy'].tolist(),
        measured=counts[point, preview_detector, :].tolist(),
        background=background,
        total=preview['model'].tolist(),
        components=fitted,
        redchi=float(preview['redchi']),
    )

    return dict(
        energy_ev=energy_ev.tolist(),
        fit_counts=fit_counts[keep].tolist(), roi_counts=roi_counts[keep].tolist(),
        fit_over_i0=fit_over_i0[keep].tolist(), roi_over_i0=roi_over_i0[keep].tolist(),
        fit_norm=indicators['fit']['norm'].tolist(),
        roi_norm=indicators['roi']['norm'].tolist(),
        per_detector=per_detector[:, keep].tolist(),
        spectrum=spectrum,
        quality=dict(
            fit={k: v for k, v in indicators['fit'].items() if k != 'norm'},
            roi={k: v for k, v in indicators['roi'].items() if k != 'norm'},
            detector_agreement=indicators['detector_agreement'],
            # Elements whose own curve has no upward edge. They are still in
            # the summed signal; they are only kept out of the agreement
            # comparison, which cannot normalise them.
            elements_without_edge=[elements[row] for row in indicators['edgeless_rows']],
            # The thresholds behind the verdicts, so the panel can say what it
            # judged against without keeping a second copy of the numbers.
            limits=dict(pre_edge_mean=NULL_MEAN_LIMIT, pre_edge_rms=NULL_RMS_LIMIT,
                        pre_edge_drift_over_scan=NULL_DRIFT_LIMIT,
                        post_edge_negative=POST_NEGATIVE_LIMIT,
                        detector_shape_rms=SHAPE_RMS_LIMIT),
        ),
        detector_parameters=parameters,
        detector_reports=reports,
        metadata=dict(
            method='scan-resolved XRF fit',
            engine=options.engine,
            # Where the chosen engine departs from the other one, in its own
            # words, so a result carries its caveats rather than leaving them
            # in the documentation.
            engine_notes=fitter.notes,
            # The whole request, so the saved group records the recipe that
            # made it and not a hand-picked subset of it.
            request=options.model_dump(),
            mu_units='edge_step', raw_edge_steps=raw_steps,
            target=options.target,
            components=fitter.names, reference_energy_kev=fitter.reference_kev,
            gates_kev={f'{symbol} {level}': kev
                       for (symbol, level), kev in fitter.gates.items()},
            target_components=[fitter.names[k] for k in fitter.target_indices],
            target_line_families=[f'{symbol} ' + {'K': 'K-alpha', 'Kbeta': 'K-beta'}.get(level, level)
                                  for symbol, level in fitter.target_keys],
            roi_range=[roi_lo, roi_hi], channel_range=[lo, hi],
            # Which of the windows and the preview point were derived rather
            # than typed, and from what line.
            windows=windows or dict(automatic=[]),
            calibration_points=indices.tolist(),
            points=points, scan_points=total_points, detectors=ndet,
            elements=elements,
            excluded_elements=[index for index in range(scan['detectors'][options.detector][1])
                               if index not in elements],
            channel_shifts=options.channel_shifts,
            deadtime_corrected=scan['deadtime_corrected'].get(options.detector, 0),
            energy_reordered=bool(scan['reordered']),
            layout=scan.get('layout', 'nexus'), notes=scan.get('notes', []),
            source_file=scan['filename'], source_entry=scan['entry'],
        ),
    )
