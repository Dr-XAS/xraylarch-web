"""A revision-bound spectrum comparison with an explicit reference."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .agent_compare import _absorption, _chi_amplitude, _overlap, _shift_details, _summary, _xanes_details
from .athena_quality import _difference, _theory, duplicate_inputs
from .athena_science import ScientificError


class ComparisonReport(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    version: int = Field(ge=0)
    reference_id: str = Field(min_length=1, max_length=100)
    scope: Literal["all", "marked"] = "all"


_NOTES = [
    "Each target is compared with the chosen reference using its current saved energy axis. "
    "No energy shift, parameter change or new processing is applied.",
    "The fitted energy shift is the additional shift an alignment would apply to the target. "
    "It can reflect chemical differences or spectral shape as well as calibration. It is not a measurement of time-dependent drift.",
    "The XANES difference is the largest absolute normalized difference on the reference grid "
    "within E0 -20 to +50 eV and the shared data range. The stated upper bound is exclusive; "
    "the difference is evaluated before any proposed alignment.",
    "Chi amplitude ratios use the reference's k-weight and effective kmin, ending at the shared "
    "available support. They can extend beyond either saved Fourier kmax. A ratio below one "
    "means lower weighted RMS amplitude in that bin, not a diagnosis of noise, disorder or data quality.",
    "Identical inputs are checked against the whole project. Check acquisition records before "
    "treating matching groups as independent repeat scans.",
]


def _usable(group):
    return bool(group.get("result")) and not group.get("processing_error")


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _identity(group):
    identity = (group.get("source") or {}).get("edge_identity")
    if not isinstance(identity, dict):
        return None
    element, edge = identity.get("element"), identity.get("edge")
    return (element, edge) if isinstance(element, str) and isinstance(edge, str) else None


def _row(group, reference, base, duplicates, preferences):
    summary = _summary(group)
    notes = []
    row = {key: summary[key] for key in ("id", "label", "data_type", "axis", "range", "points", "processing_error")}
    row.update(common_range=_overlap(base["range"], summary["range"]) if base["axis"] == summary["axis"] else None,
               e0_difference=None, edge_step_ratio=None, energy_shift=None, xanes=None, chi_amplitude=None,
               duplicate_inputs=duplicates, unavailable={}, notes=notes)
    missing = row["unavailable"]
    identities = _identity(reference), _identity(group)
    if all(identities) and identities[0] != identities[1]:
        notes.append(f"Recorded edge identities differ: reference {' '.join(identities[0])}; "
                     f"target {' '.join(identities[1])}. Check that this comparison answers your scientific question.")
    if _theory(reference) or _theory(group):
        notes.append("This comparison includes calculated data; it is not a comparison of two measured acquisitions.")
    if _difference(reference) or _difference(group):
        notes.append("A difference signal is present; absorption-edge and chi-amplitude comparisons are unavailable.")
    if not _usable(reference) or not _usable(group):
        reason = "Both groups need successful saved processing results. Previous results from failed processing are omitted."
        missing.update({key: reason for key in ("e0_difference", "edge_step_ratio", "energy_shift", "xanes", "chi_amplitude")})
        return row
    if _absorption(reference) and _absorption(group):
        if _finite(base["e0"]) and _finite(summary["e0"]):
            row["e0_difference"] = round(summary["e0"] - base["e0"], 3)
        else:
            missing["e0_difference"] = "Both absorption spectra need a saved effective E0."
        if _finite(base["edge_step"]) and base["edge_step"] > 0 and _finite(summary["edge_step"]) and summary["edge_step"] > 0:
            row["edge_step_ratio"] = round(summary["edge_step"] / base["edge_step"], 4)
        else:
            missing["edge_step_ratio"] = "Both absorption spectra need positive saved edge steps."
        if any(s.get("is_normalized") or s["data_type"] in ("norm", "xmudat") for s in (reference, group)):
            notes.append("An input is already normalized. Its edge step is a normalization convention, not the original absorption scale.")
        shift = _shift_details(group, reference, preferences)
        if "unavailable" in shift:
            missing["energy_shift"] = shift["unavailable"]
        else:
            row["energy_shift"] = {key: shift[key] for key in ("value", "stderr", "range")}
            notes.append(f"The derivative alignment fit used smoothing window {shift['smoothing_window']} "
                         f"and polynomial order {shift['smoothing_order']}. Its nominal interval was "
                         f"{shift['nominal_range'][0]:g} to {shift['nominal_range'][1]:g} eV; "
                         "the reported range names the first and last evaluated reference-grid points.")
        row["xanes"] = _xanes_details(group, reference)
        if row["xanes"] is None:
            missing["xanes"] = "At least three finite reference points and matching normalized curves are needed inside the shared edge interval."
        elif row["xanes"]["range"] != [base["e0"] - 20, base["e0"] + 50]:
            notes.append("The XANES interval is clipped to the shared measured energy range. Compare its stated interval before comparing differences across targets.")
    else:
        reason = "Absorption-edge metrics require two energy spectra; detector counts, chi(k) and difference signals are not eligible."
        missing.update({key: reason for key in ("e0_difference", "edge_step_ratio", "energy_shift", "xanes")})
    if (base["exafs"] and summary["exafs"] and not _difference(reference) and not _difference(group)
            and reference["data_type"] != "detector" and group["data_type"] != "detector"):
        row["chi_amplitude"] = _chi_amplitude(group, reference)
        if row["chi_amplitude"] is None:
            missing["chi_amplitude"] = "No shared measured k interval has at least three finite points and nonzero reference RMS amplitude."
    else:
        missing["chi_amplitude"] = "Both groups need applicable saved EXAFS results to compare chi(k)."
    return row


def comparison_report(project, reference_id, scope, preferences):
    if scope not in ("all", "marked"):
        raise ScientificError("Choose all or marked groups for comparison.")
    reference = next((group for group in project["groups"] if group["id"] == reference_id), None)
    if reference is None:
        raise ScientificError("The comparison reference is not in this project.")
    targets = [group for group in project["groups"]
               if group["id"] != reference_id and (scope == "all" or group["marked"])]
    if not targets:
        raise ScientificError("Choose at least one target other than the reference; mark a group or choose All groups.")
    if len(targets) > 100:
        raise ScientificError("Compare at most 100 target groups per report; mark a smaller batch.")
    base = _summary(reference)
    duplicates = duplicate_inputs(project["groups"])
    fields = ("id", "label", "data_type", "axis", "range", "points", "e0", "edge_step", "exafs", "available_kmax", "processing_error")
    return {
        "project_id": project["id"], "project_name": project["name"], "version": project["version"],
        "reference_id": reference_id, "scope": scope, "reference": {key: base[key] for key in fields},
        "groups": [_row(group, reference, base, duplicates[group["id"]], preferences) for group in targets],
        "notes": [*_NOTES, f"Requested derivative-fit smoothing preferences: window {preferences['sg_window']}, "
                  f"polynomial order {preferences['sg_order']}. Each successful fit records the values it used."],
    }
