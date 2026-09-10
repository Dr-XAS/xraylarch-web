"""SPEC list-output reader following Demeter's native scan conversion.

Only zapline mono scans are recognized by the pinned SPEC plugin. Unrelated
scan commands are kept in the original file and reported separately.
"""
import hashlib
import math
import re

from .athena_file_plugins import PreparedCollection, _fail, _prepared, _rows


def split_spec(data, max_points, max_columns):
    if b'\0' in data:
        _fail('SPEC text contains binary NUL bytes.', 'upload_binary')
    lines = data.decode('utf-8-sig').splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r'^#S\s', line)]
    if not starts:
        _fail('SPEC contains no scan records.')
    scans = []; skipped = []; total_points = 0
    # Native list conversion retains the file header on the first scan and
    # repeats #F on later scans. Keeping the complete file header in each
    # converted table preserves instrument context without copying raw data.
    file_headers = lines[:starts[0]]
    if any(line.strip() and not line.startswith('#') for line in file_headers):
        _fail('SPEC contains observations before its first scan boundary.')
    for ordinal, start in enumerate(starts):
        end = starts[ordinal + 1] if ordinal + 1 < len(starts) else len(lines)
        marker = re.fullmatch(r'#S\s+(\d+)\s+(.+)', lines[start])
        if marker is None:
            _fail('SPEC has a damaged scan header.')
        number, command = marker.groups()
        if not re.match(r'zapline\s+mono\b', command):
            skipped.append({'number': number, 'ordinal': ordinal + 1, 'command': command,
                            'reason': 'This SPEC reader recognizes zapline mono scans.'})
            continue
        block = lines[start:end]
        if not any(line.strip() and not line.startswith('#') for line in block[1:]):
            skipped.append({'number': number, 'ordinal': ordinal + 1, 'command': command,
                            'reason': 'No recorded observations in this scan.'})
            continue
        label_lines = [i for i, line in enumerate(block) if re.match(r'^#L\s', line)]
        if len(label_lines) != 1:
            _fail(f'SPEC scan {number} needs one #L column-label line.')
        boundary = label_lines[0]
        # SPEC separates labels by two or more spaces so labels may include
        # spaces. Files with single-word labels can also use single spaces.
        label_text = re.sub(r'^#L\s+', '', block[boundary]).strip()
        labels = re.split(r'\s{2,}|\t+', label_text)
        if len(labels) == 1:
            labels = label_text.split()
        labels = [re.sub(r'\s+', '_', label) for label in labels]
        declarations = [re.fullmatch(r'#N\s+(\d+)\s*', line) for line in block[:boundary]]
        counts = [int(match[1]) for match in declarations if match]
        if len(counts) != 1 or counts[0] != len(labels):
            _fail(f'SPEC scan {number} has inconsistent #N and #L column counts.')
        if any(line.strip() and not line.startswith('#') for line in block[:boundary]):
            _fail(f'SPEC scan {number} contains observations before its column labels.')
        observations = [line for line in block[boundary + 1:] if not line.startswith('#')]
        rows = _rows(observations, len(labels), f'SPEC scan {number}', max_points - total_points, max_columns)
        total_points += len(rows)
        for row in rows:
            # Native SPEC::fix scales only the first column by 1000, even
            # when that column is Mon counts rather than the energy axis.
            scaled = float(row[0]) * 1000
            if not math.isfinite(scaled):
                _fail(f'SPEC scan {number} first-column scaling produces non-finite values.', 'upload_nonfinite')
            row[0] = format(scaled, '.15g')
        lookup = {label.lower(): i for i, label in enumerate(labels)}
        zap = lookup.get('zapenergy')
        energy = zap if zap is not None else 12 if len(labels) > 12 else None
        ion1 = lookup.get('ion1', 7); ion2 = lookup.get('ion2', 9)
        detectors = [lookup.get(f'det{i}', i) for i in range(1, 7)]
        suggestions = {}
        if energy is not None and max(energy, ion1, ion2) < len(labels):
            base = dict(energy_column=energy, units='keV', data_type='mu')
            suggestions['transmission'] = dict(base, numerator=[ion1], denominator=ion2, mode='transmission')
            if max(detectors) < len(labels):
                suggestions['fluorescence'] = dict(base, numerator=detectors, denominator=ion1, mode='fluorescence')
        scan = {'number': number, 'ordinal': ordinal + 1, 'command': command,
                'date': next((line[3:].strip() for line in block if line.startswith('#D ')), ''),
                'source_line_start': start + 1, 'source_line_end': end, 'points': len(rows)}
        summary = 'Split this scan from the SPEC file and retained all scalar columns. '
        summary += ('Selected the labelled ZapEnergy column in keV; the native fixed column 13 belongs to a different layout.'
                    if zap is not None and zap != 12 else
                    'Check the suggested energy column and keV units against the preview before importing.')
        metadata = {'id': 'SPEC', 'version': '0.1', 'description': 'ESRF SPEC · multiple scans',
            'summary': summary, 'scan': scan,
            'conversion': {'first_column_multiplier': 1000, 'source_column_indices': list(range(len(labels))),
                           'source_columns': labels, 'source_points': len(rows), 'output_points': len(rows),
                           'native_suggestion_energy_index': 12, 'labelled_energy_index': zap}}
        headers = [*file_headers, *block[:boundary]]
        scans.append(_prepared(data, headers, labels, rows, metadata, 7, 9, suggestions=suggestions))
    if not scans:
        _fail('SPEC contains no supported zapline mono observations.', 'upload_empty')
    return PreparedCollection(scans, {'id': 'SPEC', 'version': '0.1', 'description': 'ESRF SPEC · multiple scans',
        'source_sha256': hashlib.sha256(data).hexdigest(), 'original_bytes': len(data),
        'scan_count': len(scans), 'total_points': total_points, 'skipped_scans': skipped})
