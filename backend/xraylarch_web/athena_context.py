"""Native Athena context operations, separate from the general batch editor.

Behavior follows Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406:
UI/Athena/Main.pm (constrain), Data.pm (chi_noise), Data/Mu.pm
(edgestep_error), configuration/edgestep.demeter_conf, and the Larch
normalize/chi_noise templates. Diagnostics never persist calculated state.
"""
from copy import deepcopy
from typing import Literal

import numpy as np
from larch import Group
from larch.xafs import estimate_noise, pre_edge
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import AthenaParameters, ScientificError


class ContextReport(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(strict=True, ge=0)
    group_ids: list[str] = Field(min_length=1, max_length=100)
    kind: Literal['measurement_uncertainty', 'edge_step_uncertainty']
    seed: int = Field(default=0, strict=True, ge=0, le=2**32 - 1)


class ContextPlot(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(strict=True, ge=0)
    group_id: str
    kind: Literal['r123']


class ContextMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    element: str | None = Field(default=None, strict=True, min_length=1, max_length=32)
    edge: str | None = Field(default=None, strict=True, min_length=1, max_length=3)
    importance: float | None = Field(default=None, strict=True, ge=0)
    multiplier: float | None = Field(default=None, strict=True)
    offset: float | None = Field(default=None, strict=True)

    @model_validator(mode='after')
    def paired_identity(self):
        if (self.element is None) != (self.edge is None):
            raise ValueError('Supply both element and edge.')
        return self


class ContextParameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    mode: Literal['copy', 'reset', 'pixel_ratio'] = 'copy'
    source_id: str | None = None
    section: Literal['all', 'group', 'background', 'forward', 'reverse', 'plot'] = 'all'
    field: Literal['element', 'edge', 'importance', 'multiplier', 'offset', 'fix_step'] | None = None
    values: dict = Field(default_factory=dict)
    metadata: ContextMetadata = Field(default_factory=ContextMetadata)

    @model_validator(mode='after')
    def selected_values(self):
        if self.field is not None and 'section' in self.model_fields_set:
            raise ValueError('Choose one metadata field or one section.')
        if set(self.values) - (set(AthenaParameters.model_fields) | {'background_standard_id'}):
            raise ValueError('Supply known processing parameters.')
        if self.mode == 'copy' and not self.source_id:
            raise ValueError('Choose a source group for copying.')
        if self.mode == 'reset' and (self.source_id is not None or self.values or self.metadata.model_fields_set):
            raise ValueError('Reset uses default values without a source or overrides.')
        if self.mode == 'pixel_ratio' and (self.field not in ('importance', 'multiplier') or self.source_id is not None
                                           or self.values or self.metadata.model_fields_set):
            raise ValueError('Apply each group\'s BLA pixel ratio to importance or multiplier without a source or overrides.')
        return self


# These are Main.pm's native lists, not the broader web batch sections.
NATIVE_SECTIONS = {
    'group': (),
    'background': ('e0', 'rbkg', 'flatten', 'bkg_kweight', 'nnorm', 'pre1', 'pre2',
                   'norm1', 'norm2', 'bkg_kmin', 'bkg_kmax', 'background_standard_id', 'clamp_lo', 'clamp_hi'),
    'forward': ('kmin', 'kmax', 'dk', 'window', 'kweight'),
    'reverse': ('rmin', 'rmax', 'dr', 'rwindow'),
    'plot': (),
}


def context_parameters(store, project, groups, options):
    """Apply native constraints atomically through the store's dependency guards."""
    from .athena import _ensure_edge_identity
    from .athena_e0 import atomic_edge
    from .athena_merge import importance
    choice = ContextParameters.model_validate(options)
    if choice.mode == 'pixel_ratio':
        skipped = {}
        for group in groups:
            if group['frozen']:
                skipped[group['id']] = 'The group is frozen.'
                continue
            ratio = pixel_ratio(group)
            if ratio is None:
                skipped[group['id']] = 'No finite nonnegative BLA pixel ratio is retained in this group\'s XDI metadata.'
                continue
            if choice.field == 'importance':
                group['source']['importance'] = ratio
            else:
                group['multiplier'] = ratio
        return list(skipped), {'skipped_reasons': skipped}
    source = store.group(project, choice.source_id) if choice.mode == 'copy' else None
    sections = () if choice.field else tuple(NATIVE_SECTIONS) if choice.section == 'all' else (choice.section,)
    keys = tuple(key for section in sections for key in NATIVE_SECTIONS[section])
    defaults = AthenaParameters().model_dump() | {'background_standard_id': None}
    values = dict(defaults)
    identity = None
    metadata = {'importance': 1., 'multiplier': 1., 'offset': 0.}
    warnings = []
    if source:
        effective = (source.get('result') or {}).get('effective', {})
        values = source['parameters'] | {'background_standard_id': source.get('background_standard_id')} | choice.values
        values = {key: effective.get(key, value) if value is None and key != 'background_standard_id' else value
                  for key, value in values.items()}
        metadata.update(importance=importance(source), multiplier=source['multiplier'], offset=source['offset'])
        identity = deepcopy(source['source'].get('edge_identity'))
        native = source['source'].get('native', {}).get('args', {})
        if ('forward' in sections) and native.get('fft_pc') not in (None, False, 0, '0', ''):
            warnings.append('Native phase correction is retained as source metadata but is not applied by Athena Web.')
    explicit_metadata = choice.metadata.model_dump(exclude_none=True)
    if explicit_metadata.get('element'):
        entry = atomic_edge(explicit_metadata['element'], explicit_metadata['edge'])
        identity = {key: entry[key] for key in ('element', 'edge')} | {'origin': 'selected'}
    metadata.update({key: value for key, value in explicit_metadata.items() if key not in ('element', 'edge')})
    skipped, updates, targets = [], {}, []
    for group in groups:
        if source and group['id'] == source['id']:
            continue
        if group['frozen'] or ((keys or choice.field == 'fix_step') and store._frozen_background_dependents(project, [group['id']])):
            skipped.append(group['id'])
            continue
        patch = {key: values[key] for key in keys}
        if patch.get('background_standard_id') == group['id']:
            skipped.append(group['id'])
            continue
        if 'background' in sections or choice.field == 'fix_step':
            # Demeter copies bkg_fixstep, never bkg_step itself. A fixed
            # destination retains its own current step, not the source's.
            fixed = source is not None and choice.values.get('step', source['parameters']['step']) is not None
            patch['step'] = ((group.get('result') or {}).get('effective', {}).get('edge_step')
                             if group['parameters']['step'] is None else group['parameters']['step']) if fixed else None
            if fixed and patch['step'] is None:
                raise ScientificError(f"{group['label']}: process its edge step before fixing the normalization.")
        if patch:
            updates[group['id']] = patch
        targets.append(group)
    if updates:
        skipped.extend(store.parameter_updates(project, updates, skip_frozen=True))
    for group in targets:
        if group['id'] in skipped:
            continue
        if 'group' in sections or choice.field == 'importance':
            group['source']['importance'] = metadata['importance']
        if 'group' in sections or choice.field in ('element', 'edge'):
            group['source'].pop('edge_identity', None)
            if identity is not None:
                group['source']['edge_identity'] = deepcopy(identity)
            _ensure_edge_identity(group)
        if 'plot' in sections:
            group.update(multiplier=metadata['multiplier'], offset=metadata['offset'])
        elif choice.field in ('multiplier', 'offset'):
            group[choice.field] = metadata[choice.field]
    return sorted(set(skipped)), {'warnings': warnings}


def pixel_ratio(group):
    """The XDI BLA extension records the ratio directly; never infer from μ."""
    for key in ('xdi_metadata', 'beamline_metadata'):
        value = group.get('source', {}).get(key, {}).get('attributes', {}).get('bla', {}).get('pixel_ratio')
        try:
            number = float(value)
            if not isinstance(value, bool) and np.isfinite(number) and number >= 0:
                return number
        except (ValueError, TypeError, OverflowError):
            pass
    return None


def measurement_uncertainty(group):
    from .athena_merge import signal
    k, chi = signal(group, 'chi')
    effective = (group.get('result') or {}).get('effective', {})
    p = group['parameters']
    kmin, kmax = effective.get('kmin'), effective.get('kmax')
    if kmin is None or kmax is None or kmax <= kmin:
        raise ScientificError('Process a usable Fourier-transform range first.')
    out = Group()
    # Exact native template: window enters Larch **kws; kwindow remains
    # its default Kaiser window. Do not silently substitute the web FFT.
    estimate_noise(k, chi, group=out, kmin=kmin, kmax=kmax, dk=p['dk'], dk2=p['dk'],
                   window=p['window'], kweight=p['kweight'])
    values = {key: float(f'{getattr(out, key):.3e}') for key in ('epsilon_k', 'epsilon_r')}
    if not np.isfinite(list(values.values())).all() or min(values.values()) < 0:
        raise ScientificError('Larch could not resolve finite measurement uncertainties.')
    return values | {'nidp': float(2 * (kmax - kmin) * (p['rmax'] - p['rmin']) / np.pi),
                     'recommended_kmax': float(f'{out.kmax_suggest:.3f}'),
                     'method': 'Demeter Larch chi_noise; high-R noise estimate (15–30 Å)'}


def edge_step_uncertainty(group, seed=0):
    effective = (group.get('result') or {}).get('effective', {})
    if group['data_type'] not in ('mu', 'xanes') or group.get('is_normalized') or group.get('is_difference'):
        raise ScientificError('Edge-step uncertainty requires an unnormalized absorption spectrum.')
    keys = ('pre1', 'pre2', 'norm1', 'norm2')
    values = [effective.get(key) for key in keys]
    initial = effective.get('edge_step')
    if initial is None or any(value is None for value in values) or effective.get('nnorm') is None:
        raise ScientificError('Normalize this spectrum before estimating edge-step uncertainty.')
    initial = float(f'{initial:.7f}')  # Data::normalize stores seven decimals.
    rng = np.random.default_rng(seed)
    full = [initial]
    energy = np.asarray(group['energy']) + group['parameters']['energy_shift']
    mu = np.asarray(group['mu'])
    fixed = group['parameters']['step'] is not None
    for _ in range(20):
        ranges = dict(zip(keys, np.asarray(values) + rng.uniform(-1, 1, 4) * [20, 10, 15, 30]))
        out = Group()
        pre_edge(energy, mu, group=out, e0=effective['e0'], nnorm=effective['nnorm'], **ranges)
        step = float(initial) if fixed else float(f'{out.edge_step:.7f}')
        if not np.isfinite(step):
            raise ScientificError('A sampled normalization produced a nonfinite edge step; widen the normalization ranges.')
        full.append(step)
    full = np.asarray(full)
    selected = full
    sd, mean = float(np.std(full, ddof=1)), float(np.mean(full))
    progress = [f'Edge step with outliers: {mean:.5f} +/- {sd:.5f} ({len(full)} samples)']
    margin, unchanged, previous, final = 2.5, 0, 0, 0
    while sd > 0 and abs(initial - final) > sd / 2.5:
        selected = full[np.abs(full - initial) <= margin * sd]
        if len(selected) < 2:
            raise ScientificError('Too few sampled normalizations survive native outlier rejection.')
        mean, sd = float(np.mean(selected)), float(np.std(selected, ddof=1))
        final = mean
        unchanged = unchanged + 1 if previous == mean else 0
        previous = mean
        progress.append(f'Edge step without outliers: {mean:.5f} +/- {sd:.5f} ({len(selected)} samples, margin = {margin:.1f})')
        margin -= .2
        if unchanged == 4 or margin < 1.5:
            break
    warnings = ['A fixed edge step has zero sampled uncertainty by construction.'] if fixed else []
    report = (f'Full sample size = 21\nSample size with outliers removed = {len(selected)}\n'
              f'Current edge step value = {initial:.5f}\nAverage edge step value = {mean:.5f}\n'
              f'Approximate uncertainty in edge step = {sd:.5f}\n\nProgress report:\n' + '\n'.join(progress))
    return dict(edge_step=float(initial), mean=mean, standard_deviation=sd, samples=21,
                retained_samples=len(selected), report=report, seed=seed, warnings=warnings,
                method='Demeter randomized normalization ranges and iterative outlier rejection')


def context_report(store, ident, request):
    project = store.load(ident)
    store.check(project, request.version)
    results, skipped = [], []
    for group_id in dict.fromkeys(request.group_ids):
        group = store.group(project, group_id)
        identity = dict(group_id=group_id, label=group['label'])
        try:
            result = (measurement_uncertainty(group) if request.kind == 'measurement_uncertainty'
                      else edge_step_uncertainty(group, request.seed))
            results.append(identity | result)
        except (ValueError, IndexError, ZeroDivisionError, FloatingPointError, np.linalg.LinAlgError) as exc:
            skipped.append(identity | {'reason': str(exc) or 'This diagnostic could not be calculated.'})
    store.check(store.load(ident), request.version)
    return dict(version=project['version'], kind=request.kind, results=results, skipped=skipped)


def source_text(store, ident, group_id):
    """Only workspace-owned uploads are readable, never imported OS paths."""
    group = store.group(store.load(ident), group_id)
    upload_id = group.get('source', {}).get('mapping', {}).get('upload_id')
    if not isinstance(upload_id, str):
        raise ScientificError('The original uploaded data file is unavailable in this project. Reimport the original file to view its text.')
    content, filename = store.inspected_file(ident, upload_id, 'source')
    if len(content) > store.settings.max_upload_bytes or b'\0' in content:
        raise ScientificError('The original source is not a viewable text file.')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')
    return dict(filename=filename, text=text, kind='original')


def context_plot(store, ident, request):
    project = store.load(ident)
    store.check(project, request.version)
    source = store.group(project, request.group_id)
    arrays = (source.get('result') or {}).get('arrays', {})
    if not arrays.get('chi') or not arrays.get('k'):
        raise ScientificError('Process χ(k) before comparing Fourier-transform k weights.')
    from .athena_science import _transforms
    curves, warnings = [], []
    for weight in (1, 2, 3):
        out = Group(k=np.asarray(arrays['k']), chi=np.asarray(arrays['chi']))
        recipe = AthenaParameters.model_validate(source['parameters'] | {'kweight': weight})
        effective = deepcopy(source['result']['effective'])
        if effective.get('bkg_kmax') is not None:
            out.autobk_details = Group(kmax=effective['bkg_kmax'])
        # Freeze the already resolved window to ensure only kweight changes.
        recipe.kmin, recipe.kmax = effective['kmin'], effective['kmax']
        _transforms(out, recipe, effective, warnings)
        values = {key: np.asarray(getattr(out, key)).tolist() for key in
                  ('r', 'chir_mag', 'chir_re', 'chir_im', 'chir_pha')}
        if not all(np.isfinite(value).all() for value in values.values()):
            raise ScientificError('A comparison transform produced nonfinite values; rescale the source spectrum.')
        curves.append(dict(kweight=weight, arrays=values))
    store.check(store.load(ident), request.version)
    return dict(version=project['version'], group_id=request.group_id, curves=curves,
                warnings=list(dict.fromkeys(warnings)))
