"""Import preprocessing, using Demeter's Larch alignment template.

Reference: Demeter 06afc8da, process/larch/align.tmpl, Data/E0.pm and
UI/Athena/IO.pm. This is the import path's smoothed derivative fit.
"""
import numpy as np
from larch import Group
from larch.fitting import minimize, param
from larch.math import deriv, index_of, interp, savitzky_golay
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import ScientificError, _pair


class ImportPreprocessing(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mark: bool = Field(default=False, strict=True)
    standard_id: str | None = Field(default=None, min_length=1, max_length=100, strict=True)
    copy_parameters: bool = Field(default=False, strict=True)
    align: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def standard_required(self):
        if (self.copy_parameters or self.align) and not self.standard_id:
            raise ValueError("Choose a preprocessing standard before copying parameters or aligning.")
        return self


def import_alignment(moving, standard):
    """Fit absolute shift and derivative scale; never modify either input.

    The pinned template fits [E0-20, E0+50), SG(31, 4), interpolating mu
    before taking derivatives. Native Data/E0.pm stores shift to 0.001 eV.
    The fitted scale is a nuisance parameter; it does not scale imported mu.
    """
    x, y = _pair(moving['energy'], moving['mu'], minimum=10)
    rx, ry = _pair(standard['energy'], standard['mu'], name="Standard", minimum=31)
    rx = rx + standard['parameters']['energy_shift']
    def e0(group):
        value = (group.get('result') or {}).get('effective', {}).get('e0')
        if value is None or not np.isfinite(value):
            raise ScientificError(f"{group['label']}: alignment needs a processed absorption edge.")
        return value
    se0, me0 = e0(standard), e0(moving)
    start, stop = se0 - 20., se0 + 50.
    if not rx[0] <= start < stop <= rx[-1]:
        raise ScientificError("Alignment needs standard data covering E₀ − 20 to E₀ + 50 eV.")
    i1, i2 = index_of(rx, start), index_of(rx, stop)
    if i2 - i1 < 10:
        raise ScientificError("Alignment needs at least ten standard points around the edge.")
    observed = savitzky_golay(deriv(ry) / deriv(rx), window_size=31, order=4)
    if np.ptp(observed[i1:i2]) <= 1e-12 or np.ptp(deriv(y) / deriv(x)) <= 1e-12:
        raise ScientificError("Alignment needs varying edge derivatives in both spectra.")
    # Native fit starts from the difference of the two processed E0 values.
    pars = Group(esh=param(se0 - me0, vary=True), scale=param(1., vary=True))
    def residual(pars):
        shifted = interp(x + pars.esh, y, rx, fill_value=0.)
        fitted = savitzky_golay(deriv(shifted) / deriv(rx), window_size=31, order=4)
        return (observed - pars.scale * fitted)[i1:i2]
    result = minimize(residual, pars, max_nfev=2000)
    shift, scale = float(pars.esh.value), float(pars.scale.value)
    if not result.success or not np.isfinite([shift, scale]).all() or not np.isfinite(result.residual).all():
        raise ScientificError("Automatic alignment did not converge. Check the standard and selected columns.")
    # A constant extrapolated tail is not an absorption-edge alignment.
    if not x[0] + shift <= start < stop <= x[-1] + shift:
        raise ScientificError("Aligned data do not cover the standard's edge window. Choose overlapping scans.")
    if scale <= 0 or np.linalg.norm(result.residual) >= np.linalg.norm(observed[i1:i2]):
        raise ScientificError("No matching edge derivatives were found. Check the standard and selected columns.")
    stderr = pars.esh.stderr
    return {'method': 'demeter-larch-smoothed-derivative', 'energy_shift': float(f'{shift:.3f}'),
            'fitted_shift': shift, 'shift_stderr': float(stderr) if stderr is not None and np.isfinite(stderr) else None,
            'derivative_scale': scale, 'xmin': start, 'xmax': stop,
            'smoothing_window': 31, 'smoothing_order': 4, 'fit_points': int(i2 - i1)}
