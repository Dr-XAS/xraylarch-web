"""Read-only k-weight overrides for the spectrum viewer's k, R and q plots."""
from copy import deepcopy

import numpy as np
from larch import Group
from pydantic import BaseModel, ConfigDict, Field

from .athena_science import AthenaParameters, ScientificError, _pair, _transforms


class PlotTransformOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    version: int = Field(ge=0)
    kweight: float = Field(ge=0, le=4)


TRANSFORM_ARRAYS = (
    "k", "chi", "weighted_chi", "kwin", "r", "chir_mag", "chir_re", "chir_im", "chir_pha",
    "q", "chiq_re", "chiq_im", "chiq_mag", "chiq_pha", "rwin",
)
TRANSFORM_PARAMETERS = ("kmin", "kmax", "dk", "window", "rmin", "rmax", "dr", "rwindow", "nfft", "kstep")


def plot_transform(group: dict, options: PlotTransformOptions) -> dict:
    result = group.get("result") or {}
    effective = deepcopy(result.get("effective") or {})
    if group.get("processing_error") or not effective.get("exafs"):
        raise ScientificError("Process an EXAFS group with usable chi(k) before changing its plot k weight.")
    arrays = result.get("arrays") or {}
    k, chi = _pair(arrays.get("k", []), arrays.get("chi", []), name=group["label"], minimum=4)
    # Keep the window and grid of the applied processing, including resolved
    # automatic limits. Only the display weight is changed; AUTOBK is not rerun.
    parameters = {**group["parameters"], **{key: effective[key] for key in TRANSFORM_PARAMETERS
                  if effective.get(key) is not None}, "kweight": options.kweight}
    recipe = AthenaParameters.model_validate(parameters)
    if abs(k[0]) > 1e-10 or not np.allclose(np.diff(k), recipe.kstep, rtol=0, atol=1e-9):
        raise ScientificError("Plot transforms require a uniform k grid starting at zero. Reprocess the group.")
    probe = Group(k=k, chi=chi)
    if effective.get("bkg_kmax") is not None:
        # AUTOBK's measured support may end beyond its last uniform k bin.
        probe.autobk_details = Group(kmax=effective["bkg_kmax"])
    warnings = []
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            _transforms(probe, recipe, effective, warnings)
    except ArithmeticError as exc:
        raise ScientificError("The plot transform overflowed. Reduce the k weight or check chi(k).") from exc
    values = {key: np.asarray(getattr(probe, key)).tolist() for key in TRANSFORM_ARRAYS}
    if not all(np.isfinite(value).all() for value in values.values()):
        raise ScientificError("The plot transform produced nonfinite values. Reduce the k weight or check chi(k).")
    effective["kweight"] = options.kweight
    return dict(group_id=group["id"], kweight=options.kweight, arrays=values,
                effective=effective, warnings=list(dict.fromkeys(warnings)))
