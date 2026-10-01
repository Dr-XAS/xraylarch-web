"""Compact projections of a project, for callers that read responses rather than plot them.

The stored project record carries each group's measured energy and mu plus the
twenty-four result arrays named in ARRAY_NAMES. The bundled three-group copper
example serializes to roughly 480 KB; a twenty-group EXAFS project reaches
several megabytes. That is the right payload for the browser, which draws it,
and the wrong one for an agent, which has to fit it in a context window.

Nothing here computes science. Every value is read from a group's stored
parameters or from the effective settings that its last processing run
recorded, so a projection can never disagree with the full record or cost a
reprocess. No array is ever included; ask for arrays explicitly instead.

Ranges are reported on the same axis as the e0 beside them, which for energy
spectra means after energy_shift is applied. energy_shift is reported too, so
the measured axis can be recovered.
"""
from __future__ import annotations

import json
from typing import Any

_COUNTED = ("marked", "frozen")

# Any run of numbers longer than this is data, not a setting, and is worth more
# as a shape than as digits nobody will read.
ARRAY_FLOOR = 8


def describe_numbers(values: list) -> str:
    """The marker an elided array leaves: its length, its ends, and its extremes.

    For an axis the ends are the extremes and the marker stops there. For a
    curve they are not: a merge's stddev is small at both ends and largest at
    the edge, and an alignment's derivative is near zero at both ends of its
    window, so a marker showing only the ends hides the part a caller wanted.
    """
    head = f"<{len(values)} numbers, {values[0]:.6g} .. {values[-1]:.6g}"
    steps = [b - a for a, b in zip(values, values[1:])]
    if all(step >= 0 for step in steps) or all(step <= 0 for step in steps):
        return head + ">"
    return head + f", min {min(values):.6g}, max {max(values):.6g}>"


def elide_arrays(value: Any) -> Any:
    """Replace plotting arrays with a description of what was left out.

    There are ten preview endpoints and no two return the same shape, so this
    walks whatever arrives rather than knowing any of them. What matters is that
    the elision is visible: a caller must be able to tell that an array was here
    and ask for it another way, which is why the marker carries the length and
    both ends rather than just saying something was dropped.
    """
    if isinstance(value, dict):
        return {key: elide_arrays(item) for key, item in value.items()}
    if isinstance(value, list):
        numbers = [item for item in value
                   if isinstance(item, (int, float)) and not isinstance(item, bool)]
        if len(value) > ARRAY_FLOOR and len(numbers) == len(value):
            return describe_numbers(value)
        return [elide_arrays(item) for item in value]
    return value


# What one entry of last_operation may cost in a summary. An alignment of fifty
# groups reports about 7.5 KB of per-group shifts and fits; the example
# action's Artemis fit setup is 30 KB of configuration and does not.
OPERATION_BUDGET = 8_000


def _last_operation(operation: dict | None) -> dict | None:
    """last_operation with its arrays elided and any oversized entry described.

    Entries get added to last_operation as features need them, and nothing
    stops one being large: the example action attaches a whole Artemis fit
    setup. Capping each entry rather than listing the bulky ones means the next
    one is caught too, and the marker says where the full value can be read.
    """
    if not operation:
        return operation
    trimmed = {}
    for key, value in elide_arrays(operation).items():
        size = len(json.dumps(value, default=str))
        if size <= OPERATION_BUDGET:
            trimmed[key] = value
            continue
        shape = (f"keys {', '.join(list(value)[:6])}" if isinstance(value, dict)
                 else f"{len(value)} items" if isinstance(value, list) else "text")
        trimmed[key] = (f"<{size / 1000:.1f} KB omitted ({shape}); "
                        "read the project without a view for it>")
    return trimmed


def _derivation(group) -> dict | None:
    """What a derived group was made from, and what it left out.

    The selection sent to /command is not what a merge used. The default merge
    drops any spectrum more than ten points shorter than the first, so merging
    the three copper scans quietly leaves out the 300 K one, and the only record
    of that is deep in the group's source. Without this a caller checks the
    selection it sent, finds three groups, and reports a merge that never
    happened.
    """
    source = group["source"]
    if not (operation := source.get("operation")):
        return None
    parents = source.get("parents") or ([source["parent"]] if source.get("parent") else [])
    derived = {"operation": operation, "parents": parents}
    if operation == "merge":
        # The label is native Athena's "merge" whatever was averaged, and a
        # merge of normalized spectra reads an edge step of about 1 where one
        # of mu reads the members' average, so say which it was.
        derived["array"] = source.get("array")
        # Always present on a merge, so an empty list means nothing was left
        # out rather than that nobody looked.
        derived["excluded"] = [
            {"id": item["group_id"], "label": item["label"], "reason": item["reason"]}
            for item in (source.get("merge") or {}).get("excluded") or ()
        ]
    return derived


def _range(group) -> tuple[str, list[float] | None, float]:
    """Return the axis name, its span, and the shift already folded into it."""
    # A chi group stores k in the energy slot; energy_shift does not apply to it.
    axis = "k" if group["data_type"] == "chi" else "energy"
    shift = 0.0 if axis == "k" else float(group["parameters"]["energy_shift"])
    values = group["energy"]
    span = [float(values[0]) + shift, float(values[-1]) + shift] if values else None
    return axis, span, shift


def group_summary(group: dict) -> dict:
    """One group without its arrays: identity, state, and what processing resolved."""
    result = group.get("result") or {}
    effective = result.get("effective") or {}
    identity = group["source"].get("edge_identity") or {}
    axis, span, shift = _range(group)
    return {
        "id": group["id"],
        "label": group["label"],
        "data_type": group["data_type"],
        # Two groups read from one file are the same measurement, which no
        # number in this summary can say on its own.
        "file": group["source"].get("filename"),
        "is_normalized": group["is_normalized"],
        "is_difference": group["is_difference"],
        "marked": group["marked"],
        "frozen": group["frozen"],
        "element": identity.get("element"),
        "edge": identity.get("edge"),
        "edge_origin": identity.get("origin"),
        "e0": effective.get("e0"),
        "edge_step": effective.get("edge_step"),
        "energy_shift": shift,
        "axis": axis,
        "range": span,
        "points": len(group["energy"]),
        "processed": bool(result) and not group["processing_error"],
        "processing_error": group["processing_error"],
        "exafs": bool(effective.get("exafs")),
        "available_kmax": effective.get("available_kmax"),
        "reference_id": group["reference_id"],
        "background_standard_id": group["background_standard_id"],
        "derived": _derivation(group),
        "warnings": result.get("warnings") or [],
    }


def _analysis_summary(analysis: dict, version: int) -> dict:
    """An analysis without its fitted arrays, flagged if the project moved on."""
    return {
        "id": analysis["id"],
        "kind": analysis["kind"],
        "created": analysis["created"],
        "group_ids": analysis["group_ids"],
        "project_version": analysis["project_version"],
        "stale": analysis["project_version"] != version,
    }


def _same_data(project: dict) -> list[list[str]]:
    """Labels that hold identical raw arrays, one list per measurement.

    The bundled example carries the 300 K scan twice, once as a sample and once
    as the foils' shared reference, and a caller reading only numbers took
    several digests and a byte comparison of two exports to establish it.
    """
    from .athena_alignment import signature

    seen: dict[str, list[str]] = {}
    for group in project["groups"]:
        # A chi group keeps k in the energy slot, so its arrays are not a scan.
        if group["data_type"] != "chi" and group["energy"]:
            seen.setdefault(signature(group), []).append(group["label"])
    return [labels for labels in seen.values() if len(labels) > 1]


def project_summary(project: dict) -> dict:
    """The whole project with no arrays anywhere."""
    groups = [group_summary(group) for group in project["groups"]]
    counts = {name: sum(1 for group in groups if group[name]) for name in _COUNTED}
    counts["groups"] = len(groups)
    counts["processed"] = sum(1 for group in groups if group["processed"])
    counts["failed"] = sum(1 for group in groups if group["processing_error"])
    return {
        "id": project["id"],
        "name": project["name"],
        "version": project["version"],
        "updated": project["updated"],
        # Presentational keys are read defensively. A project.json written
        # before one of them existed should still summarize rather than 500 at
        # the caller least able to recover from it.
        "format": project.get("format"),
        "counts": counts,
        "groups": groups,
        "same_data": _same_data(project),
        "analyses": [
            _analysis_summary(analysis, project["version"])
            for analysis in project.get("analyses") or ()
        ],
        # What the last command did, which for a command response is the part
        # the caller asked about.
        "last_operation": _last_operation(project.get("last_operation")),
        "can_undo": bool(project.get("undo")),
        "can_redo": bool(project.get("redo")),
        "journal_chars": len(project.get("journal") or ""),
    }


def project_parameters(project: dict) -> dict:
    """Every group's processing recipe, and what processing actually used.

    Requested and effective values are kept apart deliberately: a range the
    user asked for and a range Larch clipped to the measured support are
    different facts, and collapsing them hides the clipping.
    """
    return {
        "id": project["id"],
        "version": project["version"],
        "groups": [
            {
                "id": group["id"],
                "label": group["label"],
                "data_type": group["data_type"],
                "requested": group["parameters"],
                "effective": (group.get("result") or {}).get("effective") or {},
                "processing_error": group["processing_error"],
            }
            for group in project["groups"]
        ],
    }


VIEWS = {"summary": project_summary, "parameters": project_parameters}


def applied_parameters(project: dict, group_ids: list[str], keys) -> list[dict]:
    """What a parameters command asked for and what processing then used.

    Without this the reply to a parameters command says only that the version
    moved, and the one thing the caller wants to know, whether Larch honoured
    the value or clipped it, costs another read.
    """
    wanted = set(group_ids)
    return [
        {"id": group["id"], "label": group["label"],
         "processing_error": group["processing_error"],
         "values": {key: {"requested": group["parameters"].get(key),
                          "effective": ((group.get("result") or {}).get("effective") or {}).get(key)}
                    for key in keys}}
        for group in project["groups"] if group["id"] in wanted
    ]


def project_view(project: dict, view: str) -> dict:
    """The project as `view` asks for it; `full` is the stored record untouched."""
    return project if view == "full" else VIEWS[view](project)


def preview_view(payload: dict, view: str) -> dict:
    """A preview reply as `view` asks for it.

    A preview carries the curves it wants drawn, 120 to 140 KB of them on the
    copper example, and what a caller acts on is everything else. `summary`
    elides the curves; `full` keeps them for the browser, which draws them.
    """
    return payload if view == "full" else elide_arrays(payload)
