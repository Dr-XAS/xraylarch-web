import pytest

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload


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


def test_parse_upload_rejects_nonfinite_value():
    with pytest.raises(WebInputError) as exc:
        parse_upload(b"# energy mu\n1 nan\n2 3\n", "nonfinite.dat")

    assert exc.value.code == "upload_nonfinite"


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


def test_parse_upload_rejects_unsupported_suffix():
    with pytest.raises(WebInputError) as error:
        parse_upload(b"1 2\n2 3\n", "spectrum.exe")

    assert error.value.code == "upload_extension"
