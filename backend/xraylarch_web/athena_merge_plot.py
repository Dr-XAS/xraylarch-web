"""Read saved merge scatter using the native plot/points conventions.

No averaging, resampling or uncertainty propagation is performed here.
See the executed original Data::points reference for offset/zero-scale quirks.
"""
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from .athena_science import ScientificError, _pair


class MergePlotOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    version: int = Field(ge=0)
    view: Literal['stddev', 'variance'] = 'stddev'
    flatten: bool | None = None
    energy_display: Literal['mu', 'norm', 'flat'] = 'mu'
    kweight: float | None = Field(default=None, ge=0, le=4)


def merge_identity(group):
    source = group.get('source', {})
    native = source.get('native', {}).get('args', {}).get('is_merge')
    saved = source.get('merge', {})
    details = saved.get('details', {}) if isinstance(saved, dict) else {}
    if details.get('method') == 'demeter-larch' and details.get('array') in ('mu', 'norm', 'chi'):
        return details['array'], 'native'
    if native in ('e', 'n', 'k'):
        return {'e': 'mu', 'n': 'norm', 'k': 'chi'}[native], 'native'
    if source.get('operation') == 'merge' and isinstance(source.get('stddev'), list):
        return source.get('array') or ('chi' if group['data_type'] == 'chi' else 'mu'), 'legacy-population'
    raise ScientificError('This group has no saved merge identity. Select a merged spectrum.')


def saved_merge_plot(group, options):
    space, origin = merge_identity(group)
    if space not in ('mu', 'norm', 'chi'):
        raise ScientificError('The saved merge uses an unsupported signal space.')
    if (space == 'chi') != (group['data_type'] == 'chi') or group['data_type'] == 'detector':
        raise ScientificError('The current data type no longer matches the saved merge space.')
    raw_x, raw_y = _pair(group['energy'], group['mu'], minimum=3)
    source = group['source']
    sigma = source.get('raw_arrays', {}).get('stddev') if origin == 'native' else source.get('stddev')
    if sigma is None:
        raise ScientificError('The project does not contain an aligned standard-deviation array for this merge.')
    sigma = np.asarray(sigma, dtype=float)
    if sigma.ndim != 1 or sigma.shape != raw_x.shape or not np.isfinite(sigma).all() or np.any(sigma < 0):
        raise ScientificError('Saved merge standard deviation must be finite, nonnegative and match every source point.')
    p = group['parameters']
    flatten = p['flatten'] if options.flatten is None else options.flatten
    suffix = ('chi' if space == 'chi' else ('flat' if flatten else 'norm') if space == 'norm'
              else options.energy_display if options.view == 'variance' else 'mu')
    x = raw_x + (0 if space == 'chi' else p['energy_shift'])
    y = raw_y
    if suffix in ('norm', 'flat'):
        arrays = (group.get('result') or {}).get('arrays', {})
        if not arrays.get(suffix) or not arrays.get('energy'):
            raise ScientificError('Process valid normalization parameters before displaying this merge in normalized units.')
        px, y = _pair(arrays['energy'], arrays[suffix], minimum=3)
        if px.shape != x.shape or not np.allclose(px, x, rtol=0, atol=1e-9):
            raise ScientificError('Processed energy no longer matches the saved scatter grid. Reprocess the group.')
    weight = (p['kweight'] if options.kweight is None else options.kweight) if space == 'chi' else None
    multiplier, offset = float(group['multiplier']), float(group['offset'])
    notes = []
    if not np.isfinite([multiplier, offset]).all():
        raise ScientificError('The group needs finite plot scale and offset values.')
    if space == 'chi' and (np.any(x < 0) or not np.isfinite(weight) or not 0 <= weight <= 4):
        raise ScientificError('A chi merge needs nonnegative k and a plot weight between zero and four.')
    # Data::points uses `scale ||= 1`, including the spread template's scale.
    scale = multiplier or 1.
    if multiplier == 0:
        notes.append('Native Athena plotting treats a zero plot scale as one.')
    factor = np.power(x, weight) if weight is not None else np.ones(len(x))
    curves = [dict(name=group['label'], x=x.tolist(), y=(scale * factor * y + offset).tolist())]
    spread_scale = None
    if options.view == 'stddev':
        # Original points adds the offset inside add/subtract AND again after
        # scaling/weighting. Keep the native result explicit in the UI.
        for sign, label in ((1, '+'), (-1, '−')):
            values = scale * factor * (y + sign * sigma + offset) + offset
            curves.append(dict(name=f'{group["label"]} {label} standard deviation', x=x.tolist(), y=values.tolist()))
        if offset:
            notes.append('Native ± standard-deviation overlays apply the group offset before and after scaling; set the group offset to zero for a centered envelope.')
    else:
        if float(np.max(sigma)) == 0:
            spread_scale = 0.
            notes.append('All saved standard deviations are zero. The spread curve is zero before the group offset; native division by zero is avoided.')
        else:
            spread_scale = multiplier * float(np.max(raw_y)) / float(np.max(sigma)) / 2
            if spread_scale == 0:
                spread_scale = 1.
                notes.append('The native spread scale is zero and Data::points uses one in its place.')
        curves.append(dict(name=f'{spread_scale:.6g} × standard deviation', x=x.tolist(), y=(spread_scale * factor * sigma + offset).tolist()))
    if not all(np.isfinite(c['y']).all() for c in curves):
        raise ScientificError('Plot scaling overflowed. Reduce the multiplier or k weight.')
    if origin == 'legacy-population':
        notes.append('This older web merge stores population scatter; no native N/(N−1) correction has been inferred or recomputed.')
    if suffix in ('norm', 'flat'):
        notes.append('The saved scatter is added directly to the current normalized display, following Athena; normalization does not recalculate the stored scatter.')
    notes.append('Saved scatter describes differences between scans; it is not propagated measurement uncertainty.')
    return dict(group_id=group['id'], label=group['label'], merge_space=space, origin=origin,
                display=suffix, kweight=weight, multiplier=multiplier, offset=offset,
                spread_scale=spread_scale, points=len(x), curves=curves, notes=notes,
                x_label='k (Å⁻¹)' if space == 'chi' else 'Energy (eV)',
                y_label=(('χ(k)' if weight == 0 else f'k^{weight:g} χ(k)') if space == 'chi' else
                         {'mu': 'μ(E)', 'norm': 'Normalized μ(E)', 'flat': 'Flattened μ(E)'}[suffix]))
