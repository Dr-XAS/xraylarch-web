"""Native project-output readers for four simultaneous ion-chamber samples."""
import copy
import hashlib
import re

import numpy as np

from .athena_file_plugins import PreparedProject, _fail, _rows, _prepared
from .athena_plugin_config import TenBMParameters
from .parsing import parse_upload


def header(data):
    lines = data.decode('utf-8-sig').splitlines()
    boundary = next((i for i, line in enumerate(lines) if re.match(r'^\s*-{5}', line)), None)
    return lines, boundary, lines[boundary + 1] if boundary is not None and boundary + 1 < len(lines) else ''


def recognize(data, reader):
    try:
        lines, _, labels = header(data)
    except UnicodeDecodeError:
        return False
    if not lines:
        return False
    if reader == '10BMMultiChannel':
        return bool(re.match(r'^\s*MRCAT_XAFS', lines[0]) and re.search(r'(?:mcs\d{1,2}\s+){7}mcs\d{1,2}', labels))
    return bool(re.match(r'^\s*XDAC', lines[0]) and re.search(r'I01?\s+I02\s+I03\s+I04\s+It1\s+It2\s+It3\s+It4', labels))


def multichannel(data, max_points, max_columns, configuration=None):
    reader = '10BMMultiChannel' if configuration else 'X23A2MultiChannel'
    lines, boundary, labels = header(data)
    # Native headers can contain numeric-leading descriptions ("4 channel
    # ion chambers"). Validate the identified table, then comment its header
    # in a readable copy without misclassifying those descriptions as data.
    source_labels = labels.split()
    rows = _rows(lines[boundary + 2:], len(source_labels), reader, max_points, max_columns)
    table = _prepared(data, [reader + ' source columns', *lines[:boundary]], source_labels, rows, {}, 1, 5)
    parsed = parse_upload(table.data, 'multichannel.dat', max_bytes=len(table.data), max_points=max_points, max_columns=max_columns)
    columns = parsed.inspection().model_dump()['columns']
    ids = [column['column_id'] for column in columns]
    source = np.array([parsed.arrays[key] for key in ids], dtype=float)
    # Demeter Data::sort_data preserves whole detector rows and retains the
    # first row at each energy, dropping subsequent points within 0.001 eV.
    # Its old Larch sort template sorts columns independently; that breaks
    # detector correspondence. Follow the desktop row-preserving algorithm.
    order = np.argsort(source[0], kind='stable')
    retained = []
    for index in order:
        if not retained or source[0, index] - source[0, retained[-1]] > 0.001:
            retained.append(int(index))
    source = source[:, retained]
    energy = source[0]
    if len(energy) < 8:
        _fail('Multi-channel project conversion needs at least eight distinct energy points.')
    p = TenBMParameters.model_validate(configuration['values']).model_dump() if configuration else None
    temperature = '0'; temperature_details = None
    if p and p['temperature_column']:
        edges = [re.search(r'E0\s*=\s*(\d*)', line) for line in lines[1:boundary]]
        edge = next((float(match[1] or 0) for match in reversed(edges) if match), 0)
        positions = np.flatnonzero(energy > edge)
        index = int(positions[0]) if len(positions) else len(energy) - 1
        label = p['temperature_column']
        lookup = {column['name'].lower(): i for i, column in enumerate(columns)}
        if label.lower() in lookup:
            voltage = float(source[lookup[label.lower()], index])
            temperature = f'{int(200 * (voltage / 100000 - 1))}C'
            temperature_details = dict(label=label, row=index, energy=float(energy[index]), edge=edge, voltage=voltage, value=temperature)
    metadata = {'id': reader, 'version': '0.2' if p else '0.1', 'output': 'project',
        'configurable': bool(p),
        'description': 'APS 10BM · four-channel ion chambers' if p else 'NSLS X23A2 · four-channel ion chambers',
        'summary': 'Created four independent transmission samples using their paired I0 and It channels.',
        'source_sha256': hashlib.sha256(data).hexdigest(), 'original_bytes': len(data),
        'detector': {'i0': '4-channel ionization chamber', 'it': '4-channel ionization chamber'},
        'conversion': {'source_columns': labels.split(), 'source_points': len(rows), 'output_points': len(energy),
                       'retained_source_rows': retained, 'temperature': temperature_details,
                       'offsets_applied': False, 'reference_tied': False}}
    if p:
        metadata['configuration'] = copy.deepcopy({k: configuration[k] for k in ('session_id', 'version', 'values')})
        metadata['summary'] += (' Added the summed-It reference.' if p['reference'] else ' Reference import is disabled.')
        metadata['summary'] += ' Per-channel energy shifts are already included in the energy arrays; project shift parameters are zero.'
    else:
        metadata['summary'] += ' The native reader does not import a reference by default.'

    groups = []
    choices = [(f"{p[f'name{i}']} - {temperature}" if p else f'channel {i}',
                [p[f'numer{i}'] if p else i+1], [p[f'denom{i}'] if p else i+5], p[f'eshift{i}'] if p else 0, 'sample')
               for i in range(1, 5)]
    if p and p['reference']:
        choices.append((p['nameref'], [p[f'denom{i}'] for i in range(1, 5)], [p['denomref']], 0, 'reference'))
    for ordinal, (label, numer, denom, shift, role) in enumerate(choices, 1):
        if max(*numer, *denom) > len(source):
            _fail(f'{reader} channel {ordinal} refers to a column beyond this file’s {len(source)} columns.')
        numerator = np.sum(source[np.array(numer) - 1], axis=0)
        denominator = np.sum(source[np.array(denom) - 1], axis=0)
        with np.errstate(divide='ignore', invalid='ignore', over='ignore'):
            mu = np.log(np.abs(numerator / denominator))
            shifted = energy + shift
        if not np.isfinite(mu).all():
            _fail(f'{reader} channel {ordinal} has zero detector counts or non-finite transmission; review its configured columns.', 'upload_nonfinite')
        if not np.isfinite(shifted).all() or np.any(np.diff(shifted) <= 0):
            _fail(f'{reader} channel {ordinal} energy shift produces an invalid energy axis.', 'upload_nonfinite')
        groups.append({'label': label, 'prefix_filename': bool(p), 'energy': shifted.tolist(), 'mu': mu.tolist(),
            'data_type': 'xanes' if p and p['type'] == 'xanes' else 'mu',
            'source': {'file_plugin': copy.deepcopy(metadata), 'channel': ordinal, 'channel_role': role,
                'column_mapping': {'energy': 1, 'numerator': numer, 'denominator': denom, 'log': True},
                'applied_energy_shift': shift, 'column_order': 'group',
                'raw_arrays': {'i0': numerator.tolist(), 'signal': denominator.tolist()},
                'column_arrays': {key: source[i].tolist() for i, key in enumerate(ids)}}})
    return PreparedProject(groups, metadata, '\n'.join(line.strip() for line in lines[:boundary + 2] if line.strip()) if p else '')
