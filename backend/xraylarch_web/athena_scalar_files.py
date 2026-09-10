"""CMC dark-current, CLS scalar-column and LNLS timestamp adapters."""
import math
import re
import shlex

from .athena_file_plugins import _fail, _prepared, _rows


def _lines(data, reader):
    if b'\0' in data:
        _fail(f'{reader} text contains binary NUL bytes.', 'upload_binary')
    return data.decode('utf-8-sig').splitlines()


def _diagnostic():
    return {'count': 0, 'first_positions': [], 'truncated': False}


def _record(diagnostic, row, column):
    diagnostic['count'] += 1
    if len(diagnostic['first_positions']) < 32:
        diagnostic['first_positions'].append(dict(row=row, column=column))
    else:
        diagnostic['truncated'] = True


def _suggestions(count, numerator=1, denominator=2, fluorescence=(4,), default='transmission', only=None):
    choices = {}
    for mode in ([default] + [m for m in ['transmission','fluorescence'] if m != default]):
        if only and mode != only:
            continue
        num, den = ([numerator], denominator) if mode == 'transmission' else (list(fluorescence), 1)
        if num and max(0, den, *num) < count:
            choices[mode] = dict(energy_column=0, numerator=num, denominator=den, mode=mode, units='eV', data_type='mu')
    return choices


def cmc(data, max_points, max_columns):
    lines = _lines(data, 'CMC')
    boundaries = [i for i, line in enumerate(lines) if re.match(r'^#L\s', line)]
    if len(boundaries) != 1:
        _fail('CMC needs one #L column declaration per input table.')
    start = boundaries[0]
    if any(line.strip() and not line.startswith('#') for line in lines[:start]):
        _fail('CMC has observations before its column declaration.')
    observations = [line for line in lines[start+1:] if line.strip() and not line.startswith('#')]
    if not observations:
        _fail('CMC contains no observations.', 'upload_empty')
    if len(observations) > max_points:
        _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
    count = len(observations[0].split())
    # Native CMC removes nuisance PVs. Bound the raw table separately from
    # retained columns, including when a caller sets the exact output limit.
    if count > max(64, max_columns * 4):
        _fail('CMC source table exceeds the bounded auxiliary-column limit.', 'upload_too_many_columns')
    text = re.sub(r'^#L\s+', '', lines[start]).strip()
    labels = re.split(r'\s{2,}|\t+', text)
    if len(labels) != count:
        labels = text.split()
    if len(labels) != count:
        _fail('CMC column labels disagree with the observation width.')
    declarations = re.findall(r'^#N\s+(\d+)\s*$', '\n'.join(lines[:start]), re.M)
    if declarations and (len(declarations) != 1 or int(declarations[0]) != count):
        _fail('CMC #N and observation column counts disagree.')
    keep = [i for i, label in enumerate(labels) if re.fullmatch(r'energy|i[0-2]|iref|lytle|mca\d+', label, re.I)]
    if not keep:
        _fail('CMC has no recognized energy or detector columns.')
    if len(keep) > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    raw = []; source_nonfinite = _diagnostic()
    for row_number, line in enumerate(observations, 1):
        fields = line.split()
        try:
            values = [float(field) for field in fields]
        except ValueError:
            _fail('CMC has a damaged numeric observation after its column declaration.')
        if len(values) != count:
            _fail(f'CMC observations must contain {count} source columns.')
        for i, value in enumerate(values):
            if not math.isfinite(value): _record(source_nonfinite, row_number, i+1)
        raw.append(values)
    if any(not math.isfinite(row[-1]) for row in raw):
        _fail('CMC integration times must be finite.', 'upload_nonfinite')
    # Native recognition is case-insensitive, but matching offset names and
    # subtracting from lower-case i0/i1/i2 are case-sensitive. Keep that
    # distinction explicit instead of silently changing measured counts.
    offsets = {label: i for i, label in enumerate(labels) if re.fullmatch(r'i[0-2]off', label, re.I)}
    dark = {}; missing = []
    for i in keep:
        key = labels[i]
        if re.fullmatch(r'i[0-2]', key, re.I):
            off = next((index for label, index in offsets.items() if key in label), None)
            if off is None:
                dark[key] = 0.0; missing.append(key)
            else:
                if raw[0][-1] == 0:
                    _fail('CMC needs a nonzero first integration time to determine dark current.')
                dark[key] = (raw[0][i] - raw[0][off] * raw[0][-1]) / raw[0][-1]
    corrected = {key for key in dark if re.fullmatch(r'i[0-2]', key)}
    uncorrected_case = [key for key in dark if key not in corrected]
    rows = []; replacements = _diagnostic()
    for row_number, (fields, values) in enumerate(zip(observations, raw, strict=True), 1):
        tokens = fields.split(); row = []
        for index in keep:
            key = labels[index]
            value = values[index] - dark[key] * values[-1] if key in corrected else values[index]
            if math.isnan(value):
                _record(replacements, row_number, index+1); row.append('0')
            elif not math.isfinite(value):
                _fail('CMC retained or corrected detector values are not finite.', 'upload_nonfinite')
            else:
                row.append(format(value, '.15g') if key in corrected else tokens[index])
        rows.append(row)
    notes = [line for line in lines if line.startswith('#')]
    notes.append('Dark current (counts/s): ' + ', '.join(f'{k}={v:.15g}' for k,v in dark.items()))
    summary = 'Selected native energy/detector columns and subtracted the first-point dark-current rate multiplied by each observation’s integration time.'
    if missing:
        summary += ' Missing offset columns: ' + ', '.join(missing) + '; those counts remain unchanged.'
    if uncorrected_case:
        summary += ' Native case-sensitive correction leaves ' + ', '.join(uncorrected_case) + ' unchanged.'
    if replacements['count']:
        summary += f' Replaced {replacements["count"]} NaN detector values with zero, as in Athena. Review the preview.'
    return _prepared(data, ['CMC converted scalar table', *notes], [labels[i] for i in keep], rows,
        {'id':'CMC','version':'0.1','description':'APS 9BM · CMC-XOR','summary':summary,
         'conversion': {'source_columns': labels, 'source_column_indices': keep,
             'omitted_column_indices': [i for i in range(count) if i not in keep],
             'source_points': len(rows), 'output_points': len(rows), 'time_source_index': count-1,
             'dark_currents_counts_per_second': {k:v if math.isfinite(v) else None for k,v in dark.items()},
             'missing_offset_columns': missing, 'uncorrected_case_columns': uncorrected_case,
             'offsets_applied': bool(corrected.difference(missing)),
             'nan_replacements': replacements, 'source_nonfinite': source_nonfinite}}, 1,2,
        suggestions=_suggestions(len(keep), fluorescence=(6,7,8,9,10,12)))


def hxma(data, max_points, max_columns):
    lines = _lines(data, 'HXMA'); headers = []; observations = []; source_labels = None; beamline = ''
    for line in lines:
        if not line.strip():
            continue
        if line.startswith('#'):
            if observations:
                # Native ignores comments after observations; keep them as
                # provenance without letting them remap an in-flight table.
                headers.append(line); continue
            headers.append(line)
            if 'BL1606-B' in line: beamline = 'SXRMB'
            elif 'BL1606-I' in line: beamline = 'HXMA'
            if source_labels is None and '"Event-ID"' in line:
                source_labels = re.findall(r'"([^\"]+)"', line)
        else:
            observations.append(re.sub(r',\s*', ' ', line).strip())
    if not observations:
        _fail('HXMA contains no observations.', 'upload_empty')
    count = len(observations[0].split())
    raw = _rows(observations, count, 'HXMA', max_points, max(64, max_columns * 4))
    if source_labels is not None and len(source_labels) != count:
        _fail('HXMA Event-ID headers disagree with the scalar record width.')
    if count < 3:
        _fail('HXMA needs an event identifier, energy and a detector column.')
    if beamline == 'HXMA' and source_labels:
        order = []
        for pv in ['Energy:sp','mcs04:fbk','mcs05:fbk','mcs06:fbk','mcs03:fbk']:
            matches = [i for i,label in enumerate(source_labels) if pv in label]
            if len(matches) != 1:
                _fail(f'HXMA needs one {pv} column in its Event-ID header.')
            order.append(matches[0])
        labels = ['energy','i0','it','ir','lytle']
    else:
        order = list(range(1,count))
        labels = ['energy'] + [f'column_{i+1}' for i in range(1,count-1)]
    if len(order) > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    rows = [[row[i] for i in order] for row in raw]
    return _prepared(data, ['CLS converted scalar table (eV)', *headers], labels, rows,
        {'id':'HXMA','version':'0.1','description':'CLS HXMA / SXRMB',
         'summary': ('Selected Energy:sp, I0, It, Ir and Lytle from the named PV columns.' if beamline=='HXMA' and source_labels else
                     'Removed the leading event identifier and retained the remaining scalar columns. Review the suggested energy and detector columns.'),
         'beamline': {'name':beamline or 'Unspecified CLS beamline'},
         'conversion': {'source_columns':source_labels or [f'column_{i+1}' for i in range(count)],
             'source_column_indices':order, 'omitted_column_indices':[i for i in range(count) if i not in order],
             'source_points':len(rows),'output_points':len(rows),'offsets_applied':False}}, 1,2,
        suggestions=_suggestions(len(order)))


def lnls(data, max_points, max_columns):
    lines = _lines(data, 'LNLS'); header = None; labels = None; rows = []; dates = []; times = []
    for line in lines:
        if not line.strip():
            continue
        if re.match(r'^"Data"\s+"Hora"', line):
            if header is not None or rows:
                _fail('LNLS has a repeated or misplaced Data/Hora header.')
            header = line
            try:
                labels = shlex.split(line)[2:]
            except ValueError:
                _fail('LNLS column labels contain unmatched quotes.')
            labels = [re.sub(r'\s+', '_', label) for label in labels]
            continue
        fields = line.split()
        if len(fields) < 3 or not re.fullmatch(r'\d{2}/\d{2}/\d{2}',fields[0]) or not re.fullmatch(r'\d{2}:\d{2}:\d{2}',fields[1]):
            _fail('LNLS observations need date, time and numeric detector columns.')
        dates.append(fields[0]); times.append(fields[1]); rows.append(fields[2:])
        if len(rows) > max_points:
            _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
    count = len(labels) if labels is not None else len(rows[0]) if rows else 0
    rows = _rows((' '.join(row) for row in rows), count, 'LNLS', max_points, max_columns)
    for row in rows:
        for i,value in enumerate(row):
            # Preserve native isfloat/printf behavior, including its unescaped
            # dot: unsigned simple decimals are rounded, signed/scientific
            # forms that do not match retain their written precision.
            if re.fullmatch(r'\d+.\d+', value): row[i] = format(float(value), '.4f')
    transmission = header is not None and '"Fluorescencia"' not in header
    if labels is None:
        labels = ['energy'] + [f'column_{i+1}' for i in range(1,count)]
    return _prepared(data, ['LNLS converted scalar table (eV)', *([header] if header else [])], labels, rows,
        {'id':'LNLS','version':'0.1','description':'LNLS XAS',
         'summary':'Removed the date/time columns from the numeric table and retained them in source metadata. Native decimal precision and detector suggestions are preserved.',
         'conversion': {'source_column_indices':list(range(2,count+2)), 'omitted_column_indices':[0,1],
             'source_points':len(rows),'output_points':len(rows),'offsets_applied':False,
             'date_values':dates,'time_values':times,'transmission_header':transmission,
             'decimal_format':'Native unsigned decimal pattern → four decimal places; other numeric tokens unchanged'}},1,2,
        suggestions=_suggestions(count, default='transmission' if transmission else 'fluorescence',
                                 only='transmission' if transmission else None))
