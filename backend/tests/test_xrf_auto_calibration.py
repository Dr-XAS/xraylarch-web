"""Is the detector's energy calibration read from the file, not assumed?

A fixed starting guess of 10 eV per channel put the automatic windows of an
APS 20-BM detector binned to about 30 eV per channel on empty channels three
times too high: the fit, the window sum and the raw viewer's energy axis were
all wrong, and nothing said so. These tests build a detector with a known,
coarse calibration by summing every three channels of a synthetic scan drawn
from Larch's model at 10.1 eV per channel, so the right answer is exact.
"""
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient

from test_athena_xrf_xas import make_options
from xrf_xas_scan_fixture import binned_calibration, binned_channel, binned_spectra, binned_twenty_bm_file
from xraylarch_web import athena_xrf_xas as engine
from xraylarch_web import xrf_calibration as calibration
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

pytestmark = pytest.mark.xrf_slow

@pytest.fixture(scope='module')
def binned():
    """A synthetic Mn scan on a detector three times coarser than the model's."""
    return binned_spectra()


BINNED_OFFSET, BINNED_SLOPE = binned_calibration()
channel_of = binned_channel
twenty_bm = binned_twenty_bm_file


def test_a_binned_detector_is_placed_by_its_own_line_windows(binned):
    scan, spectra = binned
    data = twenty_bm(scan, spectra)
    found = calibration.infer(data, engine.read_scan(data, 'binned.0001.hdf5'), 'MCA')
    # Mn K-alpha and Cr K-alpha both peak inside the beamline's windows, half a
    # keV apart: their tabulated energies fix the calibration.
    assert found['source'] == 'lines'
    assert found['cal_slope'] == pytest.approx(BINNED_SLOPE, rel=0.02)
    # What the windows depend on: where the target line lands.
    assert channel_of(5.8988) == pytest.approx((5.8988 - found['cal_offset']) / found['cal_slope'], abs=1.0)


def test_without_line_windows_the_elastic_peak_gives_the_gain(binned):
    scan, spectra = binned
    data = twenty_bm(scan, spectra, line_windows=False)
    found = calibration.infer(data, engine.read_scan(data, 'binned.0001.hdf5'), 'MCA')
    assert found['source'] == 'elastic_peak'
    assert found['cal_slope'] == pytest.approx(BINNED_SLOPE, rel=0.04)
    assert abs((5.8988 - found['cal_offset']) / found['cal_slope'] - channel_of(5.8988)) < 2.0


def test_a_typed_calibration_that_contradicts_the_file_is_reported(binned):
    scan, spectra = binned
    data = twenty_bm(scan, spectra)
    found = calibration.infer(data, engine.read_scan(data, 'binned.0001.hdf5'), 'MCA')
    typed = make_options(cal_offset=0.0, cal_slope=0.010)
    kept, record, notes = calibration.apply(typed, found, 5.8988)
    assert (kept.cal_offset, kept.cal_slope) == (0.0, 0.010)
    assert record['automatic'] == []
    assert len(notes) == 1 and 'puts the target line at channel 590' in notes[0]


def test_a_file_with_no_readable_calibration_says_so():
    """Flat counts: no line window, no peak to follow. The default is kept,
    and the result says it is a guess instead of passing it off as a reading."""
    import h5py

    rng = np.random.default_rng(3)
    energy = np.linspace(6300.0, 7100.0, 20)
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        entry = handle.create_group('flat')
        data = entry.create_group('data')
        data['energy'] = energy
        data['ge'] = rng.poisson(50.0, size=(20, 2, 400)).astype(float)
        data['i0'] = np.full(20, 1.0e5)
    raw = buffer.getvalue()
    found = calibration.infer(raw, engine.read_scan(raw, 'flat.h5'), 'ge')
    assert found['source'] == 'default'
    blank = make_options(cal_offset=None, cal_slope=None)
    filled, record, notes = calibration.apply(blank, found, 5.8988)
    assert (filled.cal_offset, filled.cal_slope) == (0.0, 0.010)
    assert record['automatic'] == ['cal_offset', 'cal_slope']
    assert notes and 'No energy calibration could be read' in notes[0]


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path, xrf_workers=1))) as client:
        yield client


def test_import_sends_detector_spectra_to_the_xrf_panel(client, binned):
    """Import spectra refused a detector file outright; it now names the panel
    that reads it, so the workbench can open the file there."""
    scan, spectra = binned
    project = client.post('/api/athena/projects').json()
    answer = client.post(f"/api/athena/projects/{project['id']}/inspect",
                         files={'file': ('binned.0001.hdf5', twenty_bm(scan, spectra))})
    assert answer.status_code == 200, answer.text
    assert answer.json()['kind'] == 'xrf_detector_file'
    assert answer.json()['opens'] == 'xrf_xas'


def test_an_empty_calibration_places_the_windows_from_the_file(client, binned):
    """Through the routes, as the panel sends it: nothing typed."""
    scan, spectra = binned
    project = client.post('/api/athena/projects').json()
    route = f"/api/athena/projects/{project['id']}/xrf-xas"
    inspected = client.post(route + '/inspect', files={'file': ('binned.0001.hdf5', twenty_bm(scan, spectra))}).json()
    assert inspected['starting_calibration']['MCA']['source'] == 'lines'
    request = dict(version=project['version'], scan_id=inspected['upload_id'], detector='MCA', target='Mn',
                   matrix_elements=['Fe', 'Cr'], i0_channel='I0', calibration_points=3, e0=6539.0)
    result = client.post(route + '/preview', json=request)
    assert result.status_code == 200, result.text
    metadata = result.json()['metadata']
    applied = metadata['windows']['starting_calibration']
    assert applied['automatic'] == ['cal_offset', 'cal_slope']
    lo, hi = metadata['roi_range']
    assert lo <= channel_of(5.8988) < hi
    # The raw viewer draws its energy axis with the same reading.
    frame = client.post(f"/api/athena/projects/{project['id']}/xrf-view/frame", json=dict(
        version=project['version'], cube_id=inspected['upload_id'], detector='MCA', point=12,
        channel_range=[0, spectra.shape[2]], roi_range=[lo, hi]))
    assert frame.status_code == 200, frame.text
    assert frame.json()['calibration']['cal_slope'] == pytest.approx(BINNED_SLOPE, rel=0.02)


def test_noise_inside_named_windows_is_not_a_line(binned):
    """Exact window sums say where the beamline looked, not that a line is
    there: flat counting noise with named windows must not become a calibration."""
    scan, spectra = binned
    rng = np.random.default_rng(11)
    flat = rng.poisson(40.0, size=spectra.shape).astype(np.int32)
    data = twenty_bm(scan, flat)
    found = calibration.infer(data, engine.read_scan(data, 'flat.0001.hdf5'), 'MCA')
    assert found['source'] == 'default'
    assert 'reason' in found


def test_a_line_whose_edge_the_scan_does_not_reach_is_not_used(binned):
    """Gd L-alpha lies below the scatter, so the energy cut keeps it, and a peak
    sits in its window, but its L3 edge (7.24 keV) is above every point of the
    scan: whatever peaks there is not Gd, and the excitation check has to say so."""
    scan, spectra = binned
    gd = int(round(channel_of(6.0534)))
    spectra = spectra.copy()
    spectra[:, :, gd - 1:gd + 2] += np.array([1500, 4000, 1500], dtype=np.int32)
    data = twenty_bm(scan, spectra, windows=(('MnKa', 5.8988), ('CrKa', 5.4147), ('GdLa', 6.0534)))
    found = calibration.infer(data, engine.read_scan(data, 'binned.0001.hdf5'), 'MCA')
    used = {line['line'] for element in found['elements'].values() for line in element.get('lines', [])}
    assert 'Gd La' not in used and {'Mn Ka', 'Cr Ka'} <= used


def test_a_scan_recorded_downward_gives_the_same_calibration(binned):
    """read_scan sorts the points by energy; spectra read in file order have to
    be put in the same order before energies and spectra are paired."""
    scan, spectra = binned
    upward = twenty_bm(scan, spectra)
    downward = twenty_bm(scan, spectra, order=np.arange(spectra.shape[0])[::-1])
    up = calibration.infer(upward, engine.read_scan(upward, 'up.0001.hdf5'), 'MCA')
    down = calibration.infer(downward, engine.read_scan(downward, 'down.0001.hdf5'), 'MCA')
    assert down['source'] == up['source'] != 'default'
    assert down['cal_slope'] == pytest.approx(up['cal_slope'], rel=1e-9)
    assert down['cal_offset'] == pytest.approx(up['cal_offset'], abs=1e-9)


DETECTOR_OFFSET, DETECTOR_SLOPE = 0.02, 0.010


def scatter_spectra(*, elastic=1.0, extra=(), channels=1024, target_step=0.0, seed=5, incident=None, lines=None):
    """Spectra across the Mn K edge (48 incident energies, 6.4 to 7.4 keV,
    unless `incident` says otherwise) on a detector with a known calibration:
    an elastic peak, a broader Compton peak at 120 degrees, fluorescence
    lines, and whatever `extra` adds, each a function of the incident energy
    and an amplitude. `lines` are (energy, amplitude, edge it turns on at);
    by default Cr K-alpha, always there, and Mn K-alpha of `target_step`
    above the Mn edge. Every line rises 10 per cent across the Eu L3 edge,
    where Eu L-alpha would sit five channels from Mn K-alpha."""
    from xraylarch_web.athena_xrf_xas import compton_center

    rng = np.random.default_rng(seed)
    incident = np.linspace(6.4, 7.4, 48) if incident is None else np.asarray(incident, dtype=float)
    lines = [(5.4147, 0.8, 0.0), (5.8988, target_step, 6.539)] if lines is None else lines
    axis = DETECTOR_OFFSET + DETECTOR_SLOPE * np.arange(channels)
    width = 0.03
    rows = []
    for e in incident:
        fluorescence = [(kev, amplitude * (e > edge) * (1.0 + 0.1 * (e > 6.977)), width)
                        for kev, amplitude, edge in lines]
        peaks = [(e, elastic, width), (compton_center(e, 120.0), 1.0, 1.6 * width), *fluorescence,
                 *[(where(e), amplitude, width) for where, amplitude in extra]]
        shape = sum(amplitude * np.exp(-0.5 * ((axis - centre) / spread) ** 2)
                    for centre, amplitude, spread in peaks)
        rows.append(rng.poisson(2000 * shape + 5))
    return np.array(rows, dtype=float), incident


def misplacement(found, kev=(5.4147, 5.8988, 6.4, 7.4)):
    """The largest error in channels where lines land, from Cr K-alpha to the top of the scan."""
    kev = np.asarray(kev)
    placed = (kev - found['cal_offset']) / found['cal_slope']
    return float(np.abs(placed - (kev - DETECTOR_OFFSET) / DETECTOR_SLOPE).max())


# Following Compton places lines 10 to 16 channels low here; the offset alone
# is not checked, being an extrapolation 700 channels down from the scan.
@pytest.mark.parametrize('case', [
    dict(elastic=5.0),  # elastic stronger
    dict(elastic=0.3),  # Compton stronger; the elastic is resolved only at the top of the scan
    dict(elastic=5.0, extra=[(lambda e: 2 * e, 1.0)], channels=2048),  # pile-up, at half the gain
    dict(elastic=5.0, extra=[(lambda e: 2 * e, 0.05)], channels=2048),
    dict(elastic=0.3, extra=[(lambda e: e + 0.3, 1.0)]),  # a moving peak too far above to be scatter
], ids=['elastic stronger', 'Compton stronger', 'strong pile-up', 'weak pile-up', 'a peak above the elastic'])
def test_the_elastic_peak_is_followed_and_not_another_moving_peak(case):
    found = calibration.from_elastic_peak(*scatter_spectra(**case))
    assert found is not None and found['resolved']
    assert misplacement(found) < 3.0
    assert found['cal_slope'] == pytest.approx(DETECTOR_SLOPE, rel=0.03)


def test_one_scatter_peak_alone_is_reported_as_uncertain():
    """Compton with no elastic beside it looks like an elastic peak; nothing in
    the scatter tells them apart, so the reading has to say so."""
    found = calibration.from_elastic_peak(*scatter_spectra(elastic=0.0))
    assert found is not None and not found['resolved']
    assert calibration.summarise({0: calibration.joint([], found)}, 1)['caution'] == 'one scatter peak'


def nexus_scan(spectra, incident_kev):
    """A one-element scan in the NeXus-style layout, which has no line windows."""
    import h5py

    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        data = handle.create_group('scan').create_group('data')
        data['energy'] = 1000.0 * incident_kev
        data['ge'] = spectra[:, None, :]
        data['i0'] = np.full(incident_kev.size, 1.0e5)
    return buffer.getvalue()


def test_the_target_line_turning_on_at_its_edge_anchors_a_scatter_only_scan():
    """Compton alone, which on its own would place lines 10 to 16 channels low,
    but the scan crosses the Mn K edge: the line that turns on there is Mn
    K-alpha, at a tabulated energy. Eu L-alpha, five channels away, has its
    edge in the scan too, but Mn K-alpha only rises 10 per cent across it."""
    spectra, incident = scatter_spectra(elastic=0.0, target_step=1.0)
    data = nexus_scan(spectra, incident)
    found = calibration.infer(data, engine.read_scan(data, 'compton.h5'), 'ge')
    used = {line['line'] for line in found['elements']['0']['lines']}
    assert 'Mn Ka' in used and 'Eu La' not in used
    assert found['source'] == 'lines_and_elastic' and 'caution' not in found
    # Mn K-alpha lands where it peaks; Cr K-alpha, 49 channels away, carries
    # the four per cent by which Compton's gain differs from the elastic's.
    assert misplacement(found, kev=(5.8965,)) < 0.5
    assert misplacement(found, kev=(5.4147,)) < 3.0


def edge_anchored(spectra, incident):
    data = nexus_scan(spectra, incident)
    found = calibration.infer(data, engine.read_scan(data, 'scan.h5'), 'ge')
    return found, {line['line'] for line in found['elements']['0'].get('lines', [])}


def test_a_line_that_turned_on_at_one_edge_is_not_claimed_at_the_next():
    """Dense pre-edge sampling: averaged over the whole scan, the points below
    the Eu and Gd L3 edges are mostly below the Mn edge too, and Mn K-alpha
    seemed to turn on at all three. Only the points near each edge count."""
    incident = np.concatenate([np.linspace(6.40, 6.53, 40), np.linspace(6.55, 7.40, 20)])
    found, used = edge_anchored(*scatter_spectra(elastic=0.0, target_step=1.0, incident=incident))
    assert used == {'Mn Ka'}
    assert misplacement(found, kev=(5.8965,)) < 0.5


def lines_where_they_peak(found):
    """For every line used, how far its assigned energy is from where it peaked, in channels."""
    return {line['line']: abs(line['channel'] - (line['energy_kev'] - DETECTOR_OFFSET) / DETECTOR_SLOPE)
            for element in found['elements'].values() for line in element.get('lines', [])}


@pytest.mark.parametrize('elastic', [5.0, 0.0], ids=['scatter resolved', 'Compton alone'])
def test_another_elements_line_is_not_taken_for_k_beta(elastic):
    """A Cr edge scan of a sample with Mn: Mn K-alpha, above the Mn edge and
    stronger than Cr K-beta, sits 48 eV below it, where K-beta is looked for.
    It does not turn on at the Cr edge, so it is not Cr K-beta. Taken for it,
    the two lines alone would set the gain near 11 eV per channel; with
    Compton alone nothing else would catch it."""
    incident = np.linspace(5.90, 6.90, 48)
    spectra, incident = scatter_spectra(elastic=elastic, incident=incident, lines=[
        (5.4147, 3.0, 5.989), (5.9467, 0.36, 5.989), (5.8988, 1.0, 6.539), (6.4905, 0.13, 6.539)])
    found, used = edge_anchored(spectra, incident)
    assert 'Cr Ka' in used
    assert max(lines_where_they_peak(found).values()) < 1.5
    if elastic:
        assert found['cal_slope'] == pytest.approx(DETECTOR_SLOPE, rel=0.02)
        assert misplacement(found, kev=(5.4147, 5.9467)) < 1.5


def test_a_line_turning_on_at_a_later_edge_does_not_move_the_target_line():
    """Eu L-alpha turns on at the Eu L3 edge five channels from Mn K-alpha.
    Averaged over the whole scan above the Mn edge, it would pull the Mn line;
    only the points near the Mn edge are compared."""
    spectra, incident = scatter_spectra(elastic=0.0, lines=[(5.8988, 3.0, 6.539), (5.8460, 6.0, 6.977)])
    found, used = edge_anchored(spectra, incident)
    assert used == {'Mn Ka'}
    assert lines_where_they_peak(found)['Mn Ka'] < 0.5


def test_a_jump_in_the_beam_is_not_a_line_turning_on():
    """The beam steps up by a third at 6.977 keV with no I0 to divide it out:
    the largest jump brackets the Eu L3 edge, but no Eu is there. Every line
    rose by a third, none doubled; taken for Eu L-alpha, Mn K-alpha five
    channels away would have moved the reading by them."""
    incident = np.linspace(6.6, 7.4, 48)
    spectra, incident = scatter_spectra(elastic=5.0, incident=incident, lines=[(5.8988, 3.0, 0.0)])
    spectra[incident > 6.977] *= 4 / 3
    data = nexus_scan(spectra, incident)
    found = calibration.infer(data, engine.read_scan(data, 'scan.h5'), 'ge')
    assert not any(line.startswith('Eu') for line in lines_where_they_peak(found))
    assert misplacement(found, kev=(5.8988,)) < 1.5


def test_an_element_read_from_compton_alone_never_becomes_the_reading():
    """Elements whose offsets differ, the middle one read from Compton alone:
    taken into the median it became the reading, 15 channels off, with nothing
    said. With anything better to go on, it is left out; with nothing better,
    the reading says it may be Compton's."""
    def element(offset, elastic):
        found = calibration.from_elastic_peak(*scatter_spectra(elastic=elastic))
        return calibration.joint([], dict(found, cal_offset=found['cal_offset'] + offset))
    left, lone, right = element(-0.2, 0.3), element(0.0, 0.0), element(0.2, 0.3)
    reading = calibration.summarise({0: left, 1: lone, 2: right}, 3)
    assert 'caution' not in reading and reading['found_for'] == 2
    assert reading['cal_offset'] == pytest.approx(np.median([left['cal_offset'], right['cal_offset']]))
    assert calibration.summarise({0: lone, 1: lone}, 2)['caution'] == 'one scatter peak'


def test_the_compton_band_is_checked_at_each_energy():
    """A lone track a constant 0.2 keV below the incident energy is outside the
    Compton shift at the bottom of a 6.4 to 7.4 keV scan, though not at its top."""
    incident = np.linspace(6.4, 7.4, 30)
    line = [dict(line='Mn Ka', energy_kev=5.8988, channel=(5.8988 - DETECTOR_OFFSET) / DETECTOR_SLOPE)]
    track = lambda energies: dict(cal_slope=DETECTOR_SLOPE, track=dict(  # noqa: E731
        energy_kev=incident.tolist(), channel=((energies - DETECTOR_OFFSET) / DETECTOR_SLOPE).tolist()))
    from xraylarch_web.athena_xrf_xas import compton_center
    assert calibration._anchored(line, track(incident - 0.2)) is None
    assert calibration._anchored(line, track(np.array([compton_center(e, 120.0) for e in incident]))) is not None


def test_one_named_line_does_not_make_a_compton_gain_trusted():
    """A Cu edge scan with one beamline window, on Cr K-alpha, and Compton
    alone: one line does not fix the gain, so the Cu lines found at the Cu
    edge must not be held to the Compton gain and thrown away."""
    incident = np.linspace(8.85, 9.60, 48)
    spectra, incident = scatter_spectra(elastic=0.0, incident=incident, lines=[
        (5.4147, 0.8, 0.0), (8.0463, 3.0, 8.979), (8.9054, 0.4, 8.979)])
    scan = dict(energy_ev=1000.0 * incident, channels=dict(i0=np.full(incident.size, 1.0e5)))
    data = twenty_bm(scan, spectra[:, None, :].astype(np.int32), windows=(('CrKa', 5.4147),),
                     channel_of=lambda kev: (kev - DETECTOR_OFFSET) / DETECTOR_SLOPE)
    found = calibration.infer(data, engine.read_scan(data, 'cu.0001.hdf5'), 'MCA')
    used = {line['line'] for line in found['elements']['0']['lines']}
    assert {'Cr Ka', 'Cu Ka'} <= used
    assert misplacement(found, kev=(5.4147, 8.0463)) < 1.0


def test_an_onset_between_two_edges_names_neither():
    """Sparse sampling: Ca turns on between 4.01 and 4.08 keV, too few points
    below its edge to look at; the Sb L3 edge, 0.09 keV higher, has three, and
    one of them is past the Ca onset. Where the jump sits names Ca, not Sb,
    and Ca cannot be checked, so nothing is anchored and the reading says so."""
    incident = np.concatenate([[3.99, 4.01, 4.08], np.linspace(4.19, 4.60, 30)])
    spectra, incident = scatter_spectra(elastic=0.0, incident=incident, lines=[(3.6917, 2.0, 4.038)])
    found, used = edge_anchored(spectra, incident)
    assert not used & {'Sb La', 'Ca Ka'}
    assert found['caution'] == 'one scatter peak'


def test_detector_names_linked_to_one_dataset_are_read_once(monkeypatch):
    import h5py

    spectra, incident = scatter_spectra(elastic=0.3)
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        data = handle.create_group('scan').create_group('data')
        data['energy'] = 1000.0 * incident
        data['ge'] = spectra[:, None, :]
        data['ge_alias'] = data['ge']
        data['i0'] = np.full(incident.size, 1.0e5)
    raw = buffer.getvalue()
    reads = []
    real = calibration.infer
    monkeypatch.setattr(calibration, 'infer', lambda *args: reads.append(args[2]) or real(*args))
    found = calibration.infer_detectors(raw, engine.read_scan(raw, 'scan.h5'), ['ge', 'ge_alias'])
    assert reads == ['ge'] and found['ge_alias'] == found['ge']


def test_a_detector_short_of_the_incident_energy_is_still_calibrated_by_its_lines(binned):
    """The detector need not reach the scatter: its two lines fix it."""
    scan, spectra = binned
    short = spectra[:, :, :210]
    assert (scan['energy_ev'].max() / 1000 - BINNED_OFFSET) / BINNED_SLOPE > short.shape[2]
    data = twenty_bm(scan, short)
    found = calibration.infer(data, engine.read_scan(data, 'short.0001.hdf5'), 'MCA')
    assert found['source'] == 'lines'
    assert found['cal_slope'] == pytest.approx(BINNED_SLOPE, rel=0.02)


def test_a_saved_result_records_the_calibration_it_used(client, binned):
    """A result saved with the calibration left empty must say which numbers
    placed its windows, and still say so when the project is opened again."""
    scan, spectra = binned
    project = client.post('/api/athena/projects').json()
    route = f"/api/athena/projects/{project['id']}/xrf-xas"
    inspected = client.post(route + '/inspect', files={'file': ('binned.0001.hdf5', twenty_bm(scan, spectra))}).json()
    made = client.post(route + '/make', json=dict(
        version=project['version'], scan_id=inspected['upload_id'], detector='MCA', target='Mn',
        matrix_elements=['Fe', 'Cr'], i0_channel='I0', calibration_points=3, e0=6539.0))
    assert made.status_code == 200, made.text
    reopened = client.get(f"/api/athena/projects/{project['id']}").json()
    [group] = [g for g in reopened['groups'] if g['source'].get('kind') == 'xrf_xas']
    recorded = group['source']['extraction']['windows']['starting_calibration']
    assert recorded['automatic'] == ['cal_offset', 'cal_slope']
    assert recorded['applied']['cal_slope'] == pytest.approx(BINNED_SLOPE, rel=0.02)
