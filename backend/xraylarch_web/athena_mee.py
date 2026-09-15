"""Athena MEE models on accepted normalized spectra, using Larch primitives.

The pinned Larch mee_reflect/arctan/do templates are the numerical contract.
Reflection means translating the broadened edge, then subtracting it; it is
not a reversal of the energy array. The source group is never changed.
"""
from typing import Literal

import numpy as np
from larch.math import interp, smooth
from pydantic import BaseModel, ConfigDict, Field

from .athena_operations import _xy


class MEEOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    method: Literal['reflection', 'arctangent'] = 'reflection'
    shift: float = Field(gt=0, strict=True)
    amplitude: float = Field(default=.01, strict=True)
    width: float = Field(default=.5, strict=True)
    # Explicit API reference for signed energy differences without a fitted E0.
    # The Athena panel uses the group's accepted E0 and never guesses it.
    e0: float | None = Field(default=None, gt=0, strict=True)


def subtract(energy, normalized_mu, e0, choice: MEEOptions):
    x, y = _xy(energy, normalized_mu)
    if e0 is None or not np.isfinite(e0) or not x[0] < e0 < x[-1]:
        raise ValueError('MEE removal needs a saved absorption edge inside the measured range.')
    if not e0 + choice.shift < x[-1]:
        raise ValueError('Place the secondary edge inside the measured range.')
    amplitude, width = max(0., choice.amplitude), max(.01, choice.width)
    warnings = []
    if choice.amplitude < 0:
        warnings.append('Negative amplitude was reset to zero, as in Athena.')
    if choice.width < .01:
        warnings.append('Broadening was raised to Athena’s minimum of 0.01 eV.')
    if choice.method == 'reflection':
        # Larch smooth uses a dense convolution on a uniform internal grid.
        # Bound that actual work before allocating; never coarsen the data.
        step = float(np.min(np.diff(x)))
        if step < 1e-12:
            raise ValueError('Energy spacing is too small for Larch broadening.')
        xmin = step * int((x[0] - 5 * step) / step)
        xmax = step * int((x[-1] + 5 * step) / step)
        points = min(1 + int(abs(xmax - xmin + step * .1) / step), 50 * len(x))
        if 2 * points * (points + 1) > 100_000_000:
            raise ValueError('Larch reflection broadening exceeds the work limit; rebin the source explicitly before removal.')
        model = interp(x + choice.shift, smooth(x, y, sigma=width, form='lorentzian'), x, fill_value=0.)
        # Process.pm pads the shifted pre-edge after interpolation. Larch's
        # interp extrapolates despite fill_value, so this step is essential.
        model[x < x[0] + choice.shift] = 0.
    else:
        model = np.arctan((x - e0 - choice.shift) / width) / np.pi + .5
    excitation = amplitude * model
    corrected = y - excitation
    if not np.isfinite(corrected).all() or not np.isfinite(excitation).all():
        raise ValueError('MEE model produced nonfinite values; review amplitude and broadening.')
    return {'energy': x.tolist(), 'mu': corrected.tolist(), 'details': {
        'model': choice.method, 'method': 'Demeter Larch MEE templates',
        'e0': float(e0), 'center': float(e0 + choice.shift), 'shift': choice.shift,
        'amplitude': amplitude, 'width': width, 'edge_step': 1.,
        'excitation': excitation.tolist(), 'input_scale': 'normalized mu',
        'warnings': warnings,
    }}


def group_input(group, choice):
    if group['data_type'] in ('chi', 'detector'):
        raise ValueError('MEE removal requires a normalized absorption spectrum on an energy axis.')
    result = group.get('result') or {}
    arrays = result.get('arrays', {})
    if group.get('processing_error') or not arrays.get('norm'):
        raise ValueError('Process the source spectrum successfully before MEE removal.')
    return arrays['energy'], arrays['norm'], choice.e0 if choice.e0 is not None else result.get('effective', {}).get('e0')
