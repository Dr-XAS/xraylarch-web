"""Athena's Larch convolution and reproducible artificial normal noise."""
import secrets
from typing import Literal

import numpy as np
from larch.math import smooth as larch_smooth
from pydantic import BaseModel, ConfigDict, Field

from .athena_operations import _xy


class ConvolutionOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    form: Literal['gaussian', 'lorentzian'] = 'gaussian'
    width: float = Field(default=0., strict=True, ge=0, le=1000)
    noise: float = Field(default=0., strict=True, ge=0, le=100)
    seed: int | None = Field(default=None, strict=True, ge=0, le=2**32-1)

    def captured(self):
        return self.model_copy(update={'seed': secrets.randbits(32)}) if self.noise and self.seed is None else self


def broaden(energy, mu, choice: ConvolutionOptions):
    x, y = _xy(energy, mu)
    points = 0
    if choice.width:
        # Bound the exact grid that Larch constructs; never silently replace
        # its interpolation, padding or line shape with another algorithm.
        step = float(np.min(np.diff(x)))
        if step < 1e-12:
            raise ValueError('The energy spacing is too small for Larch convolution.')
        lo, hi = step * int((x[0]-5*step)/step), step * int((x[-1]+5*step)/step)
        points = min(1+int(abs(hi-lo+step*.1)/step), 50*len(x))
        if 2*points*(points+1) > 100_000_000:
            raise ValueError('Convolution work limit exceeded; explicitly rebin the source before previewing.')
        y = np.asarray(larch_smooth(x, y, sigma=choice.width, form=choice.form))
    if len(y) != len(x) or not np.isfinite(y).all():
        raise ValueError('Larch convolution produced invalid values; review the source and width.')
    return dict(energy=x.tolist(), mu=y.tolist(), details=dict(method='larch.math.smooth',
        form=choice.form, width=choice.width, width_units='eV', grid_points=points,
        input_points=len(x), output_points=len(x), warnings=[]))


def add_noise(mu, choice: ConvolutionOptions, edge_step: float | None, *, chi=False, offset=0):
    y = np.asarray(mu, dtype=float)
    seed = (choice.seed + offset) % 2**32 if choice.seed is not None else None
    scale = 0.
    if choice.noise:
        if seed is None:
            raise ValueError('Capture a noise seed before calculating or saving a noisy spectrum.')
        if not chi and (edge_step is None or not np.isfinite(edge_step) or edge_step <= 0):
            raise ValueError('Artificial noise needs a positive absorption edge step. Repair normalization or use zero noise.')
        scale = choice.noise * (1. if chi else edge_step)
        # The native Larch template calls numpy.random.normal. A private
        # RandomState reproduces its seeded stream without touching global RNG.
        y = y + np.random.RandomState(seed).normal(size=len(y), scale=scale)
    if not np.isfinite(y).all():
        raise ValueError('Artificial noise produced non-finite values.')
    return y.tolist(), dict(noise=choice.noise, noise_sigma=scale, seed=seed,
        noise_basis='absolute χ(k)' if chi else 'edge step after convolution', edge_step=edge_step,
        random_generator='NumPy RandomState MT19937 normal')
