"""Inert beamline metadata from pinned Demeter BL8/MX/X11A/XDAC helpers.

Reading these headers never changes energy, detector counts or fit settings.
Bundled INI defaults follow native encounter order; later file fields win.
"""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class BeamlineDefaults(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(default=0, strict=True, ge=0)
    enabled: StrictBool = True


MONTHS = {name: i+1 for i, name in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])}
INI = json.loads(Path(__file__).with_name('athena_beamline_defaults.json').read_text())


def identify(data, *, enabled=True, bl8_crystal=None):
    if not enabled:
        return None
    text = data.decode('utf-8-sig', errors='replace')
    lines = text.splitlines()
    if not lines:
        return None
    reader = next((name for name, pattern in [
        ('BL8', r'BL8: X-ray Absorption Spectroscopy'), ('MX', r'MRCAT_XAFS V\d+\.\d+'),
        ('X11A', r'NSLS/X11 EDC-\d+\.\d+'), ('XDAC', r'XDAC V\d+\.\d+')]
        if re.search(pattern, lines[0])), None)
    if reader is None:
        return None
    result = {'reader': reader, 'identified': True, 'daq': '', 'beamline': '', 'extra_version': '',
              'attributes': {}, 'comments': [], 'warnings': [], 'ini_files': [],
              'source_sha256': hashlib.sha256(data).hexdigest()}

    def set_item(family, tag, value):
        if value is not None:
            result['attributes'].setdefault(family.lower(), {})[tag.lower()] = str(value)

    def read_ini(name):
        if name in INI:
            result['ini_files'].append(name)
            for family, fields in INI[name].items():
                for tag, value in fields.items():
                    set_item(family, tag, value)

    def timestamp(year, month, day, hour, minute, second, native=None):
        try:
            value = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second)).isoformat()
        except (TypeError, ValueError, OverflowError):
            result['warnings'].append('The acquisition date could not be interpreted; the original header is retained.')
            return None
        if native and native != value:
            result.setdefault('native_values', {})['start_time'] = native
            result['warnings'].append('The legacy date conversion was corrected using the original acquisition header.')
        return value

    if reader in ('MX', 'XDAC'):
        version = re.search(r'V(\d+\.\d+)', lines[0])[1]
        result['extra_version'] = f'{reader}/{version}'
        set_item('facility', 'name', 'APS' if reader == 'MX' else 'NSLS')
        if reader == 'XDAC':
            set_item('facility', 'xray_source', 'bend magnet')
        comments, labels = False, False
        for line in lines[1:]:
            if not line.strip():
                continue
            creation = re.search(r'created at APS (?:Sector)?\s*(\d+)-?(BM|ID) on (\w+)\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})', line) if reader == 'MX' else re.search(
                r'created on (\d+)/(\d+)/(\d+) at (\d+):(\d+):(\d+) ([AP])M on ([UX])-(\d+)([A-Z]?)(\d?)', line)
            if creation:
                if reader == 'MX':
                    sector, source, _, month, day, hour, minute, second, year = creation.groups()
                    result.update(daq='MX', beamline=sector+source)
                    date = timestamp(year, MONTHS.get(month), day, hour, minute, second)
                    set_item('scan', 'start_time', date)
                    read_ini('mx.'+(sector+source).lower()+'.ini')
                    set_item('facility', 'xray_source', 'undulator A' if source == 'ID' else 'bend magnet')
                else:
                    month, day, year, hour, minute, second, ampm, letter, number, suffix, station = creation.groups()
                    y = int(year) if len(year) > 2 else int(year) + (2000 if int(year) < 80 else 1900)
                    native_hour = int(hour) + (12 if ampm == 'P' else 0)
                    native = f'{y:04d}-{int(month):02d}-{int(day):02d}T{native_hour:02d}:{int(minute):02d}:{int(second):02d}'
                    actual_hour = int(hour) % 12 + (12 if ampm == 'P' else 0)
                    date = timestamp(y, month, day, actual_hour, minute, second, native)
                    set_item('scan', 'start_time', date)
                    beamline = (letter+number+suffix+station).lower()
                    result.update(daq='xdac', beamline=beamline)
                    read_ini('xdac.'+beamline+'.ini')
                continue
            if re.match(r'^-{3,}', line):
                if reader == 'MX':
                    break  # Native last FILE makes its get_labels branch unreachable.
                labels = True
                continue
            if labels:
                for i, label in enumerate(line.split(), 1):
                    set_item('column', str(i), label)
                break
            if comments:
                result['comments'].append(line)
                continue
            mono = re.match(r'^Diffraction element= (\w+)\s*([()0-9]+)', line) if reader == 'XDAC' else None
            if mono:
                set_item('mono', 'name', mono[1]+mono[2])
            ring = re.search(r'Ring energy= (\d\.\d+) (\w+)', line) if mono else re.match(r'^Ring energy= (\d\.\d+) (\w+)', line)
            if ring:
                set_item('facility', 'energy', ring[1]+' '+ring[2])
            if mono or ring:
                continue
            words = line.split()
            if re.match(r'^E0', line) and len(words) > 1:
                set_item('scan', 'edge_energy', words[1]); continue
            for prefix, tag in [('NUM_REGIONS', 'NUM_REGIONS'), ('SRB', 'SRB'), ('SRSS', 'SRSS'), ('SPP', 'SPP'),
                                ('Settling', 'Settling_time'), ('Offsets', 'Offsets'), ('Gains', 'Gains')]:
                if line.startswith(prefix):
                    value = (words[1] if len(words) > 1 else '') if prefix == 'NUM_REGIONS' else \
                        (words[2]+' sec' if len(words) > 2 else '') if prefix == 'Settling' else ', '.join(words[1:])
                    set_item(reader, tag, value)
                    comments = prefix == 'Gains'
                    break
    elif reader == 'X11A':
        version = re.search(r'EDC-(\d+\.\d+)', lines[0])[1]
        result['extra_version'] = 'EDC/'+version
        for family, values in {'facility': {'name': 'NSLS', 'xray_source': 'bend magnet'},
            'beamline': {'name': 'X11A', 'collimation': 'none', 'focusing': 'none', 'harmonic_rejection': 'detuned mono'},
            'mono': {'name': 'Si(111)', 'd_spacing': '3.134542', 'stpdeg': '6400'}}.items():
            for tag, value in values.items(): set_item(family, tag, value)
        date = re.search(r'(\d+)-(\w{3})-(\d+)\s+(\d+):(\d+):(\d+)', lines[0])
        if date:
            day, month, year, hour, minute, second = date.groups()
            native_year = 1900+int(year)
            actual_year = int(year) if len(year) > 2 else native_year
            native = f'{native_year:04d}-{MONTHS.get(month, 0):02d}-{int(day):02d}T{int(hour):02d}:{int(minute):02d}:{int(second):02d}'
            set_item('scan', 'start_time', timestamp(actual_year, MONTHS.get(month), day, hour, minute, second, native))
        ring = re.search(r'ENERGY=(\d)\.(\d+)', lines[0])
        if ring: set_item('facility', 'energy', f'{int(ring[1])}.{int(ring[2])} GeV')
        if len(lines) > 1: result['comments'].append(lines[1])
        for line in lines[2:]:
            e0 = re.match(r'^E0=\s+([\d.]+)', line)
            if e0: set_item('scan', 'edge_energy', e0[1]); continue
            mono = re.search(r'HC/2D=\s+([\d.]+)\s+STPDEG=(\d+).*FOCUS=(\w)\s+TRANSLT=(\w)', line)
            if mono:
                try: spacing = 12398.61/float(mono[1])/2
                except (ValueError, ZeroDivisionError):
                    result['warnings'].append('The monochromator spacing could not be calculated from HC/2D.')
                else: set_item('mono', 'd_spacing', f'{spacing:.6f}')
                set_item('mono', 'stpdeg', mono[2])
                # Captures are one character; Demeter.is_true accepts every
                # nonzero digit as well as t/y, case-insensitively.
                set_item('beamline', 'focusing', 'yes' if mono[3].lower() in 'yt123456789' else 'no')
                set_item('beamline', 'table_translation', 'yes' if mono[4].lower() in 'yt123456789' else 'no')
                continue
            for prefix, tag in [('SRB=', 'SRB'), ('DEL=', 'DEL'), ('GAINS', 'GAINS'), ('OFFSETS', 'OFFSETS')]:
                if line.startswith(prefix): set_item('EDC', tag, ' '.join(line.split()[1:])); break
            if line.startswith('OFFSETS'): break
    else:
        result['extra_version'] = 'SLRI/1'
        for family, values in {'facility': {'name': 'SLRI', 'xray_source': 'bend magnet', 'energy': '1.2 GeV'},
            'beamline': {'name': 'BL8', 'collimation': 'none', 'focusing': 'none', 'harmonic_rejection': 'none'},
            'detector': {'i0': 'ionization chamber, N2+He'}}.items():
            for tag, value in values.items(): set_item(family, tag, value)
        date, element = None, ''
        for line in lines[1:]:
            if 'Siam Photon' in line: continue
            if re.match(r'^#?\s*Energy', line):
                labels = [w for w in line.split() if '#' not in w and '(' not in w]
                for i, label in enumerate(labels, 1): set_item('column', str(i), label.lower())
                break
            if 'Experiment date' in line:
                match = re.search(r'Experiment date:?\s+([A-Za-z]+)[, ]+(\d+)[, ]+(\d{4})', line)
                if match:
                    month, day, year = match.groups()
                    value = timestamp(year, MONTHS.get(month[:3].title()), day, 0, 0, 0)
                    date = value[:10] if value else None
                continue
            duration = re.search(r'Duration: (\d+:\d+:\d+) - (\d+:\d+:\d+)', line)
            if duration:
                if date:
                    for tag, time in [('start_time', duration[1]), ('end_time', duration[2])]: set_item('scan', tag, date+'T'+time)
                else: result['warnings'].append('The duration has no usable experiment date; the original header is retained.')
                continue
            e0 = re.search(r'E0 \(eV\) = (\d+)', line)
            if e0:
                set_item('scan', 'edge_energy', e0[1]+' eV')
                from .athena_e0 import _infer_atomic
                if not element:
                    edge = _infer_atomic(float(e0[1]))
                    element = edge['element'].lower()
                    set_item('element', 'symbol', edge['element'])
                    set_item('element', 'edge', edge['edge'])
                continue
            found = False
            for pattern, tag in [('Photon Energy Scan', 'scan'), ('Photon Energy Step', 'step'), ('Time Step', 'time'),
                ('Gain', 'gains'), ('Points/scan', 'points'), ('Ar K edge step size', 'arstep')]:
                if pattern in line:
                    parts = re.split(r'\s+=\s+', line, maxsplit=1)
                    if len(parts) > 1: set_item('SLRI', tag, parts[1])
                    found = True; break
            if found: continue
            if 'Transmission-mode' in line: set_item('detector', 'it', 'ionization chamber, N2+He')
            elif re.search('Si Drift', line, re.I): set_item('detector', 'if', '4 element silicon drift')
            elif re.search('Ge 13-array', line, re.I): set_item('detector', 'if', '13 element Ge')
        crystal = os.environ.get('XDIBL8', '') if bl8_crystal is None else bl8_crystal
        if crystal == 'KTP' or element == 'al': name, spacing = 'KTP(011)', 10.955/2
        elif crystal == 'InSb' or element == 'si': name, spacing = 'InSb(111)', 7.481/2
        elif crystal == 'Si': name, spacing = 'Si(111)', 6.271/2
        elif crystal == 'Ge': name, spacing = 'Ge(220)', 4.001/2
        elif element == 'mg': name, spacing = 'Beryl(1010)', 15.954/2
        else: name, spacing = 'Ge(220)', 4.001/2
        set_item('mono', 'name', name); set_item('mono', 'd_spacing', spacing)
        result['mono_inference'] = {'element': element, 'XDIBL8': crystal,
                                    'description': 'Crystal inferred from Athena’s rule and the XrayDB edge table; the header does not name the crystal.'}
    return result
