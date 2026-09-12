"""Athena calibration coordinates, raw derivatives and display-only smoothing."""
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from .athena_e0 import _derivatives, _crossing_e0, _normalized
from .athena_science import AthenaParameters, ScientificError, _pair, _normalization_ranges, normalization_adjustments
from .athena_smoothing import SmoothOptions, smooth


class CalibrationOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    coordinate: Literal['displayed'] = 'displayed'
    observed: float | None = Field(default=None, strict=True, gt=0)
    target: float | None = Field(default=None, strict=True, gt=0)
    display: Literal['mu', 'norm', 'derivative', 'second'] = 'derivative'
    smoothing: int = Field(default=0, strict=True, ge=0, le=10)
    smoothing_method: Literal['three_point', 'savitzky_golay'] = 'three_point'
    sg_window: int | None = Field(default=None, strict=True, ge=0, le=39)
    sg_order: int | None = Field(default=None, strict=True, ge=9, le=39)


def shifted_axis(group):
    if group['data_type'] == 'chi':
        raise ScientificError('Energy calibration requires an energy spectrum, not χ(k).')
    return _pair(np.asarray(group['energy']) + group['parameters']['energy_shift'], group['mu'], minimum=10)


def calibration_shift(observed, target, previous):
    # Calibrate::OnCalibrate rounds the total shift, not just its increment.
    return float(f'{target - observed + previous:.3f}')


def zero_crossing(group, observed):
    x, y = shifted_axis(group)
    if group['data_type'] == 'detector' or group.get('is_difference'):
        raise ScientificError('Automatic edge selection needs an absorption spectrum. Pick a reference energy instead.')
    _, second = _derivatives(x, y)
    # Native e0_zero_crossing searches unsmoothed sec; plot smoothing never
    # changes the data passed to that method. Its answer has five decimals.
    return float(f'{_crossing_e0(x, second, observed):.5f}')


def calibration_curve(group, choice):
    x, y = shifted_axis(group)
    if choice.observed is None or not x[0] <= choice.observed <= x[-1]:
        raise ScientificError('Choose the observed reference inside the displayed energy range.')
    first, second = _derivatives(x, y)
    normalization = []
    if choice.display == 'norm':
        if group['data_type'] == 'detector' or group.get('is_difference'):
            raise ScientificError('Normalized calibration display requires an absorption spectrum.')
        p = AthenaParameters.model_validate(group['parameters'])
        y = y.copy() if group.get('is_normalized') or group['data_type'] in ('norm', 'xmudat') else _normalized(x, y, p, choice.observed, flat=p.flatten)
        if not group.get('is_normalized') and group['data_type'] not in ('norm', 'xmudat'):
            normalization = normalization_adjustments(group['parameters'], _normalization_ranges(x, choice.observed, p))
    elif choice.display == 'derivative':
        y = first
    elif choice.display == 'second':
        y = second
    unsmoothed = y.copy()
    details = dict(algorithm='none', repetitions=0)
    if choice.smoothing:
        settings = dict(method=choice.smoothing_method, repetitions=choice.smoothing)
        if choice.smoothing_method == 'savitzky_golay':
            if choice.sg_window is None or choice.sg_order is None:
                raise ScientificError('Capture both Savitzky–Golay preferences before plotting.')
            settings.update(window=choice.sg_window, order=choice.sg_order)
        result = smooth(x, y, SmoothOptions(**settings))
        y = np.asarray(result['mu']); details = result['details']
    return dict(x=x.tolist(), y=y.tolist(), unsmoothed=unsmoothed.tolist(),
                marker=dict(x=choice.observed, y=float(np.interp(choice.observed, x, y))),
                smoothing=details, range=[choice.observed - 30, choice.observed + 50],
                normalization=normalization)
