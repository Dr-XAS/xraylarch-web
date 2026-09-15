"""Native NIST Vortex channel selection and iterative deadtime correction."""
import math
import re

from larch.io.columnfile import gformat

from .athena_file_plugins import _fail, _prepared, _rows
from .athena_plugin_config import X23A2MEDParameters


def _header(data):
    lines = data.decode('utf-8-sig').splitlines()
    boundary = next((i for i, line in enumerate(lines[2:], 2) if re.search(r'-{6,}', line)), None)
    if boundary is None or boundary + 1 >= len(lines):
        return lines, None, []
    return lines, boundary, lines[boundary+1].split()


def recognize(data, configuration):
    try:
        lines, _, labels = _header(data)
    except UnicodeDecodeError:
        return False
    if len(lines) < 30 or not labels:
        return False
    text = ' '.join(labels)
    p = X23A2MEDParameters.model_validate(configuration['values'])
    word = lambda value: re.search(r'\b' + re.escape(value) + r'\b', text, re.I)
    return bool(re.search(re.escape(p.energy) + r'\b', text, re.I)
                and (word(p.roi1) or re.search(r'\broi\d_\d\b', text, re.I))
                and word(p.slow1) and word(p.fast1))


def _correct(roi, fast, slow, times, deadtime):
    # This follows X23A2MED::_correct, including its relative convergence
    # comparison against deadtime in seconds, low-fast branch and 20-step cap.
    dt = deadtime * 1e-9
    corrected = []
    maximum = 0
    for r, f, s, integration in zip(roi, fast, slow, times, strict=True):
        if dt <= 1e-9:
            value = r * f / s
        else:
            if integration <= 0:
                _fail('X23A2MED integration times must be positive for deadtime correction.')
            previous = f / integration
            current, test, count = (s, 0, 0) if f <= 1 else (0, 1, 0)
            try:
                while test > dt:
                    current = (f / integration) * math.exp(previous * dt)
                    test = (current - previous) / previous
                    previous = current
                    count += 1
                    if count >= 20: test = 0
            except (OverflowError, ZeroDivisionError):
                _fail('X23A2MED deadtime correction overflowed; check counts, integration time and deadtime.')
            maximum = max(maximum, count)
            value = r * (current * integration / s)
        if not math.isfinite(value):
            _fail('X23A2MED deadtime-corrected values are not finite.', 'upload_nonfinite')
        corrected.append(value)
    return maximum, corrected


def x23a2med(data, max_points, max_columns, configuration):
    if b'\0' in data:
        _fail('X23A2MED text contains binary NUL bytes.', 'upload_binary')
    lines, boundary, source_labels = _header(data)
    if boundary is None or not source_labels:
        _fail('X23A2MED needs its column header after the dashed separator.')
    labels = [label.lower() for label in source_labels]
    if len(set(labels)) != len(labels):
        _fail('X23A2MED column labels must be distinct to identify detector channels.')
    raw = _rows(lines[boundary+2:], len(labels), 'X23A2MED', max_points, max(64, max_columns * 4))
    columns = {label: [float(row[i]) for row in raw] for i, label in enumerate(labels)}
    p = X23A2MEDParameters.model_validate(configuration['values']).model_dump()
    def column(label):
        if label.lower() not in columns:
            _fail(f'X23A2MED cannot find configured column {label}. Configure this reader and inspect the file again.')
        return columns[label.lower()]
    multi = any(re.search(r'roi\d_\d', label) for label in labels)
    represented = [i for i in range(1, 5) if all(p[f'{kind}{i}'].lower() in columns for kind in ('slow', 'fast'))
                   and (multi or p[f'roi{i}'].lower() in columns)]
    if not represented:
        _fail('X23A2MED has no complete ROI/fast/slow detector channels.')
    energy_label = 'energy' if p['energy'] == 'nergy' else p['energy']
    output_labels = [energy_label, p['i0'].lower()]
    output = [column(energy_label), column(p['i0'])]
    times = (column(p['intcol']) if p['time'] == 'column' and any(p[f'dt{i}'] > 1 for i in represented)
             else [p['inttime']] * len(raw))
    channels = []; skipped = []; edge1 = []; edge2 = []
    for i in represented:
        slow = column(p[f'slow{i}']); fast = column(p[f'fast{i}'])
        if any(value == 0 for value in slow):
            skipped.append(i)
            continue
        if multi:
            _, corr1 = _correct(column(f'roi1_{i}'), fast, slow, times, p[f'dt{i}'])
            maximum, corr2 = _correct(column(f'roi2_{i}'), fast, slow, times, p[f'dt{i}'])
            edge1.append((f'c1_{i}', corr1)); edge2.append((f'c2_{i}', corr2))
        else:
            maximum, corr = _correct(column(p[f'roi{i}']), fast, slow, times, p[f'dt{i}'])
            output_labels.append(f'corr{i}'); output.append(corr)
        channels.append({'number': i, 'deadtime_ns': p[f'dt{i}'], 'max_iterations': maximum})
    if not channels:
        _fail('Every X23A2MED slow channel contains zero counts; no corrected detector channel is available.')
    for label, values in [*edge1, *edge2]:
        output_labels.append(label); output.append(values)
    for label in ['diamond', 'it', 'ir', 'iref']:
        if label in columns:
            output_labels.append(label); output.append(columns[label])
    if len(output) > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    count = len(channels)
    suggestions = {'fluorescence': dict(energy_column=0, numerator=list(range(2, count+2)), denominator=1,
                    mode='fluorescence', units='eV', data_type='mu')}
    transmission = 3 if count == 1 else 6
    if transmission < len(output):
        suggestions['transmission'] = dict(energy_column=0, numerator=[1], denominator=transmission,
                    mode='transmission', units='eV', data_type='mu')
    summary = f'Applied native deadtime correction to {count} detector channels. '
    summary += 'Deadtimes: ' + ', '.join(f"detector {c['number']} = {c['deadtime_ns']} ns" for c in channels) + '. '
    summary += (f"Integration time: column {p['intcol']}." if p['time'] == 'column'
                else f"Integration time: constant {p['inttime']:g} s.")
    if skipped:
        summary += ' Omitted whole detector channels containing a zero slow count: ' + ', '.join(map(str, skipped)) + '.'
    if multi: summary += ' Kept both ROI edges; the fluorescence suggestion uses the first edge.'
    if transmission < len(output) and output_labels[transmission] != 'it':
        summary += f' Native transmission suggests {output_labels[transmission]}; check the detector choice in the preview.'
    headers = [f'X23A2MED converted energy table · {count} corrected channels',
        '<MED> Deadtimes (nsec): ' + ' '.join(str(c['deadtime_ns']) for c in channels),
        '<MED> Maximum iterations: ' + ' '.join(str(c['max_iterations']) for c in channels), *lines[:boundary+1]]
    # The pinned Larch template uses write_ascii, whose scalar formatter is
    # gformat(length=14). Use that same Larch formatter in the converted copy.
    rows = [[gformat(value, length=14).strip() for value in row] for row in zip(*output, strict=True)]
    return _prepared(data, headers, output_labels, rows,
        {'id': 'X23A2MED', 'version': '0.2', 'description': 'NIST Vortex · X23A2 / BMM', 'summary': summary,
         'configuration': {key: configuration[key] for key in ('session_id', 'version', 'values')},
         'detector': {'if': f'{count} element Vortex silicon drift', 'med_nchannels': count,
             'med_deadtime': ' '.join(str(c['deadtime_ns']) for c in channels),
             'med_maxiterations': ' '.join(str(c['max_iterations']) for c in channels)},
         'conversion': {'source_columns': source_labels, 'source_points': len(raw), 'output_points': len(raw),
             'channels': channels, 'represented_channels': represented, 'omitted_zero_slow_channels': skipped,
             'multiedge': multi, 'output_labels': output_labels, 'format': 'Larch write_ascii gformat(length=14)',
             'offsets_applied': False}}, 1, transmission, suggestions=suggestions)
