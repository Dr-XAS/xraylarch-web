"""XDI files, read through the registry rather than only through larch.

XDI is the one interchange format for XAS whose column names are specified
rather than conventional, so a file that follows the dictionary should need no
guessing at all. The tests below use the real XDI scans in
``examples/xafsdata`` and each names a way the import can still go wrong: a
reference foil that is never offered for calibration, a scan whose only
absorption is already computed and so appears to have no importable channel,
and a choice between two absorption columns that depends on which the
beamline happened to write first.
"""
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.beamline_registry import identify_beamline
from xraylarch_web.config import Settings

EXAMPLES = Path(__file__).resolve().parents[2] / 'examples' / 'xafsdata'


@pytest.fixture
def inspect(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    store = AthenaStore(settings)
    project = store.create()

    def run(name):
        result = store.inspect(project['id'], (EXAMPLES / name).read_bytes(), name)
        labels = {column['column_id']: column['name'] for column in result['columns']}

        def spell(value):
            if isinstance(value, list):
                return [labels.get(item, item) for item in value]
            return labels.get(value, value)

        reader = dict(result['beamline_reader'])
        reader['roles'] = {role: spell(value) for role, value in reader['roles'].items()}
        if reader.get('reference'):
            reader['reference'] = {**reader['reference'],
                                   'numerator': spell(reader['reference']['numerator']),
                                   'denominator': spell(reader['reference']['denominator'])}
        chosen = result['athena_suggestion']
        return {'reader': reader,
                'chosen': {**chosen, 'numerator': spell(chosen['numerator']),
                           'denominator': spell(chosen['denominator'])}}

    return run


def columns_of(name):
    """The file's columns by label, read straight from the parser."""
    from xraylarch_web.parsing import parse_upload

    parsed = parse_upload((EXAMPLES / name).read_bytes(), name)
    return {column.name.lower(): parsed.arrays[column.column_id] for column in parsed.columns}


def test_the_version_line_is_what_makes_a_file_xdi():
    """A column file with XDI-shaped fields but no version line is not XDI.

    Claiming XDI for a file that only resembles one would promise the caller
    a specified column dictionary the file does not actually follow.
    """
    body = b'# Beamline.name: 13-BM-D\n# Column.1: energy eV\n# energy i0\n7000 1.0\n7001 1.0\n'
    assert identify_beamline(body) is None or identify_beamline(body)['id'] != 'xdi'
    assert identify_beamline(b'# XDI/1.0\n' + body)['id'] == 'xdi'


def test_the_header_names_the_facility_and_the_beamline():
    found = identify_beamline((EXAMPLES / 'cu_romanglass.xdi').read_bytes())
    assert (found['facility'], found['beamline']) == ('APS', '13-ID-E, GSECARS')
    assert found['format'] == 'XDI 1.0'
    # This file states no element anywhere, and none is invented for it.
    assert 'edge' not in found


def test_the_edge_is_read_from_either_spelling_the_format_has_used():
    """XDI 1.0 writes Element.symbol; the GSE/1.0 files before it wrote Scan.element.

    Reading only the newer spelling loses the edge on every older file, and
    with it the energy the normalisation should be centred on.
    """
    older = identify_beamline((EXAMPLES / 'cu_metal_rt.xdi').read_bytes())
    newer = identify_beamline((EXAMPLES / 'feo_rt1.xdi').read_bytes())

    assert older['edge'] == 'Cu K'
    assert newer['edge'] == 'Fe K'


def test_a_file_that_states_no_facility_is_not_given_one():
    """cu_metal_rt.xdi names its beamline and its source but no facility."""
    found = identify_beamline((EXAMPLES / 'cu_metal_rt.xdi').read_bytes())
    assert found['beamline'] == 'APS 13ID'
    assert found['facility'] == 'not stated in the file'


def test_the_reference_foil_is_offered_for_energy_calibration(inspect):
    """XDI spells the reference channel 'irefer', which the registry missed.

    Without it the reference scan recorded alongside the sample is just
    another unnamed column, and the user has no calibration standard.
    """
    found = inspect('cu_romanglass.xdi')
    assert found['reader']['roles']['reference'] == 'irefer'
    assert found['reader']['reference'] == {
        'numerator': 'itrans', 'denominator': 'irefer', 'log': True}


def test_a_scan_whose_only_absorption_is_already_computed_still_imports(inspect):
    """fe3c_rt.xdi holds energy, mutrans and i0: no transmitted beam at all.

    Before 'mutrans' was read as an absorption this file produced no import
    suggestion of any kind, so the browser offered nothing to plot.
    """
    found = inspect('fe3c_rt.xdi')
    assert found['chosen']['mode'] == 'mu'
    assert found['chosen']['numerator'] == ['mutrans']
    assert found['chosen']['denominator'] is None


def test_the_absorption_chosen_does_not_depend_on_the_column_order(inspect):
    """cu_romanglass.xdi writes mufluor before mutrans; both are absorptions.

    Taking whichever came first would make the default import an accident of
    the beamline's column layout. The transmission absorption is taken,
    because it is the same quantity as the raw i0 and itrans columns beside
    it; the fluorescence is offered through its own channel.
    """
    found = inspect('cu_romanglass.xdi')
    columns = columns_of('cu_romanglass.xdi')
    assert list(columns).index('mufluor') < list(columns).index('mutrans')
    assert found['reader']['roles']['mu'] == 'mutrans'
    assert found['reader']['roles']['fluorescence'] == ['ifluor']


def test_the_uncorrected_copy_of_a_channel_is_not_summed_with_the_corrected_one(inspect):
    """cu_romanglass.xdi writes 'ifluor' and 'ifluor_raw' -- one signal, twice.

    Its own header says which is which: column 4 is deadtime-corrected and
    column 5 is not. Importing both counts every photon about twice, and the
    error is largest where the count rate is highest, so it flattens the edge
    rather than merely scaling it.
    """
    columns = columns_of('cu_romanglass.xdi')
    raw, corrected = columns['ifluor_raw'], columns['ifluor']
    assert np.median(raw / corrected) < 1.0  # the correction only adds counts
    assert inspect('cu_romanglass.xdi')['reader']['roles']['fluorescence'] == ['ifluor']


def test_the_absorption_column_is_the_logarithm_of_the_two_beams():
    """The role mapping has to agree with the arithmetic, not just the names.

    If 'i0' and 'itrans' were swapped, or either were mapped to the wrong
    column, ln(i0/itrans) would no longer reproduce the file's own mutrans.
    """
    columns = columns_of('cu_metal_rt.xdi')
    computed = np.log(columns['i0'] / columns['itrans'])

    assert np.allclose(computed, columns['mutrans'], atol=1e-6)
