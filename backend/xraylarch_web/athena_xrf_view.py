"""Looking at the raw counts of an energy dispersive detector.

The fluorescence XAS extraction in `athena_xrf_xas` fits every spectrum in a
scan and hands back mu(E). Before trusting it -- or when it goes wrong --
someone has to look at what the detector actually recorded: the spectrum at a
point, element by element, on a log scale where a peak three decades below the
elastic line is still visible, and the behaviour of a channel window across
the whole scan or across a map.

This module reads those counts and nothing else. It does not fit, deadtime
correct, or divide by I0; what it returns is what the file holds, so that a
disagreement between this view and a fitted result is a statement about the
fit rather than about two different preprocessings. The reader is deliberately
more permissive than `read_scan`: a file with no energy array -- a map, a
single spectrum, one row of a larger raster -- is a legitimate thing to look
at even though no XAS can be extracted from it.

docs/athena-xrf-viewer.md records the method and the failure each test is
named for.
"""
from __future__ import annotations

import io

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import ScientificError
from .hdf5_safety import validate_handle
from .athena_xrf_xas import (MAX_CHANNELS, MAX_DETECTORS, TWENTY_BM_DETECTOR, _entry,
                             _stream_channels, _twenty_bm, _twenty_bm_energy,
                             _twenty_bm_scalars, detector_tables, read_window)

# A map is many more points than an energy scan, and the viewer reads a
# channel window across all of them for the trace and the map image.
MAX_VIEW_POINTS = 100_000
# What one frame request may materialise: the channel window over every point
# and element. The compressed size of the file says nothing about this.
MAX_VIEW_VALUES = 40_000_000
# Points in the returned trace. Short scans go back whole; larger maps are
# decimated for the trace, but not for the map image.
MAX_TRACE_POINTS = 4000

# Stage and encoder names, for deciding which 1-D arrays could be the two
# axes of a raster. Positions are what make a cube a map; an energy axis or a
# scaler of the same length is not a position however it is named.
POSITION_HINTS = ('x', 'y', 'z', 'horizontal', 'vertical', 'sample', 'stage',
                  'aerotech', 'pos', 'coarse', 'fine')
# Named so they will not be mistaken for stage positions by the hints above
# ('x' matches almost anything).
POSITION_VETOES = ('energy', 'time', 'current', 'count', 'scaler', 'deadtime',
                   'dwell', 'temperature', 'taper', 'gap')


# ---------------------------------------------------------------- options


class XrfViewOptions(BaseModel):
    """One frame: which point, which elements, which channel window."""

    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)

    version: int = Field(ge=0)
    cube_id: str = Field(pattern=r'^[A-Za-z0-9_-]{16,128}$')
    detector: str = Field(min_length=1, max_length=120)

    point: int = Field(default=0, ge=0, lt=MAX_VIEW_POINTS)
    # Points averaged around `point`, to show the shape of a weak spectrum
    # without pretending a single noisy one is smooth. 1 is the point alone.
    average: int = Field(default=1, ge=1, le=1024)
    # Which detector elements to draw and to sum. Empty means all of them.
    elements: list[int] = Field(default_factory=list, max_length=MAX_DETECTORS)

    channel_range: list[int] = Field(default=[0, MAX_CHANNELS], min_length=2, max_length=2)
    # Adjacent channels summed before the spectrum is sent, reducing frame size.
    rebin: int = Field(default=1, ge=1, le=64)

    # The channel window whose sum makes the trace and the map. In channels,
    # like `channel_range`, so that neither depends on the calibration below.
    roi_range: list[int] = Field(default=[0, MAX_CHANNELS], min_length=2, max_length=2)

    # Channel -> keV, for the spectrum's abscissa only. Nothing here is fitted.
    # Left empty, it is read from the file (its line windows, its elastic
    # peak) by the route before the frame is drawn.
    cal_offset: float | None = Field(default=None, ge=-0.5, le=0.5)
    cal_slope: float | None = Field(default=None, gt=1e-4, le=0.1)

    # Which 1-D array the trace runs against. None means the point index.
    axis: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode='after')
    def _ordered(self):
        for name, pair in (('channel_range', self.channel_range), ('roi_range', self.roi_range)):
            lo, hi = pair
            if lo < 0 or hi <= lo:
                raise ValueError(f'{name} must increase and start at or after zero.')
            if hi > MAX_CHANNELS:
                raise ValueError(f'{name} ends beyond channel {MAX_CHANNELS}.')
        if sorted(set(self.elements)) != self.elements:
            raise ValueError('Detector elements must be listed once each, in order.')
        # A negative index would select from the far end of the detector
        # instead of being refused, and the spectrum would be somebody else's.
        if self.elements and self.elements[0] < 0:
            raise ValueError('Detector elements are numbered from zero.')
        return self


# ---------------------------------------------------------------- reading


def _numeric(node, points):
    if (not hasattr(node, 'shape') or node.ndim != 1 or node.shape[0] != points
            or not np.issubdtype(node.dtype, np.number)):
        return None
    values = np.asarray(node[()], dtype=float)
    return values if np.isfinite(values).all() else None


def _axes(entry, group, points):
    """Every 1-D array as long as the cube: what a trace could run against.

    Three layouts are read, because the two beamline files to hand use two of
    them and a third is what the NeXus standard suggests: arrays beside the
    cube in the data group, the bluesky stream groups the energy scans carry,
    and the NDAttributes an areaDetector writes (deadtime factors and the
    detector's own channel-advance sums, which are the only per-point numbers
    a single row file of a map holds).
    """
    found = {}
    for name in group:
        values = _numeric(group[name], points)
        if values is not None:
            found[name] = values
    for name, values in _stream_channels(entry, points).items():
        found.setdefault(name, values)
    attributes = entry.get('instrument/NDAttributes') if hasattr(entry, 'get') else None
    if attributes is not None and hasattr(attributes, 'keys'):
        for name in attributes:
            values = _numeric(attributes[name], points)
            if values is not None:
                found.setdefault(name, values)
    return found


def _row_length(values):
    """Points between the steps of a slow raster axis, or None.

    A slow axis holds still for a row and then steps. The step is far larger
    than the jitter of an encoder readback holding still, so the boundaries
    are where the difference exceeds half the largest one; a raster is when
    those boundaries are evenly spaced and divide the scan exactly.
    """
    diffs = np.abs(np.diff(values))
    if diffs.size == 0 or diffs.max() <= 0:
        return None
    moves = np.flatnonzero(diffs > 0.5 * diffs.max()) + 1
    if moves.size == 0:
        return None
    columns = int(moves[0])
    points = values.size
    if columns < 2 or points % columns or points // columns < 2:
        return None
    if not np.array_equal(moves, np.arange(columns, points, columns)):
        return None
    return columns


def detect_raster(axes):
    """Which pair of position arrays, if any, folds the points into an image.

    None for an energy scan or a single map row, which is the common case
    here and not an error: the viewer then offers the trace alone.
    """
    names = [name for name in sorted(axes)
             if any(hint in name.lower() for hint in POSITION_HINTS)
             and not any(veto in name.lower() for veto in POSITION_VETOES)]
    for slow in names:
        columns = _row_length(axes[slow])
        if columns is None:
            continue
        rows = axes[slow].size // columns
        held = np.ptp(axes[slow].reshape(rows, columns), axis=1)
        step = np.abs(np.diff(axes[slow][::columns])).min()
        if not np.all(held < 0.5 * step):
            continue
        for fast in names:
            if fast == slow:
                continue
            block = axes[fast].reshape(rows, columns)
            # The fast axis must sweep its whole travel inside every row.
            if not np.all(np.ptp(block, axis=1) > 0.5 * np.ptp(axes[fast])):
                continue
            first = block[0, -1] - block[0, 0]
            second = block[1, -1] - block[1, 0]
            return dict(fast=fast, slow=slow, columns=columns, rows=rows,
                        serpentine=bool(first * second < 0))
    return None


def read_cube(data: bytes, filename: str, *, settings=None) -> dict:
    """Read what an energy dispersive detector recorded, with or without an
    energy axis.

    `read_scan` refuses a file with no energy array because no XAS can come
    out of it. Here that file is the subject: a map, a row of a map, or a
    single spectrum is exactly what someone wants to look at.
    """
    import h5py

    try:
        handle = h5py.File(io.BytesIO(data), 'r')
    except OSError as exc:
        raise ScientificError('This file is not readable as HDF5. '
                              'Select the original detector file.') from exc
    with handle:
        validate_handle(handle, settings)
        detectors = detector_tables(handle, lambda points: 1 <= points <= MAX_VIEW_POINTS)
        twenty = _twenty_bm(handle)
        if twenty is not None and detectors:
            # APS 20-BM: one '1D Scan' group, the positioners in 'X Positions'
            # and every scaler under 'Detectors'; none of it is a raster.
            scan, _ = twenty
            count = detectors[TWENTY_BM_DETECTOR][0]
            axes = _twenty_bm_scalars(scan, count)
            energy = _twenty_bm_energy(scan)
            if energy is not None and energy.size == count and np.isfinite(energy).all():
                axes['Mono Energy'] = energy
            return dict(filename=filename, points=count, detectors=detectors,
                        axes=axes, raster=None, entry=scan.name)
        entry = _entry(handle)
        group = entry['data']
        if not detectors:
            raise ScientificError(
                'This file has no multi-channel detector array of the form '
                '(points, elements, channels). Select a detector file.')
        points = {shape[0] for shape in detectors.values()}
        if len(points) > 1:
            # Two cubes of different lengths cannot share one point slider or
            # one trace abscissa, and guessing which one the reader meant is
            # worse than saying so.
            raise ScientificError(
                'This file holds detector arrays of different lengths (' +
                ', '.join(f'{name} with {shape[0]}' for name, shape in sorted(detectors.items())) +
                ' points). Split the file, or select one written by a single scan.')
        count = points.pop()
        axes = _axes(entry, group, count)
        return dict(filename=filename, points=count, detectors=detectors,
                    axes=axes, raster=detect_raster(axes), entry=entry.name)


def cube_summary(cube: dict) -> dict:
    """What the panel needs to offer a detector, a point and an axis."""
    return dict(
        filename=cube['filename'], points=int(cube['points']),
        detectors=[dict(name=name, elements=shape[1], channels=shape[2])
                   for name, shape in sorted(cube['detectors'].items())],
        axes=[dict(name=name, min=float(values.min()), max=float(values.max()))
              for name, values in sorted(cube['axes'].items())
              if values.min() < values.max()],
        raster=cube['raster'],
    )


def load_window(data: bytes, detector: str, channel_range, *, allowed, settings=None) -> np.ndarray:
    """One channel window of one detector, over every point and element."""
    import h5py

    lo, hi = channel_range
    if detector not in allowed:
        raise ScientificError(f'This file has no usable detector named {detector}. '
                              'Choose one of the detectors the file offers.')
    with h5py.File(io.BytesIO(data), 'r') as handle:
        validate_handle(handle, settings)
        return read_window(handle, detector, lo, hi, limit=MAX_VIEW_VALUES)


# ----------------------------------------------------------------- frames


def _rebinned(window, lo, rebin):
    """Sum adjacent channels, dropping the remainder past the last full bin.

    Returns the summed counts and the channel at the centre of each bin, so
    that the abscissa still means what the calibration says it means.
    """
    width = window.shape[-1] // rebin
    if width < 1:
        raise ScientificError('The channel window is narrower than one rebinned bin.')
    kept = window[..., :width * rebin]
    summed = kept.reshape(*kept.shape[:-1], width, rebin).sum(axis=-1)
    centres = lo + np.arange(width) * rebin + (rebin - 1) / 2.0
    return summed, centres


def _selected(elements, available):
    if not elements:
        return list(range(available))
    stray = [index for index in elements if index >= available]
    if stray:
        raise ScientificError(
            f'This detector has {available} elements, numbered from 0; element ' +
            ', '.join(str(index) for index in stray) + ' does not exist.')
    return list(elements)


def frame(cube: dict, window: np.ndarray, options: XrfViewOptions) -> dict:
    """The spectrum at one point, the trace of a channel window, and -- when
    the file holds the positions for it -- that window as an image."""
    points = int(cube['points'])
    if options.point >= points:
        raise ScientificError(f'This file has {points} points, numbered from 0; '
                              f'point {options.point} does not exist.')
    elements = _selected(options.elements, window.shape[1])
    lo, hi = options.channel_range
    hi = min(hi, lo + window.shape[2])

    # The spectrum, averaged over a block centred on the chosen point. The
    # block is clipped to the scan rather than wrapped, so the average near an
    # end is over fewer points and is reported as such.
    half = options.average // 2
    start = max(0, options.point - half)
    stop = min(points, start + options.average)
    start = max(0, stop - options.average)
    block = window[start:stop, elements, :].mean(axis=0)
    spectra, centres = _rebinned(block, lo, options.rebin)
    from .xrf_calibration import DEFAULT_OFFSET_KEV, DEFAULT_SLOPE_KEV
    offset = DEFAULT_OFFSET_KEV if options.cal_offset is None else options.cal_offset
    slope = DEFAULT_SLOPE_KEV if options.cal_slope is None else options.cal_slope
    energy_kev = offset + slope * centres

    roi_lo, roi_hi = options.roi_range
    inside = slice(max(roi_lo - lo, 0), max(min(roi_hi, hi) - lo, 0))
    if inside.stop <= inside.start:
        raise ScientificError('The window of interest lies outside the channels read. '
                              'Move it inside the channel range.')
    roi = window[:, elements, inside].sum(axis=(1, 2))

    axis_name, axis = None, np.arange(points, dtype=float)
    if options.axis is not None:
        if options.axis not in cube['axes']:
            raise ScientificError(f'This file has no array named {options.axis} to plot '
                                  'against. Choose one of the axes it offers.')
        axis_name, axis = options.axis, cube['axes'][options.axis]

    stride = max(1, -(-points // MAX_TRACE_POINTS))
    result = dict(
        points=points, point=int(options.point),
        averaged=[int(start), int(stop)],
        elements=[int(index) for index in elements],
        channel_lo=int(lo), rebin=int(options.rebin),
        energy_kev=energy_kev.tolist(),
        calibration=dict(cal_offset=float(offset), cal_slope=float(slope)),
        spectra=[row.tolist() for row in spectra],
        total=spectra.sum(axis=0).tolist(),
        # Counts in the window of interest at this point, per element: which
        # element is seeing the sample, and which is dead or shadowed.
        element_counts=[float(window[options.point, index, inside].sum())
                        for index in elements],
        axis_name=axis_name, trace_stride=int(stride),
        axis=axis[::stride].tolist(), roi=roi[::stride].tolist(),
        roi_range=[int(roi_lo), int(min(roi_hi, hi))],
        map=None,
    )
    raster = cube['raster']
    if raster is not None:
        image = roi.reshape(raster['rows'], raster['columns'])
        if raster['serpentine']:
            image = image.copy()
            image[1::2] = image[1::2, ::-1]
        fast = cube['axes'][raster['fast']].reshape(raster['rows'], raster['columns'])[0]
        slow = cube['axes'][raster['slow']][::raster['columns']]
        result['map'] = dict(
            rows=raster['rows'], columns=raster['columns'],
            fast=raster['fast'], slow=raster['slow'],
            x=np.sort(fast).tolist() if raster['serpentine'] else fast.tolist(),
            y=slow.tolist(), values=[row.tolist() for row in image])
    return result
