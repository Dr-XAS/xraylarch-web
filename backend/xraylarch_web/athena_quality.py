"""Read-only review of saved spectrum processing and identical input arrays."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .agent_views import group_summary
from .athena_alignment import signature
from .athena_science import normalization_adjustments


class QualityReport(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    version: int = Field(ge=0)
    scope: Literal["all", "marked"] = "all"


_NOTES = [
    "This snapshot reads saved results without processing or changing groups. "
    "Review the spectra and experimental context before combining or interpreting them.",
    "Identical input arrays are checked against the whole project. Copies can have "
    "different processing or reference roles; identical arrays do not establish independent measurements.",
    "Warnings include processing notices and assumptions. Their presence or absence is not a quality score.",
]


def _theory(group):
    source = group.get("source") or {}
    tags = source.get("tags")
    return group["data_type"] == "xmudat" or isinstance(tags, list) and "theory" in tags


def _difference(group):
    return bool(group.get("is_difference") or (group.get("source") or {}).get("operation") == "difference")


def _duplicate_eligible(group):
    return (group["data_type"] != "detector" and not _difference(group)
            and not _theory(group) and bool(group.get("energy")))


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _adjustments(group, effective):
    """Only explicit, applicable settings count as requested/effective changes."""
    if group["data_type"] == "detector" or _difference(group):
        return []
    requested = group["parameters"]
    changes = []
    if (group["data_type"] not in ("chi", "norm", "xmudat")
            and not group.get("is_normalized")):
        changes.extend({"parameter": item["parameter"], "requested": item["requested"],
                        "effective": item["used"], "unit": "eV relative to E0"}
                       for item in normalization_adjustments(requested, effective))
    if effective.get("exafs"):
        keys = ("kmin", "kmax", "rmin", "rmax")
        if group["data_type"] != "chi":
            keys = ("bkg_kmin", "bkg_kmax", *keys)
        changes.extend({"parameter": key, "requested": requested.get(key),
                        "effective": effective.get(key),
                        "unit": "Å" if key in ("rmin", "rmax") else "Å⁻¹"}
                       for key in keys)
    return [item for item in changes
            if _finite(item["requested"]) and _finite(item["effective"])
            and not math.isclose(item["requested"], item["effective"], rel_tol=1e-10, abs_tol=1e-10)]


def duplicate_inputs(groups):
    """Map each group to other groups with identical inputs and the same axis kind."""
    fingerprints = {}
    matching = {}
    for group in groups:
        if _duplicate_eligible(group):
            # A chi group's energy slot contains k, so it cannot match an energy spectrum.
            key = (group["data_type"] == "chi", signature(group))
            fingerprints[group["id"]] = key
            matching.setdefault(key, []).append(group)
    return {group["id"]: [{"id": other["id"], "label": other["label"]}
                          for other in matching.get(fingerprints.get(group["id"]), [])
                          if other["id"] != group["id"]]
            for group in groups}


def _row(group, duplicates):
    summary = group_summary(group)
    failed = bool(group.get("processing_error"))
    result = group.get("result") if not failed else None
    effective = (result or {}).get("effective") or {}
    notes = []
    if group["data_type"] == "detector":
        notes.append("Detector counts have no edge normalization or EXAFS processing.")
    elif _difference(group):
        notes.append("This is a derived difference signal. Absorption quality checks do not apply.")
    elif group["data_type"] == "chi":
        notes.append("Input is chi(k); edge normalization and background removal do not apply.")
    elif group["data_type"] == "xanes":
        notes.append("XANES processing is selected; EXAFS is not calculated.")
    elif result and not effective.get("exafs"):
        notes.append("EXAFS is unavailable in the saved result; inspect the processing notices and post-edge range.")
    if _theory(group):
        notes.append("This is calculated data; duplicate measurement checks do not apply.")
    if group.get("is_normalized") or group["data_type"] in ("norm", "xmudat"):
        notes.append("Input is already normalized; normalization was not refitted.")
    if failed:
        notes.append("Processing failed. Any previous effective results are omitted from this review.")
    elif not result:
        notes.append("No processed result is saved for this group.")
    warnings = []
    for record in ((group.get("source") or {}), (result or {})):
        messages = record.get("warnings")
        if isinstance(messages, list):
            warnings.extend(message for message in messages if isinstance(message, str) and message not in warnings)
    fields = ("id", "label", "data_type", "marked", "frozen", "axis", "range", "points")
    return {
        **{key: summary[key] for key in fields},
        "e0": effective.get("e0"), "edge_step": effective.get("edge_step"),
        "exafs": bool(effective.get("exafs")), "available_kmax": effective.get("available_kmax"),
        "status": "failed" if failed else "processed" if result else "unprocessed",
        "processing_error": group.get("processing_error"),
        "warnings": warnings,
        "adjustments": _adjustments(group, effective) if result else [],
        "duplicate_inputs": duplicates,
        "notes": notes,
    }


def prepare_quality_report(project, request: QualityReport):
    """Return the selected rows in project order; never mutate the snapshot."""
    duplicates = duplicate_inputs(project["groups"])
    groups = [_row(group, duplicates[group["id"]])
              for group in project["groups"] if request.scope == "all" or group["marked"]]
    notes = list(_NOTES)
    if not groups:
        notes.append("Mark at least one group or choose All groups." if request.scope == "marked"
                     else "Import spectra to review their saved processing.")
    return {
        "project_id": project["id"], "project_name": project["name"],
        "version": project["version"], "scope": request.scope,
        "counts": {
            "groups": len(groups),
            **{status: sum(row["status"] == status for row in groups)
               for status in ("processed", "failed", "unprocessed")},
            **{f"with_{field}": sum(bool(row[field]) for row in groups)
               for field in ("warnings", "adjustments", "duplicate_inputs")},
        },
        "groups": groups, "notes": notes,
    }
