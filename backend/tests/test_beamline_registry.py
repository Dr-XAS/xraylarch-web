"""The registry must name the beamline, and name its channels correctly.

Each test below names a way the naming can mislead a user: a column that is
imported as the incident beam when it is a diode, a fluorescence signal counted
twice, the requested energy used as the axis instead of the achieved one. The
files are the real scans in ``examples/xafsdata/beamlines``, so a test that
fails is a file that would import wrongly in the browser.
"""
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.beamline_registry import identify_beamline, reader_catalog
from xraylarch_web.beamline_roles import emission_line, scanned_element, tokens
from xraylarch_web.config import Settings

EXAMPLES = Path(__file__).resolve().parents[2] / 'examples' / 'xafsdata' / 'beamlines'


def converted(name):
    """An example file's columns as arrays, after any plugin that handles it.

    Some of these formats record something other than the columns they mean
    -- the 9809 collector writes monochromator angles -- so a check on the
    numbers has to read them the way the import does, not off the text.
    """
    from xraylarch_web.athena_file_plugins import prepare_file
    from xraylarch_web.parsing import parse_upload

    data = (EXAMPLES / name).read_bytes()
    prepared = prepare_file(data, max_bytes=len(data) + 1, max_points=100000, max_columns=64)
    parsed = parse_upload(prepared.data if prepared is not None else data, name)
    return {column.name: parsed.arrays[column.column_id] for column in parsed.columns}


@pytest.fixture
def enabled_store(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    return AthenaStore(settings)


@pytest.fixture
def inspect(enabled_store):
    project = enabled_store.create()

    def run(name):
        result = enabled_store.inspect(project['id'], (EXAMPLES / name).read_bytes(), name)
        if result.get('kind') == 'scan_list':
            result = result['scans'][0]
        labels = {column['column_id']: column['name'] for column in result['columns']}

        def spell(value):
            if isinstance(value, list):
                return [labels.get(item, item) for item in value]
            return labels.get(value, value)

        reader = dict(result['beamline_reader'])
        reader['roles'] = {role: spell(value) for role, value in reader['roles'].items()}
        reader['suggestions'] = {
            mode: {key: spell(value) for key, value in suggestion.items()}
            for mode, suggestion in reader['suggestions'].items()}
        if reader.get('reference'):
            reader['reference'] = {**reader['reference'],
                                   'numerator': spell(reader['reference']['numerator']),
                                   'denominator': spell(reader['reference']['denominator'])}
        return reader

    return run


def written(columns, rows=40, units='eV', start=7000., step=1.):
    """A small XDI file with the given column labels, for a layout no real
    scan in the repository happens to have.

    XDI only because a file must be recognized before the registry names its
    channels at all; none of these labels is an XDI dictionary name, so they
    are read the same way a column file's labels are.
    """
    head = ['# XDI/1.0', '# Facility.name: a bench source']
    head += [f'# Column.{i}: {name}' + (f' {units}' if i == 1 else '')
             for i, name in enumerate(columns, 1)]
    head.append('# ' + ' '.join(columns))
    body = []
    for row in range(rows):
        energy = start + row * step
        body.append(' '.join(f'{value:g}' for value in
                             [energy] + [energy + 0.5 * n for n in range(1, len(columns))]))
    return ('\n'.join(head + body) + '\n').encode()


@pytest.fixture
def inspect_written(enabled_store):
    """Inspect bytes rather than a file in the repository, keeping labels."""
    project = enabled_store.create()

    def run(content, name='bench.xdi'):
        result = enabled_store.inspect(project['id'], content, name)
        labels = {column['column_id']: column['name'] for column in result['columns']}

        def spell(value):
            if isinstance(value, list):
                return [labels.get(item, item) for item in value]
            return labels.get(value, value)

        reader = dict(result['beamline_reader'])
        reader['roles'] = {role: spell(value) for role, value in reader['roles'].items()}
        chosen = result['athena_suggestion']
        return {'reader': reader,
                'chosen': {**chosen, 'numerator': spell(chosen['numerator']),
                           'denominator': spell(chosen['denominator']),
                           'energy_column': spell(chosen['energy_column'])}}

    return run


# -- what wrote the file ---------------------------------------------------

@pytest.mark.parametrize('name, facility, beamline', [
    ('APS10BM_2019.dat', 'Advanced Photon Source', '10-BM (MRCAT)'),
    ('APS12BM_2019.dat', 'Advanced Photon Source', '12-BM-B'),
    ('APS13ID_2008.dat', 'Advanced Photon Source', '13-BM-D (GSECARS)'),
    ('APS13ID_2019.dat', 'Advanced Photon Source', '13-ID-E (GSECARS)'),
    ('APS20BM_2001.dat', 'Advanced Photon Source', '20-BM'),
    ('APS20ID_2018.dat', 'Advanced Photon Source', '20-ID'),
    ('APS9BM_2019.dat', 'Advanced Photon Source', '9-BM'),
    ('CLSHXMA.dat', 'Canadian Light Source', 'HXMA (06ID-1)'),
    ('ESRF_BM08_LISA_2021.dat', 'ESRF', 'BM08 (LISA)'),
    ('ESRF_SNBL_2013.dat', 'ESRF', ''),
    ('NSLS6BM_2019.dat', 'NSLS-II', 'BMM (06BM)'),
    ('NSLS8ID_2019.dat', 'NSLS-II', 'ISS (8-ID)'),
    ('NSLS_XDAC_2011.dat', 'National Synchrotron Light Source', 'X-23A2'),
    ('PF9A_2022.dat', 'Photon Factory, KEK', 'BL9A'),
    ('PFBL12C_2005.dat', 'Photon Factory, KEK', 'BL12C'),
    ('SLS_PHOENIX_2023.dat', 'Swiss Light Source', 'PHOENIX (X07MB)'),
    ('SSRL1_2006.dat', 'Stanford Synchrotron Radiation Lightsource', ''),
])
def test_the_registry_names_the_beamline_that_wrote_the_file(name, facility, beamline, inspect):
    found = inspect(name)
    assert (found['facility'], found['beamline']) == (facility, beamline)


def test_a_file_that_names_no_beamline_is_not_given_one():
    """A plain SPEC file states its facility nowhere, and must not be guessed.

    Reporting a beamline the file does not carry would put a wrong label on an
    imported spectrum, which is worse than reporting only the format.
    """
    found = identify_beamline((EXAMPLES / 'APS9BM_2006.dat').read_bytes())
    assert found['id'] == 'spec'
    assert found['facility'] == found['beamline'] == ''
    assert found['confidence'] == 'format'


def test_a_spec_file_that_happens_to_name_its_facility_is_still_spec():
    """'# Facility:' is a field any format can carry; '#F' and '#S' are SPEC's.

    Reading the facility line first labels an ESRF or APS SPEC scan as the
    NSLS-II Bluesky column export, and with it come that export's column
    conventions, which SPEC does not follow.
    """
    body = (b'#F /data/scan.dat\n#S 1 ascan en 7000 7100 100 1\n'
            b'# Facility: Advanced Photon Source\n#L energy  i0  it\n'
            b'7000 1.0 0.5\n7001 1.0 0.5\n')
    assert identify_beamline(body)['id'] == 'spec'


def test_a_spec_file_whose_path_names_its_station_says_so_and_no_more():
    # A SPEC scan from the user's own beamline read only 'SPEC scan file';
    # the '#F' path is the file's own statement of where it was written.
    body = (b'#F /net/data/aps/20bm/run1/scan.dat\n#S 1 ascan en 7000 7100 100 1\n'
            b'#L energy  i0  it\n7000 1.0 0.5\n7001 1.0 0.5\n')
    found = identify_beamline(body)
    assert (found['id'], found['facility'], found['beamline'], found['confidence']) == \
        ('spec', 'Advanced Photon Source', '20-BM', 'beamline')
    assert "'#F' path" in found['evidence']
    elsewhere = identify_beamline(body.replace(b'/net/data/aps/20bm', b'/data/run7'))
    assert elsewhere['facility'] == elsewhere['beamline'] == ''


def test_a_facility_line_far_down_the_file_does_not_identify_it():
    """A format marker counts only where a header can be.

    Matched anywhere in the first 64 kB, a line of prose or a comment inside
    the data identifies the whole file as a format it is not, and every column
    is then read by that format's conventions.
    """
    buried = b'# notes\n' * 200 + b'# Facility: Advanced Photon Source\n7000 1.0\n7001 1.0\n'
    assert identify_beamline(buried) is None
    in_header = b'# Facility: Advanced Photon Source\n# energy i0\n7000 1.0\n7001 1.0\n'
    assert identify_beamline(in_header)['id'] == 'bluesky-ascii'


def test_a_station_the_file_never_names_is_reported_as_an_expectation():
    """XDAC wrote 'on X-23A2' into some of its files and not into others.

    Reporting the station anyway, as if the file had said it, puts an
    unsourced beamline on an imported spectrum, so the evidence line says
    where it comes from and the confidence stays at the format. The file here
    is the repository's XDAC scan with that one phrase taken out.
    """
    silent = (EXAMPLES / 'NSLS_XDAC_2011.dat').read_text().replace(' on X-23A2', '', 1)
    found = identify_beamline(silent.encode())
    assert found['beamline'] == 'X-23A2'
    assert found['confidence'] == 'format'
    assert 'usually writes from' in found['evidence']


def test_a_station_the_file_does_name_is_reported_as_the_file_states_it(inspect):
    """MRCAT writes 'created at APS 10BM', and that is a statement, not a guess.

    The expectation above must not swallow the cases where the header says
    which station it was, or the distinction it draws is worthless.
    """
    found = inspect('APS10BM_2019.dat')
    assert (found['beamline'], found['confidence']) == ('10-BM (MRCAT)', 'beamline')
    assert 'usually writes from' not in found['evidence']


def test_a_headerless_column_file_is_not_attributed_to_anyone():
    assert identify_beamline((EXAMPLES / 'generic_columns_no_header.dat').read_bytes()) is None


# -- which column is which -------------------------------------------------

def test_a_diode_whose_name_contains_io_is_not_the_incident_beam():
    """APS 20-ID writes 'Caldiode', and Athena's 'i(0$|o)' pattern matches it.

    Importing the calibration diode as I0 gives a spectrum of the diode's
    response divided into the transmitted beam -- not an absorption spectrum.
    """
    assert 'i0' not in tokens('Caldiode')
    assert 'io' not in tokens('Caldiode')


def test_a_scaler_timer_whose_name_contains_io_is_not_the_incident_beam():
    """APS 9-BM writes 'SIS Scaler Integratio', truncated mid-word."""
    assert not {'i0', 'io'} & set(tokens('SIS Scaler Integratio'))


@pytest.mark.parametrize('name, i0, transmission', [
    ('APS20ID_2018.dat', 'PreKB-I0', 'IT'),
    ('APS9BM_2019.dat', 'I0-32', 'It-32'),
    ('APS20ID_2022.dat', 'I0', 'It'),
])
def test_the_incident_and_transmitted_beams_survive_a_decorated_label(name, i0, transmission,
                                                                     inspect):
    roles = inspect(name)['roles']
    assert (roles['i0'], roles['transmission']) == (i0, transmission)


def test_a_dead_time_corrected_copy_of_i0_does_not_win_by_coming_first():
    """APS 20-ID writes 'PreKB-I0' and also 'XMAP4:DT Corr I0'.

    Both carry an i0 token, so whichever is read first wins; the second is the
    fluorescence electronics' own copy of the chamber reading, dead-time
    corrected, and importing it as the incident beam divides one detector's
    arithmetic into another's.
    """
    chamber, copy = tokens('PreKB-I0'), tokens('XMAP4:DT Corr I0')
    assert 'i0' in chamber and 'i0' in copy
    assert 'dt' in copy and 'corr' in copy  # what tells the copy from the chamber


def test_two_columns_that_both_name_the_incident_beam_are_left_unset(inspect_written):
    """A chamber in front of the sample and one behind it, both called I0.

    Nothing in the labels says which is upstream. Taking whichever comes first
    can divide the transmitted beam into itself, so no choice is offered and
    the user makes it.
    """
    found = inspect_written(written(['energy', 'post_sample_I0', 'PreKB-I0', 'It']))
    assert 'i0' not in found['reader']['roles']
    assert 'transmission' not in found['reader']['suggestions']


def test_athenas_substring_guess_does_not_fill_a_choice_the_registry_declined(inspect_written):
    """Athena's I0 pattern is 'i(0$|o)', which matches 'ion_time'.

    Leaving that guess in place when the registry has deliberately made none
    presents a scaler's dwell time as the incident beam -- a worse answer than
    an empty one, because it looks decided.
    """
    found = inspect_written(
        written(['energy', 'ion_time', 'post_sample_I0', 'PreKB-I0', 'It']))
    assert found['chosen']['numerator'] == []
    assert found['chosen']['denominator'] == ''
    assert found['chosen']['energy_column'] == 'energy'  # the axis is still named


def test_a_file_with_no_monitor_column_keeps_the_suggestion_it_already_had(inspect_written):
    """A processed table -- energy and norm -- has no I0 to be wrong about.

    Blanking the import whenever the registry names no channels would reach
    far past the ambiguous files it is meant for: it would empty the choice
    for every exported norm or chi table web Larch writes itself, which are
    recognized as XDI and carry nothing but results. The registry withholds a
    guess only where it saw the monitor columns and could not choose between
    them.
    """
    found = inspect_written(written(['energy', 'norm']))
    assert found['reader']['suggestions'] == {}  # nothing the registry can name
    assert found['chosen']['numerator'] == ['norm']
    assert found['chosen']['energy_column'] == 'energy'


def test_the_chamber_that_shares_i0s_station_is_the_transmitted_beam(inspect):
    """LISA writes two experimental stations into one file: EH1 and EH2.

    'I1_EH1' and 'I1_EH2' both read as the transmitted beam, and the one that
    belongs with 'I0_EH1' is the one standing in the same station, not the one
    written first.
    """
    roles = inspect('ESRF_BM08_LISA_2021.dat')['roles']
    assert (roles['i0'], roles['transmission']) == ('i0_eh1', 'i1_eh1')


def test_a_corrected_total_is_not_summed_with_the_uncorrected_total(inspect_written):
    """A detector writing 'Fe_Ka_sum' and 'Fe_Ka_sum_corr' writes one signal.

    Summing both counts every photon twice and bends the edge, because the
    dead-time correction grows with count rate.
    """
    found = inspect_written(written(['energy', 'I0', 'Fe_Ka_sum', 'Fe_Ka_sum_corr']))
    assert found['reader']['roles']['fluorescence'] == ['Fe_Ka_sum_corr']


def test_the_reference_foil_is_not_imported_as_the_sample(inspect):
    """'Iref' holds the reference foil, behind the sample and its own chamber.

    Taking it for the transmitted beam would import the foil's spectrum under
    the sample's name -- a wrong spectrum that still looks like a good one.
    """
    found = inspect('APS9BM_2019.dat')
    assert found['roles']['transmission'] == 'It-32'
    assert found['roles']['reference'] == 'Iref-32'
    # Offered, but its Iref shows no Mn edge, so it is not imported by default.
    assert found['reference'] == {'numerator': 'It-32', 'denominator': 'Iref-32', 'log': True, 'default': False}


def test_requested_energy_is_not_the_axis_when_the_achieved_energy_is_written(inspect):
    """KEK-PF writes the energy it asked for and the energy it reached.

    Plotting against the requested energy hides the monochromator's own error,
    which is exactly the error an EXAFS fit is sensitive to.
    """
    assert inspect('PF9A_2022.dat')['roles']['energy'] == 'energy_attained'


def test_a_setpoint_written_as_one_word_is_not_the_energy_axis(inspect_written):
    """'EnergySetpoint' is one token, so a word-level filter never sees 'set'.

    The setpoint is the energy the monochromator was asked for; plotting
    against it hides the monochromator's own error, which is the error an
    EXAFS fit is most sensitive to.
    """
    found = inspect_written(written(['EnergySetpoint', 'Energy', 'I0', 'It']))
    assert found['reader']['roles']['energy'] == 'Energy'


def test_a_declared_unit_is_not_overruled_by_the_size_of_the_numbers(inspect_written):
    """A Li K edge scan runs from about 50 to 70 eV, and says 'eV' in its header.

    Deciding units from the range alone reads those numbers as keV and
    multiplies the axis by a thousand, which moves a soft X-ray edge into the
    hard X-ray range and makes the element search name the wrong element.
    """
    found = inspect_written(written(['energy', 'I0', 'It'], start=50., step=0.5))
    assert found['reader']['energy_units'] == 'eV'
    assert found['chosen']['units'] == 'eV'


def test_a_detector_sum_is_not_added_to_the_channels_it_already_sums(inspect):
    """PHOENIX writes a summed Al Ka channel and four corrected per-element ones.

    Importing all five counts the same photons twice over and inflates the
    fluorescence yield by about a factor of five.
    """
    found = inspect('SLS_PHOENIX_2023.dat')
    assert found['roles']['fluorescence'] == ['alka_sum_cps_c3']


def test_a_numbered_ion_chamber_is_read_from_the_beamline_not_from_its_number(inspect):
    """At SNBL the upstream chamber is 'Mon' and the transmitted beam is 'Ion1'.

    Reading 'Ion1' as the incident beam because of its number gives no edge at
    all: against a line fitted below the edge, ln(Ion1/Ion2) moves by -0.060
    across the Ge K edge of this GeO2 sample, where ln(Mon/Ion1) rises by 0.75.
    The check below recomputes that step from the file, so the mapping is tied
    to the physics and not to the labels alone.
    """
    found = inspect('ESRF_SNBL_2013.dat')
    assert (found['roles']['i0'], found['roles']['transmission']) == ('mon', 'ion1')
    # The order is a station convention, not something the file states, and
    # the evidence line has to say so: another station can wire them its way.
    assert 'station convention' in found['evidence']

    lines = (EXAMPLES / 'ESRF_SNBL_2013.dat').read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('#L'))
    names = lines[start][2:].split()
    rows = []
    for line in lines[start + 1:]:
        if line.startswith('#') or not line.strip():
            break
        rows.append([float(word) for word in line.split()])
    table = np.array(rows)
    column = {name.lower(): table[:, i] for i, name in enumerate(names)}
    energy = column['zapenergy'] * 1000.

    # The height of the edge above the pre-edge line, not a difference of
    # window means: the monochromator's flux drift and the ion chambers'
    # falling response both slope across the edge and would be counted as part
    # of it otherwise.
    def edge_step(mu, e0=11103.):
        below = (energy > e0 - 200.) & (energy < e0 - 40.)
        above = (energy > e0 + 20.) & (energy < e0 + 80.)
        slope, intercept = np.polyfit(energy[below], mu[below], 1)
        flat = mu - (slope * energy + intercept)
        return flat[above].mean()

    assert edge_step(np.log(column['mon'] / column['ion1'])) == pytest.approx(0.75, abs=0.03)
    assert abs(edge_step(np.log(column['ion1'] / column['ion2']))) < 0.1  # no edge here


def test_a_photon_factory_fluorescence_scan_does_not_make_its_detector_a_transmission(inspect):
    """The 9809 collector calls its two counters I0 and I1 whatever they were.

    At BL9A in 2022 the second counter was a fluorescence detector, and the
    file says so on its station line: 'BL9A      Fluorescence( 3)'. Reading I1
    as the transmitted beam anyway imports ln(I0/I1), and that is the spectrum
    upside down: measured on this Fe scan below, the fluorescence yield I1/I0
    rises by 0.090 across the edge against a pre-edge scatter of 0.00006, while
    ln(I0/I1) *falls* by 2.6. The mode is on the station line of every 9809
    file, so the right reading is stated rather than guessed, and BL12C's
    transmission scan keeps the usual mapping.
    """
    found = inspect('PF9A_2022.dat')
    assert found['roles']['fluorescence'] == ['i1']
    assert 'transmission' not in found['roles']
    assert 'fluorescence scan' in found['evidence']
    assert inspect('PFBL12C_2005.dat')['roles']['transmission'] == 'i1'

    # The 9809 file records monochromator angles, so the numbers below come
    # from the same plugin conversion the import uses.
    column = converted('PF9A_2022.dat')
    energy, i0, i1 = column['energy_attained'], column['i0'], column['i1']

    def edge_step(mu, e0=7122.):
        below = (energy > e0 - 120.) & (energy < e0 - 30.)
        above = (energy > e0 + 30.) & (energy < e0 + 120.)
        slope, intercept = np.polyfit(energy[below], mu[below], 1)
        flat = mu - (slope * energy + intercept)
        return float(flat[above].mean())

    assert edge_step(i1 / i0) == pytest.approx(0.090, abs=0.005)
    assert edge_step(np.log(i0 / i1)) < -2.


# -- which element was scanned ---------------------------------------------

def test_the_scanned_element_is_the_one_whose_edge_lies_in_the_scan():
    """A multi-element detector names eight elements in every file it writes.

    The labels cannot say which edge was measured; the energy axis can. APS
    20-ID's 2018 scan runs across 11867 eV, where As has its K edge and none of
    Fe, Ti, Mn, Cu, Zn, Cr or Ni has any edge at all.
    """
    watched = ['as', 'cr', 'cu', 'fe', 'mn', 'ni', 'ti', 'zn']
    assert scanned_element(watched, (11700., 12600.)) == 'as'


def test_an_ambiguous_energy_range_names_no_element():
    """Two candidate edges inside one scan is not an answer, and must not be one."""
    assert scanned_element(['fe', 'mn'], (6400., 7500.)) is None


@pytest.mark.parametrize('label, element', [
    ('XMAP4:AsKa_Sum', 'as'),
    ('XSP3:PbLa_Sum', 'pb'),
    ('Mn_Ka_mca1', 'mn'),
    ('d1_alka_corr_c13', 'al'),
])
def test_an_emission_line_label_names_its_element(label, element):
    assert emission_line(tokens(label)) == element


@pytest.mark.parametrize('label', ['Ir', 'Iref', 'I0', 'It', 'energy', 'Clock_mca1'])
def test_a_channel_label_is_not_read_as_an_emission_line(label):
    """'Ir' is the reference channel at most beamlines, and iridium at none."""
    assert emission_line(tokens(label)) is None


# -- the registry does not overrule a converter ----------------------------

def test_a_demeter_plugin_keeps_its_own_column_suggestion(enabled_store):
    """The XDAC plugin builds corr1-4 itself and knows they are the fluorescence.

    The registry must not replace a suggestion made by the code that created
    the columns in the first place.
    """
    project = enabled_store.create()
    name = 'NSLS_XDAC_2011.dat'
    result = enabled_store.inspect(project['id'], (EXAMPLES / name).read_bytes(), name)
    labels = {column['column_id']: column['name'] for column in result['columns']}
    suggestion = result['athena_suggestion']

    assert result['beamline_reader']['beamline'] == 'X-23A2'
    assert suggestion['mode'] == 'fluorescence'
    assert [labels[c] for c in suggestion['numerator']] == ['corr1', 'corr2', 'corr3', 'corr4']


def test_the_catalog_lists_every_reader_the_registry_can_report():
    catalog = reader_catalog()
    identifiers = {entry['id'] for entry in catalog}

    assert {'aps-mrcat', 'xdi', 'spec', 'esrf-zapline', 'kek-pf'} <= identifiers
    assert len(identifiers) == len(catalog)  # no duplicate entries
    for entry in catalog:
        assert entry['evidence'] and entry['format']


def test_the_catalog_also_names_the_beamlines_only_a_file_plugin_reaches():
    """Diamond B18 and the rest are opened by a Demeter reader, not by a pattern.

    They are as much part of the answer to "will it open my data?" as the
    beamlines the registry recognizes itself, so leaving them out of the
    catalog would understate the coverage by nine beamlines.
    """
    catalog = {(entry['facility'], entry['beamline']) for entry in reader_catalog()}

    assert ('Diamond Light Source', 'B18') in catalog
    assert ('Brazilian Synchrotron Light Laboratory', '') in catalog
    assert ('National Synchrotron Light Source', 'X10C') in catalog


def test_the_formats_route_answers_before_any_file_has_been_uploaded(tmp_path):
    """The question is asked while deciding whether to use web Larch at all.

    So the route must need no project and no upload; a version of it hung off
    a project would be unreachable at the moment it is wanted.
    """
    from fastapi.testclient import TestClient

    from xraylarch_web.main import create_app

    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        response = client.get('/api/athena/formats')

    assert response.status_code == 200, response.text
    assert response.json() == reader_catalog()
