"""Engine tests for the raw XRF spectrum and map viewer.

Every test is named for one failure in the table at the end of
docs/athena-xrf-viewer.md. The cubes are written here rather than measured:
each one puts a known number of counts in a known channel, so the trace, the
map and the rebinned spectrum all have an arithmetic answer to check against.
"""
import io

import numpy as np
import pytest

from xraylarch_web import athena_xrf_view as viewer
from xraylarch_web.athena_science import ScientificError

CHANNELS = 64
PEAK = 30                       # the channel every synthetic line sits in


def cube_file(counts, axes=(), *, detector='ge', extra=None):
    """Write a detector cube into the beamline's HDF5 layout.

    `axes` are (name, values) pairs written beside the cube, which is how a
    beamline records stage positions, the incident energy, or a scaler.
    """
    import h5py

    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        data = handle.create_group('synthetic').create_group('data')
        data[detector] = np.asarray(counts, dtype=float)
        for name, values in axes:
            data[name] = np.asarray(values, dtype=float)
        for name, values in (extra or {}).items():
            data[name] = np.asarray(values, dtype=float)
    return buffer.getvalue()


def line_cube(intensity, elements=2):
    """One emission line of the given per-point intensity, split evenly over
    the detector elements, on a flat continuum of one count a channel."""
    intensity = np.asarray(intensity, dtype=float).reshape(-1)
    counts = np.ones((intensity.size, elements, CHANNELS))
    counts[:, :, PEAK] = 1.0 + intensity[:, None] / elements
    return counts


def options(**overrides):
    settings = dict(version=0, cube_id='synthetic-view-cube-0001', detector='ge',
                    channel_range=[0, CHANNELS], roi_range=[PEAK, PEAK + 1])
    settings.update(overrides)
    return viewer.XrfViewOptions(**settings)


def read(data):
    return viewer.read_cube(data, 'synthetic.h5')


def frame(data, cube=None, **overrides):
    cube = cube or read(data)
    chosen = options(**overrides)
    window = viewer.load_window(data, chosen.detector, chosen.channel_range,
                                allowed=cube['detectors'])
    return viewer.frame(cube, window, chosen)


def raster_positions(rows, columns, *, serpentine=False):
    """The two stage arrays a raster scan writes, point by point."""
    fast = np.tile(np.arange(columns, dtype=float), rows)
    if serpentine:
        block = fast.reshape(rows, columns).copy()
        block[1::2] = block[1::2, ::-1]
        fast = block.reshape(-1)
    slow = np.repeat(np.arange(rows, dtype=float), columns)
    return [('sample_x', fast), ('sample_y', slow)]


# ---------------------------------------------------------------- reading


def test_a_file_with_no_energy_array_is_still_readable():
    """The XAS reader refuses a file with no energy array, because no mu(E)
    can come out of one. Reusing it for the viewer would have left the raw
    counts of every map and every single spectrum unopenable."""
    data = cube_file(line_cube(np.arange(12.0)))
    cube = read(data)

    assert cube['points'] == 12
    assert cube['detectors']['ge'] == (12, 2, CHANNELS)

    from xraylarch_web import athena_xrf_xas
    with pytest.raises(ScientificError) as raised:
        athena_xrf_xas.read_scan(data, 'synthetic.h5')
    assert 'no energy array' in str(raised.value)


def test_detector_arrays_of_different_lengths_are_refused():
    """Two cubes of different lengths cannot share one point slider or one
    trace abscissa, and picking whichever sorted first would silently show
    the reader a point from the other scan."""
    import h5py

    buffer = io.BytesIO(cube_file(line_cube(np.ones(10))))
    with h5py.File(buffer, 'a') as handle:
        handle['synthetic/data']['xspress'] = np.ones((7, 2, CHANNELS))
    with pytest.raises(ScientificError) as raised:
        read(buffer.getvalue())
    assert 'different lengths' in str(raised.value)
    assert 'xspress with 7' in str(raised.value)


def test_an_oversized_window_is_refused_before_it_is_read(monkeypatch):
    """A map is a hundred times the points of a scan, so the product of the
    per-dimension limits is far beyond memory even when every one is met."""
    data = cube_file(line_cube(np.ones(10)))
    cube = read(data)
    monkeypatch.setattr(viewer, 'MAX_VIEW_VALUES', 100)
    with pytest.raises(ScientificError) as raised:
        viewer.load_window(data, 'ge', [0, CHANNELS], allowed=cube['detectors'])
    assert 'narrow the channel range' in str(raised.value).lower()


# ------------------------------------------------------ folding into a map


def test_a_raster_is_folded_into_a_map_in_the_order_it_was_scanned():
    """The counts arrive as one long list. Folding them with the wrong row
    length, or with the rows in the wrong order, still produces an image --
    one that looks like a plausible sample and is not the one measured."""
    rows, columns = 4, 5
    image = np.arange(rows * columns, dtype=float).reshape(rows, columns)
    data = cube_file(line_cube(image.reshape(-1)), raster_positions(rows, columns))

    result = frame(data)
    assert result['map']['rows'] == rows and result['map']['columns'] == columns
    assert result['map']['fast'] == 'sample_x' and result['map']['slow'] == 'sample_y'
    # Two elements, each holding half the line, plus one continuum count each.
    assert np.allclose(result['map']['values'], image + 2.0)


def test_a_serpentine_raster_is_unwound_rather_than_mirrored():
    """A scan that turns round at the end of each row writes every other row
    backwards. Folded as if it had flown back, the image is sheared: edges
    zig-zag, and the artefact looks like a real feature of the sample."""
    rows, columns = 4, 6
    image = np.arange(rows * columns, dtype=float).reshape(rows, columns)
    written = image.copy()
    written[1::2] = written[1::2, ::-1]
    data = cube_file(line_cube(written.reshape(-1)),
                     raster_positions(rows, columns, serpentine=True))

    cube = read(data)
    assert cube['raster']['serpentine'] is True
    result = frame(data, cube)
    assert np.allclose(result['map']['values'], image + 2.0)
    # The fast axis is reported ascending, matching the unwound rows.
    assert result['map']['x'] == sorted(result['map']['x'])


def test_a_single_map_row_is_offered_as_a_trace_and_not_as_a_one_row_image():
    """One file of a 51-file map holds one row, and the positions in it do
    not raster. Inventing an image from them would present a line profile as
    a map of the sample."""
    columns = 8
    axes = [('sample_x', np.arange(columns, dtype=float)),
            ('sample_y', np.full(columns, 3.0))]
    result = frame(cube_file(line_cube(np.arange(columns, dtype=float)), axes))

    assert result['map'] is None
    assert np.allclose(result['roi'], np.arange(columns) + 2.0)


def test_an_energy_scan_is_not_mistaken_for_a_map():
    """'energy' contains an x and a y, and the position hints are substring
    matches. An energy scan paired with a scaler would otherwise fold into a
    rectangle of nothing."""
    points = 12
    axes = [('energy', np.linspace(6400.0, 7200.0, points)),
            ('sample_y', np.repeat(np.arange(3.0), 4))]
    cube = read(cube_file(line_cube(np.ones(points)), axes))

    assert cube['raster'] is None
    assert 'energy' in cube['axes']


def test_the_trace_is_decimated_but_the_map_keeps_every_pixel(monkeypatch):
    """A long map cannot be sent point by point to a browser, and decimating
    the image along with the trace would drop whole pixels out of it."""
    rows, columns = 10, 10
    data = cube_file(line_cube(np.ones(rows * columns)), raster_positions(rows, columns))
    monkeypatch.setattr(viewer, 'MAX_TRACE_POINTS', 20)

    result = frame(data)
    assert result['trace_stride'] == 5
    assert len(result['roi']) == 20
    assert np.shape(result['map']['values']) == (rows, columns)


# ------------------------------------------------------------- the frame


def test_the_spectrum_is_the_counts_at_the_point_asked_for():
    """The point slider, the averaging window and the element selection each
    index the cube, and an off-by-one in any of them shows a neighbouring
    spectrum that looks entirely reasonable."""
    data = cube_file(line_cube([10.0, 20.0, 30.0, 40.0]))
    result = frame(data, point=2)

    assert result['total'][PEAK] == pytest.approx(30.0 + 2.0)
    assert result['spectra'][0][PEAK] == pytest.approx(15.0 + 1.0)
    assert result['averaged'] == [2, 3]
    assert result['element_counts'] == pytest.approx([16.0, 16.0])


def test_averaging_near_the_end_of_the_scan_stays_inside_it():
    """A block that runs off the end used to wrap round through NumPy's
    negative indexing, averaging the last points with the first ones."""
    data = cube_file(line_cube([0.0, 0.0, 0.0, 0.0, 100.0]))
    result = frame(data, point=4, average=3)

    assert result['averaged'] == [2, 5]
    assert result['total'][PEAK] == pytest.approx(100.0 / 3 + 2.0)


def test_one_element_can_be_looked_at_on_its_own():
    """A dead or shadowed element is only visible against the others, and it
    is hidden entirely in the sum the extraction fits."""
    counts = line_cube([10.0, 20.0], elements=3)
    counts[:, 1, :] = 0.0                       # element 1 recorded nothing
    result = frame(cube_file(counts), elements=[1])

    assert result['elements'] == [1]
    assert max(result['total']) == 0.0
    assert result['roi'] == [0.0, 0.0]


def test_an_element_that_does_not_exist_is_refused_rather_than_wrapped():
    """NumPy reads element -1 as the last one and raises on element 99, so
    one typo returned somebody else's spectrum and the other returned a 500."""
    data = cube_file(line_cube(np.ones(4), elements=2))
    with pytest.raises(ScientificError) as raised:
        frame(data, elements=[5])
    assert '2 elements' in str(raised.value)
    with pytest.raises(ValueError):
        options(elements=[-1])


def test_a_window_of_interest_outside_the_channels_read_is_refused():
    """An empty slice sums to zero at every point, which plots as a flat
    trace: a dead detector and a misplaced window look identical."""
    data = cube_file(line_cube(np.ones(4)))
    with pytest.raises(ScientificError) as raised:
        frame(data, channel_range=[0, 20], roi_range=[40, 50])
    assert 'outside the channels read' in str(raised.value)


def test_rebinning_conserves_counts_and_keeps_the_energy_axis_honest():
    """Averaging instead of summing rescales the ordinate, and labelling a
    bin by its first channel shifts the whole spectrum half a bin left --
    which at 10 eV a channel is a visible calibration error."""
    data = cube_file(line_cube([100.0]))
    plain = frame(data, rebin=1)
    binned = frame(data, rebin=4, cal_offset=-0.01, cal_slope=0.01)

    assert sum(binned['total']) == pytest.approx(sum(plain['total']))
    assert len(binned['total']) == CHANNELS // 4
    # Bin 7 covers channels 28-31: the line plus four channels of continuum
    # from each of the two elements. Its centre is channel 29.5.
    assert binned['total'][PEAK // 4] == pytest.approx(100.0 + 4 * 2.0)
    assert binned['energy_kev'][PEAK // 4] == pytest.approx(-0.01 + 0.01 * 29.5)


def test_the_trace_can_run_against_an_axis_the_file_holds():
    """Plotted against the point index, a scan whose points are unevenly
    spaced in energy is distorted, and a map row carries no distance at all."""
    points = 6
    energy = np.linspace(6400.0, 7200.0, points)
    data = cube_file(line_cube(np.arange(points, dtype=float)), [('energy', energy)])

    result = frame(data, axis='energy')
    assert result['axis_name'] == 'energy'
    assert np.allclose(result['axis'], energy)

    with pytest.raises(ScientificError) as raised:
        frame(data, axis='sample_x')
    assert 'no array named sample_x' in str(raised.value)
