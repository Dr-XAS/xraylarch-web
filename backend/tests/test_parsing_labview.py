"""Synthetic LabVIEW scans exercise wide tables without private beamline data."""
from __future__ import annotations

import numpy as np
import pytest

from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload
from xraylarch_web.parsing_labview import labview_table


def make_scan(width=72, count=3):
    labels = ["Mono Energy (alt) *", "Scaler preset time *", "Ipreslit", "I0", "It", "Iref"]
    labels.extend(f"Detector:{i}:counts" for i in range(7, width + 1))
    if width >= 12:
        labels[10:12] = ["XMAP12B:CuKa_Sum", "XMAP12B:Total_Sum"]
    labels = labels[:width]
    # The acquisition legend runs down ten rows, then continues to the right.
    legend = ["#  " + "    ".join(f"{i + 1}) {labels[i]}" for i in range(row, width, 10))
              for row in range(min(10, width))]
    header = "\n".join([
        "# 1-D Scan File created by LabVIEW Control Panel  synthetic scan",
        "# Beamline 20 BM", "# Here is a readable list of column headings:",
        *legend, "#", "# Column Headings:", "#" + "  ".join(labels),
    ]) + "\n"
    data = np.arange(count * width, dtype=float).reshape(count, width) + 0.25
    data[:, 0] = 8900. + np.arange(count)
    rows = [" ".join(str(value) for value in row) for row in data]
    return header, rows, labels, data


def make_fixed_width_scan(detector_label="XMAP8:1:Total"):
    """Match the 9 BM legend layout, using entirely artificial observations."""
    _, rows, _, data = make_scan(width=27)
    labels = [
        "Mono Energy *", "Scaler preset time *", "SIS scaler time preset",
        "SIS Scaler Integration time", "I0", "IT", "IRef", "IF",
        "XMAP8:DT Corr I0", "XMAP8:SnKa_Sum", "XMAP8:Total_Sum",
        detector_label,
        *(f"XMAP8:{i}:Total" for i in range(2, 9)),
        *(f"XMAP8:{i}:SnKa" for i in range(8)),
    ]
    # LabVIEW truncates/pads each label to 21 characters without inserting a
    # separator before the next cell. Long labels therefore touch 13) and 14).
    labels = [label[:21] for label in labels]
    legend = [
        "# " + "".join(f"{i + 1:2d}) {labels[i]:21}" for i in range(row, 27, 10))
        for row in range(10)
    ]
    header = "\n".join([
        "# 1-D Scan File created by LabVIEW Control Panel  synthetic scan",
        "# Beamline 9 BM", "# Here is a readable list of column headings:",
        *legend, "#", "# Column Headings:",
        "#" + "".join(f"{label:21}" for label in labels),
    ]) + "\n"
    return header, rows, labels, data


def source(header, rows):
    return (header + "\n".join(rows) + "\n").encode()


def assert_error(data, code="upload_malformed_rows", **limits):
    with pytest.raises(WebInputError) as exc:
        parse_upload(data, "synthetic.0002", **limits)
    assert exc.value.code == code
    assert exc.value.fields == ("file",)


@pytest.mark.parametrize("width", [72, 128])
def test_numbered_legend_preserves_full_labels_and_every_source_column(width):
    header, rows, labels, expected = make_scan(width)
    payload = source(header, rows)
    parsed = parse_upload(payload, "synthetic.0002")
    assert [column.name for column in parsed.columns] == labels
    assert [column.index for column in parsed.columns] == list(range(width))
    assert parsed.row_count == len(expected)
    assert parsed.source_bytes == payload
    actual = np.column_stack([parsed.arrays[column.column_id] for column in parsed.columns])
    np.testing.assert_array_equal(actual, expected)
    assert parsed.columns[10].name == "XMAP12B:CuKa_Sum"
    assert parsed.columns[11].name == "XMAP12B:Total_Sum"
    assert parsed.columns[-1].name == labels[-1]


def test_labview_table_recognizes_numbering_without_confusing_label_parentheses():
    header, rows, labels, _ = make_scan()
    table = labview_table(source(header, rows).decode())
    assert table == (tuple(labels), tuple(tuple(row.split()) for row in rows))


@pytest.mark.parametrize("line_ending", [b"\n", b"\r\n"])
def test_fixed_width_legend_preserves_labels_every_column_and_source_bytes(line_ending):
    header, rows, labels, expected = make_fixed_width_scan()
    assert "SIS scaler time prese13)" in header
    assert "SIS Scaler Integratio14)" in header
    payload = source(header, rows).replace(b"\n", line_ending)
    parsed = parse_upload(payload, "synthetic.0001")
    assert parsed.source_bytes == payload
    assert parsed.row_count == len(expected)
    assert [column.name for column in parsed.columns] == labels
    assert [column.index for column in parsed.columns] == list(range(27))
    actual = np.column_stack([parsed.arrays[column.column_id] for column in parsed.columns])
    np.testing.assert_array_equal(actual, expected)
    assert parsed.columns[2].name == "SIS scaler time prese"
    assert parsed.columns[3].name == "SIS Scaler Integratio"
    assert parsed.columns[12].name == "XMAP8:2:Total"
    assert parsed.columns[13].name == "XMAP8:3:Total"


@pytest.mark.parametrize("label", [
    "Detector (13) counts", "XMAP8:(14):Total", "Detector counts set 1",
])
def test_fixed_width_numbers_inside_labels_are_not_column_markers(label):
    header, rows, labels, _ = make_fixed_width_scan(detector_label=label)
    table = labview_table(source(header, rows).decode())
    assert table == (tuple(labels), tuple(tuple(row.split()) for row in rows))


@pytest.mark.parametrize("damage", ["missing", "duplicate", "empty_label"])
def test_fixed_width_incomplete_or_duplicate_legend_is_rejected(damage):
    header, rows, _, _ = make_fixed_width_scan()
    cell = f"13) {'XMAP8:2:Total':21}"
    replacement = {
        "missing": "",
        "duplicate": f"12) {'XMAP8:2:Total':21}",
        "empty_label": f"13) {'':21}",
    }[damage]
    assert cell in header
    assert_error(source(header.replace(cell, replacement), rows))


@pytest.mark.parametrize("scan_factory", [make_scan, make_fixed_width_scan])
@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("damage", ["text", "short", "extra", "comment"])
def test_first_middle_and_last_damaged_observations_cannot_be_skipped(index, damage, scan_factory):
    header, rows, _, _ = scan_factory()
    fields = rows[index].split()
    rows[index] = {
        "text": "bad observation",
        "short": " ".join(fields[:-1]),
        "extra": rows[index] + " 99",
        "comment": "# damaged observation",
    }[damage]
    assert_error(source(header, rows))


@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("nonfinite", ["nan", "inf", "-inf", "1e999"])
def test_nonfinite_values_in_high_columns_are_rejected(index, nonfinite):
    header, rows, _, _ = make_scan()
    fields = rows[index].split()
    fields[-1] = nonfinite
    rows[index] = " ".join(fields)
    assert_error(source(header, rows), "upload_nonfinite")


@pytest.mark.parametrize("old,new", [
    ("11) XMAP12B:CuKa_Sum", "12) XMAP12B:CuKa_Sum"),
    ("11) XMAP12B:CuKa_Sum", "73) XMAP12B:CuKa_Sum"),
    ("11) XMAP12B:CuKa_Sum", "0) XMAP12B:CuKa_Sum"),
    ("11) XMAP12B:CuKa_Sum", "011) XMAP12B:CuKa_Sum"),
    ("11) XMAP12B:CuKa_Sum", "11) "),
    ("# Column Headings:\n", ""),
    ("# Here is a readable list of column headings:\n", ""),
    ("# Beamline 20 BM", "8900 1 2"),
])
def test_invalid_numbered_headers_fail_instead_of_shifting_columns(old, new):
    header, rows, _, _ = make_scan()
    assert_error(source(header.replace(old, new), rows))


def test_legend_count_must_match_observation_width():
    header, rows, _, _ = make_scan()
    assert_error(source(header.replace("    72) Detector:72:counts", ""), rows))


def test_empty_table_and_explicit_resource_limits_remain_enforced():
    header, rows, _, _ = make_scan()
    assert_error(source(header, []), "upload_empty")
    assert_error(source(header, rows), "upload_too_many_columns", max_columns=71)
    assert_error(source(header, rows), "upload_too_many_points", max_points=2)
    assert_error(source(header, rows), "upload_too_large", max_bytes=20)


def test_blank_lines_and_crlf_do_not_change_values_or_labels():
    header, rows, labels, expected = make_scan()
    payload = source(header.replace("#\n", "#\n\n"), rows).replace(b"\n", b"\r\n")
    parsed = parse_upload(payload, "synthetic.0002")
    assert parsed.source_bytes == payload
    assert [column.name for column in parsed.columns] == labels
    np.testing.assert_array_equal(parsed.arrays["column_0072"], expected[:, 71])


def test_unrelated_and_legacy_headers_keep_existing_parser_route():
    header, rows, _, _ = make_scan()
    assert labview_table(source(header.replace("LabVIEW Control Panel", "Other Control Panel"), rows).decode()) is None
    assert labview_table("# 1-D Scan File created by LabVIEW Control Panel  old scan\n# energy i0\n1 2\n") is None
