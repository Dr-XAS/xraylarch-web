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


def _read_group(path: Path, suffix: str):
    if suffix == ".xdi":
        return read_xdi(str(path), use_pyxdi=True)
    if suffix == ".csv":
        group = read_csv(str(path))
        if getattr(group, "data", None):
            first_row = next(csv.reader([path.read_text(encoding="utf-8").splitlines()[0]]), [])
            has_header = bool(first_row) and all(
                not _can_be_float(value) for value in first_row
            )
            if has_header:
                data_lines = path.read_text(encoding="utf-8").splitlines()[1:]
                data_path = path.with_name("_numeric.csv")
                data_path.write_text("\n".join(data_lines), encoding="utf-8")
                group = read_csv(str(data_path))
                group.array_labels = [value.strip() or f"col_{i + 1:02d}" for i, value in enumerate(first_row)]
        return group
    return read_ascii(str(path))


def _can_be_float(value: str) -> bool:
    try:
        float(value.strip())
    except ValueError:
        return False
    return True


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
        value = getattr(group, label, None)
        if value is None and hasattr(group, "data"):
            data = group.data
            if isinstance(data, (list, tuple)) and index < len(data):
                value = data[index]
            else:
                data_array = np.asarray(data)
                if data_array.ndim == 2 and index < data_array.shape[0]:
                    value = data_array[index]
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
    data: bytes, filename: str, max_bytes: int = 50_000_000
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
            "Upload a text, CSV, or XDI data file.",
        )

    display_name = _safe_display_name(filename)
    suffix = Path(display_name).suffix.lower()
    try:
        with tempfile.TemporaryDirectory(prefix="xraylarch-upload-") as temp_dir:
            temp_path = Path(temp_dir) / display_name
            temp_path.write_bytes(data)
            group = _read_group(temp_path, suffix)
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
        raw_data = getattr(group, "data", ())
        if np.asarray(raw_data).size == 0:
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

    row_count = max((array.size for _, _, array in numeric_arrays), default=0)
    if row_count == 0:
        raise WebInputError(
            "upload_empty",
            "The upload contains no data rows.",
            ("file",),
            "Upload a non-empty XAS data table.",
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
        columns.append(
            ColumnInfo(
                name=name,
                index=index,
                numeric=True,
                unit=unit,
                role_hint=_role_hint(name),
                preview=tuple(float(value) for value in array[:5]),
            )
        )
        arrays[name] = array

    energy_name = next(
        (column.name for column in columns if column.role_hint == "energy"), None
    )
    if energy_name is not None:
        energy = arrays[energy_name]
        if energy.size > 1 and np.any(np.diff(energy) <= 0):
            issues.append(
                _issue(
                    "energy_not_monotonic",
                    "Energy values are not strictly increasing.",
                    energy_name,
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
