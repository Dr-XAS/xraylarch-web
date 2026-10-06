"""Reading an XAS scan out of HDF5, whatever layout its facility chose.

Every facility arranges a NeXus scan differently, and a reader that works on
one file is no evidence about the others. The files read here are the
synthetic ones ``scripts/write_demo_hdf5.py`` writes: each follows the layout
its facility documents -- the group names, the entry naming, the places the
metadata lives -- and carries a Mn K edge of known height, so a test that
fails names either a layout the walker missed or a channel it mapped to the
wrong role.

They are not a substitute for real files; public NXxas examples are read in
``test_public_example_files.py`` when a copy is on the machine.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

h5py = pytest.importorskip('h5py')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from write_demo_hdf5 import E0, EDGE_STEP, LAYOUT_FILES, mn_k_scan
from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.hdf5_readers import identify_hdf5, is_hdf5, layout_catalog, read_hdf5

def edge_step(energy, mu, e0=E0):
    """The edge height above the pre-edge line, as an analysis would read it."""
    below = (energy > e0 - 120.) & (energy < e0 - 20.)
    above = (energy > e0 + 40.) & (energy < e0 + 140.)
    slope, intercept = np.polyfit(energy[below], mu[below], 1)
    flat = mu - (slope * energy + intercept)
    return float(flat[above].mean())


@pytest.fixture
def written(tmp_path):
    def build(layout):
        return LAYOUT_FILES[layout](tmp_path / f'{layout}.nxs').read_bytes()
    return build


@pytest.fixture
def inspect(tmp_path):
    """Open bytes through the real import path, as the browser does."""
    settings = Settings(data_root=tmp_path / 'store')
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    store = AthenaStore(settings)
    project = store.create()

    def run(data, name='scan.nxs'):
        result = store.inspect(project['id'], data, name)
        labels = {column['column_id']: column['name'] for column in result['columns']}

        def spell(value):
            if isinstance(value, list):
                return [labels.get(item, item) for item in value]
            return labels.get(value, value)

        reader = dict(result['beamline_reader'])
        reader['roles'] = {role: spell(value) for role, value in reader['roles'].items()}
        result['beamline_reader'] = reader
        result['labels'] = labels
        return result

    return run


# -- the walker finds the scan wherever the layout put it ------------------

@pytest.mark.parametrize('layout', sorted(LAYOUT_FILES))
def test_each_layout_is_recognized_by_what_only_it_writes(layout, written):
    found = identify_hdf5(written(layout))
    assert found['id'] == layout


@pytest.mark.parametrize('layout', sorted(LAYOUT_FILES))
def test_the_import_path_maps_the_roles_and_offers_the_right_division(layout, written, inspect):
    """Opening the file must name the incident and transmitted beams.

    The roles are what the column chooser is filled from, so a layout that is
    recognized but whose channels land in the wrong roles still gives the user
    the wrong spectrum.
    """
    result = inspect(written(layout))
    roles = result['beamline_reader']['roles']
    chosen = result['athena_suggestion']
    labels = result['labels']

    assert result['row_count'] == 301
    assert roles['energy'] == 'energy'
    assert roles['i0'] in ('i0', 'monitor')
    assert roles['transmission'] in ('it', 'i1', 'itrans')
    assert chosen['mode'] == 'transmission'
    assert [labels[c] for c in chosen['numerator']] == [roles['i0']]
    assert labels[chosen['denominator']] == roles['transmission']


@pytest.mark.parametrize('layout', sorted(LAYOUT_FILES))
def test_the_converted_table_reproduces_the_edge_it_was_written_with(layout, written):
    """The column table the browser receives must carry the original edge.

    An HDF5 scan reaches the rest of the app as text, so every way the
    conversion could corrupt it -- a transposed array, a dropped column, too
    few digits written out -- shows up as an edge of the wrong height. The
    check goes through the same text the importer parses, not through the
    arrays the reader held in memory.
    """
    from xraylarch_web.hdf5_readers import _column_text
    from xraylarch_web.parsing import parse_upload

    layout_found, scan = read_hdf5(written(layout))
    assert layout_found.ident == layout

    parsed = parse_upload(_column_text(scan), f'{layout}.dat')
    arrays = {column.name.lower(): parsed.arrays[column.column_id]
              for column in parsed.columns}
    incident = arrays.get('i0', arrays.get('monitor'))
    transmitted = arrays.get('it', arrays.get('i1', arrays.get('itrans')))

    assert parsed.row_count == 301
    assert edge_step(arrays['energy'], np.log(incident / transmitted)) == pytest.approx(
        EDGE_STEP, abs=0.03)


def test_a_counter_clock_is_not_imported_as_a_detector_channel(written):
    """BLISS writes 'elapsed_time' beside the counters; it measures no beam."""
    _, scan = read_hdf5(written('esrf-bliss'))
    assert 'elapsed_time' not in scan.channels


def test_a_scan_with_a_detector_cube_says_its_columns_are_not_the_measurement(tmp_path):
    """A fluorescence scan's ion chambers can carry no usable edge at all.

    The sample is dilute enough to need a multi-element detector, so the
    transmission the two chambers support may be pure noise. Converting the
    file to columns and saying nothing else would offer that noise as the
    file's spectrum, so the reader names the cube it set aside.
    """
    energy, i0, it = mn_k_scan()
    path = tmp_path / 'fluorescence.nxs'
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('entry')
        entry.attrs['NX_class'] = 'NXentry'
        entry.attrs['default'] = 'data'
        data = entry.create_group('data')
        data.attrs['NX_class'] = 'NXdata'
        data['energy'] = energy
        data['I0'] = i0
        data['It'] = it
        data['xspress3'] = np.zeros((len(energy), 4, 4096))

    _, scan = read_hdf5(path.read_bytes())
    assert scan.spectra == {'xspress3': (301, 4, 4096)}
    assert 'xspress3' in identify_hdf5(path.read_bytes())['note']


def test_a_scan_of_columns_alone_is_given_no_such_warning(written):
    assert 'note' not in identify_hdf5(written('nxdata'))


def test_a_file_that_is_not_hdf5_is_left_to_the_text_readers():
    assert not is_hdf5(b'# XDI/1.0\n# Facility.name: APS\n')
    assert identify_hdf5(b'# XDI/1.0\n') is None


def test_an_hdf5_file_holding_no_scan_is_not_claimed(tmp_path):
    """An HDF5 file of images and settings must not be read as a spectrum."""
    path = tmp_path / 'not-a-scan.h5'
    with h5py.File(path, 'w') as handle:
        handle['settings/exposure'] = 0.5
        handle['frames'] = np.zeros((4, 8, 8))
    assert identify_hdf5(path.read_bytes()) is None


def test_every_layout_appears_in_the_catalog():
    identifiers = {entry['id'] for entry in layout_catalog()}
    assert identifiers >= set(LAYOUT_FILES) | {'bluesky-nexus'}


# -- units, unreadable files and damaged channels ---------------------------

def nxxas_scan(path, *, units='eV', scale=1., spoil=None):
    energy, i0, it = mn_k_scan()
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('entry')
        entry.attrs['NX_class'] = 'NXentry'
        entry['definition'] = 'NXxas'
        entry['instrument/monochromator/energy'] = energy * scale
        if units:
            entry['instrument/monochromator/energy'].attrs['units'] = units
        if spoil is not None:
            it = it.copy(); it[spoil] = np.nan
        entry['monitor/data'] = i0
        entry['instrument/detector/data'] = it
        entry['instrument/ifluor/data'] = np.where(np.isnan(it), 1., i0 * 0.1)
    return path.read_bytes()


def import_suggested(tmp_path, data, name='scan.nxs'):
    store = AthenaStore(Settings(data_root=tmp_path / 'units'))
    project = store.create()
    inspected = store.inspect(project['id'], data, name)
    from xraylarch_web.athena import ImportRequest
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], **inspected['athena_suggestion'])
    return inspected, store.import_data(project['id'], request)['groups'][0]


def test_an_nxxas_energy_stored_in_kev_is_converted_to_ev_not_read_as_ev(tmp_path):
    # The conversion dropped the units attribute and called the first column
    # eV, so a keV axis became a scan over a few electronvolts.
    inspected, group = import_suggested(tmp_path, nxxas_scan(tmp_path / 'kev.nxs', units='keV', scale=1e-3))
    assert inspected['athena_suggestion']['units'] == 'keV'
    assert group['energy'][0] == pytest.approx(6400.) and group['energy'][-1] == pytest.approx(7200.)
    assert abs(group['result']['effective']['e0'] - E0) < 3


def test_an_energy_without_declared_units_is_flagged_for_the_user(tmp_path):
    inspected, _ = import_suggested(tmp_path, nxxas_scan(tmp_path / 'bare.nxs', units=None))
    assert any('declares no units for its energy' in w for w in inspected['warnings'])


def test_a_nan_in_one_hdf5_channel_does_not_refuse_the_other_channels(tmp_path):
    # The converter writes 'nan' into its table; any NaN used to refuse the file.
    inspected, group = import_suggested(tmp_path, nxxas_scan(tmp_path / 'nan.nxs', spoil=150))
    assert len(group['energy']) == 300
    assert any('Dropped 1 rows' in w for w in group['source']['warnings'])


def test_a_detector_only_hdf5_file_says_what_it_holds_instead_of_nul_bytes(tmp_path):
    path = tmp_path / 'sample_Cu_EXAFS.0017.hdf5'
    with h5py.File(path, 'w') as handle:
        for n in range(1, 4):
            handle[f'1D Scan/MCA {n}'] = np.zeros((1, 50, 1024), dtype='int32')
        handle['1D Scan/X Positions'] = np.zeros((1, 50, 2))
    store = AthenaStore(Settings(data_root=tmp_path / 'store'))
    project = store.create()
    from xraylarch_web.errors import WebInputError
    with pytest.raises(WebInputError, match="holds detector spectra.*'sample_Cu_EXAFS.0017'.*XRF panels"):
        store.inspect(project['id'], path.read_bytes(), path.name)
