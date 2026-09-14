"""Athena shortcut curves, computed from saved Larch arrays without mutation."""
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from .athena_science import ScientificError, _number, _pair
from .athena_special_plot import _arrays


class ShortcutOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    version: int = Field(ge=0)
    kind: Literal['i0sig', 'i0', 'normderiv', 'normscaled', 'e00', 'k123', 'r123']
    group_ids: list[str] = Field(min_length=1, max_length=100)
    energy_mode: Literal['mu', 'norm', 'flat', 'dmude', 'd2mude'] = 'norm'
    component: Literal['mag', 're', 'im', 'pha'] = 'mag'
    stack_offset: float = 0.


def detector_scale(group, channel):
    """Resolve captured scales, native project state, or initial column maxima."""
    source = group.get('source', {})
    raw = source.get('raw_arrays', {}).get(channel)
    _, y = _pair(group['energy'], [] if raw is None else raw, name=f'{group["label"]} · {channel}')
    captured = source.get('detector_plot_scales', {})
    if channel in captured:
        return _number(captured[channel], f'Captured {channel} scale')
    native = source.get('native', {})
    key = f'{channel}_scale'
    # Original Data::Prj::_record overwrites saved factors using signed max(mu).
    # JSON records can retain the live Data state instead.
    legacy = native.get('format') == 'athena-perl'
    if not legacy and key in native.get('args', {}):
        return _number(native['args'][key], f'Saved {channel} scale')
    peak = float(np.max(y))
    if peak == 0:
        raise ScientificError(f'{group["label"]}: a zero {channel} maximum prevents detector comparison scaling.')
    mu_max = float(np.max(group['mu']))
    return _number((mu_max if legacy else abs(mu_max)) / peak, f'{channel} scale')


def capture_detector_scales(group):
    """Keep import-time comparison factors through later point removal/edits."""
    if group['data_type'] == 'chi':
        return
    scales = {}
    for channel in ('i0', 'signal'):
        try:
            scales[channel] = detector_scale(group, channel)
        except ScientificError:
            continue  # Optional detector data must not block importing μ(E).
    if scales:
        group['source']['detector_plot_scales'] = scales


def shortcut_plot(groups, options):
    marked = options.kind in ('i0', 'e00', 'normscaled')
    if [g['id'] for g in groups] != options.group_ids or len(set(options.group_ids)) != len(groups) or (not marked and len(groups) != 1):
        raise ScientificError('Choose distinct marked groups or one current group for this shortcut.')
    curves, notes, skipped = [], [], []
    x_label, y_label, x_range = 'Energy (eV)', 'μ(E)', None

    def add(group, x, y, name, scale=1., offset=0., **extra):
        x, y = _pair(x, y, name=name)
        scale, offset = _number(scale, 'Plot scale'), _number(offset, 'Plot offset')
        # Original Data::points coalesces a literal zero scale to one.
        effective_scale = scale or 1.
        y = effective_scale * y + offset
        if not np.isfinite(y).all():
            raise ScientificError('Shortcut scaling overflowed. Reduce the input amplitudes or group offset.')
        if scale == 0:
            notes.append('Native Athena plotting treats a zero plot scale as one.')
        curves.append(dict(group_id=group['id'], name=f'{group["label"]} · {name}', x=x.tolist(), y=y.tolist(),
                           scale=scale, effective_scale=effective_scale, offset=offset, **extra))

    if options.kind in ('k123', 'r123'):
        g = groups[0]; a = (g.get('result') or {}).get('arrays', {})
        if g['data_type'] in ('xanes', 'detector'):
            raise ScientificError('Choose an EXAFS spectrum or χ(k) for the three-weight comparison.')
        if options.kind == 'k123':
            if g.get('processing_error') or (g['data_type'] != 'chi' and not (g.get('result') or {}).get('effective', {}).get('exafs')):
                raise ScientificError('Apply valid EXAFS processing parameters before making this plot.')
            k, chi = _pair(a.get('k', g['energy'] if g['data_type'] == 'chi' else []),
                           a.get('chi', g['mu'] if g['data_type'] == 'chi' else []), minimum=4)
            if np.any(k < 0): raise ScientificError('The k grid must be nonnegative.')
            data = [(k, chi * k ** w) for w in (1, 2, 3)]
            maxima = [float(np.max(y)) for _, y in data]
            spacing = 1.2 * maxima[1]
            x_label, y_label = 'k (Å⁻¹)', 'k-weighted χ(k) · weights in legend'
        else:
            transformed = [_arrays(g, float(w), notes) for w in (1, 2, 3)]
            data = [(a['r'], a[f'chir_{options.component}']) for a in transformed]
            maxima = [float(np.max(a['chir_mag'])) for a in transformed]
            spacing = maxima[1]
            x_label = 'R (Å)'
            y_label = {'mag': '|χ(R)|', 're': 'Re[χ(R)]', 'im': 'Im[χ(R)]', 'pha': 'Phase χ(R) (rad)'}[options.component]
        for i, (x, y) in enumerate(data):
            if i != 1 and maxima[i] == 0:
                raise ScientificError(f'Weight {i+1} has a zero maximum; Athena comparison scaling is undefined.')
            scale = 1. if i == 1 else float(f'{maxima[1] / maxima[i]:.3f}')
            add(g, x, y, f'k-weight {i+1}' + (' · unscaled' if i == 1 else f' · scaled by {scale:.3f}'),
                scale, (1-i) * spacing, kweight=i+1)
        notes.append('Weights 1 and 3 use Athena’s three-decimal comparison scales; saved group plot multipliers and offsets are replaced for this view.')
    else:
        y_label = {'normderiv': 'Normalized μ(E) and scaled derivative', 'normscaled': 'Normalized μ(E) × edge step',
                   'i0sig': 'μ(E) and scaled detector signals', 'i0': 'I₀ (source units)', 'e00': 'μ(E) · forms in legend'}[options.kind]
        if options.kind == 'e00': x_label = 'E − E₀ (eV)'
        for i, g in enumerate(groups):
            count = len(curves)
            try:
                if g['data_type'] == 'chi': raise ScientificError('This shortcut requires energy data, not χ(k).')
                a = (g.get('result') or {}).get('arrays', {})
                effective = (g.get('result') or {}).get('effective', {})
                rawx, mu = _pair(g['energy'], g['mu'])
                x = rawx + g['parameters']['energy_shift']
                offset = g['offset'] + (i * options.stack_offset if marked else 0)
                suffix = 'flat' if g['parameters']['flatten'] else 'norm'
                def processed(key):
                    px, y = _pair(a.get('energy', []), a.get(key, []), name=f'{g["label"]} · {key}')
                    if px.shape != x.shape or not np.allclose(px, x, atol=1e-9, rtol=0):
                        raise ScientificError('Processed energy is out of date. Reprocess this group.')
                    return y
                if options.kind in ('i0', 'i0sig'):
                    if options.kind == 'i0sig': add(g, x, mu, 'μ(E)', g['multiplier'], offset)
                    for channel in (('i0', 'signal') if options.kind == 'i0sig' else ('i0',)):
                        try:
                            raw = g.get('source', {}).get('raw_arrays', {}).get(channel)
                            _, values = _pair(rawx, [] if raw is None else raw, name=channel)
                            factor = detector_scale(g, channel) if options.kind == 'i0sig' else 1.
                            add(g, x, values, ('I₀' if channel == 'i0' else 'Signal') + (f' · scaled by {factor:.6g}' if options.kind == 'i0sig' else ''),
                                g['multiplier'] * factor, offset, detector_scale=factor, channel=channel)
                        except ScientificError as exc:
                            skipped.append(dict(group_id=g['id'], label=g['label'], channel=channel, reason=str(exc)))
                    continue
                if g['data_type'] == 'detector' or g.get('is_difference'):
                    raise ScientificError('Choose an absorption spectrum with valid normalization.')
                if options.kind == 'normderiv':
                    derivative = processed('dmude'); maximum = float(np.max(np.abs(derivative)))
                    if maximum == 0: raise ScientificError('A zero derivative prevents Athena comparison scaling.')
                    e0 = _number(effective.get('e0'), 'E₀')
                    x_range = [e0-30, e0+70]
                    add(g, x, processed(suffix), f'{suffix} μ(E)', g['multiplier'], offset)
                    scale = float(f'{.5 / maximum:.3f}')
                    add(g, x, derivative, f'Normalized derivative · scaled by {scale:.3f}', scale, offset)
                elif options.kind == 'normscaled':
                    step = _number(effective.get('edge_step'), 'Edge step')
                    add(g, x, processed(suffix), f'{suffix} μ(E) × edge step {step:.6g}', step, offset)
                else:
                    e0 = _number(effective.get('e0'), 'E₀')
                    form = 'mu' if options.energy_mode == 'mu' else suffix
                    add(g, x-e0, mu if form == 'mu' else processed(form), f'{form} μ(E)', g['multiplier'], offset)
            except ScientificError as exc:
                del curves[count:]
                if not marked: raise
                skipped.append(dict(group_id=g['id'], label=g['label'], reason=str(exc)))
        if options.kind in ('normderiv', 'normscaled', 'e00'):
            notes.append('Normalized displays follow each group’s Flatten setting. The normalized derivative always comes from the unflattened spectrum.')
        if options.kind == 'e00':
            notes.append('Athena’s E₀-at-zero shortcut displays μ(E), with energy derivatives switched off.')
        if options.kind == 'i0sig':
            notes.append('Detector factors are retained from import. New columns use |max μ(E)| / max channel; legacy PRJ import uses signed max μ(E), following Athena’s project reader.')
    return dict(group_ids=options.group_ids, curves=curves, notes=list(dict.fromkeys(notes)), skipped=skipped,
                x_label=x_label, y_label=y_label, x_range=x_range)
