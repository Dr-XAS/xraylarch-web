"""Athena file adapters: recognize, transform a copy, then read with Larch.

Contracts: registered Demeter Plugins/*.pm at
06afc8da08a5a7d5a26ee14992170fcf5dc67406. Only registered formats are changed.
"""
from dataclasses import dataclass
import hashlib
import math
import re
import struct
from typing import Callable

from .errors import WebInputError
from .athena_zip import PreparedArchive, read_archive, recognize as recognize_zip


@dataclass(frozen=True)
class PreparedFile:
    data: bytes
    metadata: dict
    numerator: int
    denominator: int
    fluorescence: tuple[int, int] | None = None
    suggestions: dict | None = None
    column_units: dict[int, str] | None = None


@dataclass(frozen=True)
class PreparedCollection:
    scans: list[PreparedFile]
    metadata: dict


@dataclass(frozen=True)
class PreparedProject:
    groups: list[dict]
    metadata: dict
    journal: str = ''


def _fail(message, code='upload_malformed_rows'):
    raise WebInputError(code, message, ('file',),
                        'Repair the source file and select it again; no observations were imported.')


def _rows(lines, count, name, max_points, max_columns):
    if count > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    result = []
    for line in lines:
        if not line.strip():
            continue
        # Fortran fixed-width overflow: retain the next value's minus sign.
        fields = re.sub(r'([eE][-+]\d{1,2})-', r'\1 -', line).split()
        try:
            values = [float(field) for field in fields]
        except ValueError:
            _fail(f'{name} contains a damaged observation after its data boundary.')
        if len(values) != count:
            _fail(f'{name} observations must contain {count} columns.')
        if not all(math.isfinite(v) for v in values):
            _fail(f'{name} contains non-finite observations.', 'upload_nonfinite')
        result.append(fields)
        if len(result) > max_points:
            _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
    if not result:
        _fail(f'{name} contains no observations.', 'upload_empty')
    return result


def _prepared(original, headers, labels, rows, metadata, numerator, denominator, fluorescence=None, suggestions=None):
    # Preserve header text in the readable copy; source downloads retain bytes,
    # including original NUL padding. Generated labels follow the native plugin.
    text = '\n'.join(['# ' + line for line in headers] +
                     ['# --------------------', '# ' + ' '.join(labels)] +
                     [' '.join(row) for row in rows]) + '\n'
    data = text.encode('utf-8')
    metadata.update(source_sha256=hashlib.sha256(original).hexdigest(),
                    converted_sha256=hashlib.sha256(data).hexdigest(),
                    original_bytes=len(original), converted_bytes=len(data))
    return PreparedFile(data, metadata, numerator, denominator, fluorescence, suggestions)


def _spec(data, max_points, max_columns):
    from .athena_spec import split_spec
    return split_spec(data, max_points, max_columns)


def _b18(data, max_points, max_columns):
    from .athena_header_files import b18
    return b18(data, max_points, max_columns)


def _bm23(data, max_points, max_columns):
    from .athena_header_files import bm23
    return bm23(data, max_points, max_columns)


def _slribl4(data,max_points,max_columns,calibration):
    from .athena_dispersive import slribl4
    return slribl4(data,max_points,max_columns,calibration)


def _multichannel(data, max_points, max_columns, configuration=None):
    from .athena_multichannel import multichannel
    return multichannel(data, max_points, max_columns, configuration)


def _recognize_multichannel(data, reader):
    from .athena_multichannel import recognize
    return recognize(data, reader)


def _srs(data, max_points, max_columns):
    from .athena_angle_files import srs
    return srs(data, max_points, max_columns)


def _dubble(data, max_points, max_columns):
    from .athena_angle_files import srs
    return srs(data, max_points, max_columns, 'DUBBLE')


def _pfbl12c(data, max_points, max_columns):
    from .athena_angle_files import pfbl12c
    return pfbl12c(data, max_points, max_columns)


def _cmc(data, max_points, max_columns):
    from .athena_scalar_files import cmc
    return cmc(data, max_points, max_columns)


def _hxma(data, max_points, max_columns):
    from .athena_scalar_files import hxma
    return hxma(data, max_points, max_columns)


def _lnls(data, max_points, max_columns):
    from .athena_scalar_files import lnls
    return lnls(data, max_points, max_columns)


def _x15b(data, max_points, max_columns, configuration):
    from .athena_x15b import x15b
    return x15b(data, max_points, max_columns, configuration)


def _x23a2med(data, max_points, max_columns, configuration):
    from .athena_x23a2med import x23a2med
    return x23a2med(data, max_points, max_columns, configuration)


def _recognize_x23a2med(data, configuration):
    from .athena_x23a2med import recognize
    return recognize(data, configuration)


def _x10c(data, max_points, max_columns):
    # The pinned is() loop mistakenly tests $first repeatedly. Follow its POD
    # and fix() contract: EXAFS first line AND a later DATA START marker.
    text = data.replace(b'\0', b'').decode('utf-8-sig')
    lines = text.splitlines()
    boundaries = [i for i, line in enumerate(lines) if re.match(r'^\s+DATA START\b', line, re.I)]
    if len(boundaries) != 1:
        _fail('X10C needs one DATA START boundary after its EXAFS header.')
    start = boundaries[0]
    rows = _rows(lines[start + 1:], 8, 'X10C', max_points, max_columns)
    return _prepared(data, lines[:start + 1], ['energy', '1', '2', '3', '4', '5', '6', '7'], rows,
        {'id': 'X10C', 'version': '0.1', 'description': 'NSLS beamline X10C',
         'summary': 'Removed NUL padding, separated joined negative values, and retained all eight columns. Transmission uses columns 4 / 6.',
         'beamline': {'name': 'X10C', 'collimation': 'none', 'focusing': 'Rhodium coated cylindrically bent mirror',
                      'harmonic_rejection': 'using focusing mirror'},
         'mono': {'name': 'Si 220', 'd_spacing': 1.9201},
         'facility': {'name': 'NSLS', 'xray_source': 'bend magnet'}}, 3, 5)


def _lytle(data, max_points, max_columns):
    if b'\0' in data:
        _fail('Lytle text contains binary NUL bytes.', 'upload_binary')
    lines = [line for line in data.decode('utf-8-sig').splitlines() if line.strip()]
    if len(lines) < 3:
        _fail('Lytle needs monochromator parameters and a data description.')
    fields = lines[1].split()
    try:
        dspace, steps_per_degree = float(fields[4]), float(fields[5])
    except (ValueError, IndexError):
        _fail('Lytle DSPACE and STPDEG must be numeric monochromator parameters.')
    if not all(math.isfinite(v) and v > 0 for v in (dspace, steps_per_degree)):
        _fail('Lytle DSPACE and STPDEG must be positive finite values.')
    start = 2
    while start < len(lines) and re.match(r'^\s*(?:DELTA|DELEND|SEC|OFFSETS?)\s*:', lines[start]):
        start += 1
    # This native layout has one descriptive header before the observation
    # table. Require that boundary instead of swallowing damaged rows as text.
    if start == len(lines) or not re.search(r'[A-Za-z%]', lines[start]):
        _fail('Lytle needs a descriptive header before its encoder/count table.')
    rows = _rows(lines[start + 1:], 5, 'Lytle', max_points, max_columns)
    for row in rows:
        angle = float(row[0]) / steps_per_degree / 57.29577951
        if not 0 < angle < math.pi / 2:
            _fail('Lytle encoder values must give Bragg angles between 0 and 90 degrees.')
        # Use the pinned Athena constants and its emitted six significant
        # digits. Modern hc constants would silently move the native axis.
        energy = 12398.61 / (2 * dspace) / math.sin(angle)
        if not math.isfinite(energy) or not 0 < energy <= 1e7:
            _fail('Lytle encoder conversion produces unsupported energies.')
        row[0] = f'{energy:.5E}'
    return _prepared(data, lines[:start + 1], ['energy', 'i0', 'it', 'if', 'ir'], rows,
        {'id': 'Lytle', 'version': '0.2', 'description': 'Lytle database · encoder data',
         'summary': 'Converted encoder steps to energy using the file’s monochromator settings. Detector counts are unchanged.',
         'conversion': {'d_spacing_angstrom': dspace, 'steps_per_degree': steps_per_degree,
                        'hc_ev_angstrom': 12398.61, 'degrees_per_radian': 57.29577951,
                        'energy_significant_digits': 6}}, 1, 2, (3, 1))


def _ssrl_text(data):
    if b'\0' in data:
        _fail('SSRL text contains binary NUL bytes.', 'upload_binary')
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        # ROBL uses the same collector with Latin-1 copyright/degree symbols.
        text = data.decode('latin-1')
    return text.replace('©', '(c)').replace('°', 'deg').splitlines()


def _ssrl_ascii(data, max_points, max_columns, *, micro=False):
    name = 'SSRLmicro' if micro else 'SSRLA'
    lines = _ssrl_text(data)
    boundaries = [i for i, line in enumerate(lines) if re.match(r'^\s*Data:\s*$', line)]
    if len(boundaries) != 1:
        _fail(f'{name} needs one Data: section followed by column labels and a blank line.')
    start = boundaries[0] + 1
    end = next((i for i in range(start, len(lines)) if not lines[i].strip()), len(lines))
    labels = [re.sub(r'\s+', '_', line.rstrip()) for line in lines[start:end]]
    if len(labels) < (4 if micro else 5) or end == len(lines):
        _fail(f'{name} has an incomplete column-label section.')
    raw_labels = labels.copy()
    if micro:
        labels = [label.replace('.', '_') for label in labels]
        detectors = [i for i, label in enumerate(labels) if not re.search('time|energy', label, re.I)
                     and not re.search('ICR|SCA', label)]
        scalars = [i for i, label in enumerate(labels) if not re.search('time|energy', label, re.I) and 'SCA' in label]
        order = [1, 0, *detectors, *scalars]
    else:
        order = [2, 1, 0, *range(3, len(labels))]
    if len(order) > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    # Validate even ICR columns omitted by the native converter. Each retained
    # fluorescence channel may have one ICR companion in the original table.
    rows = _rows(lines[end + 1:], len(labels), name, max_points, max_columns * (2 if micro else 1))
    dropped = [i + 1 for i, row in enumerate(rows) if not micro and float(row[2]) < .001]
    converted = [[f'{float(row[i]):.4f}' for i in order] for row in rows
                 if micro or float(row[2]) >= .001]
    if not converted:
        _fail(f'{name} contains no observations with achieved energy at least 0.001 eV.', 'upload_empty')
    output_labels = [labels[i].replace('SCA', 'S') if micro else labels[i] for i in order]
    metadata = {'id': name, 'version': '0.1' if micro else '0.2',
        'description': 'SSRL MicroEXAFS Data Collector' if micro else 'SSRL XAFS Data Collector · ASCII',
        'summary': ('Moved energy before the clock and detector columns, retained SCA channels, and omitted ICR channels as Athena does. '
                    'Choose fluorescence columns if no transmission detector was recorded.' if micro else
                    'Moved achieved energy to the first column, followed by requested energy and the clock. Detector offsets are not subtracted.'),
        'conversion': {'source_columns': raw_labels, 'source_column_indices': order,
                       'source_points': len(rows), 'output_points': len(converted), 'decimal_places': 4,
                       'omitted_column_indices': [i for i in range(len(labels)) if i not in order],
                       'omitted_energy_rows': dropped, 'offsets_applied': False}}
    if dropped:
        metadata['summary'] += f' Omitted {len(dropped)} rows below 0.001 eV using Athena’s achieved-energy rule.'
    n, d, fluo = (2, 3, (5, 2)) if micro else (3, 4, (5, 3))
    headers = lines[:start - 1]
    for i, line in enumerate(headers[:-1]):
        if re.match(r'^\s*Offsets\b', line):
            offsets = headers[i + 1].split()
            if len(offsets) == len(labels):
                headers[i + 1] = ' '.join(offsets[j] for j in order)
    # The native suggested fluorescence column is optional in shorter layouts.
    return _prepared(data, headers, output_labels, converted, metadata, n, d,
                     fluo if len(order) > fluo[0] else None)


def _ssrla(data, max_points, max_columns):
    return _ssrl_ascii(data, max_points, max_columns)


def _ssrlmicro(data, max_points, max_columns):
    return _ssrl_ascii(data, max_points, max_columns, micro=True)


def _ssrlb(data, max_points, max_columns):
    if len(data) < 800:
        _fail('SSRL binary header is truncated.')
    title = data[:40].replace(b'\0', b'').decode('ascii', errors='replace').strip()
    version_match = re.match(r'^\s*SSRL\s+-\s+EXAFS Data Collector\s+(\d+\.\d+)', title)
    if version_match is None:
        _fail('SSRL binary header needs its Data Collector version.')
    version = float(version_match[1])
    shape = re.fullmatch(rb'\s*PTS:\s*(\d+)\s+COLS:\s*(\d+)\s*', data[80:120].replace(b'\0', b''))
    if shape is None:
        _fail('SSRL binary header needs integer PTS and COLS counts.')
    npts, ncol = map(int, shape.groups())
    if npts < 1 or ncol < 5:
        _fail('SSRL binary needs observations and at least five collector columns.')
    if npts > max_points:
        _fail(f'Upload exceeds the {max_points} point limit.', 'upload_too_many_points')
    if ncol > max_columns:
        _fail(f'Upload exceeds the {max_columns} column limit.', 'upload_too_many_columns')
    offset = 800 + 28 * ncol + 16
    stop = offset + 4 * npts * ncol
    if len(data) < stop:
        _fail('SSRL binary observation table is truncated; its PTS/COLS counts exceed the available bytes.')
    # Fixed-size records may include unused trailing NUL padding, as the
    # official 1.1 fixture does. A nonzero suffix is not silently discarded.
    if any(data[stop:]):
        _fail('SSRL binary has unexpected nonzero data after the declared observations.')
    recorded = struct.unpack_from('<I', data, offset - 16)[0]
    if recorded != npts:
        _fail('SSRL binary point counts disagree between its header and data record.')
    headers = []; pos = 0
    for size in [40] * 5 + [80, 40] + [80] * 6:
        headers.extend(data[pos:pos + size].replace(b'\0', b'').decode('latin-1').rstrip().splitlines())
        pos += size
    # Match native header presentation; these diagnostics are never applied
    # to detector counts (the legacy collector uses different float ordering).
    for label in ['Offsets', 'Weights']:
        values = struct.unpack_from(f'<{ncol}f', data, pos); pos += 4 * ncol
        headers.append(label + ': ' + ' '.join(f'{v:.3f}' for v in values))
    labels = []
    for i in range(ncol):
        raw = data[pos + i * 20:pos + (i + 1) * 20].replace(b'\0', b'').decode('latin-1').rstrip()
        if not raw.strip():
            _fail('SSRL binary contains an empty column label.')
        labels.append(re.sub(r'\s+', '_', raw))
    order = [2, 1, 0, *range(3, ncol)]
    rows = []
    for pos in range(offset, stop, ncol * 4):
        record = data[pos:pos + ncol * 4]
        if version < 2:
            record = b''.join(record[i + 2:i + 4] + record[i:i + 2] for i in range(0, len(record), 4))
        values = struct.unpack(f'<{ncol}f', record)
        if not all(math.isfinite(v) for v in values):
            _fail('SSRL binary contains non-finite observations.', 'upload_nonfinite')
        rows.append([f'{values[i] / (4 if version < 2 else 1):.3f}' for i in order])
    return _prepared(data, headers, [labels[i] for i in order], rows,
        {'id': 'SSRLB', 'version': '0.2', 'description': 'SSRL XAFS Data Collector · binary', 'binary': True,
         'summary': f'Decoded Data Collector {version_match[1]} binary records and moved achieved energy to the first column. '
                    'Detector offsets are not subtracted. The original binary file remains available below.',
         'conversion': {'collector_version': version_match[1], 'source_columns': labels, 'source_column_indices': order,
                        'source_points': npts, 'output_points': npts, 'decimal_places': 3,
                        'legacy_word_swap': version < 2, 'trailing_padding_bytes': len(data) - stop, 'offsets_applied': False}},
        3, 4, (5, 3) if ncol > 5 else None)


@dataclass(frozen=True)
class FilePlugin:
    name: str
    version: str
    description: str
    documentation: str
    signature: re.Pattern
    transform: Callable[..., PreparedFile | PreparedCollection | PreparedProject | PreparedArchive]
    recognize: Callable[[bytes], bool] | None = None
    configurable: bool = False
    configured_recognize: Callable[[bytes, dict], bool] | None = None

    @property
    def ident(self):
        return 'Demeter::Plugins::' + self.name


# Sorted registry mirrors the documented check order. The pinned desktop
# displays a sorted list but checks directory enumeration order.
# DUBBLE precedes generic SRS when both are enabled; either can read its SRS
# records. User/system extension discovery remains separate work.
_PLUGINS = (
    FilePlugin('10BMMultiChannel', '0.2', 'APS 10BM · four-channel ion chambers',
        'Converts the four paired ion-chamber channels into a project for group preview and selection. '
        'Configure column numbers, names, per-channel energy shifts, temperature and the optional summed '
        'reference. Applied shifts are included in the energy arrays; the resulting shift parameter is zero.',
        re.compile(rb'^\s*MRCAT_XAFS'), _multichannel,
        lambda data: _recognize_multichannel(data, '10BMMultiChannel'), configurable=True),
    FilePlugin('B18', '0.1', 'Diamond B18 · Core XAFS',
        'Cleans tabs and indentation and retains all measurements with Larch. The native default '
        'sums the 36 detector columns 8–43 and divides by column 3 without a logarithm. '
        'Review or change the selected detector channels in the live column preview.',
        re.compile(rb'.*Diamond'), _b18,
        lambda data: len(data.splitlines()) > 1 and b'B18-CORE XAS' in data.splitlines()[1]),
    FilePlugin('BM23', '0.1', 'ESRF BM23',
        'Cleans SPEC labels and converts the first column from keV to eV. The native transmission '
        'suggestion is ln(abs(column 3 / column 4)). Multiple scans open in the scan chooser; '
        'review detector columns and the converted energy axis before import.',
        re.compile(rb'(?=.*BM23)(?=.*E\.S\.R\.F\.).*'), _bm23),
    FilePlugin('CMC', '0.1', 'APS 9BM · CMC-XOR',
        'Selects native energy, ion-chamber, Lytle and MCA columns. Derives dark-current rates from the first '
        'observation and offset columns, then subtracts rate times each integration time. Native NaN-to-zero '
        'replacements are reported. Check the preview and select XANES for scans too short for EXAFS.',
        re.compile(rb'.*'), _cmc, lambda data: len(data.splitlines())>3 and re.match(rb'^#C.+(?:bmexafs|9bmuser)',data.splitlines()[3]) is not None),
    FilePlugin('DUBBLE', '0.1', 'ESRF DUBBLE',
        'Reads SRS records identified by a dubble header. Converts millidegrees using Si(111) d = 3.13543 Å '
        'and joins multi-line detector records. Native nine-element suggestions use MED2–MED9 over I0; '
        'all detector columns remain selectable in the preview. Original bytes are retained.',
        re.compile(rb'^.*&SRS'), _dubble, lambda data: b'dubble' in data.split(b'&END', 1)[0]),
    FilePlugin('HXMA', '0.1', 'CLS HXMA / SXRMB',
        'Reads CLS Data Acquisition tables. HXMA uses the named Energy:sp, I0, It, Ir and Lytle PV columns. '
        'SXRMB and tables without PV labels retain all scalar columns after removing Event-ID. The original '
        'PV headers and omitted columns remain in the source download.',
        re.compile(rb'^.*CLS Data Acquisition'), _hxma),
    FilePlugin('LNLS', '0.1', 'LNLS XAS',
        'Removes leading Data/Hora columns from the numeric table while retaining the date and time values '
        'in metadata. Uses native decimal formatting. Fluorescence headers suggest column 5 / column 2; '
        'transmission headers use ln(abs(column 2 / column 3)).',
        re.compile(rb'.*'), _lnls, lambda data: b'"Data"\t"Hora"' in data.split(b'\n',1)[0] or
            re.search(rb'\d{2}/\d{2}/\d{2}\t\d{2}:\d{2}:\d{2}',data) is not None),
    FilePlugin('Lytle', '0.2', 'Lytle database · encoder data',
        'Reads the encoder-based Lytle format identified by NPTS, NS, CUEDGE and CUHITE. '
        'Uses DSPACE and STPDEG from the file header to convert encoder steps to energy. '
        'The five columns are energy, I0, It, fluorescence and reference. '
        'Transmission starts with ln(abs(I0 / It)); fluorescence can use column 4 / column 2. '
        'The original file remains available from the column-selection panel.',
        re.compile(rb'^\s*NPTS\s+NS\s+CUEDGE\s+CUHITE'), _lytle),
    FilePlugin('PFBL12C', '0.3', 'Photon Factory / SPring-8 / SAGA / Aichi',
        'Reads 9809 beamline files. Converts requested and attained angles with the monochromator D spacing '
        'from the header and Athena’s conversion constant and precision. Transmission uses attained energy '
        'and ln(abs(I0 / I1)); offsets are preserved without subtraction.',
        re.compile(rb'^.*9809\s+(?:KEK-PF|SPring-8|SAGA-LS|AichiSR)\s+(?:BL\d+|NW\d+|\d+\w+\d*)'), _pfbl12c),
    FilePlugin('SLRIBL4', '0.1', 'Dispersive pixel/stripe data',
        'Converts pixel and signal columns using the saved athena.dxas coefficients. Establish the calibration '
        'in Dispersive energy calibration with a conventional and pixel standard, then inspect the file again. '
        'The native pixel/stripe signature also occurs in ESRF ID24 data; it does not identify a facility uniquely.',
        re.compile(rb'(?=.*pixel)(?=.*stripe).*'), _slribl4),
    FilePlugin('SPEC', '0.1', 'ESRF SPEC · multiple scans',
        'Splits zapline mono scans into separate column tables in their original order. '
        'Choose scans and preview each before reviewing detector columns. All scalar columns and the original '
        'file are retained. Uses a labelled ZapEnergy column in keV when present; the native fixed column 13 '
        'does not describe every file layout. Transmission uses Ion1 / Ion2; fluorescence sums Det1 through Det6 over Ion1.',
        re.compile(rb'.*'), _spec, lambda data: re.search(rb'^#S\s+\d+\s+zapline\s+mono\b', data, re.M) is not None),
    FilePlugin('SRS', '0.1', 'Daresbury SRS',
        'Joins SRS multi-element detector records and converts millidegrees using Si(111) d = 3.13543 Å. '
        'Native suggestions select the measured channels for nine- and 32-element detectors. Explicit '
        'ENERGY/TIME column declarations are read directly without angle conversion. DUBBLE records are '
        'also recognized; enabling DUBBLE gives its own reader priority.',
        re.compile(rb'^.*&SRS'), _srs),
    FilePlugin('SSRLA', '0.2', 'SSRL XAFS Data Collector · ASCII',
        'Reads SSRL and ROBL ASCII collector files. Moves achieved energy before requested energy and the clock. '
        'Retains detector counts without subtracting offsets, emits four decimal places, and removes rows with '
        'achieved energy below 0.001 eV as Athena does. Transmission uses columns 4 / 5; fluorescence uses 6 / 4.',
        re.compile(rb'^\s*SSRL\s+EXAFS Data Collector'), _ssrla,
        lambda data: b'\0' not in data.split(b'\n', 2)[1] if b'\n' in data else True),
    FilePlugin('SSRLB', '0.2', 'SSRL XAFS Data Collector · binary',
        'Reads the fixed-record binary collector format. Versions before 2.0 swap the two 16-bit words of each '
        'float and divide by four; 2.0 uses little-endian IEEE floats. Emits three decimal places with achieved '
        'energy first. Transmission uses columns 4 / 5; fluorescence uses 6 / 4. Original binary bytes are retained.',
        re.compile(rb'^\s*SSRL\s+-\s+EXAFS Data Collector\s+\d+\.\d+'), _ssrlb,
        lambda data: b'\0' in data[40:80]),
    FilePlugin('SSRLmicro', '0.1', 'SSRL MicroEXAFS Data Collector',
        'Reads MicroEXAFS ASCII data, moves energy before the clock, retains detectors then SCA channels, '
        'and omits ICR channels from the converted table. Transmission uses columns 3 / 4; fluorescence uses '
        '6 / 3. Use column ranges to sum additional SCA channels. Original ICR readings remain in the source download.',
        re.compile(rb'^\s*SSRL\s+MicroEXAFS Data Collector'), _ssrlmicro),
    FilePlugin('X10C', '0.1', 'NSLS beamline X10C',
        'Recognizes EXAFS on the first line and DATA START later in the file. '
        'Removes NUL padding and separates joined negative numbers in a converted copy. '
        'Retains all eight columns; transmission starts with ln(abs(column 4 / column 6)), '
        'using column 1 as energy. The column-selection panel shows the selected signal '
        'and offers both original and converted files.',
        re.compile(rb'^EXAFS', re.I), _x10c),
    FilePlugin('X15B', '0.1', 'NSLS beamline X15B',
        'Reads binary files with a 212-byte header and 64-byte scalar records. Native configuration selects '
        'energy, I0, narrow/wide ROI and transmission columns before the live detector preview. Configure '
        'source scalar columns 1–14, apply for this server session or save for future starts, then inspect '
        'the file again. Original binary bytes and the applied configuration are retained.',
        re.compile(rb'^\xd4\x00\x00\x00'), _x15b, configurable=True),
    FilePlugin('X23A2MED', '0.2', 'NIST Vortex · X23A2 / BMM',
        'Corrects one through four Vortex detector channels using configured ROI, fast/slow labels, '
        'deadtimes and integration times. Keeps both ROI edges in multiedge files. A zero slow count '
        'omits that whole detector channel, as in Athena; omitted channels are reported. The live preview '
        'uses the converted counts, and source bytes plus the applied configuration are retained.',
        re.compile(rb'.*'), _x23a2med,
        lambda data: b'BMM' in data.split(b'\n',1)[0] or (len(data.splitlines()) > 1 and b'X-23A2' in data.splitlines()[1]),
        configurable=True, configured_recognize=_recognize_x23a2med),
    FilePlugin('X23A2MultiChannel', '0.1', 'NSLS X23A2 · four-channel ion chambers',
        'Creates four independent transmission groups from I0/I02/I03/I04 and It1–It4, then opens '
        'project preview and selection. Each sample uses its own denominator. Native defaults do not '
        'import or tie a reference channel. Original detector columns and source bytes are retained.',
        re.compile(rb'^\s*XDAC'), _multichannel,
        lambda data: _recognize_multichannel(data, 'X23A2MultiChannel')),
    FilePlugin('Zip', '0.1', 'ZIP archive of data files',
        'Lists the archive’s files in their original order. Select entries and review each through '
        'the usual live column, scan or project preview. Each member keeps its original bytes. '
        'Directories are omitted from selection. Expanded data shares the upload byte limit; '
        'up to 1,000 entries are supported. Password-protected archives and links are not supported.',
        re.compile(rb'.*'), read_archive, recognize_zip),
)


def plugin_catalog():
    revision = '06afc8da08a5a7d5a26ee14992170fcf5dc67406'
    return [{'id': p.ident, 'name': p.name, 'description': p.description, 'version': p.version,
             'origin': 'system', 'documentation': p.documentation, 'configurable': p.configurable,
             'documentation_url': f'https://github.com/bruceravel/demeter/blob/{revision}/lib/Demeter/Plugins/{p.name}.pm'}
            for p in _PLUGINS]


def prepare_file(data, *, max_bytes, max_points, max_columns, enabled=None, read_configuration=None, read_dispersive=None):
    if len(data) > max_bytes:
        _fail(f'Upload exceeds the {max_bytes} byte limit.', 'upload_too_large')
    first = data.removeprefix(b'\xef\xbb\xbf').split(b'\n', 1)[0]
    disabled = []
    for plugin in _PLUGINS:
        if plugin.signature.match(first) and (plugin.recognize is None or plugin.recognize(data)):
            configuration = None
            if plugin.configured_recognize:
                from .athena_plugin_config import default_configuration
                configuration = (read_configuration or default_configuration)(plugin.name)
                if not plugin.configured_recognize(data, configuration):
                    continue
            if enabled is not None and not enabled.get(plugin.ident, False):
                disabled.append(plugin)
                continue
            try:
                if plugin.name == 'SLRIBL4':
                    return plugin.transform(data, max_points, max_columns, read_dispersive() if read_dispersive else None)
                if plugin.name == 'Zip':
                    return plugin.transform(data, max_bytes=max_bytes)
                if plugin.configurable:
                    from .athena_plugin_config import default_configuration
                    configuration = configuration or (read_configuration or default_configuration)(plugin.name)
                    return plugin.transform(data, max_points, max_columns, configuration)
                return plugin.transform(data, max_points, max_columns)
            except UnicodeDecodeError:
                _fail('The recognized file contains invalid UTF-8 text.', 'upload_encoding')
    if disabled:
        plugin = disabled[0]
        raise WebInputError('file_plugin_disabled', f'The {plugin.name} file plugin is disabled.',
                            ('file',), f'Enable {plugin.name} in File → Plugin registry, then retry file inspection.')
    return None
