"""Write a synthetic fluorescence scan in the beamline's HDF5 layout.

The HTTP tests and the browser test need the same upload: a whole energy scan
of spectra drawn from Larch's own XRF model, laid out the way the beamline
writes one. Keeping the generator here means both read the same file format,
and running this module as a script is how the browser test -- which cannot
import Python -- gets its scan and the settings that go with it.
"""
import io
import json
import sys

import numpy as np

from test_athena_xrf_xas import CHANNELS, E0, synthetic_scan

DETECTOR_CHANNELS = 800          # wider than the fit window, as a real detector is


def scan_file(scan, counts):
    """Serialise the synthetic scan into the beamline's HDF5 layout."""
    import h5py

    points, elements, width = counts.shape
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        entry = handle.create_group('synthetic')
        data = entry.create_group('data')
        data['energy'] = scan['energy_ev']
        full = np.zeros((points, elements, DETECTOR_CHANNELS))
        full[:, :, CHANNELS[0]:CHANNELS[0] + width] = counts
        data['ge'] = full
        data['i0'] = scan['channels']['i0']
        primary = entry.create_group('instrument/bluesky/streams/primary')
        for index in range(elements):
            factors = primary.create_group(f'ge-element{index}-deadtime_factor')
            factors['value'] = scan['deadtime']['ge'][:, index]
    return buffer.getvalue()


def twenty_bm_file(scan, counts, shifts=None):
    """The same scan in the APS 20-BM LabVIEW detector-file layout: one
    '1D Scan' group, each element a separate 'MCA n' array shaped (1, points,
    channels), the energy in 'X Positions', every scaler under 'Detectors'
    shaped (1, points). `shifts` maps an element to channels its spectrum is
    written *higher* than the others, as a misaligned element is recorded."""
    import h5py

    points, elements, width = counts.shape
    shifts = shifts or {}
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        group = handle.create_group('1D Scan')
        group.attrs['AUTODTCORR'] = 'NO'
        positions = np.zeros((1, points, 2), dtype=np.float32)
        positions[0, :, 0] = scan['energy_ev']
        positions[0, :, 1] = 1.0
        group['X Positions'] = positions
        group['X Positions'].attrs['Motor Info'] = np.array(
            [['Mono Energy *', ''], ['Scaler preset time *', '']], dtype=object)
        detectors = group.create_group('Detectors')
        detectors['I0'] = scan['channels']['i0'][None, :].astype(np.float32)
        detectors['XMAP12B:DT Corr I0 '] = scan['channels']['i0'][None, :].astype(np.float32)
        for index in range(elements):
            start = CHANNELS[0] + shifts.get(index, 0)
            full = np.zeros((1, points, DETECTOR_CHANNELS), dtype=np.int32)
            full[0, :, start:start + width] = counts[:, index, :]
            group[f'MCA {index + 1}'] = full
    return buffer.getvalue()


# A detector three times coarser than the model's, as 20-BM's binned XMAP is:
# every three channels summed, so its calibration is known exactly.
BIN = 3


def binned_calibration():
    from test_athena_xrf_xas import TRUE_SHAPE
    return TRUE_SHAPE['cal_offset'] + TRUE_SHAPE['cal_slope'], BIN * TRUE_SHAPE['cal_slope']


def binned_spectra(points=24, detectors=2):
    """A synthetic Mn scan summed three channels at a time: (scan, spectra)."""
    scan, counts, _, _ = synthetic_scan(points=points, detectors=detectors, calibration_points=3)
    full = np.zeros((counts.shape[0], counts.shape[1], DETECTOR_CHANNELS))
    full[:, :, CHANNELS[0]:CHANNELS[0] + counts.shape[2]] = counts
    usable = DETECTOR_CHANNELS // BIN * BIN
    spectra = full[:, :, :usable].reshape(counts.shape[0], counts.shape[1], -1, BIN).sum(axis=3)
    return scan, np.round(spectra).astype(np.int32)


def binned_channel(kev):
    offset, slope = binned_calibration()
    return (kev - offset) / slope


LINE_WINDOWS = (('MnKa', 5.8988), ('CrKa', 5.4147))


def binned_twenty_bm_file(scan, spectra, *, line_windows=True, windows=LINE_WINDOWS, order=None,
                          channel_of=binned_channel):
    """The binned scan in 20-BM's layout, with the beamline's line windows the
    way its control program writes them: one sum per element per line, named
    from 0 while the MCA records are numbered from 1."""
    import h5py

    points, elements, _ = spectra.shape
    # `order` writes the points in another order (reversed, shuffled), as a
    # scan recorded downward in energy is.
    order = np.arange(points) if order is None else np.asarray(order)
    energy, i0, spectra = scan['energy_ev'][order], scan['channels']['i0'][order], spectra[order]
    buffer = io.BytesIO()
    pvs = []
    with h5py.File(buffer, 'w') as handle:
        group = handle.create_group('1D Scan')
        group.attrs['AUTODTCORR'] = 'NO'
        positions = np.zeros((1, points, 2), dtype=np.float32)
        positions[0, :, 0] = energy
        positions[0, :, 1] = 1.0
        group['X Positions'] = positions
        group['X Positions'].attrs['Motor Info'] = np.array(
            [['Mono Energy *', ''], ['Scaler preset time *', '']], dtype=object)
        detectors = group.create_group('Detectors')
        detectors['I0'] = i0[None, :].astype(np.float32)
        for index in range(elements):
            group[f'MCA {index + 1}'] = spectra[None, :, index, :]
            if line_windows:
                for record, (name, kev) in enumerate(windows, start=7):
                    centre = int(round(channel_of(kev)))
                    lo, hi = centre - 5, centre + 6
                    label = f'XMAP12B:{index}:{name}'
                    detectors[label] = spectra[None, :, index, lo:hi].sum(axis=2).astype(np.float32)
                    pvs.append(f'{label}/20xmap12b:mca{index + 1}.R{record}')
        group.attrs['Header'] = '# Detector Names/PVs:\r\n# ' + '  '.join(pvs) + '\r\n'
    return buffer.getvalue()


def main(path, points, layout='nexus'):
    if layout == 'binned-20bm':
        scan, spectra = binned_spectra(points=points)
        with open(path, 'wb') as handle:
            handle.write(binned_twenty_bm_file(scan, spectra))
        offset, slope = binned_calibration()
        print(json.dumps(dict(points=points, target='Mn', matrix='Fe, Cr', e0=E0,
                              cal_offset=offset, cal_slope=slope,
                              target_channel=binned_channel(5.8988))))
        return

    scan, counts, options, _ = synthetic_scan(points=points, detectors=2,
                                              calibration_points=3)
    with open(path, 'wb') as handle:
        handle.write(scan_file(scan, counts))
    # What a reader of the panel would have to type in to fit this scan.
    print(json.dumps(dict(
        points=points, detector='ge', i0_channel=options.i0_channel,
        target=options.target, matrix=', '.join(options.matrix_elements),
        channel_lo=options.channel_range[0], channel_hi=options.channel_range[1],
        roi_lo=options.roi_range[0], roi_hi=options.roi_range[1],
        e0=E0, energy_min=float(scan['energy_ev'][0]),
        energy_max=float(scan['energy_ev'][-1]))))


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]), *sys.argv[3:4])
