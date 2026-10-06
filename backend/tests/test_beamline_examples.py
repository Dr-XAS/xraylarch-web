"""The measured beamline files shipped with Larch must reach the import page.

``examples/xafsdata/beamlines`` holds one real scan per beamline, and a file a
beamline writes every day is the only honest test of a reader. The corpus test
drives the same path the browser does -- ``AthenaStore.inspect`` with the file
plugins switched on -- so a file that only a plugin can read still counts. The
two tests after it name the defects that kept one file each out of the app.
"""
from io import StringIO
from pathlib import Path

import numpy as np
import pytest

from larch.io import read_xdi
from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.parsing import parse_upload

EXAMPLES = Path(__file__).resolve().parents[2] / 'examples' / 'xafsdata' / 'beamlines'

# Raw FDMNES output is a calculated spectrum, not a measurement: its fourth
# line is an uncommented row of calculation parameters that no column reader
# can take for data. The convolved output of the same calculation comments
# that line out and reads fine, so only the raw file is held out here.
UNSUPPORTED = {'FDMNES_2022_Mo2C_out.dat'}

MEASURED = sorted(path.name for path in EXAMPLES.iterdir()
                  if path.is_file() and path.name not in UNSUPPORTED)


@pytest.fixture
def enabled_store(tmp_path):
    settings = Settings(data_root=tmp_path)
    AthenaPreferences(settings).save_plugins(
        PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
    return AthenaStore(settings)


@pytest.mark.parametrize('name', MEASURED)
def test_every_measured_example_file_reaches_the_column_table(name, enabled_store):
    project = enabled_store.create()
    result = enabled_store.inspect(project['id'], (EXAMPLES / name).read_bytes(), name)
    if result.get('kind') == 'scan_list':  # a SPEC file offers its scans first
        assert result['scans']
        return
    assert result['row_count'] > 0
    assert len(result['columns']) >= 2


def test_mrcat_keeps_a_sample_description_that_starts_with_a_number():
    """APS 10-BM writes the sample description above the dashed separator.

    'MnO2 5B kapton tape / 3000 x 806 / 4 layers' is prose, but two of those
    lines begin with a number. Reading such a line as a hidden observation
    rejected a valid MRCAT scan outright.
    """
    path = EXAMPLES / 'APS10BM_2019.dat'
    lines = path.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('-------')) + 2
    independent = np.loadtxt(StringIO('\n'.join(lines[start:])))

    parsed = parse_upload(path.read_bytes(), path.name)

    assert [column.name for column in parsed.columns] == ['energy', 'io', 'it', 'iref', 'if']
    assert parsed.row_count == len(independent)
    np.testing.assert_array_equal(parsed.arrays['column_0001'], independent[:, 0])


def test_xdi_mono_d_spacing_may_carry_a_unit():
    """NSLS-II BMM writes '# Mono.d_spacing: 3.1356369 A' with the unit.

    Reading that value as a bare float raised, so one cosmetic metadata field
    made the whole scan unreadable.
    """
    path = EXAMPLES / 'NSLS6BM_2019.dat'
    quoted = next(line for line in path.read_text().splitlines() if 'd_spacing' in line)
    assert len(quoted.split(':', 1)[1].split()) == 2  # the value carries a unit

    group = read_xdi(str(path), use_pyxdi=True)

    assert group.d_spacing == pytest.approx(3.1356369)
    assert parse_upload(path.read_bytes(), path.name).row_count == len(group.energy)
