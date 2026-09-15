"""Bounded Athena E0 selection on an energy axis in eV.

Primary references: Athena 0.9.26 params/e0.html and Demeter revision
06afc8da08a5a7d5a26ee14992170fcf5dc67406, lib/Demeter/Data/{E0,Mu}.pm,
templates/process/{ifeffit,larch}/{deriv,normalize,find_e0,find_wl}.tmpl.
https://bruceravel.github.io/demeter/documents/Athena/params/e0.html
https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/E0.pm

Fraction iteration and the alternating zero-crossing search follow that
source. Derivatives use deriv(mu)/deriv(energy), i.e. ratios of central
differences (also Ifeffit 1.2.11d decod.f), including nonuniform grids.
The manual describes the white line as a first-derivative zero. The pinned
Mu.pm implements this via the first sampled turnover after the seed, then
a local maximum of a naturally cubic-spline-interpolated flattened signal.
That source algorithm is used here, with process.demeter_conf's six-sample
margin and 0.02 eV grid. SciPy's natural CubicSpline has the same boundary
conditions as Ifeffit 1.2.11d misc_num.f splcoefs/splint; the alternative
Demeter Larch template uses linear interpolation and a different linspace.
Initial edge finding and normalization use this checkout's Larch, not an
Ifeffit executable. No normalization-polynomial equivalence is asserted.
Atomic energies use XrayDB's Elam table; Demeter's configurable absorption
resource and chemical interpretation are not reproduced by a table lookup.
"""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

import numpy as np
from larch import Group
from larch.xafs import pre_edge
from larch.xafs.xafsutils import TINY_ENERGY
from scipy.interpolate import CubicSpline
from xraydb import atomic_number, atomic_symbol, xray_edges

from .athena_science import (
    AthenaParameters, ScientificError, _edge, _normalization_ranges, _pair,
)

METHODS = ("derivative", "atomic", "fraction", "zero_crossing", "white_line", "manual")
MAX_ITERATIONS = 5
E0_TOLERANCE = 0.001  # eV, Demeter Constants.pm EPSILON3 / E0.pm
WHITE_LINE_MARGIN = 6  # measured samples on each side, process.demeter_conf
WHITE_LINE_GRID = 0.02  # eV, process.demeter_conf
MAX_WHITE_LINE_POINTS = 100_000
_INFER_EDGES = ("K", "L1", "L2", "L3")
_EDGE_REMAP = {
    ("Nd", "L1"): ("Fe", "K"), ("Sm", "L1"): ("Co", "K"),
    ("Er", "L3"): ("Ni", "K"), ("Ce", "L1"): ("Mn", "K"),
    ("Ir", "L1"): ("Bi", "L3"), ("Tl", "L3"): ("Se", "K"),
    ("Pb", "L2"): ("Rb", "K"), ("Ba", "L1"): ("Cr", "K"),
    ("Bk", "L2"): ("Pd", "K"),
}


def _symbol(element):
    if not isinstance(element, str) or not element.strip().isalpha() or len(element.strip()) > 2:
        raise ScientificError("element must be a periodic-table symbol, for example Cu or Pt.")
    symbol = element.strip().title()
    try:
        return atomic_symbol(atomic_number(symbol))
    except (ValueError, IndexError, KeyError) as exc:
        raise ScientificError(f"Unknown element {element!r}; use a periodic-table symbol such as Cu.") from exc


@lru_cache(maxsize=1)
def _edge_table():
    """Immutable Elam entries; missing heavy-element edges are never invented."""
    entries = []
    for z in range(1, 119):
        symbol = atomic_symbol(z)
        for edge, record in xray_edges(symbol).items():
            energy = float(record.energy)
            if np.isfinite(energy) and energy > 0:
                entries.append((symbol, edge, energy))
    return tuple(entries)


def atomic_edge(element, edge):
    """Return {element, edge, energy}; Elam binding energy in absolute eV.

    Symbols and IUPAC shell names are case-insensitive (Cu, K, L3, ...).
    No chemical shift, calibration shift, or unmeasured edge is synthesized.
    """
    symbol = _symbol(element)
    if not isinstance(edge, str):
        raise ScientificError("edge must be an IUPAC shell name such as K, L1, L2 or L3.")
    shell = edge.strip().upper()
    for atom, name, energy in _edge_table():
        if (atom, name) == (symbol, shell):
            return {"element": symbol, "edge": shell, "energy": energy}
    raise ScientificError(f"No tabulated {shell or '(empty)'} edge for {symbol}; choose an edge from edge_catalog(element).")


def edge_catalog(element=None):
    """Return UI choices without mutable cached objects or non-JSON scalars.

    With a symbol: {element, edges: [{edge, energy}]} in shell order, eV.
    Without one: {elements: [symbols]} in atomic-number order, restricted
    to elements with tabulated edges (H through Cf in XrayDB 4.5.8).
    """
    if element is None:
        return {"elements": list(dict.fromkeys(atom for atom, _, _ in _edge_table()))}
    symbol = _symbol(element)
    return {"element": symbol, "edges": [
        {"edge": shell, "energy": energy} for atom, shell, energy in _edge_table() if atom == symbol]}


def _infer_atomic(e0):
    """Demeter Mu.pm find_edge: nearest K/L1/L2/L3, then named remappings.

    Search shell first and atomic number second, keeping the first tie.
    No XDI element metadata is available in this scalar helper; callers can
    explicitly select an atomic element/edge to override the inference.
    """
    candidates = [item for shell in _INFER_EDGES for item in _edge_table() if item[1] == shell]
    symbol, shell, _ = min(candidates, key=lambda item: abs(item[2] - e0))
    symbol, shell = _EDGE_REMAP.get((symbol, shell), (symbol, shell))
    return atomic_edge(symbol, shell)


def _finite(value, name):
    if isinstance(value, (bool, np.bool_)):
        raise ScientificError(f"{name} must be a finite number, not a boolean.")
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ScientificError(f"{name} must be a finite number in eV." if name != "fraction" else
                              "fraction must be a finite number greater than 0 and at most 1.") from exc
    if not np.isfinite(result):
        raise ScientificError(f"{name} must be finite.")
    return result


def _inside(x, value, name):
    value = _finite(value, name)
    if not x[1] <= value <= x[-2]:
        raise ScientificError(f"{name} must lie inside the shifted energy range, with measured data on both sides.")
    return value


def _derivatives(x, y):
    with np.errstate(over="raise", divide="raise", invalid="raise"):
        first = np.gradient(y) / np.gradient(x)
        second = np.gradient(first) / np.gradient(x)
    if not np.isfinite(first).all() or not np.isfinite(second).all():
        raise ScientificError("Derivatives are not finite; rescale mu or rebin the energy grid.")
    return first, second


def _crossings(x, y):
    """Bracket sign changes, including isolated exact zeros but not tangencies.

    A multi-point zero plateau is retained as an ambiguous bracket; only
    selecting that bracket raises, rather than choosing an arbitrary peak.
    """
    nonzero = np.flatnonzero(y)
    for lo, hi in zip(nonzero[:-1], nonzero[1:]):
        if np.signbit(y[lo]) == np.signbit(y[hi]):
            continue
        root = None
        if hi - lo == 1:
            # Scale first to avoid overflow when opposite values are large.
            scale = max(abs(y[lo]), abs(y[hi]))
            left, right = y[lo] / scale, y[hi] / scale
            root = float(x[lo] + (x[hi] - x[lo]) * (-left / (right - left)))
        elif hi - lo == 2:
            root = float(x[lo + 1])
        yield int(lo), int(hi), root


def _crossing_e0(x, values, seed):
    candidates = list(_crossings(x, values))
    # E0.pm starts at the first sample strictly above seed, expanding
    # by sample count, upward before downward. Do not replace with an
    # energy-distance minimum on an irregular measurement grid.
    center = int(np.searchsorted(x, seed, side="right"))
    def rank(item):
        lo, hi, _ = item
        if lo < center < hi:
            return (0, 0)
        return (hi - center, 0) if lo >= center else (center - lo, 1)
    candidates.sort(key=rank)
    if not candidates:
        raise ScientificError("No second-derivative zero crossing on either side of seed_e0; inspect the edge or use manual E0.")
    root = candidates[0][2]
    if root is None:
        raise ScientificError("The selected derivative has a flat zero interval; a unique E0 cannot be resolved. Use manual E0 or another seed.")
    return _inside(x, root, "Selected E0")


def _normalized(x, y, p, e0, *, flat=False):
    ranges = _normalization_ranges(x, e0, p)
    group = Group()
    pre_edge(x, y, group=group, e0=e0, step=p.step, make_flat=flat, **ranges)
    index = int(np.abs(x - e0).argmin())
    fitted_step = float(group.post_edge[index] - group.pre_edge[index])
    if (p.step is None and fitted_step <= max(1e-12, np.ptp(y) * 1e-10)) or group.edge_step <= 0:
        raise ScientificError("E0 normalization requires a positive fitted edge step; check mu and the normalization windows.")
    result = group.flat if flat else group.norm
    if not np.isfinite(result).all():
        raise ScientificError("E0 normalization is not finite; check mu and normalization windows.")
    return result


def _white_line_e0(x, y, p, seed, data_type):
    """Mu.pm find_white_line and Ifeffit find_wl.tmpl, with bounded support.

    Locate the first raw-mu decrease starting strictly after seed, select the
    preceding sample, and evaluate the spline of the ENTIRE flattened scan
    only within +/-6 samples. The grid and first-maximum tie rule match
    Ifeffit range/ceil/nofx, using zero-based indexing here. Normalized inputs
    supply their existing flat curve. Missing margins are errors rather than
    Perl negative-index wraparound; no clipped windows or global peak search.
    The seed comparison uses the shifted axis consistently, correcting the
    pinned Mu.pm raw-energy comparison when bkg_eshift is nonzero.
    """
    start = int(np.searchsorted(x, seed, side="right"))
    decreasing = np.flatnonzero(np.diff(y[start:]) < 0)
    if not decreasing.size:
        raise ScientificError("No sampled white-line turnover after seed_e0; choose another seed or use manual E0.")
    peak = start + int(decreasing[0])
    lo, hi = peak - WHITE_LINE_MARGIN, peak + WHITE_LINE_MARGIN
    if lo < 0 or hi >= x.size:
        raise ScientificError("White-line refinement needs six measured samples on both sides of the first turnover; extend the scan or use manual E0.")
    # Ifeffit decod.f range(): int(span/step + 1e-4) + 1.
    count = int((x[hi] - x[lo]) / WHITE_LINE_GRID + 1e-4) + 1
    if count > MAX_WHITE_LINE_POINTS:
        raise ScientificError("White-line 0.02 eV refinement exceeds 100000 grid points; supply more closely sampled edge data or use manual E0.")
    grid = x[lo] + WHITE_LINE_GRID * np.arange(count)
    flattened = y if data_type in ("norm", "xmudat") else _normalized(x, y, p, seed, flat=True)
    interpolated = CubicSpline(x, flattened, bc_type="natural", extrapolate=False)(grid)
    if not np.isfinite(interpolated).all():
        raise ScientificError("White-line spline is not finite within measured support; inspect the data or use manual E0.")
    index = int(np.argmax(interpolated))
    e0 = _inside(x, grid[index], "White-line E0")
    warnings = []
    if index in (0, count - 1):
        warnings.append("White-line maximum is at the refinement-window boundary; inspect the selected peak or choose another seed.")
    if e0 <= seed:
        warnings.append("Refined white-line E0 is at or below the seed; inspect the selected peak or choose another seed.")
    return e0, warnings


def _fraction_e0(x, y, p, seed, fraction, data_type):
    """E0.pm fraction interpolation with fresh scalar normalization each pass."""
    e0 = seed
    for iteration in range(1, MAX_ITERATIONS + 1):
        if data_type in ("norm", "xmudat"):
            normalized = y  # supplied dimensionless signal, unit edge step
        else:
            normalized = _normalized(x, y, p, e0)
        if not np.isfinite(normalized).all():
            raise ScientificError("Fraction normalization is not finite; check mu and normalization windows.")
        indices = np.flatnonzero(normalized >= fraction)
        if not indices.size or indices[0] == 0:
            raise ScientificError("The requested fraction is not bracketed from below by the normalized edge; extend the scan or adjust the fraction/normalization windows.")
        hi = int(indices[0])
        lo = hi - 1
        alpha = (fraction - normalized[lo]) / (normalized[hi] - normalized[lo])
        next_e0 = _inside(x, x[lo] + alpha * (x[hi] - x[lo]), "Fraction E0")
        converged = abs(next_e0 - e0) <= E0_TOLERANCE
        e0 = next_e0
        if converged:
            return e0, iteration, True
    return e0, MAX_ITERATIONS, False


def compute_e0(energy, mu, parameters: AthenaParameters | Mapping | None, *,
               method="derivative", fraction=0.5, element=None, edge=None,
               value=None, seed_e0=None, data_type="mu", _for_rebin=False):
    """Select E0 without mutating the spectrum, recipe, or energy calibration.

    Return JSON {method, e0, seed_e0, element, edge, tabulated_e0, iterations,
    converged, warnings}. Energies are eV on energy+parameters.energy_shift;
    explicit value/seed_e0 and tabulated atomic values are already absolute
    shifted-axis coordinates and receive no additional shift. Input must be
    real mu/xanes/norm with 8..100000 samples; chi(k) is rejected.

    Defaults find a fresh seed through athena_science._edge (Larch, or its
    documented interior derivative maximum for <100 points). parameters.e0
    does not pin a new selection. seed_e0 overrides initialization for atomic,
    fraction, zero_crossing and white_line; derivative always finds afresh.
    manual requires value, needs no automatic seed, and reports seed_e0=None.
    element+edge must both be supplied for an explicit atomic selection, or
    both omitted to infer from the transient seed. Other methods infer this
    metadata from their result; it is not a chemical identification.

    Fraction must satisfy 0<f<=1; invalid values are rejected without the
    pinned source's fallback/clamping. Raw mu/xanes use Larch scalar normalization
    with the supplied pre/post ranges, nnorm and optional fixed step, refit
    for each E0. norm uses its existing unit-step values without refitting.
    fnorm and flatten display controls do not modify the E0 search. White-line
    always uses the normalized/flattened curve with the source's fixed six-
    sample margin, 0.02 eV grid and natural spline. iterations counts fraction
    normalizations (maximum five) or one zero/white-line refinement; it is zero
    for derivative/atomic/manual. Nonconvergence returns the last bounded
    value with converged=False and a warning, never a hidden fallback.

    Differences from pinned Demeter: native Larch initial/normalization
    numerics, unrounded interpolated E0, explicit invalid-range errors, exact
    isolated derivative zeros accepted, and continued one-sided searching
    at boundaries. White-line uses shifted coordinates consistently and rejects
    unavailable margins rather than reproducing Perl negative-index wrapping.
    """
    if not isinstance(method, str) or method not in METHODS:
        raise ScientificError("Unknown E0 method; choose " + ", ".join(METHODS) + ".")
    if data_type not in ("mu", "xanes", "norm", "xmudat"):
        raise ScientificError("E0 selection requires mu, xanes, norm or xmudat energy data; chi(k) is not an absorption edge.")
    if parameters is not None and not isinstance(parameters, (AthenaParameters, Mapping)):
        raise ScientificError("parameters must be an AthenaParameters recipe or a mapping.")
    p = parameters if isinstance(parameters, AthenaParameters) else AthenaParameters.model_validate(parameters or {})
    # Only the import rebin planner can use the dense original grid here.
    # Fraction crossing needs no derivative or FFT and supports equal energies.
    # Public E0 operations retain their existing strict processed-grid contract.
    if _for_rebin and (method != 'fraction' or data_type != 'norm' or seed_e0 is None):
        raise ScientificError('Original-grid E0 refinement requires normalized fraction selection with an explicit seed.')
    x, y = _pair(energy, mu, name="E0 spectrum", minimum=8,
                 **({'maximum': 250_000, 'allow_equal': True} if _for_rebin else {}))
    x += p.energy_shift
    if x[0] <= 0 or x[-1] > 1e7:
        raise ScientificError("Supply positive energies in eV no greater than 1e7 after energy_shift.")
    if not _for_rebin and np.any(np.diff(x) < TINY_ENERGY):
        raise ScientificError("Energy spacing is below Larch's 0.0005 eV limit; rebin close points.")
    try:
        with np.errstate(over="raise", invalid="raise"):
            signal_range = np.ptp(y)
    except ArithmeticError as exc:
        raise ScientificError("The signal range overflows; rescale mu before selecting E0.") from exc
    if signal_range <= np.finfo(float).eps * max(1, np.max(np.abs(y))):
        raise ScientificError("The signal is constant; select an absorption spectrum containing an edge.")
    fraction = _finite(fraction, "fraction")
    if not 0 < fraction <= 1:
        raise ScientificError("fraction must be greater than 0 and at most 1.")
    if method != "fraction" and fraction != 0.5:
        raise ScientificError("fraction applies only to the fraction E0 method.")
    if method != "manual" and value is not None:
        raise ScientificError("value applies only to the manual E0 method.")
    if method != "atomic" and (element is not None or edge is not None):
        raise ScientificError("element and edge apply only to the atomic E0 method.")
    if method in ("manual", "derivative") and seed_e0 is not None:
        raise ScientificError("seed_e0 applies to atomic, fraction, zero_crossing or white_line refinement.")
    warnings = []
    iterations, converged, seed = 0, True, None
    if method == "manual":
        e0 = _inside(x, value, "manual value")
        atomic = _infer_atomic(e0)
    else:
        if method == "atomic" and ((element is None) != (edge is None)):
            raise ScientificError("Supply both element and edge for atomic E0, or omit both to infer them.")
        seed = _edge(x, y) if seed_e0 is None else _inside(x, seed_e0, "seed_e0")
        if seed_e0 is None and x.size < 100:
            warnings.append("Fewer than 100 samples: E0 uses a derivative-maximum fallback. Check the selected edge or supply a seed.")
        e0 = seed
        atomic = _infer_atomic(seed)
        try:
            with np.errstate(over="raise", divide="raise", invalid="raise"):
                if method == "atomic":
                    atomic = _infer_atomic(seed) if element is None else atomic_edge(element, edge)
                    e0 = _inside(x, atomic["energy"], "Tabulated atomic E0")
                elif method == "fraction":
                    e0, iterations, converged = _fraction_e0(x, y, p, seed, fraction, data_type)
                    if not converged:
                        warnings.append("Fraction E0 did not converge within five iterations at 0.001 eV tolerance; the last estimate is returned. Inspect the normalization windows or choose manual E0.")
                elif method == "zero_crossing":
                    _, second = _derivatives(x, y)
                    e0 = _crossing_e0(x, second, seed)
                    iterations = 1
                elif method == "white_line":
                    e0, issues = _white_line_e0(x, y, p, seed, data_type)
                    iterations = 1
                    warnings.extend(issues)
        except (ArithmeticError, np.linalg.LinAlgError) as exc:
            raise ScientificError("E0 calculation is numerically unstable; rescale mu or adjust the seed/normalization windows.") from exc
        if method != "atomic":
            atomic = _infer_atomic(e0)
    if method != "atomic" or element is None:
        warnings.append(f"Element and edge are inferred from energy; confirm {atomic['element']} {atomic['edge']} matches this measurement.")
    return {"method": method, "e0": float(e0), "seed_e0": None if seed is None else float(seed),
            "element": atomic["element"], "edge": atomic["edge"], "tabulated_e0": atomic["energy"],
            "iterations": iterations, "converged": converged, "warnings": warnings}
