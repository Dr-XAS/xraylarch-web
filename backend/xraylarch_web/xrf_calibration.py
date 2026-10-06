"""Where a detector's channels sit in energy, read from the scan itself.

The fit refines each detector element's energy calibration, but it starts
from a guess, and every automatic window is placed with that guess. A fixed
guess of 10 eV per channel put the windows of a 20-BM detector binned to about
30 eV per channel on empty channels three times too high, and the result was
noise with nothing to say why. So the starting calibration is read from the
file, per detector element:

1. Fluorescence lines in the beamline's own windows. 20-BM writes, for every
   element, the counts summed over a channel window around each line it was set
   up for ('XMAP12B:0:CrKa'). Those sums are exact window sums of the stored
   spectra, so the window is recovered exactly. A window says only where the
   beamline looked, so a line counts only if its absorption edge is reached in
   the scan and it peaks inside its window, clear of counting noise, in the
   spectra summed over the highest incident energies, where the scatter has
   moved furthest from it. Two such lines half a keV or more apart fix offset
   and slope by their tabulated energies.
2. The elastic peak. At every scan point it sits at the incident energy, which
   the scan records, so its channel against the incident energy is a straight
   line whose slope and intercept are the calibration. Pile-up runs at half
   its gain and Compton sits below it by at most the shift at 180 degrees,
   which tells the tracks apart; where only one scatter peak can be seen, it
   may be Compton, and the result says so.
3. The line that turns on at the edge the scan crosses. A fluorescence XAS
   scan crosses its target's edge, and the target's main line at least
   doubles there, while a line only modulated across another element's edge
   does not. Found where the first reading puts it, it anchors the offset;
   with one line, the scatter supplies the slope.

The elements' answers are combined by their median. When nothing is found, or
the answer is not a calibration this detector could have, the old default is
kept and the result says so, with the reason.
"""
from __future__ import annotations

import re

import numpy as np

DEFAULT_OFFSET_KEV = 0.0
DEFAULT_SLOPE_KEV = 0.010
# The bounds the fit itself allows for the starting calibration.
OFFSET_BOUND_KEV = 0.5
SLOPE_BOUNDS_KEV = (1e-4, 0.1)

# 'XMAP12B:0:CrKa', 'XMAP12B:11:CuKb', 'XMAP12B:3:PbLa': prefix, element index,
# element symbol, line family and line. Totals and sums over elements
# ('XMAP12B:CrKa_Sum', 'XMAP12B:4:Total') do not match.
LINE_WINDOW = re.compile(r'^(?P<prefix>[^:]+):(?P<index>\d+):(?P<symbol>[A-Z][a-z]?)'
                         r'(?P<family>[KLM])(?P<line>[abg])$')
# The header's 'Detector Names/PVs' list ties each name to the MCA record it
# sums: 'XMAP12B:0:CrKa/20xmap12b:mca1.R7'. The names' own index is 0-based for
# line windows and 1-based for totals, so the PV is what decides the element.
NAME_TO_MCA = re.compile(r'(?P<name>[^\s/]+:\d+:[A-Za-z]+)/\S*?mca(?P<mca>\d+)\.R\d+')
# The absorption edge whose vacancy each line family fills (its lowest for L, M).
FAMILY_EDGE = {'K': 'K', 'L': 'L3', 'M': 'M5'}

MIN_LINE_SEPARATION_KEV = 0.3
# A line closer than this below the lowest incident energy sits in the scatter's sweep.
SCATTER_MARGIN_KEV = 0.2
ELASTIC_POINTS = 48
ELASTIC_MIN_POINTS = 8
# A peak must stand this many Poisson standard deviations above its valleys.
SIGNIFICANCE = 5.0
# Points read from a detector file at a time.
CHUNK_POINTS = 64
# A followed peak has to move this many channels across the scan to be a track.
MIN_TRACK_CHANNELS = 5


# The points from this far to EDGE_WINDOW_KEV below and above an edge say
# whether a line turns on there. Kept local, so that another element's edge
# further along the scan does not count as a step at this one.
EDGE_GAP_BELOW_KEV, EDGE_GAP_ABOVE_KEV = 0.02, 0.05
EDGE_WINDOW_KEV = 0.15
EDGE_MIN_POINTS = 3
EDGE_LOCATION_TOLERANCE_KEV = 0.02
# A line that turns on at an edge at least doubles across it; a line merely
# modulated there (EXAFS of another element) does not.
TURN_ON_RATIO = 2.0


def max_compton_shift_kev(energy_kev: float) -> float:
    """How far below the elastic peak the Compton peak can sit: its shift at 180 degrees."""
    from .athena_xrf_xas import compton_center

    return energy_kev - compton_center(energy_kev, 180.0)


def line_energy_kev(symbol: str, family: str, line: str) -> float | None:
    """Intensity-weighted energy of a line group such as Ka or Lb, in keV."""
    import xraydb

    try:
        lines = xraydb.xray_lines(symbol)
    except (ValueError, KeyError):
        return None
    prefix = family + line
    chosen = [(entry.energy, entry.intensity) for name, entry in lines.items()
              if name.startswith(prefix) and entry.intensity > 0]
    if not chosen:
        return None
    energy, weight = np.array(chosen, dtype=float).T
    return float(np.sum(energy * weight) / np.sum(weight)) / 1000.0


def edge_kev(symbol: str, family: str) -> float | None:
    """The absorption edge that has to be crossed for a line family to be excited."""
    import xraydb

    try:
        return float(xraydb.xray_edge(symbol, FAMILY_EDGE[family]).energy) / 1000.0
    except (ValueError, KeyError, AttributeError, TypeError):
        return None


def crossed_edges(energy_kev: np.ndarray) -> list[tuple[str, str, float]]:
    """The K and L3 edges the scan crosses with points on both sides:
    (symbol, line family, edge energy in keV)."""
    import xraydb

    crossed = []
    for z in range(11, 93):
        symbol = xraydb.atomic_symbol(z)
        for family in ('K', 'L'):
            edge = edge_kev(symbol, family)
            if edge is None:
                continue
            below, above = edge_sides(energy_kev, edge)
            if np.count_nonzero(below) >= EDGE_MIN_POINTS and np.count_nonzero(above) >= EDGE_MIN_POINTS:
                crossed.append((symbol, family, edge))
    return crossed


def located_edge(energy_kev: np.ndarray, counts: np.ndarray, i0: np.ndarray | None) -> tuple[str, str, float] | None:
    """The edge where the scan's fluorescence jumps, named only when one
    element's K or L3 edge lies there.

    `counts` is each point's total over the detector, `i0` the incident flux
    where the file names it. The largest rise between neighbouring points
    brackets the edge, as finely as the scan samples it; an edge tabulated
    within 20 eV of that bracket (a monochromator off by that much, or a
    chemical shift) is the one. Two candidates, or none, name nothing: with
    sparse sampling, which onset is which cannot be told.
    """
    import xraydb

    order = np.argsort(energy_kev, kind='stable')
    energy = energy_kev[order]
    flux = counts[order] / (i0[order] if i0 is not None else 1.0)
    if energy.size < 2 * EDGE_MIN_POINTS or np.any(~np.isfinite(flux)) or np.any(flux <= 0):
        return None
    jump = int(np.argmax(np.diff(np.log(flux))))
    lo, hi = energy[jump] - EDGE_LOCATION_TOLERANCE_KEV, energy[jump + 1] + EDGE_LOCATION_TOLERANCE_KEV
    there = []
    for z in range(11, 93):
        symbol = xraydb.atomic_symbol(z)
        for family in ('K', 'L'):
            edge = edge_kev(symbol, family)
            if edge is not None and lo <= edge <= hi:
                there.append((symbol, family, edge))
    return there[0] if len(there) == 1 else None


def edge_sides(energy_kev: np.ndarray, edge: float) -> tuple[np.ndarray, np.ndarray]:
    """The points just below and just above an edge."""
    below = (energy_kev >= edge - EDGE_WINDOW_KEV) & (energy_kev < edge - EDGE_GAP_BELOW_KEV)
    above = (energy_kev > edge + EDGE_GAP_ABOVE_KEV) & (energy_kev <= edge + EDGE_WINDOW_KEV)
    return below, above


def _peak_centre(spectrum: np.ndarray, top: int) -> float:
    """A parabola through the top three channels places the peak between them."""
    if not 0 < top < spectrum.size - 1:
        return float(top)
    y0, y1, y2 = spectrum[top - 1:top + 2]
    curvature = y0 - 2 * y1 + y2
    return float(top + (0.5 * (y0 - y2) / curvature if curvature < 0 else 0.0))


def edge_lines(edge: tuple[str, str, float], below: tuple[np.ndarray, int], above: tuple[np.ndarray, int],
               clear: np.ndarray, provisional: dict, below_kev: float, clear_below_kev: float) -> list[dict]:
    """The lines of the element whose edge the scan crosses, where they peak.

    Every fluorescence XAS scan crosses its target's edge, and the target's
    main line turns on there: the mean spectrum just above the edge minus the
    one just below it peaks at that line, which the scatter cannot bias.
    `below` and `above` are each (summed spectrum, number of points), from
    `edge_sides`. `provisional` (from the scatter or the beamline's windows)
    says where to look, within the largest Compton shift. For a K edge,
    K-beta is then looked for in `clear`, the spectra at the highest incident
    energies, where the gain predicts it, and it too has to turn on at this
    edge, or it may be another element's line. Lines must lie below
    `below_kev` (main) and `clear_below_kev` (K-beta), clear of the scatter.
    Each line found carries `turn_on`, how many times it rose across the edge.
    """
    from scipy.signal import find_peaks

    symbol, family, energy = edge
    main = line_energy_kev(symbol, family, 'a')
    if main is None or main >= below_kev:
        return []
    (below_sum, n_below), (above_sum, n_above) = below, above
    smooth = lambda values: np.convolve(values, np.ones(3) / 3, mode='same')  # noqa: E731
    before, after = smooth(below_sum / n_below), smooth(above_sum / n_above)
    step = after - before
    noise = np.sqrt(smooth(below_sum / n_below ** 2 + above_sum / n_above ** 2) / 3)
    rise = after / np.maximum(before, 1.0 / max(n_below, 1))
    gain, offset = provisional['cal_slope'], provisional['cal_offset']
    reach = (max_compton_shift_kev(energy) + 0.1) / gain
    expected = (main - offset) / gain
    lo, hi = max(1, int(expected - reach)), min(step.size - 1, int(expected + reach) + 1)
    if hi - lo < 3:
        return []
    peaks, props = find_peaks(step[lo:hi], prominence=0)
    peaks = peaks + lo
    real = ((step[peaks] >= SIGNIFICANCE * noise[peaks]) & (props['prominences'] >= SIGNIFICANCE * noise[peaks])
            & (rise[peaks] >= TURN_ON_RATIO))
    if not real.any():
        return []
    top = int(peaks[real][np.argmax(step[peaks[real]])])
    centre = _peak_centre(step, top)
    found = [dict(line=f'{symbol} {family}a', energy_kev=main, channel=centre, via='edge', edge_kev=energy,
                  turn_on=float(rise[top]))]
    second = line_energy_kev(symbol, 'K', 'b') if family == 'K' else None
    if second is not None and second < clear_below_kev:
        spread = (second - main) / gain
        lo, hi = max(1, int(centre + 0.9 * spread - 3)), min(clear.size - 1, int(centre + 1.1 * spread + 3) + 1)
        if hi - lo >= 3:
            region = smooth(clear)
            peaks, props = find_peaks(region[lo:hi], prominence=0)
            peaks = peaks + lo
            real = (_significant(region[peaks], props['prominences']) & (region[peaks] > 0)
                    & (rise[peaks] >= TURN_ON_RATIO) & (step[peaks] >= SIGNIFICANCE * noise[peaks]))
            if real.any():
                top = int(peaks[real][np.argmax(region[peaks[real]])])
                found.append(dict(line=f'{symbol} Kb', energy_kev=second, channel=_peak_centre(clear, top),
                                  via='edge', edge_kev=energy, turn_on=float(rise[top])))
    return found


def _header_mca_numbers(header: str | None) -> dict[str, int]:
    if not header:
        return {}
    return {match['name']: int(match['mca']) for match in NAME_TO_MCA.finditer(header)}


def _significant(height: np.ndarray, prominence: np.ndarray, smoothing: int = 3) -> np.ndarray:
    """Which peaks stand clear of counting noise: their prominence above their
    valleys exceeds SIGNIFICANCE Poisson standard deviations of the counts
    summed into the smoothed channel."""
    noise = SIGNIFICANCE * np.sqrt(np.maximum(height, 1.0) / smoothing)
    return prominence >= noise


def _window_for(total_spectrum: np.ndarray, total: float, rows: np.ndarray, series: np.ndarray):
    """The channel window [lo, hi) whose sums reproduce a beamline ROI exactly.

    `total` is the ROI's sum over all points, which narrows the candidates to
    the windows of `total_spectrum` holding exactly that; each candidate is
    then checked at the sample points, whose spectra are `rows` and whose ROI
    values are `series`. Returns None when no window reproduces the ROI.
    """
    cumulative = np.concatenate([[0.0], np.cumsum(total_spectrum, dtype=float)])
    if not np.isfinite(total) or total <= 0:
        return None
    row_cumulative = np.concatenate([np.zeros((rows.shape[0], 1)), np.cumsum(rows, axis=1, dtype=float)],
                                    axis=1)
    found = []
    for lo in range(cumulative.size - 1):
        hi = int(np.searchsorted(cumulative, cumulative[lo] + total - 0.5, side='left'))
        if hi <= lo or hi >= cumulative.size or abs(cumulative[hi] - cumulative[lo] - total) > 0.5:
            continue
        # Equal totals can come from chance; the window has to hold the
        # ROI at every point checked, not only in sum.
        if np.all(np.abs(row_cumulative[:, hi] - row_cumulative[:, lo] - series) <= 0.5):
            found.append((lo, hi))
    if not found:
        return None
    # Empty channels at either end leave several windows with the same sums;
    # the narrowest is the one the beamline set around the line.
    return min(found, key=lambda pair: pair[1] - pair[0])


def line_peaks(spectra_by_element: dict[int, np.ndarray], sample_rows, scalars: dict,
               header: str | None, below_kev: float, excited_from_kev: float,
               clear_by_element: dict[int, np.ndarray] | None = None) -> dict[int, list[dict]]:
    """Per element, where the excited fluorescence lines actually peak.

    `spectra_by_element` holds each element's spectrum summed over all points
    (to recover the windows exactly), `sample_rows(index)` the points that
    confirm them, and `clear_by_element` the spectra summed over the highest
    incident energies, all at or above `excited_from_kev`, where the peaks are
    looked for. A line counts only if it lies below `below_kev`, under the
    scatter's sweep, its edge lies below `excited_from_kev`, so it is excited
    at every one of those points, and it peaks inside its window, clear of the
    window's edges and of counting noise. A window says where the beamline
    looked; only the peak says a line is there. A strong neighbour does not
    make a line less real, so a peak is judged against its own height.
    """
    from scipy.signal import find_peaks

    mca_numbers = _header_mca_numbers(header)
    found: dict[int, list[dict]] = {}
    for name, values in scalars.items():
        match = LINE_WINDOW.match(name)
        if match is None:
            continue
        energy = line_energy_kev(match['symbol'], match['family'], match['line'])
        edge = edge_kev(match['symbol'], match['family'])
        if energy is None or edge is None or energy >= below_kev or edge >= excited_from_kev:
            continue
        number = mca_numbers.get(name)
        element = (number - 1) if number is not None else int(match['index'])
        if element not in spectra_by_element:
            continue
        total = spectra_by_element[element]
        points, rows = sample_rows(element)
        series = np.asarray(values, dtype=float)
        window = _window_for(total, float(series.sum()), rows, series[points])
        if window is None:
            continue
        lo, hi = window
        width = hi - lo
        a, b = max(0, lo - width), min(total.size, hi + width)
        clear = (clear_by_element or {}).get(element, total)
        region = np.convolve(clear[a:b], np.ones(3) / 3, mode='same')
        peaks, props = find_peaks(region, prominence=0)
        heights, prominences = region[peaks], props['prominences']
        real = _significant(heights, prominences) & (prominences >= 0.05 * heights) & (heights > 0)
        keep = [(heights[i], peaks[i] + a) for i in np.flatnonzero(real) if lo < peaks[i] + a < hi - 1]
        if not keep:
            continue
        _, top = max(keep)
        found.setdefault(element, []).append(dict(
            line=f"{match['symbol']} {match['family']}{match['line']}", energy_kev=energy,
            channel=_peak_centre(clear, int(top)), window=[lo, hi], via='window'))
    return found


def from_elastic_peak(spectra: np.ndarray, incident_kev: np.ndarray) -> dict | None:
    """The calibration that follows the elastic peak across the scan.

    `spectra` is (points, channels) for one element at the chosen points and
    `incident_kev` their incident energies. Returns None when no peak can be
    followed consistently.

    For a trial slope, every significant peak at every point implies an
    offset, E - slope * channel. A peak that moves with the incident energy at
    that slope gives the same offset from point to point; a stationary
    fluorescence line's offsets drift with E and noise does not survive the
    significance test. Every track crossing enough of the scan is a candidate.

    Which track is the elastic peak rests on two facts. Pile-up of two
    scattered photons sits at twice the incident energy and so moves at half
    the gain: the scatter is the well-supported family of tracks with the
    largest gain. Within it the elastic and Compton peaks run nearly parallel,
    the elastic above, by no more than the Compton shift at 180 degrees; the
    elastic is often resolved only at the high-energy end, where that shift
    is largest, and so may be followed over fewer points. So the elastic is
    the upper track of the best-supported pair that close together; a track
    further from any other is no partner of a scatter peak.

    `resolved` says whether such a pair was seen. When it was not, the
    best-supported track is taken, and it may be an unresolved blend, or
    Compton alone: lines then sit low by up to the Compton shift.
    """
    from scipy.signal import find_peaks

    energies, peaks = [], []
    for spectrum, energy in zip(spectra, incident_kev):
        smooth = np.convolve(np.asarray(spectrum, dtype=float), np.ones(3) / 3, mode='same')
        top = smooth.max()
        if not np.isfinite(top) or top <= 0:
            continue
        found, props = find_peaks(smooth, prominence=0.002 * top)
        found = found[_significant(smooth[found], props['prominences'])]
        if found.size:
            energies.append(float(energy))
            peaks.append(found.astype(float))
    if len(peaks) < ELASTIC_MIN_POINTS:
        return None
    energies = np.array(energies)
    if np.ptp(energies) <= 0:
        return None
    point_of = np.concatenate([np.full(p.size, i) for i, p in enumerate(peaks)])
    channel = np.concatenate(peaks)
    energy = energies[point_of]
    candidates = []
    for slope in np.geomspace(*SLOPE_BOUNDS_KEV, 400):
        offsets = energy - slope * channel
        usable = np.flatnonzero(np.abs(offsets) <= OFFSET_BOUND_KEV)
        if usable.size < ELASTIC_MIN_POINTS:
            continue
        width = 2.5 * slope
        for phase in (0.0, 0.5):  # two bin phases, so a track on a bin edge is not split
            bins = np.floor((offsets[usable] + OFFSET_BOUND_KEV) / width + phase).astype(int)
            values, counts = np.unique(bins, return_counts=True)
            for value in values[counts >= ELASTIC_MIN_POINTS]:
                members = usable[bins == value]
                support = np.unique(point_of[members])
                if support.size < max(ELASTIC_MIN_POINTS, 0.25 * len(peaks)):
                    continue
                if np.ptp(energies[support]) < 0.4 * np.ptp(energies):
                    continue
                candidates.append((support.size, slope, float(np.median(offsets[members]))))
    if not candidates:
        return None
    middle = float(np.median(energies))
    channel_at_middle = lambda row: (middle - row[2]) / row[1]  # noqa: E731
    most = max(row[0] for row in candidates)
    gain = max(row[1] for row in candidates if row[0] >= 0.5 * most)
    family = sorted((row for row in candidates if abs(row[1] / gain - 1) <= 0.2), key=channel_at_middle)
    # One track turns up at neighbouring trial slopes and bin phases: rows a
    # few channels apart at the middle of the scan are the same track.
    tracks: list[list[tuple]] = []
    for row in family:
        if tracks and channel_at_middle(row) - channel_at_middle(tracks[-1][-1]) <= 2.5:
            tracks[-1].append(row)
        else:
            tracks.append([row])
    best = [max(track, key=lambda row: row[0]) for track in tracks]
    reach = max_compton_shift_kev(middle) + 2.5 * gain
    pairs = [(low, high) for i, low in enumerate(best) for high in best[i + 1:]
             if (channel_at_middle(high) - channel_at_middle(low)) * gain <= reach]
    if pairs:
        _, slope, centre = max(pairs, key=lambda pair: pair[0][0] + pair[1][0])[1]
    else:
        _, slope, centre = max(best, key=lambda row: row[0])
    def along(slope, centre):
        """The peaks on a track, one per point: the closest within 2.5 channels."""
        chosen = {}
        for index in np.flatnonzero(np.abs(energy - slope * channel - centre) <= 2.5 * slope):
            distance = abs(energy[index] - slope * channel[index] - centre)
            if point_of[index] not in chosen or distance < chosen[point_of[index]][0]:
                chosen[point_of[index]] = (distance, index)
        return sorted(index for _, index in chosen.values())

    # The vote fixes where the track runs better than its slope: rows a few
    # per cent apart in slope cross the same peaks. A robust line through the
    # peaks found, gathered again along it, settles it. Robust, because where
    # the track crosses a fluorescence line the stationary line is gathered
    # instead, at several closely spaced points near the edge.
    from scipy.stats import theilslopes

    rows = along(slope, centre)
    for _ in range(5):
        if len(rows) < ELASTIC_MIN_POINTS or np.ptp(energy[rows]) < 0.4 * np.ptp(energies):
            return None
        fit_slope, fit_intercept, _, _ = theilslopes(channel[rows], energy[rows])
        if fit_slope <= 0 or fit_slope * np.ptp(energy[rows]) < MIN_TRACK_CHANNELS:
            return None
        again = along(1.0 / fit_slope, -fit_intercept / fit_slope)
        if again == rows:
            break
        rows = again
    return dict(cal_offset=float(-fit_intercept / fit_slope), cal_slope=float(1.0 / fit_slope),
                source='elastic_peak', points=len(rows), resolved=bool(pairs),
                track=dict(energy_kev=energy[rows].tolist(), channel=channel[rows].tolist()))


def joint(lines: list[dict], elastic: dict | None) -> dict | None:
    """One calibration from the excited lines and the elastic track.

    Two lines far enough apart decide alone: their energies are tabulated,
    while the elastic track can be pulled by an unresolved Compton peak. One
    line anchors the offset and the elastic track supplies the slope, the two
    weighted to count equally.
    """
    separated = len(lines) >= 2 and (max(row['energy_kev'] for row in lines)
                                     - min(row['energy_kev'] for row in lines)) >= MIN_LINE_SEPARATION_KEV
    track = (elastic or {}).get('track') or {} if not separated else {}
    n_track = len(track.get('energy_kev', []))
    if n_track == 0 and not separated:
        return None
    if lines and n_track and not elastic.get('resolved', True):
        return _anchored(lines, elastic)
    energies = [row['energy_kev'] for row in lines] + list(track.get('energy_kev', []))
    channels = [row['channel'] for row in lines] + list(track.get('channel', []))
    weights = [max(n_track, 1) / max(len(lines), 1)] * len(lines) + [1.0] * n_track
    energies, channels, weights = map(np.asarray, (energies, channels, weights))
    slope, offset = np.polyfit(channels, energies, 1, w=np.sqrt(weights))
    if slope <= 0:
        return None
    residual = energies - (offset + slope * channels)
    worst = float(np.max(np.abs(residual)))
    if worst > max(0.1, 3 * slope):
        if lines and n_track:
            # The followed peak was not the elastic one, or a line was misnamed.
            # Lines that agree with each other are the surer of the two.
            return joint(lines, None) if len(lines) >= 2 else None
        return None
    source = 'lines_and_elastic' if lines and n_track else 'elastic_peak' if n_track else 'lines'
    return dict(cal_offset=float(offset), cal_slope=float(slope), source=source,
                lines=lines, elastic_points=n_track, worst_residual_kev=worst,
                **({'scatter_resolved': bool(elastic.get('resolved'))} if n_track else {}))


def _anchored(lines: list[dict], elastic: dict) -> dict | None:
    """Lines and a lone scatter peak. The peak followed may be Compton, or a
    blend of Compton and elastic, anywhere from the incident energy down to
    the Compton shift below it: it gives the gain, and the lines place it.
    A track outside that band is no scatter peak these lines agree with."""
    slope = elastic['cal_slope']
    offset = float(np.mean([row['energy_kev'] - slope * row['channel'] for row in lines]))
    energies, channels = (np.asarray(elastic['track'][key]) for key in ('energy_kev', 'channel'))
    below = energies - (offset + slope * channels)
    reach = np.array([max_compton_shift_kev(float(energy)) for energy in energies])
    if below.min() < -3 * slope or np.any(below > reach + 3 * slope):
        return None
    return dict(cal_offset=offset, cal_slope=float(slope), source='lines_and_elastic', lines=lines,
                elastic_points=int(energies.size), scatter_resolved=False,
                scatter_below_kev=[float(below.min()), float(below.max())])


def plausible(calibration: dict) -> bool:
    """Inside the bounds the fit allows. The detector need not reach the
    incident energy: lines below it calibrate it as well."""
    offset, slope = calibration['cal_offset'], calibration['cal_slope']
    return abs(offset) <= OFFSET_BOUND_KEV and SLOPE_BOUNDS_KEV[0] < slope <= SLOPE_BOUNDS_KEV[1]


def summarise(per_element: dict[int, dict], elements: int, reason: str | None = None) -> dict:
    """One starting calibration for the windows, and the per-element values."""
    if not per_element:
        return dict(cal_offset=DEFAULT_OFFSET_KEV, cal_slope=DEFAULT_SLOPE_KEV, source='default',
                    elements={}, **({'reason': reason} if reason else {}))
    # An element read from one scatter peak alone may have followed Compton.
    # Whenever any element has more to go on, the median is theirs alone, so
    # such an element cannot become the median; when none has, it says so.
    sure = {index: row for index, row in per_element.items()
            if not (row['source'] == 'elastic_peak' and not row.get('scatter_resolved'))}
    used = sure or per_element
    offsets = np.array([row['cal_offset'] for row in used.values()])
    slopes = np.array([row['cal_slope'] for row in used.values()])
    sources = {row['source'] for row in used.values()}
    order = ('lines_and_elastic', 'lines', 'elastic_peak')
    source = next(name for name in order if name in sources)
    caution = {} if sure else {'caution': 'one scatter peak'}
    return dict(cal_offset=float(np.median(offsets)), cal_slope=float(np.median(slopes)),
                source=source, **caution,
                found_for=len(used), of=elements,
                slope_spread=float(np.ptp(slopes) / np.median(slopes)) if slopes.size > 1 else 0.0,
                elements={str(index): row for index, row in sorted(per_element.items())})


SOURCE_WORDS = {
    'lines_and_elastic': 'fluorescence lines of known energy and the scatter peak',
    'lines': 'fluorescence lines of known energy',
    'elastic_peak': 'the elastic peak followed across the scan',
    'default': 'no calibration the file holds',
}


def describe(calibration: dict) -> str:
    return (f"{calibration['cal_offset']:.3f} keV + {calibration['cal_slope'] * 1000:.2f} eV per channel, "
            f"from {SOURCE_WORDS[calibration['source']]}")


def _element_reader(handle, detector):
    """(points, elements, channels), a reader of one element's spectra over a
    range of points in file order, and the 20-BM header, for either layout."""
    from .athena_xrf_xas import TWENTY_BM_DETECTOR, _entry, _twenty_bm, _twenty_bm_shape

    twenty = _twenty_bm(handle)
    if twenty is not None:
        if detector != TWENTY_BM_DETECTOR:
            return None
        scan, names = twenty
        shape = _twenty_bm_shape(scan, names)
        return shape, (lambda index, a, b: np.asarray(scan[names[index]][0, a:b, :], dtype=float)), \
            scan.attrs.get('Header')
    group = _entry(handle)['data']
    if detector not in group or group[detector].ndim != 3:
        return None
    dataset = group[detector]
    return (tuple(int(n) for n in dataset.shape),
            (lambda index, a, b: np.asarray(dataset[a:b, index, :], dtype=float)), None)


def infer(data: bytes, scan: dict, detector: str) -> dict:
    """The starting calibration a scan file implies for one of its detectors.

    `scan` is what `read_scan` returned for the same bytes. Its energies and
    scalar channels are in ascending energy, which may not be the file's
    order, so they are mapped back to the file's order before they are paired
    with spectra read from it. Each element is read CHUNK_POINTS points at a
    time, keeping only its running sums and the few rows used for checks.
    Never raises for a file `read_scan` accepted: a calibration it cannot
    read is reported as the default, with the reason.
    """
    import io

    import h5py

    try:
        with h5py.File(io.BytesIO(data), 'r') as handle:
            reader = _element_reader(handle, detector)
            if reader is None:
                return summarise({}, 0, 'the detector is not in the file')
            (points, elements, channels), read, header = reader
            if isinstance(header, bytes):
                header = header.decode('utf-8', 'replace')
            order = np.asarray(scan.get('order', np.arange(points)))
            if order.size != points:
                return summarise({}, elements, 'the scan and its detector disagree in length')
            # read_scan sorted the points by energy: sorted[i] is file[order[i]].
            energy_kev = np.empty(points)
            energy_kev[order] = np.asarray(scan['energy_ev'], dtype=float)[:points] / 1000.0
            scalars = {}
            for name, values in (scan.get('channels') or {}).items():
                if LINE_WINDOW.match(name) and np.size(values) == points:
                    in_file = np.empty(points)
                    in_file[order] = np.asarray(values, dtype=float)
                    scalars[name] = in_file
            check = np.unique(np.linspace(0, points - 1, min(points, 24)).round().astype(int))
            by_energy = np.argsort(energy_kev, kind='stable')
            follow = np.sort(by_energy[np.unique(np.linspace(0, points - 1, min(points, ELASTIC_POINTS))
                                                .round().astype(int))])
            highest = energy_kev >= np.quantile(energy_kev, 2 / 3)
            excited_from = float(energy_kev[highest].min())
            edges = crossed_edges(energy_kev)
            sides = [edge_sides(energy_kev, edge) for _, _, edge in edges]
            point_counts = np.zeros(points)
            totals, clear, samples, elastic, across = {}, {}, {}, {}, {}
            for index in range(elements):
                total = np.zeros(channels)
                high = np.zeros(channels)
                step_sums = np.zeros((len(edges), 2, channels))
                rows_check, rows_follow = [], []
                for start in range(0, points, CHUNK_POINTS):
                    stop = min(points, start + CHUNK_POINTS)
                    block = read(index, start, stop)
                    if block.shape != (stop - start, channels) or not np.isfinite(block).all():
                        total = None
                        break
                    total += block.sum(axis=0)
                    high += block[highest[start:stop]].sum(axis=0)
                    point_counts[start:stop] += block.sum(axis=1)
                    for k, (under, over) in enumerate(sides):
                        step_sums[k, 0] += block[under[start:stop]].sum(axis=0)
                        step_sums[k, 1] += block[over[start:stop]].sum(axis=0)
                    rows_check.append(block[check[(check >= start) & (check < stop)] - start])
                    rows_follow.append(block[follow[(follow >= start) & (follow < stop)] - start])
                if total is None:
                    continue
                totals[index], clear[index], across[index] = total, high, step_sums
                samples[index] = np.concatenate(rows_check)
                elastic[index] = np.concatenate(rows_follow)
            lines = (line_peaks(totals, lambda index: (check, samples[index]), scalars, header,
                                below_kev=float(energy_kev.min()) - SCATTER_MARGIN_KEV,
                                excited_from_kev=excited_from, clear_by_element=clear)
                     if scalars else {})
            below_kev = float(energy_kev.min()) - SCATTER_MARGIN_KEV
            clear_below_kev = excited_from - max_compton_shift_kev(excited_from) - SCATTER_MARGIN_KEV
            # Only the edge the fluorescence is seen to jump at, and only when
            # one element's edge is there.
            from .athena_xrf_xas import suggest_i0

            flux = None
            monitor = suggest_i0(sorted(name for name, values in (scan.get('channels') or {}).items()
                                        if np.size(values) == points and np.all(np.asarray(values) > 0)))
            if monitor is not None:
                flux = np.empty(points)
                flux[order] = np.asarray(scan['channels'][monitor], dtype=float)
            jumped = located_edge(energy_kev, point_counts, flux)
            at = [k for k, edge in enumerate(edges) if jumped is not None and edge[:2] == jumped[:2]]
            per_element: dict[int, dict] = {}
            refused: list[dict] = []
            for index in totals:
                named = lines.get(index, [])
                track = from_elastic_peak(elastic[index], energy_kev[follow])
                found = joint(named, track)
                if found is not None and plausible(found):
                    # The lines of the element whose edge the scan crosses,
                    # looked for where this first reading puts them.
                    known = {row['line'] for row in named}
                    extra = []
                    for k in at:
                        edge = edges[k]
                        counts = [int(np.count_nonzero(side)) for side in sides[k]]
                        extra += [row for row in edge_lines(edge, (across[index][k, 0], counts[0]),
                                                            (across[index][k, 1], counts[1]), clear[index],
                                                            found, below_kev, clear_below_kev)
                                  if row['line'] not in known]
                    # joint() refuses lines that disagree with a resolved
                    # scatter pair, or with each other, beyond its tolerance.
                    better = joint(named + extra, track) if extra else None
                    if better is not None and plausible(better):
                        found = better
                if found is not None and plausible(found):
                    per_element[index] = found
                elif found is not None:
                    refused.append(found)
            if per_element:
                return summarise(per_element, elements)
            if refused:
                return summarise({}, elements, f'what was read, {describe(refused[0])}, is outside the '
                                               'range the fit allows')
            return summarise({}, elements, 'no line peaked in a beamline window and no elastic peak '
                                           'could be followed across the scan')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        # A file read_scan accepted still gets an answer, the default, and the
        # result says why; the full error goes to the log.
        import logging
        logging.getLogger(__name__).warning('Starting calibration not read from %s: %r', detector, exc)
        return summarise({}, 0, f'the file could not be read for it ({type(exc).__name__})')


def infer_detectors(data: bytes, scan: dict, names) -> dict[str, dict]:
    """`infer` for each detector name. Names linked to one dataset in the file
    are read once, as are the reads behind them."""
    import io

    import h5py

    from .athena_xrf_xas import _entry

    names = sorted(names)
    same_as = {name: name for name in names}
    try:
        with h5py.File(io.BytesIO(data), 'r') as handle:
            group = _entry(handle)['data']
            seen: list[tuple[str, object]] = []
            for name in names:
                if isinstance(group.get(name), h5py.Dataset):
                    ident = group[name].id
                    first = next((other for other, other_id in seen if other_id == ident), None)
                    if first is None:
                        seen.append((name, ident))
                    else:
                        same_as[name] = first
    except (OSError, ValueError, KeyError, TypeError):
        pass  # Not that layout (20-BM keeps one detector), or unreadable: infer says why.
    found: dict[str, dict] = {}
    for name in names:
        found[name] = found[same_as[name]] if same_as[name] in found else infer(data, scan, name)
    return found


def compact(calibration: dict) -> dict:
    """What is kept with an upload and a result: the values and where they came
    from, per element, without the followed peak's points."""
    elements = {index: {key: value for key, value in row.items() if key != 'track'}
                for index, row in calibration.get('elements', {}).items()}
    return {**{key: value for key, value in calibration.items() if key != 'elements'}, 'elements': elements}


def apply(options, inferred: dict, line_kev: float | None):
    """The options with an empty starting calibration filled from the file, and
    what the panel should be told about it.

    Returns (options, record, notes). A calibration typed into the request is
    kept; if the file's own calibration puts the target line somewhere else,
    a note says so.
    """
    automatic = [key for key in ('cal_offset', 'cal_slope') if getattr(options, key) is None]
    notes: list[str] = []
    if automatic:
        options = options.model_copy(update={key: inferred[key] for key in automatic})
        if inferred['source'] == 'default':
            reason = inferred.get('reason')
            notes.append('No energy calibration could be read from this file'
                         + (f' ({reason})' if reason else '') + '. The windows use 10 eV per channel as a guess. '
                         'Check where the target line sits in the raw spectra and enter the detector calibration '
                         'if it is not where the fit window expects it.')
    elif inferred['source'] != 'default' and line_kev is not None:
        entered = (line_kev - options.cal_offset) / options.cal_slope
        read = (line_kev - inferred['cal_offset']) / inferred['cal_slope']
        if abs(entered - read) > max(5.0, 0.1 * abs(read)):
            notes.append(f'The entered calibration ({options.cal_offset:.3f} keV + '
                         f'{options.cal_slope * 1000:.2f} eV per channel) puts the target line at channel '
                         f'{entered:.0f}, but {SOURCE_WORDS[inferred["source"]]} put it at channel {read:.0f} '
                         f'({describe(inferred)}). Leave the calibration empty to use the file\'s.')
    record = dict(compact(inferred), automatic=automatic,
                  applied=dict(cal_offset=options.cal_offset, cal_slope=options.cal_slope))
    return options, record, notes
