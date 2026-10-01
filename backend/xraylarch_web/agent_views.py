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

from typing import Any

_COUNTED = ("marked", "frozen")

# Any run of numbers longer than this is data, not a setting, and is worth more
# as a shape than as digits nobody will read.
ARRAY_FLOOR = 8


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
            return f"<{len(value)} numbers, {value[0]:.6g} .. {value[-1]:.6g}>"
        return [elide_arrays(item) for item in value]
    return value


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
    if excluded := (source.get("merge") or {}).get("excluded"):
        derived["excluded"] = [
            {"id": item["group_id"], "label": item["label"], "reason": item["reason"]}
            for item in excluded
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
        "analyses": [
            _analysis_summary(analysis, project["version"])
            for analysis in project.get("analyses") or ()
        ],
        # What the last command did, which for a command response is the part
        # the caller asked about. Point-edit results list every removed index,
        # hundreds of them after a truncate, hence the elision.
        "last_operation": elide_arrays(project.get("last_operation")),
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
