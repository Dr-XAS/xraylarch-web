"""SLRI BL8 argon correction using Athena's native Larch normalization call."""
import copy
import hashlib
import re

import numpy as np
from larch import Group
from larch.xafs import pre_edge

from .athena_columns import preview_trace
from .athena_file_plugins import PreparedFile, _fail, _rows
from .athena_plugin_config import BL8ArParameters

# Xray::Absorption defaults to Elam, whose pinned Ar K entry is 3205.9 eV.
# The prose configuration rounds it to 3206, but get_energy does not round.
AR_K_EV = 3205.9


def recognize(data, configuration):
    params = BL8ArParameters.model_validate(configuration['values'])
    if b'BL8: X-ray Absorption Spectroscopy' not in data.split(b'\n', 1)[0]:
        return False
    match = re.search(rb'# E0 \(eV\)\s+=\s+(\d+)', data)
    return bool(match and 0 <= AR_K_EV / params.harmonic - int(match[1]) < params.margin)


def bl8ar(data, max_points, max_columns, configuration):
    params = BL8ArParameters.model_validate(configuration['values'])
    headers, observations, mode, count, channels = [], [], None, 0, 0
    for line in data.decode('utf-8-sig').splitlines(keepends=True):
        if not line.strip():
            continue
        if line.startswith('#'):
            headers.append(line)
            if 'Si Drift 4-Array' in line:
                mode, count, channels = 'sidrift', 10, 4
            elif 'Transmission-mode XAS' in line:
                mode, count, channels = 'trans', 6, 1
            elif re.search('Ge 13-array', line, re.I):
                mode, count, channels = 'ge', 19, 13
        elif not line.startswith('Energy'):
            observations.append(line)
    if mode is None:
        _fail('BL8Ar needs a Transmission-mode XAS, Si Drift 4-Array or Ge 13-array header.')
    table = np.asarray(_rows(observations, count, 'BL8Ar', max_points, max_columns), dtype=float)
    order = np.argsort(table[:, 0], kind='stable')
    energy, i0 = table[order, 0], table[order, 3]
    e0 = AR_K_EV / params.harmonic
    if len(energy) < 8 or np.any(np.diff(energy) <= 0) or energy[0] <= 0:
        _fail('BL8Ar needs at least eight distinct positive energies to fit I0.')
    windows = [(e0 + params.pre1, e0 + params.pre2), (e0 + params.nor1, e0 + params.nor2)]
    if any(lo < energy[0] or hi > energy[-1] or np.count_nonzero((energy >= lo) & (energy < hi)) < 4
           for lo, hi in windows):
        _fail('BL8Ar fit ranges need at least four points each and must lie within the scan. '
              'Configure the pre/post-edge ranges in the plugin registry, then reinspect.', 'bl8ar_fit_range')
    fit = Group()
    # normalize.tmpl uses bkg_nnorm - 1, so two native terms mean degree 1.
    # Larch's edge_step is positive, including for a falling I0 edge; retain
    # this native Larch behavior and report the sign of the fitted jump too.
    pre_edge(energy, i0, group=fit, e0=e0, nnorm=1, pre1=params.pre1, pre2=params.pre2,
             norm1=params.nor1, norm2=params.nor2)
    step = float(fit.edge_step)
    if not np.isfinite(step) or not all(np.isfinite(getattr(fit, k)).all() for k in ['pre_edge', 'post_edge']):
        _fail('BL8Ar could not determine a finite I0 edge step.', 'bl8ar_fit_failed')
    corrected = table.copy()
    corrected[table[:, 0] > e0, 3] -= step
    corrected[:, 5] *= channels
    if not np.isfinite(corrected).all():
        _fail('BL8Ar correction overflowed the detector values.', 'upload_nonfinite')
    labels = ['Energy', 'BraggAngle', 'TimeStep', 'I0', 'I1', 'mu']
    if channels > 1:
        labels += [f'SCA{i}' for i in range(channels)]
    converted = (''.join(headers) + f'# Ar K edge step size found in I0 = {step:.3f}\n' +
        '# ' + '   '.join(labels) + '\n' +
        ''.join(''.join(f'{v:10.5E}   ' for v in row) + '\n' for row in corrected)).encode('utf-8')
    sign = float(np.interp(e0, energy, fit.post_edge - fit.pre_edge))
    summary = f'Fitted an I0 step of {step:.6g} at {e0:.6g} eV; subtracted it only above that energy. '
    summary += f'Column 6 keeps the uncorrected absorption × {channels}. '
    if mode == 'ge':
        summary += 'Native fluorescence selects SCA0–SCA3; use columns 7–19 to include all 13 detectors. '
    if sign < 0:
        summary += 'I0 has a falling fitted edge. Native Larch uses a positive step; review the corrected curve carefully. '
    choices = {'transmission': dict(energy_column=0, numerator=[3], denominator=4, mode='transmission', units='eV', data_type='mu')}
    if mode != 'trans':
        choices = {'fluorescence': dict(energy_column=0, numerator=[6, 7, 8, 9], denominator=3,
                   mode='fluorescence', units='eV', data_type='mu'), **choices}
    metadata = {'id': 'BL8Ar', 'version': '0.1', 'description': 'SLRI BL8 · Ar correction in I0', 'summary': summary,
        'source_sha256': hashlib.sha256(data).hexdigest(), 'converted_sha256': hashlib.sha256(converted).hexdigest(),
        'original_bytes': len(data), 'converted_bytes': len(converted),
        'configuration': copy.deepcopy({k: configuration[k] for k in ['values', 'version', 'session_id']}),
        'conversion': {'mode': mode, 'channels': channels, 'ar_k_ev': AR_K_EV, 'edge_energy': e0,
            'step_size': step, 'signed_fit_jump': sign, 'post_edge_degree': 1, 'pre_range': windows[0],
            'post_range': windows[1], 'source_points': len(table), 'output_points': len(table), 'significant_digits': 6},
        'review_required': params.plot}
    traces = [preview_trace(energy, y, label=label, role=role, ident=role) for y, label, role in [
        (i0, 'Original I0', 'original'), (fit.pre_edge, 'Pre-edge fit', 'pre'),
        (fit.post_edge, 'Post-edge fit', 'post'), (corrected[order, 3], 'Corrected I0', 'corrected')]]
    return PreparedFile(converted, metadata, 3, 4, suggestions=choices, column_units={0: 'eV'},
        preview={'traces': traces, 'points': len(table), 'edge_energy': e0, 'step_size': step,
                 'pre_range': windows[0], 'post_range': windows[1]})
