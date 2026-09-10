"""Measured Demeter quick scan, with a strict MRCAT header/data boundary."""
from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from larch.io import read_ascii

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload

FIXTURE = Path(__file__).parent / 'fixtures' / 'demeter-uhup.101'
LINES = FIXTURE.read_text().splitlines()
START = next(i for i, line in enumerate(LINES) if line.startswith('-------')) + 2


@pytest.mark.parametrize('suffix', ['.101', '.dat', '.xmu', '.txt'])
def test_measured_mrcat_reads_every_observation_and_retains_source(suffix):
    data = FIXTURE.read_bytes()
    parsed = parse_upload(data, 'quick' + suffix, max_points=2006, max_columns=5)
    direct = read_ascii(str(FIXTURE))
    independent = np.loadtxt(StringIO('\n'.join(LINES[START:])))
    assert parsed.row_count == 2006
    assert [c.name for c in parsed.columns] == direct.array_labels == ['energy', 'mcs3', 'mcs4', 'mcs5', 'mcs6']
    for i, column in enumerate(parsed.columns):
        np.testing.assert_array_equal(parsed.arrays[column.column_id], independent[:, i])
        np.testing.assert_array_equal(parsed.arrays[column.column_id], direct.data[i])
    assert np.count_nonzero(np.diff(parsed.arrays['column_0001']) == 0) == 24
    assert parsed.source_bytes == data
    assert any(issue.code == 'energy_not_monotonic' for issue in parsed.issues)


@pytest.mark.parametrize('index', [0, 1000, 2005])
@pytest.mark.parametrize('row,code', [('16999 broken 1 2 3', 'upload_malformed_rows'),
    ('# not a footer', 'upload_malformed_rows'), ('1 2 3 4', 'upload_malformed_rows'),
    ('16999 1 nan 2 3', 'upload_nonfinite')])
def test_mrcat_never_discards_damaged_observations_as_headers(index, row, code):
    lines = list(LINES); lines[START + index] = row
    with pytest.raises(WebInputError) as err:
        parse_upload('\n'.join(lines).encode(), 'quick.101')
    assert err.value.code == code


@pytest.mark.parametrize('edit', ['version', 'separator', 'labels', 'hidden_row', 'empty'])
def test_invalid_mrcat_header_cannot_hide_data(edit):
    lines = list(LINES)
    if edit == 'version': lines[0] = 'MRCAT_XAFS broken'
    if edit == 'separator': lines[START - 2] = 'separator missing'
    if edit == 'labels': lines[START - 1] = '1 2 3 4 5'
    if edit == 'hidden_row': lines.insert(2, LINES[START])
    if edit == 'empty': lines = lines[:START]
    with pytest.raises(WebInputError) as err:
        parse_upload('\n'.join(lines).encode(), 'quick.101')
    assert err.value.code == ('upload_empty' if edit == 'empty' else 'upload_malformed_rows')


@pytest.mark.parametrize('limits,code', [({'max_points': 2005}, 'upload_too_many_points'),
    ({'max_columns': 4}, 'upload_too_many_columns')])
def test_mrcat_limits_count_data_and_all_detector_columns(limits, code):
    with pytest.raises(WebInputError) as err:
        parse_upload(FIXTURE.read_bytes(), 'quick.101', **limits)
    assert err.value.code == code
