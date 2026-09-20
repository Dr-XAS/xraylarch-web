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
_FIXED_NUMBER = re.compile(r" *([-+]?\d+)\) ")
_LABEL_WIDTH = 21


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


def _fixed_width_legend(contents: list[str], heading: str) -> list[tuple[str, str]] | None:
    """Recognize the export with 21-character labels and no cell separator.

    A full-width label can touch the next index, including when the label ends
    in a digit. Read whole cells, then require agreement with the flattened
    heading so other, whitespace-separated legend variants keep their parser.
    """
    entries: list[tuple[str, str]] = []
    for content in contents:
        offset = 0
        while content[offset:].strip():
            match = _FIXED_NUMBER.match(content, offset)
            if match is None:
                return None
            end = match.end() + _LABEL_WIDTH
            entries.append((match[1], content[match.end():end].strip()))
            offset = end
    flattened = "".join(
        label.ljust(_LABEL_WIDTH) for _, label in sorted(entries, key=lambda entry: int(entry[0]))
    ).strip()
    return entries if entries and flattened == heading else None


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

    if boundary + 1 >= len(lines) or not (heading := _comment(lines[boundary + 1])):
        raise _malformed()
    contents = [_comment(line) for line in lines[legend + 1:boundary]]
    contents = [content for content in contents if content]
    entries = _fixed_width_legend(contents, heading)
    if entries is None:
        entries = []
        for content in contents:
            matches = list(_NUMBER.finditer(content))
            if not matches or content[:matches[0].start()].strip():
                raise _malformed()
            for i, match in enumerate(matches):
                end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
                entries.append((match[1], content[match.end():end].strip()))
    numbered: dict[int, str] = {}
    for token, label in entries:
        number = int(token)
        if number < 1 or token != str(number) or number in numbered or not label:
            raise _malformed()
        numbered[number] = label
    if not numbered or sorted(numbered) != list(range(1, len(numbered) + 1)):
        raise _malformed()

    # The format has one commented, flattened heading line after this marker.
    # Do not seek the first numeric line: that could discard a damaged first
    # observation. Every subsequent nonblank line is validated as data.
    rows = tuple(tuple(line.split()) for line in lines[boundary + 2:])
    if not rows:
        raise WebInputError(
            "upload_empty", "The LabVIEW upload contains no data rows.", ("file",),
            "Upload a non-empty LabVIEW data table.",
        )
    return tuple(numbered[i] for i in range(1, len(numbered) + 1)), rows
