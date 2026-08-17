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
