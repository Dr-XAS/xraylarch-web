"""Native B18 and BM23 column cleanup before Larch import and live preview."""
import hashlib
import math
import re
from dataclasses import replace

from .athena_file_plugins import PreparedFile, PreparedCollection, _fail, _prepared, _rows
from .parsing import _validate_tabular_text, _tabular_rows


def _text(data, name):
    if b'\0' in data:
        _fail(f'{name} text contains binary NUL bytes.', 'upload_binary')
    return data.decode('utf-8-sig')


def b18(data, max_points, max_columns):
    # Native fix skips odd-numbered non-comment lines only with Ifeffit.
    # With Larch it strips indentation/tabs and retains every observation.
    text = _text(data, 'B18')
    converted = ''.join(line if line.startswith('#') else re.sub(r'^\s+', '', line.replace('\t', ' '))
                        for line in text.splitlines(keepends=True)).encode()
    _validate_tabular_text(converted, '.dat', max_points=max_points, max_columns=max_columns)
    rows = [row for row in _tabular_rows(converted.decode(), '.dat') if row and all(_numeric(v) for v in row)]
    if not rows:
        _fail('B18 contains no observations.', 'upload_empty')
    count = len(rows[0])
    choices = {}
    if count >= 43:
        choices['fluorescence'] = dict(energy_column=0, numerator=list(range(7,43)), denominator=2,
            mode='fluorescence', units='eV', data_type='mu')
    summary = 'Retained every measurement with Larch. The native detector suggestion sums columns 8–43 and divides by column 3, without a logarithm.'
    if not choices:
        summary += ' This file has fewer than 43 columns; select its detector columns manually in the preview.'
    metadata = dict(id='B18', version='0.1', description='Diamond B18 · Core XAFS', summary=summary,
        source_sha256=hashlib.sha256(data).hexdigest(), converted_sha256=hashlib.sha256(converted).hexdigest(),
        original_bytes=len(data), converted_bytes=len(converted),
        conversion=dict(source_points=len(rows), output_points=len(rows), columns=count, decimated=False, backend='larch'))
    return PreparedFile(converted, metadata, 7, 2, suggestions=choices)


def _numeric(value):
    try:
        float(value)
        return True
    except ValueError:
        return False


def _bm23_table(data, lines, max_points, max_columns, ordinal):
    boundaries = [i for i,line in enumerate(lines) if line.startswith('#L')]
    if len(boundaries) != 1:
        _fail('BM23 needs one #L column declaration for each scan.')
    start = boundaries[0]
    if any(line.strip() and not line.startswith('#') and _numeric(line.split()[0]) for line in lines[:start]):
        _fail('BM23 has observations before its column declaration.')
    raw = [line for line in lines[start+1:] if line.strip() and not line.startswith('#') and not re.fullmatch(r'\s*-+\s*',line)]
    if not raw:
        _fail('BM23 contains no observations.', 'upload_empty')
    count = len(raw[0].split())
    label_line = lines[start][2:].strip()
    labels = re.split(r'\s{2,}|\t+', label_line)
    if len(labels) != count:
        labels = label_line.split()
    if len(labels) != count:
        _fail('BM23 column labels disagree with the observation width.')
    labels = [re.sub(r'\s+', '_', label) for label in labels]
    declarations = re.findall(r'^#N\s+(\d+)\s*$', '\n'.join(lines[:start]), re.M)
    if declarations and (len(declarations) != 1 or int(declarations[0]) != count):
        _fail('BM23 #N and observation column counts disagree.')
    rows = _rows(raw, count, 'BM23', max_points, max_columns)
    for row in rows:
        # Perl's default scalar stringification uses 15 significant digits.
        row[0] = format(float(row[0])*1000, '.15g')
        if not math.isfinite(float(row[0])):
            _fail('BM23 energy conversion produces non-finite values.', 'upload_nonfinite')
    choices = {'transmission': dict(energy_column=0, numerator=[2], denominator=3,
                mode='transmission', units='eV', data_type='mu')} if count >= 4 else {}
    scan = next((re.match(r'^#S\s+(\S+)\s*(.*)', line) for line in reversed(lines[:start]) if re.match(r'^#S\s', line)), None)
    metadata = dict(id='BM23', version='0.1', description='ESRF BM23',
        summary='Converted the first energy column from keV to eV and cleaned the SPEC header. Transmission uses ln(abs(column 3 / column 4)).',
        conversion=dict(source_points=len(rows), output_points=len(rows), energy_factor=1000, source_energy_units='keV', output_energy_units='eV', source_columns=labels))
    if not choices:
        metadata['summary'] += ' Fewer than four columns are present; choose the signal manually.'
    if scan:
        metadata['scan'] = dict(ordinal=ordinal, number=scan[1], command=scan[2], points=len(rows))
    result = _prepared(data, [line for line in lines[:start] if not re.search(r'-+$',line) and not re.search(r'N\s+\d+',line)],
                       labels, rows, metadata, 2, 3, suggestions=choices)
    # Original labels can still say keV. The converted axis is eV even if
    # this reduced table lacks the native four-column detector suggestion.
    return replace(result, column_units={0: 'eV'})


def bm23(data, max_points, max_columns):
    lines = _text(data, 'BM23').splitlines()
    starts = [i for i,line in enumerate(lines) if re.match(r'^#S\s', line)]
    if len(starts) < 2:
        return _bm23_table(data, lines, max_points, max_columns, 1)
    # A SPEC file may contain several independent scans; preserve the existing
    # scan chooser instead of concatenating separate energy sweeps.
    scans = []; remaining = max_points
    for ordinal, (start, stop) in enumerate(zip(starts, starts[1:]+[len(lines)]),1):
        scan = _bm23_table(data, lines[:starts[0]]+lines[start:stop], remaining, max_columns, ordinal)
        remaining -= scan.metadata['conversion']['output_points']; scans.append(scan)
    return PreparedCollection(scans, dict(id='BM23', version='0.1', description='ESRF BM23 · SPEC scans',
        summary=f'Found {len(scans)} BM23 scans. Preview each scan before selecting detector columns.',
        source_sha256=hashlib.sha256(data).hexdigest(), original_bytes=len(data), scan_count=len(scans),
        total_points=max_points-remaining, skipped_scans=[]))
