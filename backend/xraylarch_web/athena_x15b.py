"""NSLS X15B binary scalar records and native configurable column selection."""
import math
import re
import struct

from .athena_file_plugins import _fail, _prepared
from .athena_plugin_config import X15BParameters


def x15b(data, max_points, max_columns, configuration):
    params = X15BParameters.model_validate(configuration['values']).model_dump()
    if len(data) < 212:
        _fail('X15B needs its complete 212-byte binary header.')
    size = len(data) - 212
    if not size:
        _fail('X15B contains no observations.', 'upload_empty')
    if size % 64:
        _fail('X15B has an incomplete 64-byte scalar record; no observations were imported.')
    points = size // 64
    if points > max_points:
        _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
    if max_columns < 5:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    labels = ['energy', 'i0', 'narrow', 'wide', 'trans']
    order = [params[label] for label in labels]
    rows = []
    preview = [[] for _ in range(14)]
    nonfinite_count = 0
    nonfinite_positions = []
    for number, record in enumerate(struct.iter_unpack('<16f', data[212:]), 1):
        # Word 0 is the record leader; native parameter columns 1..14 refer
        # to the following scalars. Word 15 is omitted by native configuration.
        selected = [record[index] for index in order]
        if not all(math.isfinite(value) for value in selected):
            _fail('X15B selected columns contain non-finite observations.', 'upload_nonfinite')
        rows.append([format(value, '.4f') for value in selected])
        for index, value in enumerate(record[1:15]):
            if number <= 3: preview[index].append(value if math.isfinite(value) else None)
            if not math.isfinite(value):
                nonfinite_count += 1
                if len(nonfinite_positions) < 32: nonfinite_positions.append(dict(row=number, column=index+1))
    title = re.search(r'(\w+)\s+(\d+/\d+/\d+)', data[:212].decode('latin-1'), re.ASCII)
    project = ' '.join(title.groups()) if title else '??'
    return _prepared(data, [f'X15B converted energy table · project {project}',
        'Unpacked little-endian 4-byte floats; native four-decimal output.',
        'Selected source scalar columns: ' + ', '.join(f'{key}={value}' for key, value in params.items())], labels, rows,
        {'id': 'X15B', 'version': '0.1', 'description': 'NSLS beamline X15B', 'binary': True,
         'summary': 'Read the binary scalar records and selected source columns ' +
             ', '.join(f'{key}={value}' for key, value in params.items()) +
             '. Review the detector curves. Configure X15B in the plugin registry to select other source columns, then inspect the file again.',
         'configuration': {key: configuration[key] for key in ('session_id', 'version', 'values')},
         'beamline': {'name': 'X15B', 'collimation': 'Cylindrical platinum coated Glidcop',
             'focusing': '1:1 focusing platinum coated ULE (silica) toroid', 'harmonic_rejection': 'using collimating mirror'},
         'mono': {'name': 'Si 111, possibly InSb or Beryl'},
         'facility': {'name': 'NSLS', 'xray_source': 'bend magnet'},
         'detector': {'i0': 'He filled ion chamber', 'if': 'single element Ge'},
         'conversion': {'project': project, 'source_points': points, 'output_points': points,
             'header_bytes': 212, 'record_bytes': 64, 'byte_order': 'little', 'decimal_places': 4,
             'source_scalar_indices': [v-1 for v in order], 'record_word_indices': order,
             'omitted_scalar_indices': [i for i in range(14) if i+1 not in order], 'offsets_applied': False,
             'source_columns': [{'number': i+1, 'preview': values} for i, values in enumerate(preview)],
             'source_nonfinite': {'count': nonfinite_count, 'first_positions': nonfinite_positions, 'truncated': nonfinite_count > 32}}},
        1, 4, suggestions={
            'fluorescence': dict(energy_column=0, numerator=[2], denominator=1, mode='fluorescence', units='eV', data_type='mu'),
            'transmission': dict(energy_column=0, numerator=[1], denominator=4, mode='transmission', units='eV', data_type='mu')})
