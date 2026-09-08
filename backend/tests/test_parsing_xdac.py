"""XDAC validation against real NSLS V1.2/V1.4 files and local Larch.

Oracle: larch/io/xafs_beamlines.py NSLSXDAC_BeamlineData, and
larch/io/columnfile.py read_ascii. The reader and numeric arrays are real;
damaged rows must fail before that reader can discard them as header text.
"""

from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from larch.io import read_ascii

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload


EXAMPLES = Path(__file__).parents[2] / "examples" / "xafsdata"
HEADER = ('XDAC V1.2 Datafile V1\n'
          '"fe.060" created on 10/3/02 at 10:20:36 PM on X-11A\n'
          'Ring energy= 2.58 GeV\nE0= 7112.00\n'
          'SRB= -200 -20 20 22k\nOffsets= 9925.80 9914.40\n'
          'Iron foil, I0: 50%N2, It:N2\n\n'
          '--------------------------------------------------------------------------------\n'
          'Energy I0 It\n')
ROWS = ['6911.98862 41410.4000 39622.2000',
        '6916.99353 41396.4000 39720.2000',
        '6922.00600 41300.4000 39729.2000']


def upload(rows=ROWS, header=HEADER):
    return (header + '\n'.join(rows) + '\n').encode()


def assert_error(data, code="upload_malformed_rows", **limits):
    with pytest.raises(WebInputError) as exc:
        parse_upload(data, "fe.060", **limits)
    assert exc.value.code == code
    assert exc.value.fields == ("file",)
    assert exc.value.recovery


@pytest.mark.parametrize("filename,points,columns", [
    ("fe.060", 511, 3), ("beamlines/NSLS_XDAC_2011.dat", 422, 17),
])
def test_real_xdac_preserves_all_raw_arrays_larch_labels_and_metadata(filename, points, columns, tmp_path):
    path = EXAMPLES / filename
    source = path.read_bytes()
    parsed = parse_upload(source, path.name, max_points=points, max_columns=columns)
    direct = read_ascii(str(path))
    lines = source.decode().splitlines()
    boundary = next(i for i, line in enumerate(lines) if line.startswith('-------'))
    independent = np.loadtxt(StringIO('\n'.join(lines[boundary + 2:])))

    assert parsed.row_count == points
    assert len(parsed.columns) == columns
    assert [col.name for col in parsed.columns] == direct.array_labels
    assert [col.name for col in parsed.columns[:3]] == ['energy', 'i0', 'it']
    assert [col.role_hint for col in parsed.columns[:3]] == ['energy', 'i0', 'it']
    for i, col in enumerate(parsed.columns):
        np.testing.assert_array_equal(parsed.arrays[col.column_id], independent[:, i])
        np.testing.assert_array_equal(parsed.arrays[col.column_id], direct.data[i])
        assert col.preview == tuple(independent[:5, i])
    assert parsed.issues == parsed.warnings == ()

    # The public contract retains metadata as original source bytes. Verify
    # it still yields the same complete Larch header and parsed attributes.
    assert parsed.source_bytes == source
    restored = tmp_path / path.name
    restored.write_bytes(parsed.source_bytes)
    reread = read_ascii(str(restored))
    assert reread.header == direct.header
    for key in ['E0', 'NUM_REGIONS', 'SRB', 'SRSS', 'SPP', 'Offsets', 'Gains']:
        assert getattr(reread.attrs, key) == getattr(direct.attrs, key)


@pytest.mark.parametrize("suffix", [".060", ".dat", ".xmu", ".txt"])
def test_xdac_recognition_is_content_based_for_ascii_suffixes(suffix):
    parsed = parse_upload(upload(), 'iron' + suffix)
    assert parsed.row_count == 3
    assert parsed.arrays['column_0001'][0] == 6911.98862
    assert parsed.columns[2].role_hint == 'it'


def test_xdac_boundary_allows_blank_lines_and_crlf_as_larch_does():
    data = upload().replace(b'Energy I0 It\n', b'\n  Energy I0 It\n\n')
    data = data.replace(b'\n', b'\r\n')
    parsed = parse_upload(data, 'iron.dat')
    assert parsed.row_count == 3
    assert [col.name for col in parsed.columns] == ['energy', 'i0', 'it']
    assert parsed.source_bytes == data


@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("row", [
    '6911.98862 nope 39622.2000', 'bad first observation',
    '6911.98862 41410.4000', '6911.98862 41410.4000 39622.2000 9',
    '# damaged observation', 'E0= 7112.00', '-------',
])
def test_every_row_after_labels_is_strict_even_first_and_last(index, row):
    rows = list(ROWS)
    rows[index] = row
    assert_error(upload(rows))


@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("value", ['nan', 'inf', '-inf', '1e999'])
def test_xdac_nonfinite_observations_are_rejected(index, value):
    rows = list(ROWS)
    rows[index] = f'6911.98862 {value} 39622.2000'
    assert_error(upload(rows), 'upload_nonfinite')


@pytest.mark.parametrize("header", [
    HEADER.replace('XDAC V1.2 Datafile V1', 'XDAC broken version'),
    HEADER.replace('XDAC V1.2 Datafile V1', 'XDAC V1.2'),
    HEADER.replace('XDAC V1.2 Datafile V1', 'xdac V1.2 Datafile V1'),
    HEADER.replace('-' * 80 + '\n', ''),
    HEADER.replace('-' * 80, '------'),
    HEADER.replace('-' * 80, 'notes ------- not a boundary'),
    HEADER.replace('Energy I0 It\n', ''),
    HEADER.replace('Energy I0 It', 'Energy 2 It'),
    HEADER.replace('Energy I0 It', 'Energy nan It'),
    HEADER.replace('Energy I0 It', '-------\nEnergy I0 It'),
    HEADER.replace('-' * 80, '6911.98862 41410.4000 39622.2000\n' + '-' * 80),
    HEADER.replace('-' * 80, '6911.98862 nope 39622.2000\n' + '-' * 80),
])
def test_malformed_xdac_header_cannot_hide_or_skip_observations(header):
    assert_error(upload(header=header))


def test_xdac_missing_label_and_data_lines_are_not_a_generic_empty_header():
    assert_error(HEADER.rsplit('Energy', 1)[0].encode())
    assert_error(HEADER.encode(), 'upload_empty')


def test_unrecognized_headers_keep_generic_malformed_leading_row_validation():
    for marker in ['other format', '# XDAC V1.2 Datafile V1', '']:
        assert_error(upload(header=HEADER.replace('XDAC V1.2 Datafile V1', marker)))
    assert_error(b'Energy I0 It\n6911 nope 39622\n6916 41396 39720\n')


@pytest.mark.parametrize("limits,code", [
    ({'max_points': 2}, 'upload_too_many_points'),
    ({'max_columns': 2}, 'upload_too_many_columns'),
    ({'max_bytes': 20}, 'upload_too_large'),
])
def test_xdac_resource_limits_still_apply(limits, code):
    assert_error(upload(), code, **limits)


def test_real_xdac_limits_count_data_not_header_numbers():
    data = (EXAMPLES / 'fe.060').read_bytes()
    assert_error(data, 'upload_too_many_points', max_points=510)
    assert_error(data, 'upload_too_many_columns', max_columns=2)


def test_binary_and_encoding_validation_precede_xdac_recognition():
    assert_error(upload().replace(b'Iron', b'\x00Iron'), 'upload_binary')
    assert_error(upload().replace(b'Iron', b'\xffIron'), 'upload_unreadable')
