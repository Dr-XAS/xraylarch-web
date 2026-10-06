"""Saved Athena projects, and the beamlines Demeter's plugins stand for.

Two things reach the import route that the column readers cannot handle on
their own. The first is a saved Athena project: it holds processed groups
rather than columns, and the browser only routes it to the project preview
when its name ends in .prj, so a project saved as .json or renamed by a user
used to be pushed through the column parser and fail with a message about NUL
bytes. The second is a file whose beamline nothing in its own header states --
a 2006 APS 9-BM scan is an ordinary SPEC file to anything reading its first
line -- but which one of Demeter's plugins recognizes from the shape of its
columns.
"""
import gzip
from pathlib import Path

import pytest

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.beamline_registry import PLUGIN_BEAMLINES, athena_project, reader_catalog
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError

EXAMPLES = Path(__file__).resolve().parents[2] / 'examples' / 'xafsdata'
PROJECTS = EXAMPLES / 'AthenaProjectFiles'


@pytest.fixture
def inspect(tmp_path):
    """Inspect an upload with every file plugin enabled, as the route does."""
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    store = AthenaStore(settings)
    project = store.create()

    def run(data, name):
        return store.inspect(project['id'], data, name)

    return run


# One example of each shape the 80 projects in the corpus take: gzipped
# Demeter text, gzipped Athena text, plain text, and the JSON of 0.9.26
# both gzipped and not.
@pytest.mark.parametrize('name, writer, compressed', [
    ('cu.prj', 'Athena', True),
    ('AgL3_CAMD.prj', 'Demeter', True),
    ('Vathena.prj', 'Demeter', False),
    ('athena3.prj', 'Demeter', True),
    ('json_unzipped.prj', 'Demeter', False),
])
def test_a_project_is_recognized_whatever_shape_it_was_saved_in(name, writer, compressed):
    found = athena_project((PROJECTS / name).read_bytes())

    assert found['writer'] == writer
    assert found['compressed'] is compressed
    assert found['version']


def test_a_column_file_is_not_mistaken_for_a_project():
    """Recognition is by header line, so ordinary uploads must fall through.

    If anything with a '#' comment block were taken for a project, every
    beamline column file in the corpus would be routed away from the column
    readers and open with no columns at all.
    """
    for name in ('beamlines/APS12BM_2019.dat', 'cu_metal_rt.xdi', 'fe3c_rt.xdi'):
        assert athena_project((EXAMPLES / name).read_bytes()) is None
    # Nor is a gzipped file that is not a project, nor unreadable gzip.
    assert athena_project(gzip.compress(b'# energy i0 it\n7000 1 1\n')) is None
    assert athena_project(b'\x1f\x8b' + b'not actually compressed') is None


def test_a_project_saved_under_another_name_still_opens_as_a_project(inspect):
    """The browser routes by file name; this is the case that defeats it.

    Athena itself saves projects as .prj, but the corpus carries them as
    .json too, and a user who renames one gets whatever the column parser
    makes of gzipped binary -- previously an error about NUL bytes that said
    nothing about what the file was.
    """
    result = inspect((PROJECTS / 'cu.prj').read_bytes(), 'copper_scans.dat')

    assert result['kind'] == 'project'
    assert result['preview']['groups']


def test_a_project_that_hides_code_in_a_group_is_still_refused(inspect):
    """danger.prj is the corpus's deliberate attack fixture.

    Recognizing projects earlier must not route them around the check that
    refuses a project whose fields hold Perl to be evaluated rather than
    numbers.
    """
    with pytest.raises(WebInputError) as raised:
        inspect((PROJECTS / 'danger.prj').read_bytes(), 'danger.prj')

    assert 'not executable expressions' in str(raised.value)


def test_the_catalog_lists_the_project_format_it_can_open():
    """The formats view is the demo's answer to "what can this open?"."""
    entry = next(item for item in reader_catalog() if item['id'] == 'athena-project')

    assert 'Athena project' in entry['format']


def test_every_plugin_named_here_is_a_plugin_that_exists():
    """The attribution table is keyed by short plugin name, the catalog by package.

    The two spellings are what makes this worth a test: 'CMC' in a converted
    file's own metadata is 'Demeter::Plugins::CMC' in the catalog, and a table
    written in the catalog's spelling silently never matches anything.
    """
    known = {plugin['id'].rsplit('::', 1)[-1] for plugin in plugin_catalog()}

    assert set(PLUGIN_BEAMLINES) <= known


def test_a_plugin_names_the_beamline_the_file_itself_does_not(inspect):
    """APS9BM_2006.dat is a bare SPEC file; only the CMC plugin places it."""
    result = inspect((EXAMPLES / 'beamlines' / 'APS9BM_2006.dat').read_bytes(), 'APS9BM_2006.dat')
    reader = result['beamline_reader']

    assert result['file_plugin']['id'] == 'CMC'
    assert (reader['facility'], reader['beamline']) == ('Advanced Photon Source', '9-BM (CMC-XOR)')


def test_what_the_file_says_about_itself_beats_what_a_plugin_infers(inspect):
    """The CLS file is claimed by the HXMA plugin, which reads two beamlines.

    Its own header names which one, so the header's answer is kept rather
    than replaced by the plugin's broader claim.
    """
    result = inspect((EXAMPLES / 'beamlines' / 'CLSHXMA.dat').read_bytes(), 'CLSHXMA.dat')

    assert result['file_plugin']['id'] == 'HXMA'
    assert result['beamline_reader']['beamline'] == 'HXMA (06ID-1)'
