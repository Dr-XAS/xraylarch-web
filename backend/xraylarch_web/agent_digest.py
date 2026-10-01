"""A description of one spectrum for a caller that cannot look at the plot.

`agent_views` only reads stored values. This module also measures, so it lives
apart. It answers the questions a scientist would answer at a glance — where is
the edge, did Larch use the ranges that were asked for, how noisy is it, where
are the peaks in R — for a caller with no screen.

Everything measured here is either delegated to the native routine that already
implements it (`athena_context.measurement_uncertainty` and `noise_floor` both
wrap Demeter's chi_noise; `athena_science.normalization_adjustments` reports
Larch's clipping) or is a plain descriptive statistic over an array the last
processing run already produced. Nothing is refitted and nothing is persisted.
"""
from __future__ import annotations

import numpy as np

from .athena_science import ScientificError, normalization_adjustments
from .agent_views import group_summary

# Beyond this radius |chi(R)| is dominated by noise rather than by shells.
_MAX_PEAK_R = 6.0
_MAX_PEAKS = 6

# Signal-to-noise is binned two inverse angstroms at a time: fine enough to
# place the k where chi stops being signal within a couple of wavenumbers, and
# coarse enough that a whole scan fits on one line. A support wide enough to
# need more bins than this gets wider bins rather than more of them.
_SNR_BIN = 2.0
_MAX_SNR_BINS = 12
_MIN_BIN_POINTS = 3


def _pairs(effective, requested, *names):
    """Requested against used, for the range parameters Larch may clip."""
    return {
        name: {"requested": requested.get(name), "used": effective.get(name)}
        for name in names
    }


def _sampling(group) -> dict:
    """Grid spacing, which distinguishes a raw scan from a rebinned one."""
    axis = np.asarray(group["energy"], dtype=float)
    if axis.size < 2:
        return {"points": int(axis.size), "step": None}
    steps = np.diff(axis)
    return {
        "points": int(axis.size),
        "step": {
            "min": float(steps.min()),
            "median": float(np.median(steps)),
            "max": float(steps.max()),
        },
        "uniform": bool(np.ptp(steps) <= 1e-9 * max(1.0, abs(float(np.median(steps))))),
    }


def _chir_peaks(arrays) -> list[dict]:
    """Local maxima of |chi(R)|, strongest first.

    These are peak positions in the transform, NOT interatomic distances: no
    phase correction is applied, so each sits roughly 0.2-0.5 A below the true
    shell distance. Reported so a caller can compare spectra and spot missing
    or extra structure, not so it can quote a bond length.
    """
    r = np.asarray(arrays.get("r") or [], dtype=float)
    magnitude = np.asarray(arrays.get("chir_mag") or [], dtype=float)
    if r.size < 3 or r.size != magnitude.size:
        return []
    inside = r <= _MAX_PEAK_R
    r, magnitude = r[inside], magnitude[inside]
    if r.size < 3 or not np.isfinite(magnitude).all():
        return []
    interior = np.arange(1, magnitude.size - 1)
    rising = magnitude[interior] > magnitude[interior - 1]
    falling = magnitude[interior] > magnitude[interior + 1]
    found = interior[rising & falling]
    if not found.size:
        return []
    # A peak below a fortieth of the tallest is transform ripple, not a shell.
    floor = magnitude[found].max() / 40.0
    found = found[magnitude[found] >= floor]
    order = found[np.argsort(magnitude[found])[::-1]][:_MAX_PEAKS]
    return [
        {"r": round(float(r[index]), 3), "magnitude": round(float(magnitude[index]), 4)}
        for index in order
    ]


def _signal_to_noise(group, arrays) -> dict:
    """rms chi(k) per k window, against a floor the transform range cannot move.

    This is the number a plot is normally used to eyeball: chi(k) is signal
    while it stands above the noise and is noise after that, and the whole
    decision about where to put kmax turns on which window that happens in.
    The digest's other noise figure cannot answer it, because Larch measures
    it over the current transform range and it therefore moves whenever the
    range a caller is trying to choose moves. `noise_floor` takes the same
    estimator over the full measured support instead, so these ratios stay
    put while kmax is being chosen.

    Windows are plain rms of chi, not of k-weighted chi, because the floor is
    in chi units and a ratio between different units would mean nothing.
    """
    from .athena_context import noise_floor

    k = np.asarray(arrays.get("k") or [], dtype=float)
    chi = np.asarray(arrays.get("chi") or [], dtype=float)
    if k.size < 2 or k.size != chi.size or not np.isfinite(chi).all():
        return {"unavailable": "This group has no usable chi(k) to bin."}
    try:
        floor = noise_floor(group)
    except (ScientificError, ValueError, KeyError, IndexError) as exc:
        return {"unavailable": str(exc)}

    start, stop, epsilon = floor["kmin"], floor["kmax"], floor["epsilon_k"]
    width = _SNR_BIN
    while (stop - start) / width > _MAX_SNR_BINS:
        width += _SNR_BIN
    edges = list(np.arange(start, stop, width))
    # A final sliver of a window holds few enough points that its rms says more
    # about where the scan stopped than about the noise there, and a sliver that
    # happens to read high reverses the trend the table exists to show. Fold it
    # into the window before it instead.
    if len(edges) > 1 and stop - edges[-1] < width / 2:
        edges.pop()
    bins = []
    for index, lower in enumerate(edges):
        # The last window runs to the end of the support and is the only one
        # to keep its right-hand endpoint, so no point is counted twice.
        last = index == len(edges) - 1
        upper = stop if last else float(lower) + width
        inside = (k >= lower) & ((k <= upper) if last else (k < upper))
        if int(inside.sum()) < _MIN_BIN_POINTS:
            continue
        rms = float(np.sqrt(np.mean(chi[inside] ** 2)))
        bins.append({"k": [round(float(lower), 2), round(upper, 2)],
                     "rms_chi": float(f"{rms:.4g}"),
                     "ratio": round(rms / epsilon, 1)})
    if not bins:
        return {"unavailable": "The measured k support is too short to bin."}
    return {
        "epsilon_k": epsilon,
        "over": [round(start, 2), round(stop, 2)],
        "bins": bins,
        "note": "rms chi(k) per k window over a noise floor measured across the "
                "whole k support, so the ratio does not move when the transform "
                "range does. A window whose ratio is near 1 is noise; put kmax "
                "below where that starts.",
    }


def group_digest(group: dict) -> dict:
    """Describe one group without returning any of its arrays."""
    result = group.get("result") or {}
    effective = result.get("effective") or {}
    requested = group["parameters"]
    arrays = result.get("arrays") or {}

    digest = {
        "group": group_summary(group),
        "sampling": _sampling(group),
        "warnings": result.get("warnings") or [],
    }
    if group["processing_error"] or not result:
        digest["unavailable"] = (
            group["processing_error"] or "This group has not been processed yet."
        )
        return digest

    if effective.get("e0") is not None:
        digest["normalization"] = {
            **_pairs(effective, requested, "pre1", "pre2", "norm1", "norm2", "nnorm"),
            "adjustments": normalization_adjustments(requested, effective),
            "flattened": effective.get("flatten"),
        }
    if effective.get("exafs"):
        digest["background"] = _pairs(
            effective, requested, "rbkg", "bkg_kmin", "bkg_kmax", "bkg_kweight", "nclamp")
        digest["transform"] = {
            **_pairs(effective, requested, "kmin", "kmax", "kweight", "dk", "window",
                     "rmin", "rmax", "dr", "rwindow"),
            "available_kmax": effective.get("available_kmax"),
        }
        digest["chir_peaks"] = _chir_peaks(arrays)
        digest["chir_peaks_note"] = (
            "Transform peak positions without phase correction; each lies below "
            "the true shell distance. Not bond lengths."
        )
        digest["noise"] = _noise(group)
        digest["signal_to_noise"] = _signal_to_noise(group, arrays)
    return digest


def _noise(group) -> dict:
    """Demeter's chi_noise estimate, or why it could not be taken."""
    from .athena_context import measurement_uncertainty

    try:
        return measurement_uncertainty(group)
    except (ScientificError, ValueError, KeyError, IndexError) as exc:
        return {"unavailable": str(exc)}
