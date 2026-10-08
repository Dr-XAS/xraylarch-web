"""Several groups measured against the first, in numbers rather than overlays.

"Are these comparable?" is answered in the browser by overlaying the curves.
Without a plot, both blind arms that were asked it exported every group to CSV
and rebuilt the overlay in numpy: the edge offset, the XANES difference, the
chi(k) amplitude per window. This does that arithmetic once, on the arrays the
app already holds, and returns only the numbers.

Nothing here writes. The shift comes from the same fit `align` runs, but
reading it does not move anything, so a linked reference family that `align`
would refuse to move can still be measured.
"""
from __future__ import annotations

import numpy as np

from .athena_science import ScientificError
from .agent_views import group_summary

# The window around the reference E0 that the XANES difference is taken over,
# the same [E0 - 20, E0 + 50) that the alignment fit uses.
_EDGE_BELOW, _EDGE_ABOVE = 20.0, 50.0
_K_BIN = 2.0
_MIN_BIN_POINTS = 3

NOTE = (
    "Each row is measured against the first group. energy_shift is the shift "
    "align would fit now, relative to the group's current shift; it is read, "
    "not applied. xanes_max_difference is max |norm - reference norm| over the "
    "reference E0 -20 to +50 eV on the current axes, so an unaligned pair reads "
    "high. chi_amplitude is rms(k^kweight chi) of the group over the "
    "reference's, per k window over the support both share, at the reference's "
    "kweight; below 1 is weaker oscillation. same_data_as names every group in "
    "the project, selected or not, whose raw energy and mu arrays are identical "
    "to this one's: the same measurement under two labels."
)


def _fingerprint(group) -> str | None:
    from .athena_alignment import signature

    # A chi group keeps k in the energy slot, so its arrays are not a scan.
    return None if group["data_type"] == "chi" else signature(group)


def _arrays(group) -> dict:
    return (group.get("result") or {}).get("arrays") or {}


def _absorption(group) -> bool:
    return group["data_type"] not in ("chi", "detector") and not group.get("is_difference")


def _overlap(lower: list[float] | None, upper: list[float] | None) -> list[float] | None:
    if not lower or not upper:
        return None
    start, stop = max(lower[0], upper[0]), min(lower[1], upper[1])
    return [round(start, 3), round(stop, 3)] if start < stop else None


def _shift(group, reference, preferences) -> dict:
    from .athena_alignment import fit_alignment

    try:
        fit = fit_alignment(group, reference, smoothed=True, **preferences)
    except (ScientificError, ValueError, KeyError) as exc:
        return {"unavailable": str(exc)}
    summary = fit["summary"]
    return {
        "value": round(summary["fitted_shift"] - group["parameters"]["energy_shift"], 3),
        "stderr": summary["native_shift_stderr"],
    }


def _xanes(group, reference) -> float | None:
    mine, theirs = _arrays(group), _arrays(reference)
    e0 = ((reference.get("result") or {}).get("effective") or {}).get("e0")
    x, y = np.asarray(mine.get("energy") or [], float), np.asarray(mine.get("norm") or [], float)
    rx, ry = np.asarray(theirs.get("energy") or [], float), np.asarray(theirs.get("norm") or [], float)
    if e0 is None or x.size < 2 or rx.size < 2 or x.size != y.size or rx.size != ry.size:
        return None
    start, stop = max(e0 - _EDGE_BELOW, x[0], rx[0]), min(e0 + _EDGE_ABOVE, x[-1], rx[-1])
    inside = (rx >= start) & (rx < stop)
    if int(inside.sum()) < _MIN_BIN_POINTS:
        return None
    grid = rx[inside]
    return round(float(np.max(np.abs(np.interp(grid, x, y) - ry[inside]))), 4)


def _chi_amplitude(group, reference) -> dict | None:
    mine, theirs = _arrays(group), _arrays(reference)
    k, chi = np.asarray(mine.get("k") or [], float), np.asarray(mine.get("chi") or [], float)
    rk, rchi = np.asarray(theirs.get("k") or [], float), np.asarray(theirs.get("chi") or [], float)
    if k.size < 2 or rk.size < 2 or k.size != chi.size or rk.size != rchi.size:
        return None
    effective = (reference.get("result") or {}).get("effective") or {}
    saved_weight = effective.get("kweight")
    kweight = float(2.0 if saved_weight is None else saved_weight)
    start = float(effective.get("kmin") or 0.0)
    stop = min(float(k[-1]), float(rk[-1]))
    on_grid = np.interp(rk, k, chi)
    edges = [float(lower) for lower in np.arange(start, stop, _K_BIN)]
    # A sliver of a window at the end of the support says more about where the
    # scan stopped than about its amplitude; fold it into the window before.
    if len(edges) > 1 and stop - edges[-1] < _K_BIN / 2:
        edges.pop()
    bins = []
    for index, lower in enumerate(edges):
        upper = stop if index == len(edges) - 1 else lower + _K_BIN
        inside = (rk >= lower) & ((rk <= upper) if upper == stop else (rk < upper))
        if int(inside.sum()) < _MIN_BIN_POINTS:
            continue
        weight = rk[inside] ** kweight
        theirs_rms = float(np.sqrt(np.mean((rchi[inside] * weight) ** 2)))
        mine_rms = float(np.sqrt(np.mean((on_grid[inside] * weight) ** 2)))
        if theirs_rms <= 0:
            continue
        bins.append({"k": [round(lower, 2), round(upper, 2)], "ratio": round(mine_rms / theirs_rms, 3)})
    return {"kweight": kweight, "bins": bins} if bins else None


def compare(groups: list[dict], preferences: dict, project_groups: list[dict] | None = None) -> dict:
    """Every group after the first, measured against the first.

    same_data_as looks across project_groups when given, not only the
    selection: the duplicate worth knowing about is usually the one not asked
    about, such as a reference channel that is a copy of a sample scan.
    """
    reference, rest = groups[0], groups[1:]
    summaries = {group["id"]: group_summary(group) for group in groups}
    base = summaries[reference["id"]]
    pool = {group["id"]: group for group in [*groups, *(project_groups or ())]}
    prints = {ident: _fingerprint(group) for ident, group in pool.items()}
    rows = []
    for group in rest:
        mine = summaries[group["id"]]
        row = {
            "id": group["id"],
            "label": group["label"],
            "file": mine["file"],
            "same_data_as": [other["label"] for other in pool.values() if other["id"] != group["id"]
                             and prints[group["id"]] is not None
                             and prints[other["id"]] == prints[group["id"]]],
            "points": mine["points"],
            "range": mine["range"],
            "common_range": _overlap(base["range"], mine["range"]) if mine["axis"] == base["axis"] else None,
            "available_kmax": mine["available_kmax"],
        }
        if _absorption(group) and _absorption(reference):
            if base["e0"] is not None and mine["e0"] is not None:
                row["e0_difference"] = round(mine["e0"] - base["e0"], 3)
            if base["edge_step"] and mine["edge_step"]:
                row["edge_step_ratio"] = round(mine["edge_step"] / base["edge_step"], 4)
            row["energy_shift"] = _shift(group, reference, preferences)
            row["xanes_max_difference"] = _xanes(group, reference)
        if base["exafs"] and mine["exafs"]:
            row["chi_amplitude"] = _chi_amplitude(group, reference)
        rows.append(row)
    return {
        "reference": {key: base[key] for key in
                      ("id", "label", "file", "points", "range", "e0", "edge_step", "available_kmax")},
        "groups": rows,
        "note": NOTE,
    }


AGREEMENT_NOTE = (
    "How far apart the members of this merge are, as fractions of the merged "
    "curve's range (max - min): scatter_to_range is the median of the merge's "
    "stddev, and each member's rms_to_range is the rms of that member minus the "
    "merge. A member far above the others is the one that does not belong. On "
    "array 'mu' a difference in absolute mu between scans counts as "
    "disagreement even when the shapes match; preview with array 'norm' to "
    "compare shapes."
)


def merge_agreement(result: dict) -> dict | None:
    """A merge preview's scatter in two numbers and one per member.

    The preview hands the browser the stddev band to draw, and a caller who
    cannot see it learns nothing from "<460 numbers, ...>". The band is as wide
    as the signal when one member is unaligned or from another instrument, and
    this is how that shows without a plot.
    """
    y = np.asarray(result.get("y") or [], float)
    stddev = np.asarray(result.get("stddev") or [], float)
    if y.size < 2 or stddev.size != y.size:
        return None
    span = float(np.ptp(y))
    if span <= 0:
        return None
    members = []
    for component in result.get("components") or ():
        values = np.asarray(component.get("y") or [], float)
        if values.size == y.size:
            members.append({"label": component["label"],
                            "rms_to_range": round(float(np.sqrt(np.mean((values - y) ** 2))) / span, 4)})
    return {"scatter_to_range": round(float(np.median(stddev)) / span, 4),
            "max_scatter_to_range": round(float(np.max(stddev)) / span, 4),
            "members": members, "note": AGREEMENT_NOTE}
