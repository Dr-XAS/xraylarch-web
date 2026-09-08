"""Read-only Athena difference forms, physical energy axes and signed areas.

Oracle: Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406,
lib/Demeter/Diff.pm (diff, make_name, _integrate), UI/Athena/Difference.pm,
templates/analysis/{ifeffit,larch}/diff_diff.tmpl, and
documentation/Athena/analysis/diff.rst.
https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Diff.pm

DATA is interpolated onto STANDARD, then the expression is
(-1 if invert else 1) * (data - multiplier * standard). This checkout's
larch.math.interp defaults to linear; that Larch template is followed within
the full STANDARD grid, including Larch's linear endpoint extrapolation.
Extrapolated values are counted and warned about, never called measured data.
The alternative Ifeffit template uses qinterp;
equivalence to its interpolation is not asserted. Derivatives use Larch's
deriv(y)/deriv(energy), repeated for second derivatives, before interpolation.
Normalized derivatives always differentiate unflattened norm, never flat.

Both templates subtract the DATA energy shift from the intermediate output
axis. Diff.pm integrates that intermediate axis against physical DATA E0,
then make_group adds the shift back. Here all coordinates, including the
natural cubic spline and E0-relative limits, remain physical eV throughout;
the intermediate-coordinate mismatch is avoided. The integration spline is
never extrapolated beyond the full STANDARD grid, even when that grid contains
explicitly reported extrapolated DATA values.
Integration follows _integrate's six Romberg refinements and absolute 1e-5
successive-diagonal tolerance, returning the last finite estimate if needed.

Only %a uses five decimals; multiplier and bounds use general scalar formatting.
Disabled integration has no fabricated area: %a becomes 'n/a'. Unknown tokens
remain literal. Rendered labels longer than 200 characters are truncated with
a warning, so preview and saved labels agree. Renormalization, plot-space conversion and persistence
belong to the caller; this helper never processes or modifies input groups.
"""

from __future__ import annotations

from collections.abc import Mapping
from numbers import Real
import re
from typing import Literal

from larch.math import deriv, interp
import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from scipy.interpolate import CubicSpline

from .athena_science import ScientificError, _pair


MIN_POINTS = 5
ROMBERG_STEPS = 6
ROMBERG_EPSILON = 1e-5
DifferenceForm = Literal["xmu", "norm", "der", "nder", "sec", "nsec"]


class DifferenceOptions(BaseModel):
    """Integration bounds are relative eV; multiplier is signed and finite.

    The caller resolves renormalize=None to form == 'xmu' when creating a
    group. plot_inputs and plot_space affect presentation, not these arrays.
    """

    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False,
                              validate_assignment=True, revalidate_instances="always")

    standard_id: str = Field(min_length=1, max_length=200)
    form: DifferenceForm = "norm"
    multiplier: float = 1.0
    invert: bool = False
    integrate: bool = True
    xmin: float = -20.0
    xmax: float = 30.0
    renormalize: bool | None = None
    name_template: str = Field(default="diff %d - %s", max_length=200)
    plot_inputs: bool = True
    plot_space: Literal["E", "k"] = "E"

    @field_validator("standard_id")
    @classmethod
    def nonblank_id(cls, value):
        if not value.strip():
            raise ValueError("Choose a standard group with a nonempty ID.")
        return value

    @model_validator(mode="after")
    def ordered_interval(self):
        if self.integrate and self.xmin >= self.xmax:
            raise ValueError("xmax must be greater than xmin, in eV relative to the data group's E0.")
        return self


_LABELS = {
    "xmu": ("Δμ(E) (input μ units)", "Integrated Δμ (input μ units·eV)"),
    "norm": ("Δnormalized μ(E)", "Integrated Δnormalized μ (eV)"),
    "der": ("Δ[dμ/dE] (input μ units/eV)", "Integrated Δ[dμ/dE] (input μ units)"),
    "nder": ("Δ[dμ_norm/dE] (eV⁻¹)", "Integrated Δ[dμ_norm/dE] (dimensionless)"),
    "sec": ("Δ[d²μ/dE²] (input μ units/eV²)", "Integrated Δ[d²μ/dE²] (input μ units/eV)"),
    "nsec": ("Δ[d²μ_norm/dE²] (eV⁻²)", "Integrated Δ[d²μ_norm/dE²] (eV⁻¹)"),
}
_NAME_TOKEN = re.compile(r"%([dsfmnxa%])")


def _number(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real) or not np.isfinite(value):
        raise ScientificError(f"{name} must be a finite real number.")
    return float(value)


def _mapping(value, name):
    if not isinstance(value, Mapping):
        raise ScientificError(f"{name} must be a group/settings object.")
    return value


def _curve(group, form, role):
    group = _mapping(group, role)
    ident = group.get("id")
    if not isinstance(ident, str) or not ident.strip() or len(ident) > 200:
        raise ScientificError(f"{role} needs a nonempty group ID of at most 200 characters.")
    label = group.get("label", ident)
    if not isinstance(label, str) or len(label) > 2000:
        raise ScientificError(f"{role} label must be text of at most 2000 characters.")
    if group.get("data_type") not in ("mu", "xanes", "norm"):
        raise ScientificError(f"{label}: difference forms require energy data (mu, xanes or norm), not chi(k).")
    parameters = _mapping(group.get("parameters", {}), f"{label} parameters")
    result = _mapping(group.get("result") or {}, f"{label} result")
    effective = _mapping(result.get("effective", {}), f"{label} effective settings")
    x, y = _pair(group.get("energy"), group.get("mu"), name=label, minimum=MIN_POINTS)
    x += _number(parameters.get("energy_shift", 0), f"{label} energy_shift")
    if x[0] <= 0 or x[-1] > 1e7 or np.any(np.diff(x) <= 0):
        raise ScientificError(f"{label}: shifted energies must be strictly increasing, positive eV no greater than 1e7.")
    resolved = form
    if form in ("norm", "nder", "nsec"):
        if group.get("processing_error"):
            raise ScientificError(f"{label}: apply valid processing parameters before using normalized difference forms: {group['processing_error']}")
        flatten = parameters.get("flatten", effective.get("flatten", True))
        if form == "norm":
            if not isinstance(flatten, bool):
                raise ScientificError(f"{label}: flatten must be a boolean saved preference.")
            resolved = "flat" if flatten else "norm"
        array_name = resolved if form == "norm" else "norm"
        arrays = _mapping(result.get("arrays", {}), f"{label} processed arrays")
        if array_name not in arrays or arrays[array_name] is None:
            raise ScientificError(f"{label}: no {array_name} array is available; process this group before making the difference.")
        processed_x, y = _pair(arrays.get("energy"), arrays[array_name],
                               name=f"{label} processed {array_name}", minimum=MIN_POINTS)
        if processed_x.shape != x.shape or not np.allclose(processed_x, x, rtol=0, atol=1e-9):
            raise ScientificError(f"{label}: processed energy does not match the shifted source axis; apply parameters again.")
    if form in ("der", "nder", "sec", "nsec"):
        y = deriv(y) / deriv(x)
        if form in ("sec", "nsec"):
            y = deriv(y) / deriv(x)
    if not np.isfinite(y).all():
        raise ScientificError(f"{label}: the {form} curve is not finite; rescale the signal or rebin the energy grid.")
    return x, y, resolved


def _romberg(x, y, lower, upper):
    spline = CubicSpline(x, y, bc_type="natural", extrapolate=False)
    step = upper - lower
    previous = [float(step * (spline(lower) + spline(upper)) / 2)]
    for iteration in range(1, ROMBERG_STEPS + 1):
        step /= 2
        interior = lower + np.arange(1, 2**iteration, 2) * step
        current = [previous[0] / 2 + float(np.sum(spline(interior))) * step]
        for column in range(1, iteration + 1):
            last = current[-1]
            current.append(last + (last - previous[column - 1]) / (4**column - 1))
        if not np.isfinite(current).all():
            raise ScientificError("Difference integration is not finite; rescale the signals or narrow the integration interval.")
        if abs(current[-1] - previous[-1]) <= ROMBERG_EPSILON:
            return float(current[-1]), True, iteration
        previous = current
    return float(previous[-1]), False, ROMBERG_STEPS


def _name(data, standard, data_form, area, options):
    names = [data.get("label", data["id"]), standard.get("label", standard["id"])]
    if options.invert:
        names.reverse()
    tokens = {"d": names[0], "s": names[1], "f": data_form, "%": "%",
              "m": f"{options.multiplier:g}", "n": f"{options.xmin:g}",
              "x": f"{options.xmax:g}", "a": "n/a" if area is None else f"{area:.5f}"}
    return _NAME_TOKEN.sub(lambda match: tokens[match[1]], options.name_template)


def _resolved_e0(group):
    """A saved physical E0 is valid for signed/unnormalizable raw data too."""
    effective = (group.get("result") or {}).get("effective", {})
    parameters = group.get("parameters", {})
    for value in (effective.get("e0"), parameters.get("e0")):
        if isinstance(value, Real) and not isinstance(value, (bool, np.bool_)) and np.isfinite(value):
            return float(value)
    return None


def difference_spectrum(data_group, standard_group, options: DifferenceOptions):
    """Return a JSON-safe difference on the full STANDARD energy grid.

    Store group dictionaries supply id, label, data_type, raw energy/mu,
    parameters.energy_shift/flatten and (for normalized forms) processed
    result.arrays.energy/norm/flat. Processed energy is already shifted and
    must match raw energy + energy_shift. Raw forms need no processed arrays.
    Integration prefers finite result.effective.e0 from DATA, then finite
    parameters.e0, both in physical eV. No edge is detected and standard E0
    is never substituted. Raw forms can integrate despite a normalization
    error when E0 is known. 5..100000 samples are required per input.
    DATA is linearly interpolated/extrapolated onto the full STANDARD grid,
    with extrapolated_points and explicit coverage/integration warnings.
    Integration is limited to that grid's spline domain. Unsupported limits
    raise ScientificError; nonconvergence returns the final estimate + warning.

    group_id identifies DATA, not a newly created group. All overlays share
    energy: data is the selected data form interpolated/extrapolated onto that grid;
    standard is multiplier-scaled. Inversion negates only difference/area.
    """
    options = DifferenceOptions.model_validate(options)
    warnings = []
    try:
        with np.errstate(over="raise", divide="raise", invalid="raise"):
            dx, dy, data_form = _curve(data_group, options.form, "Data")
            sx, sy, standard_form = _curve(standard_group, options.form, "Standard")
            if standard_group["id"] != options.standard_id:
                raise ScientificError("standard_id does not match the supplied standard group; select the intended standard.")
            x = sx
            extrapolated_points = int(np.count_nonzero((x < dx[0]) | (x > dx[-1])))
            if extrapolated_points:
                warnings.append(f"Linearly extrapolated DATA at {extrapolated_points} of {x.size} STANDARD grid points outside DATA support {dx[0]:g} to {dx[-1]:g} eV; these values are estimates, not measured coverage.")
            data = interp(dx, dy, x, kind="linear")
            standard = options.multiplier * sy
            difference = (-1 if options.invert else 1) * (data - standard)
            if not np.isfinite([data, standard, difference]).all():
                raise ScientificError("Difference arrays are not finite; reduce the multiplier or rescale the input signals.")
            e0 = _resolved_e0(data_group)
            area, integration = None, None
            if options.integrate:
                if e0 is None or e0 <= 0:
                    raise ScientificError("Integration requires a positive finite data-group E0 in effective settings or saved parameters; specify E0 or disable integration.")
                lower, upper = e0 + options.xmin, e0 + options.xmax
                if not np.isfinite([lower, upper]).all() or not x[0] <= lower < upper <= x[-1]:
                    raise ScientificError(f"Integration bounds E0+xmin/xmax must be inside the full STANDARD grid spline domain {x[0]:g} to {x[-1]:g} eV; narrow the interval or disable integration.")
                if lower < dx[0] or upper > dx[-1]:
                    warnings.append("The integration interval includes extrapolated DATA coverage; the area depends on endpoint extrapolation outside measured DATA support.")
                area, converged, iterations = _romberg(x, difference, lower, upper)
                integration = {"xmin": options.xmin, "xmax": options.xmax, "lower": lower,
                               "upper": upper, "converged": converged, "iterations": iterations}
                if not converged:
                    warnings.append("Difference integration did not converge within six Romberg refinements at absolute tolerance 1e-5; the last finite estimate is returned. Inspect the curve and integration interval.")
    except (ArithmeticError, np.linalg.LinAlgError) as exc:
        raise ScientificError("Difference calculation is numerically unstable; rescale the signals/multiplier or rebin the energy grid.") from exc
    y_label, area_label = _LABELS[options.form]
    label = _name(data_group, standard_group, data_form, area, options)
    if len(label) > 200:
        label = label[:200]
        warnings.append("Rendered difference label exceeded 200 characters and was truncated to match the saved group label.")
    return {"group_id": data_group["id"], "label": label,
            "energy": x.tolist(), "difference": difference.tolist(), "data": data.tolist(),
            "standard": standard.tolist(), "form": options.form, "data_form": data_form,
            "standard_form": standard_form, "area": area, "e0": e0, "integration": integration,
            "warnings": warnings, "extrapolated_points": extrapolated_points,
            "y_label": y_label, "area_label": area_label}
