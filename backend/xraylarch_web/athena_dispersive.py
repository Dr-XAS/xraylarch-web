"""Demeter Pixel guess/apply and derivative calibration, implemented with Larch.

Pixel.pm, Dispersive.pm and pixel_{setup,fit,set}.tmpl at 06afc8da08a5a7d5a26ee14992170fcf5dc67406.
The native fitting templates exist only for Ifeffit: qintrp and three-point
smoothing follow its published formulas; normalization and minimization use
Larch and lmfit. No native optimizer/normalization equivalence is implied.
"""
import numpy as np
from larch import Group
from larch.math import deriv
from larch.xafs import pre_edge
from lmfit import Parameters, minimize
from pydantic import BaseModel, ConfigDict, Field
import yaml
import re

from .athena_science import ScientificError, _pair, _edge
from .athena_operations import transform_spectrum
from .errors import WebInputError


class Coefficients(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    offset: float = 0.
    linear: float = .4
    quadratic: float = 0.


class PixelColumns(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    pixel_column: str
    numerator: list[str] = Field(max_length=64)
    denominator: list[str] = Field(default_factory=list, max_length=64)
    logarithm: bool = False
    invert: bool = False
    reverse_signal: bool = False
    sort: bool = False


class PixelNormalization(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    pre1: float | None = None
    pre2: float | None = None
    norm1: float | None = None
    norm2: float | None = 1000.
    nnorm: int = Field(default=2, ge=0, le=3)
    step: float | None = Field(default=None,gt=0)


class DispersiveRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    version: int = Field(ge=0)
    upload_id: str
    columns: PixelColumns
    standard_id: str | None = None
    coefficients: Coefficients = Field(default_factory=Coefficients)
    normalization: PixelNormalization = Field(default_factory=PixelNormalization)
    nsmooth: int = Field(default=4, ge=0, le=10)


class DispersiveDefaults(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    version: int = Field(default=0, ge=0)
    coefficients: Coefficients | None = None


def decode_calibration(data):
    if len(data) > 4096:
        raise ValueError('Calibration files must be no larger than 4 KB.')
    try:
        for token in yaml.scan(data):
            if isinstance(token,(yaml.tokens.AliasToken,yaml.tokens.AnchorToken,yaml.tokens.TagToken)):
                raise ValueError('Calibration must be a flat mapping of three numbers.')
        node=yaml.compose(data,Loader=yaml.BaseLoader)
        if not isinstance(node,yaml.MappingNode) or len(node.value)!=3:
            raise ValueError('Calibration needs offset, linear and quadratic.')
        values={}
        for k,v in node.value:
            if not isinstance(k,yaml.ScalarNode) or not isinstance(v,yaml.ScalarNode) or k.value in values:
                raise ValueError('Calibration must have three distinct scalar coefficients.')
            values[k.value]=float(v.value)
        return Coefficients.model_validate(values)
    except (yaml.YAMLError,UnicodeError,TypeError,OverflowError) as exc:
        raise ValueError('Choose a valid athena.dxas YAML calibration.') from exc


def encode_calibration(coefficients):
    if coefficients is None:
        raise ValueError('Save a calibration before exporting athena.dxas.')
    values=Coefficients.model_validate(coefficients).model_dump()
    return ('---\n'+''.join(f'{key}: {value:.17g}\n' for key,value in values.items())).encode()


def normalize(x,y,settings,e0=None):
    e0=_edge(x,y,e0)
    # Native dispersive.bkg_nor2=1000 is an upper limit, clipped by Larch to
    # the measured post-edge range. Expose the actual resolved windows.
    g=Group(); pre_edge(x,y,group=g,e0=e0,make_flat=True,**settings.model_dump())
    if not np.isfinite(g.edge_step) or g.edge_step<=0 or not np.isfinite(g.norm).all():
        raise ScientificError('Dispersive normalization needs a positive edge step. Review columns, signal direction and windows.')
    return g


def fractions(x,y,settings):
    seed=_edge(x,y); results=[]
    for fraction in (.1,.9):
        e0=seed; converged=False
        for iteration in range(1,6):
            g=normalize(x,y,settings,e0)
            hits=np.flatnonzero(g.norm>=fraction)
            if not hits.size or hits[0]==0:
                raise ScientificError('The 10%/90% edge levels are not bracketed. Check the signal direction and normalization windows.')
            i=int(hits[0]);next_e0=x[i-1]+(x[i]-x[i-1])*(fraction-g.norm[i-1])/(g.norm[i]-g.norm[i-1])
            if not x[1]<=next_e0<=x[-2]:raise ScientificError('Edge fraction lies outside the interior data range.')
            converged=bool(abs(next_e0-e0)<=.001);e0=float(next_e0)
            if converged:break
        results.append(dict(fraction=fraction,position=e0,iterations=iteration,converged=converged))
    return results


def guess(pixel,signal,energy,standard,pixel_norm,standard_norm,quadratic=0.):
    pixel,signal=_pair(pixel,signal,minimum=8)
    energy,standard=_pair(energy,standard,minimum=8)
    p=fractions(pixel,signal,pixel_norm);s=fractions(energy,standard,standard_norm)
    width=p[1]['position']-p[0]['position']
    if width<=0 or s[1]['position']<=s[0]['position']:
        raise ScientificError('The standard and pixel edges must rise through 10% then 90%. Review the signal direction.')
    linear=(s[1]['position']-s[0]['position'])/width
    c=Coefficients(offset=s[0]['position']-linear*p[0]['position'],linear=linear,quadratic=quadratic)
    return c,dict(pixel_fractions=p,standard_fractions=s,
        warnings=[] if all(r['converged'] for r in p+s) else ['An edge-fraction estimate reached five iterations; inspect the initial overlap before refinement.'])


def smooth_derivative(values,count):
    values=np.array(values,dtype=float,copy=True)
    for _ in range(count):
        previous=values.copy()
        values[1:-1]=.5*previous[1:-1]+.25*(previous[:-2]+previous[2:])
        values[0]=.75*previous[0]+.25*previous[1]
        values[-1]=.75*previous[-1]+.25*previous[-2]
    return values


def qinterp(x,y,points):
    """Ifeffit misc_num.f qintrp: blended quadratics, linear near endpoints."""
    j=np.clip(np.searchsorted(x,points,side='right')-1,0,len(x)-2)
    out=y[j]+(points-x[j])*(y[j+1]-y[j])/(x[j+1]-x[j])
    inside=(j>=4)&(j<len(x)-5)
    i=j[inside];v=points[inside]
    if i.size:
        a,b,c,d=x[i],x[i+1],x[i+2],x[i-1]
        va=(v-b)*(v-c)*y[i]/((a-b)*(a-c))-(v-a)*(v-c)*y[i+1]/((a-b)*(b-c))+(v-a)*(v-b)*y[i+2]/((a-c)*(b-c))
        vb=(v-b)*(v-d)*y[i]/((a-b)*(a-d))-(v-a)*(v-d)*y[i+1]/((a-b)*(b-d))+(v-a)*(v-b)*y[i-1]/((a-d)*(b-d))
        out[inside]=(va*(v-d)-vb*(v-c))/(c-d)
    return out


def apply(pixel,signal,coefficients):
    return transform_spectrum('dispersive',pixel,signal,coefficients.model_dump())


def refine(pixel,signal,energy,standard,coefficients,nsmooth=4):
    pixel,signal=_pair(pixel,signal,minimum=8,maximum=100000)
    energy,standard=_pair(energy,standard,minimum=8,maximum=100000)
    initial=apply(pixel,signal,coefficients)
    lo=max(min(initial['energy'])+5,energy[0]);hi=min(max(initial['energy'])-10,energy[-1])
    mask=(energy>=lo)&(energy<=hi)
    if np.count_nonzero(mask)<8:raise ScientificError('Calibration needs at least eight overlapping standard points after the native 5/10 eV margins.')
    # Native derivative template differentiates raw xmu, not normalized/flat.
    target=(deriv(standard)/deriv(energy))[mask];grid=energy[mask]
    source=smooth_derivative(deriv(signal)/deriv(pixel),nsmooth)
    if np.ptp(target)<=1e-14 or np.ptp(source)<=1e-14:
        raise ScientificError('Calibration requires edge structure in both derivatives.')
    params=Parameters()
    for key,value in coefficients.model_dump().items():params.add(key,value=value)
    params.add('scale',value=1.)
    def residual(parameters):
        values=parameters.valuesdict();x=values['offset']+pixel*(values['linear']+values['quadratic']*pixel)
        if not np.isfinite(x).all() or not (np.all(np.diff(x)>0) or np.all(np.diff(x)<0)):
            return np.full(grid.size,1e10)
        y=source
        if x[0]>x[-1]:x,y=x[::-1],y[::-1]
        return target-values['scale']*qinterp(x,y,grid)
    before=residual(params)
    fit=minimize(residual,params,method='leastsq',max_nfev=1600)
    c=Coefficients(**{key:float(fit.params[key].value) for key in Coefficients.model_fields})
    converted=apply(pixel,signal,c);after=residual(fit.params)
    if not fit.success or not np.isfinite(after).all() or np.dot(after,after)>np.dot(before,before)*(1+1e-8):
        raise ScientificError('Calibration refinement did not converge to an improved fit. Review the initial overlap and selected columns.')
    outside=int(np.count_nonzero((grid<min(converted['energy']))|(grid>max(converted['energy']))))
    details=dict(method='lmfit leastsq; native raw-derivative residual and qintrp',nsmooth=nsmooth,
        scale=float(fit.params['scale'].value),evaluations=int(fit.nfev),fit_min=float(lo),fit_max=float(hi),
        points=int(grid.size),initial_sum_squares=float(np.dot(before,before)),sum_squares=float(np.dot(after,after)),
        extrapolated_points=outside,fit_energy=grid.tolist(),standard_derivative=target.tolist(),
        fitted_derivative=(target-after).tolist(),residual=after.tolist(),
        warnings=[f'{outside} fitted points use endpoint extrapolation; inspect the fit limits.'] if outside else [])
    return c,details


def parse_pixels(data,filename,max_bytes,max_points,max_columns):
    from .parsing import parse_upload
    if len(data)>max_bytes:raise ValueError('Pixel upload exceeds the configured byte limit.')
    text=data.decode('utf-8-sig');lines=text.splitlines()
    suffix='.csv' if filename.lower().endswith('.csv') else '.dat'
    # ESRF/SLRI colon records contain numbers but are metadata. Only rewrite
    # the initial colon header, never a damaged observation after the boundary.
    if lines and 'pixel' in lines[0] and 'stripe' in lines[0]:
        for i,line in enumerate(lines):
            if re.match(r'^\s*[-+]?(?:\d|\.\d)',line):
                # Colon metadata ends with a date, which read_ascii can
                # otherwise mistake for the detector column names.
                count=len(line.split())
                lines.insert(i,'# '+' '.join(['pixel']+[f'signal_{j}' for j in range(1,count)]))
                break
            if line.lstrip().startswith(':'):lines[i]='# '+line
    if suffix=='.csv' and lines and lines[0].lstrip().startswith(','):
        fields=lines[0].split(',')
        # Photon Factory's header starts with an empty pixel label, followed
        # by numeric acquisition times; it is not an observation with NaN x.
        if all(v.strip() and np.isfinite(float(v)) for v in fields[1:]):
            lines[0]=','.join(['pixel']+[f'signal_{i}' for i in range(1,len(fields))])
    return parse_upload(('\n'.join(lines)+'\n').encode(),'pixel'+suffix,
        max_bytes=max_bytes+len(lines)+1000,max_points=max_points,max_columns=max_columns)


def slribl4(data,max_points,max_columns,calibration):
    from .athena_file_plugins import _prepared
    if calibration is None:
        raise WebInputError('dispersive_calibration_missing','SLRIBL4 needs a saved pixel-to-energy calibration.',
            ('file',),'Use Dispersive energy calibration to compare a pixel standard with a conventional standard, or import athena.dxas, then retry this file.')
    parsed=parse_pixels(data,'pixel.dat',max(len(data),1),max_points,max_columns)
    arrays=list(parsed.arrays.values())
    if len(arrays)<2:raise ValueError('SLRIBL4 needs pixel and signal columns.')
    c=Coefficients.model_validate(calibration)
    converted=apply(arrays[0],arrays[1],c)
    # Data::Pixel defaults to the first two columns, denominator=1 and ln=0.
    rows=[[f'{x:.15g}',f'{y:.15g}'] for x,y in zip(converted['energy'],converted['mu'],strict=True)]
    return _prepared(data,['SLRIBL4 dispersive calibration'],['energy','mu'],rows,
        dict(id='SLRIBL4',version='0.1',description='Dispersive pixel/stripe data',
             summary='Applied the saved pixel-to-energy calibration to the first two columns. Review the calibrated signal before importing.',
             calibration=c.model_dump(),input_points=len(arrays[0]),source_columns=len(arrays),
             reversed=converted['details']['reversed']),1,0,
        suggestions={'mu':dict(energy_column=0,numerator=[1],denominator=None,mode='mu',units='eV',data_type='mu')})
