"""Demeter/Larch alignment: interpolate mu first, then fit derivative and scale."""
import hashlib
from typing import Literal

import numpy as np
from larch import Group
from larch.fitting import minimize, param
from larch.math import deriv, index_of, interp, savitzky_golay
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_calibration import calibration_curve, CalibrationOptions
from .athena_science import ScientificError, _pair
from .athena_smoothing import smooth, SmoothOptions


class AlignmentOptions(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    method: Literal['demeter-larch']='demeter-larch'
    standard_id: str=Field(min_length=1,max_length=100,strict=True)
    operation: Literal['inspect','manual','auto']='inspect'
    display: Literal['mu','norm','derivative','smoothed']='smoothed'
    fit: Literal['derivative','smoothed']='smoothed'
    use_reference: bool=Field(default=False,strict=True)
    energy_shift: float|None=Field(default=None,strict=True,ge=-1e6,le=1e6)
    sg_window: int|None=Field(default=None,strict=True,ge=0,le=39)
    sg_order: int|None=Field(default=None,strict=True,ge=9,le=39)

    @model_validator(mode='after')
    def manual_shift(self):
        if self.operation=='manual' and self.energy_shift is None:raise ValueError('Enter a total energy shift in eV.')
        return self


def edge(group):
    if group['data_type'] in ('chi','detector') or group.get('is_difference'):
        raise ScientificError('Choose an absorption spectrum for alignment.')
    value=group['parameters'].get('e0')
    if value is None:value=(group.get('result') or {}).get('effective',{}).get('e0')
    if value is None or not np.isfinite(value):raise ScientificError(f"{group['label']}: alignment needs a resolved absorption edge.")
    return float(value)


def signature(group):
    digest=hashlib.sha256()
    for key in ('energy','mu'):digest.update(np.asarray(group[key],dtype='<f8').tobytes())
    return digest.hexdigest()


def saved_fit(group):
    record=group['source'].get('alignment')
    if isinstance(record,dict) and record.get('signature')==signature(group) and record.get('energy_shift')==group['parameters']['energy_shift']:
        return record
    return None


def fit_alignment(moving,standard,*,smoothed=True,sg_window=31,sg_order=9):
    """The original template's fixed [standard E0-20, E0+50) fit interval.

    Returns an absolute shift, nuisance derivative scale, uncertainty and the
    actual fit residual. The nuisance scale is never applied to measured mu.
    """
    x,y=_pair(moving['energy'],moving['mu'],minimum=10)
    rx,ry=_pair(standard['energy'],standard['mu'],name='Standard',minimum=10)
    rx=rx+standard['parameters']['energy_shift']
    se0,me0=edge(standard),edge(moving);start,stop=se0-20,se0+50
    if not rx[0]<=start<stop<=rx[-1]:raise ScientificError('Alignment needs standard data covering E₀ − 20 to E₀ + 50 eV.')
    i1,i2=index_of(rx,start),index_of(rx,stop)
    if i2-i1<10:raise ScientificError('Alignment needs at least ten standard points around the edge.')
    observed=deriv(ry)/deriv(rx);settings=None
    if smoothed:
        filtered=smooth(rx,observed,SmoothOptions(method='savitzky_golay',window=sg_window,order=sg_order))
        observed=np.asarray(filtered['mu']);settings=filtered['details']
    if np.ptp(observed[i1:i2])<=1e-12 or np.ptp(deriv(y)/deriv(x))<=1e-12:
        raise ScientificError('Alignment needs varying edge derivatives in both spectra.')
    pars=Group(esh=param(se0-me0,vary=True),scale=param(1.,vary=True))
    def fitted(pars):
        shifted=interp(x+pars.esh,y,rx,fill_value=0.)
        out=deriv(shifted)/deriv(rx)
        if settings:out=savitzky_golay(out,window_size=settings['window'],order=settings['order'])
        return out
    def residual(pars):return (observed-pars.scale*fitted(pars))[i1:i2]
    result=minimize(residual,pars,max_nfev=2000)
    shift,scale=float(pars.esh.value),float(pars.scale.value)
    if not result.success or not np.isfinite([shift,scale]).all() or not np.isfinite(result.residual).all():
        raise ScientificError('Automatic alignment did not converge. Check the standard and selected columns.')
    if not x[0]+shift<=start<stop<=x[-1]+shift:
        raise ScientificError("Aligned data do not cover the standard's edge window. Choose overlapping scans.")
    if scale<=0 or np.linalg.norm(result.residual)>=np.linalg.norm(observed[i1:i2]):
        raise ScientificError('No matching edge derivatives were found. Check the standard and selected columns.')
    stderr=pars.esh.stderr
    stderr=float(stderr) if stderr is not None and np.isfinite(stderr) else None
    summary=dict(method='demeter-larch-smoothed-derivative' if smoothed else 'demeter-larch-derivative',
        energy_shift=float(f'{shift:.3f}'),fitted_shift=shift,shift_stderr=stderr,
        native_shift_stderr=None if stderr is None else float(f'{stderr:.3f}'),derivative_scale=scale,
        xmin=start,xmax=stop,fit_points=int(i2-i1),
        smoothing_window=None if not settings else settings['window'],smoothing_order=None if not settings else settings['order'],
        chisqr=float(result.chi_square),redchi=float(result.chi_reduced))
    return dict(summary=summary,curve=dict(x=rx[i1:i2].tolist(),standard=observed[i1:i2].tolist(),
        fitted=(scale*fitted(pars)[i1:i2]).tolist(),residual=np.asarray(result.residual).tolist()))


def display_curve(group,display):
    e0=edge(group)
    # Align::plot temporarily sets SG size=21/order=4; Config's minint makes
    # the effective order 9. This display override does not alter fit prefs.
    choice=CalibrationOptions(observed=e0,target=e0,display='derivative' if display=='smoothed' else display,
        smoothing=3 if display=='smoothed' else 0,smoothing_method='savitzky_golay',sg_window=21,sg_order=9)
    c=calibration_curve(group,choice)
    return dict(x=c['x'],y=c['y'],e0=e0,label=group['label'],group_id=group['id'])
