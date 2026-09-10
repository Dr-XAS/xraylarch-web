from __future__ import annotations

import csv
import re
import tempfile
from pathlib import Path, PurePath

import numpy as np
from larch.io import read_ascii, read_csv, read_xdi

from .contracts import ColumnInfo, FieldIssue, ParsedUpload
from .errors import WebInputError

_ROLE_NAMES = {
    "energy": "energy",
    "e": "energy",
    "mu": "mu",
    "xmu": "mu",
    "i0": "i0",
    "it": "it",
    "ifluor": "ifluor",
}
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_NAME_CHARS = re.compile(r"[^A-Za-z0-9._ -]+")
_COMMENT_PREFIXES = ("#", ";", "!")
_DEFAULT_MAX_POINTS = 250_000
_DEFAULT_MAX_COLUMNS = 64
_XDAC_MARKER = re.compile(r"XDAC V\d+(?:\.\d+)* Datafile V\d+(?:\.\d+)*")
_MRCAT_MARKER = re.compile(r"MRCAT_XAFS V\d+(?:\.\d+)* Datafile")
_XDAC_SEPARATOR = re.compile(r"-{7,}")
_XDAC_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _safe_display_name(filename: str) -> str:
    raw_name = PurePath(str(filename).replace("\\", "/")).name
    safe_name = _CONTROL_CHARS.sub("_", raw_name)
    safe_name = _NAME_CHARS.sub("_", safe_name).strip(" .")
    return safe_name or "upload.dat"


def _normalized_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _role_hint(name: str) -> str | None:
    normalized = _normalized_name(name)
    return _ROLE_NAMES.get(normalized)


def _issue(code: str, message: str, *fields: str, recovery: str) -> FieldIssue:
    return FieldIssue(code=code, message=message, fields=fields, recovery=recovery)


def _noncomment_lines(text: str) -> list[str]:
    lines: list[str] = []
    record: list[str] = []
    quote_open = False
    for line in text.splitlines():
        if not record and line.strip() and line.lstrip().startswith(_COMMENT_PREFIXES):
            continue
        record.append(line)
        index = 0
        while index < len(line):
            if line[index] != '"':
                index += 1
                continue
            if quote_open and index + 1 < len(line) and line[index + 1] == '"':
                index += 2
                continue
            quote_open = not quote_open
            index += 1
        if not quote_open:
            if any(part.strip() for part in record):
                lines.append("\n".join(record))
            record = []
    if record and any(part.strip() for part in record):
        lines.append("\n".join(record))
    return lines


def _csv_dialect(text: str) -> csv.Dialect:
    lines = _noncomment_lines(text)
    sample = "\n".join(lines[:20])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        return csv.excel


def _read_group(path: Path, suffix: str):
    if suffix == ".xdi":
        return read_xdi(str(path), use_pyxdi=True)
    if suffix == ".csv":
        text = path.read_text(encoding="utf-8-sig")
        dialect = _csv_dialect(text)
        lines = _noncomment_lines(text)
        rows = [
            tuple(value.strip() for value in next(csv.reader([line], dialect)))
            for line in lines
        ]
        normalized_path = path.with_name("_normalized.csv")
        normalized_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        group = read_csv(str(normalized_path))
        if rows and all(not _can_be_float(value) for value in rows[0]):
            data_path = path.with_name("_numeric.csv")
            with data_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle, dialect=dialect, lineterminator="\n")
                writer.writerows(rows[1:])
            group = read_csv(str(data_path))
            group.array_labels = [
                value or f"col_{i + 1:02d}" for i, value in enumerate(rows[0])
            ]
        return group
    return read_ascii(str(path))


def _can_be_float(value: str) -> bool:
    try:
        float(value.strip())
    except ValueError:
        return False
    return True


def _tabular_rows(text: str, suffix: str) -> tuple[tuple[str, ...], ...]:
    lines = _noncomment_lines(text)
    if suffix != ".csv":
        return tuple(tuple(line.split()) for line in lines)

    dialect = _csv_dialect(text)
    return tuple(
        tuple(value.strip() for value in next(csv.reader([line], dialect)))
        for line in lines
    )


def _beamline_table(text: str) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]] | None:
    """Locate XDAC/MRCAT tables without guessing where observations start.

    Source: larch/io/xafs_beamlines.py, NSLSXDAC_BeamlineData and
    APSMRCAT_BeamlineData. The first line identifies the format, and labels
    follow the first '-------' separator. The measured XDAC V1.2/V1.4 and
    MRCAT V0.3 fixtures use dash-only separators and whitespace labels.
    Blank lines are ignored, as in larch/io/columnfile.py read_ascii.

    Our boundary is deliberately stricter than Larch's reverse scan, which
    can discard damaged first/middle observations as header text. Once
    labels are consumed, every nonblank line is a data row, including text
    or comments that Larch might otherwise treat as a header/footer. A
    numeric-leading row before the boundary is ambiguous and rejected.
    Metadata is not rewritten: read_ascii still receives the original file,
    and ParsedUpload.source_bytes retains its complete original header.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    if lines[0].lower().startswith('xdac'):
        name, marker = 'XDAC', _XDAC_MARKER
    elif lines[0].lower().startswith('mrcat_xafs'):
        name, marker = 'MRCAT', _MRCAT_MARKER
    else:
        return None

    def malformed_header():
        return WebInputError(
            "upload_malformed_rows",
            f"The {name} header must contain a valid {name} version marker, a dashed separator, and column labels before data.",
            ("file",),
            f"Restore the {name} header and label line; do not move observations into the header.",
        )

    if not marker.fullmatch(lines[0]):
        raise malformed_header()
    boundary = next((i for i, line in enumerate(lines[1:], 1) if "-------" in line), None)
    if boundary is None or not _XDAC_SEPARATOR.fullmatch(lines[boundary]) or boundary + 1 >= len(lines):
        raise malformed_header()
    if any(_can_be_float(line.split()[0]) for line in lines[1:boundary]):
        raise malformed_header()
    labels = tuple(lines[boundary + 1].split())
    if not labels or not all(_XDAC_LABEL.fullmatch(label) and not _can_be_float(label) for label in labels):
        raise malformed_header()
    rows = tuple(tuple(line.split()) for line in lines[boundary + 2:])
    if not rows:
        raise WebInputError(
            "upload_empty", f"The {name} upload contains no data rows.", ("file",),
            f"Upload a non-empty {name} data table.",
        )
    return labels, rows


def _validate_tabular_text(
    data: bytes,
    suffix: str,
    *,
    max_points: int,
    max_columns: int,
) -> None:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise WebInputError(
            "upload_unreadable",
            "The upload could not be read as XAS text data.",
            ("file",),
            "Save the file as UTF-8 text and upload it again.",
        ) from exc

    beamline = _beamline_table(text) if suffix == ".dat" else None
    expected_fields = len(beamline[0]) if beamline is not None else None
    if expected_fields is not None and expected_fields > max_columns:
        raise WebInputError(
            "upload_too_many_columns",
            f"Upload exceeds the {max_columns} column limit.", ("file",),
            "Choose a table with fewer columns.",
        )
    rows = beamline[1] if beamline is not None else _tabular_rows(text, suffix)
    point_count = 0
    for fields in rows:
        values: list[float] = []
        numeric = bool(fields)
        numeric_fields = 0
        for field in fields:
            try:
                value = float(field)
            except ValueError:
                numeric = False
                continue
            numeric_fields += 1
            if not np.isfinite(value):
                raise WebInputError(
                    "upload_nonfinite",
                    "The upload contains non-finite numeric values.",
                    ("file",),
                    "Remove non-finite rows and upload the data again.",
                )
            values.append(value)
        numeric = bool(fields) and numeric_fields == len(fields)

        if expected_fields is None:
            if not numeric:
                if 0 < numeric_fields < len(fields):
                    raise WebInputError(
                        "upload_malformed_rows",
                        "The upload contains a malformed or inconsistent data row.",
                        ("file",),
                        "Repair the tabular rows and upload the data again.",
                    )
                continue
            expected_fields = len(values)
            if expected_fields > max_columns:
                raise WebInputError(
                    "upload_too_many_columns",
                    f"Upload exceeds the {max_columns} column limit.",
                    ("file",),
                    "Choose a table with fewer columns.",
                )
        elif not numeric or len(values) != expected_fields:
            raise WebInputError(
                "upload_malformed_rows",
                "The upload contains a malformed or inconsistent data row.",
                ("file",),
                "Repair the tabular rows and upload the data again.",
            )

        point_count += 1
        if point_count > max_points:
            raise WebInputError(
                "upload_too_many_points",
                f"Upload exceeds the {max_points} point limit.",
                ("file",),
                "Choose a spectrum with fewer data points.",
            )


def _has_data_lines(data: bytes) -> bool:
    text = data.decode("utf-8", errors="replace")
    return any(
        line.strip() and line.lstrip()[0] not in "#;!"
        for line in text.splitlines()
    )


def _numeric_arrays(group) -> tuple[tuple[str, str | None, np.ndarray], ...]:
    labels = list(getattr(group, "array_labels", ()) or ())
    if not labels:
        data = getattr(group, "data", ())
        if isinstance(data, (list, tuple)):
            labels = [f"col_{index + 1:02d}" for index in range(len(data))]
        else:
            data_array = np.asarray(data)
            if data_array.ndim == 2:
                labels = [f"col_{index + 1:02d}" for index in range(data_array.shape[0])]

    units = list(getattr(group, "array_units", ()) or ())
    arrays: list[tuple[str, str | None, np.ndarray]] = []
    for index, label in enumerate(labels):
        value = None
        if hasattr(group, "data"):
            data = group.data
            if isinstance(data, (list, tuple)) and index < len(data):
                value = data[index]
            else:
                data_array = np.asarray(data)
                if data_array.ndim == 2 and index < data_array.shape[0]:
                    value = data_array[index]
        if value is None:
            value = getattr(group, label, None)
        if value is None:
            continue
        try:
            array = np.asarray(value, dtype=float)
        except (TypeError, ValueError):
            continue
        if array.ndim != 1:
            continue
        unit = units[index] if index < len(units) and units[index] else None
        arrays.append((str(label), unit, np.array(array, dtype=float, copy=True)))
    return tuple(arrays)


def parse_upload(
    data: bytes,
    filename: str,
    max_bytes: int = 50_000_000,
    max_points: int = _DEFAULT_MAX_POINTS,
    max_columns: int = _DEFAULT_MAX_COLUMNS,
) -> ParsedUpload:
    """Parse a bounded XAS upload without executing or persisting user paths."""
    if len(data) > max_bytes:
        raise WebInputError(
            "upload_too_large",
            f"Upload exceeds the {max_bytes} byte limit.",
            ("file",),
            "Choose a smaller text upload.",
        )
    if b"\x00" in data:
        raise WebInputError(
            "upload_binary",
            "The upload contains binary NUL bytes.",
            ("file",),
            "Upload a readable text, CSV, or XDI data file.",
        )

    display_name = _safe_display_name(filename)
    suffix = Path(display_name).suffix.lower()
    parser_suffix = suffix if suffix in {".xdi", ".csv"} else ".dat"
    _validate_tabular_text(
        data,
        parser_suffix,
        max_points=max_points,
        max_columns=max_columns,
    )
    try:
        with tempfile.TemporaryDirectory(prefix="xraylarch-upload-") as temp_dir:
            temp_path = Path(temp_dir) / display_name
            temp_path.write_bytes(data)
            group = _read_group(temp_path, parser_suffix)
            numeric_arrays = _numeric_arrays(group)
    except WebInputError:
        raise
    except Exception as exc:
        raise WebInputError(
            "upload_unreadable",
            "The upload could not be read as XAS text data.",
            ("file",),
            "Check the file format and upload it again.",
        ) from exc

    if not numeric_arrays:
        if not _has_data_lines(data):
            raise WebInputError(
                "upload_empty",
                "The upload contains no data rows.",
                ("file",),
                "Upload a non-empty XAS data table.",
            )
        raise WebInputError(
            "upload_no_numeric_data",
            "The upload does not contain numeric data columns.",
            ("file",),
            "Upload a table with at least one numeric column.",
        )
    if len(numeric_arrays) > max_columns:
        raise WebInputError(
            "upload_too_many_columns",
            f"Upload exceeds the {max_columns} column limit.",
            ("file",),
            "Choose a table with fewer columns.",
        )

    row_count = max((array.size for _, _, array in numeric_arrays), default=0)
    if row_count == 0:
        raise WebInputError(
            "upload_empty",
            "The upload contains no data rows.",
            ("file",),
            "Upload a non-empty XAS data table.",
        )
    if row_count > max_points:
        raise WebInputError(
            "upload_too_many_points",
            f"Upload exceeds the {max_points} point limit.",
            ("file",),
            "Choose a spectrum with fewer data points.",
        )

    columns: list[ColumnInfo] = []
    arrays: dict[str, np.ndarray] = {}
    issues: list[FieldIssue] = []
    for index, (name, unit, array) in enumerate(numeric_arrays):
        if not np.isfinite(array).all():
            raise WebInputError(
                "upload_nonfinite",
                f"Column '{name}' contains non-finite values.",
                (name,),
                "Remove non-finite rows and upload the data again.",
            )
        column_id = f"column_{index + 1:04d}"
        columns.append(
            ColumnInfo(
                column_id=column_id,
                name=name,
                index=index,
                numeric=True,
                unit=unit,
                role_hint=_role_hint(name),
                preview=tuple(float(value) for value in array[:5]),
            )
        )
        arrays[column_id] = array

    energy_key = next(
        (
            column.column_id
            for column in columns
            if column.role_hint == "energy"
        ),
        None,
    )
    if energy_key is not None:
        energy = arrays[energy_key]
        if energy.size > 1 and np.any(np.diff(energy) <= 0):
            issues.append(
                _issue(
                    "energy_not_monotonic",
                    "Energy values are not strictly increasing.",
                    energy_key,
                    recovery="Repair the energy order before processing.",
                )
            )

    return ParsedUpload(
        display_name=display_name,
        row_count=row_count,
        columns=tuple(columns),
        arrays=arrays,
        warnings=(),
        issues=tuple(issues),
        source_bytes=data,
    )
