"""Readers checked against public example files that live outside the repository.

These files were fetched from the facilities' and the IXAS NXxas working
group's own download pages. Their licences are not stated, so they are not
copied into the repository: they are read from the directory named by
``WEBLARCH_PUBLIC_EXAMPLES``, and every test here skips when it is unset or
absent. Nothing in the repository depends on them.

What they are evidence for:

* ``co_metal_rt.nxs``, ``NXxas_examples/`` -- real scans converted to the NXxas
  application definition by three different converters, so they are evidence
  about the *layout*, and about the parts of the metadata each converter
  chose to write. They are not files a beamline writes directly.
* ``NXxas_examples/KEK_PFdata/`` -- a real Photon Factory 9A scan in three
  forms: as the 9809 collector wrote it (byte for byte the repository's own
  ``examples/xafsdata/beamlines/PF9A_2022.dat``), and the facility's two
  conversions of it, to XDI and to NeXus. That is the one case here where the
  same measurement exists more than once, so the reader's channel mapping can
  be checked against the facility's own reading of its file rather than
  against itself. The channels agree; the energy axis does not, and the last
  test here says which of them is right and how that was settled.
"""
import os
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog, prepare_file
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.parsing import parse_upload

PUBLIC = Path(os.environ.get('WEBLARCH_PUBLIC_EXAMPLES', ''))

pytestmark = pytest.mark.skipif(
    not os.environ.get('WEBLARCH_PUBLIC_EXAMPLES') or not PUBLIC.is_dir(),
    reason='set WEBLARCH_PUBLIC_EXAMPLES to a directory holding the public example files')

KEK_RAW = 'NXxas_examples/KEK_PFdata/PF9A_2022.dat'
KEK_XDI = 'NXxas_examples/KEK_PFdata/PF9A_2022_new.dat'
KEK_NEXUS = 'NXxas_examples/KEK_PFdata/Fe_XAS_PF9A_nexus.h5'


@pytest.fixture
def inspect(tmp_path):
    """Open a public file through the import path the browser uses."""
    settings = Settings(data_root=tmp_path / 'store')
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    store = AthenaStore(settings)
    project = store.create()

    def run(name):
        path = PUBLIC / name
        result = store.inspect(project['id'], path.read_bytes(), path.name)
        labels = {column['column_id']: column['name'] for column in result['columns']}

        def spell(value):
            if isinstance(value, list):
                return [labels.get(item, item) for item in value]
            return labels.get(value, value)

        reader = dict(result['beamline_reader'])
        reader['roles'] = {role: spell(value) for role, value in reader['roles'].items()}
        reader['chosen'] = {key: spell(value) if key in ('numerator', 'denominator',
                                                         'energy_column') else value
                            for key, value in result['athena_suggestion'].items()}
        reader['columns'] = list(labels.values())
        return reader

    return run


def columns_of(name):
    """The named columns of a text file, as the import path produces them.

    The 9809 collector's own format is not a column file -- its header rows
    carry numbers too -- and reaches the column parser only after its plugin
    has converted it, which is also what the browser does with it.
    """
    data = (PUBLIC / name).read_bytes()
    prepared = prepare_file(data, max_bytes=len(data) + 1, max_points=100000, max_columns=64)
    parsed = parse_upload(prepared.data if prepared is not None else data, Path(name).name)
    return {column.name: parsed.arrays[column.column_id] for column in parsed.columns}


# -- NXxas, as three converters actually write it --------------------------

@pytest.mark.parametrize('name, facility, beamline', [
    ('co_metal_rt.nxs', 'APS', '13-ID-C'),
    (KEK_NEXUS, 'Photon Factory', 'BL9A'),
    ('NXxas_examples/Fe_XDIFiles/fe_xas_nexus.h5', 'APS', '13-BM-D'),
])
def test_an_nxxas_file_is_credited_with_the_station_it_names(name, facility, beamline, inspect):
    """Every one of these files names its station, in a different field.

    The definition has been through several drafts and each converter wrote
    the station where its draft put it, so a reader that knows only one place
    reports 'no beamline' for files that state one plainly -- or, for the
    GSECARS file, reports the whole sentence 'APS, APS undulator A, 13-ID-C'
    as the facility and no station at all. A station read from the file is
    also the difference between a recognition the user can trust and one
    offered as the format's usual.
    """
    reader = inspect(name)

    assert (reader['facility'], reader['beamline']) == (facility, beamline)
    assert reader['confidence'] == 'beamline'


@pytest.mark.parametrize('name, measured, monitors', [
    ('co_metal_rt.nxs', 'mutrans', ['i0', 'itrans']),
    (KEK_NEXUS, 'intensity', ['i0', 'ifluor']),
    ('NXxas_examples/Fe_XDIFiles/fe_xas_nexus.h5', 'intensity', ['i0', 'itrans']),
])
def test_an_nxxas_file_offers_its_monitors_beside_the_absorption_it_declares(
        name, measured, monitors, inspect):
    """The converted mu is the import, and the raw monitors stay available.

    These files carry both: the absorption the converter computed, and the
    counts it computed it from. Reading only the plot group drops the
    monitors, which leaves a user who distrusts a converted spectrum -- and in
    the Fe2O3 entry of the XDI conversion there is reason to, its stored
    intensity and its own itrans disagree -- with nothing to recompute from.
    Reading only the monitors is worse: it would divide two counters at a
    beamline whose detector layout the file does not describe.
    """
    reader = inspect(name)

    assert reader['roles']['mu'] == measured
    assert reader['chosen']['numerator'] == [measured]
    assert reader['chosen']['denominator'] is None
    assert set(monitors) <= set(reader['columns'])


# -- the one scan that exists in two formats -------------------------------

def test_the_facility_reads_its_own_9809_counters_the_way_the_registry_does(inspect):
    """The facility published this scan converted; it divided I1 by I0.

    ``test_a_photon_factory_fluorescence_scan_does_not_make_its_detector_a_
    transmission`` settles the mapping from the file's own station line and
    from the edge, with the original that the repository carries. This is the
    outside confirmation of it: the Photon Factory's own XDI conversion of
    this same scan has a 'norm' column, and I1/I0 reproduces it (correlation
    0.9998) where ln(I0/I1), the transmission reading, anticorrelates with it.
    """
    reader = inspect(KEK_RAW)
    raw, published = columns_of(KEK_RAW), columns_of(KEK_XDI)

    assert reader['roles']['fluorescence'] == ['i1']
    assert np.corrcoef(raw['i1'] / raw['i0'], published['norm'])[0, 1] > 0.999
    assert np.corrcoef(np.log(raw['i0'] / raw['i1']), published['norm'])[0, 1] < -0.9


def test_the_energy_axis_read_from_the_original_is_the_one_the_angles_support(inspect):
    """The .dat and its two conversions must not be three different scans.

    The counts survive conversion exactly -- the NeXus file's i0 and ifluor
    are the original's columns 4 and 5 point for point -- but the energy axis
    does not: the facility's conversion is up to 51 eV below the original,
    which is the difference between an Fe K edge and no Fe K edge. The
    original's own axis is the one to believe, by two independent readings of
    this file: it agrees to 0.07 eV with the Bragg energy of the angles the
    conversion itself recorded, under the d-spacing the header states, and it
    puts the edge at 7122 eV, where an Fe foil's is. On the converted axis the
    same point sits at 7078 eV, 34 eV below the edge of the element measured.

    So this test is not a check on the converted file; it is the check that
    our reading of the 9809 original stays the physically right one, and that
    nothing later 'corrects' it toward the published conversion.
    """
    from xraylarch_web.hdf5_readers import read_hdf5

    raw = columns_of(KEK_RAW)
    _, scan = read_hdf5((PUBLIC / KEK_NEXUS).read_bytes())
    energy = raw['energy_attained']
    # 12398.419 eV A / 2 d sin(theta): the monochromator equation, with the
    # Si(111) spacing the file's own header gives.
    from_angle = 12398.419 / (2 * 3.13551 * np.sin(np.radians(columns_of(KEK_XDI)['angle_read'])))
    fine = slice(85, 85 + 1050)  # the 0.1 eV block, so no step change fakes a derivative

    assert np.allclose(scan.channels['i0'], raw['i0'])
    assert np.allclose(scan.channels['ifluor'], raw['i1'])
    assert np.abs(from_angle - energy).max() < 0.1
    assert np.abs(from_angle - scan.channels['energy']).max() > 40.
    edge = energy[fine][np.argmax(np.gradient(raw['i1'][fine] / raw['i0'][fine]))]
    assert edge == pytest.approx(7122., abs=5.)
