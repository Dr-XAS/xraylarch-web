from __future__ import annotations

from collections.abc import Iterable

import numpy as np
from larch import Group
from larch.xafs import autobk, pre_edge, xftf
from larch.xafs.xafsutils import ETOK

from .contracts import (
    EffectiveRecipe,
    FieldIssue,
    ParsedUpload,
    PlotTrace,
    ProcessingResult,
    RecipeDraft,
)
from .errors import WebInputError


def _issue(code: str, message: str, *fields: str, recovery: str) -> FieldIssue:
    return FieldIssue(code=code, message=message, fields=fields, recovery=recovery)


def _as_array(values: Iterable[float]) -> np.ndarray:
    array = np.asarray(values, dtype=float)
    if array.ndim != 1:
        raise WebInputError(
            "invalid_mapping",
            "Selected columns must be one-dimensional numeric arrays.",
            recovery="Select numeric energy and signal columns.",
        )
    return array


def _validate_arrays(energy: np.ndarray, mu: np.ndarray) -> None:
    if energy.size == 0 or mu.size == 0 or energy.size != mu.size:
        raise WebInputError(
            "invalid_mapping",
            "Energy and signal columns must have the same non-zero length.",
            ("energy_column", "signal_column"),
            "Select complete numeric columns from the upload.",
        )
    if not np.isfinite(energy).all() or not np.isfinite(mu).all():
        raise WebInputError(
            "invalid_mapping",
            "Selected columns contain non-finite values.",
            ("energy_column", "signal_column"),
            "Remove non-finite rows and confirm the mapping again.",
        )
    if energy.size > 1 and np.any(np.diff(energy) <= 0):
        raise WebInputError(
            "invalid_mapping",
            "Energy values must be strictly increasing.",
            ("energy_column",),
            "Repair the energy order before processing.",
        )


def resolve_column_id(parsed: ParsedUpload, value: str) -> str:
    """Resolve a current column ID or an unambiguous legacy display name."""
    if value in parsed.arrays:
        return value
    matches = [column.column_id for column in parsed.columns if column.name == value]
    if len(matches) == 1:
        return matches[0]
    raise WebInputError(
        "invalid_mapping",
        "Choose a unique column from this upload.",
        ("energy_column", "signal_column"),
        "Select the columns in the import panel and retry.",
    )


def validate_mapping(
    parsed: ParsedUpload, energy_column: str, signal_column: str
) -> tuple[np.ndarray, np.ndarray]:
    """Return safe copies of one validated energy/signal column pair."""
    energy_column_id = resolve_column_id(parsed, energy_column)
    signal_column_id = resolve_column_id(parsed, signal_column)
    if energy_column_id == signal_column_id:
        raise WebInputError(
            "invalid_mapping",
            "Choose different energy and signal columns.",
            ("energy_column", "signal_column"),
            "Select one energy column and one signal column.",
        )
    try:
        energy = _as_array(parsed.arrays[energy_column_id])
        mu = _as_array(parsed.arrays[signal_column_id])
    except KeyError as exc:
        raise WebInputError(
            "invalid_mapping",
            "Choose columns that exist in this upload.",
            ("energy_column", "signal_column"),
            "Select the columns in the import panel and retry.",
        ) from exc
    _validate_arrays(energy, mu)
    return energy.copy(), mu.copy()


def _finite(value: float | int | None) -> bool:
    return value is None or bool(np.isfinite(value))


def validate_recipe(
    recipe: RecipeDraft,
    energy: np.ndarray,
    *,
    max_nfft: int = 262_144,
) -> tuple[FieldIssue, ...]:
    """Report every invalid recipe field before invoking Larch."""
    issues: list[FieldIssue] = []
    numeric_fields = (
        "e0",
        "step",
        "pre1",
        "pre2",
        "norm1",
        "norm2",
        "rbkg",
        "kmin",
        "kmax",
        "autobk_dk",
        "ft_dk",
        "ft_dk2",
        "kstep",
        "rmax_out",
    )
    for field in numeric_fields:
        if not _finite(getattr(recipe, field)):
            issues.append(
                _issue(
                    "recipe_nonfinite",
                    f"{field} must be finite.",
                    field,
                    recovery="Enter a finite numeric value or leave it automatic.",
                )
            )

    if recipe.e0 is not None and not (float(energy.min()) <= recipe.e0 <= float(energy.max())):
        issues.append(
            _issue(
                "e0_out_of_range",
                "e0 must be within the selected energy range.",
                "e0",
                recovery="Choose an edge energy within the uploaded spectrum.",
            )
        )
    if recipe.step is not None and recipe.step <= 0:
        issues.append(_issue("step_invalid", "step must be greater than zero.", "step", recovery="Use a positive edge step or leave it automatic."))
    if recipe.rbkg <= 0:
        issues.append(_issue("rbkg_invalid", "rbkg must be greater than zero.", "rbkg", recovery="Use a positive Rbkg value."))
    if recipe.kmin < 0:
        issues.append(_issue("kmin_invalid", "kmin must be zero or greater.", "kmin", recovery="Use a non-negative k minimum."))
    if recipe.kmax is not None and recipe.kmax <= recipe.kmin:
        issues.append(_issue("k_range_invalid", "kmax must be greater than kmin.", "kmin", "kmax", recovery="Increase kmax or lower kmin."))
    if recipe.kweight not in (0, 1, 2, 3, 4):
        issues.append(_issue("kweight_invalid", "kweight must be an integer from 0 to 4.", "kweight", recovery="Choose a supported k-weight."))
    if recipe.nnorm is not None and recipe.nnorm not in (0, 1, 2, 3):
        issues.append(_issue("nnorm_invalid", "nnorm must be an integer from 0 to 3.", "nnorm", recovery="Choose a supported normalization degree."))
    if recipe.nfft < 128 or recipe.nfft & (recipe.nfft - 1):
        issues.append(_issue("nfft_invalid", "nfft must be a power of two of at least 128.", "nfft", recovery="Use a supported FFT size."))
    elif recipe.nfft > max_nfft:
        issues.append(
            _issue(
                "nfft_too_large",
                f"nfft must not exceed {max_nfft}.",
                "nfft",
                recovery="Use a smaller supported FFT size.",
            )
        )
    if recipe.kstep < 0.001:
        issues.append(
            _issue(
                "kstep_too_small",
                "kstep must be at least 0.001 Å⁻¹.",
                "kstep",
                recovery="Use a k step of 0.001 Å⁻¹ or greater.",
            )
        )
    if recipe.kstep > 0 and recipe.rmax_out > np.pi / (2 * recipe.kstep):
        issues.append(
            _issue(
                "rmax_out_invalid",
                "rmax_out exceeds the FFT range for the selected kstep.",
                "rmax_out",
                "kstep",
                recovery="Lower the R output limit or use a smaller k step.",
            )
        )
    for field in ("autobk_dk", "ft_dk", "ft_dk2", "kstep", "rmax_out"):
        value = getattr(recipe, field)
        if value is not None and value <= 0:
            issues.append(_issue("recipe_range_invalid", f"{field} must be greater than zero.", field, recovery="Use a positive value or leave it automatic."))
    for low, high in (("pre1", "pre2"), ("norm1", "norm2")):
        first, second = getattr(recipe, low), getattr(recipe, high)
        if first is not None and second is not None and first >= second:
            issues.append(_issue("energy_range_invalid", f"{low} must be lower than {high}.", low, high, recovery="Order the selected energy range."))
    return tuple(issues)


def _trace(
    trace_id: str, label: str, x_label: str, y_label: str, x_unit: str, y_unit: str,
    x: np.ndarray, y: np.ndarray,
) -> PlotTrace:
    x_values = np.asarray(x, dtype=float)
    y_values = np.asarray(y, dtype=float)
    if not np.isfinite(x_values).all() or not np.isfinite(y_values).all():
        raise WebInputError(
            "processing_nonfinite",
            "Larch returned non-finite processed values.",
            recovery="Adjust the recipe or inspect the source data.",
        )
    return PlotTrace(
        id=trace_id,
        label=label,
        x_label=x_label,
        y_label=y_label,
        x_unit=x_unit,
        y_unit=y_unit,
        x=tuple(float(value) for value in x_values),
        y=tuple(float(value) for value in y_values),
    )


def run_processing(
    energy: np.ndarray,
    mu: np.ndarray,
    recipe: RecipeDraft,
    *,
    max_nfft: int = 262_144,
) -> ProcessingResult:
    """Run the established Larch pipeline in a request-local Group."""
    energy_array = _as_array(energy).copy()
    mu_array = _as_array(mu).copy()
    _validate_arrays(energy_array, mu_array)
    issues = validate_recipe(recipe, energy_array, max_nfft=max_nfft)
    if issues:
        raise WebInputError(
            "invalid_recipe",
            "The processing recipe contains invalid values.",
            tuple(field for issue in issues for field in issue.fields),
            "Correct the highlighted controls and preview again.",
        )

    group = Group(energy=energy_array, mu=mu_array)
    pre_edge_kwargs = {
        key: value
        for key, value in {
            "e0": recipe.e0,
            "step": recipe.step,
            "nnorm": recipe.nnorm,
            "pre1": recipe.pre1,
            "pre2": recipe.pre2,
            "norm1": recipe.norm1,
            "norm2": recipe.norm2,
        }.items()
        if value is not None
    }
    autobk_kwargs = {
        "e0": group.e0 if hasattr(group, "e0") else None,
        "edge_step": group.edge_step if hasattr(group, "edge_step") else None,
        "rbkg": recipe.rbkg,
        "kmin": recipe.kmin,
        "kmax": recipe.kmax,
        "kweight": recipe.kweight,
        "nfft": recipe.nfft,
        "kstep": recipe.kstep,
    }
    if recipe.autobk_dk is not None:
        autobk_kwargs["dk"] = recipe.autobk_dk
    if recipe.autobk_window is not None:
        autobk_kwargs["win"] = recipe.autobk_window

    try:
        pre_edge(group.energy, group.mu, group=group, **pre_edge_kwargs)
        available_kmax = float(
            np.sqrt(max(0.0, ETOK * (float(group.energy.max()) - float(group.e0))))
        )
        if recipe.kmin >= available_kmax or (
            recipe.kmax is not None and recipe.kmax > available_kmax
        ):
            raise WebInputError(
                "invalid_recipe",
                "The selected k range exceeds the uploaded spectrum.",
                ("kmin", "kmax"),
                "Choose k bounds within the available data range.",
            )
        requested_autobk_kmax = (
            recipe.kmax if recipe.kmax is not None else available_kmax
        )
        requested_ft_kmax = recipe.kmax if recipe.kmax is not None else 20.0
        requested_ft_dk2 = recipe.ft_dk2 if recipe.ft_dk2 is not None else recipe.ft_dk
        grid_points = int(
            1.01
            + max(requested_autobk_kmax, requested_ft_kmax + requested_ft_dk2)
            / recipe.kstep
        )
        if grid_points > recipe.nfft:
            raise WebInputError(
                "invalid_recipe",
                "The k range and kstep require more points than nfft permits.",
                ("kmax", "kstep", "nfft"),
                "Increase nfft, increase kstep, or lower kmax.",
            )
        autobk_kwargs["e0"] = group.e0
        autobk_kwargs["edge_step"] = group.edge_step
        autobk(group.energy, group.mu, group=group, **autobk_kwargs)
        xftf_kwargs = {
            "group": group,
            "kmin": recipe.kmin,
            "kweight": recipe.kweight,
            "dk": recipe.ft_dk,
            "dk2": recipe.ft_dk2,
            "window": recipe.ft_window,
            "rmax_out": recipe.rmax_out,
            "nfft": recipe.nfft,
            "kstep": recipe.kstep,
        }
        # In this Larch version, automatic xftf kmax is represented by omitting
        # the argument; explicitly passing None raises inside xftf_prep().
        if recipe.kmax is not None:
            xftf_kwargs["kmax"] = recipe.kmax
        xftf(
            group.k,
            group.chi,
            **xftf_kwargs,
        )
    except WebInputError:
        raise
    except Exception as exc:
        raise WebInputError(
            "processing_failed",
            "Larch could not process this spectrum with the selected recipe.",
            recovery="Adjust the recipe or inspect the source data.",
        ) from exc

    traces = (
        _trace("raw_mu", "Raw μ(E)", "Energy", "μ", "eV", "arb. units", group.energy, group.mu),
        _trace("norm_mu", "Normalized μ(E)", "Energy", "Normalized μ", "eV", "unitless", group.energy, group.norm),
        _trace("chi_k", "χ(k)", "k", "χ(k)", "Å⁻¹", "unitless", group.k, group.chi),
        _trace("chi_r", "χ(R)", "R", "|χ(R)|", "Å", "unitless", group.r, group.chir_mag),
    )
    scalars = (group.e0, group.edge_step, group.k.max())
    if not all(np.isfinite(float(value)) for value in scalars):
        raise WebInputError("processing_nonfinite", "Larch returned non-finite derived values.", recovery="Adjust the recipe or inspect the source data.")
    autobk_effective = group.callargs.autobk
    ft_effective = group.callargs.xftf
    pre_effective = group.pre_edge_details
    return ProcessingResult(
        effective=EffectiveRecipe(
            e0=float(group.e0),
            e0_automatic=recipe.e0 is None,
            edge_step=float(group.edge_step),
            edge_step_automatic=recipe.step is None,
            pre1=float(pre_effective.pre1),
            pre1_automatic=recipe.pre1 is None,
            pre2=float(pre_effective.pre2),
            pre2_automatic=recipe.pre2 is None,
            norm1=float(pre_effective.norm1),
            norm1_automatic=recipe.norm1 is None,
            norm2=float(pre_effective.norm2),
            norm2_automatic=recipe.norm2 is None,
            nnorm=int(pre_effective.nnorm),
            nnorm_automatic=recipe.nnorm is None,
            rbkg=float(autobk_effective["rbkg"]),
            kweight=int(ft_effective["kweight"]),
            autobk_kmin=float(autobk_effective["kmin"]),
            autobk_kmax=float(group.k.max()),
            autobk_kmax_automatic=recipe.kmax is None,
            autobk_dk=float(autobk_effective["dk"]),
            autobk_dk_automatic=recipe.autobk_dk is None,
            autobk_window=str(autobk_effective["win"]),
            autobk_window_automatic=recipe.autobk_window is None,
            xftf_kmin=float(ft_effective["kmin"]),
            xftf_kmax=float(ft_effective["kmax"]),
            xftf_kmax_automatic=recipe.kmax is None,
            xftf_dk=float(ft_effective["dk"]),
            xftf_dk2=float(
                ft_effective["dk2"]
                if ft_effective["dk2"] is not None
                else ft_effective["dk"]
            ),
            xftf_dk2_automatic=recipe.ft_dk2 is None,
            xftf_window=str(ft_effective["window"]),
            nfft=int(ft_effective["nfft"]),
            kstep=float(ft_effective["kstep"]),
            rmax_out=float(ft_effective["rmax_out"]),
        ),
        plots=traces,
    )
