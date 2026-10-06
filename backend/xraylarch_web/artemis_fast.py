"""A differentiable EXAFS fit backend: feffit's residual, solved with gradients.

Larch's ``feffit`` evaluates the FEFF path equation in Python and hands lmfit a
residual it can only differentiate by finite differences, so every iteration
costs one model evaluation per variable plus one, and the derivatives carry the
step-size error that ``epsfcn`` trades against rounding. This module rebuilds
the *same* residual out of JAX primitives. The optimizer then gets an exact
Jacobian from automatic differentiation, and the whole residual compiles once
into fused machine code instead of being re-interpreted on every call.

Nothing here is a different fit. The forward model is the FEFF path equation
from the differentiable engine in ``xasforward.physics.exafs_paths``; the data,
the FEFF path arrays, the Fourier window, the noise scale epsilon and the count
of independent points all come from the very Larch objects the reference
backend uses, so the two engines minimize the same function of the same
numbers. :func:`fast_fit_group` reports the largest disagreement between the
two forward models at the converged parameters, as ``metadata.engine_parity``,
so a fit that drifted away from the reference says so in its own output.

The facade is deliberately narrow: :func:`build_residual_spec` turns a fit
request into a :class:`ResidualSpec`, :func:`solve` turns a
:class:`ResidualSpec` into parameters and a covariance matrix, and neither
knows anything about EXAFS. :func:`fast_fit_group` is the only part that does.

One correction is applied on the way into the engine. Larch computes the
energy-to-wavenumber constant from the CODATA values shipped by scipy, while
the engine hard-codes a literal from an earlier CODATA release; they differ by
4.4e-8 relative. Left alone that limits agreement in chi(k) to ~8e-8 wherever
E0 is refined. Because the constant enters only as the product ``e0 * ETOK``,
scaling E0 by the ratio of the two constants reproduces Larch exactly, with no
global state and no change to the gradients. See ``docs/artemis-web.md``.
"""

from __future__ import annotations

import ast
import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable

import numpy as np
from scipy.optimize import least_squares

from .artemis import (_LARCH_LOCK, _CONSTANTS, _PATH_PARAMETERS, _initial_values, _number, _timing, bound_notices,
                      FitRequest, display_epsilon, fit_arrays, fit_inputs)
from .errors import WebInputError

ENGINE = "xasforward.exafs_paths+jax"

# The engine is a research package rather than a PyPI release, so the app has to
# work without it. Import once, remember why it failed, and let the route turn
# the failure into an orderly "not available here" instead of a 500.
_IMPORT_ERROR: str | None = None
try:  # pragma: no cover - exercised by whether the import succeeds
    import jax

    jax.config.update("jax_enable_x64", True)
    import jax.numpy as jnp
    from xasforward.physics.exafs_paths import feff_path_chi
except Exception as exc:  # pragma: no cover - depends on the environment
    jax = jnp = feff_path_chi = None
    _IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

_COMPILE_LOCK = threading.RLock()

if jnp is not None:
    _JAX_FUNCTIONS = {"sqrt": jnp.sqrt, "exp": jnp.exp, "log": jnp.log, "sin": jnp.sin,
                      "cos": jnp.cos, "tan": jnp.tan, "abs": jnp.abs}
else:  # pragma: no cover - only when the engine is missing
    _JAX_FUNCTIONS = {}


def fast_engine_status() -> dict:
    """Whether the fast backend can run here, and if not, what is missing."""
    if _IMPORT_ERROR is None:
        return dict(available=True, engine=ENGINE, jax_version=str(jax.__version__), reason=None)
    return dict(available=False, engine=ENGINE, jax_version=None, reason=_IMPORT_ERROR)


def _require_engine() -> None:
    if _IMPORT_ERROR is not None:
        raise WebInputError(
            "fast_engine_unavailable",
            "The fast fitting backend is not installed in this deployment.",
            fields=("engine",),
            recovery="Use the default Larch backend, or install the differentiable EXAFS engine "
                     "(jax and xasforward) and restart the server.")


# ---------------------------------------------------------------------------
# The facade: a residual specification in, parameters and a covariance out.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ResidualSpec:
    """Everything a least-squares solver needs, and nothing about EXAFS.

    ``residual`` maps the variable vector to the weighted residual vector and
    must be differentiable by JAX. ``derived`` maps the same vector to every
    reported quantity that is a function of it -- constrained parameters and
    per-path parameter values -- so that uncertainties can be propagated to
    them from the covariance without a second parameterisation of the model.

    ``n_independent`` is the EXAFS count of independent points, which is
    smaller than the number of residual points because the Fourier transform
    oversamples; chi-square and every uncertainty are scaled to it, following
    the same convention as feffit.
    """

    names: tuple[str, ...]
    initial: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    residual: Callable
    n_independent: float
    data_residual: np.ndarray
    derived: Callable


@dataclass(frozen=True)
class FastFitResult:
    """Fitted parameters with their covariance, and the usual fit statistics."""

    values: dict[str, float]
    stderr: dict[str, float | None]
    covariance: np.ndarray | None
    correlation: dict[tuple[str, str], float]
    derived: dict[str, float]
    derived_stderr: dict[str, float | None]
    success: bool
    errorbars: bool
    message: str
    statistics: dict
    residual: np.ndarray
    seconds: dict[str, float]
    notice: str | None = None


def solve(spec: ResidualSpec, *, max_nfev: int = 2000, tol: float = 1e-10) -> FastFitResult:
    """Minimize ``spec.residual`` and return parameters with their covariance.

    The Jacobian is exact, so the tolerances can be far tighter than the 1e-6
    feffit uses for its finite-difference fit without costing extra iterations.
    """
    _require_engine()
    start = time.perf_counter()
    with _COMPILE_LOCK:
        residual = jax.jit(spec.residual)
        jacobian = jax.jit(jax.jacfwd(spec.residual))
        # Compile both before timing the solve, so the reported optimizer time
        # is the optimizer and not one-off tracing.
        probe = np.asarray(residual(spec.initial))
        jacobian(spec.initial).block_until_ready()
    compiled = time.perf_counter()

    def as_float(vector):
        return np.asarray(residual(jnp.asarray(vector)), dtype=float)

    def as_jac(vector):
        return np.asarray(jacobian(jnp.asarray(vector)), dtype=float)

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            fit = least_squares(as_float, spec.initial, jac=as_jac,
                                bounds=(spec.lower, spec.upper), method="trf",
                                xtol=tol, ftol=tol, gtol=tol, max_nfev=max_nfev)
    except Exception as exc:
        raise WebInputError(
            "artemis_fit_failed",
            "The fast backend could not fit this model. Check parameter expressions, bounds, "
            "path files, and fitting ranges.",
            fields=("fit",),
            recovery="Try physically meaningful starting values and tighter bounds; reduce free "
                     "parameters if the model is underdetermined.") from exc
    solved = time.perf_counter()

    best = np.asarray(fit.x, dtype=float)
    resid = np.asarray(fit.fun, dtype=float)
    npts, nvarys = len(resid), len(best)
    n_idp = spec.n_independent
    chisqr = float((resid ** 2).sum())

    # feffit rescales chi-square from the oversampled residual to the number of
    # independent points, and rescales the covariance by the same chi-square
    # per independent degree of freedom because it fits with scale_covar=False.
    # Reproduce both, or the error bars are not comparable with the reference.
    chi_square = chisqr * n_idp / npts
    denominator = n_idp - nvarys
    chi2_reduced = chi_square / denominator
    err_scale = chisqr / denominator

    jac = as_jac(best)
    covariance, condition, rank, notice = _covariance(jac, err_scale, spec.names)
    errorbars = covariance is not None

    values = {name: float(value) for name, value in zip(spec.names, best)}
    sigma = np.sqrt(np.diag(covariance)) if errorbars else np.full(nvarys, np.nan)
    stderr = {name: (float(value) if np.isfinite(value) else None)
              for name, value in zip(spec.names, sigma)}

    correlation = {}
    if errorbars:
        for i, left in enumerate(spec.names):
            for j, right in enumerate(spec.names):
                if i < j and sigma[i] > 0 and sigma[j] > 0:
                    correlation[(left, right)] = float(covariance[i, j] / (sigma[i] * sigma[j]))

    # Constrained parameters are smooth functions of the variables, so their
    # uncertainty is the quadratic form g^T C g of the same covariance -- the
    # first-order propagation feffit does with correlated_values, but with the
    # gradient taken analytically rather than from the expression graph.
    derived_values, derived_gradients = spec.derived(best)
    derived = {name: float(value) for name, value in derived_values.items()}
    derived_stderr: dict[str, float | None] = {}
    for name, gradient in derived_gradients.items():
        if not errorbars:
            derived_stderr[name] = None
            continue
        gradient = np.asarray(gradient, dtype=float)
        variance = float(gradient @ covariance @ gradient)
        derived_stderr[name] = float(np.sqrt(variance)) if variance >= 0 else None

    data_sum = float((spec.data_residual ** 2).sum())
    neg2_loglikel = n_idp * math.log(chi_square / n_idp) if chi_square > 0 else -np.inf
    statistics = dict(
        n_varys=nvarys, n_independent=float(n_idp), n_data=npts, nfev=int(fit.nfev),
        chi_square=chi_square, reduced_chi_square=chi2_reduced,
        r_factor=(chisqr / data_sum if data_sum > 0 else float("nan")),
        aic=neg2_loglikel + 2 * nvarys, bic=neg2_loglikel + math.log(n_idp) * nvarys,
        errorbars=errorbars, jacobian_condition=condition, jacobian_rank=rank)

    return FastFitResult(
        values=values, stderr=stderr, covariance=covariance, correlation=correlation,
        derived=derived, derived_stderr=derived_stderr,
        success=bool(fit.success), errorbars=errorbars, message=str(fit.message),
        statistics=statistics, residual=resid,
        seconds=dict(compile=compiled - start, optimizer=solved - compiled, covariance=time.perf_counter() - solved),
        notice=notice)


# Past this condition number of the column-scaled Jacobian, two or more
# parameters move the residual in directions the data cannot tell apart, and an
# inverse returns finite errors that describe the round-off rather than the fit.
MAX_CONDITION = 1e8


def _covariance(jac: np.ndarray, err_scale: float, names) -> tuple[np.ndarray | None, float | None, int, str | None]:
    """Parameter covariance from the Jacobian at the minimum, or a reason it has none.

    The columns are scaled to unit length first, so the condition number
    measures how nearly parallel the parameters' effects are rather than how
    different their units are (an E0 in eV beside a sigma² in Å²). The inverse
    is then formed from the SVD, which does not square the condition number the
    way inverting JᵀJ does. A parameter the residual does not depend on, a rank
    below the parameter count, or a condition past MAX_CONDITION withholds the
    covariance; feffit would report errors there that mean nothing.
    """
    count = jac.shape[1]
    norms = np.linalg.norm(jac, axis=0)
    if not np.all(np.isfinite(jac)):
        return None, None, 0, "The Jacobian at the solution is not finite, so no uncertainties are reported."
    dead = [name for name, norm in zip(names, norms) if norm == 0]
    if dead:
        return None, None, count - len(dead), (f"The fit does not depend on {', '.join(dead)} at the solution, "
                                               "so no uncertainties are reported. Fix or remove it.")
    scaled = jac / norms
    try:
        _, singular, vt = np.linalg.svd(scaled, full_matrices=False)
    except np.linalg.LinAlgError:
        return None, None, 0, "The Jacobian could not be decomposed, so no uncertainties are reported."
    rank = int(np.sum(singular > singular[0] * max(scaled.shape) * np.finfo(float).eps))
    condition = float(singular[0] / singular[-1]) if singular[-1] > 0 else math.inf
    if rank < count or condition > MAX_CONDITION:
        return None, (condition if math.isfinite(condition) else None), rank, (
            f"The parameters are not independently determined (Jacobian rank {rank} of {count}, "
            f"condition number {condition:.2g}), so no uncertainties are reported. "
            "Remove or constrain a correlated parameter.")
    scaled_cov = (vt.T / singular ** 2) @ vt
    covariance = scaled_cov / np.outer(norms, norms) * err_scale
    if not np.all(np.isfinite(covariance)) or np.any(np.diag(covariance) < 0):
        return None, condition, rank, "The covariance is not finite, so no uncertainties are reported."
    return covariance, condition, rank, None


# ---------------------------------------------------------------------------
# EXAFS: building the residual that feffit would have built.
# ---------------------------------------------------------------------------

def _jax_evaluate(node: ast.AST, values: dict):
    """Evaluate one checked expression tree on traced values.

    The sibling of ``artemis._evaluate``. That one casts to ``float`` and
    rejects anything that is not finite, which a JAX tracer is not; this one
    keeps the computation symbolic so the optimizer can differentiate through
    parameter constraints. Both read trees that ``artemis._expression`` has
    already restricted to arithmetic and a handful of named functions.
    """
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        return values[node.id] if node.id in values else _CONSTANTS[node.id]
    if isinstance(node, ast.UnaryOp):
        operand = _jax_evaluate(node.operand, values)
        return -operand if isinstance(node.op, ast.USub) else operand
    if isinstance(node, ast.Call):
        return _JAX_FUNCTIONS[node.func.id](_jax_evaluate(node.args[0], values))
    left, right = _jax_evaluate(node.left, values), _jax_evaluate(node.right, values)
    if isinstance(node.op, ast.Add):
        return left + right
    if isinstance(node.op, ast.Sub):
        return left - right
    if isinstance(node.op, ast.Mult):
        return left * right
    if isinstance(node.op, ast.Div):
        return left / right
    return left ** right


def _realimag(values):
    """Interleave real and imaginary parts, as Larch's ``realimag`` does."""
    return jnp.stack([jnp.real(values), jnp.imag(values)], axis=-1).ravel()


def _energy_scale() -> float:
    """Ratio that makes the engine's ``e0 * ETOK`` use Larch's CODATA constant."""
    from larch.xafs.xafsutils import ETOK as larch_etok
    from xasforward.physics.exafs_paths.formula import ETOK as engine_etok

    return float(larch_etok / engine_etok)


def build_residual_spec(dataset, transform, path_arrays, trees, parameters) -> ResidualSpec:
    """Translate a prepared Larch dataset into a differentiable residual.

    ``dataset`` must already have been through ``prepare_fit``: that is what
    settles the model k grid, interpolates the data onto it, and fixes the
    noise scale epsilon and the number of independent points. Taking those from
    Larch rather than recomputing them is the point -- it is what makes the two
    backends comparable rather than merely similar.
    """
    _require_engine()
    energy_scale = _energy_scale()
    model_k = np.asarray(dataset.model.k, dtype=float)
    nk = len(model_k)
    chi_data = jnp.asarray(np.asarray(dataset._chi, dtype=float))
    k_grid = jnp.asarray(model_k)

    kweights = transform.kweight if isinstance(transform.kweight, (list, tuple)) else [transform.kweight]
    kweights = [int(weight) for weight in kweights]
    kstep, nfft = float(transform.kstep), int(transform.nfft)

    if getattr(transform, "kwin", None) is None:  # pragma: no cover - set by estimate_noise
        transform.fftf(np.zeros(nk))
    kwin = jnp.asarray(np.asarray(transform.kwin[:nk], dtype=float))

    def as_list(value):
        return list(value) if isinstance(value, (list, tuple)) else [value] * len(kweights)

    eps_r = [float(np.mean(value)) for value in as_list(dataset.epsilon_r)]
    eps_k = [float(np.mean(value)) for value in as_list(dataset.epsilon_k)]

    fitspace = transform.fitspace
    rstep = float(transform.rstep)
    irmin = int(max(0, 0.01 + transform.rmin / rstep))
    irmax = int(min(nfft / 2, 0.01 + transform.rmax / rstep))
    iqmin = int(max(0, 0.01 + transform.kmin / kstep))
    iqmax = int(min(nfft / 2, 0.01 + transform.kmax / kstep))

    definitions, initial_values, ordered, _ = _initial_values(parameters)
    guesses = [item.name for item in parameters if item.kind == "guess"]
    fixed = {item.name: float(item.value) for item in parameters if item.kind == "set"}
    def_order = [item.name for item in ordered if item.kind == "def"]
    def_trees = {item.name: _expression_tree(item, definitions) for item in parameters
                 if item.kind == "def"}

    def resolve(vector):
        """Every named parameter, as a function of the free variables."""
        values = dict(fixed)
        for index, name in enumerate(guesses):
            values[name] = vector[index]
        for name in def_order:
            values[name] = _jax_evaluate(def_trees[name], values)
        return values

    def model_chi(vector):
        values = resolve(vector)
        total = jnp.zeros(nk)
        for record in path_arrays:
            local = values | record["constants"]
            tree = trees[record["id"]]
            total = total + feff_path_chi(
                k_grid, feff_k=record["k"], amp=record["amp"], phase=record["phase"],
                real_p=record["real_p"], mean_free_path=record["lam"],
                reff=record["reff"], degen=record["degen"],
                S02=_jax_evaluate(tree["s02"], local),
                e0=_jax_evaluate(tree["e0"], local) * energy_scale,
                deltar=_jax_evaluate(tree["deltar"], local),
                sigma2=_jax_evaluate(tree["sigma2"], local),
                interp="cubic", larch_zero_fix=True)
        return total

    def transform_difference(diff):
        """Apply feffit's fit-space transform to a data-minus-model difference."""
        parts = []
        for index, weight in enumerate(kweights):
            if fitspace == "k":
                parts.append(((diff / eps_k[index]) * k_grid ** weight)[iqmin:iqmax])
            else:
                padded = jnp.zeros(nfft).at[:nk].set(diff * kwin * k_grid ** weight)
                chir = jnp.fft.fft(padded)[: nfft // 2] * (kstep / jnp.sqrt(jnp.pi))
                parts.append(_realimag(chir[irmin:irmax] / eps_r[index]))
        return jnp.concatenate(parts)

    def residual(vector):
        return transform_difference(chi_data - model_chi(vector))

    def derived(vector):
        """Reported quantities that are functions of the variables, with gradients."""
        vector = jnp.asarray(vector)

        def every(values_vector):
            values = resolve(values_vector)
            out = {name: values[name] for name in def_order}
            for record in path_arrays:
                local = values | record["constants"]
                for field in _PATH_PARAMETERS:
                    out[f"{record['id']}.{field}"] = _jax_evaluate(trees[record["id"]][field], local)
            return out

        values = {name: float(value) for name, value in every(vector).items()}
        gradients = jax.jacfwd(every)(vector)
        return values, {name: np.asarray(value, dtype=float) for name, value in gradients.items()}

    initial = np.array([float(initial_values[name]) for name in guesses], dtype=float)
    lower = np.array([definitions[name].min if definitions[name].min is not None else -np.inf
                      for name in guesses], dtype=float)
    upper = np.array([definitions[name].max if definitions[name].max is not None else np.inf
                      for name in guesses], dtype=float)
    # trf needs a strictly interior start; nudge a parameter that begins on its bound.
    initial = np.clip(initial, np.nextafter(lower, np.inf), np.nextafter(upper, -np.inf))

    return ResidualSpec(
        names=tuple(guesses), initial=initial, lower=lower, upper=upper,
        residual=residual, n_independent=float(dataset.n_idp),
        data_residual=np.asarray(transform_difference(chi_data), dtype=float),
        derived=derived)


def _expression_tree(item, definitions):
    from .artemis import _expression

    tree, _ = _expression(item.expression, set(definitions), item.name)
    return tree


def _path_arrays(inputs) -> list[dict]:
    """The FEFF arrays each path contributes, as device arrays the engine takes."""
    records = []
    for path, record in zip(inputs.paths, inputs.path_records):
        fdat = path._feffdat
        records.append(dict(
            id=record["id"],
            k=jnp.asarray(np.asarray(fdat.k, dtype=float)),
            amp=jnp.asarray(np.asarray(fdat.amp, dtype=float)),
            phase=jnp.asarray(np.asarray(fdat.pha, dtype=float)),
            real_p=jnp.asarray(np.asarray(fdat.rep, dtype=float)),
            lam=jnp.asarray(np.asarray(fdat.lam, dtype=float)),
            reff=float(fdat.reff), degen=float(path.degen),
            constants={key: float(record["metadata"][key]) for key in ("reff", "degen", "nleg")}))
    return records


# ---------------------------------------------------------------------------
# The route's entry point.
# ---------------------------------------------------------------------------

def fast_fit_group(group: dict, request: FitRequest) -> dict:
    """Fit one dataset with the differentiable backend, in feffit's own terms.

    The request is read by the same code the reference backend uses, and the
    dataset is prepared by Larch, so the k grid, the noise scale and the count
    of independent points are not reinvented here. Only the minimization is
    different. Afterwards the fitted values are written back into the Larch
    parameters and Larch recomputes its own model, which both produces the
    curves to plot and gives an independent check of the forward model.
    """
    _require_engine()
    from larch.fitting import group2params

    handler_started = time.perf_counter()
    with _LARCH_LOCK, TemporaryDirectory(prefix="artemis-fast-fit-") as directory:
        inputs = fit_inputs(group, request, Path(directory))
        if inputs.disorder:
            # The differentiable forward model has no Debye or Einstein sigma²;
            # refuse rather than fit a model other than the one typed.
            raise WebInputError("fast_fit_unsupported", "The fast backend cannot fit Debye or Einstein sigma² models.",
                                fields=("paths",), recovery="Run the reference Larch fit for this model.")
        dataset, notices = inputs.dataset, inputs.notices
        # The same phase feffit's own call covers: set-up, minimization,
        # uncertainties, and the output arrays written back into the dataset.
        fit_started = time.perf_counter()
        params = group2params(inputs.parameters)
        dataset.prepare_fit(params)

        spec = build_residual_spec(dataset, inputs.transform, _path_arrays(inputs),
                                   inputs.trees, request.parameters)
        result = solve(spec)

        # Hand the answer back to Larch and let it rebuild everything it would
        # have built after a fit of its own: the model chi(k), the per-path
        # curves, and the Fourier transforms the plots are drawn from.
        for name, value in result.values.items():
            params[name].value = value
        params.update_constraints()
        larch_residual = dataset._residual(params)
        dataset.save_outputs(rmax_out=10, path_outputs=True)
        fit_seconds = time.perf_counter() - fit_started

        # The two forward models are now standing at the same parameters, so
        # their difference is a measurement rather than an assumption. Report
        # it: a fit that has drifted from the reference says so in its output.
        parity = float(np.max(np.abs(np.asarray(larch_residual, dtype=float) - result.residual)))

        arrays = fit_arrays(request, inputs)
        parameter_rows, correlations = [], []
        for definition in request.parameters:
            if definition.kind == "guess":
                value, stderr = result.values[definition.name], result.stderr[definition.name]
            elif definition.kind == "def":
                value, stderr = result.derived[definition.name], result.derived_stderr[definition.name]
            else:
                value, stderr = float(definition.value), None
            parameter_rows.append(dict(name=definition.name, kind=definition.kind, value=_number(value),
                                       initial=inputs.initial_values[definition.name],
                                       stderr=(None if stderr is None else _number(stderr, nullable=True)),
                                       min=definition.min, max=definition.max,
                                       expression=definition.expression))
        for (left, right), value in result.correlation.items():
            correlations.append(dict(left=min(left, right), right=max(left, right), value=_number(value)))
        correlations.sort(key=lambda row: -abs(row["value"]))

        if result.notice:
            notices.append(result.notice)
        elif not result.errorbars:
            notices.append("The fast backend could not determine reliable parameter uncertainties; inspect parameter correlations and model constraints.")
        if not result.success:
            notices.append("The optimizer did not converge. These are the final attempted parameters, not a converged fit.")
        notices.extend(bound_notices(parameter_rows))
        notices.append(f"Fast backend: the reference and differentiable forward models differ by at most "
                       f"{parity:.2e} in the weighted residual at these parameters.")

        statistics = dict(result.statistics, epsilon_k=_number(display_epsilon(dataset)))
        response = dict(group_id=group["id"], group_label=group.get("label", ""),
                        success=result.success, message=result.message,
                        report=_report(request, inputs, result, parity),
                        warnings=notices, statistics=statistics, parameters=parameter_rows,
                        correlations=correlations, paths=inputs.path_records,
                        transform=request.transform.model_dump(),
                        metadata=dict(engine=ENGINE, kstep=0.05, nfft=2048, rwindow="hanning",
                                      phase_corrected=False, noise="Larch high-R estimate (15–30 Å)",
                                      background_refined=False,
                                      r_residual="complex data minus model; residual_mag is its magnitude",
                                      engine_parity=parity),
                        **arrays)
        response["metadata"]["seconds"] = _timing(dict(result.seconds, fit=fit_seconds,
                                                       total=time.perf_counter() - handler_started))
        return response


def _report(request: FitRequest, inputs, result: FastFitResult, parity: float) -> str:
    """A plain-text report in the spirit of feffit_report, for the same panel."""
    stats = result.statistics
    lines = ["=================== FAST FIT (differentiable backend) ===================",
             f"   engine             = {ENGINE}",
             f"   message            = {result.message}",
             f"   n_function_calls   = {stats['nfev']}",
             f"   n_variables        = {stats['n_varys']}",
             f"   n_data_points      = {stats['n_data']}",
             f"   n_independent      = {stats['n_independent']:.3f}",
             f"   chi_square         = {stats['chi_square']:.6g}",
             f"   reduced chi_square = {stats['reduced_chi_square']:.6g}",
             f"   r-factor           = {stats['r_factor']:.6g}",
             f"   Akaike info crit   = {stats['aic']:.6g}",
             f"   Bayesian info crit = {stats['bic']:.6g}",
             "",
             f"   compile time       = {result.seconds['compile']:.3f} s",
             f"   optimizer time     = {result.seconds['optimizer']:.3f} s",
             f"   forward-model parity vs larch = {parity:.3e} (weighted residual)",
             "",
             "Variables:"]
    for name in result.values:
        stderr = result.stderr[name]
        shown = "unknown" if stderr is None else f"+/- {stderr:.6g}"
        lines.append(f"   {name:<16} = {result.values[name]:.6g}  {shown}  "
                     f"(init= {inputs.initial_values[name]:.6g})")
    if result.derived:
        lines.append("")
        lines.append("Derived values:")
        for name in sorted(result.derived):
            stderr = result.derived_stderr.get(name)
            shown = "unknown" if stderr is None else f"+/- {stderr:.6g}"
            lines.append(f"   {name:<16} = {result.derived[name]:.6g}  {shown}")
    if result.correlation:
        lines.append("")
        lines.append("Correlations (unreported correlations are < 0.100):")
        for (left, right), value in sorted(result.correlation.items(), key=lambda row: -abs(row[1])):
            if abs(value) >= 0.1:
                lines.append(f"   {left:<12} {right:<12} = {value:+.3f}")
    lines.append("=" * 73)
    return "\n".join(lines)
