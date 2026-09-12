"""Native Larch point removal, margin selection and snapped truncation."""
from typing import Literal

import numpy as np
from larch.math import index_of
from larch.xafs.xafsutils import KTOE
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictFloat, model_validator

from .athena_operations import _xy


class PointEditOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    mode: Literal['inspect','point','indices','points','range','margins','truncate','interval']
    point: float | None = Field(default=None, strict=True)
    points: list[StrictFloat] | None = Field(default=None, min_length=1, max_length=100000)
    indices: list[StrictInt] | None = Field(default=None, min_length=1, max_length=100000)
    xmin: float | None = Field(default=None, strict=True)
    xmax: float | None = Field(default=None, strict=True)
    emin: float | None = Field(default=None, strict=True)
    emax: float | None = Field(default=None, strict=True)
    tolerance: float | None = Field(default=None, strict=True, ge=0)
    side: Literal['before','after'] | None = None
    value: float | None = Field(default=None, strict=True)
    scope: Literal['current','marked'] = 'current'

    @model_validator(mode='after')
    def fields_for_mode(self):
        required={'inspect':set(),'point':{'point'},'points':{'points'},'indices':{'indices'},'range':{'xmin','xmax'},
                  'margins':{'emin','emax','tolerance'},'truncate':{'side','value'},'interval':set()}[self.mode]
        allowed={'xmin','xmax'} if self.mode=='interval' else required
        supplied={key for key,value in self.model_dump().items() if value is not None}-{ 'mode','scope'}
        if not required<=supplied or supplied-allowed or (self.mode=='interval' and not supplied):
            raise ValueError('Supply only the complete set of values for the selected point-removal mode.')
        if self.mode=='margins' and (self.emin>=self.emax or not(self.emax<=0 or self.emin>=0)):
            raise ValueError('Margin limits must increase and stay on one side of E0.')
        return self


def parse_options(action, values):
    values=dict(values)
    if 'mode' not in values:
        if action=='truncate':values['mode']='interval'
        else:values['mode']='indices' if 'indices' in values else 'points' if 'points' in values else 'range'
    choice=PointEditOptions.model_validate(values)
    if (action=='truncate') != (choice.mode in ('truncate','interval')):
        raise ValueError('Choose the matching deglitch or truncate action.')
    return choice


def select_points(group, choice):
    chi=group['data_type']=='chi'
    shift=0 if chi else group['parameters']['energy_shift']
    x,y=_xy(np.asarray(group['energy'])+shift,group['mu'])
    effective=(group.get('result') or {}).get('effective',{})
    arrays=(group.get('result') or {}).get('arrays',{})
    removed=np.zeros(len(x),dtype=bool);margins=None;snapped=None
    def inside(value):
        if not x[0]<=value<=x[-1]:raise ValueError('Select a value inside the measured range.')
    def nearest(value):
        inside(value);distance=np.abs(x-value)
        # Process::deglitch's reduction resolves exact ties to the later point.
        return int(np.flatnonzero(distance==distance.min())[-1])
    if choice.mode=='inspect':
        pass
    elif choice.mode=='point':
        removed[nearest(choice.point)]=True
    elif choice.mode=='indices':
        if any(i<0 or i>=len(x) for i in choice.indices):raise ValueError('Point indices must identify existing source rows.')
        removed[choice.indices]=True
    elif choice.mode=='points':
        for value in choice.points:removed[nearest(value)]=True
    elif choice.mode in ('range','interval'):
        lo=choice.xmin if choice.xmin is not None else x[0];hi=choice.xmax if choice.xmax is not None else x[-1]
        inside(lo);inside(hi)
        if lo>=hi:raise ValueError('The lower bound must be smaller than the upper bound.')
        within=(x>=lo)&(x<=hi);removed=within if choice.mode=='range' else ~within
    elif choice.mode=='truncate':
        inside(choice.value);index=index_of(x,choice.value);snapped=float(x[index])
        removed[:index] = True if choice.side=='before' else False
        if choice.side=='after':removed[index:]=True
    else:
        e0=effective.get('e0');pre=choice.emin<0;line=np.asarray(arrays.get('pre_edge' if pre else 'post_edge',[]))
        if chi or group['data_type']=='detector' or group.get('is_difference') or e0 is None or len(line)!=len(x) or not np.isfinite(line).all():
            raise ValueError('Margins require a successfully normalized absorption spectrum and its pre/post-edge line.')
        lo,hi=e0+choice.emin,e0+choice.emax
        if hi<x[0] or lo>x[-1]:raise ValueError('The margin range does not overlap the measured data.')
        first,last=index_of(x,lo),index_of(x,hi)
        indices=np.arange(first,last+1)
        upper,lower=line[indices]+choice.tolerance,line[indices]-choice.tolerance
        removed[indices]=(y[indices]>upper)|(y[indices]<lower)
        margins=dict(x=x[indices].tolist(),upper=upper.tolist(),lower=lower.tolist(),baseline=line[indices].tolist(),
                     region='pre-edge' if pre else 'post-edge',e0=e0,indices=indices.tolist())
    keep=np.flatnonzero(~removed);drop=np.flatnonzero(removed)
    if len(keep)<10:raise ValueError('At least ten measured points must remain. Widen the retained range or remove fewer points.')
    return dict(kept_indices=keep.tolist(),removed_indices=drop.tolist(),
        energy=np.asarray(group['energy'])[keep].tolist(),mu=y[keep].tolist(),
        selected_energy=x[drop].tolist(),selected_mu=y[drop].tolist(),margins=margins,snapped=snapped,
        input_points=len(x),output_points=len(keep))


def plot_views(group):
    arrays=(group.get('result') or {}).get('arrays',{})
    effective=(group.get('result') or {}).get('effective',{})
    chi=group['data_type']=='chi';shift=0 if chi else group['parameters']['energy_shift']
    views={'mu':dict(x=(np.asarray(group['energy'])+shift).tolist(),y=group['mu']), 'chie':None}
    e0=effective.get('e0');k=np.asarray(arrays.get('k',[]));weighted=arrays.get('weighted_chi',[])
    if not chi and e0 is not None and len(k)==len(weighted) and len(k):
        views['chie']=dict(x=(e0+KTOE*k*k).tolist(),y=weighted)
    return views


def selected_chie(group, selected_energy):
    """Place display markers at removed raw energies on the processed curve.

    Interpolation here only positions a marker. Removal always selects raw
    measurements, and never synthesizes replacement measurements.
    """
    curve = plot_views(group)['chie']
    if curve is None:
        return None
    x = np.asarray(selected_energy)
    x = x[(x >= curve['x'][0]) & (x <= curve['x'][-1])]
    return dict(x=x.tolist(), y=np.interp(x, curve['x'], curve['y']).tolist())
