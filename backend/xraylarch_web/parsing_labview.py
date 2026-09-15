"""Read the explicit numbered legend in APS LabVIEW scan headers.

The legend is printed down columns, not in acquisition order. Its indices
identify the data columns; parentheses inside detector names are ordinary
label text. Larch still reads the original numeric data and metadata.
"""
from __future__ import annotations

import re

from .errors import WebInputError


_SIGNATURE = "1-D Scan File created by LabVIEW Control Panel"
_LEGEND = "Here is a readable list of column headings:"
_HEADINGS = "Column Headings:"
_NUMBER = re.compile(r"(?<!\S)([-+]?\d+)\)\s*")


def _comment(line: str) -> str | None:
    stripped = line.lstrip()
    return stripped[1:].strip() if stripped.startswith("#") else None


def _malformed() -> WebInputError:
    return WebInputError(
        "upload_malformed_rows",
        "The LabVIEW header requires a complete numbered column legend and its column-heading boundary before data.",
        ("file",),
        "Restore the original LabVIEW header and consecutive column numbers; do not move observations into the header.",
    )


def labview_table(text: str) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]] | None:
    """Return source-ordered labels and every observation after the header.

    Older LabVIEW files without either explicit legend marker keep the generic
    reader. Once either marker identifies the numbered format, an incomplete
    header fails rather than falling back to potentially shifted labels.
    """
    lines = [line for line in text.splitlines() if line.strip()]
    first = _comment(lines[0]) if lines else None
    if first is None or not (first == _SIGNATURE or first.startswith(_SIGNATURE + " ")):
        return None

    legends = [i for i, line in enumerate(lines) if _comment(line) == _LEGEND]
    headings = [i for i, line in enumerate(lines) if _comment(line) == _HEADINGS]
    if not legends and not headings:
        return None
    if len(legends) != 1 or len(headings) != 1 or legends[0] >= headings[0]:
        raise _malformed()
    legend, boundary = legends[0], headings[0]
    if any(_comment(line) is None for line in lines[:boundary + 1]):
        raise _malformed()

    numbered: dict[int, str] = {}
    for line in lines[legend + 1:boundary]:
        content = _comment(line)
        if not content:
            continue
        matches = list(_NUMBER.finditer(content))
        if not matches or content[:matches[0].start()].strip():
            raise _malformed()
        for i, match in enumerate(matches):
            token = match[1]
            number = int(token)
            end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
            label = content[match.end():end].strip()
            if number < 1 or token != str(number) or number in numbered or not label:
                raise _malformed()
            numbered[number] = label
    if not numbered or sorted(numbered) != list(range(1, len(numbered) + 1)):
        raise _malformed()

    # The format has one commented, flattened heading line after this marker.
    # Do not seek the first numeric line: that could discard a damaged first
    # observation. Every subsequent nonblank line is validated as data.
    if boundary + 1 >= len(lines) or not _comment(lines[boundary + 1]):
        raise _malformed()
    rows = tuple(tuple(line.split()) for line in lines[boundary + 2:])
    if not rows:
        raise WebInputError(
            "upload_empty", "The LabVIEW upload contains no data rows.", ("file",),
            "Upload a non-empty LabVIEW data table.",
        )
    return tuple(numbered[i] for i in range(1, len(numbered) + 1)), rows
