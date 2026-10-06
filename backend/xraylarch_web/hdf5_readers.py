"""Open an XAS scan stored as HDF5, whatever layout its facility chose.

NeXus fixes the container but not the arrangement, so every facility writes an
energy scan somewhere different: Bluesky puts the counters in an ``NXdata``
group beside a ``bluesky/metadata`` tree, ESRF's BLISS puts them in
``measurement`` under a numbered entry, SOLEIL uses ``scan_data``, Diamond
writes ``entry1`` with one group per detector, and the NXxas application
definition puts the monochromator energy and the monitor in named places of
their own. A reader that hard-codes one of these reads one facility's files.

The approach here is the other way round. One walker finds the scan's channels
in any of these layouts -- the 1-D arrays that share the scan's length, under
whichever group that layout puts them in -- and the layout is then used only
for what it alone can say: which facility and beamline wrote the file, where
the sample name and E0 live, and which channel is the incident beam when the
names do not say.

The converted scan leaves here as a column table, the same shape Larch's own
parser produces, so an HDF5 upload reaches the column chooser, the plotting and
the import path already built for text files rather than beside them. Arrays
with more than one dimension -- a multi-channel analyser's spectrum at every
point -- are named in the metadata and left for the fluorescence panel, which
is the part of the application that knows what to do with a spectral cube.
"""

from __future__ import annotations

import io
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .hdf5_safety import read_text, validate_handle

HDF5_MAGIC = b'\x89HDF\r\n\x1a\n'
# A channel whose name says it is a timer, a counter's elapsed clock or an
# EPICS record's status is not a measurement of the beam.
_NOT_A_CHANNEL = re.compile(
    r'^(seq[_ ]?num|point[_ ]?no|timestamp|epoch|clock'
    r'|(elapsed|dwell|count|integration|acquisition|real|live|dead)?[_ ]?time)$', re.I)


def is_hdf5(data: bytes) -> bool:
    """Whether these bytes are an HDF5 file, by its signature."""
    return data[:8] == HDF5_MAGIC


def _text(value) -> str:
    """One HDF5 scalar as text, whether it was stored as bytes or as str."""
    value = np.asarray(value)
    if value.dtype.kind == 'O' or value.dtype.kind == 'S':
        raw = value.ravel()[0] if value.size else b''
        return raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
    if value.dtype.kind == 'U':
        return str(value.ravel()[0]) if value.size else ''
    return str(value.ravel()[0]) if value.size == 1 else ''


def _read(group, path, default=''):
    """A dataset's text value, or ``default`` when the path is not there."""
    node = group.get(path)
    return _text(read_text(node)) if node is not None and node.shape is not None else default


def _named(value: str) -> str:
    """The name inside a Bluesky metadata field that holds a JSON object.

    Bluesky writes ``facility`` as ``{"name": "Advanced Photon Source"}`` in
    some deployments and as a bare string in others; both must read the same.
    """
    value = value.strip()
    if value.startswith('{'):
        try:
            return str(json.loads(value).get('name', '')).strip()
        except (ValueError, AttributeError):
            return ''
    return value


def _attr(node, name: str) -> str:
    value = node.attrs.get(name)
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    if isinstance(value, np.ndarray):
        return _text(value)
    return str(value)


def _nx_class(node) -> str:
    return _attr(node, 'NX_class')


def _groups(node, nx_class: str):
    """The direct children of ``node`` declaring the given NeXus class."""
    return [child for child in node.values()
            if hasattr(child, 'keys') and _nx_class(child) == nx_class]


@dataclass
class Hdf5Scan:
    """One energy scan read out of an HDF5 file."""

    entry: str
    channels: dict = field(default_factory=dict)
    spectra: dict = field(default_factory=dict)
    facility: str = ''
    beamline: str = ''
    sample: str = ''
    title: str = ''
    e0: float | None = None
    overrides: dict = field(default_factory=dict)
    # The 'units' attribute of each channel's dataset, where the file gives one.
    units: dict = field(default_factory=dict)

    def metadata(self) -> dict:
        """What the file says about itself, for the import panel."""
        found = {'entry': self.entry}
        for key in ('facility', 'beamline', 'sample', 'title'):
            if getattr(self, key):
                found[key] = getattr(self, key)
        if self.e0 is not None:
            found['e0'] = self.e0
        if self.spectra:
            found['spectra'] = [{'name': name, 'shape': list(shape)}
                                for name, shape in self.spectra.items()]
            found['note'] = self.spectral_note()
        return found

    def spectral_note(self) -> str:
        """Say that the columns are not the whole measurement.

        A scan with a multi-element detector keeps its signal in a spectrum at
        every energy point, not in a column, and its ion chambers may carry no
        usable edge at all: a sample dilute enough to need a fluorescence
        detector is usually too dilute to measure in transmission. Offering
        the columns without saying this invites the user to plot the noise
        between two monitors and read it as a spectrum.
        """
        named = ', '.join(f'{name} {tuple(shape)}' for name, shape in self.spectra.items())
        return (f'This scan also holds detector spectra ({named}), which are its '
                f'measurement if it was run in fluorescence. The columns below are '
                f'the beam monitors; extract a fluorescence channel from the '
                f'spectra to see the sample.')


def _collect(group, scan_length=None):
    """The 1-D channels and the multi-dimensional spectra of one group.

    A scan's channels all have one value per point, so the length that most
    datasets share is the scan's length and anything else -- a positioner's
    single value, a detector's calibration -- is not a channel.
    """
    arrays, spectra = {}, {}
    for name, node in group.items():
        if not hasattr(node, 'shape') or node.shape is None:
            continue
        if node.dtype.kind not in 'fiu' or not node.shape:
            continue
        if node.ndim > 1:
            spectra[name] = node.shape
        elif not _NOT_A_CHANNEL.match(name):
            arrays[name] = node

    if scan_length is None:
        lengths = Counter(node.shape[0] for node in arrays.values())
        if not lengths:
            return {}, spectra
        scan_length = lengths.most_common(1)[0][0]
    if scan_length < 2:
        return {}, spectra
    channels = {name: np.asarray(node[()], dtype=float)
                for name, node in arrays.items() if node.shape[0] == scan_length}
    spectra = {name: shape for name, shape in spectra.items() if shape[0] == scan_length}
    return channels, spectra


def _entries(handle):
    """The scan entries of a file, the default one first.

    A NeXus file names its preferred entry in the root ``default`` attribute.
    Files that do not are walked in their own order.
    """
    default = _attr(handle, 'default')
    import h5py

    names = list(handle)
    if default in names:
        names = [default] + [name for name in names if name != default]
    found, seen = [], set()
    for name in names:
        node = handle[name]
        if hasattr(node, 'keys'):
            address = h5py.h5o.get_info(node.id).addr
            if address not in seen:
                found.append(name)
                seen.add(address)
    return found


def _signal_group(entry):
    """The NXdata group holding the scan, honouring the entry's own default."""
    data_groups = _groups(entry, 'NXdata')
    default = _attr(entry, 'default')
    if default and default in entry and hasattr(entry[default], 'keys'):
        return entry[default]
    if data_groups:
        return data_groups[0]
    return entry['data'] if 'data' in entry and hasattr(entry['data'], 'keys') else None


# -- the layouts -----------------------------------------------------------

def _match_bluesky(handle, entry):
    """Bluesky's NeXus export: the run's start document is written out in full.

    Nothing else writes an ``instrument/bluesky/metadata`` tree, and that tree
    carries the facility, the beamline and the edge energy the scan was planned
    around, which no other layout here states outright.
    """
    meta = entry.get('instrument/bluesky/metadata')
    if meta is None:
        return None
    group = _signal_group(entry)
    if group is None:
        return None
    channels, spectra = _collect(group)
    e0 = _read(meta, 'start.E0')
    scan = Hdf5Scan(entry.name, channels, spectra,
                    facility=_named(_read(meta, 'start.facility')),
                    beamline=_named(_read(meta, 'start.beamline'))
                    or _read(meta, 'start.beamline_id'),
                    sample=_read(meta, 'start.sample_name'),
                    title=_read(meta, 'start.plan_name'),
                    e0=float(e0) if e0 else None)
    # Bluesky names a chamber for where it stands on the beamline, not for what
    # it measures, so 'IpreKB' -- the last monitor before the sample -- is the
    # incident beam and no channel is called I0 at all.
    if 'IpreKB-net_current' in channels:
        scan.overrides = {'i0': 'iprekb_net_current'}
    return scan


def _match_nxxas(handle, entry):
    """The NXxas application definition, which names each role in its path.

    This is the one layout that does not need guessing: the monochromator
    energy, the incident monitor and the absorbed beam each have a defined
    place, so the roles come from the standard rather than from the labels.
    """
    if _read(entry, 'definition').strip().upper() != 'NXXAS':
        return None
    channels: dict = {}
    overrides = {}
    # The definition fixes each role's place, but it has been through several
    # drafts and each converter followed the one of its year: the incident
    # monitor is 'monitor/data' in the published definition and
    # 'instrument/i0/data' in the files the facilities' own converters write.
    # Both are the standard's statement about the file, so both are read, and
    # the channel keeps the name the file gave it rather than its role.
    for role, label, paths in (('energy', 'energy', ('instrument/monochromator/energy',)),
                               ('i0', 'i0', ('monitor/data', 'instrument/i0/data')),
                               ('transmission', 'itrans', ('instrument/detector/data',
                                                           'instrument/itrans/data')),
                               ('fluorescence', 'ifluor', ('instrument/ifluor/data',)),
                               ('mu', 'intensity', ('intensity',))):
        for path in paths:
            node = entry.get(path)
            if node is None or node.shape is None or node.ndim != 1:
                continue
            channels[label] = np.asarray(node[()], dtype=float)
            if role != 'energy':
                overrides[role] = label
            break
    if 'energy' not in channels:
        return None
    group = _signal_group(entry)
    if group is not None:
        extra, spectra = _collect(group, len(channels['energy']))
        channels.update({name: values for name, values in extra.items()
                         if name not in channels})
    else:
        spectra = {}
    # Where the station is written moved between drafts too, and a file that
    # has no field for it puts the whole beamline into the source's name
    # ('APS, APS undulator A, 13-ID-C'). Read the dedicated fields first, so
    # that a file naming its station is shown as naming it rather than as an
    # APS file of unknown provenance.
    facility = (_read(entry, 'instrument/source/facility_name')
                or _read(entry, 'instrument/source/name'))
    beamline = (_read(entry, 'instrument/name')
                or _read(entry, 'instrument/source/beamline_name')
                or _read(entry, 'instrument/source/beamline')
                or _read(entry, 'instrument/beamline/name'))
    return Hdf5Scan(entry.name, channels, spectra,
                    facility=facility, beamline=beamline,
                    sample=_read(entry, 'sample/name'),
                    title=_read(entry, 'title'),
                    overrides=overrides)


def _match_bliss(handle, entry):
    """ESRF's BLISS: entries named '<scan>.<subscan>' with a 'measurement' group.

    BLISS writes every counter the session had into ``measurement``, so the
    channel names are the beamline's own counter names and the layout itself
    says only that the file came from an ESRF-style BLISS session.
    """
    if not re.fullmatch(r'\d+\.\d+', entry.name.lstrip('/')):
        return None
    group = entry.get('measurement')
    if group is None:
        return None
    channels, spectra = _collect(group)
    instrument = entry.get('instrument')
    beamline = _read(instrument, 'name') if instrument is not None else ''
    return Hdf5Scan(entry.name, channels, spectra,
                    facility=_read(entry, 'instrument/source/name'),
                    beamline=beamline or _read(entry, 'instrument/machine/name'),
                    sample=_read(entry, 'sample/name'),
                    title=_read(entry, 'title'))


def _match_soleil(handle, entry):
    """SOLEIL's Flyscan and Scan servers write their counters to 'scan_data'."""
    group = entry.get('scan_data')
    if group is None:
        return None
    channels, spectra = _collect(group)
    return Hdf5Scan(entry.name, channels, spectra,
                    facility=_read(entry, 'instrument/source/name') or 'SOLEIL',
                    beamline=_read(entry, 'instrument/name'),
                    sample=_read(entry, 'sample/name'),
                    title=_read(entry, 'title'))


def _match_nxdata(handle, entry):
    """Any NeXus file: the NXdata group the entry itself points at.

    Diamond's GDA, PETRA III's online data analysis and most other NeXus
    writers differ in where they put their metadata but agree on this much, so
    one reader covers them and names only what the file actually states.
    """
    group = _signal_group(entry)
    if group is None:
        return None
    channels, spectra = _collect(group)
    if not channels:
        return None
    return Hdf5Scan(entry.name, channels, spectra,
                    facility=_read(entry, 'instrument/source/name'),
                    beamline=_read(entry, 'instrument/name'),
                    sample=_read(entry, 'sample/name'),
                    title=_read(entry, 'title'))


@dataclass(frozen=True)
class Hdf5Layout:
    """One facility's way of arranging an energy scan inside HDF5."""

    ident: str
    name: str
    facility: str
    beamline: str
    fmt: str
    evidence: str
    match: Callable


LAYOUTS = (
    Hdf5Layout('bluesky-nexus', 'Bluesky NeXus export', '', '', 'NeXus/HDF5 (Bluesky)',
               "the 'instrument/bluesky/metadata' start document", _match_bluesky),
    Hdf5Layout('nxxas', 'NXxas application definition', '', '', 'NeXus/HDF5 (NXxas)',
               "the entry's definition field naming NXxas", _match_nxxas),
    Hdf5Layout('esrf-bliss', 'ESRF BLISS scan', 'ESRF', '', 'NeXus/HDF5 (BLISS)',
               "a '<scan>.<subscan>' entry holding a 'measurement' group", _match_bliss),
    Hdf5Layout('soleil-nexus', 'SOLEIL scan server file', 'SOLEIL', '', 'NeXus/HDF5 (SOLEIL)',
               "the 'scan_data' group SOLEIL's scan servers write", _match_soleil),
    Hdf5Layout('nxdata', 'NeXus NXdata scan', '', '', 'NeXus/HDF5',
               'an NXdata group of equal-length channels', _match_nxdata),
)


def read_hdf5(data: bytes, *, settings=None):
    """Read the first readable scan of an HDF5 upload.

    Returns the layout that recognized it and the scan itself, or None when
    the file holds nothing that looks like an energy scan.
    """
    import h5py

    with h5py.File(io.BytesIO(data), 'r') as handle:
        validate_handle(handle, settings)
        for name in _entries(handle):
            entry = handle[name]
            for layout in LAYOUTS:
                try:
                    scan = layout.match(handle, entry)
                except (KeyError, OSError, ValueError, TypeError):
                    continue
                if scan is not None and len(scan.channels) >= 2:
                    scan.units = _channel_units(entry, scan)
                    return layout, scan
    return None


def _channel_units(entry, scan) -> dict:
    """The units each channel's dataset declares, found by the dataset's name.

    Values were read without their attributes, and the converted table then
    called its first column eV: an NXxas energy stored in keV became a scan
    over a few electronvolts.
    """
    found = {}
    length = len(next(iter(scan.channels.values())))

    def visit(name, node):
        base = name.rsplit('/', 1)[-1]
        label = 'energy' if name.endswith('monochromator/energy') else base
        if label in scan.channels and label not in found and hasattr(node, 'shape') \
                and node.shape is not None and node.ndim == 1 and node.shape[0] == length:
            units = _attr(node, 'units') or _attr(node, 'unit')
            if units:
                found[label] = units.strip()
    entry.visititems(visit)
    return found


def _energy_units(text: str) -> str | None:
    """'eV' or 'keV' for a declared energy unit, None for anything else."""
    return {'ev': 'eV', 'electronvolt': 'eV', 'kev': 'keV', 'kiloelectronvolt': 'keV'}.get(text.strip().lower())


def _column_text(scan: Hdf5Scan) -> bytes:
    """The scan as a column table, in the form Larch's own parser reads.

    Writing the arrays out as text rather than handing them over directly is
    what lets an HDF5 upload use the column chooser, the preview and the import
    path already built for text files.
    """
    names = list(scan.channels)
    rows = np.column_stack([scan.channels[name] for name in names])
    lines = [f'# {scan.title or "scan"} from {scan.entry}']
    for key, value in scan.metadata().items():
        if key in {'entry', 'spectra'}:
            continue
        lines.append(f'# {key.capitalize()}: {value}')
    declared = {name: scan.units[name] for name in names if name in scan.units}
    if declared:
        lines.append('# Units: ' + ', '.join(f'{name} [{units}]' for name, units in declared.items()))
    lines.append('# ' + '\t'.join(names))
    body = '\n'.join('\t'.join(f'{value:.8g}' for value in row) for row in rows)
    return ('\n'.join(lines) + '\n' + body + '\n').encode('utf-8')


def unreadable_hdf5_message(data: bytes, filename: str, *, settings=None) -> str:
    """Say what an HDF5 file holds when it holds no scan this reader opens.

    Without this, a per-scan detector file dropped on Import fell through to
    the text parser and was refused for containing NUL bytes, which says
    nothing about what the file is or where its scan is.
    """
    import h5py

    spectra, other = [], []
    with h5py.File(io.BytesIO(data), 'r') as handle:
        validate_handle(handle, settings)
        def visit(name, node):
            if not hasattr(node, 'shape') or node.shape is None or node.dtype.kind not in 'fiu':
                return
            # A spectrum per point: two real dimensions, the last a channel axis.
            dims = [n for n in node.shape if n > 1]
            (spectra if len(dims) >= 2 and dims[-1] >= 256 else other).append((name, node.shape))
        handle.visititems(visit)
    if not spectra:
        return ('This HDF5 file holds no energy scan the importer can read: no group of equal-length channels '
                'with an energy axis was found.')
    shape = ' × '.join(str(n) for n in spectra[0][1] if n > 1)
    named = (f"'{spectra[0][0]}'" if len(spectra) == 1 else f"'{spectra[0][0]}' … '{spectra[-1][0]}'")
    stem = re.sub(r'\.(hdf5?|h5|nxs)$', '', filename, flags=re.I)
    scan = (f" Its scan table is usually the text file '{stem}', imported on its own."
            if stem != filename else '')
    return (f'This HDF5 file holds detector spectra, not a scan table: {len(spectra)} multichannel '
            f'detector array{"s" if len(spectra) > 1 else ""} ({named}, {shape} each) and no energy column '
            f'the importer reads.{scan} Detector spectra belong in the XRF panels of the Process menu, '
            'which open the HDF5 layouts they list.')


def prepare_hdf5(data: bytes, *, settings=None):
    """Convert an HDF5 upload to the prepared column file the importer expects.

    Returns None when the bytes are not HDF5 or hold no energy scan, so the
    caller falls through to the text path unchanged.
    """
    if not is_hdf5(data):
        return None
    found = read_hdf5(data, settings=settings)
    if found is None:
        return None
    layout, scan = found
    from .athena_file_plugins import PreparedFile

    # 'binary' puts a hex dump rather than mojibake in the source preview;
    # 'hdf5_layout' tells the importer these columns are this module's to name.
    metadata = {'hdf5_layout': layout.ident, 'name': layout.name, 'format': layout.fmt,
                'binary': True, **scan.metadata()}
    # The numerator and denominator the dataclass carries are Athena's own
    # defaults; the registry names the real channels further down the import.
    # Energy units travel as the file declared them; keV is converted at
    # import, explicitly. A channel declaring none is left for the user.
    units = {index: _energy_units(scan.units[name]) for index, name in enumerate(scan.channels)
             if name in scan.units and _energy_units(scan.units[name])}
    if units:
        metadata['declared_units'] = {name: scan.units[name] for name in scan.channels if name in scan.units}
    return PreparedFile(_column_text(scan), metadata, 1, 2, column_units=units)


def identify_hdf5(data: bytes, *, settings=None) -> dict | None:
    """Name the facility, beamline and layout of an HDF5 upload."""
    if not is_hdf5(data):
        return None
    found = read_hdf5(data, settings=settings)
    if found is None:
        return None
    layout, scan = found
    facility = scan.facility or layout.facility
    beamline = scan.beamline or layout.beamline
    found = {'id': layout.ident, 'name': layout.name, 'facility': facility,
             'beamline': beamline, 'format': layout.fmt, 'evidence': layout.evidence,
             'overrides': dict(scan.overrides),
             'confidence': 'beamline' if beamline else 'format'}
    if scan.spectra:
        found['note'] = scan.spectral_note()
    return found


def layout_catalog() -> list[dict]:
    """Every HDF5 layout the reader knows, for the supported-formats view."""
    return [{'id': layout.ident, 'name': layout.name, 'facility': layout.facility,
             'beamline': layout.beamline, 'format': layout.fmt, 'evidence': layout.evidence}
            for layout in LAYOUTS]
