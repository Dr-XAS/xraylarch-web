"""Athena's 28-column parameter report, backed by the saved Larch project.

Column positions and numeric formats follow Demeter UI/Athena/Group.pm.
The native BIFF8 XLS format is intentional; this is not CSV with an XLS suffix.
"""
from __future__ import annotations

from datetime import datetime, timezone
import io
import math
from typing import Literal

import numpy as np
from larch import __version__ as larch_version
from pydantic import BaseModel, ConfigDict, Field
from xraydb import atomic_name
import xlwt

from .athena_export import _absolute_energy
from .athena_xdi_controls import effective_metadata


class ParameterReport(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    version: int = Field(ge=0)
    scope: Literal['all', 'marked'] = 'all'


SECTIONS = [
    ('identity', 'Group information', 0, 4),
    ('background', 'Background removal parameters', 6, 18),
    ('forward', 'Forward Fourier transform parameters', 20, 24),
    ('reverse', 'Backward Fourier transform parameters', 26, 28),
    ('plotting', 'Plotting parameters', 30, 31),
]
_LABELS = {
    0: ('group', 'Group', ''), 1: ('element', 'Element', ''), 2: ('edge', 'Edge', ''),
    3: ('importance', 'Importance', ''), 4: ('shift', 'Edge shift', 'eV'),
    6: ('e0', 'E0', 'eV'), 7: ('algorithm', 'Algorithm', ''), 8: ('rbkg', 'Rbkg', 'Å'),
    9: ('bkg_weight', 'k-weight', ''), 10: ('order', 'Normalization order', 'terms'),
    11: ('pre_range', 'Pre-edge range', 'eV relative to E0'),
    12: ('norm_range', 'Normalization range', 'eV relative to E0'),
    13: ('spline_k', 'Spline range (k)', 'Å⁻¹'), 14: ('spline_e', 'Spline range (E)', 'eV relative to E0'),
    15: ('step', 'Edge step', ''), 16: ('standard', 'Standard', ''),
    17: ('clamp_lo', 'Lower clamp', ''), 18: ('clamp_hi', 'Upper clamp', ''),
    20: ('k_range', 'k-range', 'Å⁻¹'), 21: ('dk', 'dk', 'Å⁻¹'), 22: ('window', 'Window', ''),
    23: ('arbitrary_weight', 'Arb. kw', ''), 24: ('phase', 'Phase correction', ''),
    26: ('r_range', 'R-range', 'Å'), 27: ('dr', 'dR', 'Å'), 28: ('rwindow', 'Window', ''),
    30: ('multiplier', 'Plot multiplier', ''), 31: ('offset', 'y offset', ''),
}
COLUMNS = [dict(index=index, key=key, label=label, unit=unit,
                section=next(s for s, _, low, high in SECTIONS if low <= index <= high))
           for index, (key, label, unit) in _LABELS.items()]
THREE_DECIMAL = {4, 6, 8, 21, 27, 31}
SCIENTIFIC = {15, 30}


def _number(value):
    if value is None or value == '':
        return None
    try:
        number = float(value) if not isinstance(value, bool) else math.nan
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _range(low, high):
    a, b = _number(low), _number(high)
    return None if a is None or b is None else f'[ {a:.3f} : {b:.3f} ]'


def _clamp(value):
    number = _number(value)
    if number is None:
        return None
    clamps = {0: 'None', 3: 'Slight', 6: 'Weak', 12: 'Medium', 24: 'Strong', 96: 'Rigid'}
    nearest = min(clamps, key=lambda v: abs(v - number))
    return clamps[nearest] if number in clamps else f'{clamps[nearest]} ({number:g})'


def _element_name(symbol):
    name = atomic_name(symbol).capitalize()
    # Chemistry::Elements, used by Athena's report, uses the IUPAC spelling.
    return 'Aluminium' if name == 'Aluminum' else name


def report_row(group, project):
    p = group['parameters']; result = group.get('result') or {}
    e = result.get('effective', {}) if not group.get('processing_error') else {}
    native = group.get('source', {}).get('native', {}).get('args', {})
    notes = []
    def value(key):
        # Effective None means the operation did not use that parameter.
        # Report its saved control value, with applicability stated below.
        return e[key] if e.get(key) is not None else p.get(key)
    def number(key):
        result = _number(value(key))
        if value(key) is not None and result is None:
            notes.append(f'{key}: invalid saved value {value(key)!s}; reported as n.a.')
        return result
    data_type = group['data_type']
    if group.get('processing_error') or not result:
        notes.append('Processing is unavailable; values are saved settings, not confirmed results.')
    elif data_type == 'detector' or group.get('is_difference', group.get('source', {}).get('operation') == 'difference'):
        notes.append('Absorption and Fourier settings are inactive for this signal.')
    elif data_type == 'chi':
        notes.append('Background and normalization settings are inactive for chi(k).')
    elif not e.get('exafs'):
        notes.append('Background removal and Fourier settings were not used for this energy spectrum.')
    if group.get('is_normalized') or data_type in ('norm', 'xmudat'):
        notes.append('Input is already normalized; normalization settings were not fitted.')
    identity = effective_metadata(group)['attributes'].get('element', {})
    try:
        element = _element_name(identity.get('symbol')) if identity.get('symbol') else None
    except (ValueError, KeyError):
        element = identity.get('symbol')
    importance = _number(native.get('importance', 1.))
    if importance is None:
        notes.append('The retained native importance is invalid; reported as n.a.')
    weight = _number(native.get('fit_karb_value', value('kweight')))
    if 'fit_karb_value' not in native:
        notes.append('No separate arbitrary weight was saved; Arb. kw uses the applied FT weight.')
    elif weight is None:
        notes.append('The retained arbitrary weight is invalid; reported as n.a.')
    standard_id = group.get('background_standard_id')
    standard = next((g['label'] for g in project['groups'] if g['id'] == standard_id), None) if standard_id else 'None'
    if standard_id and standard is None:
        standard = f'Unavailable ({standard_id})'
        notes.append('The background standard is missing from the project.')
    degree = number('nnorm'); e0 = number('e0')
    if data_type == 'chi' and e0 is None:
        origin = _absolute_energy(group, np.array([0.]))
        if origin is not None:
            e0 = float(origin[0]); notes.append('E0 is the retained native energy origin, not an edge fitted to chi(k).')
    k1, k2 = number('bkg_kmin'), number('bkg_kmax')
    if any(_number(value(key)) not in (None, 0, 3, 6, 12, 24, 96) for key in ('clamp_lo', 'clamp_hi')):
        notes.append('Clamp names are nearest native levels; parentheses retain custom numeric strengths.')
    from .athena_export import ETOK_NATIVE
    values = [None] * 32
    cells = {
        0: group['label'], 1: element, 2: identity.get('edge'), 3: importance, 4: number('energy_shift'),
        6: e0, 7: 'autobk' if e.get('exafs') and data_type != 'chi' else None,
        8: number('rbkg'), 9: number('bkg_kweight'), 10: None if degree is None else degree + 1,
        11: _range(value('pre1'), value('pre2')), 12: _range(value('norm1'), value('norm2')),
        13: _range(k1, k2), 14: _range(None if k1 is None else k1*k1/ETOK_NATIVE, None if k2 is None else k2*k2/ETOK_NATIVE),
        15: _number(e.get('edge_step') if e.get('edge_step') is not None else p.get('step')),
        16: standard, 17: _clamp(value('clamp_lo')), 18: _clamp(value('clamp_hi')),
        20: _range(value('kmin'), value('kmax')), 21: number('dk'), 22: value('window'), 23: weight,
        24: 'no', 26: _range(value('rmin'), value('rmax')), 27: number('dr'), 28: value('rwindow'),
        30: _number(group['multiplier']), 31: _number(group['offset']),
    }
    for index, item in cells.items():
        if isinstance(item, str) and len(item.encode('utf-16-le')) // 2 > 32767:
            raise ValueError(f"{group['label']}: a parameter exceeds the XLS cell text limit.")
        values[index] = item
    return dict(group_id=group['id'], label=group['label'], data_type=data_type, frozen=group['frozen'], values=values, notes=notes)


def prepare_report(project, request):
    groups = [g for g in project['groups'] if request.scope == 'all' or g['marked']]
    if not groups:
        raise ValueError('No groups are selected for the parameter report. Choose all groups or mark at least one group.')
    return dict(project_id=project['id'], version=project['version'], scope=request.scope,
                filename=f'athena-parameters-{request.scope}.xls', project_name=project['name'], columns=COLUMNS,
                sections=[dict(key=key, label=label) for key, label, _, _ in SECTIONS],
                rows=[report_row(g, project) for g in groups])


def encode_report(report):
    workbook = xlwt.Workbook(encoding='utf-8', style_compression=2)
    sheet = workbook.add_sheet('Parameters')
    title = xlwt.easyxf('font: name Arial, height 240, bold on; pattern: pattern solid, fore_colour gray25; align: vert centre;')
    section = xlwt.easyxf('font: name Arial, height 200, bold on; pattern: pattern solid, fore_colour gray25; align: vert centre, wrap on;')
    heading = xlwt.easyxf('font: name Arial, height 200, bold on; align: horiz center, vert centre, wrap on; pattern: pattern solid, fore_colour gray25;')
    styles = {fmt: xlwt.easyxf('font: name Arial, height 200; align: horiz center, vert centre, wrap on;', num_format_str=fmt)
              for fmt in ('General', '0.000', '0.00E+00')}
    label_style = xlwt.easyxf('font: name Arial, height 200; align: vert centre, wrap on;')
    sheet.write_merge(1, 1, 0, 31, f"Athena parameter report — {report['project_name']}", title)
    sheet.write_merge(2, 2, 0, 31, f"Created {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}; {report['scope']} groups; project revision {report['version']}", label_style)
    sheet.write_merge(3, 3, 0, 31, f'XrayLarch/0.1.0, Larch/{larch_version}, xlwt/{xlwt.__VERSION__}', label_style)
    sheet.write_merge(4, 4, 0, 31, 'Energy: eV relative to E0 except E0/shift. k: Å⁻¹. R: Å. Normalization order: terms. n.a.: unavailable. See applicability notes below.', label_style)
    sheet.row(1).height = 440; sheet.row(5).height = 440; sheet.row(6).height = 720
    for _, label, low, high in SECTIONS:
        sheet.write_merge(5, 5, low, high, label, section)
    for column in COLUMNS:
        index = column['index']; sheet.write(6, index, column['label'], heading)
        width = 31 if index == 0 else 27 if index in (11, 12, 13, 14, 20, 26) else 22 if index in (7, 16) else 16
        sheet.col(index).width = width * 256
    for spacer in (5, 19, 25, 29):
        sheet.col(spacer).width = 3 * 256
    for index, row in enumerate(report['rows'], start=7):
        sheet.row(index).height = max(440, min(2400, 300 * (1 + len(row['label']) // 30)))
        for column in COLUMNS:
            col = column['index']; value = row['values'][col]
            fmt = '0.000' if col in THREE_DECIMAL else '0.00E+00' if col in SCIENTIFIC else 'General'
            sheet.write(index, col, 'n.a.' if value is None else value, label_style if col == 0 else styles[fmt])
    index = 8 + len(report['rows'])
    sheet.write_merge(index, index, 0, 31, 'Applicability and retained settings', section)
    for row in report['rows']:
        if row['notes']:
            index += 1
            sheet.write_merge(index, index, 0, 4, row['label'], label_style)
            sheet.write_merge(index, index, 6, 31, ' '.join(row['notes']), label_style)
            sheet.row(index).height = 600
    sheet.panes_frozen = True; sheet.horz_split_pos = 7; sheet.vert_split_pos = 1
    sheet.remove_splits = True
    output = io.BytesIO(); workbook.save(output)
    return report['filename'], 'application/vnd.ms-excel', output.getvalue()
