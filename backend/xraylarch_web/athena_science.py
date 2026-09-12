"""Core Athena-style calculations using this checkout's Larch implementation.

Energies (including explicit e0 and utility fit limits) are in eV; k and R
are in inverse angstroms and angstroms. Shifts are ADDED to the energy axis.
Processing and analysis dictionaries contain JSON-serializable scalars/lists.
merge_spectra returns NumPy arrays for subsequent scientific calculations.
This module implements core processing, not full desktop Athena parity.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Annotated, Literal

import numpy as np
from larch import Group
from larch.math import index_nearest, index_of
from larch.xafs import autobk, find_e0, pre_edge, xftf, xftr
from larch.xafs.xafsutils import ETOK, TINY_ENERGY
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from scipy.optimize import least_squares, minimize, nnls

MAX_POINTS = 100_000
MAX_NFFT = 65_536
MAX_SPECTRA = 100
MAX_MATRIX_VALUES = 2_000_000
Window = Literal["hanning", "parzen", "welch", "gaussian", "sine", "kaiser"]
Weight = Annotated[float, Field(ge=0, le=4)]
ARRAY_NAMES = (
    "energy", "mu", "norm", "flat", "pre_edge", "post_edge", "bkg", "dmude", "d2mude",
    "k", "chi", "weighted_chi", "kwin", "r", "chir_mag", "chir_re", "chir_im", "chir_pha",
    "q", "chiq_re", "chiq_im", "chiq_mag", "chiq_pha", "rwin",
)


class ScientificError(ValueError):
    """Invalid scientific input or a calculation that cannot produce usable data."""


class AthenaParameters(BaseModel):
    """Validated recipe; e0 refers to the axis AFTER energy_shift is applied.

    Normalization limits are relative to e0. dk/window/kweight apply to the
    forward transform; bkg_dk/bkg_window/bkg_kweight independently control the
    AUTOBK spline objective. Taper widths are in inverse angstroms, weights are
    finite real exponents from 0 through 4. nclamp (0..100) counts samples at
    each end of AUTOBK's uniform k grid; zero disables its endpoint clamps.
    Missing saved fields use Athena defaults bkg_dk=1, bkg_window=hanning,
    nclamp=5, overriding this checkout's lower-level Larch defaults.
    FFTs are limited to powers of two from 128 through 65536.
    fnorm=False preserves scalar edge-step normalization. With fnorm=True,
    raw mu(E) is corrected before a separate normalization/AUTOBK calculation;
    this is intended only for low-energy fluorescence EXAFS (see process_spectrum).
    """

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, validate_assignment=True)

    e0: float | None = Field(default=None, gt=0, le=1e7)
    step: float | None = Field(default=None, gt=0)
    pre1: float | None = Field(default=None, lt=0)
    pre2: float | None = Field(default=None, le=0)
    norm1: float | None = Field(default=None, ge=0)
    norm2: float | None = Field(default=None, gt=0)
    nnorm: int | None = Field(default=None, ge=0, le=3)
    flatten: bool = True
    fnorm: bool = Field(default=False, strict=True)
    rbkg: float = Field(default=1, gt=0, le=20)
    bkg_kmin: float = Field(default=0, ge=0, le=100)
    bkg_kmax: float | None = Field(default=None, gt=0, le=100)
    bkg_kweight: Weight = 2.0
    bkg_dk: float = Field(default=1, ge=0, le=20)
    bkg_window: Window = "hanning"
    nclamp: int = Field(default=5, ge=0, le=100)
    clamp_lo: float = Field(default=0, ge=0, le=1000)
    clamp_hi: float = Field(default=1, ge=0, le=1000)
    kmin: float = Field(default=3, ge=0, le=100)
    kmax: float | None = Field(default=None, gt=0, le=100)
    kweight: Weight = 2.0
    dk: float = Field(default=1, ge=0, le=20)
    window: Window = "hanning"
    rmin: float = Field(default=1, ge=0, le=100)
    rmax: float = Field(default=3, gt=0, le=100)
    dr: float = Field(default=0, ge=0, le=20)
    rwindow: Window = "hanning"
    energy_shift: float = Field(default=0, ge=-100_000, le=100_000)
    nfft: int = Field(default=2048, ge=128, le=MAX_NFFT)
    kstep: float = Field(default=0.05, ge=0.001, le=1)

    @field_validator("window", "rwindow", "bkg_window", mode="before")
    @classmethod
    def canonical_window(cls, value):
        if isinstance(value, str):
            value = value.strip().lower()
            if value == "kaiser-bessel":
                value = "kaiser"
        return value

    @field_validator("nfft", "nnorm", "nclamp", mode="before")
    @classmethod
    def integer_not_boolean(cls, value):
        if isinstance(value, (bool, np.bool_)):
            raise ValueError("Use an integer, not a boolean.")
        return value

    @field_validator("kweight", "bkg_kweight", "bkg_dk", mode="before")
    @classmethod
    def number_not_boolean(cls, value):
        if isinstance(value, (bool, np.bool_)):
            raise ValueError("Use a finite number, not a boolean.")
        return value

    @model_validator(mode="after")
    def ordered_ranges(self):
        for low, high in (("pre1", "pre2"), ("norm1", "norm2"),
                          ("bkg_kmin", "bkg_kmax"), ("kmin", "kmax"),
                          ("rmin", "rmax")):
            a, b = getattr(self, low), getattr(self, high)
            if a is not None and b is not None and a >= b:
                raise ValueError(f"{high} must be greater than {low}.")
        if self.nfft & (self.nfft - 1):
            raise ValueError("nfft must be a power of two from 128 through 65536.")
        rlast = np.pi / (self.kstep * self.nfft) * (self.nfft // 2 - 1)
        if self.rmax + self.dr / 2 > rlast:
            raise ValueError("rmax + dr/2 exceeds the FFT R range; lower it or decrease kstep.")
        for window, width, name in ((self.window, self.dk, "dk"),
                                    (self.rwindow, self.dr, "dr"),
                                    (self.bkg_window, self.bkg_dk, "bkg_dk")):
            if window == "gaussian" and width <= 0:
                raise ValueError(f"{window} requires a positive taper width ({name}).")
        return self


def _pair(x, y, *, name="Spectrum", minimum=2, maximum=MAX_POINTS, allow_equal=False):
    try:
        if np.iscomplexobj(x) or np.iscomplexobj(y):
            raise ValueError("Complex spectra require an explicit real representation.")
        xa, ya = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ScientificError(f"{name}: supply real numeric coordinate and signal arrays.") from exc
    if xa.ndim != 1 or ya.ndim != 1 or xa.size != ya.size:
        raise ScientificError(f"{name}: supply one-dimensional arrays of equal length.")
    if not minimum <= xa.size <= maximum:
        raise ScientificError(f"{name}: supply {minimum} to {maximum} points.")
    if not np.isfinite(xa).all() or not np.isfinite(ya).all():
        raise ScientificError(f"{name}: remove NaN and infinite values before processing.")
    if np.any(np.diff(xa) < 0 if allow_equal else np.diff(xa) <= 0):
        raise ScientificError(f"{name}: coordinates must be strictly increasing; sort and merge duplicates.")
    return xa.copy(), ya.copy()


def _number(value, name):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ScientificError(f"{name} must be a finite number.") from exc
    if not np.isfinite(result):
        raise ScientificError(f"{name} must be a finite number.")
    return result


def _lists(values, name):
    a = np.asarray(values, dtype=float)
    if not np.isfinite(a).all():
        raise ScientificError(f"{name} produced non-finite values; inspect the signal and adjust the fit range.")
    return a.tolist()


def _edge(x, y, e0=None):
    if np.ptp(y) <= np.finfo(float).eps * max(1, np.max(np.abs(y))):
        raise ScientificError("The signal is constant; select an absorption spectrum containing an edge.")
    if e0 is None:
        try:
            # This checkout's find_energy_step slices [0:-0] below 100
            # points, producing NaN and an unreliable edge. For short scans
            # use the measured interior maximum of dmu/dE instead.
            if x.size < 100:
                e0 = float(x[1 + np.argmax(np.gradient(y, x)[1:-1])])
            else:
                e0 = float(find_e0(x, y))
        except (ValueError, IndexError, TypeError) as exc:
            raise ScientificError("Cannot locate the edge; supply e0 and more points on both sides of it.") from exc
    if not np.isfinite(e0) or not x[1] <= e0 <= x[-2]:
        raise ScientificError("e0 must lie inside the shifted energy range, with data on both sides.")
    return float(e0)


def _normalization_ranges(x, e0, p):
    """Intersect outer fit endpoints with measured support, as in native Larch.

    Keep the requested recipe intact. The returned/effective endpoints describe
    the fit; inner endpoints and polynomial support must still be usable.
    """
    lo, hi = float(x[0] - e0), float(x[-1] - e0)
    rounding = 5 if index_nearest(x, e0) > 20 else 2
    pre1 = p.pre1 if p.pre1 is not None else max(lo, rounding * round((x[1] - e0) / rounding))
    if p.pre1 is None and pre1 >= 0:
        pre1 = lo
    pre1 = max(pre1, lo)
    pre2 = p.pre2 if p.pre2 is not None else pre1 / 2
    norm2 = p.norm2 if p.norm2 is not None else min(hi, 5 * round(hi / 5))
    if p.norm2 is None and norm2 <= 2:
        norm2 = hi
    norm2 = min(norm2, hi)
    norm1 = p.norm1 if p.norm1 is not None else min(25, 5 * round(norm2 / 15))
    if p.norm1 is None:
        norm1 = max(0, min(norm1, norm2 - 2))
    if not lo <= pre1 < pre2 <= 0:
        raise ScientificError("pre1/pre2 must be ordered, below e0 and inside the measured energy range.")
    if not 0 <= norm1 < norm2 <= hi or norm2 - norm1 < 2:
        raise ScientificError("norm1/norm2 must span at least 2 eV above e0 inside the measured energy range.")
    nnorm = p.nnorm
    if nnorm is None:
        nnorm = 0 if norm2 - norm1 < 30 else (1 if norm2 - norm1 < 300 else 2)
    npre = index_nearest(x, e0 + pre2) - index_of(x, e0 + pre1)
    npost = index_nearest(x, e0 + norm2) - index_of(x, e0 + norm1)
    if npre < 3 or npost < max(3, nnorm + 2) or (nnorm > 1 and npost < 5):
        raise ScientificError("Normalization windows contain too few points; widen them or lower nnorm.")
    return dict(pre1=pre1, pre2=pre2, norm1=norm1, norm2=norm2, nnorm=nnorm)


def normalization_adjustments(parameters, effective):
    """Report outer endpoint resolutions without changing saved user choices."""
    return [dict(parameter=key, requested=parameters[key], used=effective[key])
            for key in ('pre1', 'norm2') if parameters.get(key) is not None
            and effective.get(key) is not None and parameters[key] != effective[key]]


def normalization_warnings(parameters, effective):
    return [f"Normalization {a['parameter']}: requested {a['requested']:.10g} eV relative to E0; "
            f"using {a['used']:.10g} eV at the measured boundary. The requested value is retained."
            for a in normalization_adjustments(parameters, effective)]


def _fft_capacity(kmax, p):
    # xftr returns only nfft/2 points. Avoid both forward truncation and q/chiq
    # length mismatches, and bound xftf_prep's temporary interpolation grid.
    if int(1.01 + kmax / p.kstep) > p.nfft // 2:
        raise ScientificError("The k grid exceeds nfft/2; increase nfft or kstep, or reduce bkg_kmax.")
    if int(1.01 + (kmax + p.dk) / p.kstep) > MAX_NFFT:
        raise ScientificError("The transform window creates an oversized grid; reduce dk or increase kstep.")


def _larch_window(window, width, warnings):
    # Ifeffit window.f permits beta=0: I0(0)/I0(0)=1 strictly inside
    # the window. Larch calls that implementation 'bessel'; its newer
    # 'kaiser' formula instead degenerates to an all-zero array at beta=0.
    if window == "kaiser" and width == 0:
        note = "Zero-width Kaiser uses Larch's legacy Bessel window (the rectangular limit)."
        if note not in warnings:
            warnings.append(note)
        return "bessel"
    return window


def _transforms(group, p, effective, warnings):
    available = float(group.k[-1])
    kmin = p.kmin
    if p.kmax is not None:
        kmax = p.kmax
        # AUTOBK's uniform output grid stops at the last full kstep, while
        # its measured support can extend a fraction of a step beyond it.
        # Larch xftf accepts a window ending within that physical support.
        support = max(available, float(getattr(getattr(group, "autobk_details", None), "kmax", available)))
        if kmax > support + 1e-10:
            raise ScientificError(f"kmax exceeds available k={support:.4g}; lower kmax or extend the data.")
    else:
        if available <= kmin + max(4 * p.kstep, p.dk):
            if p.kmin != AthenaParameters.model_fields["kmin"].default:
                raise ScientificError("kmin leaves no usable transform range; lower kmin or use XANES processing.")
            kmin = max(float(group.k[0]), available / 2)
            warnings.append("Short k range: automatic kmin was reduced to retain measured data.")
        # Reserve about 1 inverse angstrom at the upper end, less for short data.
        kmax = available - min(1.0, (available - kmin) / 4)
    if kmin < group.k[0] - 1e-10 or kmax - kmin < 2 * p.kstep:
        raise ScientificError("The FT range must contain at least three measured k points; adjust kmin/kmax.")
    if p.window not in ("kaiser", "gaussian") and p.dk > 2 * (kmax - kmin):
        raise ScientificError("dk is too wide for the selected k range; reduce dk or widen kmin/kmax.")
    if p.rwindow not in ("kaiser", "gaussian") and p.dr > 2 * (p.rmax - p.rmin):
        raise ScientificError("dr is too wide for the selected R range; reduce dr or widen rmin/rmax.")
    _fft_capacity(available, p)
    rstep = np.pi / (p.nfft * p.kstep)
    if p.rmax - p.rmin < rstep:
        raise ScientificError("The R window is narrower than one FFT bin; widen it or increase nfft.")
    rlast = rstep * (p.nfft // 2 - 1)
    rmax_out = min(rlast, max(10.0, p.rmax + p.dr / 2 + rstep))
    # This checkout's xftf_prep casts kweight to int. On our already uniform,
    # zero-origin k grid, explicit weighting before its identity interpolation
    # implements real exponents without modifying Larch or truncating them.
    group.weighted_chi = group.chi * group.k ** p.kweight
    xftf(group.k, group.weighted_chi, group=group, kmin=kmin, kmax=kmax,
         kweight=0, dk=p.dk, window=_larch_window(p.window, p.dk, warnings), nfft=p.nfft,
         kstep=p.kstep, rmax_out=rmax_out)
    xftr(group.r, group.chir, group=group, rmin=p.rmin, rmax=p.rmax,
         dr=p.dr, window=_larch_window(p.rwindow, p.dr, warnings), nfft=p.nfft, kstep=p.kstep,
         qmax_out=available)
    # Preserve 2*pi phase equivalence to the actual complex transforms. The
    # local Larch complex_phase helper can also remove odd multiples of pi.
    group.chir_pha = np.unwrap(np.angle(group.chir))
    group.chiq_pha = np.unwrap(np.angle(group.chiq))
    effective.update(kmin=float(kmin), kmax=float(kmax), available_kmax=available,
                     rmax_out=float(rmax_out), rstep=float(rstep), qmax_out=available)


def _functional_normalization(energy, mu, pre, post, e0):
    """Return corrected mu and the post-edge maximum of post-pre, in mu units.

    Implements Demeter's process/ifeffit/fnorm.tmpl at revision
    06afc8da08a5a7d5a26ee14992170fcf5dc67406:
    https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/fnorm.tmpl
    Its Ifeffit ceil(array) means ARRAY MAXIMUM, not integer rounding (Ifeffit
    1.2.11d src/lib/decod.f, v1mth). The factor is 1 before the nearest e0
    sample and (post-pre)/max(post-pre) from that sample onward. Divide the
    entire mu signal by this factor, then refit pre_edge and AUTOBK. Dividing
    an already extracted chi is not equivalent. energy/e0 are shifted eV;
    the supplied pre/post curves retain this wrapper's Larch polynomial order.
    Reject nonpositive divisors instead of concealing ill-chosen fit ranges.
    """
    # The expression parser's nofx dispatches to nofxa (misc_num.f), which
    # selects the first/lower sample at a tie, as does Larch index_nearest.
    start = index_nearest(energy, e0)
    try:
        with np.errstate(over="raise", divide="raise", invalid="raise"):
            difference = post[start:] - pre[start:]
            if not np.isfinite(difference).all() or np.any(difference <= 0):
                raise ScientificError("fnorm requires a positive, finite post_edge - pre_edge from e0 to the end of the data; adjust the normalization ranges/order.")
            scale = float(np.max(difference))
            factor = np.ones_like(mu)
            factor[start:] = difference / scale
            corrected = mu / factor
    except ArithmeticError as exc:
        raise ScientificError("fnorm correction overflowed; choose better pre/post-edge fits or rescale mu.") from exc
    if not np.isfinite(corrected).all():
        raise ScientificError("fnorm correction overflowed; choose better pre/post-edge fits or rescale mu.")
    return corrected, scale


def _background_standard(standard):
    """Validate an explicitly supplied, unweighted, dimensionless chi(k)."""
    if standard is None:
        return None
    if not isinstance(standard, Mapping) or set(standard) != {"k", "chi"}:
        raise ScientificError("background_standard must be a mapping containing exactly k and chi arrays; supply the standard's processed, unweighted chi(k).")
    k, chi = _pair(standard["k"], standard["chi"], name="Background standard", minimum=4)
    if k[0] < 0 or k[-1] > 100:
        raise ScientificError("Background standard k must be between 0 and 100 inverse angstroms.")
    return k, chi


def _standard_arguments(standard, kmax, kstep, edge_step):
    """Map chi_std into local Larch's unnormalized (mu-bkg) residual units.

    Larch autobk._resid subtracts chi_std BEFORE dividing by edge_step; thus
    a dimensionless standard needs the factor edge_step. Its np.interp would
    otherwise extend endpoint values silently, so require full kout coverage.
    Both endpoints and endpoint-clamp samples are included, even at kmin > 0.
    Larch fits the supplied amplitude without the automatic standard-amplitude
    adjustment in Ifeffit 1.2.11d spline.f/splfun.f. E0 is never fitted here.
    """
    if standard is None:
        return {}
    k, chi = standard
    last = kstep * (int(1.01 + kmax / kstep) - 1)
    if k[0] > 0 or k[-1] < last:
        raise ScientificError(f"Background standard must cover the complete AUTOBK grid from k=0 to {last:.12g} inverse angstroms; extend the standard or lower bkg_kmax. No extrapolation is performed.")
    try:
        with np.errstate(over="raise", invalid="raise"):
            scaled_chi = chi * edge_step
    except ArithmeticError as exc:
        raise ScientificError("Background standard scaling overflowed; check the standard's dimensionless chi amplitude and the sample's edge step.") from exc
    return {"k_std": k, "chi_std": scaled_chi}


def process_spectrum(energy, mu, parameters: AthenaParameters | Mapping | None, data_type="mu", *,
                     background_standard: Mapping | None = None, is_normalized: bool = False) -> dict:
    """Return {effective, arrays, warnings}; every ARRAY_NAMES key is present.

    mu: normalize, subtract AUTOBK background, forward FT and reverse FT.
    xanes: normalize only, regardless of the amount of post-edge data.
    is_normalized preserves the independent native is_nor flag for energy
    records, including XANES reached by the main-page type toggle. It skips
    pre_edge fitting while retaining the type's EXAFS eligibility.
    norm: preserve input as norm/flat (edge_step=1), then AUTOBK and FTs.
    chi: arguments are k and chi; resample to kstep and run FTs only. Energy
         arrays are empty and energy_shift must be zero.
    Unavailable arrays are []; inactive effective settings are None. Short
    mu/norm data return normalization with a warning if EXAFS is unavailable.
    Explicit invalid ranges still fail. Input arrays are never modified.
    When kmax is automatic, default kmin=3 may decrease for short data, even
    when the recipe was round-tripped through a fully populated dictionary.

    dmude and d2mude are the first/second derivatives of unflattened normalized
    mu in eV^-1/eV^-2, using Larch's gradient-ratio convention. chir_pha and
    chiq_pha are np.unwrap(angle(complex_transform)) in radians (arbitrary where
    magnitude vanishes). chiq_re + 1j*chiq_im preserves the actual complex
    reverse transform on q, including its imaginary sign and applied FT weight.
    The background controls and forward FT controls are independent. Reported
    bkg_dk, bkg_window, nclamp and real weights are the supplied Larch settings;
    background effective settings are None when AUTOBK is not run.
    fnorm=True is for low-energy fluorescence EXAFS in raw mu input only.
    Following Athena bkg/ednorm.html and Demeter's fnorm.tmpl, divide mu by
    a scaled post_edge-pre_edge curve BEFORE refitting normalization and
    AUTOBK. Pre-edge samples before the nearest e0 sample are unchanged.
    E-space arrays (including bkg, norm, flat and derivatives) still describe
    the original mu, while chi and all its transforms use the corrected mu.
    effective.edge_step remains the original E-space step; fnorm_edge_step
    records the independently fitted corrected step (or the explicit p.step),
    and fnorm_scale is max(post_edge-pre_edge) on the post-edge data, in mu
    units. Both diagnostics are None when fnorm is off. This reproduces the
    correction sequence, not Ifeffit's different polynomial/spline numerics.

    background_standard optionally supplies exactly {"k": array, "chi": array}:
    4..100000 real finite pairs, strictly increasing k in inverse angstroms
    within [0,100], chi unweighted and dimensionless. It must cover the FULL
    AUTOBK output grid from 0 through kstep*(int(1.01+bkg_kmax/kstep)-1).
    Linear interpolation is Larch's; no extrapolation, standard amplitude fit,
    k weighting, phase correction or alignment is added. The caller must
    provide a suitably scaled standard with comparable local structure and
    consistent E0. Only the low-R objective and endpoint clamps use the
    standard; returned chi is the sample's chi, not sample-minus-standard.
    The fixed-amplitude local Larch behavior differs from Ifeffit's automatic
    standard scaling. effective.background_standard records whether applied;
    background_standard_kmin/kmax/points describe its supplied support.

    fnorm rejects norm/xanes/chi/xmudat input because no raw-mu EXAFS correction
    can be performed there. Standards support mu/norm/xmudat, and reject xanes/chi.
    Explicit requests reject insufficient EXAFS support instead of ignoring
    the option. A standard is applied to both raw and corrected AUTOBK runs
    when fnorm is enabled. The caller owns standard selection/persistence;
    no group identifiers or reference spectra are stored in the recipe.
    """
    try:
        p = AthenaParameters.model_validate(parameters.model_dump(exclude_unset=True)
            if isinstance(parameters, AthenaParameters) else ({} if parameters is None else parameters))
    except ValidationError as exc:
        raise ScientificError(f"Invalid Athena parameters: {exc}") from exc
    if data_type not in ("mu", "xanes", "norm", "chi", "xmudat", "detector"):
        raise ScientificError("data_type must be mu, xanes, norm, chi, xmudat, or detector.")
    standard = _background_standard(background_standard)
    if not isinstance(is_normalized, bool) or (is_normalized and data_type in ("chi", "detector")):
        raise ScientificError("is_normalized is a boolean flag for energy spectra.")
    if p.fnorm and (data_type != "mu" or is_normalized):
        raise ScientificError("fnorm requires raw mu input with EXAFS support; use data_type='mu' and supply the original fluorescence mu(E).")
    if standard is not None and data_type not in ("mu", "norm", "xmudat"):
        raise ScientificError("background_standard requires mu or norm input with AUTOBK processing; xanes and chi do not remove a background.")
    x, y = _pair(energy, mu, minimum=3 if data_type == "detector" else 4 if data_type == "chi" else 10)
    effective = p.model_dump()
    effective.update(data_type=data_type, is_normalized=is_normalized or data_type in ("norm", "xmudat"), edge_step=None, exafs=False,
                     fnorm_edge_step=None, fnorm_scale=None, background_standard=standard is not None,
                     background_standard_kmin=None if standard is None else float(standard[0][0]),
                     background_standard_kmax=None if standard is None else float(standard[0][-1]),
                     background_standard_points=None if standard is None else int(standard[0].size))
    arrays = {key: [] for key in ARRAY_NAMES}
    warnings = []
    group = Group()
    try:
        if data_type == "detector":
            x += p.energy_shift
            if x[0] <= 0 or x[-1] > 1e7:
                raise ScientificError("Supply positive detector energies in eV no greater than 1e7 after energy_shift.")
            group.energy, group.mu = x, y
            effective.update({key: None for key in p.model_dump() if key != "energy_shift"})
            warnings.append("Detector signal: counts are shown without edge finding, normalization, background removal, or Fourier transforms.")
        elif data_type == "chi":
            if p.energy_shift != 0:
                raise ScientificError("energy_shift cannot be applied to chi(k); supply an unshifted k axis.")
            if x[0] < 0 or x[-1] > 100:
                raise ScientificError("chi coordinates must be k in the range 0 to 100 inverse angstroms.")
            _fft_capacity(float(x[-1]), p)
            # Larch's FT assumes a zero-origin grid. Missing low-k data are zero,
            # and the selected window must start within measured support.
            group.k = p.kstep * np.arange(int(np.floor(x[-1] / p.kstep + 1e-8)) + 1)
            group.chi = np.interp(group.k, x, y, left=0)
            if p.kmin < x[0]:
                raise ScientificError("kmin is below the measured chi range; raise kmin.")
            if group.k.size < 4:
                raise ScientificError("kstep leaves fewer than four chi points; decrease kstep.")
            effective.update({key: None for key in ("e0", "step", "pre1", "pre2", "norm1", "norm2",
                "nnorm", "flatten", "rbkg", "bkg_kmin", "bkg_kmax", "bkg_kweight",
                "bkg_dk", "bkg_window", "nclamp", "clamp_lo", "clamp_hi")})
        else:
            x += p.energy_shift
            if x[0] <= 0 or x[-1] > 1e7:
                raise ScientificError("Supply positive energies in eV no greater than 1e7 after energy_shift.")
            if np.any(np.diff(x) < TINY_ENERGY):
                raise ScientificError("Energy spacing is below Larch's 0.0005 eV limit; rebin close points before processing.")
            group.energy, group.mu = x, y
            e0 = _edge(x, y, p.e0)
            if is_normalized or data_type in ("norm", "xmudat"):
                group.e0, group.edge_step = e0, 1.0
                group.norm, group.flat = y.copy(), y.copy()
                group.pre_edge, group.post_edge = np.zeros_like(y), np.ones_like(y)
                group.dmude = np.gradient(y) / np.gradient(x)
                group.d2mude = np.gradient(group.dmude) / np.gradient(x)
                effective.update({key: None for key in ("pre1", "pre2", "norm1", "norm2", "nnorm", "flatten")})
                warnings.append("Input is already normalized: normalization and flattening were not refitted.")
            else:
                ranges = _normalization_ranges(x, e0, p)
                pre_edge(x, y, group=group, e0=e0, step=p.step, make_flat=p.flatten, **ranges)
                effective.update({key: getattr(group.pre_edge_details, key) for key in ranges})
                warnings.extend(normalization_warnings(p.model_dump(), effective))
                ie0 = index_nearest(x, e0)
                fitted_step = float(group.post_edge[ie0] - group.pre_edge[ie0])
                if p.step is None and fitted_step <= max(1e-12, np.ptp(y) * 1e-10):
                    raise ScientificError("The fitted edge step is not positive; check mu, e0 and normalization windows.")
            effective.update(e0=float(group.e0), step=float(group.edge_step), edge_step=float(group.edge_step))
            available = float(np.sqrt(ETOK * (x[-1] - e0)))
            effective["available_kmax"] = available
            if data_type != "xanes":
                bmax = p.bkg_kmax if p.bkg_kmax is not None else available
                if bmax > available + 1e-10 or p.bkg_kmin >= bmax:
                    raise ScientificError("bkg_kmin/bkg_kmax must be inside the available post-edge k range.")
                if p.kmax is not None and p.kmax > bmax:
                    raise ScientificError("kmax exceeds the background k range; lower kmax or increase bkg_kmax.")
                _fft_capacity(bmax, p)
                if bmax - p.bkg_kmin < 2 or np.count_nonzero(x > e0) < 10:
                    if p.fnorm or standard is not None:
                        raise ScientificError("fnorm/background_standard requires sufficient post-edge data for AUTOBK; extend the EXAFS range or disable the option.")
                    if p.bkg_kmax is not None or p.kmax is not None or p.bkg_kmin != 0:
                        raise ScientificError("The requested EXAFS range is too short; widen it or select xanes.")
                    warnings.append("Insufficient post-edge data for EXAFS; returning normalization only.")
                else:
                    if p.bkg_window not in ("kaiser", "gaussian") and p.bkg_dk > 2 * (bmax - p.bkg_kmin):
                        raise ScientificError("bkg_dk is too wide for the background k range; reduce it or widen bkg_kmin/bkg_kmax.")
                    nkout = int(1.01 + bmax / p.kstep)
                    if p.nclamp > nkout:
                        raise ScientificError("nclamp exceeds the number of AUTOBK k samples; lower nclamp or decrease kstep.")
                    # Avoid duplicate spline knots in sparsely sampled spectra.
                    rbkg = max(p.rbkg, 2 * np.pi / (p.kstep * p.nfft))
                    nspl_raw = 1 + int(2 * rbkg * (bmax - p.bkg_kmin) / np.pi)
                    nspl = max(5, min(128, nspl_raw))
                    rstep = np.pi / (p.kstep * p.nfft)
                    irbkg = int(1 + (nspl_raw - 1) * np.pi / (2 * rstep * (bmax - p.bkg_kmin)))
                    if 2 * irbkg + 2 * p.nclamp <= nspl:
                        raise ScientificError("AUTOBK has too few residuals for its spline; increase rbkg or nclamp.")
                    kraw = np.sqrt(ETOK * np.maximum(0, x[x >= e0] - e0))
                    knot_indices = [index_nearest(kraw, v) for v in np.linspace(p.bkg_kmin, bmax, nspl)]
                    if len(set(knot_indices)) < nspl:
                        raise ScientificError("Too few distinct points for AUTOBK spline knots; lower rbkg or use denser data.")
                    bkg_options = dict(ek0=e0, rbkg=p.rbkg, kmin=p.bkg_kmin, kmax=bmax,
                                       kweight=p.bkg_kweight, dk=p.bkg_dk,
                                       win=_larch_window(p.bkg_window, p.bkg_dk, warnings),
                                       nclamp=p.nclamp, clamp_lo=p.clamp_lo, clamp_hi=p.clamp_hi,
                                       nfft=p.nfft, kstep=p.kstep, calc_uncertainties=False)
                    autobk(x, y, group=group, edge_step=group.edge_step, **bkg_options,
                           **_standard_arguments(standard, bmax, p.kstep, group.edge_step))
                    effective["background_covariance_available"] = group.autobk_details.covar is not None
                    if group.autobk_details.covar is None:
                        warnings.append("Background fit covariance is unavailable; fitted curves are shown without an uncertainty estimate.")
                    if p.fnorm:
                        corrected_mu, scale = _functional_normalization(x, y, group.pre_edge, group.post_edge, e0)
                        corrected = Group()
                        pre_edge(x, corrected_mu, group=corrected, e0=e0, step=p.step,
                                 make_flat=False, **ranges)
                        ie0 = index_nearest(x, e0)
                        fitted_step = float(corrected.post_edge[ie0] - corrected.pre_edge[ie0])
                        if p.step is None and fitted_step <= max(1e-12, np.ptp(corrected_mu) * 1e-10):
                            raise ScientificError("fnorm produced a nonpositive or unresolved corrected edge step; adjust pre/post-edge ranges or disable fnorm.")
                        autobk(x, corrected_mu, group=corrected, edge_step=corrected.edge_step,
                               **bkg_options, **_standard_arguments(standard, bmax, p.kstep, corrected.edge_step))
                        group.k, group.chi = corrected.k, corrected.chi
                        effective.update(fnorm_edge_step=float(corrected.edge_step), fnorm_scale=scale)
                        warnings.append("Energy-dependent normalization (fnorm) assumes low-energy fluorescence EXAFS affected by an energy-dependent I0 response and reliable pre/post-edge fits. E-space mu/background/normalization remain uncorrected; chi and R/q use a separately corrected and refitted spectrum.")
                    if standard is not None:
                        warnings.append("Background standard uses fixed-amplitude, unweighted chi(k) in Larch's low-R objective and endpoint clamps. Supply comparable local structure and consistent E0; no automatic amplitude or E0 adjustment is fitted, unlike legacy Ifeffit standard scaling.")
                    effective.update(rbkg=float(group.rbkg), bkg_kmin=float(group.autobk_details.kmin),
                                     bkg_kmax=float(group.autobk_details.kmax), bkg_dk=float(p.bkg_dk),
                                     bkg_window=p.bkg_window, nclamp=p.nclamp,
                                     bkg_kweight=float(p.bkg_kweight))
        if hasattr(group, "chi"):
            _transforms(group, p, effective, warnings)
            effective["exafs"] = True
        else:
            effective.update({key: None for key in ("rbkg", "bkg_kmin", "bkg_kmax", "bkg_kweight",
                "bkg_dk", "bkg_window", "nclamp",
                "clamp_lo", "clamp_hi", "kmin", "kmax", "kweight", "dk", "window", "rmin", "rmax",
                "dr", "rwindow", "nfft", "kstep")})
        for key in ARRAY_NAMES:
            if hasattr(group, key):
                arrays[key] = _lists(getattr(group, key), key)
    except ScientificError:
        raise
    except (ValueError, TypeError, IndexError, RuntimeError, ArithmeticError) as exc:
        raise ScientificError(f"Larch processing failed ({exc}); check sampling and widen the fit ranges, or use xanes for short scans.") from exc
    return {"effective": effective, "arrays": arrays, "warnings": warnings}


def calibrate_shift(energy, mu, target, observed=None) -> float:
    """Return target - observed (eV), to ADD to energy.

    Detect observed with Larch, or the interior derivative maximum for scans
    below 100 points (avoiding a small-array edge-finding bug in local Larch).
    """
    x, y = _pair(energy, mu, minimum=10)
    target = _number(target, "target")
    if target <= 0:
        raise ScientificError("target must be a positive energy in eV.")
    observed = _edge(x, y) if observed is None else _number(observed, "observed")
    if not x[0] <= observed <= x[-1]:
        raise ScientificError("observed must lie inside the measured energy range.")
    return float(target - observed)


def align_shift(energy, mu, reference_energy, reference_mu, emin=None, emax=None) -> float:
    """Derivative least-squares shift in eV, ADDED to the moving energy axis.

    emin/emax are absolute reference energies. The fit uses fixed overlap,
    never extrapolates, and optimizes a positive derivative scale plus offset.
    Shifts are bounded to +/- min(50 eV, one quarter of the initial overlap).
    A solution at the bound is rejected; pre-calibrate larger offsets first.
    """
    x, y = _pair(energy, mu, minimum=10)
    rx, ry = _pair(reference_energy, reference_mu, name="Reference", minimum=10)
    lo, hi = max(x[0], rx[0]), min(x[-1], rx[-1])
    if hi <= lo:
        raise ScientificError("Alignment requires overlapping energy ranges; pre-calibrate the spectra first.")
    bound = min(50.0, (hi - lo) / 4)
    start = max(lo, x[0] + bound) if emin is None else _number(emin, "emin")
    stop = min(hi, x[-1] - bound) if emax is None else _number(emax, "emax")
    if not lo <= start < stop <= hi:
        raise ScientificError("emin/emax must be ordered absolute energies inside the shared overlap.")
    grid = rx[(rx >= start) & (rx <= stop)]
    if grid.size < 10:
        raise ScientificError("Alignment overlap contains fewer than ten points; widen emin/emax.")
    lower, upper = max(-bound, grid[-1] - x[-1]), min(bound, grid[0] - x[0])
    if upper - lower <= 1e-6:
        raise ScientificError("No shift can be fitted without extrapolation; narrow the alignment window.")
    moving = np.gradient(y, x)
    observed = np.interp(grid, rx, np.gradient(ry, rx))
    scale = np.linalg.norm(observed - observed.mean())
    if scale <= 1e-12 or np.ptp(moving) <= 1e-12:
        raise ScientificError("Alignment needs varying edge derivatives; choose a window containing the edge.")

    def residual(shift):
        shifted = np.interp(grid - float(shift[0]), x, moving)
        centered = shifted - shifted.mean()
        denom = float(centered @ centered)
        amplitude = max(0.0, float(centered @ (observed - observed.mean())) / max(denom, 1e-300))
        return (amplitude * centered - (observed - observed.mean())) / scale

    trials = np.linspace(lower, upper, 81)
    costs = [np.sum(residual([shift]) ** 2) for shift in trials]
    seed = float(trials[int(np.argmin(costs))])
    result = least_squares(residual, [np.clip(seed, lower + 1e-8, upper - 1e-8)],
                           bounds=([lower], [upper]), ftol=1e-12, xtol=1e-12, gtol=1e-12)
    shift = float(result.x[0])
    if not result.success or min(shift - lower, upper - shift) < 1e-5:
        raise ScientificError("Alignment reached its shift bound; pre-calibrate the spectra or narrow the fit window.")
    if np.sum(result.fun ** 2) >= 0.99:
        raise ScientificError("No matching derivative structure was found; select comparable edges and a better window.")
    return shift


def _spectra(spectra, *, minimum=1):
    if not isinstance(spectra, Sequence) or not minimum <= len(spectra) <= MAX_SPECTRA:
        raise ScientificError(f"Supply between {minimum} and {MAX_SPECTRA} spectra.")
    pairs = []
    for i, pair in enumerate(spectra):
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            raise ScientificError(f"Spectrum {i + 1} must be a (coordinates, signal) pair.")
        pairs.append(_pair(*pair, name=f"Spectrum {i + 1}"))
    return pairs


def _matrix(pairs, grid):
    if len(pairs) * grid.size > MAX_MATRIX_VALUES:
        raise ScientificError("The shared matrix is too large; reduce the number of spectra or rebin the data.")
    return np.asarray([np.interp(grid, x, y) for x, y in pairs])


def _fit_grid(pairs, xmin, xmax):
    lo, hi = _number(xmin, "xmin"), _number(xmax, "xmax")
    if lo >= hi:
        raise ScientificError("xmax must be greater than xmin.")
    if lo < max(x[0] for x, _ in pairs) or hi > min(x[-1] for x, _ in pairs):
        raise ScientificError("The fit range must lie inside every spectrum's measured overlap; reduce xmin/xmax.")
    x = pairs[0][0]
    grid = x[(x >= lo) & (x <= hi)]
    if grid.size < 3:
        raise ScientificError("The fit range needs at least three points; widen xmin/xmax.")
    return grid


def _combination_weights(weights, count, mode):
    """Validate per-spectrum coefficients, normalizing only merge weights."""
    if not isinstance(mode, str) or mode not in ("merge", "sum"):
        raise ScientificError("mode must be 'merge' (weighted average) or 'sum' (signed linear sum).")
    if weights is None:
        raw = np.ones(count)
    else:
        try:
            raw = np.asarray(weights)
            if raw.ndim != 1 or raw.size != count or raw.dtype.kind not in "iuf":
                raise ValueError
            if any(isinstance(value, (bool, np.bool_)) for value in weights):
                raise ValueError
            raw = raw.astype(float, copy=True)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ScientificError("weights must be a one-dimensional sequence with one real number per spectrum; booleans are not weights.") from exc
    if not np.isfinite(raw).all():
        raise ScientificError("weights must all be finite; remove NaN and infinite coefficients.")
    if mode == "sum":
        return raw, raw.copy()
    if np.any(raw < 0) or not np.any(raw > 0):
        raise ScientificError("Merge weights must be nonnegative with at least one positive value; use mode='sum' for signed coefficients.")
    # Relative scaling prevents a finite set of large weights overflowing its
    # normalization denominator. Do not silently drop unrepresentable weights.
    scaled = raw / np.max(raw)
    coefficients = scaled / scaled.sum()
    if np.any((raw > 0) & (coefficients == 0)):
        raise ScientificError("Merge weight dynamic range is too large; reduce the ratio between the largest and smallest positive weights.")
    return raw, coefficients


def _combination_uncertainty(pairs, grid, uncertainties, coefficients):
    """Propagate independent native-sample errors through linear interpolation."""
    if uncertainties is None:
        return None
    if (not isinstance(uncertainties, (Sequence, np.ndarray))
            or isinstance(uncertainties, np.ndarray) and uncertainties.ndim == 0
            or len(uncertainties) != len(pairs)):
        raise ScientificError("uncertainties must provide one standard-deviation scalar or native-grid array per spectrum.")
    propagated = np.zeros(grid.size)
    for i, ((x, _), uncertainty, coefficient) in enumerate(zip(pairs, uncertainties, coefficients)):
        try:
            sigma = np.asarray(uncertainty)
            if sigma.dtype.kind not in "iuf" or sigma.ndim > 1:
                raise ValueError
            if sigma.ndim == 1 and sigma.size != x.size:
                raise ValueError
            if isinstance(uncertainty, (bool, np.bool_)) or (
                sigma.ndim == 1 and any(isinstance(value, (bool, np.bool_)) for value in uncertainty)
            ):
                raise ValueError
            sigma = sigma.astype(float, copy=True)
            if not np.isfinite(sigma).all() or np.any(sigma < 0):
                raise ValueError
        except (TypeError, ValueError, OverflowError) as exc:
            raise ScientificError(f"uncertainties[{i}] must be nonnegative, finite standard deviations: a scalar or one-dimensional array matching its native spectrum.") from exc
        if coefficient == 0:
            continue
        right = np.clip(np.searchsorted(x, grid, side="right"), 1, x.size - 1)
        fraction = (grid - x[right - 1]) / (x[right] - x[right - 1])
        left_sigma, right_sigma = (sigma, sigma) if sigma.ndim == 0 else (sigma[right - 1], sigma[right])
        interpolated = np.hypot((1 - fraction) * left_sigma, fraction * right_sigma)
        propagated = np.hypot(propagated, abs(coefficient) * interpolated)
    return propagated


def _combine_spectra(spectra, weights, mode, uncertainties):
    pairs = _spectra(spectra)
    raw_weights, coefficients = _combination_weights(weights, len(pairs), mode)
    lo, hi = max(x[0] for x, _ in pairs), min(x[-1] for x, _ in pairs)
    grid = pairs[0][0][(pairs[0][0] >= lo) & (pairs[0][0] <= hi)]
    if grid.size < 2:
        raise ScientificError("Combining requires at least two first-spectrum points in the shared overlap of all inputs.")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            values = _matrix(pairs, grid)
            if not np.isfinite(values).all():
                raise ScientificError("Interpolation overflowed; rescale the spectra before combining.")
            components = coefficients[:, None] * values
            if mode == "merge":
                active = coefficients > 0
                # Compute a centered population variance on a scaled signal,
                # rather than subtracting nearly equal second moments. Zero
                # weight inputs cannot set the scale or contaminate statistics.
                included = values[active]
                scale = np.max(np.abs(included), axis=0)
                scale[scale == 0] = 1
                reduced = included / scale
                differences = reduced - reduced[0]
                mean_difference = coefficients[active] @ differences
                y = (reduced[0] + mean_difference) * scale
                stddev = np.sqrt(coefficients[active] @ ((differences - mean_difference)**2)) * scale
            else:
                y, stddev = components.sum(axis=0), None
            uncertainty = _combination_uncertainty(pairs, grid, uncertainties, coefficients)
            numeric = [y, components]
            numeric.extend(value for value in (stddev, uncertainty) if value is not None)
            if not all(np.isfinite(value).all() for value in numeric):
                raise ScientificError("Combined values overflowed; rescale signals, weights, or uncertainties.")
    except ArithmeticError as exc:
        raise ScientificError("Combined values overflowed; rescale signals, weights, or uncertainties.") from exc
    return {"x": grid.copy(), "y": y, "stddev": stddev, "uncertainty": uncertainty,
            "weights": raw_weights, "coefficients": coefficients, "components": components,
            "mode": mode, "details": {
                "input_spectra": len(pairs), "overlap": [float(lo), float(hi)],
                "interpolation": "linear on first input's samples in common overlap; no extrapolation",
                "zero_weights": "zero coefficients contribute nothing but all supplied spectra still constrain overlap",
                "normalization": "weights normalized to unit sum; no spectral normalization" if mode == "merge" else "signed coefficients used unchanged; no weight or spectral normalization",
                "stddev_definition": "sqrt(sum(coefficients*(interpolated_y-y)**2)); weighted population scatter, not standard error" if mode == "merge" else "not defined for arbitrary linear sums",
                "uncertainty_definition": "propagated one-sigma errors from supplied uncertainties only; independent native samples and independent spectra, coefficients treated as exact" if uncertainties is not None else "not supplied; scatter is not converted into measurement uncertainty",
                "limitations": "Inputs must already be aligned and in the same units/representation (raw mu, normalized mu, or chi). No automatic edge-step/noise weighting, short-scan exclusion, or linked-reference processing. Weighted scatter uses the documented population convention; exact Demeter weighted-scatter parity is not asserted. Propagation omits cross-spectrum and cross-output-point covariance, alignment errors and uncertainty in normalization/weights.",
            }}


def combine_spectra(spectra: list[tuple], weights=None, *, mode="merge", uncertainties=None) -> dict:
    """Athena-style weighted averages or arbitrary signed linear sums.

    Primary semantics: Athena manual process/merge.html (section 9.3) and
    process/sum.html (section 9.13), at
    https://bruceravel.github.io/demeter/documents/Athena/ . The local Larch
    merge_groups implementation uses population scatter for equal weights;
    its merge_arrays_1d does not apply weights in sum mode, so we calculate
    the explicit coefficients here instead of silently ignoring them.

    spectra is 1..100 (x,y) pairs, each with 2..100000 increasing finite x
    coordinates and finite real y. x is eV for mu(E) or inverse angstroms for
    chi(k); the caller selects one consistent representation and supplies
    already aligned/normalized data as appropriate. No normalization of mu,
    background removal or coordinate shifts occur here.

    weights defaults to all ones. Supply one finite real scalar per spectrum.
    * mode='merge': weights >=0, at least one >0. Applied coefficients are
      a_i=w_i/sum(w); y=sum(a_i*y_i). Arbitrary importance weights are supported.
    * mode='sum': signed coefficients are used unchanged. Neither positivity
      nor sum-to-one is required; all-zero coefficients are valid.
    Zero-weight spectra still define the overlap and first-input grid; remove
    a spectrum from the list to exclude its support. No extrapolation or silent
    exclusion of short scans. The common grid/matrix is limited to 2e6 values.

    Optional uncertainties: one nonnegative finite scalar or native-grid array
    per spectrum, representing one-sigma y errors. Errors are NOT weights and
    do not change the combination. For linear interpolation at fraction t,
    variance=(1-t)^2*sigma_left^2+t^2*sigma_right^2; output variance is then
    sum(a_i^2*interpolated_variance_i). This assumes independent input samples
    and scans and exact coefficients; generated correlations between output
    points are not returned. Correlated/reused scans and normalization/alignment
    uncertainties require a covariance-aware treatment outside this function.

    Returns JSON-ready x, y, mode, weights (supplied/default), coefficients
    (applied), components (a_i*y_i, in input order), stddev, uncertainty, details.
    stddev is sqrt(sum(a_i*(y_i-y)^2)) in merge mode: weighted population
    scatter (ddof=0), zero for one contributing scan, NOT uncertainty of the
    mean. It is None for sums; unequal signals are not replicate measurements.
    uncertainty is propagated one-sigma error in either mode, or None when
    not supplied. No sample-variance or standard-error estimate is invented.
    """
    result = _combine_spectra(spectra, weights, mode, uncertainties)
    return {key: value.tolist() if isinstance(value, np.ndarray) else value
            for key, value in result.items()}


def merge_spectra(spectra: list[tuple], weights=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Backward-compatible (x, weighted_mean, population_stddev) NumPy arrays.

    Omitted weights retain the arithmetic mean and ddof=0 population scatter.
    Explicit weights must be finite and nonnegative with at least one positive
    value; they are normalized internally. Only first-input samples in the
    overlap of ALL inputs are returned, including zero-weight input support.
    No spectral normalization or extrapolation occurs. A single contributor
    has zero scatter. Use combine_spectra for signed sums, component arrays,
    provenance and separately propagated measurement errors.
    """
    result = _combine_spectra(spectra, weights, "merge", None)
    return result["x"], result["y"], result["stddev"]


def linear_combination(target_x, target_y, components: list[tuple], xmin, xmax,
                       sum_to_one=True, nonnegative=True) -> dict:
    """Unweighted linear least squares, with independently selectable constraints.

    Component order is preserved in weights. residual = observed - fit;
    rfactor = sum(residual**2)/sum(observed**2). No shifts, offsets or
    normalization are fitted. The target grid is restricted to xmin/xmax.
    """
    target = _pair(target_x, target_y, name="Target")
    pairs = _spectra(components)
    grid = _fit_grid([target, *pairs], xmin, xmax)
    observed = np.interp(grid, *target)
    design = _matrix(pairs, grid).T
    if grid.size < len(pairs):
        raise ScientificError("There are fewer fit points than components; widen the fit range.")
    rank_design = np.vstack((design, np.ones(len(pairs)))) if sum_to_one else design
    if np.linalg.matrix_rank(rank_design) < len(pairs):
        raise ScientificError("Components are linearly dependent; remove duplicate or indistinguishable standards.")
    factor = max(float(np.max(np.abs(design))), float(np.max(np.abs(observed))), 1e-100)
    a, b = design / factor, observed / factor
    if sum_to_one and nonnegative:
        result = minimize(lambda w: 0.5 * np.sum((a @ w - b) ** 2),
                          np.full(len(pairs), 1 / len(pairs)),
                          jac=lambda w: a.T @ (a @ w - b), method="SLSQP",
                          bounds=[(0, 1)] * len(pairs),
                          constraints=[{"type": "eq", "fun": lambda w: np.sum(w) - 1,
                                        "jac": lambda w: np.ones_like(w)}],
                          options={"ftol": 1e-13, "maxiter": 2000})
        if not result.success:
            raise ScientificError(f"Constrained combination fit failed ({result.message}); inspect the standards.")
        weights = np.maximum(result.x, 0)
        weights /= weights.sum()
    elif nonnegative:
        weights, _ = nnls(a, b, maxiter=100 * len(pairs))
    elif sum_to_one:
        if len(pairs) == 1:
            weights = np.ones(1)
        else:
            first = np.linalg.lstsq(a[:, :-1] - a[:, -1, None], b - a[:, -1], rcond=None)[0]
            weights = np.r_[first, 1 - first.sum()]
    else:
        weights = np.linalg.lstsq(a, b, rcond=None)[0]
    fit = design @ weights
    residual = observed - fit
    denominator = float(b @ b)
    numerator = float((residual / factor) @ (residual / factor))
    if denominator == 0 and numerator > 1e-24:
        raise ScientificError("R-factor is undefined for a zero target with a nonzero fit; select a nonzero target.")
    return dict(x=_lists(grid, "x"), observed=_lists(observed, "observed"), fit=_lists(fit, "fit"),
                residual=_lists(residual, "residual"), weights=_lists(weights, "weights"),
                rfactor=numerator / denominator if denominator else 0.0,
                sum_to_one=bool(sum_to_one), nonnegative=bool(nonnegative))


def principal_components(spectra: list[tuple], xmin, xmax) -> dict:
    """Mean-centered SVD on the first spectrum's grid, without variance scaling.

    Rows are spectra. Reconstruction is mean + scores @ components; components
    are rows of Vt. Sample explained_variance = singular_values**2/(n-1).
    Component signs are fixed by making each largest absolute loading positive.
    Identical spectra have zero explained variance and zero variance ratios.
    """
    pairs = _spectra(spectra, minimum=2)
    grid = _fit_grid(pairs, xmin, xmax)
    values = _matrix(pairs, grid)
    # Subtract before averaging to avoid manufacturing variance when three
    # or more identical spectra round differently in mean(values).
    differences = values - values[0]
    mean_difference = differences.mean(axis=0)
    mean = values[0] + mean_difference
    centered = differences - mean_difference
    u, singular_values, components = np.linalg.svd(centered, full_matrices=False)
    signs = np.sign(components[np.arange(components.shape[0]), np.argmax(np.abs(components), axis=1)])
    components *= signs[:, None]
    scores = u * singular_values * signs
    variance = singular_values ** 2 / (len(pairs) - 1)
    total = float(variance.sum())
    ratios = variance / total if total else np.zeros_like(variance)
    return dict(x=_lists(grid, "x"), mean=_lists(mean, "mean"),
                components=_lists(components, "components"), scores=_lists(scores, "scores"),
                singular_values=_lists(singular_values, "singular_values"),
                explained_variance=_lists(variance, "explained_variance"),
                explained_variance_ratio=_lists(ratios, "explained_variance_ratio"),
                n_components=int(len(singular_values)), n_spectra=len(pairs))
