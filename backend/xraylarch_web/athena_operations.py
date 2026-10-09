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
from lmfit import Parameters, minimize
from lmfit.models import GaussianModel, LinearModel, LorentzianModel, StepModel, VoigtModel
from scipy.signal import fftconvolve, savgol_filter
from scipy.stats import chi2
from xraydb import chemparse, material_mu, xray_edge, xray_line

MAX_POINTS = 100_000
MAX_GRID_POINTS = 100_000
MAX_WORK = 50_000_000
MAX_PEAKS = 12
MAX_FIT_POINTS = 20_000
MAX_NFEV = 5_000
MAX_SERIES = 40


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


def _booth_slab(measured, mu_b, jump, mu_f, g_in, g_out, thickness_cm):
    """Invert the finite-thickness fluorescence yield for the true absorption.

    Booth and Bridges, Physica Scripta T115, 202 (2005). A uniform slab of
    thickness d emits, per unit incident intensity and up to a constant
    detector solid angle,

        F(n) = n / S(n) * (1 - exp(-S(n) d)),
        S(n) = (mu_b + jump * n) * g_in + mu_f * g_out,

    where n is the normalized absorption of the edge-jumping element, mu_b
    the background attenuation just below the edge, jump the edge step in
    attenuation, mu_f the attenuation at the fluorescence energy, and g_in,
    g_out the inverse sines of the incidence and exit angles. A normalized
    measurement is F(n)/F(1), and F is strictly increasing in n, so each
    point inverts by bisection. Returns the recovered n and S(n).

    The d -> infinity limit is FLUO; the d -> 0 limit leaves the data alone.
    """
    def sigma_of(n):
        return (mu_b + jump * n) * g_in + mu_f * g_out

    def detected(n):
        sigma = sigma_of(n)
        return n / sigma * (-np.expm1(-sigma * thickness_cm))

    unit = float(detected(np.ones(1))[0])
    # F rises to a finite plateau as n grows, because a more strongly
    # absorbing sample emits from an ever thinner surface layer. Above that
    # plateau the inversion has no root for *this* thickness; a thinner slab
    # has a higher plateau, and as d -> 0 it rises without bound.
    ceiling = 1.0 / (jump * g_in * unit)
    if np.any(measured >= ceiling * (1 - 1e-9)):
        raise ValueError(
            f"Normalized signal reaches {float(np.max(measured)):.3f}, at or above the "
            f"{ceiling:.3f} ceiling for this thickness, composition, geometry and "
            "normalization, so the inversion has no solution. A thinner sample raises the "
            "ceiling; check the thickness, the composition, the angles, and the "
            "normalization ranges.")
    # Bracket below zero so noisy pre-edge points are not clamped upward. This
    # is a numerical extension, not a physicality test: stop just short of
    # S(n) = 0, where the yield itself stops being defined.
    lo = np.full(measured.shape, -0.95 * (mu_b * g_in + mu_f * g_out) / (jump * g_in))
    hi = np.ones_like(measured)
    for _ in range(200):
        short = detected(hi) < measured * unit
        if not short.any():
            break
        hi = np.where(short, hi * 2.0, hi)
    if np.any(detected(lo) > measured * unit):
        raise ValueError(
            "Normalized signal falls further below zero than this inversion can "
            "represent; check the pre-edge normalization range.")
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        low = detected(mid) < measured * unit
        lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
    n = 0.5 * (lo + hi)
    return n, sigma_of(n)


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
    algorithm = _choice(options.get("algorithm", "fluo"), "algorithm", ("fluo", "booth"))
    density = options.get("density")
    if density is not None:
        density = _number(density, "density", positive=True)
        if not 1e-3 <= density <= 30:
            raise ValueError("density must be 0.001–30 g/cm^3.")
    thickness = options.get("thickness")
    if thickness is not None:
        thickness = _number(thickness, "thickness", positive=True)
        if not 1e-4 <= thickness <= 1e6:
            raise ValueError("thickness must be 0.0001–1000000 micrometres.")
    if algorithm == "booth" and (density is None or thickness is None):
        raise ValueError("The Booth correction needs the sample thickness in micrometres and the density in g/cm^3.")
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
    # A fixed edge step and the pre-edge energy exponent belong to the
    # normalization the user approved; without them the 'measured' curve the
    # inversion corrects is not the one in the main view.
    step = options.get("step")
    if step is not None:
        step = _number(step, "step", positive=True)
    nvict = _integer(options.get("nvict", 0), "nvict", 0, 10)
    normalized = preedge(x, y, step=step, nvict=nvict, **preopts)
    ie0 = int(np.argmin(np.abs(x - e0)))
    edge_step = step if step is not None else normalized["post_edge"][ie0] - normalized["pre_edge"][ie0]
    if edge_step <= 1e-12 * max(float(np.max(np.abs(y))), np.finfo(float).tiny):
        raise ValueError("Fluorescence data must have a positive, resolvable absorption edge step; check normalization ranges.")
    attenuation = material_mu(formula, np.array([line_data.energy, edge_data.energy - 10,
                                                edge_data.energy + 10]), density=1)
    jump = attenuation[2] - attenuation[1]
    if not np.isfinite(attenuation).all() or jump <= 0:
        raise ValueError("Material has no positive attenuation jump at this edge; check composition and edge.")
    g_in, g_out = 1 / np.sin(np.deg2rad(angle_in)), 1 / np.sin(np.deg2rad(angle_out))
    alpha = (attenuation[0] * g_out / g_in + attenuation[1]) / jump
    measured = normalized["norm"]
    if density is not None:
        # The same three attenuations in absolute units. Only the product of
        # density and thickness enters, so either may carry the packing
        # fraction of a homogeneous pellet. Partial surface coverage is a
        # different geometry and is not equivalent to a thinner slab.
        mu_f, mu_b, mu_jump = (attenuation * density)[0], (attenuation * density)[1], jump * density
        thickness_cm = None if thickness is None else thickness * 1e-4
    details = {
        "algorithm": algorithm, "formula": formula, "element": element, "edge": edge,
        "line": line, "angle_in": angle_in, "angle_out": angle_out, **preopts, "step": step, "nvict": nvict,
        "alpha": float(alpha), "fluorescence_energy": float(line_data.energy),
        "edge_energy": float(edge_data.energy), "measured_mu": measured.tolist(),
    }
    if algorithm == "fluo":
        denominator = alpha + 1 - measured
        if np.any(denominator <= 1e-8 * max(1, alpha)):
            raise ValueError("FLUO correction is singular or nonphysical for these data; check composition, angles, and normalization.")
        if step is None and nvict == 0:
            group = Group()
            fluo_corr(x, y, formula, element, group=group, edge=edge, line=line,
                      anginp=angle_in, angout=angle_out, **preopts)
            mu_corrected, corrected = group.mu_corr, group.norm_corr
            method = "larch.fluo_corr"
        else:
            # Larch's fluo_corr refits the edge step and drops nvict, so it
            # would correct a differently normalized curve. Its formula, on
            # the curve the user approved:
            mu_corrected = y * alpha / denominator
            corrected = preedge(x, mu_corrected, nvict=nvict, **preopts)["norm"]
            method = "larch.fluo_corr formula, on the group's fixed-step normalization"
        if not np.isfinite(corrected).all():
            raise ValueError("Corrected fluorescence normalization is non-finite; review the normalization ranges.")
        # The FLUO limit assumes every emitted photon comes from a slab deep
        # enough to absorb the whole beam. alpha carries the correction; the
        # recovered absorption is what sets the depth the signal came from.
        true_norm = alpha * measured / denominator
        details.update(
            method=method,
            assumptions="FLUO thick homogeneous flat sample approximation, known stoichiometry, angles measured from the surface in degrees; no finite-thickness correction. Intended for XANES, questionable for quantitative EXAFS. Input is raw fluorescence mu; returned mu is Larch mu_corr, with norm_corr in normalized_mu. XrayDB density=1 cancels in the attenuation ratio.",
        )
    else:
        true_norm, _ = _booth_slab(measured, mu_b, mu_jump, mu_f, g_in, g_out, thickness_cm)
        # The inversion recovers the normalized absorption, so rebuild the raw
        # signal from it on the source group's pre-edge line and edge step.
        # Scaling the raw signal instead, as FLUO does, would scale any
        # additive background along with the fluorescence, and renormalizing
        # that does not return the absorption the inversion recovered.
        mu_corrected = normalized["pre_edge"] + edge_step * true_norm
        corrected = preedge(x, mu_corrected, nvict=nvict, **preopts)["norm"]
        if not np.isfinite(corrected).all():
            raise ValueError("Corrected fluorescence normalization is non-finite; review the normalization ranges.")
        details.update(
            method="booth.finite_thickness_slab", thickness=thickness, density=density,
            reference="Booth and Bridges, Physica Scripta T115, 202 (2005)",
            equation="F(n) = n/S(n) * (1 - exp(-S(n) d)) with S(n) = (mu_b + jump*n)/sin(angle_in) + mu_f/sin(angle_out); measured = F(n)/F(1)",
            assumptions="Uniform flat slab of the stated thickness, density and stoichiometry, uniformly illuminated, with angles measured from the surface in degrees. Attenuation is held at its tabulated values just below and above the edge and at the fluorescence line, as FLUO does, so energy dependence away from the edge is not modelled. No scattering, no detector dead time, no pinholes or grain structure, and no cylindrical or partially covering geometry. Input is raw fluorescence mu; the returned mu is rebuilt from the recovered normalized absorption on the source group's pre-edge line and edge step, so normalized_mu is that absorption renormalized on its own corrected edge step rather than a rescaled background.",
        )
    if density is not None:
        # Total attenuation along the in and out paths, so 1/sigma is the
        # attenuation length: 63% of the detected signal comes from shallower
        # than that, in a slab thick enough for the rest to exist.
        sigma = (mu_b + mu_jump * true_norm) * g_in + mu_f * g_out
        details["information_depth_um"] = (1e4 / sigma).tolist()
        # Whether the thick-sample correction applies is set by the reference
        # yield F(1), not by the shortest length in the scan: the normalized
        # measurement is F(n)/F(1), so it is sigma at n = 1 that decides how
        # close the denominator is to its infinite-thickness value.
        sigma_one = (mu_b + mu_jump) * g_in + mu_f * g_out
        details["attenuation_length_um"] = float(1e4 / sigma_one)
        if thickness is not None:
            details["sampled_fraction"] = (-np.expm1(-sigma * thickness_cm)).tolist()
            details["reference_sampled_fraction"] = float(-np.expm1(-sigma_one * thickness_cm))
    details["normalized_mu"] = np.asarray(corrected).tolist()
    return x, mu_corrected, details


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
        "assumptions": "User-specified weak additive secondary edge; phenomenological arctangent approximation from Demeter processing manual section 9.11. Full arctangent tails retained; input mu units preserved. No automatic identification, fitting, or renormalization. Recompute normalization/AUTOBK after subtraction. Reflected-spectrum method is not implemented.",
    }


_TRANSFORM_OPTIONS = {
    "smooth": ("window", "order"),
    "deglitch": ("xmin", "xmax", "indices", "points"),
    "truncate": ("xmin", "xmax"),
    "rebin": ("e0", "pre1", "pre2", "pre_step", "xanes_step", "exafs1", "exafs2", "exafs_kstep", "method"),
    "convolve": ("form", "width"),
    "deconvolve": ("form", "width", "esigma", "eshift", "smooth", "sgwindow", "sgorder"),
    "self_absorption": ("algorithm", "formula", "element", "edge", "line", "angle_in", "angle_out", "thickness", "density", "e0", "pre1", "pre2", "norm1", "norm2", "nnorm", "step", "nvict"),
    "dispersive": ("offset", "linear", "quadratic"),
    "multi_electron": ("method", "e0", "shift", "amplitude", "width", "edge_step"),
}


def transform_options(operation: str) -> tuple[str, ...]:
    """Option names ``transform_spectrum`` accepts for one operation."""
    if operation not in _TRANSFORM_OPTIONS:
        raise ValueError(f"Unknown processing operation: {operation}.")
    return _TRANSFORM_OPTIONS[operation]


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
      norm1=100, norm2=last-e0, nnorm=1 (0..3). algorithm=fluo is FLUO's
      thick homogeneous sample approximation; algorithm=booth is the Booth
      finite-thickness slab, which additionally requires thickness (um) and
      density (g/cm**3). Both return raw-scale corrected mu, with the
      renormalized spectrum in details. Supplying density adds the
      attenuation length 1/S per energy and at the edge step, and thickness
      adds the sampled fraction, to details under either algorithm; neither
      changes the FLUO result.
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


def _background_label(background) -> str:
    step = (background or {}).get("step") if isinstance(background, Mapping) else None
    if not step:
        return "slope*x + intercept"
    form = step.get("form", "arctan") if isinstance(step, Mapping) else "arctan"
    return f"slope*x + intercept + {form} step (amplitude, center, sigma)"


def _step_background(x, y, step, model, params, prefix, min_width, span):
    """Add Athena's edge step -- an arctangent or error function -- under the peaks.

    A pre-edge peak sits on the rising edge, and a straight line can only follow
    that onset by bending the peak area into the baseline. The step has its own
    centre, width and height. Its centre may lie up to one window width beyond
    either end, because a pre-edge window usually stops below the edge it is
    climbing toward; its height is nonnegative, since an absorption edge rises.
    By default the centre and width are held where the user put them (the
    edge's E0 and width) and only the height is fitted; ``vary=True`` frees
    them, which on real pre-edge windows (Mn K, 10-18 eV wide) did not converge.
    """
    step = _options(step, ("form", "center", "sigma", "amplitude", "vary"))
    form = _choice(step.get("form", "arctan"), "background step form", ("arctan", "erf"))
    # Athena's habit: hold the step at the edge's E0 and width, and let only its
    # height follow the data. Inside a narrow pre-edge window the free centre
    # and width are rarely determined, and freeing them can stop the fit.
    vary = step.get("vary", False)
    if not isinstance(vary, bool):
        raise ValueError("background step vary must be true or false.")
    center = _number(step.get("center", float(x[-1])), "background step center")
    sigma = _number(step.get("sigma", span / 4), "background step sigma", positive=True)
    amplitude = _number(step.get("amplitude", max(float(np.ptp(y)) / 2, 1e-12)), "background step amplitude")
    if not x[0] - span <= center <= x[-1] + span:
        raise ValueError("The background step centre must lie within one window width of the fit range.")
    if not min_width <= sigma <= span:
        raise ValueError(f"The background step width must be between {min_width:g} and {span:g} in x units.")
    if amplitude < 0:
        raise ValueError("The background step height must be nonnegative; an absorption edge rises.")
    name = f"{prefix}step_"
    step_model = StepModel(form=form, prefix=name)
    step_params = step_model.make_params(center=center, sigma=sigma, amplitude=amplitude)
    step_params[name + "center"].set(min=float(x[0] - span), max=float(x[-1] + span), vary=vary)
    step_params[name + "sigma"].set(min=min_width, max=span, vary=vary)
    step_params[name + "amplitude"].set(min=0)
    params.update(step_params)
    return model + step_model, params


def _peak_setup(x, y, peaks, background, prefix=""):
    """One spectrum's linear background plus peaks, with bounded start values.

    ``prefix`` namespaces every parameter so several spectra can be fitted in
    one parameter set. Returns the model, its parameters and the peak kinds.
    """
    span = float(x[-1] - x[0])
    min_width = max(float(np.min(np.diff(x))) / 10, span * 1e-9)
    background = _options(background, ("slope", "intercept", "step"))
    slope = _number(background.get("slope", (y[-1] - y[0]) / span), "background.slope")
    intercept = _number(background.get("intercept", y[0] - slope * x[0]), "background.intercept")
    model = LinearModel(prefix=f"{prefix}background_")
    params = model.make_params(slope=slope, intercept=intercept)
    if background.get("step") is not None:
        model, params = _step_background(x, y, background["step"], model, params, prefix, min_width, span)
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
            where = f"spectrum {prefix[1:-1]}" if prefix else "the spectrum"
            raise ValueError(f"peak {index} center must be within the selected fit range: {center:g} lies outside "
                             f"{x[0]:g}–{x[-1]:g}, the points {where} measured in the window.")
        if not min_width <= sigma <= span:
            raise ValueError(f"peak {index} sigma must be between {min_width:g} and {span:g} in x units.")
        name = f"{prefix}peak_{index}_"
        peak_model = {"gaussian": GaussianModel, "lorentzian": LorentzianModel, "voigt": VoigtModel}[kind](prefix=name)
        peak_params = peak_model.make_params(center=center, sigma=sigma, amplitude=amplitude)
        peak_params[name + "center"].set(min=float(x[0]), max=float(x[-1]))
        peak_params[name + "sigma"].set(min=min_width, max=span)
        peak_params[name + "amplitude"].set(min=0)
        if "gamma" in peak:
            if kind != "voigt":
                raise ValueError("gamma is supported only for Voigt peaks.")
            gamma = _number(peak["gamma"], f"peak {index} gamma", positive=True)
            if not min_width <= gamma <= span:
                raise ValueError(f"peak {index} gamma must be between {min_width:g} and {span:g}.")
            peak_params[name + "gamma"].set(value=gamma, expr="", vary=True, min=min_width, max=span)
        model += peak_model
        params.update(peak_params)
        kinds.append(kind)
    return model, params, kinds


def _peak_parameters(params, prefix=""):
    """lmfit parameters as value/stderr/vary/min/max, with the prefix removed."""
    reported = {}
    for name, par in params.items():
        if not name.startswith(prefix):
            continue
        if not np.isfinite(par.value):
            raise ValueError(f"Peak fit produced a non-finite {name}; revise the model.")
        reported[name[len(prefix):]] = {
            "value": float(par.value),
            "stderr": float(par.stderr) if par.stderr is not None and np.isfinite(par.stderr) else None,
            "vary": bool(par.vary),
            "min": float(par.min) if np.isfinite(par.min) else None,
            "max": float(par.max) if np.isfinite(par.max) else None}
    return reported


def _peak_count(peaks):
    if not isinstance(peaks, (list, tuple)) or not 1 <= len(peaks) <= MAX_PEAKS:
        raise ValueError(f"peaks must contain 1–{MAX_PEAKS} peak dictionaries with center, sigma, amplitude, and kind.")
    return len(peaks)


def fit_peaks(x, y, options: dict | None = None) -> dict:
    """Unweighted lmfit peaks plus a linear background, in the units of x/y.

    Options: inclusive xmin/xmax (default full range), required peaks (1..12),
    max_nfev=2000 (1..5000), and optional background={slope, intercept} initial
    guesses (default line through the fit-range endpoints), plus an optional
    background.step={form: arctan|erf, center, sigma, amplitude} edge step under
    the peaks (see _step_background). Each peak requires
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
    count = _peak_count(peaks)
    nfev = _integer(opts.get("max_nfev", 2000), "max_nfev", 1, MAX_NFEV)
    if x.size > MAX_FIT_POINTS or x.size * count * nfev > 200_000_000:
        raise ValueError("Peak fitting exceeds the work limit; reduce the fit range, peaks, or max_nfev.")
    model, params, kinds = _peak_setup(x, y, peaks, opts.get("background"))
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
    parameters = _peak_parameters(result.params)
    return {"x": x.tolist(), "observed": y.tolist(), "fit": result.best_fit.tolist(),
            "residual": (y - result.best_fit).tolist(), "components": components,
            "parameters": parameters, "redchi": float(result.redchi), "details": {
                "method": "lmfit.leastsq", "peak_kinds": kinds, "nfev": int(result.nfev),
                "nvarys": int(result.nvarys), "success": bool(result.success),
                "amplitude_definition": "integrated area", "background": _background_label(opts.get("background")),
                "redchi_definition": "unweighted sum((observed-fit)**2)/(N-Nvary); squared y units",
                "voigt_gamma": "tied to sigma unless gamma supplied; supplied gamma varies independently",
                "uncertainties_available": bool(result.errorbars),
            }}


def fit_peaks_series(spectra, options: dict | None = None) -> dict:
    """Fit a series of spectra at once with peak positions and widths in common.

    The scientific case is a pre-edge series measured on one beamline, where the
    peak energies and widths are a property of the sites and only the areas
    change from sample to sample. Fitting them together forces one centre and
    one width per peak across the whole series, so the areas are compared on a
    single peak model instead of on positions that wander sample by sample.

    ``spectra`` is a sequence of (x, y) pairs with 2..MAX_SERIES members, each
    on its own grid. Options are those of :func:`fit_peaks`, applied to every
    spectrum, plus ``share={center: bool, sigma: bool}`` (both true by default;
    at least one must be true). Peak start values are shared; the background and
    the amplitudes start from and vary for each spectrum on its own.

    The residuals of all spectra are concatenated and minimised unweighted in
    one least-squares problem, so the standard errors on the shared centres and
    widths draw on the whole series while each amplitude keeps its own. Shared
    parameters appear with the same value and standard error in every spectrum's
    parameter block, which is what ties them together.

    Returns spectra (each with x, observed, fit, residual, components and
    parameters named as in :func:`fit_peaks`), shared (the tied parameter names),
    redchi over the whole series, and details.
    """
    opts = _options(options, ("xmin", "xmax", "peaks", "background", "backgrounds", "max_nfev", "share"))
    if not isinstance(spectra, (list, tuple)) or not 2 <= len(spectra) <= MAX_SERIES:
        raise ValueError(f"A series fit needs 2–{MAX_SERIES} spectra; fit a single spectrum with the peak fit.")
    # One background per spectrum (an edge step at each spectrum's own E0), or
    # the same one for all.
    backgrounds = opts.get("backgrounds")
    if backgrounds is None:
        backgrounds = [opts.get("background")] * len(spectra)
    elif not isinstance(backgrounds, (list, tuple)) or len(backgrounds) != len(spectra):
        raise ValueError("backgrounds must give one background per spectrum.")
    share = _options(opts.get("share"), ("center", "sigma"))
    shared_names = [name for name in ("center", "sigma") if bool(share.get(name, True))]
    if not shared_names:
        raise ValueError("A series fit must share peak centres, widths, or both; otherwise fit each spectrum separately.")
    count = _peak_count(opts.get("peaks"))
    nfev = _integer(opts.get("max_nfev", 2000), "max_nfev", 1, MAX_NFEV)

    cut, models, params, first_kinds = [], [], Parameters(), []
    for position, spectrum in enumerate(spectra, start=1):
        try:
            x, y = _xy(*spectrum, names=("x", "y"))
        except TypeError as exc:
            raise ValueError("Each spectrum must be an (x, y) pair.") from exc
        _, _, mask = _range(x, opts, minimum=6)
        x, y = x[mask], y[mask]
        model, own, kinds = _peak_setup(x, y, opts["peaks"], backgrounds[position - 1], prefix=f"s{position}_")
        if position == 1:
            first_kinds = kinds
        else:
            for index in range(1, count + 1):
                for name in shared_names:
                    own[f"s{position}_peak_{index}_{name}"].set(expr=f"s1_peak_{index}_{name}")
        cut.append((x, y))
        models.append(model)
        params.update(own)
    points = sum(x.size for x, _ in cut)
    if points > MAX_FIT_POINTS or points * count * nfev > 200_000_000:
        raise ValueError("Series peak fitting exceeds the work limit; reduce the fit range, spectra, peaks, or max_nfev.")
    varying = sum(par.vary and par.expr is None for par in params.values())
    if points <= varying:
        raise ValueError(f"The series needs more than {varying} samples in total for the varying parameters.")

    def residual(current):
        return np.concatenate([model.eval(current, x=x) - y for model, (x, y) in zip(models, cut)])

    # Checked first: when sharing is what stops the joint fit converging, the
    # refusal should say that rather than only "improve the initial guesses".
    independent, consistency = _sharing_check(spectra, opts, backgrounds, shared_names, count)
    disagreement = " ".join(entry["warning"] for entry in consistency if entry.get("consistent") is False)
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            result = minimize(residual, params, method="leastsq", max_nfev=nfev, nan_policy="raise")
    except (ValueError, TypeError, ArithmeticError, np.linalg.LinAlgError) as exc:
        raise ValueError(f"Series peak fit failed; check initial peak values and fit range: {exc} {disagreement}".strip()) from exc
    if not result.success or result.aborted:
        raise ValueError(f"Series peak fit did not converge within max_nfev={nfev}; improve initial guesses or increase the limit. "
                         f"{result.message} {disagreement}".strip())
    if not np.isfinite(result.redchi):
        raise ValueError("Series peak fit produced a non-finite reduced chi-square; rescale data and review peak guesses.")

    reports = []
    for position, (model, (x, y)) in enumerate(zip(models, cut), start=1):
        prefix = f"s{position}_"
        fit = model.eval(result.params, x=x)
        components = {name[len(prefix):].rstrip("_"): values.tolist()
                      for name, values in model.eval_components(params=result.params, x=x).items()}
        if not all(np.isfinite(values).all() for values in [fit, y - fit, *map(np.asarray, components.values())]):
            raise ValueError("Series peak fit produced non-finite results; rescale data and review peak guesses.")
        reports.append({"x": x.tolist(), "observed": y.tolist(), "fit": fit.tolist(),
                        "residual": (y - fit).tolist(), "components": components,
                        "parameters": _peak_parameters(result.params, prefix),
                        "redchi": float(np.sum((y - fit) ** 2) / x.size)})
    warnings = [entry["warning"] for entry in consistency if entry.get("warning")]
    return {"spectra": reports, "redchi": float(result.redchi),
            "independent": independent, "consistency": consistency, "warnings": warnings,
            "shared": [f"peak_{index}_{name}" for index in range(1, count + 1) for name in shared_names],
            "details": {"method": "lmfit.leastsq", "peak_kinds": first_kinds, "nfev": int(result.nfev),
                        "nvarys": int(result.nvarys), "success": bool(result.success),
                        "series_size": len(cut), "points": int(points),
                        "amplitude_definition": "integrated area", "background": _background_label(backgrounds[0]),
                        "step_centers": [((b or {}).get("step") or {}).get("center") for b in backgrounds],
                        "shared_across_series": shared_names,
                        "redchi_definition": "unweighted sum over all spectra of (observed-fit)**2/(N-Nvary); squared y units",
                        "spectrum_redchi_definition": "that spectrum's mean squared residual; a share of the misfit, not its own fit quality",
                        "uncertainties_available": bool(result.errorbars)}}


# Below this probability the one-at-a-time values are called inconsistent with
# one shared value. The fits' errors are nominal lower bounds, so a p-value from
# them overstates disagreement somewhat; 1% keeps the flag for clear cases.
SHARING_P_THRESHOLD = 0.01


def _sharing_check(spectra, opts, backgrounds, shared_names, count):
    """Fit each spectrum alone and ask whether its shared quantities agree.

    Sharing a centre or width is an assumption the joint fit cannot test: it
    will report one value with a small error whether or not the spectra agree.
    Fitting each spectrum on its own with the same window, peaks and background
    gives one value per spectrum; the chi-square of those values about their
    error-weighted mean, against n - 1 degrees of freedom, says whether one
    shared value is consistent with them. Spectra whose own fit fails or has no
    errors are left out and named.
    """
    single = {key: opts[key] for key in ("xmin", "xmax", "peaks", "max_nfev") if key in opts}
    independent = []
    for spectrum, background in zip(spectra, backgrounds):
        try:
            parameters = fit_peaks(*spectrum, dict(single, **({"background": background} if background else {})))["parameters"]
            independent.append({"parameters": {f"peak_{index}_{name}": parameters[f"peak_{index}_{name}"]
                                               for index in range(1, count + 1)
                                               for name in ("center", "sigma", "fwhm", "amplitude")}})
        except ValueError as exc:
            independent.append({"error": str(exc)})
    consistency = []
    for index in range(1, count + 1):
        for name in shared_names:
            key = f"peak_{index}_{name}"
            usable = [(row["parameters"][key]["value"], row["parameters"][key]["stderr"])
                      for row in independent if "parameters" in row
                      and row["parameters"][key]["stderr"] and row["parameters"][key]["stderr"] > 0]
            label = {"center": "centre", "sigma": "width"}[name]
            entry = {"parameter": key, "fitted_alone": len(usable), "of": len(spectra)}
            if len(usable) < 2:
                entry["warning"] = (f"Peak {index} {label}: fewer than two spectra could be fitted on their own with "
                                    "errors, so sharing it cannot be checked against the data.")
            else:
                values, errors = (np.asarray(column, dtype=float) for column in zip(*usable))
                weights = 1 / errors ** 2
                mean = float(np.sum(weights * values) / np.sum(weights))
                chi_square = float(np.sum(((values - mean) / errors) ** 2))
                dof = len(usable) - 1
                probability = float(chi2.sf(chi_square, dof))
                entry.update(mean=mean, chi_square=chi_square, degrees_of_freedom=dof, probability=probability,
                             consistent=probability >= SHARING_P_THRESHOLD)
                if not entry["consistent"]:
                    entry["warning"] = (f"Fitted one at a time, the spectra disagree on peak {index}'s {label} "
                                        f"(χ² = {chi_square:.3g} for {dof} degrees of freedom, p = {probability:.2g}); "
                                        f"the data do not support sharing it. Fit with it unshared, or split the series.")
            consistency.append(entry)
    return independent, consistency


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
                "convention": "target minus reference; delta_c2 is minus the c2 printed in Demeter analysis manual section 10.4",
                "amplitude_equation": "c0 - 2*delta_c2*k**2 + (2/3)*delta_c4*k**4",
                "phase_equation": "2*delta_c1*k - (4/3)*delta_c3*k**3",
                "omitted_terms": [f"delta_c{i}" for i in range(order + 1, 5)],
                "assumptions": "Single isolated shell, same scatterers, E0 and processing, with scattering factors approximately cancelling and a low-order cumulant expansion. Effective EXAFS cumulant differences, not absolute structure; no mean-free-path or spherical-wave corrections. c0 is not an isolated coordination-number ratio.",
                "uncertainty": "Nominal iid residual-based covariance only; filtered samples are correlated. No cross-covariance between amplitude and phase is estimated; redchi is unweighted RSS/(N-Nparameters), not noise-calibrated chi-square.",
            }}
    return output
