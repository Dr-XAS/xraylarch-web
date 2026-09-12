"""Demeter Process::merge and Larch merge templates, including native scatter."""
from typing import Annotated, Literal

import numpy as np
from larch import Group
from larch.math import index_of, interp
from larch.xafs import estimate_noise
from pydantic import BaseModel, ConfigDict, Field

from .athena_science import ScientificError, _pair, MAX_MATRIX_VALUES


class MergeSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    weightby: Literal['importance','noise','step'] = 'importance'
    exclude_short_data: bool = Field(default=True, strict=True)
    short_data_margin: int = Field(default=10, strict=True, ge=0, le=250000)
    plot: Literal['stddev','variance','marked'] = 'stddev'
    push_metadata: bool = Field(default=True, strict=True)
    merge_references: bool = Field(default=True, strict=True)


class MergeDefaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=0, strict=True, ge=0)
    values: MergeSettings = Field(default_factory=MergeSettings)


Weight = Annotated[float, Field(strict=True, ge=0)]


class MergeOptions(MergeSettings):
    method: Literal['demeter-larch'] = 'demeter-larch'
    array: Literal['mu','norm','chi'] = 'mu'
    weights: dict[str,Weight] = Field(default_factory=dict)
    reference_weights: dict[str,Weight] = Field(default_factory=dict)
    label: str | None = Field(default=None, strict=True, min_length=1, max_length=180)


def importance(group):
    value = group['source'].get('importance', group['source'].get('native',{}).get('args',{}).get('importance',1))
    try:
        weight = float(value)
        if isinstance(value,bool) or not np.isfinite(weight) or weight < 0: raise ValueError
        return weight
    except (ValueError,TypeError):
        raise ScientificError(f"{group['label']}: importance must be a finite nonnegative number.")


def signal(group, array):
    if group['data_type']=='detector' or group.get('is_difference'):
        raise ScientificError('Choose absorption spectra for an Athena merge.')
    if array=='mu':
        if group['data_type']=='chi': raise ScientificError('χ(k) groups cannot supply μ(E).')
        return _pair(group['energy'],group['mu'],minimum=8)
    result = (group.get('result') or {}).get('arrays',{})
    coordinate = 'k' if array=='chi' else 'energy'
    if not result.get(coordinate) or not result.get(array):
        raise ScientificError(f"{group['label']}: process {array} before merging.")
    x,y = _pair(result[coordinate],result[array],minimum=8)
    # Processed energy is shifted; the native merge bounds use raw energy.
    if array=='norm':
        raw=np.asarray(group['energy'],dtype=float)
        if len(raw)!=len(x) or not np.allclose(raw+group['parameters']['energy_shift'],x,rtol=0,atol=1e-9):
            raise ScientificError(f"{group['label']}: normalized data do not match the stored energy grid. Reprocess before merging.")
        return raw,y
    return x,y


def noise(group):
    k,chi = signal(group,'chi');p=group['parameters'];out=Group()
    kmax=p['kmax'] if p['kmax'] is not None else (group.get('result') or {}).get('effective',{}).get('kmax')
    if kmax is None: raise ScientificError(f"{group['label']}: resolve the Fourier-transform maximum before noise weighting.")
    try:
        # Exact native template arguments: `window` goes through Larch's
        # **kws; its effective kwindow remains the default Kaiser window.
        estimate_noise(k,chi,group=out,kmin=p['kmin'],kmax=kmax,dk=p['dk'],dk2=p['dk'],
                       window=p['window'],kweight=p['kweight'])
        value=float(out.epsilon_k)
        if not np.isfinite(value) or value<=0: raise ValueError('no positive noise estimate')
    except (ValueError,IndexError,ZeroDivisionError,FloatingPointError) as exc:
        raise ScientificError(f"{group['label']}: Larch could not estimate χ(k) noise with the current transform limits: {exc}") from exc
    return float(f'{value:.3e}')  # Data::chi_noise stores four significant figures.


def merge(groups, choice, *, weights=None):
    if not 2<=len(groups)<=100: raise ScientificError('Mark at least two spectra to merge.')
    if len({g['id'] for g in groups})!=len(groups): raise ScientificError('Merge source groups must be distinct.')
    weights = choice.weights if weights is None else weights
    if set(weights)-{g['id'] for g in groups}: raise ScientificError('Merge weights refer to a group outside the selection.')
    pairs=[signal(g,choice.array) for g in groups]
    used=[];excluded=[]
    for group,pair in zip(groups,pairs):
        if choice.exclude_short_data and len(pairs[0][0])-len(pair[0])>choice.short_data_margin:
            excluded.append(dict(group_id=group['id'],label=group['label'],points=len(pair[0]),reason=f"More than {choice.short_data_margin} points shorter than the first spectrum ({len(pairs[0][0])} points)."))
        else:used.append((group,pair))
    if len(used)<2: raise ScientificError('Short-scan exclusion leaves fewer than two spectra. Change the margin or include short scans.')
    raw=[];members=[]
    for group,(x,y) in used:
        weight=weights.get(group['id'],importance(group)) if choice.weightby=='importance' else noise(group) if choice.weightby=='noise' else (group.get('result') or {}).get('effective',{}).get('edge_step')
        if weight is None or not np.isfinite(weight) or weight<0:
            raise ScientificError(f"{group['label']}: {choice.weightby} weighting requires a finite nonnegative value.")
        raw.append(float(weight));members.append(dict(group_id=group['id'],label=group['label'],points=len(x),weight=float(weight)))
    total=sum(raw)
    if not np.isfinite(total) or total<=0: raise ScientificError('Merge weights must have a finite positive sum.')
    coefficients=np.asarray(raw)/total
    lo=max(x[0] for _,(x,_) in used);hi=min(x[-1] for _,(x,_) in used)
    axis=lambda g,x:x+(0 if choice.array=='chi' else g['parameters']['energy_shift'])
    shifted=[axis(g,x) for g,(x,_) in used]
    if lo>=hi or max(x[0] for x in shifted)>=min(x[-1] for x in shifted):
        raise ScientificError('Merge spectra need overlapping coordinate ranges after alignment.')
    i1,i2=index_of(shifted[0],lo),index_of(shifted[0],hi)
    grid=shifted[0][i1:i2]
    if len(grid)<8: raise ScientificError('The native merge grid must contain at least eight points.')
    if len(grid)*len(used)>MAX_MATRIX_VALUES: raise ScientificError('The merge matrix is too large. Rebin the sources first.')
    values=[];mean=np.zeros(len(grid));warnings=[]
    if choice.weightby=='noise':
        warnings.append('Native noise weighting is proportional to εk: larger noise receives more weight. The manual describes the opposite; this mode follows the executable Demeter source.')
    for member,c,x,(g,(_,y)) in zip(members,coefficients,shifted,used):
        v=interp(x,y,grid,fill_value=0.)
        count=int(np.sum((grid<x[0])|(grid>x[-1])))
        if count:warnings.append(f"{g['label']}: native grid requires linear extrapolation at {count} points.")
        member.update(coefficient=float(c),extrapolated_points=count)
        values.append(v);mean=mean+c*v
    variance=np.zeros(len(grid))
    for c,v in zip(coefficients,values):variance=variance+c*(v-mean)**2
    deviation=np.sqrt(variance*len(used)/(len(used)-1))
    if not np.isfinite([*mean,*deviation]).all():raise ScientificError('Merge values overflowed; rescale the source data or weights.')
    return dict(x=grid.tolist(),y=mean.tolist(),stddev=deviation.tolist(),members=members,excluded=excluded,
        components=[dict(group_id=g['id'],label=g['label'],y=v.tolist()) for (g,_),v in zip(used,values)],
        warnings=warnings,details=dict(method='demeter-larch',array=choice.array,weightby=choice.weightby,
            scatter='sqrt(N/(N-1) * sum(coefficient * (signal-mean)^2))',count=len(used),
            grid='First shifted grid, index_of(raw overlap min):index_of(raw overlap max), upper endpoint excluded',
            xmin=float(lo),xmax=float(hi),indices=[int(i1),int(i2)]))


def plot_curves(result,choice):
    x=np.asarray(result['x']);y=np.asarray(result['y']);sigma=np.asarray(result['stddev'])
    curves=[dict(name='Merged spectrum',x=x.tolist(),y=y.tolist())]
    if choice.plot=='stddev':
        curves.extend([dict(name='Merge + standard deviation',x=x.tolist(),y=(y+sigma).tolist()),
                       dict(name='Merge − standard deviation',x=x.tolist(),y=(y-sigma).tolist())])
    elif choice.plot=='variance':
        factor=float(max(y)/max(sigma)/2) if max(sigma)>0 else 0.
        curves.append(dict(name=f'{factor:.6g} × standard deviation',x=x.tolist(),y=(sigma*factor).tolist()))
    else:curves.extend(dict(name=member['label'],x=x.tolist(),y=member['y']) for member in result['components'])
    return curves
