import pytest

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload


def test_parse_upload_returns_numeric_columns_and_monotonicity(sample_xmu_bytes):
    parsed = parse_upload(sample_xmu_bytes, "Cu scan 01.xmu")

    assert parsed.display_name == "Cu scan 01.xmu"
    assert parsed.row_count > 10
    assert [column.name for column in parsed.columns[:2]] == ["energy", "mu"]
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
    assert list(parsed.arrays) == ["energy", "mu", "mu__2"]
    assert parsed.arrays["mu"].tolist() == [2.0, 4.0]
    assert parsed.arrays["mu__2"].tolist() == [3.0, 5.0]
