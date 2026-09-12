"""Literal SpecFileLongLine is/fix contract from the pinned Demeter reader."""
import hashlib

from .athena_file_plugins import PreparedFile, _rows


def _lines(data):
    parts = data.split(b'\n')
    return [part + b'\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def recognize(data):
    # Perl reads bytes including the newline and stops at the first #L or
    # non-comment line. A later long label cannot change that decision.
    for line in _lines(data):
        if not line.startswith(b'#'):
            break
        if line.startswith(b'#L'):
            return len(line) > 254
    return False


def spec_long(data, max_points, max_columns):
    converted = b''.join(line for line in _lines(data) if not line.startswith(b'#L'))
    lines = converted.decode('utf-8').splitlines()
    observations = [line for line in lines if line.strip() and not line.startswith('#')]
    count = len(observations[0].split()) if observations else 0
    rows = _rows(observations, count, 'SpecFileLongLine', max_points, max_columns)
    suggestions = {'transmission': dict(energy_column=0, numerator=[55], denominator=56,
        mode='transmission', units='eV', data_type='mu')} if count >= 57 else {}
    return PreparedFile(converted, {
        'id': 'SpecFileLongLine', 'version': '0.1', 'description': 'SPEC · long column label line',
        'summary': 'Removed long SPEC labels; all observation bytes are unchanged. ' +
            ('Native transmission uses columns 56 / 57.' if suggestions else
             'The native columns 56 / 57 are absent. Select detector columns and check the curve.'),
        'source_sha256': hashlib.sha256(data).hexdigest(), 'converted_sha256': hashlib.sha256(converted).hexdigest(),
        'original_bytes': len(data), 'converted_bytes': len(converted),
        'conversion': {'removed_label_lines': sum(line.startswith(b'#L') for line in _lines(data)),
                       'source_points': len(rows), 'output_points': len(rows)}}, 55, 56,
        suggestions=suggestions, column_units={0: 'eV'})
