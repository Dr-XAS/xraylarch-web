"""Import-only absorber enforcement: table -> defaults -> fractional E0.

Oracle: Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406, Data/Mu.pm
initialize_e0, Data/Defaults.pm resolve_defaults/resolve_pre/resolve_nor/
resolve_spl/resolve_krange_xmu and configuration/{bkg,fft,xanes}.demeter_conf.
https://bruceravel.github.io/demeter/documents/Athena/params/e0.html
https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Defaults.pm

Only None-valued range/order fields are automatic. Non-null recipe values,
including energy_shift, numeric clamps, weights, windows and grids, survive;
E0 is deliberately replaced by the enforced table seed then its fraction.
Defaults are resolved at that seed. Automatic bounds can subsequently be
limited to measured support, as a native normalization/background backend
would do; explicit bounds are never clipped. Each such adjustment is recorded.

The web recipe uses eV relative to E0, positive k bounds in inverse angstroms,
and Larch polynomial degree. It does not accept Demeter's signed end-relative
or implicit-keV preference syntax, read personal INI files, or replace existing
web numeric defaults with every Perl preference (e.g. clamp2=24, bkg.dk=0).
Main-resource nnorm=3 maps to Larch degree 2. The source resolve_defaults does
not invoke the separate to_default(nnorm) XANES-order reset. Native three-
decimal range rounding is retained except where it would exceed support;
native E/k conversion uses this checkout's ETOK. The source's raw/shifted
coordinate inconsistencies and normalized-input recursion are not reproduced.
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np
from larch.xafs.xafsutils import ETOK, TINY_ENERGY

from .athena_e0 import E0_TOLERANCE, MAX_ITERATIONS, _normalized, atomic_edge, compute_e0
from .athena_science import AthenaParameters, ScientificError, _fft_capacity, _normalization_ranges, _pair

SOURCE_REVISION = "06afc8da08a5a7d5a26ee14992170fcf5dc67406"
XANES_CUTOFF = 100.0  # eV after the tabulated seed, xanes.cutoff
_NORMALIZATION_FIELDS = ("pre1", "pre2", "norm1", "norm2", "nnorm")
_RANGE_FIELDS = (*_NORMALIZATION_FIELDS, "bkg_kmin", "bkg_kmax", "kmin", "kmax")


def _policy(policy):
    if not isinstance(policy, Mapping) or set(policy) - {"element", "edge", "fraction"}:
        raise ScientificError("policy must contain element, edge and optionally fraction; no other options are supported.")
    if policy.get("element") is None or policy.get("edge") is None:
        raise ScientificError("An import policy requires both element and edge, for example Cu and K.")
    atom = atomic_edge(policy["element"], policy["edge"])
    fraction = policy.get("fraction", 0.5)
    if isinstance(fraction, (bool, np.bool_)):
        raise ScientificError("Import fraction must be a finite number greater than 0 and at most 1, not a boolean.")
    try:
        fraction = float(fraction)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ScientificError("Import fraction must be a finite number greater than 0 and at most 1.") from exc
    if not np.isfinite(fraction) or not 0 < fraction <= 1:
        raise ScientificError("Import fraction must be a finite number greater than 0 and at most 1.")
    return atom, fraction


def _pre2_default(seed):
    # Preserve the pinned strict interval endpoints, not a smoothed rule.
    if 12000 < seed < 20000:
        return -45.0
    if 20000 < seed < 30000:
        return -60.0
    return -75.0 if seed > 30000 else -30.0


def _at_e0(x, base, automatic, e0, data_type):
    """Limit only automatic endpoint bounds; validate all explicit bounds.

    Reuse the seed-resolved base on every pass so an earlier iteration's
    adjustment does not permanently shrink a later, again-valid interval.
    This does not re-resolve end-100 or end-2 defaults around a new seed.
    """
    recipe = dict(base, e0=float(e0))
    if not x[1] <= e0 <= x[-2]:
        raise ScientificError("Enforced/fractional E0 needs measured data on both sides in the shifted energy range.")
    if data_type not in ("norm", "xmudat"):
        start, end = float(x[0] - e0), float(x[-1] - e0)
        if "pre1" in automatic:
            recipe["pre1"] = max(recipe["pre1"], start)
        if "pre2" in automatic and recipe["pre2"] < start:
            recipe["pre2"] = recipe["pre1"] + 10
        if "pre2" in automatic and recipe["pre2"] > 0:
            recipe["pre2"] = recipe["pre1"] / 2
        if "norm2" in automatic:
            recipe["norm2"] = min(recipe["norm2"], end)
        # Ranges must remain usable; no repair by moving an explicit endpoint.
        try:
            _normalization_ranges(x, e0, AthenaParameters.model_validate(recipe))
        except ValueError as exc:
            raise ScientificError(f"Import normalization ranges are unusable at E0={e0:.6g} eV: {exc} Supply valid pre1/pre2/norm1/norm2 or extend the scan; explicit ranges are not clipped.") from exc
    if data_type != "xanes":
        available = float(np.sqrt(ETOK * (x[-1] - e0)))
        if "bkg_kmax" in automatic:
            recipe["bkg_kmax"] = min(recipe["bkg_kmax"], available)
        bmax = recipe["bkg_kmax"]
        if bmax > available or recipe["bkg_kmin"] >= bmax:
            raise ScientificError("Import bkg_kmin/bkg_kmax exceeds post-edge support at the selected E0; lower the explicit spline bounds or extend the scan.")
        if bmax > 100 or bmax - recipe["bkg_kmin"] < 2:
            raise ScientificError("Import needs a spline range spanning at least 2 inverse angstroms and ending at k<=100; use XANES input or adjust bkg_kmin/bkg_kmax.")
        # This is the native Larch kout endpoint, not a different k grid.
        grid_end = recipe["kstep"] * (int(1.01 + bmax / recipe["kstep"]) - 1)
        if "kmax" in automatic:
            recipe["kmax"] = min(recipe["kmax"], grid_end)
        if recipe["kmax"] > min(bmax, grid_end):
            raise ScientificError("Import kmax exceeds the processed spline/FT grid; lower the explicit kmax or increase bkg_kmax.")
        if recipe["kmin"] < 0 or recipe["kmax"] - recipe["kmin"] < 2 * recipe["kstep"]:
            raise ScientificError("Import FT range is too short; lower kmin, supply a usable kmax, or use XANES input. Explicit FT limits are not changed.")
        if recipe["dk"] > 2 * (recipe["kmax"] - recipe["kmin"]):
            raise ScientificError("Import dk is too wide for the resolved FT range; reduce dk or lower kmin.")
        if recipe["bkg_dk"] > 2 * (bmax - recipe["bkg_kmin"]):
            raise ScientificError("Import bkg_dk is too wide for the resolved spline range; reduce bkg_dk or lower bkg_kmin.")
        if recipe["dr"] > 2 * (recipe["rmax"] - recipe["rmin"]):
            raise ScientificError("Import dr is too wide for the selected R range; reduce dr or widen rmin/rmax.")
        _fft_capacity(bmax, AthenaParameters.model_validate(recipe))
    return AthenaParameters.model_validate(recipe).model_dump()


def _seed_defaults(x, p, seed, data_type):
    base = p.model_dump()
    automatic = set()
    short = bool(x[-1] - seed < XANES_CUTOFF)
    output_type = "xanes" if data_type == "mu" and short else data_type
    if output_type != "mu" and p.fnorm:
        raise ScientificError("fnorm requires raw mu with EXAFS support; disable fnorm for this import or provide a longer mu scan.")
    if output_type not in ("norm", "xmudat"):
        values = {"pre1": -150.0, "pre2": _pre2_default(seed), "nnorm": 2,
                  "norm1": 15.0 if output_type == "xanes" else 150.0,
                  "norm2": float(x[-1] - seed - (0 if output_type == "xanes" else 100))}
        if p.pre1 is None:
            values["pre1"] = max(values["pre1"], float(x[0] - seed))
        if p.pre2 is None and values["pre2"] < x[0] - seed:
            values["pre2"] = (p.pre1 if p.pre1 is not None else values["pre1"]) + 10
        if p.pre2 is None and values["pre2"] > 0:
            values["pre2"] = (p.pre1 if p.pre1 is not None else values["pre1"]) / 2
        # Demeter sorts resolved defaults. Do not swap an explicit value into
        # another field when a partly specified recipe is inconsistent.
        if p.norm1 is None and p.norm2 is None:
            values["norm1"], values["norm2"] = sorted((values["norm1"], values["norm2"]))
        for key, value in values.items():
            if base[key] is None:
                base[key] = int(value) if key == "nnorm" else round(value, 3)
                automatic.add(key)
    available = float(np.sqrt(ETOK * (x[-1] - seed)))
    if output_type != "xanes":
        if p.bkg_kmax is None:
            base["bkg_kmax"] = round(available, 3)
            automatic.add("bkg_kmax")
        if p.kmax is None:
            base["kmax"] = round(available - 2, 3)  # fft.kmax=-2
            automatic.add("kmax")
    base["e0"] = seed
    resolved = _at_e0(x, base, automatic, seed, output_type)
    return resolved, automatic, output_type, short, available


def initialize_import(energy, mu, parameters=None, *, policy, data_type="mu", _for_rebin=False):
    """Initialize one ordinary import without modifying arrays or policy state.

    policy is {element, edge, fraction=0.5}, with 0<f<=1. Return parameters
    (AthenaParameters.model_dump), data_type, edge_identity={element, edge,
    origin:'enforced'}, e0_selection, defaults and actionable warnings. A None
    policy or chi input bypasses enforcement and returns null metadata with
    an unchanged validated recipe; raw parsing/chi validation belongs to the
    importer. No global/session state is read or changed.

    Input energies are unshifted eV; apply energy_shift once for coverage and
    defaults. The atomic energy is already an absolute energy and is not
    shifted again. Required normalization intervals and k/FT bounds must be
    usable at both the table seed and final fractional E0. Explicit e0 is
    replaced by policy, other non-null recipe values are preserved.

    At each of at most five passes, fit scalar Larch normalization at the
    current E0 with automatic endpoint bounds constrained to measurement.
    Then call compute_e0(method='fraction', seed_e0=TABULATED_E0) on this real
    normalized curve. This preserves the source's first-crossing interpolation
    while avoiding a derivative reseed, invalid fixed endpoint bounds, and
    native is_nor recursion. e0_selection has compute_e0's shape, with the
    outer normalization iteration count/convergence. norm input uses its
    supplied unit-step signal; its normalization controls remain untouched.

    defaults records source_revision, seed_e0, seed_energy_range,
    seed_available_kmax, short_scan, automatic_fields, resolved_at_seed, and
    final_adjustments ({field: {seed, final}}). Seed-resolved values stay fixed
    unless an AUTOMATIC bound would exceed support at the refined E0. Mu scans
    ending <100 eV after the seed become xanes; norm keeps its representation
    and must have usable explicit/default k ranges. XANES retains unused EXAFS
    recipe values rather than creating invalid/inactive numeric FT ranges.
    The caller performs final processing once and owns atomic persistence.
    """
    if data_type not in ("mu", "xanes", "norm", "chi", "xmudat"):
        raise ScientificError("Import data_type must be mu, xanes, norm, chi or xmudat.")
    if parameters is not None and not isinstance(parameters, (Mapping, AthenaParameters)):
        raise ScientificError("parameters must be an AthenaParameters recipe or mapping.")
    p = parameters if isinstance(parameters, AthenaParameters) else AthenaParameters.model_validate(parameters or {})
    result = {"parameters": p.model_dump(), "data_type": data_type, "edge_identity": None,
              "e0_selection": None, "defaults": None, "warnings": []}
    if policy is None or data_type == "chi":
        return result
    atom, fraction = _policy(policy)
    seed = atom["energy"]
    # Rebin planning performs scalar normalization/fraction selection on all
    # original readings, before the final processed grid exists. Larch pre_edge
    # internally handles duplicates; retain the supplied arrays unchanged.
    raw_x, y = _pair(energy, mu, name="Enforced import", minimum=10,
                     **({'maximum': 250_000, 'allow_equal': True} if _for_rebin else {}))
    x = raw_x + p.energy_shift
    if x[0] <= 0 or x[-1] > 1e7:
        raise ScientificError("Enforced import needs positive energies in eV no greater than 1e7 after energy_shift.")
    if not _for_rebin and np.any(np.diff(x) < TINY_ENERGY):
        raise ScientificError("Enforced import energy spacing is below 0.0005 eV; rebin close points.")
    if not x[1] <= seed <= x[-2]:
        raise ScientificError(f"Enforced {atom['element']} {atom['edge']} E0={seed:g} eV needs measured data on both sides in the shifted energy range; select the correct edge or extend the scan.")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            seed_recipe, automatic, output_type, short, available = _seed_defaults(x, p, seed, data_type)
            current = seed
            for iteration in range(1, MAX_ITERATIONS + 1):
                recipe = _at_e0(x, seed_recipe, automatic, current, output_type)
                normalized = y if output_type in ("norm", "xmudat") else _normalized(x, y, AthenaParameters(**recipe), current)
                # x is already shifted, so the selector must receive shift=0.
                selection = compute_e0(x, normalized, {}, method="fraction", fraction=fraction,
                                       seed_e0=seed, data_type="norm", _for_rebin=_for_rebin)
                next_e0 = selection["e0"]
                converged = abs(next_e0 - current) <= E0_TOLERANCE
                current = next_e0
                if converged:
                    break
            final_recipe = _at_e0(x, seed_recipe, automatic, current, output_type)
    except (ArithmeticError, np.linalg.LinAlgError) as exc:
        raise ScientificError("Enforced import normalization is numerically unstable; rescale mu or adjust the normalization ranges.") from exc
    selection.update(iterations=iteration, converged=converged)
    warnings = []
    if not converged:
        warning = "Fraction E0 did not converge within five iterations at 0.001 eV tolerance; inspect the import normalization ranges."
        selection["warnings"].append(warning)
        warnings.append(warning)
    if (selection["element"], selection["edge"]) != (atom["element"], atom["edge"]):
        warnings.append(f"Fractional E0 is nearer {selection['element']} {selection['edge']}; the enforced identity remains {atom['element']} {atom['edge']}. Confirm the selected absorber and ranges.")
    if output_type != data_type:
        warnings.append("Less than 100 eV of post-edge data at the tabulated seed: this mu scan was initialized as XANES.")
    resolved = {key: seed_recipe[key] for key in _RANGE_FIELDS}
    result.update(parameters=final_recipe, data_type=output_type,
                  edge_identity={"element": atom["element"], "edge": atom["edge"], "origin": "enforced"},
                  e0_selection=selection, warnings=warnings,
                  defaults={"source_revision": SOURCE_REVISION, "seed_e0": seed,
                            "seed_energy_range": [float(x[0]), float(x[-1])], "seed_available_kmax": available,
                            "short_scan": short, "automatic_fields": sorted(automatic), "resolved_at_seed": resolved,
                            "final_adjustments": {key: {"seed": seed_recipe[key], "final": final_recipe[key]}
                                                  for key in automatic if final_recipe[key] != seed_recipe[key]}})
    return result
