"""Athena smoothing kernels and Larch's sample-index Savitzky–Golay filter."""
from typing import Literal

import numpy as np
from larch.math import savitzky_golay
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_operations import _xy, MAX_WORK


class SmoothOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    method: Literal['boxcar', 'gaussian', 'savitzky_golay', 'three_point'] = 'boxcar'
    window: int = Field(default=11, strict=True, ge=0, le=501)
    sigma: float = Field(default=4., strict=True, ge=0, le=1000)
    order: int = Field(default=9, strict=True, ge=0, le=39)
    repetitions: int = Field(default=11, strict=True, ge=0, le=1000)

    @model_validator(mode='before')
    @classmethod
    def native_sg_default(cls, values):
        if isinstance(values, dict) and values.get('method') == 'savitzky_golay' and 'window' not in values:
            return dict(values, window=31)
        return values


def smooth(energy, signal, choice: SmoothOptions):
    x, y = _xy(energy, signal)
    warnings = []
    details = dict(algorithm=choice.method, window_units='samples', warnings=warnings,
                   input_points=len(x), trimmed_left=0, trimmed_right=0)
    if choice.method in ('boxcar', 'gaussian'):
        size = choice.window if choice.window >= 1 else 11
        size += int(size % 2 == 0)
        if size != choice.window:
            warnings.append(f'Kernel size was adjusted to {size} points, as in Athena.')
        if len(x) - size < 10:
            raise ValueError('Choose a smaller smoothing kernel; at least ten output points must remain after Athena’s endpoint trimming.')
        if len(x) * size > MAX_WORK:
            raise ValueError('Smoothing work limit exceeded; reduce the kernel size or explicitly rebin the source.')
        if choice.method == 'boxcar':
            weights = np.ones(size) / size
        else:
            sigma = choice.sigma if choice.sigma >= 1 else 4.
            if sigma != choice.sigma:
                warnings.append('Gaussian width was reset to 4 samples, as in Athena.')
            # Although the native constructor starts with float zeroes,
            # PDL's xvals produces doubles. Actual PDL execution verifies this
            # promotion; a float32 kernel changes the measured results.
            positions = np.arange(size, dtype=float) - size // 2
            weights = np.exp(-(positions ** 2) / (2 * sigma ** 2))
            weights /= weights.sum()
            details['sigma'] = sigma
        half = size // 2
        # Both native Perl routines retain N-size points. Their final splice
        # drops one more right-hand observation than a usual valid convolution.
        out = np.convolve(y, weights, mode='valid')[:-1]
        x = x[half:len(x)-half-1]
        details.update(method='PDL boxcar' if choice.method == 'boxcar' else 'PDL Gaussian filter',
                       window=size, weights=weights.tolist(), trimmed_left=half, trimmed_right=half+1)
    elif choice.method == 'savitzky_golay':
        size = choice.window + int(choice.window % 2 == 0)
        order = min(choice.order, size - 1)
        # Demeter clamps the preference values, then Larch enforces its own
        # window/order relationship and odd size. Report the actual kernel.
        if size < order + 2:
            size = order + 3
        size += int(size % 2 == 0)
        if size > len(x):
            raise ValueError('The Savitzky–Golay window must fit inside the source spectrum.')
        if len(x) * size * (order + 1) ** 2 > MAX_WORK:
            raise ValueError('Smoothing work limit exceeded; reduce the window, polynomial order or number of points.')
        if (size, order) != (choice.window, choice.order):
            warnings.append(f'Larch uses a {size}-point window and polynomial order {order}.')
        try:
            out = savitzky_golay(y, window_size=size, order=order)
        except (TypeError, ValueError, np.linalg.LinAlgError) as error:
            raise ValueError('Larch could not calculate this Savitzky–Golay window and order; reduce the polynomial order and preview again.') from error
        details.update(method='larch.math.savitzky_golay', window=size, order=order,
                       boundary='Larch reflected endpoint padding')
    else:
        repetitions = max(1, choice.repetitions)
        if repetitions != choice.repetitions:
            warnings.append('Three-point smoothing uses at least one repetition, as in Athena.')
        if len(x) * repetitions > MAX_WORK:
            raise ValueError('Smoothing work limit exceeded; reduce the repetition count or number of points.')
        out = y.copy()
        for _ in range(repetitions):
            before = out
            out = np.empty_like(before)
            out[1:-1] = (before[1:-1] + (before[2:] + before[:-2]) * .5) * .5
            out[0] = 3 * before[0] * .25 + before[1] * .25
            out[-1] = 3 * before[-1] * .25 + before[-2] * .25
        details.update(method='IFEFFIT three-point kernel', repetitions=repetitions,
                       boundary='3/4 endpoint plus 1/4 adjacent point')
    if len(out) != len(x) or not np.isfinite(out).all():
        raise ValueError('Smoothing produced invalid values; review the source and filter parameters.')
    details['output_points'] = len(out)
    return dict(energy=x.tolist(), mu=out.tolist(), details=details)
