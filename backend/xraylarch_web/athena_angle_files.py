"""Native SRS/DUBBLE detector records and PF Bragg-angle conversions."""
import math
import re

from .athena_file_plugins import _fail, _prepared, _rows


def _text(data, reader):
    if b'\0' in data:
        _fail(f'{reader} text contains binary NUL bytes.', 'upload_binary')
    return data.decode('utf-8-sig').splitlines()


def _energy(angle, d_spacing, hc, reader):
    if not math.isfinite(angle) or not 0 < angle < 90:
        _fail(f'{reader} needs Bragg angles between 0 and 90 degrees.')
    divisor = 2 * d_spacing * math.sin(angle * math.pi / 180)
    if not math.isfinite(divisor) or divisor <= 0:
        _fail(f'{reader} angle and D spacing cannot produce a finite energy.', 'upload_nonfinite')
    energy = hc / divisor
    if not math.isfinite(energy) or energy <= 0:
        _fail(f'{reader} angle conversion produced invalid energy.', 'upload_nonfinite')
    return energy


def srs(data, max_points, max_columns, reader='SRS'):
    lines = _text(data, reader)
    boundaries = [i for i, line in enumerate(lines) if re.fullmatch(r'\s*&END\s*', line)]
    if len(boundaries) != 1:
        _fail(f'{reader} needs one &END header boundary.')
    start = boundaries[0]
    headers = lines[:start + 1]
    is_dubble = any('dubble' in line for line in headers)
    comments = []; records = []; record = None; continuation = []; widths = None
    energy_labels = None; terminator = None

    def finish():
        nonlocal record, continuation, widths
        if record is None:
            return
        if widths is None:
            widths = continuation[:]
        if continuation != widths or any(n != 4 for n in continuation[:-1]):
            _fail(f'{reader} has incomplete or inconsistent multi-element detector records.')
        records.append(record)
        if len(records) > max_points:
            _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
        record = None; continuation = []

    for line in lines[start + 1:]:
        if not line.strip():
            continue
        if re.match(r'^\s*(?:END\b|DATA\s+ABORTED\b)', line, re.I):
            terminator = line.strip()
            break
        if re.match(r'^\s*C(?:\s|[-])', line):
            comments.append(line)
            if re.match(r'^\s*C\s+ENERGY\s+TIME\b', line, re.I):
                if record is not None or records or energy_labels is not None:
                    _fail(f'{reader} has a repeated or misplaced ENERGY column declaration.')
                energy_labels = line.split()[1:]
            continue
        fields = line.split()
        if energy_labels is not None:
            if len(fields) != len(energy_labels):
                _fail(f'{reader} ENERGY records disagree with their declared columns.')
            records.append(fields)
            if len(records) > max_points:
                _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
        elif len(fields) == 6:
            finish(); record = fields
        elif record is not None and 1 <= len(fields) <= 4:
            record.extend(fields); continuation.append(len(fields))
            if len(record) > max_columns:
                _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
        else:
            _fail(f'{reader} needs six scalar values followed by four-column detector continuation lines.')
    finish()
    if not records:
        _fail(f'{reader} contains no observations.', 'upload_empty')
    count = len(records[0]); channels = 0 if energy_labels else count - 6
    rows = _rows((' '.join(row) for row in records), count, reader, max_points, max_columns)
    labels = ([label.lower() for label in energy_labels] if energy_labels else
              ['energy', 'time', 'i0', 'it', 'if', 'im'] +
              [f'{"med" if reader == "DUBBLE" else "g"}{i+1}' for i in range(channels)])
    if energy_labels:
        if count < 4 or labels[:2] != ['energy', 'time']:
            _fail(f'{reader} needs ENERGY, TIME and detector columns.')
        if any(float(row[0]) <= 0 for row in rows):
            _fail(f'{reader} ENERGY values must be positive.')
    else:
        for row in rows:
            row[0] = format(_energy(float(row[0]) / 1000, 3.13543, 2 * math.pi * 1973.27053324, reader), '.4f')
    base = dict(energy_column=0, units='eV', data_type='mu')
    if channels:
        # Native SRS/DUBBLE force their MED fluorescence selection even when
        # suggest('transmission') is requested. Keep all other channels for editing.
        if reader == 'DUBBLE':
            selected = list(range(7, 15))
        elif is_dubble:
            selected = [7, 8, 9, 10, 11, 12, 14]
        elif channels == 32:
            selected = [i-1 for i in [7,9,10,11,12,13,14,15,16,17,18,19,24,25,30,31,32,33]]
        else:
            selected = [6, 7, 8]
        suggestions = ({'fluorescence': dict(base, numerator=selected, denominator=2, mode='fluorescence')}
                       if max(selected) < count else {})
    else:
        suggestions = {'transmission': dict(base, numerator=[2], denominator=3, mode='transmission')}
    summary = ('Read the explicitly labelled ENERGY column directly; retained the encoder and detector columns.' if energy_labels else
               f'Converted millidegrees to energy with Si(111) d = 3.13543 Å; joined {channels} detector channels per observation.')
    metadata = {'id': reader, 'version': '0.1', 'description': 'ESRF DUBBLE' if reader == 'DUBBLE' else 'Daresbury SRS',
        'summary': summary, 'conversion': {'source_axis': 'energy_eV' if energy_labels else 'millidegrees',
            'd_spacing': None if energy_labels else 3.13543, 'hc': None if energy_labels else 2 * math.pi * 1973.27053324,
            'energy_decimal_places': None if energy_labels else 4, 'detector_channels': channels,
            'continuation_widths': widths or [], 'source_points': len(rows), 'output_points': len(rows),
            'offsets_applied': False, 'terminator': terminator, 'dubble_header': is_dubble}}
    if not energy_labels:
        metadata['mono'] = {'name': 'Si(111)', 'd_spacing': 3.13543}
    return _prepared(data, [*headers, *comments], labels, rows, metadata, 2, 3, suggestions=suggestions)


def pfbl12c(data, max_points, max_columns):
    lines = _text(data, 'PFBL12C')
    boundaries = [i for i, line in enumerate(lines) if re.match(r'^\s+offset\b', line, re.I)]
    if len(boundaries) != 1:
        _fail('PFBL12C needs one Offset boundary before its angle and detector records.')
    start = boundaries[0]
    spacings = re.findall(r'\bD\s*=\s*([-+\d.eE]+)\s+A\b', '\n'.join(lines[:start]), re.I)
    try:
        # Native starts with 2D=1 and replaces it at every matching header.
        # Retain that fallback and last-header precedence, visibly, rather
        # than refusing an input that Athena can convert.
        d = float(spacings[-1]) if spacings else .5
    except ValueError:
        _fail('PFBL12C monochromator D spacing must be numeric.')
    if not math.isfinite(d) or d <= 0:
        _fail('PFBL12C monochromator D spacing must be positive and finite.')
    observations = []
    for line in lines[start+1:]:
        if '\x1a' in line:
            break  # Native DOS EOF marker terminates the observation section.
        if line.strip():
            observations.append(line)
    count = len(observations[0].split()) if observations else 0
    if count < 5:
        _fail('PFBL12C needs two angles, time and at least two detector columns.')
    rows = _rows(observations, count, 'PFBL12C', max_points, max_columns)
    for row in rows:
        row[:2] = [format(_energy(float(v), d, 12398.52, 'PFBL12C'), '.3f') for v in row[:2]]
        row[2:] = [format(float(v), '.2f' if i == 0 else '.3f') for i, v in enumerate(row[2:])]
    labels = ['energy_requested', 'energy_attained', 'time', 'i0', 'i1'] + [f'detector_{i}' for i in range(3, count-2)]
    # A leading raw KEK-PF signature makes Larch reassign angle_drive/read
    # labels and degree units. Identify the converted table before retaining
    # the original header so ordinary Larch reading uses the new energy labels.
    return _prepared(data, ['PFBL12C converted energy table (eV)', *lines[:start+1]], labels, rows,
        {'id': 'PFBL12C', 'version': '0.3', 'description': 'Photon Factory / SPring-8 / SAGA / Aichi',
         'summary': ('Converted requested and attained Bragg angles. The preview uses attained energy. Detector offsets remain unapplied, as in Athena. '
                     + ('Used the last D spacing from the header.' if spacings else
                        'Mono spacing is absent: Athena’s fallback 2d = 1 Å was used. Check the energy axis before importing.')),
         'mono': {'d_spacing': d},
         'conversion': {'source_axis': 'degrees', 'd_spacing': d, 'd_spacing_origin': 'header' if spacings else 'native_default',
             'header_d_spacings': spacings, 'hc': 12398.52, 'energy_decimal_places': 3,
             'time_decimal_places': 2, 'detector_decimal_places': 3, 'offsets_applied': False,
             'source_points': len(rows), 'output_points': len(rows)}}, 3, 4,
        suggestions={'transmission': dict(energy_column=1, numerator=[3], denominator=4, mode='transmission', units='eV', data_type='mu')})
