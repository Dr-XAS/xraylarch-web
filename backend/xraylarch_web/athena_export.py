"""Athena column files from saved Larch arrays; export never edits a project.

Reference: Demeter 06afc8da Data/IO.pm, Data/XDI.pm and process/larch
templates. See docs/athena-data-export-reference.md for observed native bugs
and explicit grid/metadata behavior. No uploaded expressions are evaluated.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import io
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from typing import Literal
import zipfile

import numpy as np
from larch import __version__ as larch_version
from larch.io import write_ascii
from larch.math import deriv, interp, index_nearest
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_xdi import family_name
from .athena_xdi_controls import effective_metadata

Single = Literal['xmu', 'norm', 'chi', 'r', 'q']
Form = Literal['xmu', 'norm', 'chi', 'r', 'q', 'der', 'nder', 'sec', 'nsec',
               'chik', 'chik2', 'chik3', 'chir_re', 'chir_im', 'chir_mag',
               'chir_pha', 'dph', 'chiq_re', 'chiq_im', 'chiq_mag', 'chiq_pha']
SINGLE = ('xmu', 'norm', 'chi', 'r', 'q')
ENERGY = ('xmu', 'norm', 'der', 'nder', 'sec', 'nsec')
MARKED = (*ENERGY, 'chi', 'chik', 'chik2', 'chik3', 'chir_re', 'chir_im',
          'chir_mag', 'chir_pha', 'dph', 'chiq_re', 'chiq_im', 'chiq_mag', 'chiq_pha')
SUFFIX = {'xmu': 'xmu', 'norm': 'nor', 'chi': 'chik', 'r': 'chir', 'q': 'chiq'}
ETOK_NATIVE = 0.2624682917
MAX_VALUES = 2_000_000


class DataExport(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)
    version: int = Field(ge=0)
    scope: Literal['current', 'marked', 'each'] = 'current'
    group_id: str | None = Field(default=None, min_length=1, max_length=200)
    form: Form = 'xmu'
    kweight: Literal['all', '0', '1', '2', '3', 'kw'] = 'all'
    arbitrary_kweight: float | None = Field(default=None, ge=0, le=4)
    with_multipliers: bool = False

    @model_validator(mode='after')
    def combinations(self):
        if self.scope == 'current' and not self.group_id:
            raise ValueError('Choose a current group to export.')
        if self.scope != 'current' and self.group_id is not None:
            raise ValueError('Marked exports use the marked groups in list order, without a current-group override.')
        if self.form not in (MARKED if self.scope == 'marked' else SINGLE):
            raise ValueError('Choose a data form available for this export scope.')
        if self.kweight != 'all' and (self.scope == 'marked' or self.form != 'chi'):
            raise ValueError('Selected k weights apply to current or separate chi(k) files.')
        if self.with_multipliers and not (self.scope == 'marked' and self.form in ('xmu', 'der', 'sec')):
            raise ValueError('Plot multipliers apply only to marked raw mu and raw derivatives.')
        return self


@dataclass
class Table:
    filename: str
    labels: list[str]
    units: list[str]
    arrays: list[np.ndarray]
    groups: list[dict]
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    header: list[str] = field(default_factory=list)


def _array(value, name):
    a = np.asarray(value, dtype=float)
    if a.ndim != 1 or len(a) < 3 or not np.isfinite(a).all():
        raise ValueError(f'{name}: a finite one-dimensional array with at least three points is required.')
    return a


def _axis(value, name):
    a = _array(value, name)
    if np.any(np.diff(a) <= 0):
        raise ValueError(f'{name}: export requires a strictly increasing axis.')
    return a


def _same(a, b):
    return a.shape == b.shape and np.allclose(a, b, rtol=0, atol=1e-9)


def _result(group):
    if group.get('processing_error') or not group.get('result'):
        raise ValueError(f"{group['label']}: apply valid processing parameters before exporting this data form.")
    return group['result']


def _energy(group, form):
    if group['data_type'] == 'chi':
        raise ValueError(f"{group['label']}: chi(k) data has no measured energy-domain absorption.")
    x = _axis(np.asarray(group['energy']) + group['parameters']['energy_shift'], 'Energy')
    if x[0] <= 0 or x[-1] > 1e7:
        raise ValueError('Shifted energy must be positive eV no greater than 1e7.')
    y = _array(group['mu'], 'Absorption')
    resolved = form
    if len(x) != len(y):
        raise ValueError('Energy and absorption lengths differ.')
    if form in ('norm', 'nder', 'nsec'):
        a = _result(group)['arrays']
        if not _same(x, _axis(a['energy'], 'Processed energy')):
            raise ValueError('Processed energy is stale; apply parameters before export.')
        resolved = 'flat' if form == 'norm' and group['parameters']['flatten'] else 'norm'
        y = _array(a[resolved], resolved)
    if form in ('der', 'nder', 'sec', 'nsec'):
        y = deriv(y) / deriv(x)
        if form in ('sec', 'nsec'):
            y = deriv(y) / deriv(x)
    return x, y, resolved


def _phase_derivative(arrays):
    r = _axis(arrays['r'], 'R')
    phase = _array(arrays['chir_pha'], 'R phase')
    magnitude = _array(arrays['chir_mag'], 'R magnitude')
    if phase.shape != r.shape or magnitude.shape != r.shape:
        raise ValueError('R phase and magnitude must use the saved R grid.')
    slope = deriv(phase) / deriv(r)
    scale = np.max(np.abs(slope))
    # The native template divides by zero for constant phase. Its continuous
    # zero-slope limit supplies a finite, explicitly unvarying exported curve.
    return slope * (np.max(magnitude) / scale) if scale > 0 else np.zeros_like(slope)


def _transformed(group, form):
    result = _result(group); arrays = result['arrays']
    if form in ('chi', 'chik', 'chik2', 'chik3'):
        x = _axis(arrays['k'], 'k')
        weight = {'chi': 0, 'chik': 1, 'chik2': 2, 'chik3': 3}[form]
        y = _array(arrays['chi'], 'chi') * x ** weight
    elif form.startswith('chir') or form == 'dph':
        x = _axis(arrays['r'], 'R')
        y = _phase_derivative(arrays) if form == 'dph' else _array(arrays[form], form)
    else:
        x = _axis(arrays['q'], 'q'); y = _array(arrays[form], form)
    return x, y


def _absolute_energy(group, k):
    effective = (group.get('result') or {}).get('effective', {})
    e0 = effective.get('e0') or group['parameters'].get('e0')
    if e0 is None:
        native = group.get('source', {}).get('native', {}).get('args', {}).get('bkg_e0')
        try:
            value = float(native)
            if not isinstance(native, bool) and np.isfinite(value) and 0 < value <= 1e7:
                e0 = value
        except (TypeError, ValueError):
            pass
    # Pure chi(k) has no energy origin in the web contract. Do not invent one.
    if e0 is None:
        return None
    return float(e0) + k ** 2 / ETOK_NATIVE


def _arbitrary_weight(group, options):
    if options.arbitrary_kweight is not None:
        return options.arbitrary_kweight
    value = group.get('source', {}).get('native', {}).get('args', {}).get('fit_karb_value', group['parameters']['kweight'])
    try:
        if isinstance(value, bool):
            raise ValueError()
        weight = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError('The saved arbitrary k weight is invalid; choose an explicit output weight.') from exc
    if not np.isfinite(weight) or not 0 <= weight <= 4:
        raise ValueError('The saved arbitrary k weight is outside 0 through 4; choose an explicit output weight.')
    return weight


def _basename(label):
    name = (re.sub(r'[^-a-zA-Z0-9.+]+', '_', label)[:150].rstrip('.') or 'group').lstrip('.') or 'group'
    return 'group_'+name if re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', name) else name


def single(group, options):
    form = options.form
    warnings = []; notes = []; labels = []; units = []
    arrays = (_result(group)['arrays'] if form not in ('xmu',) or group.get('result') else {})
    if form in ('xmu', 'norm'):
        x, raw, _ = _energy(group, 'xmu')
        if form == 'xmu' and group['data_type'] == 'detector':
            data = [x, raw]; labels = ['energy', 'detector_signal']; units = ['eV', 'counts']
            notes.append('Detector signal: no normalization or background processing applies.')
        else:
            result = _result(group); a = result['arrays']; eff = result['effective']
            if not _same(x, _axis(a['energy'], 'Processed energy')):
                raise ValueError('Processed energy is stale; apply parameters before export.')
            pre, post = _array(a['pre_edge'], 'Pre-edge'), _array(a['post_edge'], 'Post-edge')
            normalized = _array(a['norm'], 'Normalized absorption'); flat = _array(a['flat'], 'Flattened absorption')
            if not group['parameters']['flatten'] and not (group.get('is_normalized') or group['data_type'] in ('norm', 'xmudat')):
                # A norm(E) file includes both normalization choices regardless
                # of the plotting preference. Reproduce Larch's flat curve
                # from the saved fits, without fitting or changing parameters.
                step = eff.get('edge_step')
                if not isinstance(step, (int, float)) or not np.isfinite(step) or step <= 0:
                    raise ValueError('A positive applied edge step is required for flattened export.')
                at = index_nearest(x, eff['e0'])
                residue = (post-pre)/step
                flat = normalized-residue+residue[at]
                flat[:at] = normalized[:at]
            has_background = bool(a.get('bkg'))
            bkg = _array(a['bkg'], 'Background') if has_background else np.zeros_like(x)
            if not has_background:
                notes.append('No EXAFS background is available; background columns are zero (XANES convention).')
            if form == 'xmu':
                _, d1, _ = _energy(group, 'der'); _, d2, _ = _energy(group, 'sec')
                data = [x, raw, bkg, pre, post, d1, d2]
                labels = ['energy', 'xmu', 'bkg', 'pre_edge', 'post_edge', 'der', 'sec']
                units = ['eV', '', '', '', '', '', '']
            else:
                step = eff.get('edge_step')
                if not isinstance(step, (int, float)) or not np.isfinite(step) or step <= 0:
                    raise ValueError('A positive applied edge step is required for normalized export.')
                nbkg = (bkg - pre) / step + group['offset'] if has_background else bkg
                fbkg = (bkg - pre) / step + (flat - normalized) if has_background else bkg
                if group.get('is_normalized') or group['data_type'] in ('norm', 'xmudat'):
                    nbkg = fbkg = bkg.copy()
                elif group['offset'] and has_background:
                    notes.append('Normalized background includes the native post_autobk y_offset; flattened background does not.')
                d1 = deriv(normalized) / deriv(x); d2 = deriv(d1) / deriv(x)
                data = [x, normalized, nbkg, flat, fbkg, d1, d2]
                labels = ['energy', 'norm', 'nbkg', 'flat', 'fbkg', 'nder', 'nsec']
                units = ['eV', '', '', '', '', '1/eV', '1/eV^2']
        i0 = group.get('source', {}).get('raw_arrays', {}).get('i0')
        if form == 'xmu' and i0 is not None:
            a0 = _array(i0, 'Retained I0')
            if a0.shape != x.shape:
                raise ValueError('Retained I0 does not match the exported energy grid; reimport or rebin the original columns.')
            labels.append('i0'); units.append(''); data.append(a0)
    elif form == 'chi':
        k, chi = _transformed(group, 'chi')
        if options.kweight == 'all':
            data = [k, chi, k*chi, k**2*chi, k**3*chi, _array(arrays['kwin'], 'Forward window')]
            labels = ['k', 'chi', 'chik', 'chik2', 'chik3', 'window']; units = ['1/Angstrom', '', '', '', '', '']
            energy = _absolute_energy(group, k)
            if energy is not None:
                data.append(energy); labels.append('energy'); units.append('eV')
            else:
                notes.append('Absolute-energy column omitted: imported chi(k) has no known E0.')
        else:
            weight = _arbitrary_weight(group, options) if options.kweight == 'kw' else float(options.kweight)
            data = [k, chi*k**weight]; labels = ['k', f'k{weight:g}_chi']; units = ['1/Angstrom', '']
            notes.append(f'Output chi(k) weight: {weight:g}; applied transform settings are unchanged.')
    elif form == 'r':
        labels = ['r', 'chir_re', 'chir_im', 'chir_mag', 'chir_pha', 'window', 'deriv_phase']
        units = ['Angstrom', '', '', '', 'rad', '', '']
        data = [_axis(arrays['r'], 'R')] + [_array(arrays[k], k) for k in labels[1:5]] + [_array(arrays['rwin'], 'Reverse window'), _phase_derivative(arrays)]
        notes.append('Phase derivative is scaled to maximum chi(R) magnitude, following Athena dphase.')
    else:
        q = _axis(arrays['q'], 'q'); k = _axis(arrays['k'], 'k')
        labels = ['q', 'chiq_re', 'chiq_im', 'chiq_mag', 'chiq_pha', 'window', 'chik']
        units = ['1/Angstrom', '', '', '', 'rad', '', '']
        # xftr can add a trailing q point beyond the input k grid. Preserve
        # every filtered value and explicitly zero-pad the input-only columns,
        # consistent with the transform's zero padding outside measured chi.
        mask = (q >= k[0]-1e-9) & (q <= k[-1]+1e-9)
        if not mask.all():
            notes.append(f'Input chi(k) and window are zero-padded at {int((~mask).sum())} q points outside saved k support; all filtered q values are retained.')
        data = [q] + [_array(arrays[key], key) for key in labels[1:5]]
        data += [np.interp(q, k, _array(arrays[key], key), left=0., right=0.) for key in ('kwin', 'weighted_chi')]
    return Table(f'{_basename(group["label"])}.{SUFFIX[form]}', labels, units, data, [group], warnings, notes)


def marked(groups, options):
    form = options.form
    curves = [(_energy(g, form)[:2] if form in ENERGY else _transformed(g, form)) for g in groups]
    x = curves[0][0]; data = [x]; labels = []; notes = []; warnings = []
    axis = 'energy' if form in ENERGY else 'r' if form.startswith('chir') or form == 'dph' else 'q' if form.startswith('chiq') else 'k'
    labels.append(axis); units = [{'energy': 'eV', 'k': '1/Angstrom', 'r': 'Angstrom', 'q': '1/Angstrom'}[axis]]
    if axis == 'k':
        energy = _absolute_energy(groups[0], x)
        if energy is not None:
            labels.append('energy'); units.append('eV'); data.append(energy)
        else:
            notes.append('Absolute-energy column omitted: first marked chi(k) group has no known E0.')
    for index, (g, (gx, y)) in enumerate(zip(groups, curves, strict=True), start=1):
        if len(gx) != len(y):
            raise ValueError(f"{g['label']}: axis and output values differ in length.")
        if axis == 'energy':
            outside = int(np.count_nonzero((x < gx[0]) | (x > gx[-1])))
            if outside:
                warnings.append(f"{g['label']}: {outside} points were linearly extrapolated beyond measured energy support.")
            if not _same(gx, x):
                y = interp(gx, y, x, fill_value=0.)
        elif not _same(gx, x):
            raise ValueError(f"{g['label']}: {axis} grids differ. Use separate files or apply matching transform grids before a combined export.")
        if options.with_multipliers:
            y = y * g['multiplier']
        label = f'g{index}_{re.sub(r"[^A-Za-z0-9_]", "_", g["label"])[:80]}'
        labels.append(label); units.append(''); data.append(y)
        notes.append(f'Column.{len(labels)}: {g["label"]}; group={g["id"]}; form={form}; multiplier={g["multiplier"] if options.with_multipliers else 1:g}')
    notes.append('Groups follow project list order. The first marked group supplies the output axis.')
    if form == 'norm':
        notes.append('Each group uses flattened or unflattened norm according to its applied flatten setting.')
    return Table(f'marked.{form}', labels, units, data, groups, warnings, notes)


def _text(value):
    if isinstance(value, bool):
        return 'yes' if value else 'no'
    if isinstance(value, (int, float)):
        if not np.isfinite(value):
            raise ValueError('Output metadata must be finite.')
        return f'{value:.14g}'
    return str(value).replace('\r', '\\r').replace('\n', '\\n').replace('\0', '\\0')


def processing_header(group):
    result = group.get('result') or {}; e = result.get('effective', {}); p = group['parameters']
    aliases = {'e0': 'e0', 'energy_shift': 'eshift', 'rbkg': 'rbkg', 'bkg_kweight': 'bkg_kweight',
               'edge_step': 'edge_step', 'kweight': 'kweight', 'window': 'window', 'rwindow': 'rwindow',
               'dk': 'dk', 'dr': 'dr', 'bkg_dk': 'bkg_dk', 'bkg_window': 'bkg_window', 'nclamp': 'nclamp',
               'nfft': 'nfft', 'kstep': 'kstep', 'nnorm': 'normalization_degree', 'flatten': 'flatten', 'fnorm': 'fnorm',
               'fnorm_scale': 'fnorm_scale', 'fnorm_edge_step': 'fnorm_edge_step'}
    fields = {target: e.get(key, p.get(key)) for key, target in aliases.items()}
    if fields.get('e0') is None:
        origin = _absolute_energy(group, np.array([0.]))
        if origin is not None:
            fields['e0'] = float(origin[0])
            fields['energy_origin'] = 'retained native project bkg_e0'
    fields.update(fixed_step=p.get('step') is not None, plot_multiplier=group['multiplier'], y_offset=group['offset'],
                  phase_correction=False, standard=group.get('background_standard_id') or 'None', datatype=group['data_type'])
    for name, keys in {'pre_edge_range': ('pre1', 'pre2'), 'normalization_range': ('norm1', 'norm2'),
                       'spline_range_k': ('bkg_kmin', 'bkg_kmax'), 'clamps': ('clamp_lo', 'clamp_hi'),
                       'k_range': ('kmin', 'kmax'), 'r_range': ('rmin', 'rmax')}.items():
        values = [e.get(key, p.get(key)) for key in keys]
        if all(value is not None for value in values):
            fields[name] = ' '.join(_text(v) for v in values)
    if e.get('bkg_kmax') is not None:
        fields['spline_range_energy'] = ' '.join(_text(e[k]**2/ETOK_NATIVE) for k in ('bkg_kmin', 'bkg_kmax'))
    a = result.get('arrays', {})
    if a.get('energy') and a.get('pre_edge') and a.get('post_edge'):
        # Recover equations of the saved curves, not a new fit to absorption.
        # A centered polynomial avoids cancellation when recovering coefficients.
        energy = np.asarray(a['energy']); center = float(e.get('e0') or energy.mean())
        for name, key, degree in [('pre_edge_line', 'pre_edge', 1), ('post_edge_polynomial', 'post_edge', max(1, int(e.get('nnorm') or 0)))]:
            coeff = np.polynomial.Polynomial.fit(energy-center, a[key], degree).convert().coef
            fields[name] = ' + '.join(f'{v:.14g}*(E-{center:.14g})^{i}' for i, v in enumerate(coeff))
    return [f'Athena.{name}: {_text(value)}' for name, value in fields.items() if value is not None]


def header(table, options):
    group = table.groups[0]; metadata = effective_metadata(group)
    extra = _text(metadata.get('extra_version', '')).strip()
    lines = [f'XDI/1.0 {extra} XrayLarch/0.1.0 Larch/{larch_version}'.replace('  ', ' ')]
    attrs = metadata['attributes'] if options.scope != 'marked' else {'element': metadata['attributes'].get('element', {})}
    for family, fields in sorted(attrs.items()):
        if family in ('column', 'athena', 'artemis'):
            continue
        name = family_name(metadata, family)
        for tag, value in sorted(fields.items()):
            if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name) or not re.fullmatch(r'[A-Za-z_0-9]+', tag):
                raise ValueError('Acquisition metadata contains an invalid XDI family or field name.')
            lines.append(f'{name}.{tag}: {_text(value)}')
    for index, (label, unit) in enumerate(zip(table.labels, table.units, strict=True), start=1):
        lines.append(f'Column.{index}: {label}' + (f' {unit}' if unit else ''))
    lines.append(f'XrayLarch.output: {options.scope} {options.form}')
    lines.extend(processing_header(group) if options.scope != 'marked' else [])
    lines.append('///')
    for g in table.groups:
        lines.append(f'Group: {_text(g["label"])}; id={g["id"]}')
        lines.extend(effective_metadata(g)['comments_text'].splitlines())
        if g.get('notes'):
            lines.extend(['Group notes:', *g['notes'].splitlines()])
        if options.scope == 'marked':
            lines.extend(processing_header(g))
        lines.extend('Processing notice: ' + _text(w) for w in (g.get('result') or {}).get('warnings', []))
    lines.extend(_text(note) for note in table.notes)
    lines.extend('Export notice: ' + _text(warning) for warning in table.warnings)
    return lines


def prepare(project, options):
    options = DataExport.model_validate(options)
    groups = [g for g in project['groups'] if g['id'] == options.group_id] if options.scope == 'current' else [g for g in project['groups'] if g['marked']]
    if not groups:
        raise ValueError('Choose a current group or mark groups before exporting data.')
    with np.errstate(divide='raise', over='raise', invalid='raise'):
        try:
            tables = [marked(groups, options)] if options.scope == 'marked' else [single(g, options) for g in groups]
        except (ArithmeticError, IndexError, KeyError) as exc:
            raise ValueError(f'Export could not produce complete finite columns: {exc}. Check the applied processing and data type.') from exc
    used = set(); cells = 0
    for table in tables:
        table.arrays = [_array(value, name) for name, value in zip(table.labels, table.arrays, strict=True)]
        if len({len(a) for a in table.arrays}) != 1:
            raise ValueError('Output column lengths differ; no file was written. Check the transform grids.')
        cells += sum(len(a) for a in table.arrays)
        if cells > MAX_VALUES:
            raise ValueError('This export exceeds two million values. Export fewer marked groups at a time.')
        original = table.filename; stem, suffix = original.rsplit('.', 1); counter = 2
        while table.filename.casefold() in used:
            table.filename = f'{stem}-{counter}.{suffix}'; counter += 1
        used.add(table.filename.casefold())
        table.header = header(table, options)
    return tables


def preview(tables):
    return [dict(filename=t.filename, group_ids=[g['id'] for g in t.groups], rows=len(t.arrays[0]),
                 columns=[dict(name=k, unit=u) for k, u in zip(t.labels, t.units, strict=True)],
                 sample=np.column_stack([a[:5] for a in t.arrays]).tolist(), warnings=t.warnings, notes=t.notes,
                 header=t.header) for t in tables]


def encode(tables, scope):
    # Preflight completed every table before any output is made. The actual
    # Larch writer owns numeric formatting; paths exist only in a temp folder.
    contents = []
    with TemporaryDirectory(prefix='athena-column-export-') as directory:
        for index, table in enumerate(tables):
            path = Path(directory) / f'{index}.dat'
            write_ascii(str(path), *table.arrays, label=' '.join(table.labels), header=table.header.copy())
            contents.append((table.filename, path.read_bytes()))
    if scope == 'each':
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for filename, content in contents:
                archive.writestr(filename, content)
        return 'athena-marked-data.zip', 'application/zip', output.getvalue()
    filename, content = contents[0]
    return filename, 'text/plain; charset=utf-8', content
