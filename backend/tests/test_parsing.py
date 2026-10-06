from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import _noncomment_lines, parse_upload


def test_parse_upload_returns_numeric_columns_and_monotonicity(sample_xmu_bytes):
    parsed = parse_upload(sample_xmu_bytes, "Cu scan 01.xmu")

    assert parsed.display_name == "Cu scan 01.xmu"
    assert parsed.row_count > 10
    assert [column.name for column in parsed.columns[:2]] == ["energy", "mu"]
    assert [column.column_id for column in parsed.columns[:2]] == [
        "column_0001",
        "column_0002",
    ]
    assert parsed.columns[0].role_hint == "energy"
    assert parsed.issues == ()


def test_parse_upload_sanitizes_name_and_rejects_oversize():
    parsed = parse_upload(b"1 2\n2 3\n", "../../unsafe\nname.xmu")

    assert ".." not in parsed.display_name
    with pytest.raises(WebInputError) as exc:
        parse_upload(b"1 2\n", "x.xmu", max_bytes=3)
    assert exc.value.code == "upload_too_large"


def test_parse_upload_reports_non_monotonic_energy():
    parsed = parse_upload(b"# energy mu\n3 1\n2 2\n4 3\n", "bad.dat")

    assert any(issue.code == "energy_not_monotonic" for issue in parsed.issues)


def test_parse_upload_rejects_nul_bytes():
    with pytest.raises(WebInputError) as exc:
        parse_upload(b"1 2\n\x00\n", "binary.dat")

    assert exc.value.code == "upload_binary"


def test_parse_upload_rejects_empty_table():
    with pytest.raises(WebInputError) as exc:
        parse_upload(b"# metadata only\n\n", "empty.dat")

    assert exc.value.code == "upload_empty"


def test_parse_upload_rejects_missing_numeric_array():
    with pytest.raises(WebInputError) as exc:
        parse_upload(b"not numeric\nstill text\n", "text.dat")

    assert exc.value.code == "upload_no_numeric_data"


def test_nonfinite_value_is_reported_for_its_column_instead_of_refusing_the_file():
    # A dead-time-corrected channel reading 0/0 at one point used to refuse
    # the whole file, even when nobody selected that channel.
    parsed = parse_upload(b"# energy mu dtc\n1 2 nan\n2 3 4\n3 4 5\n", "nonfinite.dat")

    assert parsed.columns[2].preview == (None, 4.0, 5.0)
    assert any("'dtc' has 1 non-finite values (data rows 1)" in w for w in parsed.warnings)
    assert parsed.inspection().model_dump_json()  # still valid JSON for the browser


def test_truncated_last_row_is_dropped_with_a_warning_but_interior_rows_still_refuse():
    rows = "".join(f"{7000 + i} {100 + i} {50 + i}\n" for i in range(10))
    parsed = parse_upload(f"# energy i0 it\n{rows}7010 110\n".encode(), "interrupted.dat")
    assert parsed.row_count == 10 and np.isfinite(parsed.arrays["column_0003"]).all()
    assert any("last data row (11) is incomplete" in w for w in parsed.warnings)

    damaged = rows.replace("7004 104 54\n", "7004 104\n")
    with pytest.raises(WebInputError, match="data row 5 has 2 fields"):
        parse_upload(f"# energy i0 it\n{damaged}".encode(), "damaged.dat")


@pytest.mark.parametrize("delimiter", [";", "\t"])
def test_parse_upload_uses_detected_csv_dialect_for_header(delimiter):
    data = f"energy{delimiter}mu{delimiter}mu\n1{delimiter}2{delimiter}3\n2{delimiter}4{delimiter}5\n".encode()

    parsed = parse_upload(data, "dialect.csv")

    assert [column.name for column in parsed.columns] == ["energy", "mu", "mu"]
    assert [column.role_hint for column in parsed.columns] == ["energy", "mu", "mu"]
    assert parsed.arrays["column_0002"].tolist() == [2.0, 4.0]
    assert parsed.arrays["column_0003"].tolist() == [3.0, 5.0]


@pytest.mark.parametrize("data", [
    b"# metadata\nenergy,mu\n1,2\n2,3\n",
    b"\xef\xbb\xbf# metadata\nenergy,mu\n# between rows\n1,2\n2,3\n",
    b"# metadata\n1,2\n2,3\n",
])
def test_parse_upload_ignores_csv_comments_before_larch(data):
    parsed = parse_upload(data, "commented.csv")

    assert parsed.row_count == 2
    assert parsed.arrays["column_0001"].tolist() == [1.0, 2.0]
    assert parsed.arrays["column_0002"].tolist() == [2.0, 3.0]


def test_parse_upload_preserves_quoted_multiline_csv_record():
    data = b'energy,mu\n1,2\n2,3\n'

    parsed = parse_upload(data, "multiline.csv")

    assert parsed.row_count == 2
    assert parsed.arrays["column_0001"].tolist() == [1.0, 2.0]


def test_csv_comment_filter_keeps_quoted_multiline_records():
    text = 'energy,mu\n1,"first\n# still quoted"\n2,3\n'

    assert _noncomment_lines(text) == [
        "energy,mu",
        '1,"first\n# still quoted"',
        "2,3",
    ]


def test_csv_comment_filter_handles_escaped_quotes():
    text = 'energy,mu\n1,"say ""#""\ncontinued"\n2,3\n'

    assert _noncomment_lines(text)[1] == '1,"say ""#""\ncontinued"'


@pytest.mark.parametrize(
    ("filename", "data"),
    [
        ("leading.dat", b"# energy mu\n1 nope\n2 3\n"),
        ("leading.csv", b"energy,mu\n1,nope\n2,3\n"),
        ("leading.xdi", b"# XDI/1.0 GSE/1.0\n# Column.1: energy eV\n# Column.2: mu\n1 nope\n2 3\n"),
    ],
)
def test_parse_upload_rejects_a_malformed_leading_observation(filename, data):
    with pytest.raises(WebInputError) as error:
        parse_upload(data, filename)

    assert error.value.code == "upload_malformed_rows"


def test_a_corrupt_row_is_not_dropped_as_if_it_were_a_comment():
    """A row that starts with two numbers and then goes wrong is still a row.

    Judging a line only by its width lets a truncated or garbled row fall
    through to the comment filter, and the scan is then imported one point
    short with nothing said about it -- the worst kind of wrong, because the
    spectrum still looks fine.
    """
    data = (b"# energy i0 it iref\n7000 1.0 0.5 0.2\n"
            b"7001 1.0 oops\n7002 1.0 0.5 0.2\n7003 1.0 0.5 0.2\n")
    with pytest.raises(WebInputError) as error:
        parse_upload(data, "truncated.dat")

    assert error.value.code == "upload_malformed_rows"


def test_a_note_that_begins_with_a_number_is_not_read_as_data():
    """MRCAT writes the sample note '3000 x 806' on line 15 of its header.

    One number followed by a word is prose; the rule above must not turn such
    a line into a malformed row and reject the whole file.
    """
    path = (Path(__file__).resolve().parents[2]
            / "examples" / "xafsdata" / "beamlines" / "APS10BM_2019.dat")
    parsed = parse_upload(path.read_bytes(), path.name)

    assert parsed.row_count == 3464  # the file's 3480 lines less its 16 of header
    assert [column.name for column in parsed.columns][:2] == ["energy", "io"]


def test_parse_upload_preserves_duplicate_source_labels():
    parsed = parse_upload(
        b"energy,mu,mu\n1,2,3\n2,4,5\n", "duplicate.csv"
    )

    assert [column.name for column in parsed.columns] == ["energy", "mu", "mu"]
    assert [column.column_id for column in parsed.columns] == [
        "column_0001",
        "column_0002",
        "column_0003",
    ]
    assert list(parsed.arrays) == ["column_0001", "column_0002", "column_0003"]
    assert parsed.arrays["column_0002"].tolist() == [2.0, 4.0]
    assert parsed.arrays["column_0003"].tolist() == [3.0, 5.0]


def test_parse_upload_column_ids_do_not_collide_with_source_labels():
    parsed = parse_upload(
        b"energy,mu,mu,mu__2\n1,2,3,4\n2,5,6,7\n", "collision.csv"
    )

    assert [column.name for column in parsed.columns] == [
        "energy",
        "mu",
        "mu",
        "mu__2",
    ]
    assert [column.index for column in parsed.columns] == [0, 1, 2, 3]
    assert [column.column_id for column in parsed.columns] == [
        "column_0001",
        "column_0002",
        "column_0003",
        "column_0004",
    ]
    assert len(parsed.arrays) == 4
    assert parsed.arrays["column_0001"].tolist() == [1.0, 2.0]
    assert parsed.arrays["column_0002"].tolist() == [2.0, 5.0]
    assert parsed.arrays["column_0003"].tolist() == [3.0, 6.0]
    assert parsed.arrays["column_0004"].tolist() == [4.0, 7.0]


@pytest.mark.parametrize(
    ("filename", "data"),
    [
        ("broken.dat", b"# energy mu\n1 2\nbad row\n3 4\n"),
        ("broken.csv", b"energy,mu\n1,2\n3\n4,5\n"),
        ("broken.xdi", b"# XDI/1.0 GSE/1.0\n# Column.1: energy eV\n# Column.2: mu\n1 2\n3 nope\n4 5\n"),
    ],
)
def test_parse_upload_rejects_a_malformed_middle_row(filename, data):
    with pytest.raises(WebInputError) as error:
        parse_upload(data, filename)

    assert error.value.code == "upload_malformed_rows"
    assert "bad row" not in error.value.message
    assert "nope" not in error.value.message


def test_parse_upload_enforces_point_and_column_limits_before_larch():
    with pytest.raises(WebInputError) as points_error:
        parse_upload(b"1 2\n2 3\n3 4\n", "points.dat", max_points=2)
    with pytest.raises(WebInputError) as columns_error:
        parse_upload(b"1 2 3\n2 3 4\n", "columns.dat", max_columns=2)

    assert points_error.value.code == "upload_too_many_points"
    assert columns_error.value.code == "upload_too_many_columns"


def test_parse_upload_accepts_arbitrary_suffix():
    parsed = parse_upload(b"1 2\n2 3\n", "spectrum.exe")

    assert parsed.display_name == "spectrum.exe"
    assert parsed.row_count == 2
    assert [column.name for column in parsed.columns] == ["col1", "col2"]
