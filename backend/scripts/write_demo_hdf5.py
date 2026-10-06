"""Write one synthetic HDF5 scan per NeXus layout the readers support.

No public HDF5 example from these facilities could be fetched into this
environment, and the repository carries none, so the files written here stand
in for them: each is written to the layout its facility documents -- the group
names, the entry naming, where the metadata lives -- and carries a Mn K edge
of known height. They are useful for a demonstration and for the layout tests
in ``tests/test_hdf5_readers.py``, which import these writers, but they are
not evidence that the readers open that facility's real files.

Run from the repository root:
  backend/.venv/bin/python backend/scripts/write_demo_hdf5.py --output hdf5-examples
"""
import argparse
from pathlib import Path

import h5py
import numpy as np

E0 = 6539.0
EDGE_STEP = 0.8


def mn_k_scan(points=301):
    """An energy scan with a Mn K edge of known height.

    I0 falls smoothly with energy, as a real ion chamber's response does, so a
    reader that divides the wrong way round or picks the wrong incident
    channel cannot recover the right edge by accident.
    """
    energy = np.linspace(6400., 7200., points)
    i0 = 1.0e-6 * np.exp(-(energy - 6400.) / 9000.)
    mu = EDGE_STEP / (1. + np.exp(-(energy - E0) / 2.)) + 0.1
    return energy, i0, i0 * np.exp(-mu)


def nxxas(path):
    """The NXxas application definition: each role has a defined path."""
    energy, i0, it = mn_k_scan()
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('entry')
        entry.attrs['NX_class'] = 'NXentry'
        entry['definition'] = 'NXxas'
        entry['title'] = 'Mn K edge, MnO powder'
        mono = entry.create_group('instrument/monochromator')
        mono.attrs['NX_class'] = 'NXmonochromator'
        mono['energy'] = energy
        mono['energy'].attrs['units'] = 'eV'
        entry['instrument/name'] = 'BM31'
        entry['instrument/source/name'] = 'ESRF'
        entry['monitor/data'] = i0
        entry['instrument/detector/data'] = it
        entry['sample/name'] = 'MnO'
    return path


def bliss(path):
    """ESRF BLISS: a '<scan>.<subscan>' entry with a 'measurement' group."""
    energy, i0, it = mn_k_scan()
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('3.1')
        entry.attrs['NX_class'] = 'NXentry'
        entry['title'] = 'ascan energy 6400 7200 300 0.1'
        entry['instrument/name'] = 'BM23'
        entry['instrument/source/name'] = 'ESRF'
        entry['sample/name'] = 'MnO'
        measurement = entry.create_group('measurement')
        measurement.attrs['NX_class'] = 'NXcollection'
        measurement['energy'] = energy
        measurement['I0'] = i0
        measurement['It'] = it
        measurement['elapsed_time'] = np.linspace(0., 30., len(energy))
    return path


def soleil(path):
    """SOLEIL's scan servers write their counters into 'scan_data'."""
    energy, i0, it = mn_k_scan()
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('scan_17')
        entry.attrs['NX_class'] = 'NXentry'
        entry['title'] = 'Mn K edge'
        entry['instrument/name'] = 'SAMBA'
        entry['sample/name'] = 'MnO'
        data = entry.create_group('scan_data')
        data.attrs['NX_class'] = 'NXdata'
        data['energy'] = energy
        data['I0'] = i0
        data['I1'] = it
    return path


def nxdata(path):
    """A plain NeXus file: an entry pointing at its own NXdata group.

    This is the fallback that covers the writers -- Diamond's GDA, PETRA III's
    online analysis -- which agree on NXdata and differ everywhere else.
    """
    energy, i0, it = mn_k_scan()
    with h5py.File(path, 'w') as handle:
        entry = handle.create_group('entry1')
        entry.attrs['NX_class'] = 'NXentry'
        entry.attrs['default'] = 'xas'
        entry['instrument/name'] = 'B18'
        entry['instrument/source/name'] = 'Diamond Light Source'
        entry['sample/name'] = 'MnO'
        data = entry.create_group('xas')
        data.attrs['NX_class'] = 'NXdata'
        data.attrs['signal'] = 'It'
        data.attrs['axes'] = 'energy'
        data['energy'] = energy
        data['I0'] = i0
        data['It'] = it
    return path


LAYOUT_FILES = {'nxxas': nxxas, 'esrf-bliss': bliss,
                'soleil-nexus': soleil, 'nxdata': nxdata}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True,
                        help='directory to write the scans into')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for layout, write in sorted(LAYOUT_FILES.items()):
        path = write(args.output / f'synthetic_{layout.replace("-", "_")}.nxs')
        print(path)


if __name__ == '__main__':
    main()
