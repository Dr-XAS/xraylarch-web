"""Bounded, stateless Athena operations; inputs are never modified.

Energy and energy widths are in eV, except ``dispersive`` takes pixel numbers.
Signals retain their input units unless documented otherwise. Unknown options
and operations raise ValueError. No user expressions are evaluated.

Scientific references: local larch/xafs/{rebin_xafs,deconvolve,fluo}.py;
https://xraypy.github.io/xraylarch/xafs_preedge.html and
https://bruceravel.github.io/demeter/documents/Athena/process/mee.html and
https://bruceravel.github.io/demeter/documents/Athena/analysis/lr.html.
"""

from __future__ import annotations

from collections.abc import Mapping
from numbers import Real

import numpy as np
from larch import Group
from larch.math.lineshapes import step as larch_step
from larch.xafs import fluo_corr, rebin_xafs, xas_deconvolve
from larch.xafs.pre_edge import preedge
from larch.xafs.xafsutils import KTOE, TINY_ENERGY
from lmfit.models import GaussianModel, LinearModel, LorentzianModel, VoigtModel
from scipy.signal import fftconvolve, savgol_filter
from xraydb import chemparse, material_mu, xray_edge, xray_line

MAX_POINTS = 100_000
MAX_GRID_POINTS = 100_000
MAX_WORK = 50_000_000
MAX_PEAKS = 12
MAX_FIT_POINTS = 20_000
MAX_NFEV = 5_000


def _array(values, name, *, complex_values=False):
    try:
        raw = np.asarray(values)
        kinds = "iufc" if complex_values else "iuf"
        if raw.dtype.kind not in kinds or raw.ndim != 1:
            raise ValueError
        if not 2 <= raw.size <= MAX_POINTS:
            raise ValueError
        result = raw.astype(complex if complex_values else float, copy=True)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(
            f"{name} must be a one-dimensional numeric array of 2–{MAX_POINTS} points."
        ) from exc
    if not np.isfinite(result).all() or np.any(np.abs(result) > 1e50):
        raise ValueError(f"{name} must contain finite numbers with magnitude at most 1e50.")
    return result


def _xy(x, y, *, names=("energy", "mu")):
    x, y = _array(x, names[0]), _array(y, names[1])
    if x.size != y.size:
        raise ValueError(f"{names[0]} and {names[1]} must have the same length.")
    if np.any(np.diff(x) <= 0):
        raise ValueError(f"{names[0]} must be strictly increasing; remove duplicates and sort paired data.")
    if np.any(np.abs(x) > 1e9):
        raise ValueError(f"{names[0]} must have magnitude at most 1e9; check the units.")
    return x, y


def _options(options, allowed):
    if options is None:
        return {}
    if not isinstance(options, Mapping):
        raise ValueError("options must be a dictionary.")
    unknown = set(options) - set(allowed)
    if unknown:
        raise ValueError(f"Unsupported options: {', '.join(sorted(map(str, unknown)))}.")
    return dict(options)


def _number(value, name, *, positive=False):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite number.")
    try:
        value = float(value)
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite number.") from exc
    if not np.isfinite(value) or abs(value) > 1e50:
        raise ValueError(f"{name} must be finite with magnitude at most 1e50.")
    if positive and value <= 0:
        raise ValueError(f"{name} must be greater than zero.")
    return value


def _integer(value, name, low, high):
    number = _number(value, name)
    if number != int(number) or not low <= number <= high:
        raise ValueError(f"{name} must be an integer from {low} to {high}.")
    return int(number)


def _choice(value, name, choices):
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{name} must be one of: {', '.join(choices)}.")
    return value


def _range(x, options, *, names=("xmin", "xmax"), minimum=2):
    low = _number(options.get(names[0], x[0]), names[0])
    high = _number(options.get(names[1], x[-1]), names[1])
    if not x[0] <= low < high <= x[-1]:
        raise ValueError(
            f"Require {names[0]} < {names[1]} within the measured range [{x[0]:g}, {x[-1]:g}]."
        )
    mask = (x >= low) & (x <= high)
    if mask.sum() < minimum:
        raise ValueError(f"The selected range must contain at least {minimum} measured points.")
    return low, high, mask


def _savgol_settings(options, size, *, window_key="window", order_key="order"):
    window = _integer(options.get(window_key, 7), window_key, 3, min(501, size))
    order = _integer(options.get(order_key, 2), order_key, 0, 5)
    if window % 2 != 1 or order >= window - 1:
        raise ValueError(f"{window_key} must be odd and at least {order_key} + 2.")
    return window, order


def _smooth(x, y, options):
    window, order = _savgol_settings(options, x.size)
    if x.size * window * (order + 1) ** 2 > MAX_WORK:
        raise ValueError("Smoothing work limit exceeded; reduce the window, order, or number of points.")
    uniform = np.allclose(np.diff(x), x[1] - x[0], rtol=1e-6, atol=1e-10)
    if uniform:
        out = savgol_filter(y, window, order, mode="interp")
    else:
        # Generalized SG: fit against actual energy, not sample index, on an
        # irregular XAFS grid. Shift/scale the local abscissa for conditioning.
        out = np.empty_like(y)
        for i in range(x.size):
            start = min(max(i - window // 2, 0), x.size - window)
            local_x = x[start:start + window] - x[i]
            local_x /= np.max(np.abs(local_x))
            design = np.polynomial.polynomial.polyvander(local_x, order)
            coef, _, rank, _ = np.linalg.lstsq(design, y[start:start + window], rcond=None)
            if rank != order + 1:
                raise ValueError("Smoothing window is ill-conditioned; reduce the polynomial order.")
            out[i] = coef[0]
    return x, out, {"window": window, "order": order,
                    "method": "scipy.savgol_filter" if uniform else "local_polynomial_least_squares",
                    "window_units": "samples", "boundary": "shifted full polynomial window"}


def _deglitch(x, y, options):
    selectors = int("indices" in options) + int("points" in options) + int(
        "xmin" in options or "xmax" in options
    )
    if selectors != 1:
        raise ValueError("Select glitches with exactly one of indices, points, or xmin/xmax.")
    mask = np.zeros(x.size, dtype=bool)
    if "indices" in options or "points" in options:
        key = "indices" if "indices" in options else "points"
        values = options[key]
        if not isinstance(values, (list, tuple, np.ndarray)) or not 1 <= len(values) <= x.size:
            raise ValueError(f"{key} must be a nonempty sequence no longer than the spectrum.")
        if key == "indices":
            indices = [_integer(value, "glitch index", 0, x.size - 1) for value in values]
        else:
            points = np.array([_number(value, "glitch energy") for value in values])
            right = np.clip(np.searchsorted(x, points), 1, x.size - 1)
            indices = np.where(np.abs(x[right] - points) < np.abs(x[right - 1] - points), right, right - 1)
            tolerance = max(1e-10, float(np.min(np.diff(x))) * 1e-6)
            if np.any(np.abs(x[indices] - points) > tolerance):
                raise ValueError("Each selected point must match a measured energy; use indices for row selections.")
        mask[indices] = True
    else:
        if not {"xmin", "xmax"} <= options.keys():
            raise ValueError("Deglitching a range requires both xmin and xmax.")
        _, _, mask = _range(x, options, minimum=1)
    if mask[0] or mask[-1] or (~mask).sum() < 2:
        raise ValueError("Glitches must have unselected points on both sides; endpoint extrapolation is not supported.")
    out = y.copy()
    out[mask] = np.interp(x[mask], x[~mask], y[~mask])
    return x, out, {"method": "linear_interpolation", "indices": np.flatnonzero(mask).tolist(),
                    "replaced_points": int(mask.sum())}


def _rebin(x, y, options):
    e0 = _number(options.get("e0"), "e0", positive=True)
    pre_step = _number(options.get("pre_step", 2), "pre_step", positive=True)
    xanes_step = _number(options.get("xanes_step", 0.05 * max(1, int(e0 / 1250))),
                         "xanes_step", positive=True)
    kstep = _number(options.get("exafs_kstep", 0.05), "exafs_kstep", positive=True)
    bounds = {name: _number(options.get(name, default), name) for name, default in (
        ("pre1", x[0] - e0), ("pre2", -30), ("exafs1", 15), ("exafs2", x[-1] - e0)
    )}
    p1, p2, ex1, ex2 = (bounds[name] for name in ("pre1", "pre2", "exafs1", "exafs2"))
    if not x[0] - e0 <= p1 < p2 < 0 < ex1 < ex2 <= x[-1] - e0:
        raise ValueError("Rebin requires pre1 < pre2 < 0 < exafs1 < exafs2, all relative to e0 and within measured energies.")
    widths = (p2 - p1, ex1 - p2, np.sqrt(ex2 / KTOE) - np.sqrt(ex1 / KTOE))
    steps = (pre_step, xanes_step, kstep)
    if any(step > width for step, width in zip(steps, widths)) or ex2 - ex1 < 20 * kstep:
        raise ValueError("Each rebin region must span at least one requested step (EXAFS energy span also >= 20 * exafs_kstep).")
    estimated = sum(width / step + 2 for width, step in zip(widths, steps))
    if estimated > 20_000 or estimated * x.size > MAX_WORK:
        raise ValueError("Rebin grid exceeds the work limit; increase the steps or truncate the input spectrum.")
    method = _choice(options.get("method", "boxcar"), "method", ("boxcar", "centroid", "spline"))
    # Larch's last bin consumes the rest of its input. Crop first, otherwise
    # samples beyond requested exafs2 would contaminate the final bin.
    lo, hi = e0 + p1, e0 + ex2
    cropped = x[(x > lo) & (x < hi)]
    source_x = np.concatenate(([lo], cropped, [hi]))
    source_y = np.interp(source_x, x, y)
    if source_x.size < 4:
        raise ValueError("Rebinning requires at least four samples in the requested range.")
    group = Group(__name__="athena_operation")
    rebin_xafs(source_x, source_y, group=group, e0=e0, **bounds, pre_step=pre_step,
               xanes_step=xanes_step, exafs_kstep=kstep, method=method)
    return group.rebinned.energy, group.rebinned.mu, {
        "method": "larch.rebin_xafs", "bin_method": method, "e0": e0, **bounds,
        "pre_step": pre_step, "xanes_step": xanes_step, "exafs_kstep": kstep,
        "assumptions": "Region limits are relative eV; EXAFS step is inverse angstrom. Larch adjusts steps to fit each region and omits the final endpoint. Sparse bins use interpolation. Source is cropped to pre1/exafs2 with interpolated boundary samples.",
    }


def _convolve(x, y, options):
    form = _choice(options.get("form", "gaussian"), "form", ("gaussian", "lorentzian"))
    width = _number(options.get("width", 1), "width", positive=True)
    step = min(float(np.min(np.diff(x))), width / 4)
    estimated = (x[-1] - x[0]) / step + 2
    if estimated > MAX_GRID_POINTS:
        raise ValueError("Convolution grid is too large; increase width or rebin the input spectrum.")
    # Avoid adding an unnecessary interval because the minimum difference of
    # an otherwise uniform float grid is a few ulps below its nominal spacing.
    intervals = max(1, int(np.ceil((estimated - 2) * (1 - 1e-12))))
    grid = np.linspace(x[0], x[-1], intervals + 1)
    step = float(grid[1] - grid[0])
    cutoff = 8 if form == "gaussian" else 100
    radius_estimate = cutoff * width / step
    if radius_estimate > 200_000 or grid.size + 2 * radius_estimate > 500_000:
        raise ValueError("Convolution kernel is too large; reduce width or rebin to a coarser grid.")
    radius = max(1, int(np.ceil(radius_estimate)))
    z = np.arange(-radius, radius + 1) * (step / width)
    kernel = np.exp(-0.5 * z**2) if form == "gaussian" else 1 / (1 + z**2)
    kernel /= kernel.sum()
    padded = np.pad(np.interp(grid, x, y), radius, mode="edge")
    out = fftconvolve(padded, kernel, mode="valid")
    return x, np.interp(x, grid, out), {
        "method": "scipy.fftconvolve", "form": form, "width": width,
        "width_definition": "Gaussian standard deviation" if form == "gaussian" else "Lorentzian HWHM",
        "grid_step_eV": step, "kernel_cutoff_widths": cutoff,
        "assumptions": "Symmetric unit-area kernel, truncated and renormalized; constant endpoint extension. Linear interpolation to/from a uniform energy grid; no energy shift.",
    }


def _deconvolve(x, y, options):
    form = _choice(options.get("form", "lorentzian"), "form", ("gaussian", "lorentzian"))
    if "width" in options and "esigma" in options:
        raise ValueError("Specify only esigma or its alias width.")
    sigma = _number(options.get("esigma", options.get("width", 1)), "esigma", positive=True)
    shift = _number(options.get("eshift", 0), "eshift")
    if not isinstance(options.get("smooth", True), bool):
        raise ValueError("smooth must be a boolean.")
    smooth = options.get("smooth", True)
    if x.size < 5 or x[0] < 1 or x[-1] > 1e6 or np.min(np.diff(x)) < TINY_ENERGY:
        raise ValueError("Larch deconvolution requires at least five energies in [1, 1e6] eV, separated by >= 0.0005 eV.")
    # Reproduce Larch's internal grid estimate before its O(n**2) division.
    step = max(int(0.1 * x[0]) * 2e-5, 0.01 * int(float(np.min(np.diff(x))) * 100))
    if step <= 0:
        raise ValueError("Larch deconvolution cannot resolve this grid; rebin to steps of at least 0.01 eV.")
    ngrid = min(25_001, 1 + int((x[-1] - x[0]) / step))
    if ngrid > 5_000 or ngrid < 5:
        raise ValueError("Deconvolution grid must have 5–5000 points; truncate or rebin the spectrum.")
    if not step / 4 <= sigma <= (x[-1] - x[0]) / 4:
        raise ValueError("esigma must be at least one quarter of the internal step and at most one quarter of the energy span.")
    if abs(shift + 0.5 * sigma) > (x[-1] - x[0]) / 4:
        raise ValueError("eshift + 0.5 * esigma must be within one quarter of the energy span.")
    window, order = None, 3
    if smooth:
        order = _integer(options.get("sgorder", 3), "sgorder", 0, 5)
        automatic = max(int(sigma / step), order + 2)
        automatic += int(automatic % 2 == 0)
        window, order = _savgol_settings(
            {"window": options.get("sgwindow", automatic), "order": order}, ngrid
        )
    elif "sgwindow" in options or "sgorder" in options:
        raise ValueError("sgwindow and sgorder require smooth=true.")
    if abs(y[-1]) <= 1e-12 * max(float(np.max(np.abs(y))), np.finfo(float).tiny):
        raise ValueError("Larch deconvolution needs a nonzero normalized post-edge endpoint; supply normalized XANES data.")
    group = Group()
    xas_deconvolve(x, y, group=group, form=form, esigma=sigma, eshift=shift,
                   smooth=smooth, sgwindow=window, sgorder=order)
    return x, group.deconv, {
        "method": "larch.xas_deconvolve", "form": form, "esigma": sigma,
        "eshift": shift, "smooth": smooth, "sgwindow": window, "sgorder": order,
        "width_definition": "Gaussian standard deviation" if form == "gaussian" else "Lorentzian HWHM",
        "assumptions": "Input mu must already be edge-step normalized. Uses Larch's one-sided kernel, endpoint normalization, cubic interpolation/extrapolation and intrinsic +0.5*esigma shift. Deconvolution can amplify noise and is not the inverse of the symmetric convolve operation.",
    }


def _self_absorption(x, y, options):
    formula, element = options.get("formula"), options.get("element")
    if not isinstance(formula, str) or not 1 <= len(formula) <= 256:
        raise ValueError("formula must be a chemical formula of at most 256 characters, e.g. CuO.")
    if not isinstance(element, str) or not 1 <= len(element) <= 2:
        raise ValueError("element must be an atomic symbol, e.g. Cu.")
    composition = chemparse(formula)
    if element not in composition or any(not np.isfinite(n) or n <= 0 or n > 1e6 for n in composition.values()):
        raise ValueError("formula must contain the absorbing element with finite, positive stoichiometry <= 1e6.")
    edge = _choice(options.get("edge", "K"), "edge", ("K", "L1", "L2", "L3"))
    default_line = {"K": "Ka", "L1": "Lb3", "L2": "Lb1", "L3": "La"}[edge]
    line = options.get("line", default_line)
    if not isinstance(line, str) or len(line) > 16:
        raise ValueError("line must name an XrayDB fluorescence line.")
    edge_data, line_data = xray_edge(element, edge), xray_line(element, line)
    if edge_data is None or line_data is None or line_data.initial_level != edge:
        raise ValueError("Choose an available absorption edge and a fluorescence line originating at that edge.")
    if x.size < 12 or x[0] <= 0 or x[-1] > 1e6 or np.min(np.diff(x)) < TINY_ENERGY:
        raise ValueError("Fluorescence correction needs >=12 positive energies <=1e6 eV with spacing >=0.0005 eV.")
    if not x[0] < edge_data.energy < x[-1]:
        raise ValueError("Measured energy range must straddle the tabulated absorption edge; check element, edge, and eV units.")
    angle_in = _number(options.get("angle_in", 45), "angle_in", positive=True)
    angle_out = _number(options.get("angle_out", 45), "angle_out", positive=True)
    if not 0.1 <= angle_in <= 90 or not 0.1 <= angle_out <= 90:
        raise ValueError("angle_in and angle_out must be 0.1–90 degrees from the sample surface.")
    e0 = _number(options.get("e0", edge_data.energy), "e0", positive=True)
    nnorm = _integer(options.get("nnorm", 1), "nnorm", 0, 3)
    preopts = {name: _number(options.get(name, default), name) for name, default in (
        ("pre1", x[0] - e0), ("pre2", -30), ("norm1", 100), ("norm2", x[-1] - e0)
    )}
    p1, p2, n1, n2 = (preopts[name] for name in ("pre1", "pre2", "norm1", "norm2"))
    if not x[0] - e0 <= p1 < p2 < 0 < n1 < n2 <= x[-1] - e0 or n2 - n1 < 2:
        raise ValueError("Require pre1 < pre2 < 0 < norm1 < norm2 within measured energies relative to e0; post-edge span must be >=2 eV.")
    if ((x >= e0 + p1) & (x < e0 + p2)).sum() < 4 or ((x >= e0 + n1) & (x < e0 + n2)).sum() < 6:
        raise ValueError("Normalization ranges need >=4 pre-edge and >=6 post-edge samples.")
    preopts.update(e0=e0, nnorm=nnorm)
    normalized = preedge(x, y, **preopts)
    ie0 = int(np.argmin(np.abs(x - e0)))
    edge_step = normalized["post_edge"][ie0] - normalized["pre_edge"][ie0]
    if edge_step <= 1e-12 * max(float(np.max(np.abs(y))), np.finfo(float).tiny):
        raise ValueError("Fluorescence data must have a positive, resolvable absorption edge step; check normalization ranges.")
    attenuation = material_mu(formula, np.array([line_data.energy, edge_data.energy - 10,
                                                edge_data.energy + 10]), density=1)
    jump = attenuation[2] - attenuation[1]
    if not np.isfinite(attenuation).all() or jump <= 0:
        raise ValueError("Material has no positive attenuation jump at this edge; check composition and edge.")
    alpha = (attenuation[0] * np.sin(np.deg2rad(angle_in)) / np.sin(np.deg2rad(angle_out)) + attenuation[1]) / jump
    denominator = alpha + 1 - normalized["norm"]
    if np.any(denominator <= 1e-8 * max(1, alpha)):
        raise ValueError("FLUO correction is singular or nonphysical for these data; check composition, angles, and normalization.")
    group = Group()
    fluo_corr(x, y, formula, element, group=group, edge=edge, line=line,
              anginp=angle_in, angout=angle_out, **preopts)
    if not np.isfinite(group.norm_corr).all():
        raise ValueError("Corrected fluorescence normalization is non-finite; review the normalization ranges.")
    return x, group.mu_corr, {
        "method": "larch.fluo_corr", "formula": formula, "element": element, "edge": edge,
        "line": line, "angle_in": angle_in, "angle_out": angle_out, **preopts,
        "alpha": float(alpha), "normalized_mu": group.norm_corr.tolist(),
        "assumptions": "FLUO thick homogeneous flat sample approximation, known stoichiometry, angles measured from the surface in degrees; no finite-thickness correction. Intended for XANES, questionable for quantitative EXAFS. Input is raw fluorescence mu; returned mu is Larch mu_corr, with norm_corr in normalized_mu. XrayDB density=1 cancels in the attenuation ratio.",
    }


def _multi_electron(x, y, options):
    """Subtract a specified weak, Lorentzian-broadened secondary edge.

    Athena manual 9.11 offers this phenomenological arctangent alternative.
    Larch exposes its line shape via lmfit; there is no dedicated MEE-removal
    routine in this checkout. This is NOT an ab initio shake-off calculation
    and does not implement Athena's translated/reflected XANES alternative.

    All physical parameters must be supplied: e0 (primary edge, absolute eV),
    shift (>0 eV above e0), amplitude (0..1, fraction of primary edge step),
    width (>0 eV, HWHM of the Lorentzian derivative), edge_step (>0, mu units).
    Set edge_step=1 explicitly for normalized input. No parameter guessing,
    fitting, clipping, baseline refitting, or subsequent normalization occurs.
    The arctangent's finite pre-threshold tail is retained over the full range.
    """
    method = _choice(options.get("method", "arctangent"), "method", ("arctangent",))
    e0 = _number(options.get("e0"), "e0", positive=True)
    shift = _number(options.get("shift"), "shift", positive=True)
    width = _number(options.get("width"), "width", positive=True)
    amplitude = _number(options.get("amplitude"), "amplitude")
    edge_step = _number(options.get("edge_step"), "edge_step", positive=True)
    if x[0] <= 0 or not x[0] < e0 < e0 + shift < x[-1]:
        raise ValueError("Require positive energies with the primary e0 and secondary e0 + shift inside the measured range.")
    if not 0 <= amplitude <= 1:
        raise ValueError("amplitude must be from 0 to 1 as a fraction of the primary edge step; use a weak excitation justified by the data.")
    if not max(float(np.min(np.diff(x))) / 10, 1e-10) <= width <= x[-1] - x[0]:
        raise ValueError("width must be between max(minimum energy spacing/10, 1e-10 eV) and the measured energy span.")
    excitation = larch_step(x, amplitude=amplitude * edge_step,
                            center=e0 + shift, sigma=width, form="atan")
    return x, y - excitation, {
        "method": "larch.math.lineshapes.step", "model": method, "e0": e0,
        "shift": shift, "center": e0 + shift, "amplitude": amplitude,
        "edge_step": edge_step, "width": width, "excitation": excitation.tolist(),
        "width_definition": "Lorentzian derivative HWHM in eV",
        "amplitude_definition": "secondary step / primary edge_step",
        "equation": "mu_corrected = mu - amplitude*edge_step*(0.5 + atan((energy-e0-shift)/width)/pi)",
        "assumptions": "User-specified weak additive secondary edge; phenomenological arctangent approximation from Athena 9.11. Full arctangent tails retained; input mu units preserved. No automatic identification, fitting, or renormalization. Recompute normalization/AUTOBK after subtraction. Reflected-spectrum method is not implemented.",
    }


_TRANSFORM_OPTIONS = {
    "smooth": ("window", "order"),
    "deglitch": ("xmin", "xmax", "indices", "points"),
    "truncate": ("xmin", "xmax"),
    "rebin": ("e0", "pre1", "pre2", "pre_step", "xanes_step", "exafs1", "exafs2", "exafs_kstep", "method"),
    "convolve": ("form", "width"),
    "deconvolve": ("form", "width", "esigma", "eshift", "smooth", "sgwindow", "sgorder"),
    "self_absorption": ("formula", "element", "edge", "line", "angle_in", "angle_out", "e0", "pre1", "pre2", "norm1", "norm2", "nnorm"),
    "dispersive": ("offset", "linear", "quadratic"),
    "multi_electron": ("method", "e0", "shift", "amplitude", "width", "edge_step"),
}


def transform_spectrum(operation: str, energy, mu, options: dict | None = None) -> dict:
    """Return ``{energy: list, mu: list, details: dict}`` for one operation.

    Supported options (all other keys are errors):
    * smooth: window=7 (odd samples, <=501), order=2 (0..5). Generalized
      Savitzky–Golay in actual energy on irregular grids; unweighted fits.
    * deglitch: inclusive xmin/xmax OR zero-based indices OR points containing
      measured energy values. Linear interpolation needs good samples on both
      sides; the first/last point cannot be replaced.
    * truncate: inclusive xmin/xmax (defaults to measured endpoints).
    * rebin: required e0; pre1=first-e0, pre2=-30, pre_step=2,
      xanes_step=Larch's e0-dependent default, exafs1=15, exafs2=last-e0,
      exafs_kstep=0.05 inverse angstrom; method=boxcar|centroid|spline.
      Region limits are eV relative to e0. All three regions must be present.
    * convolve: form=gaussian|lorentzian (default gaussian), width=1 eV;
      width is sigma for Gaussian, HWHM for Lorentzian, never FWHM.
    * deconvolve: form=lorentzian|gaussian, esigma=1 (alias width), eshift=0
      eV, smooth=True, sgwindow=automatic, sgorder=3. Requires normalized mu.
      Retains Larch's algorithm and intrinsic half-width shift, not a numerical
      inverse of this module's symmetric convolution. Internal grid <=5000.
    * self_absorption: required formula and element (symbol), edge=K (also
      L1/L2/L3), line=Ka/Lb3/Lb1/La for the respective edge, angle_in/out=45
      degrees from the surface; e0=tabulated edge, pre1=first-e0, pre2=-30,
      norm1=100, norm2=last-e0, nnorm=1 (0..3). FLUO's thick homogeneous
      sample approximation; returns raw-scale mu_corr. See details for norm.
    * dispersive: E(eV)=offset + linear*pixel + quadratic*pixel**2;
      offset=0 eV, linear=1 eV/pixel, quadratic=0 eV/pixel**2. The energy
      argument contains increasing pixel coordinates. Decreasing calibration
      reverses both arrays; nonmonotonic or nonpositive energies are rejected.
    * multi_electron: method=arctangent (only supported method); required e0
      (primary edge, eV), shift (>0 eV), amplitude (0..1 fraction of primary
      edge step), width (Lorentzian derivative HWHM, eV), edge_step (mu units;
      explicitly 1 for normalized input). Subtracts the specified secondary
      step at e0+shift. Athena 9.11's phenomenological arctangent method only;
      reflected-spectrum removal and automatic parameter fitting are absent.

    Arrays must be finite, increasing, have 2..100000 paired samples, and are
    copied. Additional operation-specific work bounds fail before allocation.
    No unit inference, automatic edge normalization, or silent fallback occurs.
    """
    _choice(operation, "operation", tuple(_TRANSFORM_OPTIONS))
    opts = _options(options, _TRANSFORM_OPTIONS[operation])
    x, y = _xy(energy, mu)
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            if operation == "truncate":
                lo, hi, mask = _range(x, opts)
                out_x, out_y, details = x[mask], y[mask], {"xmin": lo, "xmax": hi}
            elif operation == "dispersive":
                coefficients = {name: _number(opts.get(name, default), name)
                                for name, default in (("offset", 0), ("linear", 1), ("quadratic", 0))}
                offset, linear, quadratic = (coefficients[name] for name in ("offset", "linear", "quadratic"))
                slopes = linear + 2 * quadratic * x[[0, -1]]
                if not (np.all(slopes >= 0) or np.all(slopes <= 0)):
                    raise ValueError("Dispersive calibration is nonmonotonic across the pixel range.")
                out_x = offset + x * (linear + quadratic * x)
                out_y = y
                reversed_axis = bool(np.all(np.diff(out_x) < 0))
                if reversed_axis:
                    out_x, out_y = out_x[::-1], out_y[::-1]
                if np.any(out_x <= 0) or np.any(np.diff(out_x) <= 0):
                    raise ValueError("Dispersive coefficients must give positive, strictly monotonic energies.")
                details = {**coefficients, "reversed": reversed_axis, "input_units": "pixel"}
            else:
                handlers = {"smooth": _smooth, "deglitch": _deglitch, "rebin": _rebin,
                            "convolve": _convolve, "deconvolve": _deconvolve,
                            "self_absorption": _self_absorption, "multi_electron": _multi_electron}
                out_x, out_y, details = handlers[operation](x, y, opts)
        out_x, out_y = _xy(out_x, out_y)
    except (ValueError, TypeError, ArithmeticError, np.linalg.LinAlgError) as exc:
        raise ValueError(f"{operation}: {exc}") from exc
    return {"energy": out_x.tolist(), "mu": out_y.tolist(), "details": {
        "operation": operation, "energy_units": "eV", "input_points": int(x.size),
        "output_points": int(out_x.size), **details,
    }}


def fit_peaks(x, y, options: dict | None = None) -> dict:
    """Unweighted lmfit peaks plus a linear background, in the units of x/y.

    Options: inclusive xmin/xmax (default full range), required peaks (1..12),
    max_nfev=2000 (1..5000), and optional background={slope, intercept} initial
    guesses (default line through the fit-range endpoints). Each peak requires
    center, sigma, amplitude, with kind=gaussian|lorentzian|voigt (gaussian by
    default). amplitude is positive integrated area, NOT height. sigma is
    Gaussian standard deviation or Lorentzian HWHM in x units. Voigt uses a
    genuine Voigt profile with gamma=sigma unless a positive gamma is supplied;
    then both widths vary independently. No user constraints/expressions.

    Centers are bounded to the selected range; widths are bounded between
    max(minimum sample spacing/10, span*1e-9) and the fit span. Positive peaks
    only. There must be more samples than varying parameters. At most 20000
    fit samples and a bounded samples*peaks*evaluations work budget are allowed.

    Returns x, observed, fit, residual=observed-fit, components (background,
    peak_1, ...), parameters (lmfit names -> value/stderr/vary/min/max), redchi,
    and details. Unweighted redchi is RSS/(N-Nvary) in squared y units, not a
    noise-calibrated chi-square. A missing standard error is None. The optimizer
    must converge; convergence alone does not establish peak identifiability.
    """
    opts = _options(options, ("xmin", "xmax", "peaks", "background", "max_nfev"))
    x, y = _xy(x, y, names=("x", "y"))
    _, _, mask = _range(x, opts, minimum=6)
    x, y = x[mask], y[mask]
    peaks = opts.get("peaks")
    if not isinstance(peaks, (list, tuple)) or not 1 <= len(peaks) <= MAX_PEAKS:
        raise ValueError(f"peaks must contain 1–{MAX_PEAKS} peak dictionaries with center, sigma, amplitude, and kind.")
    nfev = _integer(opts.get("max_nfev", 2000), "max_nfev", 1, MAX_NFEV)
    if x.size > MAX_FIT_POINTS or x.size * len(peaks) * nfev > 200_000_000:
        raise ValueError("Peak fitting exceeds the work limit; reduce the fit range, peaks, or max_nfev.")
    span = float(x[-1] - x[0])
    min_width = max(float(np.min(np.diff(x))) / 10, span * 1e-9)
    background = _options(opts.get("background"), ("slope", "intercept"))
    slope = _number(background.get("slope", (y[-1] - y[0]) / span), "background.slope")
    intercept = _number(background.get("intercept", y[0] - slope * x[0]), "background.intercept")
    model = LinearModel(prefix="background_")
    params = model.make_params(slope=slope, intercept=intercept)
    kinds = []
    for index, peak in enumerate(peaks, start=1):
        if not isinstance(peak, Mapping):
            raise ValueError(f"peak {index} must be a dictionary.")
        peak = _options(peak, ("center", "sigma", "amplitude", "kind", "gamma"))
        kind = _choice(peak.get("kind", "gaussian"), "peak kind", ("gaussian", "lorentzian", "voigt"))
        center = _number(peak.get("center"), f"peak {index} center")
        sigma = _number(peak.get("sigma"), f"peak {index} sigma", positive=True)
        amplitude = _number(peak.get("amplitude"), f"peak {index} amplitude", positive=True)
        if not x[0] <= center <= x[-1]:
            raise ValueError(f"peak {index} center must be within the selected fit range.")
        if not min_width <= sigma <= span:
            raise ValueError(f"peak {index} sigma must be between {min_width:g} and {span:g} in x units.")
        prefix = f"peak_{index}_"
        peak_model = {"gaussian": GaussianModel, "lorentzian": LorentzianModel, "voigt": VoigtModel}[kind](prefix=prefix)
        peak_params = peak_model.make_params(center=center, sigma=sigma, amplitude=amplitude)
        peak_params[prefix + "center"].set(min=float(x[0]), max=float(x[-1]))
        peak_params[prefix + "sigma"].set(min=min_width, max=span)
        peak_params[prefix + "amplitude"].set(min=0)
        if "gamma" in peak:
            if kind != "voigt":
                raise ValueError("gamma is supported only for Voigt peaks.")
            gamma = _number(peak["gamma"], f"peak {index} gamma", positive=True)
            if not min_width <= gamma <= span:
                raise ValueError(f"peak {index} gamma must be between {min_width:g} and {span:g}.")
            peak_params[prefix + "gamma"].set(value=gamma, expr="", vary=True, min=min_width, max=span)
        model += peak_model
        params.update(peak_params)
        kinds.append(kind)
    varying = sum(par.vary and par.expr is None for par in params.values())
    if x.size <= varying:
        raise ValueError(f"Fit range needs more than {varying} samples for the varying parameters.")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            result = model.fit(y, params, x=x, method="leastsq", max_nfev=nfev, nan_policy="raise")
    except (ValueError, TypeError, ArithmeticError, np.linalg.LinAlgError) as exc:
        raise ValueError(f"Peak fit failed; check initial peak values and fit range: {exc}") from exc
    if not result.success or result.aborted:
        raise ValueError(f"Peak fit did not converge within max_nfev={nfev}; improve initial guesses or increase the limit. {result.message}")
    components = {name.rstrip("_"): values.tolist() for name, values in result.eval_components(x=x).items()}
    numeric_arrays = [result.best_fit, y - result.best_fit, *components.values()]
    if not all(np.isfinite(values).all() for values in numeric_arrays) or not np.isfinite(result.redchi):
        raise ValueError("Peak fit produced non-finite results; rescale data and review peak guesses.")
    parameters = {}
    for name, par in result.params.items():
        if not np.isfinite(par.value):
            raise ValueError(f"Peak fit produced a non-finite {name}; revise the model.")
        parameters[name] = {"value": float(par.value),
                            "stderr": float(par.stderr) if par.stderr is not None and np.isfinite(par.stderr) else None,
                            "vary": bool(par.vary),
                            "min": float(par.min) if np.isfinite(par.min) else None,
                            "max": float(par.max) if np.isfinite(par.max) else None}
    return {"x": x.tolist(), "observed": y.tolist(), "fit": result.best_fit.tolist(),
            "residual": (y - result.best_fit).tolist(), "components": components,
            "parameters": parameters, "redchi": float(result.redchi), "details": {
                "method": "lmfit.leastsq", "peak_kinds": kinds, "nfev": int(result.nfev),
                "nvarys": int(result.nvarys), "success": bool(result.success),
                "amplitude_definition": "integrated area", "background": "slope*x + intercept",
                "redchi_definition": "unweighted sum((observed-fit)**2)/(N-Nvary); squared y units",
                "voigt_gamma": "tied to sigma unless gamma supplied; supplied gamma varies independently",
                "uncertainties_available": bool(result.errorbars),
            }}


def _cumulant_polynomial_fit(k, observed, powers, factors, names):
    """Scaled SVD least squares; nominal iid residual-based covariance only."""
    scale = float(k[-1])
    reduced_k = k / scale
    design = np.column_stack([factor * reduced_k**power for power, factor in zip(powers, factors)])
    u, singular, vt = np.linalg.svd(design, full_matrices=False)
    condition = float(singular[0] / max(singular[-1], np.finfo(float).tiny))
    if condition > 1e8:
        raise ValueError("Cumulant fit is ill-conditioned; widen the k range or reduce max_cumulant.")
    reduced_coef = vt.T @ ((u.T @ observed) / singular)
    fit = design @ reduced_coef
    residual = observed - fit
    redchi = float(residual @ residual / (k.size - len(powers)))
    unit_scale = scale ** np.array(powers)
    coefficients = reduced_coef / unit_scale
    inverse_design = (vt.T / singular) / unit_scale[:, None]
    covariance = redchi * (inverse_design @ inverse_design.T)
    if not all(np.isfinite(a).all() for a in (coefficients, covariance, fit, residual)):
        raise ValueError("Cumulant fit produced non-finite values; check the k range and complex amplitudes.")
    parameters = {name: {"value": float(value), "stderr": float(np.sqrt(max(0, variance))),
                          "units": "dimensionless" if power == 0 else f"angstrom^{power}"}
                  for name, value, variance, power in zip(names, coefficients, np.diag(covariance), powers)}
    return parameters, {"fit": fit.tolist(), "residual": residual.tolist(), "redchi": redchi,
                         "parameter_order": names, "covariance": covariance.tolist(),
                         "condition_number": condition, "degrees_of_freedom": int(k.size - len(powers))}


def log_ratio(k, chi_complex_reference, chi_complex_target, options: dict | None = None) -> dict:
    """Exact log amplitude ratio and relative phase of complex filtered EXAFS.

    Both complex arrays must already isolate the SAME scattering shell, use
    identical Fourier windows/normalization, and share the increasing k grid
    (inverse angstrom). Real raw chi(k) is not an analytic amplitude: it is
    rejected. This function performs no Fourier filtering. Optional cumulant
    fitting uses the empirical expansion described in Athena manual 10.4.

    Options: kmin/kmax (inclusive; defaults full grid), amplitude_min=1e-12
    (absolute amplitude threshold in input chi units, strictly positive),
    phase_offset=0 (integer multiples of 2*pi added to relative phase). Phase
    unwrapping assumes adjacent relative phase changes are below pi; the global
    2*pi ambiguity cannot be resolved from these arrays alone.

    fit_cumulants=False enables an optional unweighted polynomial fit when
    True; max_cumulant=4 accepts 2, 3 or 4 (only with fitting enabled). The
    target-minus-reference EFFECTIVE EXAFS cumulants use the convention
        log(A_target/A_reference) = c0 - 2*delta_c2*k**2 + (2/3)*delta_c4*k**4
        phase_target-phase_reference = 2*delta_c1*k - (4/3)*delta_c3*k**3.
    Order 2 omits delta_c3/delta_c4; order 3 omits delta_c4. Omitted terms are
    fixed to zero and absent from parameters. The manual prints +2*c2*k**2:
    its c2 is MINUS our delta_c2. Positive delta_c2 thus attenuates the target,
    consistent with the Debye-Waller sign in Larch's EXAFS equation.

    c0 is a log amplitude scale (not a coordination number); delta_c1..4 have
    units angstrom**1..4. Interpretation requires matching scattering phase,
    species, E0, normalization and shell windows and a low-order cumulant
    description. These are effective EXAFS distribution changes, NOT absolute
    structural cumulants or an exact bond-length change: energy-dependent
    scattering/mean-free-path and spherical-wave corrections are not modeled.

    Fits require 6..20000 selected points and scaled-design condition <=1e8.
    Returns an additional cumulant_fit={parameters, log_amplitude, phase,
    max_cumulant, details}; each fitted observable has fit, residual, redchi,
    covariance, parameter_order, degrees_of_freedom, condition_number.
    Standard errors/covariances are nominal unweighted iid residual estimates;
    Fourier-filtered samples are correlated, so these are not calibrated
    structural uncertainties and redchi is not a noise-normalized chi-square.

    Returns k, log_amplitude_ratio=ln(abs(target))-ln(abs(reference)), and
    phase_difference=unwrap(arg(target*conj(reference)))+2*pi*phase_offset in
    radians. No zero-amplitude points are silently dropped or regularized.
    """
    opts = _options(options, ("kmin", "kmax", "amplitude_min", "phase_offset", "fit_cumulants", "max_cumulant"))
    do_fit = opts.get("fit_cumulants", False)
    if not isinstance(do_fit, bool):
        raise ValueError("fit_cumulants must be a boolean.")
    if not do_fit and "max_cumulant" in opts:
        raise ValueError("max_cumulant requires fit_cumulants=true.")
    order = _integer(opts.get("max_cumulant", 4), "max_cumulant", 2, 4)
    k = _array(k, "k")
    reference = _array(chi_complex_reference, "chi_complex_reference", complex_values=True)
    target = _array(chi_complex_target, "chi_complex_target", complex_values=True)
    if not np.iscomplexobj(chi_complex_reference) or not np.iscomplexobj(chi_complex_target):
        raise ValueError("Log ratio requires complex shell-filtered EXAFS, not raw real chi(k).")
    if not k.size == reference.size == target.size or np.any(np.diff(k) <= 0) or np.any(k < 0) or np.any(k > 1e4):
        raise ValueError("k must increase within [0, 10000] inverse angstrom, with both complex arrays of the same length.")
    _, _, mask = _range(k, opts, names=("kmin", "kmax"))
    if do_fit and not 6 <= mask.sum() <= MAX_FIT_POINTS:
        raise ValueError(f"Cumulant fitting requires 6–{MAX_FIT_POINTS} selected points; adjust kmin/kmax or the input grid.")
    k, reference, target = k[mask], reference[mask], target[mask]
    floor = _number(opts.get("amplitude_min", 1e-12), "amplitude_min", positive=True)
    offset = _integer(opts.get("phase_offset", 0), "phase_offset", -100, 100)
    amp_ref, amp_target = np.abs(reference), np.abs(target)
    if np.any(amp_ref <= floor) or np.any(amp_target <= floor):
        raise ValueError("Both complex amplitudes must exceed amplitude_min throughout the selected range; select a reliable shell-filtered range.")
    relative_unit = (target / amp_target) * np.conj(reference / amp_ref)
    phase = np.unwrap(np.angle(relative_unit)) + 2 * np.pi * offset
    log_amplitude = np.log(amp_target) - np.log(amp_ref)
    output = {"k": k.tolist(), "log_amplitude_ratio": log_amplitude.tolist(),
            "phase_difference": phase.tolist(), "details": {
                "ratio": "target/reference", "k_units": "angstrom^-1", "phase_units": "radian",
                "amplitude_min": floor, "phase_offset": offset,
                "fit_cumulants": do_fit,
                "assumptions": "Already shell-filtered complex EXAFS with identical windows and normalization; relative phase sampled without aliasing. Global 2*pi phase ambiguity remains. " + ("An empirical effective-cumulant fit is included." if do_fit else "No cumulant or structural fit performed."),
            }}
    if do_fit:
        amplitude_powers = [0, 2, 4] if order == 4 else [0, 2]
        phase_powers = [1, 3] if order >= 3 else [1]
        amp_params, amp_fit = _cumulant_polynomial_fit(k, log_amplitude, amplitude_powers,
            [1, -2, 2 / 3][:len(amplitude_powers)], ["c0", "delta_c2", "delta_c4"][:len(amplitude_powers)])
        phase_params, phase_fit = _cumulant_polynomial_fit(k, phase, phase_powers,
            [2, -4 / 3][:len(phase_powers)], ["delta_c1", "delta_c3"][:len(phase_powers)])
        output["cumulant_fit"] = {"parameters": amp_params | phase_params,
            "log_amplitude": amp_fit, "phase": phase_fit, "max_cumulant": order, "details": {
                "method": "scaled SVD unweighted least squares",
                "convention": "target minus reference; delta_c2 is minus the c2 printed in Athena manual 10.4",
                "amplitude_equation": "c0 - 2*delta_c2*k**2 + (2/3)*delta_c4*k**4",
                "phase_equation": "2*delta_c1*k - (4/3)*delta_c3*k**3",
                "omitted_terms": [f"delta_c{i}" for i in range(order + 1, 5)],
                "assumptions": "Single isolated shell, same scatterers, E0 and processing, with scattering factors approximately cancelling and a low-order cumulant expansion. Effective EXAFS cumulant differences, not absolute structure; no mean-free-path or spherical-wave corrections. c0 is not an isolated coordination-number ratio.",
                "uncertainty": "Nominal iid residual-based covariance only; filtered samples are correlated. No cross-covariance between amplitude and phase is estimated; redchi is unweighted RSS/(N-Nparameters), not noise-calibrated chi-square.",
            }}
    return output
