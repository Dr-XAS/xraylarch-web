"""Local Athena projects: atomic multi-group editing, import and exchange.

Original detector arrays are kept with each group. All transformations create
derived groups; processing parameters are recorded separately from source data.
"""
from __future__ import annotations

import ast
import copy
import csv
import gzip
import io
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .athena_science import (AthenaParameters, process_spectrum, calibrate_shift,
                             align_shift, merge_spectra, combine_spectra, linear_combination,
                             principal_components)
from .config import Settings
from .errors import WebInputError
from .parsing import parse_upload
from .routes import _read_bounded_upload
from .storage import WorkspaceStorage


def uid() -> str:
    return secrets.token_urlsafe(18)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fail(message: str, code: str = "athena_invalid"):
    raise WebInputError(code, message, recovery="Review the selected groups and values, then retry.")


class _PerlUndefined(ast.NodeTransformer):
    """Translate only the literal Perl undef token, never quoted text or code."""
    def visit_Name(self, node):
        return ast.Constant(value=None) if node.id == "undef" else node


def _project_literal(value):
    if len(value) > 8_000_000:
        fail("A native project literal exceeds 8 MB; split or rebin the project.")
    # Perl's => separates hash key/value literals. Translate it only outside
    # quoted strings; e.g. an annotation containing 'a=>b' stays unchanged.
    pieces, quote, escaped, i = [], None, False, 0
    while i < len(value):
        char = value[i]
        if quote:
            pieces.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
            pieces.append(char)
        elif value[i:i + 2] == "=>":
            pieces.append(",")
            i += 1
        else:
            pieces.append(char)
        i += 1
    value = "".join(pieces)
    tree = ast.parse(value.strip().removesuffix(";"), mode="eval")
    return ast.literal_eval(_PerlUndefined().visit(tree))


# Exchange limits apply before any project mutation. The configured upload
# limit also bounds expanded gzip input and the serialized exchange output.
_EXCHANGE_MAX_VALUES = 2_000_000
_EXCHANGE_MAX_METADATA_BYTES = 1_000_000
_NATIVE_ARRAYS = ("i0", "signal", "stddev")
_NATIVE_ALIASES = {"fft_kwindow": "fft_win", "bft_rwindow": "bft_win", "bkg_kwindow": "bkg_win"}


def _project_json(text):
    def unique(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                fail(f"Duplicate project JSON key: {key}.")
            output[key] = value
        return output

    def nonfinite(value):
        fail(f"Project JSON contains non-finite {value}; supply finite numbers.")

    def finite_float(value):
        parsed = float(value)
        if not np.isfinite(parsed):
            nonfinite(value)
        return parsed

    return json.loads(text, object_pairs_hook=unique, parse_constant=nonfinite, parse_float=finite_float)


def _metadata(value, name="Native metadata"):
    """Keep inert JSON-compatible metadata, with explicit size/depth bounds."""
    def check(item, depth=0):
        if depth > 32:
            fail(f"{name} exceeds 32 nesting levels.")
        if isinstance(item, dict):
            if not all(isinstance(k, str) for k in item):
                fail(f"{name} keys must be strings.")
            for val in item.values():
                check(val, depth + 1)
        elif isinstance(item, (list, tuple)):
            for val in item:
                check(val, depth + 1)
        elif item is not None and not isinstance(item, (str, bool, int, float)):
            fail(f"{name} contains an unsupported literal type.")
    check(value)
    try:
        serialized = json.dumps(value, allow_nan=False, ensure_ascii=True)
    except (ValueError, OverflowError):
        fail(f"{name} contains non-finite numbers.")
    if len(serialized.encode()) > _EXCHANGE_MAX_METADATA_BYTES:
        fail(f"{name} exceeds the 1 MB metadata limit.")
    return json.loads(serialized)


def _native_flag(value, default=False):
    if value in (None, ""):
        return default
    if value in (True, 1, "1", "true", "True"):
        return True
    if value in (False, 0, "0", "false", "False"):
        return False
    fail(f"Invalid native boolean value: {value!r}.")


def _exchange_array(value, name, settings):
    if not isinstance(value, (list, tuple, np.ndarray)) or len(value) > min(settings.max_points, 250_000):
        fail(f"{name} must be an array with at most {min(settings.max_points, 250_000)} values.")
    array = np.asarray(value, dtype=float)
    if array.ndim != 1 or not np.isfinite(array).all():
        fail(f"{name} must be a one-dimensional array of finite numbers.")
    return array.tolist()


def _exchange_source(source, npoints, settings):
    """Validate retained pointwise data without changing older source schemas."""
    if not isinstance(source, dict):
        fail("Source metadata must be an object.")
    source = copy.deepcopy(source)
    for key in ("raw_arrays", "column_arrays"):
        if key not in source:
            continue
        arrays = source[key]
        if not isinstance(arrays, dict) or len(arrays) > (3 if key == "raw_arrays" else settings.max_columns):
            fail(f"Source {key} has too many arrays or is not an object.")
        for name, values in arrays.items():
            if key == "raw_arrays" and name not in _NATIVE_ARRAYS:
                fail(f"Unsupported raw detector array {name}.")
            arrays[name] = _exchange_array(values, name, settings)
            if len(arrays[name]) != npoints:
                fail(f"Source {name} must match the group's {npoints} data points.")
    return source


def _exchange_budget(groups, settings):
    total = 0
    for g in groups:
        for key in ("energy", "mu"):
            if len(g[key]) > min(settings.max_points, 250_000):
                fail(f"Group exceeds the {min(settings.max_points, 250_000)} point limit.")
            total += len(g[key])
        source = g.get("source", {})
        for key in ("raw_arrays", "column_arrays"):
            total += sum(len(a) for a in source.get(key, {}).values())
        total += sum(len(a) for a in source.get("native", {}).get("unaligned_arrays", {}).values() if a is not None)
        if total > _EXCHANGE_MAX_VALUES:
            fail("Project exceeds 2,000,000 retained data values; reduce columns, groups, or rebin scans.")


def _journal(value):
    if isinstance(value, (list, tuple)):
        return "\n".join(str(v) for v in value)
    return str(value or "")


def _exchange_recipe(parameters, result=None):
    """Preserve known historical AUTOBK defaults in pre-extension web files."""
    parameters = copy.deepcopy(parameters)
    effective = (result or {}).get("effective", {})
    for key in ("bkg_dk", "bkg_window", "nclamp"):
        if key not in parameters and effective.get(key) is not None:
            parameters[key] = effective[key]
    return parameters


def _native_json_document(document):
    headers = {k: v for k, v in document.items() if k.startswith("_____head")}
    if not any(isinstance(v, str) and "Athena project file -- " in v for v in headers.values()):
        fail("This JSON is neither an Athena Web project nor a native Athena JSON project.")
    order = document.get("_____order")
    if not isinstance(order, list) or not 1 <= len(order) <= 100 or not all(isinstance(k, str) for k in order):
        fail("Native Athena JSON needs an ordered list of 1–100 group IDs.")
    if len(set(order)) != len(order):
        fail("Native Athena JSON contains duplicate group IDs in _____order.")
    records = []
    for key in order:
        dat = document.get(key)
        if not isinstance(dat, dict) or not all(k in dat for k in ("x", "y")):
            fail(f"Native group {key} is missing x/y data.")
        if not isinstance(dat.get("args", {}), dict):
            fail(f"Native group {key} args must be an object.")
        records.append(dict(dat, old_group=key))
    # Preserve project properties, fit state, headers, and unlisted records as
    # metadata. Only groups explicitly in _____order become editable spectra.
    metadata = _metadata({k: v for k, v in document.items() if k not in order})
    return records, _journal(document.get("_____journal", "")), metadata


def _native_perl_document(text):
    if not text.startswith("# Athena project file --"):
        fail("This file is not an Athena project.")
    records, record, sidecar, metadata, journal = [], {}, {}, {}, ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("# Athena-Web "):
            sidecar = _project_json(line[len("# Athena-Web "):])
        elif line.startswith("[record]"):
            records.append(record)
            record = {}
            if len(records) > 100:
                fail("A project can contain at most 100 groups.")
        elif line.startswith(("$", "@", "%")) and "=" in line:
            key, value = line.split("=", 1)
            key = key.strip().lstrip("@$%")
            # Unknown assignments are retained as inert literal data too;
            # calls, attributes and comprehensions still fail literal_eval.
            value = _project_literal(value)
            if line.startswith("%"):
                if not isinstance(value, (list, tuple)) or len(value) % 2:
                    fail("Native hash properties must contain literal key/value pairs.")
                value = dict(zip(value[::2], value[1::2]))
            if key == "journal":
                journal = _journal(value)
            elif key == "old_group" or record:
                if key in record:
                    fail(f"Duplicate native record field: {key}.")
                record[key] = value
            else:
                metadata[key] = value
    if record:
        fail("Native project has an unterminated data record.")
    if not records:
        fail("No supported data records were found in the project.")
    for record in records:
        flat = record.get("args", [])
        if not isinstance(flat, (list, tuple)) or len(flat) % 2:
            fail("Native args must contain key/value pairs.")
        args = {}
        for key, value in zip(flat[::2], flat[1::2]):
            if not isinstance(key, str) or key in args:
                fail("Native args keys must be unique strings.")
            args[key] = value
        record["args"] = args
    return records, journal, sidecar, _metadata(metadata)


def _native_parameters(args):
    parameters = {}
    for key, native in _PARAMETER_MAP.items():
        raw = args.get(native, args.get(_NATIVE_ALIASES.get(native)))
        if raw in ("", None):
            continue
        if key == "fnorm":
            parameters[key] = _native_flag(raw)
            continue
        if key in ("clamp_lo", "clamp_hi"):
            raw = {"None": 0, "Slight": 0.1, "Weak": 0.1, "Strong": 1}.get(str(raw), raw)
        elif raw == "None":
            continue
        parameters[key] = str(raw) if key in ("window", "rwindow", "bkg_window") else float(raw)
    if not _native_flag(args.get("bkg_fixstep")):
        parameters["step"] = None
    parameters["flatten"] = _native_flag(args.get("bkg_flatten"), True)
    return parameters


def _native_source(record, filename, kind, settings):
    args = _metadata(record.get("args", {}))
    source = {"filename": filename, "raw_arrays": {}, "warnings": [],
              "native": {"format": kind, "id": record["old_group"], "args": args}}
    unsupported = {k: v for k, v in record.items() if k not in ("old_group", "args", "x", "y", *_NATIVE_ARRAYS)}
    if unsupported:
        source["native"]["fields"] = _metadata(unsupported)
        source["warnings"].append("Native record state retained as metadata, not executed: " + ", ".join(sorted(unsupported)))
    npoints = len(record["x"])
    for key in _NATIVE_ARRAYS:
        if key not in record:
            continue
        values = record[key]
        has_null = isinstance(values, (list, tuple)) and any(v is None for v in values)
        if has_null:
            values = _metadata(values, f"Native {key}")
        elif values is not None:
            values = _exchange_array(values, key, settings)
        if values is not None and not has_null and len(values) == npoints:
            source["raw_arrays"][key] = values
        else:
            source["native"].setdefault("unaligned_arrays", {})[key] = values
            source["warnings"].append(f"Native {key} has {0 if values is None else len(values)} values for {npoints} points; retained without treating it as pointwise data.")
    supported = set(_PARAMETER_MAP.values()) | set(_NATIVE_ALIASES.values()) | {
        "label", "datatype", "is_xmu", "is_xanes", "is_nor", "is_chi", "is_diff", "marked", "frozen",
        "plot_scale", "plot_yoffset", "bkg_flatten", "bkg_fixstep", "bkg_stan", "referencegroup", "reference", "annotation"}
    unapplied = sorted(set(args) - supported)
    if unapplied:
        source["native"]["unapplied_args"] = unapplied
        source["warnings"].append("Native settings retained but not applied (including any fits or properties): " + ", ".join(unapplied))
    return source


def _perl_literal(value):
    if value is None:
        return "undef"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_perl_literal(v) for v in value) + "]"
    # Dict-valued properties stay in the sidecar, not Perl hash expressions.
    return repr(value)


def _validate_analysis_records(records):
    if not isinstance(records, list) or len(records) > 50:
        fail("A project exchange supports at most 50 saved analyses.")
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("group_ids"), list):
            fail("Saved analyses must include a group_ids list.")
        ids = record["group_ids"]
        if not ids or not all(isinstance(key, str) for key in ids) or len(ids) > 100:
            fail("Saved analyses require 1–100 group IDs.")
        if not isinstance(record.get("result"), dict) or not isinstance(record.get("options", {}), dict):
            fail("Saved analysis results and options must be objects.")
    return records


def _import_analyses(records, source_version, idmap, pristine, new_version, warnings):
    imported = []
    for record in _validate_analysis_records(records):
        ids = record["group_ids"]
        def remap(value):
            if isinstance(value, dict):
                return {key: remap(val) for key, val in value.items()}
            if isinstance(value, list):
                return [remap(val) for val in value]
            return idmap.get(value, value) if isinstance(value, str) else value
        out = remap(copy.deepcopy(record))
        out["id"] = uid()
        out["imported_from"] = {"id": record.get("id"), "project_version": record.get("project_version")}
        current = source_version is not None and record.get("project_version") == source_version and set(ids) <= pristine
        out["project_version"] = new_version if current else new_version - 1
        missing = [key for key in ids if key not in idmap]
        if missing:
            out["group_ids"] = [idmap[key] for key in ids if key in idmap]
            out["unmapped_group_ids"] = missing
            warnings.append("Saved analysis references missing groups; retained as stale with unmapped_group_ids.")
        imported.append(out)
    return imported


def _select_project_groups(groups, group_ids, key="id"):
    """Athena's empty selection means all; selection never changes file order."""
    if group_ids is None:
        return groups
    if not isinstance(group_ids, list) or len(group_ids) > 100 or not all(isinstance(gid, str) and gid for gid in group_ids):
        fail("Select a list of at most 100 nonempty project group IDs.")
    if len(set(group_ids)) != len(group_ids):
        fail("Selected project group IDs must not contain duplicates.")
    if not set(group_ids) <= {g[key] for g in groups}:
        fail("Selected group IDs are not present in this project upload or export.")
    return [g for g in groups if not group_ids or g[key] in group_ids]


class RestoreUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    upload_id: str = Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")
    group_ids: list[str] | None = Field(default=None, max_length=100)


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    upload_id: str
    energy_column: str
    numerator: list[str] = Field(min_length=1, max_length=64)
    denominator: str | None = None
    mode: Literal["mu", "transmission", "fluorescence"] = "mu"
    units: Literal["eV", "keV"] = "eV"
    data_type: Literal["mu", "xanes", "norm", "chi"] = "mu"
    reference_numerator: str | None = None
    reference_denominator: str | None = None
    sort: bool = False


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    version: int
    action: str
    group_ids: list[str] = Field(default_factory=list, max_length=100)
    options: dict[str, Any] = Field(default_factory=dict)


class SetE0Options(BaseModel):
    """One explicit E0 operation; it does not change the import defaults."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    method: Literal["derivative", "atomic", "fraction", "zero_crossing", "white_line", "manual"] = "derivative"
    fraction: float = Field(default=0.5, gt=0, le=1, strict=True)
    element: str | None = Field(default=None, max_length=32)
    edge: str | None = Field(default=None, max_length=3)
    value: float | None = Field(default=None, gt=0, le=1e7, strict=True)


_PARAMETER_MAP = {
    "fnorm": "bkg_fnorm",
    "e0": "bkg_e0", "step": "bkg_step", "pre1": "bkg_pre1", "pre2": "bkg_pre2",
    "norm1": "bkg_nor1", "norm2": "bkg_nor2", "nnorm": "bkg_nnorm",
    "rbkg": "bkg_rbkg", "bkg_kmin": "bkg_spl1", "bkg_kmax": "bkg_spl2",
    "bkg_kweight": "bkg_kw", "clamp_lo": "bkg_clamp1", "clamp_hi": "bkg_clamp2",
    "bkg_dk": "bkg_dk", "bkg_window": "bkg_kwindow", "nclamp": "bkg_nclamp",
    "kmin": "fft_kmin", "kmax": "fft_kmax", "kweight": "fft_kw", "dk": "fft_dk",
    "window": "fft_kwindow", "rmin": "bft_rmin", "rmax": "bft_rmax",
    "dr": "bft_dr", "rwindow": "bft_rwindow", "energy_shift": "bkg_eshift",
}

_PARAMETER_SECTIONS = {
    "normalization": ("e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm", "flatten"),
    "background": ("rbkg", "bkg_kmin", "bkg_kmax", "bkg_kweight", "bkg_dk", "bkg_window", "nclamp", "clamp_lo", "clamp_hi", "fnorm"),
    "forward": ("kmin", "kmax", "kweight", "dk", "window"),
    "reverse": ("rmin", "rmax", "dr", "rwindow"),
    "grid": ("nfft", "kstep"),
}


class AthenaStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.storage = WorkspaceStorage(settings.data_root / "athena")

    def create(self) -> dict:
        ident = uid()
        self.storage.workspace_dir(ident, create=True)
        project = {"id": ident, "format": "athena-web", "schema_version": 1,
                   "name": "Untitled project", "version": 0, "groups": [],
                   "journal": "", "history": [], "undo": [], "redo": [], "analyses": [],
                   "created": now(), "updated": now()}
        self.storage.write_json(ident, "project.json", project)
        return project

    def load(self, ident: str) -> dict:
        try:
            project = self.storage.read_json(ident, "project.json")
            try:
                project["analyses"] = self.storage.read_json(ident, "analyses.json")["analyses"]
            except FileNotFoundError:
                project.setdefault("analyses", [])
            # Fill new controls from the settings that actually produced an
            # older cached result, rather than relabeling it with new defaults.
            defaults = AthenaParameters().model_dump()
            for group in project["groups"]:
                group.setdefault("background_standard_id", None)
                effective = (group.get("result") or {}).get("effective", {})
                for key, default in defaults.items():
                    if key not in group["parameters"]:
                        group["parameters"][key] = effective.get(key) if effective.get(key) is not None else default
            return project
        except FileNotFoundError:
            fail("Project was not found.", "workspace_not_found")

    def list(self) -> list[dict]:
        output = []
        for path in self.storage.root.iterdir():
            if path.is_dir() and (path / "project.json").is_file():
                p = self.load(path.name)
                output.append({k: p[k] for k in ("id", "name", "updated", "version")} | {"count": len(p["groups"])})
        return sorted(output, key=lambda p: p["updated"], reverse=True)

    def check(self, p: dict, version: int):
        if p["version"] != version:
            fail("This project changed in another tab. Reload it before editing.", "stale_revision")

    def save(self, p: dict, old: dict, message: str) -> dict:
        if len(p["groups"]) > 100:
            fail("A project can contain at most 100 groups.")
        snapshot = f"undo-{old['version']}.json"
        self.storage.write_json(p["id"], snapshot, old)
        p["undo"] = (old["undo"] + [snapshot])[-30:]
        p["redo"] = []
        p["version"] = old["version"] + 1
        p["updated"] = now()
        p["history"] = (old["history"] + [{"time": now(), "message": message}])[-200:]
        self.storage.write_json(p["id"], "project.json", p)
        return p

    def group(self, p: dict, ident: str) -> dict:
        matches = [g for g in p["groups"] if g["id"] == ident]
        if not matches:
            fail("Selected group no longer exists.")
        return matches[0]

    def reference_family(self, p, ident):
        """Read either direction of links, including older one-way projects."""
        members = {ident}
        while True:
            previous = members.copy()
            for group in p["groups"]:
                reference = group.get("reference_id")
                if reference and (group["id"] in members or reference in members):
                    members.update((group["id"], reference))
            if members == previous:
                return [g for g in p["groups"] if g["id"] in members]

    @staticmethod
    def background_dependents(p, group_ids):
        members = set(group_ids)
        while True:
            following = {g["id"] for g in p["groups"] if g.get("background_standard_id") in members}
            if following <= members:
                return members
            members.update(following)

    def _validate_background_graph(self, p):
        visited, visiting = set(), set()
        def visit(group):
            ident = group["id"]
            if ident in visiting:
                fail("Background standards cannot form a cycle or refer to the same group.")
            if ident in visited:
                return
            visiting.add(ident)
            standard_id = group.get("background_standard_id")
            if standard_id:
                visit(self.group(p, standard_id))
            visiting.remove(ident)
            visited.add(ident)
        for group in p["groups"]:
            visit(group)

    def _process_groups(self, p, group_ids, *, tolerate_errors=False):
        """Refresh changed spectra and all users of their background standards."""
        self._validate_background_graph(p)
        needed = self.background_dependents(p, group_ids)
        processed = set()
        def visit(group):
            if group["id"] in processed:
                return
            standard_id = group.get("background_standard_id")
            if standard_id in needed:
                visit(self.group(p, standard_id))
            try:
                self.process(group, p)
            except (ValueError, WebInputError) as exc:
                if not tolerate_errors:
                    raise
                group.update(result=None, processing_error=str(exc))
            processed.add(group["id"])
        for group in p["groups"]:
            if group["id"] in needed:
                visit(group)

    def _frozen_background_dependents(self, p, group_ids):
        dependents = self.background_dependents(p, group_ids)
        return [g for g in p["groups"] if g["id"] in dependents and g["frozen"]]

    def parameter_updates(self, p, updates, *, skip_frozen=False):
        """Stage all recipes before recalculation; energy-shift ties are atomic."""
        expanded, skipped = {}, set()
        for ident, patch in updates.items():
            group = self.group(p, ident)
            family = self.reference_family(p, ident) if "energy_shift" in patch else [group]
            changing = [g for g in family if g["id"] == ident or
                        g["parameters"]["energy_shift"] != patch["energy_shift"]]
            if any(g["frozen"] for g in changing) or self._frozen_background_dependents(p, [g["id"] for g in changing]):
                if skip_frozen:
                    skipped.add(ident)
                    continue
                fail("Unfreeze the group, its linked reference, and any groups using it as a background standard before changing their parameters.")
            expanded.setdefault(ident, {}).update(patch)
            if "energy_shift" in patch:
                for tied in family:
                    previous = expanded.setdefault(tied["id"], {}).get("energy_shift", patch["energy_shift"])
                    if previous != patch["energy_shift"]:
                        fail("Linked groups cannot receive different energy shifts in one operation.")
                    if not tied["frozen"]:
                        expanded[tied["id"]]["energy_shift"] = patch["energy_shift"]
        recipes, standard_links = {}, {}
        for ident, patch in expanded.items():
            group = self.group(p, ident)
            patch = dict(patch)
            if "background_standard_id" in patch:
                standard_id = patch.pop("background_standard_id")
                if standard_id is not None:
                    if not isinstance(standard_id, str):
                        fail("Choose a background-standard group or None.")
                    self.group(p, standard_id)
                    if group["data_type"] not in ("mu", "norm"):
                        fail("Background standards apply to energy spectra with EXAFS processing.")
                standard_links[ident] = standard_id
            previous = group["parameters"]
            recipe = AthenaParameters.model_validate(previous | patch)
            # E0 uses the shifted energy axis. Apply the delta once, after
            # merging every explicit edit, so calibration targets take priority.
            if "energy_shift" in patch and "e0" not in patch and recipe.e0 is not None:
                recipe.e0 += recipe.energy_shift - previous["energy_shift"]
            recipes[ident] = recipe.model_dump()
        for ident, recipe in recipes.items():
            group = self.group(p, ident)
            group["parameters"] = recipe
        for ident, standard_id in standard_links.items():
            self.group(p, ident)["background_standard_id"] = standard_id
        self._process_groups(p, recipes)
        return sorted(skipped)

    def set_e0(self, p, groups, options):
        from .athena_e0 import compute_e0

        choice = SetE0Options.model_validate(options)
        allowed = {"method"} | {
            "fraction": {"fraction"}, "atomic": {"element", "edge"},
            "manual": {"value"},
        }.get(choice.method, set())
        if set(options) - allowed:
            fail("Only supply options used by the selected E₀ method.")
        if choice.method == "manual" and choice.value is None:
            fail("Enter the manual E₀ value in eV on the shifted energy axis.")
        if (choice.element is None) != (choice.edge is None):
            fail("Supply both the absorbing element and edge, or leave both automatic.")
        updates, results, reasons = {}, [], {}
        for group in groups:
            ident = group["id"]
            if self._frozen_background_dependents(p, [ident]):
                reasons[ident] = "The group or a group using it as a background standard is frozen."
                continue
            if group["data_type"] == "chi" or group["source"].get("operation") == "difference":
                reasons[ident] = "E₀ requires an absorption spectrum on an energy axis."
                continue
            try:
                result = compute_e0(group["energy"], group["mu"], group["parameters"],
                                    data_type=group["data_type"], **choice.model_dump())
            except ValueError as exc:
                fail(f"{group['label']}: {exc}")
            updates[ident] = {"e0": result["e0"]}
            results.append({"group_id": ident, **result})
        # Every E0 is chosen before the atomic recalculation. Consumers of a
        # selected background standard therefore see the newly processed chi.
        self.parameter_updates(p, updates)
        for result in results:
            group = self.group(p, result["group_id"])
            group["source"]["e0_selection"] = {
                **result, "energy_shift": group["parameters"]["energy_shift"], "time": now(),
            }
        return results, reasons

    def tie_reference(self, p, sample, reference):
        if sample["id"] == reference["id"]:
            fail("A group cannot reference itself.")
        if sample.get("reference_id") == reference["id"]:
            return
        if sample["data_type"] == "chi" or reference["data_type"] == "chi":
            fail("Reference channels must use an energy axis.")
        # A newly tied pair uses the sample's shift. Preserve directional
        # sample/reference metadata while enforcing the relationship both ways.
        if reference["frozen"] and reference["parameters"]["energy_shift"] != sample["parameters"]["energy_shift"]:
            fail("Unfreeze the reference before changing its energy shift.")
        pair = {sample["id"], reference["id"]}
        for group in p["groups"]:
            if group["id"] in pair or group.get("reference_id") in pair:
                group["reference_id"] = None
        if reference["parameters"]["energy_shift"] != sample["parameters"]["energy_shift"]:
            self.parameter_updates(p, {reference["id"]: {"energy_shift": sample["parameters"]["energy_shift"]}})
        sample["reference_id"] = reference["id"]

    @staticmethod
    def raw_arrays(energy, mu):
        x, y = np.asarray(energy, dtype=float), np.asarray(mu, dtype=float)
        if x.ndim != 1 or y.ndim != 1 or len(x) != len(y) or not 8 <= len(x) <= 250_000:
            fail("A group needs 8–250,000 paired data points.")
        if not np.isfinite(x).all() or not np.isfinite(y).all():
            fail("Data contain non-finite values.")
        if np.any(np.diff(x) <= 0):
            fail("The horizontal axis must be strictly increasing. Use sorting at import if appropriate.")
        return x, y

    def make_group(self, label, energy, mu, *, parameters=None, data_type="mu", source=None,
                   background_standard_id=None, project=None):
        x, y = self.raw_arrays(energy, mu)
        if data_type not in ("mu", "xanes", "norm", "chi"):
            fail("Unsupported data type.")
        params = AthenaParameters.model_validate(parameters or {})
        g = {"id": uid(), "label": str(label)[:200], "energy": x.tolist(), "mu": y.tolist(),
             "data_type": data_type, "parameters": params.model_dump(), "marked": True,
             "frozen": False, "multiplier": 1.0, "offset": 0.0, "notes": "", "reference_id": None,
             "background_standard_id": background_standard_id,
             "source": source or {}, "result": None, "processing_error": None}
        if not isinstance(g["source"], dict):
            fail("Source metadata must be an object.")
        # Imported data remains inspectable even if its saved recipe needs repair.
        try:
            self.process(g, project)
        except (ValueError, WebInputError) as exc:
            g["processing_error"] = str(exc)
        return g

    def process(self, g, project=None):
        standard_id, standard = g.get("background_standard_id"), None
        if standard_id:
            if project is None:
                fail("Resolve the background standard in its project before processing this group.")
            if standard_id == g["id"]:
                fail("A group cannot be its own background standard.")
            source = self.group(project, standard_id)
            arrays = (source.get("result") or {}).get("arrays", {})
            if source.get("processing_error") or not arrays.get("k") or not arrays.get("chi"):
                fail(f"Background standard {source['label']} has no usable chi(k); repair its processing first.")
            if g["source"].get("operation") == "difference":
                fail("A difference spectrum cannot use a background-removal standard.")
            standard = {"k": arrays["k"], "chi": arrays["chi"]}
        if g["source"].get("operation") == "difference" and g["data_type"] != "chi":
            from .athena_science import ARRAY_NAMES
            x = np.asarray(g["energy"]) + g["parameters"]["energy_shift"]
            y = np.asarray(g["mu"])
            arrays = {key: [] for key in ARRAY_NAMES}
            arrays.update(energy=x.tolist(), mu=y.tolist(), norm=y.tolist(), flat=y.tolist(), dmude=np.gradient(y, x).tolist())
            g["result"] = {"arrays": arrays, "effective": {"e0": None, "edge_step": None, "exafs": False},
                           "warnings": ["Difference spectrum: the signed difference is shown without edge normalization or EXAFS processing."]}
            g["processing_error"] = None
            return
        g["result"] = process_spectrum(g["energy"], g["mu"], AthenaParameters.model_validate(g["parameters"]),
                                       data_type=g["data_type"], background_standard=standard)
        g["result"]["effective"]["background_standard_id"] = standard_id
        g["processing_error"] = None

    def inspect(self, ident, data, filename):
        self.load(ident)
        parsed = parse_upload(data, filename, max_bytes=self.settings.max_upload_bytes,
                              max_points=self.settings.max_points, max_columns=self.settings.max_columns)
        upload = uid()
        self.storage.write_arrays(ident, f"upload-{upload}.npz", parsed.arrays)
        self.storage.write_json(ident, f"upload-{upload}.json", parsed.inspection().model_dump())
        return parsed.inspection().model_dump() | {"upload_id": upload}

    def import_data(self, ident, request: ImportRequest):
        with self.storage.lock(ident):
            old = self.load(ident)
            self.check(old, request.version)
            p = copy.deepcopy(old)
            self.storage._validate_id(request.upload_id)
            arrays = self.storage.read_arrays(ident, f"upload-{request.upload_id}.npz")
            metadata = self.storage.read_json(ident, f"upload-{request.upload_id}.json")
            def column(key):
                if key not in arrays:
                    fail("Choose columns from the inspected file.")
                return np.asarray(arrays[key], dtype=float)
            x = column(request.energy_column) * (1000 if request.units == "keV" and request.data_type != "chi" else 1)
            if len(set(request.numerator)) != len(request.numerator):
                fail("Select each numerator channel only once.")
            numerator = np.sum([column(c) for c in request.numerator], axis=0)
            y = numerator.copy()
            if request.mode != "mu":
                denominator = column(request.denominator)
                if np.any(denominator == 0):
                    fail("The denominator contains zero detector counts.")
                y = numerator / denominator
                if request.mode == "transmission":
                    if np.any(y <= 0):
                        fail("Transmission requires a positive incident/transmitted ratio at every point.")
                    y = np.log(y)
            if request.sort:
                order = np.argsort(x, kind="stable")
                x, y = x[order], y[order]
            source = {"filename": metadata["display_name"], "mapping": request.model_dump(exclude={"version"}),
                      "warnings": metadata.get("warnings", []), "columns": metadata["columns"],
                      "column_arrays": {key: np.asarray(values)[order].tolist() if request.sort else np.asarray(values).tolist()
                                        for key, values in arrays.items()},
                      "column_order": "group", "raw_arrays": {}}
            # Preserve original units/column IDs. When sorting was requested,
            # all retained columns follow the group row order; row_order maps
            # those rows back to the uploaded table.
            if request.sort:
                source["row_order"] = order.tolist()
            def aligned(values):
                return (values[order] if request.sort else values).tolist()
            if request.mode == "transmission":
                source["raw_arrays"].update(i0=aligned(numerator), signal=aligned(denominator))
            elif request.mode == "fluorescence":
                source["raw_arrays"].update(i0=aligned(denominator), signal=aligned(numerator))
            else:
                source["raw_arrays"]["signal"] = aligned(numerator)
                i0_columns = [c["column_id"] for c in metadata["columns"] if c["name"].lower() == "i0"]
                if len(i0_columns) == 1:
                    source["raw_arrays"]["i0"] = aligned(column(i0_columns[0]))
            stddev_columns = [c["column_id"] for c in metadata["columns"] if c["name"].lower() in ("stddev", "mu_stddev")]
            if len(stddev_columns) == 1:
                source["raw_arrays"]["stddev"] = aligned(column(stddev_columns[0]))
            source = _exchange_source(source, len(x), self.settings)
            if len(p["groups"]) + 1 + bool(request.reference_numerator or request.reference_denominator) > 100:
                fail("A project can contain at most 100 groups.")
            _exchange_budget([*p["groups"], {"energy": x, "mu": y, "source": source}], self.settings)
            g = self.make_group(metadata["display_name"], x, y, data_type=request.data_type, source=source)
            if request.reference_numerator or request.reference_denominator:
                a, b = column(request.reference_numerator), column(request.reference_denominator)
                if np.any(a <= 0) or np.any(b <= 0):
                    fail("Reference transmission channels must contain positive counts.")
                ry = np.log(a / b)
                if request.sort:
                    ry = ry[order]
                reference_source = copy.deepcopy(source)
                reference_source["raw_arrays"] = {"i0": aligned(a), "signal": aligned(b)}
                reference_source["mapping"].update(numerator=[request.reference_numerator],
                    denominator=request.reference_denominator, reference_numerator=None, reference_denominator=None,
                    mode="transmission")
                reference = self.make_group(g["label"] + " · reference", x, ry, source=reference_source)
                reference["marked"] = False
                g["reference_id"] = reference["id"]
                p["groups"].append(reference)
            p["groups"].append(g)
            _exchange_budget(p["groups"], self.settings)
            return self.save(p, old, f"Imported {g['label']} ({len(x)} points)")

    def command(self, ident, request: Command):
        with self.storage.lock(ident):
            old = self.load(ident)
            self.check(old, request.version)
            p = copy.deepcopy(old)
            action, options = request.action, request.options
            groups = [self.group(p, gid) for gid in dict.fromkeys(request.group_ids)]
            skipped, operation_details = [], {}
            if action in ("undo", "redo"):
                stack = old[action]
                if not stack:
                    fail(f"There is nothing to {action}.")
                restore = self.storage.read_json(ident, stack[-1])
                inverse = "redo" if action == "undo" else "undo"
                name = f"{inverse}-{old['version']}.json"
                self.storage.write_json(ident, name, old)
                restore[action] = stack[:-1]
                restore[inverse] = (old[inverse] + [name])[-30:]
                restore["version"] = old["version"] + 1
                restore["updated"] = now()
                self.storage.write_json(ident, "project.json", restore)
                return restore
            if action == "project":
                p["name"] = str(options.get("name", p["name"]))[:200] or "Untitled project"
                p["journal"] = str(options.get("journal", p["journal"]))[:50_000]
            elif action == "example":
                for filename, label in (("cu_10k.xmu", "Cu foil · 10 K"), ("cu_50k.xmu", "Cu foil · 50 K"), ("cu_rt01.xmu", "Cu foil · 300 K")):
                    path = Path(__file__).resolve().parents[2] / "examples" / "xafsdata" / filename
                    raw = np.loadtxt(path)
                    g = self.make_group(label, raw[:, 0], raw[:, 1], source={"filename": filename,
                        "citation": "XrayLarch example data; Newville, Ravel and Zhang (Cu 10/50 K: NSLS X11-A, 1992; room temperature: APS 13ID, 2001)."})
                    p["groups"].append(g)
                if p["name"] == "Untitled project":
                    p["name"] = "Copper foil · temperature series"
            elif action == "reorder":
                ids = options.get("ids", [])
                if len(ids) != len(p["groups"]) or set(ids) != {g["id"] for g in p["groups"]}:
                    fail("Reordering must include every group exactly once.")
                p["groups"] = [self.group(p, gid) for gid in ids]
            else:
                if not groups:
                    fail("Select at least one group.")
                if action not in ("metadata", "selection", "background_standard", "duplicate", "copy_series", "delete", "parameters", "set_e0", "copy_parameters", "reset_parameters", "align", "merge", "sum", "difference", "tie_reference", "untie_reference") and any(g["frozen"] for g in groups):
                    fail("Unfreeze the selected groups before changing their data or processing.")
                if action == "selection":
                    field, mode = options.get("field", "marked"), options.get("mode", "invert")
                    if field not in ("marked", "frozen") or mode not in ("all", "none", "invert"):
                        fail("Choose marked or frozen groups and all, none, or invert.")
                    for g in groups:
                        g[field] = not g[field] if mode == "invert" else mode == "all"
                elif action == "metadata":
                    for g in groups:
                        for key in ("label", "notes", "marked", "frozen", "multiplier", "offset", "reference_id"):
                            if key in options:
                                value = options[key]
                                if key in ("multiplier", "offset"):
                                    value = float(value)
                                    if not np.isfinite(value):
                                        fail("Plot values must be finite.")
                                elif key in ("marked", "frozen"):
                                    if not isinstance(value, bool):
                                        fail("Mark and freeze values must be boolean.")
                                elif key == "reference_id":
                                    if value is not None:
                                        self.tie_reference(p, g, self.group(p, value))
                                        continue
                                else:
                                    value = str(value)[:(200 if key == "label" else 20_000)]
                                g[key] = value
                elif action == "background_standard":
                    standard_id = options.get("standard_id")
                    skipped = self.parameter_updates(p, {g["id"]: {"background_standard_id": standard_id}
                        for g in groups}, skip_frozen=True)
                elif action == "parameters":
                    skipped = self.parameter_updates(p, {g["id"]: options for g in groups}, skip_frozen=len(groups) > 1)
                elif action == "set_e0":
                    results, reasons = self.set_e0(p, groups, options)
                    skipped = list(reasons)
                    operation_details = {"e0_results": results, "skipped_reasons": reasons}
                elif action in ("copy_parameters", "reset_parameters"):
                    defaults = AthenaParameters().model_dump()
                    defaults["background_standard_id"] = None
                    parameter, section = options.get("parameter"), options.get("section", "all")
                    if parameter is not None:
                        if parameter not in defaults:
                            fail("Choose a valid processing parameter.")
                        keys = (parameter,)
                    elif section == "all":
                        keys = tuple(key for key in defaults if key != "energy_shift")
                    elif section in _PARAMETER_SECTIONS:
                        keys = _PARAMETER_SECTIONS[section]
                        if section == "background":
                            keys = (*keys, "background_standard_id")
                    else:
                        fail("Choose normalization, background, forward, reverse, grid, or all parameters.")
                    if action == "copy_parameters":
                        source = self.group(p, options.get("source_id"))
                        values = options.get("values", {})
                        if not isinstance(values, dict) or set(values) - set(defaults):
                            fail("Supply known processing parameters as an object.")
                        values = source["parameters"] | {"background_standard_id": source.get("background_standard_id")} | values
                    else:
                        values = defaults
                    patch = {key: values[key] for key in keys}
                    # A source's standard can itself be among the destinations.
                    # Skip it rather than creating a self-link in an all-group copy.
                    self_standard = [g["id"] for g in groups if g["id"] == patch.get("background_standard_id")]
                    skipped = self_standard + self.parameter_updates(p,
                        {g["id"]: patch for g in groups if g["id"] not in self_standard}, skip_frozen=True)
                elif action == "tie_reference":
                    if len(groups) != 2:
                        fail("Choose exactly two groups: sample first, reference second.")
                    self.tie_reference(p, groups[0], groups[1])
                elif action == "untie_reference":
                    for group in groups:
                        for tied in self.reference_family(p, group["id"]):
                            tied["reference_id"] = None
                elif action == "duplicate":
                    for g in groups:
                        clone = copy.deepcopy(g)
                        clone.update(id=uid(), label=g["label"] + " · copy", frozen=False, reference_id=None)
                        p["groups"].append(clone)
                elif action == "copy_series":
                    key = options.get("parameter")
                    if key not in ("e0", "rbkg", "kmin", "kmax", "dk", "rmin", "rmax", "energy_shift"):
                        fail("Choose a numeric processing parameter for the copy series.")
                    count = int(options.get("count", 3))
                    start, stop = float(options["start"]), float(options["stop"])
                    if not 2 <= count <= 20 or not np.isfinite([start, stop]).all() or start == stop:
                        fail("Use 2–20 copies with distinct finite start and stop values.")
                    for g in groups:
                        for value in np.linspace(start, stop, count):
                            clone = copy.deepcopy(g)
                            clone.update(id=uid(), label=f"{g['label']} · {key}={value:g}", frozen=False, reference_id=None)
                            if key == "energy_shift" and clone["parameters"]["e0"] is not None:
                                clone["parameters"]["e0"] += float(value) - clone["parameters"]["energy_shift"]
                            clone["parameters"][key] = float(value)
                            self.process(clone, p)
                            clone["source"] = {"operation": "copy_series", "parent": g["id"], "parameter": key, "value": float(value)}
                            p["groups"].append(clone)
                elif action == "delete":
                    remove = {g["id"] for g in groups}
                    affected = self.background_dependents(p, remove) - remove
                    p["groups"] = [g for g in p["groups"] if g["id"] not in remove]
                    for g in p["groups"]:
                        if g["reference_id"] in remove:
                            g["reference_id"] = None
                        if g.get("background_standard_id") in remove:
                            g["source"].setdefault("warnings", []).append("Background standard was removed; its link was cleared.")
                            g["background_standard_id"] = None
                        if g["id"] in affected:
                            g.update(result=None, processing_error="A background standard was removed. Apply parameters to recalculate this group and its dependents.")
                elif action in ("calibrate", "align"):
                    reference = self.group(p, options.get("reference_id")) if action == "align" else None
                    fixed = {g["id"] for g in self.reference_family(p, reference["id"])} if reference else set()
                    updated_families = set()
                    for g in groups:
                        family = self.reference_family(p, g["id"])
                        family_ids = {tied["id"] for tied in family}
                        if g["id"] in fixed or g["id"] in updated_families:
                            continue
                        if action == "align" and (any(tied["frozen"] for tied in family) or self._frozen_background_dependents(p, family_ids)):
                            skipped.append(g["id"])
                            continue
                        if g["data_type"] == "chi":
                            fail("Energy calibration and alignment need energy data.")
                        if action == "calibrate":
                            shift = calibrate_shift(g["energy"], g["mu"], float(options["target"]), options.get("observed"))
                            e0 = float(options["target"])
                        else:
                            own = self.group(p, g["reference_id"]) if options.get("use_reference") and g["reference_id"] else g
                            ref = self.group(p, reference["reference_id"]) if options.get("use_reference") and reference["reference_id"] else reference
                            ref_x = np.asarray(ref["energy"]) + ref["parameters"]["energy_shift"]
                            shift = align_shift(own["energy"], own["mu"], ref_x, ref["mu"], options.get("xmin"), options.get("xmax"))
                            e0 = reference["result"]["effective"]["e0"]
                        self.parameter_updates(p, {g["id"]: {"energy_shift": float(shift), "e0": e0}})
                        updated_families.update(family_ids)
                elif action in ("merge", "sum", "difference"):
                    if len(groups) < 2:
                        fail("Select at least two groups.")
                    array = options.get("array") if action != "difference" else None
                    if array not in (None, "mu", "norm", "chi"):
                        fail("Choose raw mu, normalized mu, or chi for the combination.")
                    if array is None and len({g["data_type"] for g in groups}) != 1:
                        fail("Combine groups of the same data type.")
                    if array == "mu" and any(g["data_type"] == "chi" for g in groups):
                        fail("Raw mu combinations require energy data; choose chi for EXAFS groups.")
                    if array in ("norm", "chi"):
                        spectra = []
                        for group in groups:
                            arrays = (group.get("result") or {}).get("arrays", {})
                            coordinate = "k" if array == "chi" else "energy"
                            if not arrays.get(array) or not arrays.get(coordinate):
                                fail(f"{group['label']} has no processed {array} data; process it before combining.")
                            spectra.append((np.asarray(arrays[coordinate]), np.asarray(arrays[array])))
                    else:
                        spectra = [(np.asarray(g["energy"]) + (0 if g["data_type"] == "chi" else g["parameters"]["energy_shift"]), np.asarray(g["mu"])) for g in groups]
                    source = {"operation": action, "parents": [g["id"] for g in groups],
                              "array": array or ("chi" if groups[0]["data_type"] == "chi" else "mu")}
                    if action == "difference":
                        if len(groups) != 2:
                            fail("Difference requires exactly two groups, in list order.")
                        x, _, _ = merge_spectra(spectra)
                        y = np.interp(x, *spectra[0]) - np.interp(x, *spectra[1])
                    else:
                        combined = combine_spectra(spectra, options.get("weights"), mode=action,
                                                   uncertainties=options.get("uncertainties"))
                        x, y = combined["x"], combined["y"]
                        source.update({key: combined[key] for key in ("weights", "coefficients", "details")})
                        if combined["stddev"] is not None:
                            source["stddev"] = combined["stddev"]
                        if combined["uncertainty"] is not None:
                            source["uncertainty"] = combined["uncertainty"]
                    params = dict(groups[0]["parameters"], energy_shift=0)
                    # A difference spectrum has no absorption edge to normalize.
                    dtype = "norm" if action == "difference" and groups[0]["data_type"] != "chi" else groups[0]["data_type"]
                    if array in ("norm", "chi"):
                        dtype = array
                        if array == "norm":
                            params["step"] = None
                    if dtype != "mu":
                        params["fnorm"] = False
                    g = self.make_group(options.get("label", f"{action.title()} · {len(groups)} groups"), x, y,
                                        parameters=params, data_type=dtype, source=source,
                                        background_standard_id=groups[0].get("background_standard_id") if dtype != "chi" and action != "difference" else None,
                                        project=p)
                    p["groups"].append(g)
                else:
                    from .athena_operations import transform_spectrum
                    allowed_options = {
                        "smooth": ("window", "order"), "deglitch": ("xmin", "xmax", "indices", "points"),
                        "truncate": ("xmin", "xmax"),
                        "rebin": ("e0", "pre1", "pre2", "pre_step", "xanes_step", "exafs1", "exafs2", "exafs_kstep", "method"),
                        "convolve": ("form", "width"),
                        "deconvolve": ("form", "esigma", "width", "eshift", "smooth", "sgwindow", "sgorder"),
                        "self_absorption": ("formula", "element", "edge", "line", "angle_in", "angle_out", "e0", "pre1", "pre2", "norm1", "norm2", "nnorm"),
                        "dispersive": ("offset", "linear", "quadratic"),
                        "multi_electron": ("method", "e0", "shift", "amplitude", "width", "edge_step"),
                    }
                    if action not in allowed_options:
                        fail("Unknown processing operation.")
                    operation_options = {k: v for k, v in options.items() if k in allowed_options[action]}
                    for g in groups:
                        x = np.asarray(g["energy"]) + (0 if action == "dispersive" else g["parameters"]["energy_shift"])
                        if g["data_type"] == "chi" and action not in ("smooth", "deglitch", "truncate"):
                            fail("This operation requires energy-valued data.")
                        y = g["mu"]
                        if action == "deconvolve":
                            if not g["result"] or not g["result"]["arrays"]["norm"]:
                                fail("Normalize the selected spectrum before deconvolution.")
                            y = g["result"]["arrays"]["norm"]
                            if "xmin" in options or "xmax" in options:
                                lo, hi = float(options.get("xmin", x[0])), float(options.get("xmax", x[-1]))
                                if not np.isfinite([lo, hi]).all() or not x[0] <= lo < hi <= x[-1]:
                                    fail("Choose a deconvolution interval inside the measured energy range.")
                                mask = (x >= lo) & (x <= hi)
                                x, y = x[mask], np.asarray(y)[mask]
                        transformed = transform_spectrum(action, x, y, operation_options)
                        if action == "self_absorption":
                            transformed["mu"] = transformed["details"]["normalized_mu"]
                        params = dict(g["parameters"], energy_shift=0)
                        dtype = "norm" if action in ("deconvolve", "self_absorption") else g["data_type"]
                        if action == "dispersive":
                            params = AthenaParameters().model_dump()
                        if dtype != "mu":
                            params["fnorm"] = False
                        derived = self.make_group(g["label"] + " · " + action, transformed["energy"], transformed["mu"],
                            parameters=params, data_type=dtype, source={"operation": action, "parent": g["id"], "options": operation_options, "details": transformed["details"]},
                            background_standard_id=g.get("background_standard_id") if dtype in ("mu", "norm") else None, project=p)
                        if action == "deconvolve":
                            derived["source"]["energy_interval"] = [float(x[0]), float(x[-1])]
                        p["groups"].append(derived)
            message = f"{action.replace('_', ' ').capitalize()} · {len(groups)} selected groups" if groups else action.capitalize()
            if skipped:
                message += (f" · skipped {len(skipped)} groups" if action == "set_e0" else
                            f" · skipped {len(skipped)} frozen groups or reference pairs")
            p["last_operation"] = {"action": action, "skipped_group_ids": skipped, **operation_details}
            return self.save(p, old, message)

    def analyze(self, ident, request: Command):
        p = self.load(ident)
        self.check(p, request.version)
        groups = [self.group(p, gid) for gid in request.group_ids]
        o = request.options
        if request.action == "log_ratio":
            from larch import Group
            from larch.xafs import xftr
            from .athena_operations import log_ratio
            if len(groups) != 2 or not all(g["result"] and g["result"]["arrays"]["r"] for g in groups):
                fail("Choose two processed EXAFS groups: target first, reference second.")
            keys = ("e0", "kmin", "kmax", "dk", "window", "kweight", "rmin", "rmax", "dr", "rwindow", "nfft", "kstep")
            if any(groups[0]["result"]["effective"].get(k) != groups[1]["result"]["effective"].get(k) for k in keys):
                fail("Log-ratio analysis requires the same E₀, FT and shell-filter windows for both groups. Set explicit common limits first.")
            filtered = []
            for g in groups:
                a, params = g["result"]["arrays"], g["parameters"]
                out = Group()
                chir = np.asarray(a["chir_re"]) + 1j * np.asarray(a["chir_im"])
                xftr(np.asarray(a["r"]), chir, group=out, rmin=params["rmin"], rmax=params["rmax"], dr=params["dr"],
                     window=params["rwindow"], nfft=params["nfft"], kstep=params["kstep"], qmax_out=min(g["result"]["effective"]["available_kmax"] for g in groups))
                filtered.append(out)
            opts = {key: value for key, value in o.items() if key in ("kmin", "kmax", "amplitude_min", "phase_offset", "fit_cumulants", "max_cumulant")}
            result = log_ratio(filtered[0].q, filtered[1].chiq, filtered[0].chiq, opts)
            result["labels"] = [g["label"] for g in groups]
            return self._persist_analysis(ident, {"kind": request.action, "project_version": p["version"], "group_ids": request.group_ids, "options": opts, "result": result})
        def spectrum(g):
            if not g["result"]:
                fail("Process each selected group before analysis.")
            a = g["result"]["arrays"]
            field = o.get("array", "norm")
            xkey = "k" if field in ("chi", "weighted_chi") else "energy"
            if field not in ("norm", "flat", "mu", "dmude", "chi", "weighted_chi") or not a.get(field):
                fail("The selected plot array is not available for this group.")
            return np.asarray(a[xkey]), np.asarray(a[field])
        spectra = [spectrum(g) for g in groups]
        if not spectra:
            fail("Choose groups for analysis.")
        xmin = float(o.get("xmin", max(s[0].min() for s in spectra)))
        xmax = float(o.get("xmax", min(s[0].max() for s in spectra)))
        if request.action == "lcf":
            if len(spectra) < 3:
                fail("Select a target followed by at least two standards.")
            result = linear_combination(*spectra[0], spectra[1:], xmin, xmax,
                         sum_to_one=bool(o.get("sum_to_one", True)), nonnegative=bool(o.get("nonnegative", True)))
            result["labels"] = [g["label"] for g in groups[1:]]
        elif request.action == "pca":
            result = principal_components(spectra, xmin, xmax)
            result["labels"] = [g["label"] for g in groups]
        elif request.action == "peaks":
            from .athena_operations import fit_peaks
            peak_options = {key: o[key] for key in ("peaks", "background", "max_nfev") if key in o}
            result = fit_peaks(*spectra[0], dict(peak_options, xmin=xmin, xmax=xmax))
        else:
            fail("Unknown analysis.")
        return self._persist_analysis(ident, {"kind": request.action, "project_version": p["version"], "group_ids": request.group_ids,
                "options": o, "result": result})

    def _persist_analysis(self, ident, result):
        """Save reproducible reports without changing the scientific source revision."""
        with self.storage.lock(ident):
            current = self.load(ident)
            self.check(current, result["project_version"])
            record = dict(result, id=uid(), created=now())
            self.storage.write_json(ident, "analyses.json", {"analyses": (current["analyses"] + [record])[-50:]})
            return record

    def project_for_export(self, p, group_ids=None, marked_only=False):
        groups = _select_project_groups(p["groups"], group_ids)
        if marked_only:
            groups = [g for g in groups if g["marked"]]
            if not groups:
                fail("No marked groups match the project export selection.")
        _exchange_budget(groups, self.settings)
        if len(groups) == len(p["groups"]):
            return p
        out = copy.deepcopy({**p, "groups": groups})
        selected = {g["id"] for g in groups}
        all_ids = {g["id"] for g in p["groups"]}
        warnings = out.setdefault("import_warnings", [])
        for g in out["groups"]:
            for key, label in (("reference_id", "reference"), ("background_standard_id", "background standard")):
                if g.get(key) and g[key] not in selected:
                    message = f"{g['label']}: {label} {g[key]} was omitted from the project export."
                    warnings.append(message)
                    g["source"].setdefault("warnings", []).append(message)
                    g[key] = None
        def referenced_strings(value):
            if isinstance(value, dict):
                return set().union(set(value) & all_ids, *(referenced_strings(v) for v in value.values()))
            if isinstance(value, list):
                return set().union(*(referenced_strings(v) for v in value))
            return {value} & all_ids if isinstance(value, str) else set()
        retained = []
        for record in _validate_analysis_records(out.get("analyses", [])):
            dependencies = set(record["group_ids"]) | referenced_strings(record.get("options", {})) | referenced_strings(record["result"])
            if record.get("unmapped_group_ids") or not dependencies <= selected:
                continue
            # A subset export changes the project context (including links).
            # Keep self-contained reports, conservatively marked stale.
            if record.get("project_version") == p["version"]:
                record["project_version"] = p["version"] - 1
            retained.append(record)
        out["analyses"] = retained
        out["native_projects"] = []
        warnings.append("Subset project export: reports requiring omitted groups and native project-wide state were omitted; retained reports are stale.")
        return out

    def export_project(self, ident, format="json", group_ids=None, marked_only=False):
        if format not in ("json", "prj"):
            fail("Choose json or prj for the project export.")
        p = self.project_for_export(self.load(ident), group_ids, marked_only)
        content = self.export_prj(p) if format == "prj" else json.dumps(p, allow_nan=False).encode()
        if len(content) > self.settings.max_upload_bytes:
            fail("Project export exceeds the configured byte limit; select fewer groups.")
        return content

    def export_prj(self, p, group_ids=None, marked_only=False):
        p = self.project_for_export(p, group_ids, marked_only)
        _exchange_budget(p["groups"], self.settings)
        lines = ["# Athena project file -- Demeter version 0.9.26", "# Exported by Athena Web / XrayLarch"]
        for g in p["groups"]:
            params = _exchange_recipe(g["parameters"], g.get("result"))
            effective = (g["result"] or {}).get("effective", {})
            source = _exchange_source(g["source"], len(g["energy"]), self.settings)
            native = source.get("native", {})
            args = copy.deepcopy(native.get("args", {}))
            # Native scalar/list metadata survives independent readers. Complex
            # properties and fits remain inert in the web sidecar.
            args = {key: value for key, value in args.items() if not isinstance(value, dict)}
            args.update({"label": g["label"], "is_xmu": int(g["data_type"] == "mu"),
                    "is_xanes": int(g["data_type"] == "xanes"), "is_nor": int(g["data_type"] == "norm"),
                    "is_chi": int(g["data_type"] == "chi"), "marked": int(g["marked"]), "frozen": int(g["frozen"]),
                    "plot_scale": g["multiplier"], "plot_yoffset": g["offset"], "bkg_flatten": int(params["flatten"]),
                    "is_diff": int(g["source"].get("operation") == "difference"),
                    "annotation": g["notes"], "referencegroup": g["reference_id"] or "",
                    "bkg_stan": g.get("background_standard_id") or ""})
            for key, target in _PARAMETER_MAP.items():
                value = params.get(key)
                if value is None:
                    value = effective.get("edge_step" if key == "step" else key)
                if value is not None:
                    args[target] = value
                    if target in _NATIVE_ALIASES:
                        args[_NATIVE_ALIASES[target]] = value
            args["bkg_fixstep"] = int(params["step"] is not None)
            # Larch's legacy reader skips an entire args line containing bare
            # undef; explicit null metadata remains exact in the sidecar.
            flat = [v for pair in args.items() if pair[1] is not None for v in pair]
            lines.extend([f"$old_group = {g['id']!r};", "@args = (" + ", ".join(_perl_literal(v) for v in flat) + ");",
                          "@x = (" + ",".join(repr(str(v)) for v in g["energy"]) + ");",
                          "@y = (" + ",".join(repr(str(v)) for v in g["mu"]) + ");"])
            detector_arrays = dict(native.get("unaligned_arrays", {}), **source.get("raw_arrays", {}))
            # Older derived merge groups store their population deviation here.
            if "stddev" not in detector_arrays and isinstance(source.get("stddev"), list):
                detector_arrays["stddev"] = source["stddev"]
            for key in _NATIVE_ARRAYS:
                if key in detector_arrays and detector_arrays[key] is not None:
                    if any(v is None for v in detector_arrays[key]):
                        continue  # Placeholder retained exactly in the sidecar.
                    values = _exchange_array(detector_arrays[key], key, self.settings)
                    lines.append(f"@{key} = (" + ",".join(repr(str(v)) for v in values) + ("," if len(values) == 1 else "") + ");")
            lines.append("[record]")
        lines += ["@journal = (" + ", ".join(repr(v) for v in p["journal"].splitlines()) + ");", "1;"]
        # Sidecar comment preserves automatic settings, references and provenance
        # on a web round trip; native Athena ignores this comment.
        sidecar = {"name": p["name"], "version": p["version"], "analyses": p.get("analyses", []),
                   "native_projects": p.get("native_projects", []), "import_warnings": p.get("import_warnings", []),
                   "groups": [dict({k: g[k] for k in ("id", "parameters", "notes", "source", "reference_id")},
                                   background_standard_id=g.get("background_standard_id")) for g in p["groups"]]}
        for meta, g in zip(sidecar["groups"], p["groups"]):
            meta["parameters"] = _exchange_recipe(g["parameters"], g.get("result"))
        lines.insert(2, "# Athena-Web " + json.dumps(sidecar, ensure_ascii=True, allow_nan=False))
        payload = "\n".join(lines).encode()
        if len(payload) > self.settings.max_upload_bytes:
            fail("Expanded project export exceeds the configured byte limit; reduce retained data or split the project.")
        return gzip.compress(payload)

    def _parse_project(self, data, filename):
        """Validate a project without science, destination edits, or new group IDs."""
        if len(data) > self.settings.max_upload_bytes:
            fail("Project upload exceeds the configured byte limit.")
        if data[:2] == b"\x1f\x8b":
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as handle:
                data = handle.read(self.settings.max_upload_bytes + 1)
        if len(data) > self.settings.max_upload_bytes:
            fail("Expanded project is too large.")
        text = data.decode("utf-8-sig")
        journal, name = "", Path(filename).stem
        sidecar, native_project = {}, None
        import_warnings = []
        web = False
        if text.lstrip().startswith("{"):
            document = _project_json(text)
            web = document.get("format") == "athena-web"
            if web:
                if document.get("schema_version") != 1:
                    fail("Unsupported Athena Web project schema version.")
                records = document.get("groups", [])
                sidecar = document
                journal, name = _journal(document.get("journal", "")), str(document.get("name", name))
            else:
                records, journal, metadata = _native_json_document(document)
                native_project = {"filename": filename, "format": "athena-json", "metadata": metadata}
        else:
            records, journal, sidecar, metadata = _native_perl_document(text)
            if not isinstance(sidecar, dict):
                fail("Athena Web sidecar must be an object.")
            if not sidecar:
                native_project = {"filename": filename, "format": "athena-perl", "metadata": metadata}
            name = sidecar.get("name", name)
        if not isinstance(records, list) or len(records) > 100:
            fail("A project can contain at most 100 groups.")
        if not isinstance(sidecar, dict):
            fail("Athena Web sidecar must be an object.")
        meta_records = sidecar.get("groups", [])
        if not isinstance(meta_records, list) or len(meta_records) > 100:
            fail("Invalid sidecar group list.")
        metadata = {}
        for meta in meta_records:
            if not isinstance(meta, dict) or not isinstance(meta.get("id"), str) or meta["id"] in metadata:
                fail("Sidecar group IDs must be unique strings.")
            metadata[meta["id"]] = meta
        idmap, provisional = {}, []
        for record in records:
            if not isinstance(record, dict):
                fail("Each project group must be an object.")
            old_id = record.get("id" if web else "old_group")
            if not isinstance(old_id, str) or not old_id or old_id in idmap:
                fail("Native and web group IDs must be nonempty unique strings.")
            idmap[old_id] = None
            x = _exchange_array(record.get("energy" if web else "x"), "energy", self.settings)
            y = _exchange_array(record.get("mu" if web else "y"), "mu", self.settings)
            # Validate every group's data/budget before doing expensive science.
            self.raw_arrays(x, y)
            meta = record if web else metadata.get(old_id, {})
            if web:
                source = _exchange_source(record.get("source", {}), len(x), self.settings)
                params = _exchange_recipe(record["parameters"], record.get("result"))
                label, dtype = record["label"], record["data_type"]
                notes, reference = str(record.get("notes", "")), record.get("reference_id")
                standard = record.get("background_standard_id")
                marked, frozen = _native_flag(record.get("marked")), _native_flag(record.get("frozen"))
                multiplier, offset = record.get("multiplier", 1), record.get("offset", 0)
            else:
                args = record.get("args", {})
                if not isinstance(args, dict):
                    fail("Native args must be an object.")
                source = (_exchange_source(meta["source"], len(x), self.settings) if "source" in meta else
                          _native_source(record, filename, native_project["format"] if native_project else "athena-perl", self.settings))
                params = meta.get("parameters")
                if params is None:
                    params = _native_parameters(args)
                dtype = next((kind for kind, key in (("chi", "is_chi"), ("norm", "is_nor"), ("xanes", "is_xanes"))
                              if _native_flag(args.get(key))), {"chi": "chi", "xanes": "xanes"}.get(args.get("datatype"), "mu"))
                if _native_flag(args.get("is_diff")):
                    source["operation"] = "difference"
                label = args.get("label", old_id)
                notes = str(meta.get("notes", args.get("annotation", "")))
                reference = meta.get("reference_id", args.get("referencegroup", args.get("reference")))
                standard = meta.get("background_standard_id", args.get("bkg_stan"))
                if "background_standard_id" not in meta and standard in ("None", "none"):
                    standard = None
                marked = _native_flag(args.get("marked", args.get("project_marked")), True)
                frozen = _native_flag(args.get("frozen"))
                multiplier, offset = args.get("plot_scale", 1), args.get("plot_yoffset", 0)
            if dtype not in ("mu", "norm", "xanes", "chi"):
                fail("Unsupported data type in project.")
            if reference not in (None, "", 0, "0"):
                if not isinstance(reference, (str, int)):
                    fail("Project reference IDs must be strings or integer native IDs.")
                reference = str(reference)
                if reference == old_id:
                    fail("An imported group cannot reference itself.")
            else:
                reference = None
            if standard not in (None, "", 0, "0"):
                if not isinstance(standard, (str, int)):
                    fail("Background standard IDs must be strings or integer native IDs.")
                standard = str(standard)
            else:
                standard = None
            if not isinstance(params, dict):
                fail("Project parameters must be an object.")
            recipe_error = None
            try:
                AthenaParameters.model_validate(params)
            except ValidationError as exc:
                if (web or "parameters" in meta) and not source.get("native"):
                    raise
                recipe_error = "Native processing settings need repair: " + str(exc)
                import_warnings.append(f"{label}: {recipe_error}")
            messages = source.get("warnings", [])
            if not isinstance(messages, list) or not all(isinstance(message, str) for message in messages):
                fail("Source warnings must be a list of strings.")
            import_warnings.extend(f"{label}: {message}" for message in messages)
            multiplier, offset = float(multiplier), float(offset)
            if not np.isfinite([multiplier, offset]).all():
                fail("Invalid plot values in project.")
            provisional.append({"old_id": old_id, "energy": x, "mu": y, "source": source,
                                "parameters": params, "label": label, "data_type": dtype,
                                "notes": notes, "reference_id": reference, "marked": marked,
                                "background_standard_id": standard,
                                "frozen": frozen, "multiplier": multiplier, "offset": offset,
                                "has_web_recipe": web or "parameters" in meta, "recipe_error": recipe_error})

        _exchange_budget(provisional, self.settings)
        for record in provisional:
            if record["reference_id"] and record["reference_id"] not in idmap:
                import_warnings.append(f"{record['label']}: reference {record['reference_id']} was not present in the project.")
            if record["background_standard_id"] and record["background_standard_id"] not in idmap:
                import_warnings.append(f"{record['label']}: background standard {record['background_standard_id']} was not present in the project.")
        retained_projects = sidecar.get("native_projects", [])
        if not isinstance(retained_projects, list):
            fail("native_projects must be a list.")
        retained_projects = [_metadata(state) for state in retained_projects]
        if native_project:
            retained_projects.append(native_project)
            state_keys = [key for key in native_project["metadata"] if not key.startswith(("_____head", "_____journ", "_____order", "_____emacs"))]
            if state_keys:
                import_warnings.append("Native project state retained as metadata, not executed: " + ", ".join(state_keys))
        prior_warnings = sidecar.get("import_warnings", [])
        if not isinstance(prior_warnings, list) or not all(isinstance(w, str) for w in prior_warnings):
            fail("import_warnings must be a list of strings.")
        analyses = _validate_analysis_records(sidecar.get("analyses", []))
        return {"name": str(name)[:200], "journal": journal[:50_000], "groups": provisional,
                "format": "athena-web" if web else "athena-json" if native_project and native_project["format"] == "athena-json" else "athena-perl",
                "native_projects": retained_projects, "analyses": analyses, "version": sidecar.get("version"),
                "warnings": list(dict.fromkeys(prior_warnings + import_warnings))}

    @staticmethod
    def _preview_samples(x, y):
        indices = np.linspace(0, len(x) - 1, min(len(x), 800), dtype=int)
        return np.asarray(x)[indices].tolist(), np.asarray(y)[indices].tolist()

    @staticmethod
    def _preview_raw_axis(record):
        shift = 0 if record["data_type"] == "chi" else AthenaParameters(
            energy_shift=record["parameters"].get("energy_shift", 0)).energy_shift
        return np.asarray(record["energy"]) + shift

    @staticmethod
    def _unprocessed_project_group(record, ident=None):
        """Build validated raw records before resolving project dependencies."""
        params = (AthenaParameters().model_dump() | record["parameters"] if record["recipe_error"] else
                  AthenaParameters.model_validate(record["parameters"]).model_dump())
        return {"id": ident or uid(), "label": str(record["label"])[:200],
                "energy": record["energy"], "mu": record["mu"], "parameters": params,
                "data_type": record["data_type"], "source": record["source"],
                "notes": record["notes"][:20_000], "result": None, "processing_error": record["recipe_error"],
                **{key: record[key] for key in ("marked", "frozen", "multiplier", "offset", "reference_id", "background_standard_id")}}

    def preview_project(self, ident, data, filename):
        self.load(ident)
        filename = Path(filename.replace("\\", "/")).name[:255] or "project.prj"
        parsed = self._parse_project(data, filename)
        groups = []
        for record in parsed["groups"]:
            x, y = self._preview_samples(self._preview_raw_axis(record), record["mu"])
            groups.append({"id": record["old_id"], "label": str(record["label"])[:200],
                           "data_type": record["data_type"], "points": len(record["energy"]),
                           "x": x, "y": y, "notes": record["notes"][:20_000],
                           "reference_id": record["reference_id"], "parameters": record["parameters"],
                           "background_standard_id": record["background_standard_id"]})
        upload_id = uid()
        prefix = f"project-upload-{upload_id}"
        # Cache at most ten original uploads and twice the configured upload
        # byte limit per workspace. Older previews expire, never saved groups.
        with self.storage.lock(ident):
            workspace = self.storage.workspace_dir(ident)
            self.storage.write_bytes(ident, prefix + ".bin", data)
            try:
                self.storage.write_json(ident, prefix + ".json", {"filename": filename})
            except OSError:
                self.storage.path(ident, prefix + ".bin").unlink(missing_ok=True)
                raise
            cached = sorted(workspace.glob("project-upload-*.bin"), key=lambda path: path.stat().st_mtime_ns)
            size = sum(path.stat().st_size for path in cached)
            while len(cached) > 10 or size > 2 * self.settings.max_upload_bytes:
                expired = cached.pop(0)
                size -= expired.stat().st_size
                expired.unlink()
                expired.with_suffix(".json").unlink(missing_ok=True)
        return {"upload_id": upload_id, "filename": filename, "name": parsed["name"],
                "journal": parsed["journal"], "format": parsed["format"],
                "groups": groups, "warnings": parsed["warnings"]}

    def _read_project_upload(self, ident, upload_id):
        self.storage._validate_id(upload_id)
        prefix = f"project-upload-{upload_id}"
        with self.storage.lock(ident):
            self.load(ident)
            try:
                metadata = self.storage.read_json(ident, prefix + ".json")
                with self.storage.path(ident, prefix + ".bin").open("rb") as handle:
                    data = handle.read(self.settings.max_upload_bytes + 1)
            except FileNotFoundError:
                fail("Project preview expired or belongs to another workspace; upload the file again.")
        if len(data) > self.settings.max_upload_bytes:
            fail("Project upload exceeds the configured byte limit.")
        return data, metadata["filename"]

    def restore_upload(self, ident, request: RestoreUploadRequest):
        self.check(self.load(ident), request.version)
        data, filename = self._read_project_upload(ident, request.upload_id)
        return self.restore(ident, request.version, data, filename, request.group_ids, keep_name=True)

    def preview_project_group(self, ident, upload_id, group_id, mode="mu"):
        if mode not in ("mu", "norm", "flat", "dmude", "chi"):
            fail("Choose mu, norm, flat, dmude, or chi for the project preview.")
        data, filename = self._read_project_upload(ident, upload_id)
        parsed = self._parse_project(data, filename)
        record = _select_project_groups(parsed["groups"], [group_id], key="old_id")[0]
        response = {"label": str(record["label"])[:200], "mode": mode,
                    "data_type": record["data_type"], "warnings": parsed["warnings"], "x": [], "y": []}
        if (mode == "mu" and record["data_type"] != "chi") or (mode == "chi" and record["data_type"] == "chi"):
            x, y = self._preview_raw_axis(record), record["mu"]
        else:
            if record["recipe_error"]:
                return dict(response, processing_error=record["recipe_error"])
            # Resolve standards by original IDs in the full upload. Process only
            # the requested dependency chain; unrelated groups stay unprocessed.
            by_id = {item["old_id"]: self._unprocessed_project_group(item, item["old_id"])
                     for item in parsed["groups"]}
            needed, cursor = set(), group_id
            while cursor and cursor not in needed:
                if cursor not in by_id:
                    return dict(response, processing_error=f"Background standard {cursor} was not present in the project upload.")
                needed.add(cursor)
                cursor = by_id[cursor]["background_standard_id"]
            ephemeral = {"groups": [g for key, g in by_id.items() if key in needed]}
            try:
                self._process_groups(ephemeral, list(needed), tolerate_errors=True)
            except (ValueError, WebInputError) as exc:
                return dict(response, processing_error=str(exc))
            g = by_id[group_id]
            if g["processing_error"]:
                return dict(response, processing_error=g["processing_error"])
            arrays = g["result"]["arrays"]
            x, y = arrays.get("k" if mode == "chi" else "energy", []), arrays.get(mode, [])
            response["warnings"] = list(dict.fromkeys(response["warnings"] + g["result"]["warnings"]))
            if not x or not y or len(x) != len(y):
                return dict(response, processing_error=f"This {record['data_type']} group has no {mode} curve.")
        response["x"], response["y"] = self._preview_samples(x, y)
        return response

    def restore(self, ident, version, data, filename, group_ids=None, *, keep_name=False):
        with self.storage.lock(ident):
            old = self.load(ident)
            self.check(old, version)
            parsed = self._parse_project(data, filename)
            records = _select_project_groups(parsed["groups"], group_ids, key="old_id")
            complete = len(records) == len(parsed["groups"])
            if len(old["groups"]) + len(records) > 100:
                fail("A project can contain at most 100 groups.")
            _exchange_budget([*old["groups"], *records], self.settings)
            p = copy.deepcopy(old)
            imported, idmap, pristine = [], {}, set()
            import_warnings = list(parsed["warnings"])
            for record in records:
                g = self._unprocessed_project_group(record)
                if len(record["notes"]) > 20_000:
                    g["source"].setdefault("warnings", []).append("Native annotation exceeds the notes limit; original text remains in native args.")
                idmap[record["old_id"]] = g["id"]
                imported.append(g)
            broken_links = set()
            for g in imported:
                for key, label in (("reference_id", "Reference"), ("background_standard_id", "Background standard")):
                    pointer = g[key]
                    g[key] = idmap.get(pointer)
                    if pointer and g[key] is None:
                        message = f"{label} {pointer} was not selected or present; link was not restored."
                        g["source"].setdefault("warnings", []).append(message)
                        import_warnings.append(f"{g['label']}: {message}")
                        broken_links.add(g["id"])
            p["groups"].extend(imported)
            self._process_groups(p, [g["id"] for g in imported], tolerate_errors=True)
            changed_dependencies = self.background_dependents(p, broken_links)
            for record, g in zip(records, imported, strict=True):
                if record["has_web_recipe"] and not g["processing_error"] and g["id"] not in changed_dependencies:
                    pristine.add(record["old_id"])
                if g["source"].get("native") and g["result"]:
                    g["result"]["warnings"].extend(message for message in g["source"].get("warnings", [])
                                                    if message not in g["result"]["warnings"])
            if complete:
                if parsed["native_projects"]:
                    p.setdefault("native_projects", []).extend(parsed["native_projects"])
                imported_analyses = _import_analyses(parsed["analyses"], parsed["version"],
                    idmap, pristine, old["version"] + 1, import_warnings)
            else:
                imported_analyses = []
                if parsed["analyses"] or parsed["native_projects"]:
                    import_warnings.append("Partial project import: saved analyses and native project-wide state were not imported; select all groups to restore them.")
            if len(old.get("analyses", [])) + len(imported_analyses) > 50:
                fail("Restoring these analyses would exceed the 50-analysis limit; split the exchange or remove reports first.")
            p["analyses"] = old.get("analyses", []) + imported_analyses
            if import_warnings:
                p["import_warnings"] = list(dict.fromkeys(p.get("import_warnings", []) + import_warnings))
            if not keep_name or (not old["groups"] and old["name"] == "Untitled project"):
                p["name"] = parsed["name"]
            p["journal"] = (p["journal"] + "\n" + parsed["journal"]).strip()[:50_000]
            saved = self.save(p, old, f"Imported project {filename}: {len(imported)} groups")
            if imported_analyses:
                try:
                    self.storage.write_json(ident, "analyses.json", {"analyses": p["analyses"]})
                except OSError:
                    self.storage.write_json(ident, "project.json", old)
                    raise
            return saved


def build_athena_router(settings: Settings):
    router = APIRouter(prefix="/api/athena")
    store = AthenaStore(settings)

    def guarded(call):
        try:
            return call()
        except WebInputError:
            raise
        except ValidationError as exc:
            messages = []
            for issue in exc.errors(include_url=False):
                field = ".".join(str(part) for part in issue["loc"])
                message = issue["msg"].removeprefix("Value error, ")
                messages.append(f"{field}: {message}" if field else message)
            fail("; ".join(messages))
        except (ValueError, KeyError, TypeError, IndexError, OSError, SyntaxError, RecursionError) as exc:
            fail(str(exc) or "The requested operation could not be completed.")

    @router.get("/projects")
    def list_projects():
        return store.list()

    @router.get("/edges")
    def absorption_edges(element: str = Query(min_length=1, max_length=32)):
        from .athena_e0 import edge_catalog
        return guarded(lambda: edge_catalog(element))

    @router.post("/projects")
    def create_project():
        return store.create()

    @router.get("/projects/{ident}")
    def get_project(ident: str):
        return store.load(ident)

    @router.post("/projects/{ident}/inspect")
    async def inspect(ident: str, file: UploadFile = File(...)):
        data = await _read_bounded_upload(file, settings.max_upload_bytes)
        return guarded(lambda: store.inspect(ident, data, file.filename or "data.dat"))

    @router.post("/projects/{ident}/import")
    def import_data(ident: str, request: ImportRequest):
        return guarded(lambda: store.import_data(ident, request))

    @router.post("/projects/{ident}/command")
    def command(ident: str, request: Command):
        return guarded(lambda: store.command(ident, request))

    @router.post("/projects/{ident}/analyze")
    def analyze(ident: str, request: Command):
        return guarded(lambda: store.analyze(ident, request))

    @router.post("/projects/{ident}/restore")
    async def restore(ident: str, version: int, file: UploadFile = File(...)):
        data = await _read_bounded_upload(file, settings.max_upload_bytes)
        return guarded(lambda: store.restore(ident, version, data, file.filename or "project.prj"))

    @router.post("/projects/{ident}/preview-project")
    async def preview_project(ident: str, file: UploadFile = File(...)):
        data = await _read_bounded_upload(file, settings.max_upload_bytes)
        return guarded(lambda: store.preview_project(ident, data, file.filename or "project.prj"))

    @router.get("/projects/{ident}/preview-project/{upload_id}/groups/{group_id:path}")
    def preview_project_group(ident: str, upload_id: str, group_id: str,
                              mode: Literal["mu", "norm", "flat", "dmude", "chi"] = "mu"):
        return guarded(lambda: store.preview_project_group(ident, upload_id, group_id, mode))

    @router.post("/projects/{ident}/restore-upload")
    def restore_upload(ident: str, request: RestoreUploadRequest):
        return guarded(lambda: store.restore_upload(ident, request))

    @router.get("/projects/{ident}/export")
    def export(ident: str, format: Literal["json", "prj"] = "json",
               group_ids: list[str] | None = Query(default=None), marked_only: bool = False):
        content = guarded(lambda: store.export_project(ident, format, group_ids, marked_only))
        return Response(content, media_type="application/octet-stream" if format == "prj" else "application/json",
                        headers={"Content-Disposition": f'attachment; filename="athena-project.{format}"'})

    @router.get("/projects/{ident}/groups/{group_id}/export")
    def export_group(ident: str, group_id: str, space: Literal["E", "k", "R", "q"] = "E"):
        g = store.group(store.load(ident), group_id)
        if g["result"]:
            a = dict(g["result"]["arrays"])
        elif space == "E" and g["data_type"] != "chi":
            a = {"energy": (np.asarray(g["energy"]) + g["parameters"]["energy_shift"]).tolist(), "mu": g["mu"]}
        elif space == "k" and g["data_type"] == "chi":
            a = {"k": g["energy"], "chi": g["mu"]}
        else:
            fail("Process this group before exporting transformed arrays.")
        columns = {"E": ["energy", "mu", "norm", "flat", "pre_edge", "post_edge", "bkg", "dmude", "d2mude"],
                   "k": ["k", "chi", "weighted_chi", "kwin"], "R": ["r", "chir_mag", "chir_re", "chir_im", "chir_pha", "rwin"],
                   "q": ["q", "chiq_re", "chiq_im", "chiq_mag", "chiq_pha"]}[space]
        columns = [key for key in columns if key in a and len(a[key]) > 0]
        if not columns:
            fail("This plot space is unavailable for the selected data type.")
        if (space == "E" and g["data_type"] != "chi") or (space == "k" and g["data_type"] == "chi"):
            native_x = np.asarray(g["energy"]) + (g["parameters"]["energy_shift"] if space == "E" else 0)
            output_x = a.get("energy" if space == "E" else "k", [])
            # Retain scatter and supplied uncertainty only on their native grid;
            # interpolating a standard deviation is not variance propagation.
            if len(native_x) == len(output_x) and np.allclose(native_x, output_x, rtol=0, atol=1e-10):
                for key, label in (("stddev", "population_stddev"), ("uncertainty", "measurement_uncertainty")):
                    values = g["source"].get(key)
                    if isinstance(values, list) and len(values) == len(output_x):
                        a[label] = values
                        columns.append(label)
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(columns)
        writer.writerows(zip(*(a[key] for key in columns), strict=True))
        return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="athena-{space}.csv"'})

    return router
