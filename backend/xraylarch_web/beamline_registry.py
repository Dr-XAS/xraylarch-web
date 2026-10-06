"""Recognize the beamline that wrote an uploaded file, and name it.

Web Larch already reads many file formats: Larch's column parser, Demeter's
file plugins and the XDI reader between them cover most of what a beamline
writes. What none of them does is say *where the file came from*. A user who
uploads a scan sees a table of columns called ``Caldiode`` and ``PreKB-I0``
and must know the beamline to choose correctly.

This registry answers that question. For every supported format it names the
facility, the beamline and the format, says what in the file proves it, and --
once the beamline is known -- names the detector channels (see
:mod:`xraylarch_web.beamline_roles`). Detection reuses Larch's own
``guess_beamline`` for the eight data-acquisition families it already knows,
so the regular expressions live in one place, and adds the formats that
identify themselves in their header: XDI, the NSLS-II Bluesky column export,
ESRF LISA, SLS PHOENIX, FDMNES and SPEC.

Two neighbouring modules do related work and are deliberately left alone:
``athena_file_plugins`` is a port of Demeter's plugin chain (it *converts*
files), and ``athena_beamline_metadata`` is a port of Demeter's identification
of four DAQ header styles (it *transcribes* header fields). This registry
neither converts nor transcribes: it identifies and maps roles, and it defers
to a Demeter plugin's own column suggestion wherever one exists.
"""

from __future__ import annotations

import gzip
import io
import re
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from larch.io.xafs_beamlines import guess_beamline
from xraydb import xray_edges

from . import beamline_roles

HEAD_BYTES = 64_000
HEAD_LINES = 80


@dataclass(frozen=True)
class BeamlineReader:
    """One recognized way of writing an XAS scan to a file."""

    ident: str
    name: str
    facility: str
    beamline: str
    fmt: str
    evidence: str
    refine: Callable[[str], dict] | None = None
    overrides: dict = field(default_factory=dict)
    #: The station this acquisition system is usually run from, used when the
    #: header names none. It is an expectation about where the file came from,
    #: not something the file says, so it is kept apart from ``beamline``:
    #: a station the file did name must not be overwritten later, while this
    #: one must be, by any reader that knows better.
    usual: str = ''

    def describe(self, head: str) -> dict:
        found = {'id': self.ident, 'name': self.name, 'facility': self.facility,
                 'beamline': self.beamline, 'format': self.fmt, 'evidence': self.evidence,
                 'overrides': dict(self.overrides)}
        if self.refine is not None:
            refined = dict(self.refine(head))
            # A refinement that reads something out of the header says so in
            # the evidence line rather than replacing it: the pattern that
            # recognized the file is still why it was recognized.
            note = refined.pop('evidence_note', '')
            found.update(refined)
            if note:
                found['evidence'] = f'{found["evidence"]}; {note}'
        assumed = not found['beamline'] and bool(self.usual)
        if assumed:
            found.update(beamline=self.usual, beamline_assumed=True,
                         evidence=f'{found["evidence"]}; the header names no station, and '
                                  f'{self.usual} is the one this system usually writes from')
        found['confidence'] = 'beamline' if found['beamline'] and not assumed else 'format'
        return found


def _search(pattern, head, flags=re.I | re.M):
    found = re.search(pattern, head, flags)
    return found.group(1).strip() if found else ''


def _aps_sector(text):
    """Turn an EPICS prefix or a header word into an APS beamline name.

    '13BMD:' and '# Beamline 20 ID' both name a sector and a source; the
    station letter is kept when the prefix carries one.
    """
    found = re.search(r'\b(\d{1,2})\s*[-]?\s*(BM|ID)\s*[-]?\s*([A-E])?\b', text, re.I)
    if not found:
        return ''
    sector, source, station = found.group(1), found.group(2).upper(), found.group(3)
    name = f'{sector}-{source}'
    return f'{name}-{station.upper()}' if station else name


def _refine_mrcat(head):
    station = _aps_sector(_search(r'created at APS\s*(\S+)', head))
    return {'beamline': f'{station} (MRCAT)'} if station else {}


def _refine_gse(head):
    prefix = _search(r'scan prefix\s*=\s*(\S+)', head) or _search(r'\|\|\s+(\d{2}(?:BM|ID)[A-E]?):', head)
    station = _aps_sector(prefix)
    return {'beamline': f'{station} (GSECARS)'} if station else {}


def _refine_xsd(head):
    named = _search(r'^#\s*Beamline\s+(\d{1,2}\s*(?:BM|ID)\s*[A-E]?)\s*$', head)
    station = _aps_sector(named)
    if not station and re.search(r'\bpncbm:', head, re.I):
        station = '20-BM'  # the PNC/XSD bending-magnet station names itself only in its PVs
    if not station and re.search(r'\bpncid:', head, re.I):
        station = '20-ID'
    found = {'beamline': station} if station else {}
    # The scan configuration states the edge the scan was set up for; it is
    # the operator's statement, checked against the energy axis on import.
    edge = _search(r'^#\s*E0:\s*([-+]?\d+(?:\.\d*)?)\s*eV', head)
    if edge:
        found['scan_e0'] = float(edge)
    scan = {key: _search(pattern, head) for key, pattern in (
        ('started', r'created by LabVIEW Control Panel\s+([^;]+);'),
        ('duration', r';\s*Scan time\s+([^.\n]+)'),
        ('bounds', r'^#\s*Scan bounds:\s*(.+)$'),
        ('steps', r'^#\s*Scan step\(s\):\s*(.+)$'),
        ('integration', r'^#\s*Integration times:\s*(.+)$'),
        ('amplifiers', r'^#\s*Amplifier Sensitivities:\s*\n#\s*(.+)$'),
        ('comment', r'^#\s*User Comment:\s*\n#\s*(.+)$'))}
    scan = {key: value for key, value in scan.items() if value}
    if scan:
        found['scan_config'] = scan
    return found


def _refine_spec(head):
    """A SPEC file names no facility, but its '#F' line is the path it was
    written to, and beamline data paths usually carry the station
    ('/net/data/20bm/...'). The station is taken only as the path states it,
    and the facility only when the path names the APS too."""
    path = _search(r'^#F\s+(.+)$', head)
    station = _aps_sector(path.replace('_', ' ')) if path else ''
    if not station:
        return {}
    found = {'beamline': station, 'evidence_note': f"the '#F' path '{path}' names {station}"}
    if re.search(r'(?<![a-z])aps(?![a-z])|apsshare|/xsd/', path, re.I):
        found['facility'] = 'Advanced Photon Source'
    return found


def _refine_xdac(head):
    return {'beamline': _search(r'\bon\s+(X-?\d+[A-Z]?\d*)\s*$', head)}


def _refine_kekpf(head):
    station = _search(r'KEK-PF\s+(BL\S+)', head)
    found = {'beamline': station} if station else {}
    # The 9809 collector calls its two counters I0 and I1 whatever they
    # measured, and names the measurement on the station's own line
    # ('BL9A      Fluorescence( 3)'). In a fluorescence scan I1 is the
    # detector, so reading it as the transmitted beam gives ln(I0/If): a
    # spectrum whose edge goes the wrong way. The file states which it was,
    # so this is not a guess, and a station line that says Transmission
    # leaves the usual mapping alone.
    if re.search(r'^\s*BL\S+\s+Fluorescence\b', head, re.I | re.M):
        found['overrides'] = {'fluorescence': ['i1'], 'transmission': []}
        found['evidence_note'] = "the station line declares a fluorescence scan, so I1 is the detector"
    return found


def _refine_cls(head):
    # The CLS writes its process-variable prefix, not its beamline name:
    # BL1606-ID-1 is the hard X-ray micro-analysis beamline on sector 06ID.
    if re.search(r'BL1606-ID', head):
        return {'beamline': 'HXMA (06ID-1)'}
    return {}


def xdi_fields(head: str) -> dict:
    """The ``Family.tag: value`` fields of an XDI header, lowercased keys."""
    fields = {}
    for line in head.splitlines():
        if not line.startswith('#'):
            break
        body = line.lstrip('#').strip()
        if body.startswith('//') or ':' not in body:
            continue
        key, value = body.split(':', 1)
        if re.fullmatch(r'[A-Za-z][\w]*\.[\w]+', key.strip()):
            fields[key.strip().lower()] = value.strip()
    return fields


def _refine_xdi(head):
    fields = xdi_fields(head)
    beamline = fields.get('beamline.name', '').split(' -- ')[0].strip()
    found = {'facility': fields.get('facility.name', '') or 'not stated in the file',
             'beamline': beamline}
    # XDI 1.0 puts the element in its own family; the GSE/1.0 files written
    # before that spelled it under Scan, and both are in circulation.
    symbol = fields.get('element.symbol') or fields.get('scan.element', '')
    edge = ' '.join(x for x in (symbol, fields.get('element.edge')
                                or fields.get('scan.edge', '')) if x)
    if edge:
        found['edge'] = edge
    version = _search(r'#\s*XDI/(\S+)', head)
    if version:
        found['format'] = f'XDI {version}'
    return found


def _refine_bluesky_ascii(head):
    found = {'facility': _search(r'^#\s*Facility:\s*(.+)$', head),
             'beamline': _search(r'^#\s*Beamline:\s*(.+)$', head)}
    edge = ' '.join(x for x in (_search(r'^#\s*Element:\s*(\S+)\s*$', head),
                                _search(r'^#\s*Edge:\s*(\S+)\s*$', head)) if x)
    if edge:
        found['edge'] = edge
    return found


# Larch's guess_beamline already matches eight acquisition families from the
# first header line. Reuse it, and add only what it does not carry: which
# facility and station the family belongs to.
LARCH_FAMILIES = {
    'APS MRCAT': BeamlineReader(
        'aps-mrcat', 'MRCAT XAFS collector', 'Advanced Photon Source', '',
        'MRCAT column ASCII', "the 'MRCAT_XAFS' version line", _refine_mrcat,
        usual='10-BM (MRCAT)'),
    'APS 12BM': BeamlineReader(
        'aps-12bm', 'APS 12-BM EXAFS scan', 'Advanced Photon Source', '12-BM-B',
        'SPEC-style column ASCII', "the 'exafsscan' command and its 'exafs_region' lines"),
    'GSE EpicsScan': BeamlineReader(
        'aps-gsecars', 'GSECARS Epics StepScan', 'Advanced Photon Source', '',
        'Epics StepScan column ASCII', 'the Epics StepScan header', _refine_gse,
        usual='13-BM-D (GSECARS)'),
    'APS XSD': BeamlineReader(
        'aps-xsd-labview', 'APS XSD LabVIEW scan', 'Advanced Photon Source', '',
        'LabVIEW column ASCII', "the 'LabVIEW Control Panel' first line", _refine_xsd),
    'NSLS XDAC': BeamlineReader(
        'nsls-xdac', 'NSLS XDAC collector', 'National Synchrotron Light Source', '',
        'XDAC column ASCII', "the 'XDAC' version line", _refine_xdac,
        usual='X-23A2'),
    'SSRL': BeamlineReader(
        'ssrl-collector', 'SSRL EXAFS Data Collector', 'Stanford Synchrotron Radiation Lightsource', '',
        'SSRL collector ASCII', "the 'EXAFS Data Collector' first line"),
    'CLS HXMA': BeamlineReader(
        'cls-hxma', 'CLS data acquisition', 'Canadian Light Source', '',
        'CLS column ASCII', "the 'CLS Data Acquisition' first line", _refine_cls,
        usual='HXMA (06ID-1)'),
    'KEK PF': BeamlineReader(
        'kek-pf', 'KEK Photon Factory 9809 collector', 'Photon Factory, KEK', '',
        '9809 column ASCII (angle axis)', "the '9809  KEK-PF' first line", _refine_kekpf),
}

# Formats that name themselves in their own header, tried in order once
# guess_beamline has declined. Order is specific before general.
SELF_DESCRIBING = (
    (re.compile(r'^#?\s*XDI/\d', re.I), BeamlineReader(
        'xdi', 'XAS Data Interchange file', '', '', 'XDI',
        'the XDI version line and its Facility/Beamline fields', _refine_xdi)),
    (re.compile(r'^#\s*eBraggEnergy\b', re.I), BeamlineReader(
        'esrf-lisa', 'ESRF LISA column file', 'ESRF', 'BM08 (LISA)', 'Column ASCII',
        "the '#eBraggEnergy' label line LISA writes")),
    (re.compile(r'^#.*KEITHLEY\d?.*_c\d', re.I), BeamlineReader(
        'sls-phoenix', 'SLS PHOENIX column file', 'Swiss Light Source', 'PHOENIX (X07MB)',
        'Column ASCII', 'the Keithley channel labels numbered _c1, _c2, ...')),
    (re.compile(r'^#\s*FDMNES program', re.I), BeamlineReader(
        'fdmnes', 'FDMNES calculated spectrum', '', '',
        'FDMNES output', "the '# FDMNES program' first line")),
    # ESRF's 'zap' fast-scan subsystem writes SPEC files whose energy axis is
    # called ZapEnergy; no other facility's SPEC output carries that name.
    # 'Mon', 'Ion1' and 'Ion2' are counter names from the station's own SPEC
    # configuration, not part of the format, so their order along the beam is
    # an expectation rather than something the file states. It is the order
    # the example file in this repository measures (see the edge-step check in
    # the tests), and the evidence line says so, so a station that wires them
    # differently is visible to the user instead of silently mis-imported.
    (re.compile(r'^#S\s+\d+\s+zapline\b|^#L\b.*\bZapEnergy\b', re.M), BeamlineReader(
        'esrf-zapline', 'ESRF zapline scan', 'ESRF', '', 'SPEC (ESRF zapline)',
        "the ZapEnergy axis ESRF's fast-scan subsystem writes; Mon, Ion1 and "
        'Ion2 are taken in that order along the beam, which is a station '
        'convention and not stated by the file',
        overrides={'i0': 'mon', 'transmission': 'ion1', 'reference': 'ion2'})),
    (re.compile(r'^#[FS]\s', re.M), BeamlineReader(
        'spec', 'SPEC scan file', '', '', 'SPEC',
        "the '#F' and '#S' SPEC header lines", _refine_spec)),
    # Last, because '# Facility:' is a field a file of any format can carry,
    # while every entry above is matched on something only its own format
    # writes. A SPEC file that happens to name its facility stays SPEC.
    (re.compile(r'^#\s*Facility:\s*\S', re.I | re.M), BeamlineReader(
        'bluesky-ascii', 'Bluesky column export', '', '', 'Column ASCII (Bluesky export)',
        "the '# Facility:' and '# Beamline:' header fields", _refine_bluesky_ascii)),
)


# Demeter's file plugins recognize beamlines this registry's own patterns do
# not: a 2006 APS 9-BM file is a plain SPEC file to anything reading its first
# line, and only the CMC plugin's dark-current logic knows which station wrote
# it. When a plugin has converted the file, its identification is better than
# none, so the facility and station it stands for are named here. Plugins
# whose description covers several facilities at once -- PFBL12C, which reads
# Photon Factory, SPring-8, SAGA and Aichi files alike -- are deliberately
# absent: naming one of them would be a guess, and those files say which
# facility wrote them in their own headers.
#
# The keys are the plugins' short names, which is what a converted file carries
# in its own metadata; the catalog spells the same plugin as a Perl package
# path, 'Demeter::Plugins::CMC'. A test holds the two spellings together.
PLUGIN_BEAMLINES = {
    '10BMMultiChannel': ('Advanced Photon Source', '10-BM (MRCAT)'),
    'B18': ('Diamond Light Source', 'B18'),
    'BL8Ar': ('Synchrotron Light Research Institute', 'BL8'),
    'BM23': ('ESRF', 'BM23'),
    'CMC': ('Advanced Photon Source', '9-BM (CMC-XOR)'),
    'DUBBLE': ('ESRF', 'BM26A (DUBBLE)'),
    'HXMA': ('Canadian Light Source', 'HXMA (06ID-1) or SXRMB (06B1-1)'),
    'LNLS': ('Brazilian Synchrotron Light Laboratory', ''),
    'SLRIBL4': ('Synchrotron Light Research Institute', 'BL4'),
    'SRS': ('Daresbury SRS', ''),
    'X10C': ('National Synchrotron Light Source', 'X10C'),
    'X15B': ('National Synchrotron Light Source', 'X15B'),
    'X23A2MultiChannel': ('National Synchrotron Light Source', 'X-23A2'),
}


def attribute_plugin(reader: dict | None, plugin: dict | None) -> dict | None:
    """Name the beamline a Demeter plugin stands for, when nothing else did.

    A reader that already names a beamline from the file's own header keeps
    it: the header is the file's statement about itself, while the plugin is
    an inference from the shape of its columns. A station the registry only
    assumed is not such a statement, and gives way to the plugin's claim,
    which at least rests on something in the file.

    A station reached this way is still an expectation -- the plugin
    recognizes an acquisition system, and the station is where that system
    usually runs -- so the evidence says so and the confidence stays at the
    format.
    """
    name = (plugin or {}).get('id', '').rsplit('::', 1)[-1]
    attribution = PLUGIN_BEAMLINES.get(name)
    stated = reader is not None and reader.get('beamline') and not reader.get('beamline_assumed')
    if attribution is None or stated:
        return reader
    facility, beamline = attribution
    claim = f'the {name} reader claimed this file'
    if beamline:
        claim += (f'; the header names no station, and {beamline} is the one this '
                  'system usually writes from')
    if reader is None:
        return {'id': 'demeter-plugin', 'name': plugin['description'], 'facility': facility,
                'beamline': beamline, 'format': plugin['description'], 'evidence': claim,
                'overrides': {}, 'confidence': 'format'}
    found = dict(reader, facility=reader.get('facility') or facility, beamline=beamline,
                 evidence=f"{reader['evidence']}; {claim}" if beamline else reader['evidence'],
                 confidence='format')
    found.pop('beamline_assumed', None)
    return found


GZIP_MAGIC = b'\x1f\x8b'
# Every Athena and Demeter release since 2002 writes this line first, and the
# JSON projects of 0.9.26 keep it verbatim under '_____header1'. The file name
# does not say it: projects are saved as .prj, .json, .gz and with no suffix
# at all, and a scan may be called .prj by a user who renamed it.
ATHENA_PROJECT_LINE = re.compile(
    r'#\s*Athena project file\s*--\s*(Athena|Demeter)\s+version\s+([\w.]+)', re.I)
# A project web Larch saved itself carries no Demeter header, only its format.
ATHENA_WEB_LINE = re.compile(r'"format"\s*:\s*"athena-web"')
PROJECT_HEAD_BYTES = 8_000


def athena_project(data: bytes) -> dict | None:
    """Name the writer of an Athena project file, from its own header.

    Returns None for anything else, so the caller can go on to the column
    readers. A project is recognized by its content rather than its name
    because the two formats that reach this point -- a saved Athena project
    and a beamline's column file -- are told apart by their first line, and
    an Athena project pushed through the column parser fails with a message
    about NUL bytes that says nothing about what the file actually is.
    """
    head = data[:PROJECT_HEAD_BYTES]
    compressed = data[:2] == GZIP_MAGIC
    if compressed:
        try:
            head = gzip.GzipFile(fileobj=io.BytesIO(data)).read(PROJECT_HEAD_BYTES)
        except (OSError, EOFError):
            return None
    text = head.decode('utf-8-sig', errors='replace')
    found = ATHENA_PROJECT_LINE.search(text)
    if found is None:
        if not ATHENA_WEB_LINE.search(text):
            return None
        writer, version = 'web Larch', ''
    else:
        writer, version = found.group(1), found.group(2)
    named = f'{writer} {version}'.strip()
    return {'id': 'athena-project', 'name': 'Athena project',
            'format': f'Athena project ({named})', 'writer': writer, 'version': version,
            'compressed': compressed,
            'evidence': "the '# Athena project file' header line the writer puts first"}


def head_text(data: bytes) -> str | None:
    """The readable head of an upload, or None when it is not text."""
    head = data[:HEAD_BYTES]
    if b'\x00' in head:
        return None
    return head.decode('utf-8-sig', errors='replace')


def identify_beamline(data: bytes, *, settings=None) -> dict | None:
    """Name the facility, beamline and format of an uploaded file.

    Returns None when nothing recognizes the file; the caller then leaves
    Athena's own guesses in place.
    """
    from .hdf5_readers import identify_hdf5, is_hdf5
    if is_hdf5(data):
        return identify_hdf5(data, settings=settings)
    head = head_text(data)
    if head is None:
        return None
    lines = head.splitlines()[:HEAD_LINES]
    # Recognition reads the same first 80 lines whichever rule does it, so
    # that what a file is cannot depend on a line far down inside it. Once
    # a reader has claimed the file, it refines from the whole head: a long
    # XDI header can carry its Facility field past line 80.
    opening = '\n'.join(lines)
    family = guess_beamline(lines).name
    reader = LARCH_FAMILIES.get(family)
    if reader is not None:
        return reader.describe(head)
    for pattern, candidate in SELF_DESCRIBING:
        if pattern.search(opening):
            return candidate.describe(head)
    return None


def energy_units(column_id, arrays, column_units=None):
    """The units of the energy axis: what the file declares, else what it shows.

    An XAS scan runs over hundreds of eV somewhere between 1 and 150 keV, so
    an undeclared axis whose largest value is below 100 is in keV. A declared
    unit is believed even when the numbers look wrong, because the one thing
    worse than a file with implausible units is a reader that overrules a
    file that said what it meant.
    """
    declared = (column_units or {}).get(column_id)
    if declared in ('eV', 'keV'):
        return declared
    values = (arrays or {}).get(column_id)
    if values is None or len(values) == 0:
        return 'eV'
    return 'keV' if float(np.nanmax(values)) < 100. else 'eV'


def energy_span(column_id, arrays, column_units=None):
    """The first and last energy of the scan in eV, or None if unreadable."""
    values = (arrays or {}).get(column_id)
    values = None if values is None else np.asarray(values, float)[np.isfinite(values)]
    if values is None or len(values) < 2:
        return None
    low, high = float(np.min(values)), float(np.max(values))
    if energy_units(column_id, arrays, column_units) == 'keV':
        low, high = low * 1000., high * 1000.
    return low, high


def read_roles(reader: dict, columns, column_units=None, arrays=None) -> dict:
    """Name the detector channels of a file whose beamline is known.

    The returned mapping carries the roles that were found, one import
    suggestion per measurement mode the file supports, and the reference
    channel to import beside the sample. Roles are assigned twice: the first
    pass finds the energy column, whose units and range then decide which
    element a multi-element fluorescence detector was watching. The units are
    resolved once, here, and written back into the unit map, so that the
    range the element search reads and the units the import suggestion
    carries are the same decision rather than two guesses that can disagree.
    """
    overrides = reader.get('overrides')
    roles = beamline_roles.assign_roles(columns, column_units=column_units, overrides=overrides)
    if roles.energy:
        column_units = dict(column_units or {},
                            **{roles.energy: energy_units(roles.energy, arrays, column_units)})
        roles = beamline_roles.assign_roles(
            columns, column_units=column_units, overrides=overrides,
            energy_range=energy_span(roles.energy, arrays, column_units))
    suggestions = beamline_roles.suggestions_from_roles(roles)
    found = {'roles': roles.named(), 'suggestions': suggestions,
             'declined': list(roles.declined)}
    if roles.i0_corrected:
        found['roles']['i0_corrected'] = roles.i0_corrected
    if roles.energy_units:
        found['energy_units'] = roles.energy_units
    if roles.fluorescence_element:
        found['fluorescence_element'] = roles.fluorescence_element
    reference = beamline_roles.reference_from_roles(roles)
    span = energy_span(roles.energy, arrays, column_units) if roles.energy else None
    measurement = beamline_roles.choose_measurement(
        suggestions, reference, arrays, expected_edge(reader.get('scan_e0'), roles.fluorescence_element, span))
    if measurement is not None:
        found['suggestions'], reference = measurement.pop('suggestions'), measurement.pop('reference')
        found['measurement'] = measurement
    if reference:
        found['reference'] = reference
    return found


def expected_edge(stated, element, span):
    """The edge energy the scan measured: the scan's stated E0 when it lies in
    the scanned range, else the edge of the element the detector watched."""
    if span is None:
        return None
    low, high = span
    if stated is not None and low < stated < high:
        return float(stated)
    if element:
        inside = [edge.energy for edge in xray_edges(element).values() if low < edge.energy < high]
        if inside:
            return float(min(inside))
    return None


_SYMBOL = re.compile(r'(?<![A-Za-z])([A-Z][a-z])(?![a-z])')


def declared_edge_warnings(filename, span, stated=None):
    """Warn when the element a file names, or its stated E0, is not in the scan.

    A scan named 'series_Ni.0007' names nickel and its header states E0 = 8333 eV, but
    its energy axis runs over the manganese K edge: a scan of something else,
    or a mislabeled one. Nothing is changed; the user is told.
    """
    if span is None:
        return []
    low, high = span
    warnings = []
    if stated is not None and not low < stated < high:
        warnings.append(f'The header states E0 = {stated:g} eV, but the energy axis runs {low:.0f}–{high:.0f} eV; '
                        'this scan does not contain the edge it was set up for.')
    for symbol in dict.fromkeys(_SYMBOL.findall(filename)):
        if symbol.lower() not in beamline_roles.ELEMENTS:
            continue
        edges = {name: edge.energy for name, edge in xray_edges(symbol).items() if name in ('K', 'L3', 'L2', 'L1')}
        if edges and not any(low < energy < high for energy in edges.values()):
            named = ', '.join(f'{symbol} {name} {energy:.0f} eV' for name, energy in edges.items()
                              if 1000 < energy < 150_000)
            warnings.append(f'The file name names {symbol}, but the energy axis ({low:.0f}–{high:.0f} eV) '
                            f'contains none of its edges ({named}). Check that this is the scan you mean.')
    return warnings


def reader_catalog() -> list[dict]:
    """Every reader the registry knows, for the supported-formats view."""
    from .athena_file_plugins import plugin_catalog
    from .hdf5_readers import layout_catalog
    readers = [*LARCH_FAMILIES.values(), *(reader for _, reader in SELF_DESCRIBING)]
    catalog = [{'id': reader.ident, 'name': reader.name, 'facility': reader.facility,
                'beamline': reader.beamline or reader.usual,
                'format': reader.fmt, 'evidence': reader.evidence}
               for reader in readers] + layout_catalog()
    # The beamlines reached only through a Demeter file reader. They belong in
    # the view for the same reason the rest do -- the question is which data
    # the program opens, not which part of it does the opening -- but they are
    # listed under the reader that has to be enabled for them to work.
    described = {plugin['id'].rsplit('::', 1)[-1]: plugin['description'] for plugin in plugin_catalog()}
    seen = {(item['facility'], item['beamline']) for item in catalog}
    for name, (facility, beamline) in sorted(PLUGIN_BEAMLINES.items()):
        if (facility, beamline) not in seen:
            catalog.append({'id': f'plugin-{name.lower()}', 'name': described[name],
                            'facility': facility, 'beamline': beamline,
                            'format': described[name],
                            'evidence': f'the {name} file reader, which must be enabled first'})
    # A saved project is a format web Larch opens, not a beamline's output, so
    # it names no facility; the view still has to list it.
    catalog.append({'id': 'athena-project', 'name': 'Athena project', 'facility': '',
                    'beamline': '', 'format': 'Athena project (Athena or Demeter, any version)',
                    'evidence': "the '# Athena project file' header line the writer puts first"})
    return catalog
