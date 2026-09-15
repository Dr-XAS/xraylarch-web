"""Read-only Cauchy wavelet views of a group's processed EXAFS.

Match Dr.XAS's add_wavelet_payload: weight the unwindowed chi(k), run
Larch's Cauchy transform to 10 Å, then clip the displayed R range. Changing
rmax_out in the calculation also changes the wavelet, so it stays fixed.
"""
from __future__ import annotations

import numpy as np
from larch import Group
from larch.xafs import cauchy_wavelet
from pydantic import BaseModel, ConfigDict, Field

from .athena_science import MAX_MATRIX_VALUES, MAX_NFFT, ScientificError


class WaveletOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    version: int = Field(ge=0)
    kweight: float | None = Field(default=None, ge=0, le=4)
    rmax: float = Field(default=6, ge=0.1, le=10)


def wavelet_plot(group: dict, options: WaveletOptions) -> dict:
    result = group.get("result") or {}
    arrays = result.get("arrays") or {}
    if (group.get("data_type") in ("detector", "xanes") or group.get("processing_error")
            or not arrays.get("k") or not arrays.get("chi")):
        raise ScientificError("Process an EXAFS group with usable chi(k) before plotting its wavelet.")
    k = np.asarray(arrays["k"], dtype=float)
    chi = np.asarray(arrays["chi"], dtype=float)
    if (k.ndim != 1 or chi.shape != k.shape or k.size < 4
            or not np.isfinite(k).all() or not np.isfinite(chi).all()):
        raise ScientificError("The wavelet requires matching, finite k and chi arrays with at least four points.")
    step = float(k[1] - k[0])
    if step <= 0 or abs(float(k[0])) > 1e-10 or not np.allclose(np.diff(k), step, rtol=1e-7, atol=1e-10):
        raise ScientificError("The Cauchy wavelet requires a uniform k grid starting at zero. Reprocess the group.")
    # Larch rounds its input spacing to 0.001 Å⁻¹ internally. Reject a grid
    # whose labels would otherwise no longer describe the transformed data.
    rounded_step = round(step, 3)
    if rounded_step <= 0 or not np.isclose(step, rounded_step, rtol=0, atol=1e-10):
        raise ScientificError("The Cauchy wavelet requires kstep in multiples of 0.001 Å⁻¹. Adjust kstep and reprocess.")

    effective = result.get("effective") or {}
    weight = options.kweight
    if weight is None:
        weight = effective.get("kweight", group.get("parameters", {}).get("kweight", 2))
    if isinstance(weight, bool) or weight is None or not np.isfinite(weight) or not 0 <= weight <= 4:
        raise ScientificError("The wavelet k weight must be a finite number between zero and four.")
    weight = float(weight)

    # Larch only reads nfft/2 input samples. Retain Dr.XAS's 2048 default,
    # increasing capacity for finer valid Athena grids instead of truncating.
    nfft = max(2048, 1 << (2 * len(k) - 1).bit_length())
    nrpts = int(np.round((10 - 1e-7) * 2048 * rounded_step / np.pi))
    if nfft > MAX_NFFT or nrpts < 2 or nrpts * len(k) > MAX_MATRIX_VALUES:
        raise ScientificError("This wavelet grid is too large or too sparse. Adjust kstep or reduce the processed k range.")
    with np.errstate(over="raise", invalid="raise"):
        try:
            transformed = Group(k=k.copy(), chi=chi * np.power(k, weight))
            cauchy_wavelet(transformed, kweight=0, nfft=nfft, rmax_out=10)
        except (FloatingPointError, OverflowError) as exc:
            raise ScientificError("The wavelet calculation overflowed. Reduce the k weight or check chi(k).") from exc
    r = np.asarray(transformed.wcauchy_r)
    magnitude = np.asarray(transformed.wcauchy_mag)
    if magnitude.shape != (len(r), len(k)) or not np.isfinite(magnitude).all():
        raise ScientificError("The wavelet calculation did not produce a finite k–R map.")
    mask = (r >= 0) & (r <= options.rmax)
    if np.count_nonzero(mask) < 2:
        raise ScientificError("The display R range contains fewer than two wavelet rows. Increase the R range or kstep.")
    return dict(
        group_id=group["id"], label=group["label"], kweight=weight,
        k=k.tolist(), r=r[mask].tolist(), magnitude=magnitude[mask, :].tolist(),
        metadata=dict(method="cauchy", source="processed_chi", kstep=step,
                      nfft=nfft, rmax_out=10, rmax=options.rmax,
                      window="none", phase_corrected=False),
    )
