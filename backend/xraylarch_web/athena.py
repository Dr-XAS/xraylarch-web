"""Local Athena projects: atomic multi-group editing, import and exchange.

Original detector arrays are kept with each group. All transformations create
derived groups; processing parameters are recorded separately from source data.
"""
from __future__ import annotations

import copy
import csv
import gzip
import hashlib
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
from .athena_preprocessing import ImportPreprocessing
from .athena_rebin import ImportRebin, PostRebin, RebinPlan, prepare_rebin, rebin_unavailable
from .athena_preferences import AthenaPreferences, RebinDefaults, RebinGrid
from .athena_plugin_registry import PluginRegistry, registry_view, decode_registry, encode_registry, MAX_REGISTRY_BYTES
from .athena_plugin_config import PluginConfigurations, ConfigurationRequest
from .athena_smoothing_preferences import SmoothingPreferences, SGPreferenceRequest
from .athena_dispersive import DispersiveRequest, DispersiveDefaults, PixelNormalization
from .athena_beamline_metadata import BeamlineDefaults
from .athena_xdi_controls import XDIValidation
from .athena_report import ParameterReport
from .athena_export import DataExport
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


def _project_literal(value, *, legacy_strings=False):
    from .athena_literals import project_literal
    try:
        return project_literal(value, legacy_strings=legacy_strings)
    except (ValueError, SyntaxError, RecursionError) as exc:
        fail(str(exc))


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


def _point_edit_history(source, settings):
    history = source.get('point_edits', [])
    if not isinstance(history, list) or len(history) > 200:
        fail('Point-edit history must be a list of at most 200 edits.')
    from .athena_point_edit import parse_options
    for edit in history:
        required = {'action', 'options', 'removed_indices', 'removed_energy', 'removed_mu', 'project_version'}
        if not isinstance(edit, dict) or set(edit) != required or edit['action'] not in ('deglitch', 'truncate'):
            fail('Point-edit history contains an invalid edit.')
        if type(edit['project_version']) is not int or edit['project_version'] < 0 or not isinstance(edit['options'], dict):
            fail('Point-edit history needs a valid revision and options.')
        parse_options(edit['action'], edit['options'])
        indices = edit['removed_indices']
        if not isinstance(indices, list) or not indices or any(type(i) is not int or i < 0 for i in indices) or indices != sorted(set(indices)):
            fail('Point-edit history needs ordered, distinct removed row indices.')
        for key in ('removed_energy', 'removed_mu'):
            values = _exchange_array(edit[key], key, settings)
            if len(values) != len(indices):
                fail('Point-edit history needs paired removed measurements.')
    return history


def _exchange_source(source, npoints, settings):
    """Validate retained pointwise data without changing older source schemas."""
    if not isinstance(source, dict):
        fail("Source metadata must be an object.")
    source = copy.deepcopy(source)
    _point_edit_history(source, settings)
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
    if 'rebin_original' in source:
        original = source['rebin_original']
        allowed = {'energy', 'mu', 'raw_arrays', 'column_arrays', 'row_order', 'column_order'}
        if not isinstance(original, dict) or set(original) - allowed or not {'energy', 'mu'} <= set(original):
            fail('Rebin original data must contain energy/mu and known source arrays.')
        original['energy'] = _exchange_array(original['energy'], 'original energy', settings)
        original['mu'] = _exchange_array(original['mu'], 'original mu', settings)
        count = len(original['energy'])
        if len(original['mu']) != count or count < 10 or np.any(np.diff(original['energy']) < 0):
            fail('Rebin original data need paired, nondecreasing energy values.')
        kept = _exchange_source({key: original[key] for key in ('raw_arrays', 'column_arrays') if key in original}, count, settings)
        original.update(kept)
        if 'column_order' in original and original['column_order'] != 'group':
            fail('Rebin original columns must follow the retained original energy row order.')
        if 'row_order' in original:
            order = original['row_order']
            if not isinstance(order, list) or len(order) != count or any(type(i) is not int for i in order) or sorted(order) != list(range(count)):
                fail('Rebin original row order must be a permutation of the source rows.')
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
        original = source.get('rebin_original', {})
        total += len(original.get('energy', [])) + len(original.get('mu', []))
        for key in ('raw_arrays', 'column_arrays'):
            total += sum(len(a) for a in original.get(key, {}).values())
        total += sum(len(edit['removed_energy']) + len(edit['removed_mu']) for edit in _point_edit_history(source, settings))
        total += sum(len(a) for a in source.get("native", {}).get("unaligned_arrays", {}).values() if a is not None)
        if total > _EXCHANGE_MAX_VALUES:
            fail("Project exceeds 2,000,000 retained data values; reduce columns, groups, or scan lengths.")


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
    from .athena_literals import project_statements
    legacy_strings = "# Exported by Athena Web / XrayLarch" in text.splitlines()[:4]
    for raw in project_statements(text):
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
            value = _project_literal(value, legacy_strings=legacy_strings)
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
    # Desktop Athena assigns fresh group identities when old names collide.
    # Keep every spectrum and the original ID; ambiguous links use the first.
    if not sidecar:
        reserved = {r.get("old_group") for r in records if isinstance(r.get("old_group"), str)}
        seen = set()
        for record in records:
            original = record.get("old_group")
            if isinstance(original, str) and original in seen:
                suffix = 2
                while f"{original}__{suffix}" in reserved:
                    suffix += 1
                record["original_group_id"] = original
                record["old_group"] = f"{original}__{suffix}"
                reserved.add(record["old_group"])
            if isinstance(original, str):
                seen.add(original)
    return records, journal, sidecar, _metadata(metadata)


def _native_parameters(args, *, larch_writer=False):
    parameters = {}
    for key, native in _PARAMETER_MAP.items():
        raw = args.get(native, args.get(_NATIVE_ALIASES.get(native)))
        if key == "nnorm":
            # Demeter's process/larch/normalize.tmpl passes bkg_nnorm - 1.
            # A missing native preference defaults to three terms, unlike a
            # web recipe's None, which asks Larch to choose a degree.
            if raw in ("", None, "None"):
                parameters[key] = None if larch_writer else 2
            elif isinstance(raw, bool):
                parameters[key] = raw  # Preserve invalid settings for repair.
            else:
                try:
                    order = float(raw)
                    parameters[key] = order - (0 if larch_writer else 1) if np.isfinite(order) else raw
                except (TypeError, ValueError, OverflowError):
                    parameters[key] = raw
            continue
        if raw in ("", None):
            continue
        if key == "fnorm":
            parameters[key] = _native_flag(raw)
            continue
        if key in ("clamp_lo", "clamp_hi"):
            raw = {"none": 0, "slight": 3, "weak": 6, "medium": 12, "strong": 24, "rigid": 96}.get(str(raw).lower(), raw)
        elif raw == "None":
            continue
        try:
            parameters[key] = str(raw) if key in ("window", "rwindow", "bkg_window") else float(raw)
        except (TypeError, ValueError, OverflowError):
            # Keep the spectrum importable and the saved recipe inspectable;
            # scientific validation reports this field on processing.
            parameters[key] = raw
    if not _native_flag(args.get("bkg_fixstep")):
        parameters["step"] = None
    parameters["flatten"] = _native_flag(args.get("bkg_flatten"), True)
    return parameters


def _native_processing_limits(parameters, energy, data_type, source):
    """Resolve native limits against measured support, retaining original args.

    Demeter's Larch AUTOBK template changes a zero Kaiser width to 0.1.
    Background/FT compatibility resolutions are recorded here. Normalization
    outer requests remain in the recipe and are resolved by the shared
    processor, which reports the effective endpoints separately.
    """
    if data_type == "detector":
        return  # Absorption/EXAFS settings are dormant, not limits on counts.
    changes, resolved = [], {}

    def numeric(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value)

    def resolve(key, value, reason):
        original = parameters.get(key)
        if original != value:
            parameters[key] = value
            resolved[key] = value
            shown = f"{value:.10g}" if isinstance(value, (int, float)) else str(value)
            changes.append(f"{key}: {original} → {shown} ({reason})")

    if data_type == "chi":
        # Native chi records carry unused mu-processing placeholders such as
        # e0=0 and norm2=-20. They must not block their actual Fourier data.
        defaults = AthenaParameters().model_dump()
        for key in parameters.copy():
            if key.startswith("bkg_") or key in {"e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm", "rbkg", "nclamp", "clamp_lo", "clamp_hi", "fnorm", "flatten", "energy_shift"}:
                resolve(key, defaults[key], "inactive for chi(k)")
        if numeric(parameters.get("kmax")) and parameters["kmax"] > energy[-1]:
            resolve("kmax", float(energy[-1]), "measured chi(k) coverage")

    if str(parameters.get("bkg_window", "")).lower() in ("kaiser", "kaiser-bessel") and parameters.get("bkg_dk") == 0:
        resolve("bkg_dk", 0.1, "Demeter Larch Kaiser convention")
    e0 = parameters.get("e0")
    shift = parameters.get("energy_shift", 0)
    if data_type != "chi" and numeric(e0) and numeric(shift):
        lo, hi = float(energy[0] + shift - e0), float(energy[-1] + shift - e0)
        if lo < 0 < hi:
            # Normalization now resolves outer fit endpoints at processing time,
            # retaining the requested fields just like Demeter's Data object.
            from larch.xafs.xafsutils import ETOK
            available = float(np.sqrt(ETOK * hi))
            if numeric(parameters.get("bkg_kmax")) and parameters["bkg_kmax"] > available:
                resolve("bkg_kmax", available, "measured post-edge coverage")
            background_max = parameters.get("bkg_kmax")
            support = min(available, background_max) if numeric(background_max) and background_max > 0 else available
            if numeric(parameters.get("kmax")) and parameters["kmax"] > support:
                resolve("kmax", support, "available background coverage")
    if changes:
        source.setdefault("warnings", []).append("Native settings resolved for Larch; original values remain in source metadata: " + "; ".join(changes))
        source["native"]["resolved_parameters"] = resolved


def _native_source(record, filename, kind, settings):
    args = _metadata(record.get("args", {}))
    source = {"filename": filename, "raw_arrays": {}, "warnings": [],
              "native": {"format": kind, "id": record["old_group"], "args": args}}
    if "original_group_id" in record:
        source["native"]["id"] = record["original_group_id"]
        source["warnings"].append(f"Repeated native group ID {record['original_group_id']!r}: preserved as a separate spectrum; links to that old ID resolve to its first occurrence.")
    identity = _source_edge_identity({"edge_identity": {
        "element": args.get("bkg_z"), "edge": args.get("fft_edge")}})
    if identity and identity["element"] == "H":
        identity = None  # Native Demeter uses H as its inference sentinel.
    if identity:
        source["edge_identity"] = {**identity, "origin": "native"}
    if 'bkg_delta_eshift' in args:
        from .athena_alignment import signature
        try:
            uncertainty = float(args['bkg_delta_eshift'])
            shift = float(args.get('bkg_eshift', 0))
            if isinstance(args['bkg_delta_eshift'], bool) or not np.isfinite([uncertainty, shift]).all() or uncertainty < 0:
                raise ValueError
            source['alignment'] = dict(method='native', energy_shift=shift, shift_stderr=uncertainty,
                native_shift_stderr=uncertainty, signature=signature(dict(energy=record['x'], mu=record['y'])))
        except (TypeError, ValueError, OverflowError):
            source['warnings'].append('Invalid native energy-shift uncertainty was retained without applying it.')
    if "bkg_e0_fraction" in args:
        try:
            fraction = float(args["bkg_e0_fraction"])
            if isinstance(args["bkg_e0_fraction"], bool) or not 0 < fraction <= 1:
                raise ValueError
            source["e0_fraction"] = fraction
        except (TypeError, ValueError, OverflowError):
            source["warnings"].append("Native E₀ fraction is invalid; retained in native metadata without applying it.")
    unsupported = {k: v for k, v in record.items() if k not in ("old_group", "args", "x", "y", *_NATIVE_ARRAYS)}
    if unsupported:
        source["native"]["fields"] = _metadata(unsupported)
    if 'xdi' in record:
        from .athena_xdi import from_native, identity as xdi_identity
        try:
            xdi = from_native(record['xdi'])
        except ValueError as exc:
            source['warnings'].append(f'Native XDI metadata was retained without applying it: {exc}')
        else:
            if xdi is not None:
                source['xdi_metadata'] = xdi
                unsupported.pop('xdi', None)
                if xdi_identity(xdi):
                    source['edge_identity'] = xdi_identity(xdi)
    if unsupported:
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
        "label", "datatype", "is_xmu", "is_xanes", "is_nor", "is_chi", "is_xmudat", "is_diff", "marked", "frozen",
        "plot_scale", "plot_yoffset", "bkg_flatten", "bkg_fixstep", "bkg_stan", "referencegroup", "reference", "annotation"}
    if identity:
        supported.update(("bkg_z", "fft_edge"))
    if "e0_fraction" in source:
        supported.add("bkg_e0_fraction")
    if 'alignment' in source:
        supported.add('bkg_delta_eshift')
    unapplied = sorted(set(args) - supported)
    if unapplied:
        source["native"]["unapplied_args"] = unapplied
        source["warnings"].append("Native settings retained but not applied (including any fits or properties): " + ", ".join(unapplied))
    return source


def _source_edge_identity(source):
    """Interpret valid identity metadata without enabling any import policy."""
    from .athena_e0 import atomic_edge
    identity = source.get("edge_identity")
    if not isinstance(identity, dict):
        return None
    try:
        entry = atomic_edge(identity.get("element"), identity.get("edge"))
        return {key: entry[key] for key in ("element", "edge")}
    except ValueError:
        return None  # Unknown native metadata remains preserved and inert.


def _is_difference(group):
    """The signal's meaning survives changes to its operation provenance."""
    if "is_difference" not in group:
        return group.get("source", {}).get("operation") == "difference"
    value = group["is_difference"]
    if not isinstance(value, bool):
        fail("The difference-spectrum flag must be boolean.")
    return value


def _ensure_edge_identity(group):
    """Populate missing identity from an existing result, without processing."""
    source = group["source"]
    effective = (group.get("result") or {}).get("effective", {})
    if "edge_identity" not in source and group["data_type"] not in ("chi", "detector") and not _is_difference(group):
        value = effective.get("e0")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value) and value > 0:
            from .athena_e0 import _infer_atomic
            entry = _infer_atomic(value)
            source["edge_identity"] = {**{key: entry[key] for key in ("element", "edge")}, "origin": "inferred"}
    identity = _source_edge_identity(source)
    if identity and group.get("result"):
        effective.update(identity)


def _derived_source(parent, operation, **details):
    # Retain scientific identity, not detector arrays that no longer share
    # the derived grid. Full input/provenance remains on the parent group.
    source = {"operation": operation, "parent": parent["id"], **details}
    for key in ("edge_identity", "e0_fraction"):
        if key in parent["source"]:
            source[key] = copy.deepcopy(parent["source"][key])
    from .athena_xdi_history import inherit_source
    source['xdi_metadata'] = inherit_source(parent, operation, details)
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


class ImportEdgePolicy(BaseModel):
    """A per-request copy of the current browser tab's import policy."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    element: str = Field(min_length=1, max_length=32)
    edge: str = Field(min_length=1, max_length=3)
    fraction: float = Field(default=0.5, gt=0, le=1, strict=True)


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    upload_id: str
    energy_column: str
    numerator: list[str] = Field(max_length=64)
    denominator: str | list[str] | None = Field(default=None, max_length=64)
    signal_multiplier: float = Field(default=1, strict=True, allow_inf_nan=False)
    invert: bool = Field(default=False, strict=True)
    mode: Literal["mu", "transmission", "fluorescence"] = "mu"
    units: Literal["eV", "keV"] = "eV"
    data_type: Literal["mu", "xanes", "norm", "chi", "xmudat"] = "mu"
    reference_numerator: str | None = None
    reference_denominator: str | None = None
    reference_log: bool = Field(default=True, strict=True)
    reference_same_element: bool = Field(default=True, strict=True)
    individual_channels: bool = Field(default=False, strict=True)
    sort: bool = False
    edge_policy: ImportEdgePolicy | None = None
    preprocessing: ImportPreprocessing | None = None
    rebin: ImportRebin | None = None
    rebin_grid: RebinGrid | None = None
    reader_reviewed: bool = Field(default=False, strict=True)


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


class EdgeIdentityOptions(BaseModel):
    """Group metadata, independent of numerical E0 and future-import policy."""
    model_config = ConfigDict(extra="forbid")
    element: str = Field(min_length=1, max_length=32, strict=True)
    edge: str = Field(min_length=1, max_length=3, strict=True)


_PARAMETER_MAP = {
    # Demeter explicitly ignores the older bkg_fnorm field on project import.
    # Its energy-dependent normalization switch is bkg_funnorm.
    "fnorm": "bkg_funnorm",
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
        self.plugin_configurations = PluginConfigurations(settings)
        self.smoothing_preferences = SmoothingPreferences(settings)
        from .athena_preferences import AthenaPreferences
        self.preferences = AthenaPreferences(settings)
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
                group["is_difference"] = _is_difference(group)
                effective = (group.get("result") or {}).get("effective", {})
                for key, default in defaults.items():
                    if key not in group["parameters"]:
                        group["parameters"][key] = effective.get(key) if effective.get(key) is not None else default
                _ensure_edge_identity(group)
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

    def parameter_updates(self, p, updates, *, skip_frozen=False, tolerate_errors=False):
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
                    if group["data_type"] not in ("mu", "norm", "xmudat"):
                        fail("Background standards apply to energy spectra with EXAFS processing.")
                standard_links[ident] = standard_id
            previous = group["parameters"]
            recipe = AthenaParameters.model_validate(previous | patch)
            if patch.get("fnorm") is True and (group["data_type"] != "mu" or group.get("is_normalized", False)):
                fail("fnorm requires raw mu input with EXAFS support.")
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
        self._process_groups(p, recipes, tolerate_errors=tolerate_errors)
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
            if group["data_type"] in ("chi", "detector") or _is_difference(group):
                reasons[ident] = "E₀ requires an absorption spectrum on an energy axis."
                continue
            try:
                result = compute_e0(group["energy"], group["mu"], group["parameters"],
                                    data_type="norm" if group.get("is_normalized") else group["data_type"], **choice.model_dump())
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
            if choice.method == "fraction":
                group["source"]["e0_fraction"] = choice.fraction
            elif choice.method == "atomic" and choice.element is not None:
                group["source"]["edge_identity"] = {
                    "element": result["element"], "edge": result["edge"], "origin": "selected",
                }
                group["result"]["effective"].update(element=result["element"], edge=result["edge"])
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
                   background_standard_id=None, project=None, is_difference=None, is_normalized=None):
        x, y = self.raw_arrays(energy, mu)
        if data_type not in ("mu", "xanes", "norm", "chi", "xmudat", "detector"):
            fail("Unsupported data type.")
        if is_normalized is not None and (not isinstance(is_normalized, bool) or
                (data_type in ("chi", "detector") and is_normalized) or (data_type in ("norm", "xmudat") and not is_normalized)):
            fail("Supply a boolean normalization flag consistent with the data type.")
        params = AthenaParameters.model_validate(parameters or {})
        g = {"id": uid(), "label": str(label)[:200], "energy": x.tolist(), "mu": y.tolist(),
             "data_type": data_type, "is_normalized": data_type in ("norm", "xmudat") if is_normalized is None else is_normalized,
             "parameters": params.model_dump(), "marked": True,
             "frozen": False, "multiplier": 1.0, "offset": 0.0, "notes": "", "reference_id": None,
             "background_standard_id": background_standard_id,
             "source": source or {}, "result": None, "processing_error": None}
        if not isinstance(g["source"], dict):
            fail("Source metadata must be an object.")
        g["is_difference"] = _is_difference(g if is_difference is None else dict(g, is_difference=is_difference))
        # Imported data remains inspectable even if its saved recipe needs repair.
        try:
            self.process(g, project)
        except (ValueError, WebInputError) as exc:
            g["processing_error"] = str(exc)
        return g

    def process(self, g, project=None):
        standard_id, standard = g.get("background_standard_id"), None
        # Native XANES keeps the EXAFS recipe and standard selection dormant.
        # Switching back restores them; it must not consume an old cached chi.
        if standard_id and g["data_type"] not in ("xanes", "detector"):
            if project is None:
                fail("Resolve the background standard in its project before processing this group.")
            if standard_id == g["id"]:
                fail("A group cannot be its own background standard.")
            source = self.group(project, standard_id)
            arrays = (source.get("result") or {}).get("arrays", {})
            if source.get("processing_error") or not arrays.get("k") or not arrays.get("chi"):
                fail(f"Background standard {source['label']} has no usable chi(k); repair its processing first.")
            if _is_difference(g):
                fail("A difference spectrum cannot use a background-removal standard.")
            standard = {"k": arrays["k"], "chi": arrays["chi"]}
        if _is_difference(g) and g["data_type"] not in ("chi", "detector"):
            from .athena_science import ARRAY_NAMES
            x = np.asarray(g["energy"]) + g["parameters"]["energy_shift"]
            y = np.asarray(g["mu"])
            arrays = {key: [] for key in ARRAY_NAMES}
            arrays.update(energy=x.tolist(), mu=y.tolist(), norm=y.tolist(), flat=y.tolist(), dmude=np.gradient(y, x).tolist())
            g["result"] = {"arrays": arrays, "effective": {"e0": None, "edge_step": None, "exafs": False},
                           "warnings": ["Difference spectrum: the signed difference is shown without edge normalization or EXAFS processing."]}
            g["processing_error"] = None
            _ensure_edge_identity(g)
            return
        recipe = (AthenaParameters(energy_shift=g["parameters"].get("energy_shift", 0)) if g["data_type"] == "detector"
                  else AthenaParameters.model_validate(g["parameters"]))
        normalized = g.get("is_normalized", g["data_type"] in ("norm", "xmudat"))
        if g["data_type"] in ("xanes", "norm", "xmudat", "detector") or normalized:
            recipe = recipe.model_copy(update={"fnorm": False})
        g["result"] = process_spectrum(g["energy"], g["mu"], recipe,
                                       data_type=g["data_type"], background_standard=standard,
                                       is_normalized=normalized)
        g["result"]["effective"]["background_standard_id"] = standard_id
        _ensure_edge_identity(g)
        g["processing_error"] = None

    def change_datatype(self, project, groups, options):
        """Athena Group dialog and Main::quick_change_type, without reimporting."""
        toggle = options.get("toggle", False)
        if not isinstance(toggle, bool) or set(options) - {"data_type", "toggle"}:
            fail("Choose a data type or the current-group type toggle.")
        destination = options.get("data_type")
        if toggle:
            if destination is not None or len(groups) != 1:
                fail("Toggle the type of exactly one current group, without a destination.")
            if groups[0]["data_type"] == "detector":
                fail("The quick toggle applies only to μ(E)/XANES; choose a destination in Change data type for detector counts.")
        elif destination not in ("mu", "xanes", "norm"):
            fail("Choose μ(E), XANES, or normalized μ(E).")
        changed, reasons = [], {}
        for group in groups:
            previous = group["data_type"]
            if previous not in ("mu", "xanes", "norm", "detector") or (toggle and previous == "detector"):
                reasons[group["id"]] = "χ(k) and FEFF data cannot be changed to an energy record type."
                continue
            normalized = group.get("is_normalized", previous == "norm")
            target = ("norm" if normalized else "mu") if previous == "xanes" else "xanes"
            if not toggle:
                target, normalized = destination, destination == "norm"
            group.update(data_type=target, is_normalized=normalized)
            changed.append({"group_id": group["id"], "label": group["label"],
                            "previous_type": previous, "data_type": target, "is_normalized": normalized})
        if not changed:
            fail("Select energy groups: χ(k) and FEFF types cannot be changed by this dialog.")
        # Native type correction includes frozen groups and retains recipes,
        # raw arrays, reference links and difference identity. Rebuild results
        # and dependent standards; failed science remains explicitly repairable.
        self._process_groups(project, [item["group_id"] for item in changed], tolerate_errors=True)
        errors = {g["id"]: g["processing_error"] for g in project["groups"]
                  if g["id"] in self.background_dependents(project, [item["group_id"] for item in changed])
                  and g.get("processing_error")}
        return {"datatype_results": changed, "skipped_reasons": reasons, "processing_errors": errors}

    def make_import_group(self, label, energy, mu, *, data_type="mu", source=None, edge_policy=None):
        """Initialize raw imports; project restore and derived groups bypass this."""
        source = copy.deepcopy(source or {})
        parameters, prepared = None, None
        if edge_policy is not None and data_type != "chi":
            from .athena_import_policy import initialize_import
            policy = ImportEdgePolicy.model_validate(edge_policy)
            try:
                prepared = initialize_import(energy, mu, policy=policy.model_dump(), data_type=data_type)
            except ValueError as exc:
                fail(f"{label}: {exc}")
            parameters, data_type = prepared["parameters"], prepared["data_type"]
            source["edge_identity"] = prepared["edge_identity"]
            source["edge_policy"] = {**{key: prepared["edge_identity"][key] for key in ("element", "edge")},
                                     "fraction": policy.fraction}
            source["e0_fraction"] = policy.fraction
            source["import_defaults"] = prepared["defaults"]
            source.setdefault("warnings", []).extend(prepared.get("warnings", []))
        g = self.make_group(label, energy, mu, parameters=parameters, data_type=data_type, source=source)
        if prepared is not None:
            if g["processing_error"]:
                fail(f"{label}: enforced edge could not be processed. {g['processing_error']}")
            g["source"]["e0_selection"] = {
                **prepared["e0_selection"], "group_id": g["id"],
                "energy_shift": g["parameters"]["energy_shift"], "time": now(),
            }
            g["result"]["warnings"].extend(message for message in source.get("warnings", [])
                                           if message not in g["result"]["warnings"])
        elif data_type != "chi" and not _source_edge_identity(source) and g["result"] and g["result"]["effective"].get("e0") is not None:
            from .athena_e0 import _infer_atomic
            entry = _infer_atomic(g["result"]["effective"]["e0"])
            identity = {key: entry[key] for key in ("element", "edge")}
            g["source"]["edge_identity"] = {**identity, "origin": "inferred"}
            g["result"]["effective"].update(identity)
        return g

    def make_reference_group(self, sample, energy, mu, *, source, same_element):
        """Demeter Athena IO.pm: independent derivative E0, shared identity,
        and the rebin.use_atomic=25 eV safeguard for a same-edge reference.
        The sample's fractional-E0 import policy does not apply to its foil.
        """
        from .athena_e0 import atomic_edge, compute_e0
        source = copy.deepcopy(source)
        identity = _source_edge_identity(sample["source"]) if same_element else None
        if identity:
            source["edge_identity"] = {**identity, "origin": "reference_sample"}
        selection, parameters = None, None
        warnings = []
        try:
            selection = compute_e0(energy, mu, AthenaParameters(), data_type=sample["data_type"], method="derivative")
            sample_e0 = (sample.get("result") or {}).get("effective", {}).get("e0")
            if identity and sample_e0 is not None and abs(sample_e0 - selection["e0"]) > 25:
                atom = atomic_edge(identity["element"], identity["edge"])
                # Keep the measured curve inspectable if its tabulated edge
                # lies outside the scan, just as for other failed recipes.
                if energy[0] < atom["energy"] < energy[-1]:
                    previous = selection["e0"]
                    selection = compute_e0(energy, mu, AthenaParameters(), data_type=sample["data_type"],
                        method="atomic", element=identity["element"], edge=identity["edge"])
                    warnings.append(f"Reference derivative E0 ({previous:g} eV) differs from the sample by more than 25 eV; using the {identity['element']} {identity['edge']} tabulated edge ({selection['e0']:g} eV).")
                else:
                    warnings.append("The same-element reference edge is outside this scan; kept its measured derivative E0. Check the selected columns or clear Same element.")
            parameters = {"e0": selection["e0"]}
        except ValueError as exc:
            warnings.append(f"Reference E0 could not be initialized: {exc}")
        source.setdefault("warnings", []).extend(warnings)
        reference = self.make_group(sample["label"] + " · reference", energy, mu,
            data_type=sample["data_type"], source=source, parameters=parameters)
        reference["marked"] = False
        if selection:
            reference["source"]["e0_selection"] = {**selection, "group_id": reference["id"],
                "energy_shift": reference["parameters"]["energy_shift"], "time": now()}
        if reference["result"]:
            reference["result"]["warnings"].extend(warnings)
        return reference

    def inspect(self, ident, data, filename):
        project = self.load(ident)
        from .athena_file_plugins import prepare_file, PreparedCollection, PreparedProject, PreparedArchive
        from .parsing import _safe_display_name
        prepared = prepare_file(data, max_bytes=self.settings.max_upload_bytes,
                                max_points=self.settings.max_points, max_columns=self.settings.max_columns,
                                enabled=AthenaPreferences(self.settings).read_plugins()['enabled'],
                                read_configuration=self.plugin_configurations.read,
                                read_dispersive=lambda: AthenaPreferences(self.settings).read_dispersive()['coefficients'])
        display_name = _safe_display_name(filename)
        if isinstance(prepared, PreparedArchive):
            upload = uid()
            inspection = dict(kind='archive_list', upload_id=upload, display_name=display_name,
                              file_plugin=prepared.metadata, members=prepared.members)
            written = [f'upload-{upload}.source', f'upload-{upload}.json']
            try:
                self.storage.write_bytes(ident, written[0], data)
                self.storage.write_json(ident, written[1], inspection)
            except BaseException:
                for name in written:
                    self.storage.path(ident, name).unlink(missing_ok=True)
                raise
            return inspection
        if isinstance(prepared, PreparedProject):
            return {'kind': 'project', 'preview': self.preview_project(ident, data, display_name, prepared=prepared)}
        if isinstance(prepared, PreparedCollection):
            # Parse every scan before staging any result. A damaged later
            # scan must not leave a partial collection available to import.
            parsed_scans = [parse_upload(scan.data, display_name + '.dat',
                max_bytes=self.settings.max_upload_bytes, max_points=self.settings.max_points,
                max_columns=self.settings.max_columns) for scan in prepared.scans]
            source_upload = uid(); written = [f'upload-{source_upload}.source']; scans = []
            try:
                self.storage.write_bytes(ident, written[0], data)
                for scan, parsed in zip(prepared.scans, parsed_scans, strict=True):
                    upload = uid()
                    written.extend(f'upload-{upload}.{ext}' for ext in ('npz', 'converted', 'json'))
                    scan_name = _safe_display_name(f'{display_name}.scan-{scan.metadata["scan"]["ordinal"]}')
                    scans.append(self._inspect_table(ident, project, data, scan_name, scan, parsed=parsed,
                        upload=upload, source_upload=source_upload, source_name=display_name))
            except BaseException:
                for name in written:
                    self.storage.path(ident, name).unlink(missing_ok=True)
                raise
            return {'kind': 'scan_list', 'display_name': display_name, 'file_plugin': prepared.metadata, 'scans': scans}
        return self._inspect_table(ident, project, data, display_name, prepared)

    def _inspect_table(self, ident, project, data, display_name, prepared, *, parsed=None, upload=None,
                       source_upload=None, source_name=None):
        if parsed is None:
            parsed = parse_upload(prepared.data if prepared else data, display_name + '.dat' if prepared else display_name,
                max_bytes=self.settings.max_upload_bytes, max_points=self.settings.max_points, max_columns=self.settings.max_columns)
        upload = upload or uid()
        self.storage.write_arrays(ident, f"upload-{upload}.npz", parsed.arrays)
        inspection = parsed.inspection().model_dump()
        inspection['display_name'] = display_name
        if parsed.xdi_metadata is not None:
            inspection['xdi_metadata'] = copy.deepcopy(parsed.xdi_metadata)
        from .athena_beamline_metadata import identify
        beamline = identify(prepared.data if prepared else data,
                            enabled=AthenaPreferences(self.settings).read_beamline()['enabled'])
        if beamline is not None:
            beamline['input_basis'] = 'converted' if prepared else 'original'
            inspection['beamline_metadata'] = beamline
        from .athena_columns import suggest_columns
        suggestion, column_units = suggest_columns(inspection['columns'], inspection['display_name'])
        if prepared:
            ids = [c['column_id'] for c in inspection['columns']]
            plugin_suggestions = {}
            if prepared.suggestions is not None:
                for mode, choice in prepared.suggestions.items():
                    chosen = dict(choice, energy_column=ids[choice['energy_column']],
                        numerator=[ids[i] for i in choice['numerator']], denominator=ids[choice['denominator']] if choice['denominator'] is not None else '')
                    plugin_suggestions[mode] = chosen
                    column_units[chosen['energy_column']] = chosen['units']
                if plugin_suggestions:
                    suggestion = next(iter(plugin_suggestions.values()))
            elif max(prepared.numerator, prepared.denominator) < len(ids):
                suggestion = dict(energy_column=ids[0], numerator=[ids[prepared.numerator]],
                                  denominator=ids[prepared.denominator], mode='transmission', units='eV', data_type='mu')
                plugin_suggestions['transmission'] = suggestion
            if prepared.fluorescence:
                n, d = prepared.fluorescence
                plugin_suggestions['fluorescence'] = dict(suggestion, numerator=[ids[n]], denominator=ids[d], mode='fluorescence')
            inspection['plugin_suggestions'] = plugin_suggestions
            if prepared.suggestions is None:
                column_units[ids[0]] = 'eV'
            for index, units in (prepared.column_units or {}).items():
                column_units[ids[index]] = units
                if suggestion['energy_column'] == ids[index]:
                    suggestion = dict(suggestion, units=units)
            converted = prepared.data.decode('utf-8')
            inspection.update(file_plugin=prepared.metadata, converted_preview='\n'.join(converted.splitlines()[:120]),
                              converted_preview_truncated=len(converted.splitlines()) > 120)
            if prepared.preview is not None:
                inspection['reader_preview'] = prepared.preview
            self.storage.write_bytes(ident, f'upload-{upload}.converted', prepared.data)
        if source_upload:
            inspection.update(source_upload_id=source_upload, source_display_name=source_name)
        else:
            self.storage.write_bytes(ident, f'upload-{upload}.source', data)
        inspection.update(athena_suggestion=suggestion, column_units=column_units)
        snippet = data[:32_000].decode("utf-8-sig", errors="replace")
        inspection.update(source_preview="\n".join(snippet.splitlines()[:120]),
                          source_preview_truncated=len(data) > 32_000 or len(snippet.splitlines()) > 120)
        if prepared and prepared.metadata.get('binary'):
            inspection.update(source_preview='\n'.join(f'{i:08x}  ' + data[i:i + 16].hex(' ')
                                                       for i in range(0, min(len(data), 512), 16)),
                              source_preview_format='hex', source_preview_truncated=len(data) > 512)
        self.storage.write_json(ident, f"upload-{upload}.json", inspection)
        return self._remembered_inspection(inspection | {'upload_id': upload}, project)

    def _remembered_inspection(self, inspection, project):
        try:
            remembered = AthenaPreferences(self.settings).column_choices(inspection, project)
            if remembered is not None:
                inspection['remembered_columns'] = remembered
        except (ValueError, OSError, KeyError, TypeError):
            inspection['warnings'] = [*inspection['warnings'], 'Remembered column choices could not be read. Review the suggested columns; saved choices were left unchanged.']
        return inspection

    def inspect_dispersive(self,ident,data,filename):
        # Calibration must inspect unconverted pixels even when SLRIBL4 is
        # enabled. The same Larch table parser validates every original row.
        from .parsing import _safe_display_name
        from .athena_dispersive import parse_pixels
        parsed=parse_pixels(data,filename,self.settings.max_upload_bytes,self.settings.max_points,self.settings.max_columns)
        return self._inspect_table(ident,self.load(ident),data,_safe_display_name(filename),None,parsed=parsed)

    def _dispersive_inputs(self,ident,request):
        from .athena_columns import map_columns
        from .athena_science import _pair
        p=self.load(ident);self.check(p,request.version)
        self.storage._validate_id(request.upload_id)
        arrays=self.storage.read_arrays(ident,f'upload-{request.upload_id}.npz')
        metadata=self.storage.read_json(ident,f'upload-{request.upload_id}.json')
        choice=request.columns
        mapped=map_columns(arrays,ImportRequest(version=request.version,upload_id=request.upload_id,
            energy_column=choice.pixel_column,numerator=choice.numerator,denominator=choice.denominator,
            mode='transmission' if choice.logarithm else 'fluorescence',invert=choice.invert,sort=choice.sort))
        x=mapped['x'];y=mapped['samples'][0]['y'][mapped['order']]
        if choice.reverse_signal:y=y[::-1]
        x,y=_pair(x,y,name='Pixel spectrum',minimum=8)
        if x[0]<0:fail('Pixel coordinates must be nonnegative.')
        standard=None
        if request.standard_id:
            standard=self.group(p,request.standard_id)
            if standard['data_type'] in ('chi','detector') or _is_difference(standard):
                fail('Choose a conventional absorption spectrum as the calibration standard.')
        return p,x,y,standard,metadata,arrays,mapped['warnings'],mapped['order']

    def dispersive(self,ident,request,action='preview'):
        from .athena_dispersive import normalize,guess,refine,apply
        from .athena_columns import preview_trace
        p,x,y,standard,metadata,arrays,warnings,order=self._dispersive_inputs(ident,request)
        c=request.coefficients
        result=dict(version=p['version'],upload_id=request.upload_id,columns=request.columns.model_dump(),
                    standard_id=request.standard_id,coefficients=c.model_dump(),warnings=list(warnings),
                    pixel=preview_trace(x,y,label=metadata['display_name'],role='pixel',ident='pixel'),points=len(x))
        if action=='columns':return result
        ex=sy=sn=None
        if standard is not None:
            ex=np.asarray(standard['energy'])+standard['parameters']['energy_shift'];sy=np.asarray(standard['mu'])
            sn=AthenaParameters.model_validate(standard['parameters'])
        if action in ('guess','refine'):
            if standard is None:fail('Select a conventional calibration standard first.')
            if action=='guess':c,details=guess(x,y,ex,sy,request.normalization,sn,c.quadratic,standard_normalized=standard['is_normalized'])
            else:c,details=refine(x,y,ex,sy,c,request.nsmooth)
            result.update(details=details,coefficients=c.model_dump())
            result['warnings'].extend(details['warnings'])
        elif action!='preview':fail('Choose a dispersive preview, initial guess or refinement.')
        converted=apply(x,y,c);cx=np.asarray(converted['energy']);cy=np.asarray(converted['mu'])
        result['calibrated']=preview_trace(cx,cy,label=metadata['display_name']+' · calibrated',role='calibrated',ident='calibrated')
        result['reversed']=converted['details']['reversed']
        if standard is not None:
            normalized=normalize(cx,cy,PixelNormalization())
            conventional=normalize(ex,sy,sn,standard['parameters']['e0'],normalized=standard['is_normalized'])
            result['normalized']=preview_trace(cx,normalized.norm,label=metadata['display_name']+' · calibrated',role='calibrated',ident='calibrated_norm')
            result['standard']=preview_trace(ex,conventional.norm,label=standard['label'],role='standard',ident=standard['id'])
            result['plot_range']=[float(conventional.e0)-100,float(conventional.e0)+400]
        return result

    def make_dispersive(self,ident,request):
        from .athena_dispersive import apply
        with self.storage.lock(ident):
            old,x,y,standard,metadata,arrays,warnings,order=self._dispersive_inputs(ident,request)
            if len(old['groups'])>=100:fail('A project can contain at most 100 groups.')
            converted=apply(x,y,request.coefficients)
            if converted['details']['reversed']:
                order=order[::-1]
            source=dict(kind='dispersive',filename=metadata['display_name'],operation='dispersive',
                calibration=request.coefficients.model_dump(),pixel_columns=request.columns.model_dump(),
                standard_id=request.standard_id,standard_label=standard['label'] if standard else None,
                column_arrays={k:np.asarray(v)[order].tolist() for k,v in arrays.items()},
                column_order='group',row_order=order.tolist(),columns=metadata['columns'],
                source_sha256=hashlib.sha256(self.storage.path(ident,f'upload-{request.upload_id}.source').read_bytes()).hexdigest(),
                warnings=list(metadata.get('warnings',[]))+warnings)
            for field in ('xdi_metadata', 'beamline_metadata'):
                if metadata.get(field):
                    source[field] = copy.deepcopy(metadata[field])
            source=_exchange_source(source,len(x),self.settings)
            _exchange_budget([*old['groups'],dict(energy=converted['energy'],mu=converted['mu'],source=source)],self.settings)
            new=self.make_group(metadata['display_name']+' · calibrated',converted['energy'],converted['mu'],source=source)
            from .athena_xdi_history import inherit_source
            # Acquisition metadata belongs to the pixel upload. The standard
            # only supplies calibration, never its own scan times or comments.
            new['source']['xdi_metadata'] = inherit_source(new, 'dispersive', {})
            new['marked']=False
            p=copy.deepcopy(old)
            index=p['groups'].index(standard)+1 if standard is not None else len(p['groups'])
            p['groups'].insert(index,new)
            return self.save(p,old,'Dispersive calibration · '+metadata['display_name'])

    def inspected_columns(self, ident, upload_id):
        project = self.load(ident)
        self.storage._validate_id(upload_id)
        try:
            inspection = self.storage.read_json(ident, f'upload-{upload_id}.json')
        except FileNotFoundError:
            fail('These inspected columns are unavailable. Select the original file again.')
        if inspection.get('kind') == 'archive_list':
            fail('Choose files from the ZIP before inspecting columns.')
        return self._remembered_inspection(inspection | {'upload_id': upload_id}, project)

    def archive_member(self, ident, upload_id, member_index):
        self.load(ident)
        self.storage._validate_id(upload_id)
        try:
            inspection = self.storage.read_json(ident, f'upload-{upload_id}.json')
            data = self.storage.path(ident, f'upload-{upload_id}.source').read_bytes()
        except FileNotFoundError:
            fail('This ZIP is unavailable. Select the original archive again.')
        if inspection.get('kind') != 'archive_list':
            fail('Choose a staged ZIP archive.')
        from .athena_zip import read_archive
        from .parsing import _safe_display_name
        content, name = read_archive(data, self.settings.max_upload_bytes, member_index)
        return content, _safe_display_name(name)

    def inspected_file(self, ident, upload_id, variant):
        self.load(ident)
        self.storage._validate_id(upload_id)
        if variant not in ('source', 'converted'):
            fail('Choose the original or converted source file.')
        try:
            metadata = self.storage.read_json(ident, f'upload-{upload_id}.json')
            source_id = metadata.get('source_upload_id', upload_id) if variant == 'source' else upload_id
            self.storage._validate_id(source_id)
            content = self.storage.path(ident, f'upload-{source_id}.{variant}').read_bytes()
        except FileNotFoundError:
            fail('This source file is unavailable. Select the original file again.')
        return content, (metadata.get('source_display_name', metadata['display_name']) if variant == 'source'
                         else metadata['display_name'] + '.converted.dat')

    def import_standard(self, project, request):
        choice = request.preprocessing
        if choice is None or not (choice.copy_parameters or choice.align):
            return None
        if request.data_type == 'chi':
            fail('Import-time parameter copying and alignment require energy data, not chi(k).')
        standard = self.group(project, choice.standard_id)
        if standard['data_type'] in ('chi', 'detector') or _is_difference(standard):
            fail('Choose an absorption spectrum as the preprocessing standard.')
        if standard.get('processing_error') or not standard.get('result'):
            fail(f"{standard['label']}: repair the preprocessing standard before importing.")
        return standard

    def preprocess_import(self, project, sample, standard, choice):
        """Apply only to new groups; the enclosing import owns the transaction."""
        if choice is None:
            return  # Compatibility with saved/older clients.
        sample['marked'] = choice.mark
        record = choice.model_dump()
        sample['source']['import_preprocessing'] = record
        if standard is None:
            return
        record.update(standard_label=standard['label'], standard_version=project['version'])
        if choice.copy_parameters:
            patch = {key: value for key, value in standard['parameters'].items() if key != 'energy_shift'}
            patch['background_standard_id'] = standard.get('background_standard_id')
            self.parameter_updates(project, {sample['id']: patch})
            sample['multiplier'], sample['offset'] = standard['multiplier'], standard['offset']
            if 'edge_identity' in standard['source']:
                sample['source']['edge_identity'] = copy.deepcopy(standard['source']['edge_identity'])
                _ensure_edge_identity(sample)
            record['copied_parameters'] = copy.deepcopy(patch)

    def align_import(self, project, sample, reference, standard, choice, shared_alignment):
        if choice is not None and choice.align:
            record = sample['source']['import_preprocessing']
            from .athena_preprocessing import import_alignment
            # Native MED imports share the first detector's fitted shift.
            # Use paired references only when both spectra have one.
            if shared_alignment is None:
                family = self.reference_family(project, standard['id'])
                standard_reference = next((g for g in family if g['id'] != standard['id']), None)
                use_reference = reference is not None and standard_reference is not None
                moving, fixed = (reference, standard_reference) if use_reference else (sample, standard)
                prefs = self.smoothing_preferences.read()['values']
                shared_alignment = import_alignment(moving, fixed, sg_window=prefs['window'], sg_order=prefs['order']) | {
                    'used_references': use_reference, 'moving_id': moving['id'], 'standard_id': fixed['id']}
            patch = {'energy_shift': shared_alignment['energy_shift']}
            if choice.copy_parameters:
                # E0 copied from a calibrated standard is already on the final
                # energy axis. A tied reference keeps its own edge plus shift.
                patch['e0'] = sample['parameters']['e0']
            self.parameter_updates(project, {sample['id']: patch})
            record['alignment'] = copy.deepcopy(shared_alignment)
            from .athena_alignment import signature
            for member in self.reference_family(project, sample['id']):
                member['source']['alignment'] = copy.deepcopy(shared_alignment) | {'signature': signature(member)}
        return shared_alignment

    def rebinned_source(self, source, x, y, plan):
        if plan is None:
            return source, x, y
        source = copy.deepcopy(source)
        original = {'energy': np.asarray(x).tolist(), 'mu': np.asarray(y).tolist()}
        for key in ('raw_arrays', 'column_arrays', 'row_order', 'column_order'):
            if key in source:
                original[key] = source.pop(key)
        source['rebin_original'] = original
        source['raw_arrays'] = {key: (plan.uncertainty(values) if key == 'stddev' else plan.apply(values)).tolist()
                                for key, values in original.get('raw_arrays', {}).items()}
        source['rebin'] = copy.deepcopy(plan.details)
        source.setdefault('warnings', []).extend(plan.details['warnings'])
        if 'stddev' in source['raw_arrays']:
            source['rebin']['uncertainty'] = 'independent-input linear propagation, including shared smoothing observations'
        source = _exchange_source(source, len(plan.energy), self.settings)
        return source, plan.energy, plan.apply(y)

    def import_data(self, ident, request: ImportRequest):
        with self.storage.lock(ident):
            old = self.load(ident)
            self.check(old, request.version)
            p = copy.deepcopy(old)
            standard = self.import_standard(p, request)
            shared_alignment = None
            self.storage._validate_id(request.upload_id)
            arrays = self.storage.read_arrays(ident, f"upload-{request.upload_id}.npz")
            metadata = self.storage.read_json(ident, f"upload-{request.upload_id}.json")
            if metadata.get('file_plugin', {}).get('review_required') and not request.reader_reviewed:
                raise WebInputError('reader_review_required', 'Review the I0 correction plot before importing.',
                                    recovery='Inspect the fit and corrected I0, then confirm the review for this file.')
            from .athena_columns import map_columns
            mapped = map_columns(arrays, request)
            prepare_rebin(mapped, request, standard)
            x, order = mapped["x"], mapped["order"]
            nnew = len(mapped["samples"]) * (2 if mapped["reference"] is not None else 1)
            if len(p["groups"]) + nnew > 100:
                fail("A project can contain at most 100 groups.")
            def column(key):
                if key not in arrays:
                    fail("Choose columns from the inspected file.")
                return np.asarray(arrays[key], dtype=float)
            source_base = {"filename": metadata["display_name"], "mapping": request.model_dump(exclude={"version", "edge_policy"}),
                      "warnings": list(metadata.get("warnings", [])) + mapped["warnings"], "columns": metadata["columns"],
                      "column_arrays": {key: np.asarray(values)[order].tolist() if request.sort else np.asarray(values).tolist()
                                        for key, values in arrays.items()},
                      "column_order": "group", "raw_arrays": {}}
            if metadata.get('file_plugin'):
                source_base['file_plugin'] = copy.deepcopy(metadata['file_plugin'])
            if metadata.get('beamline_metadata'):
                source_base['beamline_metadata'] = copy.deepcopy(metadata['beamline_metadata'])
            if metadata.get('xdi_metadata'):
                from .athena_xdi import identity as xdi_identity
                source_base['xdi_metadata'] = copy.deepcopy(metadata['xdi_metadata'])
                if xdi_identity(metadata['xdi_metadata']):
                    source_base['edge_identity'] = xdi_identity(metadata['xdi_metadata'])
            # Preserve original units/column IDs. When sorting was requested,
            # all retained columns follow the group row order; row_order maps
            # those rows back to the uploaded table.
            if request.sort:
                source_base["row_order"] = order.tolist()
            def aligned(values):
                return (values[order] if request.sort else values).tolist()
            names = {c["column_id"]: f"{c['name']} (column {c['index'] + 1})" for c in metadata["columns"]}
            for sample in mapped["samples"]:
                source = copy.deepcopy(source_base)
                source["mapping"]["numerator"] = sample["columns"]
                if request.data_type == 'chi':
                    source['mapping'].update(mode='mu', denominator=None, signal_multiplier=1., invert=False)
                numerator, denominator = sample["numerator"], mapped["denominator"]
                y = sample["y"][order]
                if mapped["mode"] == "transmission":
                    source["raw_arrays"].update(i0=aligned(numerator), signal=aligned(mapped['scale'] * denominator))
                elif mapped["mode"] == "fluorescence":
                    source["raw_arrays"].update(i0=aligned(denominator), signal=aligned(mapped['scale'] * numerator))
                else:
                    source["raw_arrays"]["signal"] = aligned(mapped['scale'] * numerator)
                    i0_columns = [c["column_id"] for c in metadata["columns"] if c["name"].lower() == "i0"]
                    if len(i0_columns) == 1:
                        source["raw_arrays"]["i0"] = aligned(column(i0_columns[0]))
                stddev_columns = [c["column_id"] for c in metadata["columns"] if c["name"].lower() in ("stddev", "mu_stddev")]
                if len(stddev_columns) == 1:
                    source["raw_arrays"]["stddev"] = aligned(abs(mapped['scale']) * column(stddev_columns[0]))
                source = _exchange_source(source, len(x), self.settings)
                _exchange_budget([*p["groups"], {"energy": x, "mu": y, "source": source}], self.settings)
                label = metadata["display_name"]
                if request.individual_channels and sample["columns"]:
                    label += " · " + names.get(sample["columns"][0], "Constant 1")
                group_source, group_x, group_y = self.rebinned_source(source, x, y, sample.get('rebin'))
                g = self.make_import_group(label, group_x, group_y, data_type=request.data_type,
                                          source=group_source, edge_policy=request.edge_policy)
                if sample.get('rebin') is not None:
                    from .athena_xdi_history import inherit_source
                    g['source']['xdi_metadata'] = inherit_source(g, 'rebin', {})
                p["groups"].append(g)
                self.preprocess_import(p, g, standard, request.preprocessing)
                reference = None
                if mapped["reference"] is not None:
                    ref = mapped["reference"]
                    reference_source = copy.deepcopy(source)
                    reference_source["raw_arrays"] = ({"i0": aligned(ref["numerator"]), "signal": aligned(ref["denominator"])}
                        if request.reference_log else {"i0": aligned(ref["denominator"]), "signal": aligned(ref["numerator"])})
                    reference_source["mapping"].update(numerator=[request.reference_numerator] if request.reference_numerator else [],
                        denominator=request.reference_denominator, reference_numerator=None, reference_denominator=None,
                        individual_channels=False, signal_multiplier=1., invert=False,
                        preprocessing=ImportPreprocessing().model_dump() if request.preprocessing is not None else None,
                        data_type=g["data_type"], mode="transmission" if request.reference_log else "fluorescence")
                    reference_source, ref_x, ref_y = self.rebinned_source(reference_source, x, ref['y'][order], sample.get('reference_rebin'))
                    reference = self.make_reference_group(g, ref_x, ref_y,
                        source=reference_source, same_element=request.reference_same_element)
                    if sample.get('reference_rebin') is not None:
                        from .athena_xdi_history import inherit_source
                        reference['source']['xdi_metadata'] = inherit_source(reference, 'rebin', {})
                    g["reference_id"] = reference["id"]
                    p["groups"].append(reference)
                shared_alignment = self.align_import(p, g, reference, standard,
                                                     request.preprocessing, shared_alignment)
            _exchange_budget(p["groups"], self.settings)
            saved = self.save(p, old, f"Imported {metadata['display_name']} ({len(x)} points, {nnew} groups)")
            try:
                AthenaPreferences(self.settings).remember_columns(metadata, request, old)
            except (ValueError, OSError, KeyError, TypeError):
                # The spectrum has already been accepted. Do not report a
                # failed import (and invite duplicate imports) for a prefs error.
                return saved | {'import_preferences_warning': 'Spectra imported, but column choices could not be remembered for the next import.'}
            return saved

    def preview_columns(self, ident, request: ImportRequest):
        from .athena_columns import map_columns, preview_trace
        project = self.load(ident)
        self.check(project, request.version)
        standard = self.import_standard(project, request)
        self.storage._validate_id(request.upload_id)
        arrays = self.storage.read_arrays(ident, f"upload-{request.upload_id}.npz")
        metadata = self.storage.read_json(ident, f"upload-{request.upload_id}.json")
        mapped = map_columns(arrays, request)
        prepare_rebin(mapped, request, standard)
        x, order = mapped["x"], mapped["order"]
        if not np.isfinite(x).all():
            fail("The selected horizontal axis contains non-finite values after unit conversion.")
        warnings = list(metadata.get("warnings", [])) + mapped["warnings"]
        if request.preprocessing is not None and request.preprocessing.align:
            warnings.append('This preview shows the selected columns on the original energy axis. Standard alignment is applied when importing.')
        if request.rebin is None and np.any(np.diff(x) <= 0):
            warnings.append("The horizontal axis is not strictly increasing. Choose the energy column or sort the rows; duplicate energies must be repaired before import.")
        names = {c["column_id"]: f"{c['name']} (column {c['index'] + 1})" for c in metadata["columns"]}
        traces = [preview_trace(x, sample["y"][order], label=names.get(sample["columns"][0], 'Constant 1') if request.individual_channels and sample["columns"] else "Sample",
                  role="sample", ident="sample:" + "+".join(sample["columns"])) for sample in mapped["samples"]]
        if mapped["reference"] is not None:
            traces.append(preview_trace(x, mapped["reference"]["y"][order], label="Reference", role="reference", ident="reference"))
        rebin_results = []
        if request.rebin is not None:
            for trace in traces:
                trace.update(stage='original', label=trace['label'] + ' · original')
            for i, sample in enumerate(mapped['samples']):
                label = names.get(sample['columns'][0], 'Constant 1') if request.individual_channels and sample['columns'] else 'Sample'
                for key, y, role, title in [('rebin', sample['y'][order], 'sample', label),
                    ('reference_rebin', mapped['reference']['y'][order] if mapped['reference'] else None, 'reference', 'Reference · ' + label)]:
                    plan = sample.get(key)
                    if plan is None:
                        continue
                    trace = preview_trace(plan.energy, plan.apply(y), label=title + ' · rebinned', role=role, ident=f'{key}:{i}')
                    traces.append(trace | {'stage': 'rebinned'})
                    rebin_results.append({'id': trace['id'], 'label': title, 'role': role, **plan.details})
                    warnings.extend(plan.details['warnings'])
        self.check(self.load(ident), request.version)
        return {"filename": metadata["display_name"], "points": len(x), "traces": traces, "warnings": list(dict.fromkeys(warnings)),
                **({'rebin_results': rebin_results} if request.rebin is not None else {}),
                "x_label": "k (Å⁻¹)" if request.data_type == "chi" else "Energy (eV)",
                "y_label": "χ(k)" if request.data_type == "chi" else "μ(E)"}

    def _rebin_results(self, project, request: Command):
        """Build derived groups without persistence, using accepted recipes."""
        if request.action != 'rebin' or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Choose rebin and distinct source groups.')
        choice = PostRebin.model_validate(request.options)
        selected = {gid: self.group(project, gid) for gid in request.group_ids}
        results, skipped = [], {}
        # Native derived groups follow their originals in list order.
        for parent in project['groups']:
            if parent['id'] not in selected:
                continue
            reason = rebin_unavailable(parent)
            if reason:
                if not choice.skip_ineligible:
                    fail(f"{parent['label']}: {reason}")
                skipped[parent['id']] = reason
                continue
            x = np.asarray(parent['energy']) + parent['parameters']['energy_shift']
            e0 = choice.e0 or parent['parameters']['e0'] or (parent.get('result') or {}).get('effective', {}).get('e0')
            if e0 is None:
                fail(f"{parent['label']}: set a valid edge energy before rebinning.")
            plan = RebinPlan(x, choice, e0, 'manual' if choice.e0 is not None else 'saved-group-e0')
            source = _derived_source(parent, 'rebin', options=choice.model_dump(),
                parent_energy_shift=parent['parameters']['energy_shift'], parent_parameters=copy.deepcopy(parent['parameters']))
            for key in ('filename', 'columns', 'column_arrays', 'column_order', 'row_order', 'raw_arrays'):
                if key in parent['source']:
                    source[key] = copy.deepcopy(parent['source'][key])
            # Calibrated energies are materialized once. The pinned template
            # mixes shifted grid energies with unshifted interpolation inputs;
            # preserve the accepted calibration instead of duplicating that bug.
            source, energy, mu = self.rebinned_source(source, x, parent['mu'], plan)
            params = dict(parent['parameters'], energy_shift=0, e0=None)
            if _is_difference(parent):
                params['e0'] = e0  # A signed difference has no new absorption edge.
            derived = self.make_group(parent['label'] + ' rebinned', energy, mu,
                parameters=params, data_type=parent['data_type'], source=source,
                background_standard_id=parent.get('background_standard_id'), project=project,
                is_difference=_is_difference(parent), is_normalized=parent.get('is_normalized'))
            for key in ('notes', 'multiplier', 'offset'):
                derived[key] = copy.deepcopy(parent[key])
            # Explicit web list state. Native InsertData starts unchecked, but
            # AddData inherits the cloned marked flag; see the parity reference.
            derived['marked'] = False
            results.append((parent, derived))
        if not results:
            fail('No eligible energy groups are selected for rebinning.')
        return choice, results, skipped

    def preview_rebin(self, ident, request: Command):
        from .athena_columns import preview_trace
        project = self.load(ident)
        self.check(project, request.version)
        choice, prepared, skipped = self._rebin_results(project, request)
        results = []
        for parent, child in prepared:
            traces, errors = [], []
            for role, group in [('original', parent), ('rebinned', child)]:
                if choice.plot_space == 'E':
                    x = np.asarray(group['energy']) + group['parameters']['energy_shift']
                    y = group['mu']
                else:
                    arrays = (group.get('result') or {}).get('arrays', {})
                    x, y = arrays.get('k', []), arrays.get('weighted_chi', [])
                    if group.get('processing_error') or not len(x) or len(x) != len(y):
                        errors.append(f"{group['label']}: {group.get('processing_error') or 'No EXAFS data for a k-space preview.'}")
                        continue
                traces.append(preview_trace(np.asarray(x), np.asarray(y), label=parent['label'] + ' · ' + role,
                    role=role, ident=parent['id'] + ':' + role))
            results.append({'source_group_id': parent['id'], 'label': parent['label'],
                'details': child['source']['rebin'], 'traces': traces, 'errors': errors,
                'processing_error': child['processing_error'], 'parameters': child['parameters'],
                'kweight': parent['parameters']['kweight']})
        self.check(self.load(ident), request.version)
        return {'version': project['version'], 'options': choice.model_dump(), 'results': results,
                'skipped_reasons': skipped}

    def xdi_metadata(self, ident, group_id):
        from .athena_xdi_controls import metadata_view
        project = self.load(ident)
        return dict(version=project['version'], **metadata_view(self.group(project, group_id)))

    def _merge_results(self, project, request: Command):
        from .athena_merge import MergeOptions, merge, plot_curves
        if request.action!='merge' or len(request.group_ids)<2 or len(set(request.group_ids))!=len(request.group_ids):
            fail('Mark at least two distinct spectra for merging.')
        defaults=self.preferences.read_merge()['values']
        choice=MergeOptions.model_validate({**defaults,**request.options})
        groups=[self.group(project,ident) for ident in request.group_ids]
        reference_ids={g['reference_id'] for g in groups if g.get('reference_id')}
        if set(choice.reference_weights)-reference_ids:fail('Reference weights refer to a group outside the selected samples’ references.')
        primary=merge(groups,choice)
        used=[self.group(project,row['group_id']) for row in primary['members']]
        outputs=[('sample',used,primary)]
        notes=[]
        if choice.merge_references and choice.array!='chi':
            if all(g.get('reference_id') for g in used):
                refs=list({g['id']:g for g in (self.group(project,g['reference_id']) for g in used)}.values())
                if len(refs)<2: notes.append('The selected samples share one reference; a second reference spectrum is needed to make a reference merge.')
                else: outputs.append(('reference',refs,merge(refs,choice,weights={g['id']:choice.reference_weights[g['id']] for g in refs if g['id'] in choice.reference_weights})))
            else: notes.append('Reference channels were not merged because at least one contributing sample has no linked reference.')
        elif choice.array=='chi' and choice.merge_references:
            notes.append('Reference-channel merging applies to μ(E) and normalized μ(E), not χ(k).')
        if len(project['groups'])+len(outputs)>100:fail('A project can contain at most 100 groups.')
        labels={g['label'] for g in project['groups']}
        number=1;label=choice.label or 'merge'
        while label in labels and not choice.label:
            number+=1;label=f'merge {number}'
        prepared=[];rows=[]
        for role,parents,result in outputs:
            # Selection/filtering is repeated independently for the reference
            # merge; report its contributors and coefficients explicitly.
            parents=[self.group(project,item['group_id']) for item in result['members']]
            first=parents[0]
            source=_derived_source(first,'merge',parents=[g['id'] for g in parents],array=choice.array)
            if not choice.push_metadata: source.pop('xdi_metadata',None)
            source.update(raw_arrays={'stddev':result['stddev']},merge=dict(
                options=choice.model_dump(exclude_none=True),role=role,details=result['details'],members=result['members'],excluded=result['excluded']))
            source['warnings']=result['warnings']
            p=dict(first['parameters'],energy_shift=0)
            if p['e0'] is None:p['e0']=(first.get('result') or {}).get('effective',{}).get('e0')
            if choice.array=='chi':p['fnorm']=False
            dtype='chi' if choice.array=='chi' else 'mu'
            g=self.make_group(('  Ref ' if role=='reference' else '')+label,result['x'],result['y'],
                data_type=dtype,parameters=p,source=source,project=project,
                is_normalized=False if dtype=='chi' else first.get('is_normalized',False),
                background_standard_id=None if dtype=='chi' else first.get('background_standard_id'))
            g['marked']=role=='sample'
            prepared.append(g)
            rows.append(dict(role=role,label=g['label'],data_type=dtype,parameters=g['parameters'],
                result=result,curves=plot_curves(result,choice),
                plots={view:plot_curves(result,choice.model_copy(update={'plot':view})) for view in ('stddev','variance','marked')},
                processing_error=g['processing_error']))
        if len(prepared)==2:
            prepared[0]['reference_id']=prepared[1]['id'];prepared[1]['reference_id']=prepared[0]['id']
        _exchange_budget(project['groups']+prepared,self.settings)
        return prepared,dict(project_id=project['id'],version=project['version'],group_ids=request.group_ids,
            options=choice.model_dump(exclude_none=True),requested_options=request.options,outputs=rows,notes=notes)

    def preview_merge(self, ident, request: Command):
        project=self.load(ident);self.check(project,request.version)
        _,preview=self._merge_results(project,request)
        self.check(self.load(ident),request.version)
        return preview

    def _alignment_results(self, project, request: Command):
        from .athena_alignment import AlignmentOptions, display_curve, edge, fit_alignment, saved_fit, signature
        if request.action != 'align' or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Select distinct source groups for alignment.')
        options = dict(request.options)
        prefs = self.smoothing_preferences.read()['values']
        choice = AlignmentOptions.model_validate({'sg_window': prefs['window'], 'sg_order': prefs['order'], **options})
        if choice.operation != 'auto' and len(request.group_ids) != 1:
            fail('Inspect or manually shift one current group at a time.')
        standard = self.group(project, choice.standard_id)
        edge(standard)
        fixed = {g['id'] for g in self.reference_family(project, standard['id'])}
        working, updates, rows, reasons, handled = copy.deepcopy(project), {}, [], {}, set()
        for ident in request.group_ids:
            parent = self.group(project, ident)
            family = self.reference_family(project, ident)
            members = {g['id'] for g in family}
            reason = None
            if members & fixed: reason = 'The alignment standard and its linked references stay fixed.'
            elif members & handled: reason = 'This linked reference family is already included.'
            elif choice.operation != 'inspect' and (any(g['frozen'] for g in family) or self._frozen_background_dependents(project, members)):
                reason = 'Unfreeze the group, its linked references and background dependents before alignment.'
            elif choice.operation != 'inspect' and self.background_dependents(project, members) & fixed:
                reason = 'The fixed standard uses this group as a background standard.'
            if reason:
                if len(request.group_ids) == 1: fail(reason)
                reasons[ident] = reason
                continue
            try:
                edge(parent)
                use_refs = bool(choice.use_reference and parent.get('reference_id') and standard.get('reference_id'))
                moving = self.group(project, parent['reference_id']) if use_refs else parent
                fixed_curve = self.group(project, standard['reference_id']) if use_refs else standard
                before, target = display_curve(moving, choice.display), display_curve(fixed_curve, choice.display)
                fit = fit_alignment(moving, fixed_curve, smoothed=choice.fit == 'smoothed', sg_window=choice.sg_window,
                                    sg_order=choice.sg_order) if choice.operation == 'auto' else None
                shift = fit['summary']['energy_shift'] if fit else choice.energy_shift if choice.operation == 'manual' else parent['parameters']['energy_shift']
                # Native bkg_eshift's reference trigger changes only the shift.
                # Explicit E0 patches prevent parameter_updates from moving it.
                patches = {g['id']: dict(energy_shift=shift, e0=edge(g) if g['data_type'] not in ('chi','detector') and not _is_difference(g) else g['parameters']['e0'])
                           for g in family} if choice.operation != 'inspect' else {}
                after_group = copy.deepcopy(moving)
                if patches: after_group['parameters'].update(patches[moving['id']])
                after = display_curve(after_group, choice.display)
            except (ValueError, WebInputError) as exc:
                if len(request.group_ids) == 1: raise
                reasons[ident] = str(exc)
                continue
            updates.update(patches)
            handled.update(members)
            if choice.operation != 'inspect':
                for member in family:
                    dest = self.group(working, member['id'])
                    dest['source']['alignment'] = dict(
                        **(fit['summary'] if fit else dict(method='manual',energy_shift=shift,shift_stderr=None)),
                        signature=signature(dest), moving_id=moving['id'], standard_id=fixed_curve['id'], used_references=use_refs)
            rows.append(dict(group_id=ident, label=parent['label'], moving_id=moving['id'], standard_id=fixed_curve['id'],
                used_references=use_refs, before=before, after=after, standard=target, energy_shift=shift,
                shift_delta=shift-parent['parameters']['energy_shift'], fit=fit, saved_fit=saved_fit(parent) if choice.operation == 'inspect' else None))
        if not rows: fail('No selected groups can be aligned. ' + ' '.join(dict.fromkeys(reasons.values())))
        if updates: self.parameter_updates(working, updates, tolerate_errors=True)
        changed = [dict(group_id=g['id'], label=g['label'], energy_shift=g['parameters']['energy_shift'], e0=g['parameters']['e0'])
                   for g in working['groups'] if g['id'] in updates]
        errors = {g['id']: g['processing_error'] for g in working['groups']
                  if g['id'] in self.background_dependents(project, updates) and g.get('processing_error')}
        return working, dict(project_id=project['id'], version=project['version'], group_ids=request.group_ids,
            options=choice.model_dump(exclude_none=True), requested_options=request.options, rows=rows,
            changes=changed, skipped_reasons=reasons, processing_errors=errors)

    def preview_alignment(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        _, result = self._alignment_results(project, request)
        self.check(self.load(ident), request.version)
        return result

    def _calibration_results(self, project, request: Command, *, find_zero=False):
        from .athena_calibration import CalibrationOptions, calibration_curve, calibration_shift, shifted_axis, zero_crossing
        from .athena_e0 import atomic_edge
        from .athena_science import _edge, normalization_adjustments
        if request.action != 'calibrate' or len(request.group_ids) != 1:
            fail('Choose one current group to calibrate.')
        parent = self.group(project, request.group_ids[0])
        options = dict(request.options)
        if options.get('smoothing_method') == 'savitzky_golay' and options.get('smoothing', 0):
            prefs = self.smoothing_preferences.read()['values']
            options = {'sg_window': prefs['window'], 'sg_order': prefs['order'], **options}
        choice = CalibrationOptions.model_validate(options)
        x, y = shifted_axis(parent)
        observed = choice.observed
        if observed is None:
            observed = parent['parameters']['e0'] or (parent.get('result') or {}).get('effective', {}).get('e0')
            if observed is None:
                if parent['data_type'] == 'detector' or _is_difference(parent):
                    fail('Provide an observed reference energy for this group.')
                observed = _edge(x, y)
        if not x[0] <= observed <= x[-1]:
            fail('Choose the observed reference inside the displayed energy range.')
        atom = None
        identity = _source_edge_identity(parent['source'])
        if identity:
            atom = atomic_edge(identity['element'], identity['edge'])
        target = choice.target if choice.target is not None else atom['energy'] if atom else observed
        zero = zero_crossing(parent, observed) if find_zero else None
        choice = choice.model_copy(update=dict(observed=observed if zero is None else zero, target=target))
        curve = calibration_curve(parent, choice)
        shift = calibration_shift(choice.observed, target, parent['parameters']['energy_shift'])
        working = copy.deepcopy(project)
        family = self.reference_family(project, parent['id'])
        self.parameter_updates(working, {parent['id']: dict(energy_shift=shift, e0=target)}, tolerate_errors=True)
        calibrated_curve = None
        if choice.display == 'norm':
            # Rounding the shift changes E-E0 slightly. Refit the overlay on
            # the proposed recipe so it shows the normalization save will use.
            calibrated_curve = calibration_curve(self.group(working, parent['id']), choice.model_copy(update={'observed': target}))
        changed = [g['id'] for g in family if self.group(working, g['id'])['parameters'] != g['parameters']]
        errors = {g['id']: g['processing_error'] for g in working['groups']
                  if g['id'] in self.background_dependents(project, changed) and g.get('processing_error')}
        changes = [dict(group_id=g['id'], label=g['label'], e0=g['parameters']['e0'], energy_shift=g['parameters']['energy_shift'])
                   for g in working['groups'] if g['id'] in changed]
        limits = [dict(group_id=g['id'], label=g['label'], adjustments=adjustments)
                  for g in working['groups'] if g['id'] in self.background_dependents(project, [member['id'] for member in family])
                  and (adjustments := normalization_adjustments(g['parameters'], (g.get('result') or {}).get('effective', {})))]
        return working, dict(project_id=project['id'], version=project['version'], group_id=parent['id'],
            options=choice.model_dump(exclude_none=True), requested_options=request.options,
            curve=curve, energy_shift=shift, shift_delta=shift-parent['parameters']['energy_shift'],
            actual_reference=choice.observed + shift-parent['parameters']['energy_shift'],
            atomic_target=atom, zero_crossing=zero, changes=changes, processing_errors=errors,
            normalization_limits=limits, calibrated_curve=calibrated_curve)

    def preview_calibration(self, ident, request: Command, *, find_zero=False):
        project = self.load(ident)
        self.check(project, request.version)
        _, result = self._calibration_results(project, request, find_zero=find_zero)
        self.check(self.load(ident), request.version)
        return result

    def _point_edit_results(self, project, request: Command):
        from .athena_point_edit import parse_options, select_points, plot_views, selected_chie
        if request.action not in ('deglitch','truncate') or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Select distinct source groups for deglitching or truncation.')
        choice = parse_options(request.action, request.options)
        selected = {gid: self.group(project, gid) for gid in request.group_ids}
        working = copy.deepcopy(project)
        results, reasons, changed = [], {}, []
        for parent in project['groups']:
            if parent['id'] not in selected:
                continue
            if self._frozen_background_dependents(project, [parent['id']]):
                reason = 'Unfreeze this group and its background-standard dependents before removing points.'
                if choice.scope != 'marked':
                    fail(reason)
                reasons[parent['id']] = reason
                continue
            selection = select_points(parent, choice)
            edited = self.group(working, parent['id'])
            if selection['removed_indices']:
                keep = selection['kept_indices']
                edited['energy'], edited['mu'] = selection['energy'], selection['mu']
                source = edited['source']
                for key in ('raw_arrays', 'column_arrays'):
                    for name, values in source.get(key, {}).items():
                        if len(values) != selection['input_points']:
                            fail(f'{parent["label"]}: retained {name} does not match the measured rows.')
                        source[key][name] = [values[i] for i in keep]
                if len(source.get('row_order', [])) == selection['input_points']:
                    source['row_order'] = [source['row_order'][i] for i in keep]
                entry = dict(action=request.action, options=choice.model_dump(exclude_none=True),
                    removed_indices=selection['removed_indices'], removed_energy=selection['selected_energy'],
                    removed_mu=selection['selected_mu'], project_version=project['version'])
                source['point_edits'] = (source.get('point_edits', []) + [entry])[-200:]
                from .athena_xdi_history import inherit_source
                source['xdi_metadata'] = inherit_source(parent, 'remove_points',
                    dict(count=len(selection['removed_indices']), action=request.action))
                changed.append(parent['id'])
            results.append(dict(group_id=parent['id'], label=parent['label'], **selection,
                                original=plot_views(parent), selected_chie=selected_chie(parent, selection['selected_energy'])))
        if not results:
            fail('No editable selected groups remain. Unfreeze the intended groups or change the selection.')
        # Point removal can invalidate an old normalization/FFT range. Retain
        # the edit and its recipe with an explicit processing error, never stale
        # cached curves. Transitive background-standard consumers refresh too.
        self._process_groups(working, changed, tolerate_errors=True)
        _exchange_budget(working['groups'], self.settings)
        for row in results:
            group = self.group(working, row['group_id'])
            row.update(modified=plot_views(group), processing_error=group.get('processing_error'))
        return choice, working, results, reasons, changed

    def preview_point_edit(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        choice, working, results, reasons, changed = self._point_edit_results(project, request)
        self.check(self.load(ident), request.version)
        return dict(project_id=ident, version=project['version'], options=choice.model_dump(exclude_none=True),
                    results=results, skipped_reasons=reasons, changed_group_ids=changed)

    def _convolution_results(self, project, request: Command):
        from .athena_convolution import ConvolutionOptions, broaden, add_noise
        if request.action != 'convolve' or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Choose convolution and distinct source groups.')
        choice = ConvolutionOptions.model_validate(request.options).captured()
        selected = {gid: self.group(project, gid) for gid in request.group_ids}
        if len(project['groups']) + len(selected) > 100:
            fail('A project can contain at most 100 groups.')
        prepared = []
        for index, parent in enumerate(project['groups']):
            if parent['id'] not in selected:
                continue
            chi = parent['data_type'] == 'chi'
            if chi and choice.width:
                fail('Convolution width is in energy; use zero width to add noise to χ(k).')
            shift = 0 if chi else parent['parameters']['energy_shift']
            result = broaden(np.asarray(parent['energy']) + shift, parent['mu'], choice)
            params = dict(parent['parameters'], energy_shift=0)
            effective = (parent.get('result') or {}).get('effective', {})
            if not chi and parent['data_type'] != 'detector' and not _is_difference(parent):
                params['e0'] = effective.get('e0', params['e0'])
            source = _derived_source(parent, 'convolve', options=choice.model_dump(), details=result['details'],
                parent_parameters=copy.deepcopy(parent['parameters']), parent_energy_shift=shift)
            label = f"{parent['label']}: {choice.width:.2f} eV {choice.form.capitalize()}, {choice.noise:.3f} noise"
            child = self.make_group(label, result['energy'], result['mu'], parameters=params,
                data_type=parent['data_type'], source=source, project=project,
                background_standard_id=parent.get('background_standard_id'),
                is_difference=_is_difference(parent), is_normalized=parent.get('is_normalized'))
            if child['processing_error']:
                fail(f"Could not process convolved {parent['label']}: {child['processing_error']}")
            # Native noise() normalizes after broadening, then scales noise by
            # that updated edge step. Existing normalization recipes are kept.
            step = (child.get('result') or {}).get('effective', {}).get('edge_step')
            child['mu'], noise_details = add_noise(child['mu'], choice, step, chi=chi, offset=len(prepared))
            source['details'].update(noise_details)
            from .athena_xdi_history import inherit_source
            source['xdi_metadata'] = inherit_source(parent, 'convolve', source)
            if choice.noise:
                self.process(child, project)
            for key in ('notes', 'multiplier', 'offset'):
                child[key] = copy.deepcopy(parent[key])
            child['marked'] = bool(parent['marked'] and index == len(project['groups'])-1)
            prepared.append((parent, child))
        return choice, prepared

    def preview_convolution(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        choice, prepared = self._convolution_results(project, request)
        results = []
        for parent, child in prepared:
            traces, errors = {space: [] for space in ('E', 'k', 'R')}, {}
            for role, group in [('original', parent), ('modified', child)]:
                if group['data_type'] != 'chi':
                    x = np.asarray(group['energy']) + group['parameters']['energy_shift']
                    traces['E'].append(dict(role=role, label=group['label'], x=x.tolist(), y=group['mu']))
                for space, xkey, ykey in [('k', 'k', 'weighted_chi'), ('R', 'r', 'chir_mag')]:
                    arrays = (group.get('result') or {}).get('arrays', {})
                    x, y = arrays.get(xkey, []), arrays.get(ykey, [])
                    if x and len(x) == len(y):
                        traces[space].append(dict(role=role, label=group['label'], x=x, y=y))
            for space, curves in traces.items():
                if len(curves) != 2:
                    traces[space] = []
                    errors[space] = f'{space}-space comparison is unavailable for this data type or processing recipe.'
            results.append(dict(group_id=parent['id'], label=child['label'], details=child['source']['details'],
                input_space='k' if parent['data_type'] == 'chi' else 'E', data_type=parent['data_type'],
                kweight=parent['parameters']['kweight'], traces=traces, errors=errors,
                modified_energy=child['energy'], modified_mu=child['mu'], parameters=child['parameters']))
        self.check(self.load(ident), request.version)
        return dict(project_id=ident, version=project['version'], options=choice.model_dump(), results=results)

    def _smoothing_results(self, project, request: Command):
        from .athena_smoothing import SmoothOptions, smooth
        if request.action != 'smooth' or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Choose smoothing and distinct source groups.')
        if 'method' not in request.options:
            fail('Choose a smoothing algorithm before previewing.')
        options = request.options
        if options.get('method') == 'savitzky_golay' and ('window' not in options or 'order' not in options):
            # Capture current session defaults once; the preview returns both
            # values explicitly so a later preference edit cannot alter save.
            options = {**self.smoothing_preferences.read()['values'], **options}
        choice = SmoothOptions.model_validate(options)
        selected = {gid: self.group(project, gid) for gid in request.group_ids}
        if len(project['groups']) + len(selected) > 100:
            fail('A project can contain at most 100 groups.')
        results = []
        for index, parent in enumerate(project['groups']):
            if parent['id'] not in selected:
                continue
            shift = 0 if parent['data_type'] == 'chi' else parent['parameters']['energy_shift']
            transformed = smooth(np.asarray(parent['energy']) + shift, parent['mu'], choice)
            info = transformed['details']
            suffix = {'boxcar': f"boxcar size {info.get('window')}",
                      'gaussian': f"Gaussian filter {info.get('window')}, {info.get('sigma'):g}" if 'sigma' in info else '',
                      'savitzky_golay': 'Savitzky-Golay',
                      'three_point': f"smoothed {info.get('repetitions')} times"}[choice.method]
            effective = (parent.get('result') or {}).get('effective', {})
            params = dict(parent['parameters'], energy_shift=0)
            if parent['data_type'] not in ('chi', 'detector') and not _is_difference(parent):
                params['e0'] = effective.get('e0', params['e0'])
            source = _derived_source(parent, 'smooth', options=choice.model_dump(), details=info,
                parent_parameters=copy.deepcopy(parent['parameters']), parent_energy_shift=shift)
            separator = ', ' if choice.method in ('boxcar', 'gaussian') else ' '
            child = self.make_group(parent['label'] + separator + suffix, transformed['energy'], transformed['mu'],
                parameters=params, data_type=parent['data_type'], source=source,
                background_standard_id=parent.get('background_standard_id'), project=project,
                is_difference=_is_difference(parent), is_normalized=parent.get('is_normalized'))
            for key in ('notes', 'multiplier', 'offset'):
                child[key] = copy.deepcopy(parent[key])
            # Native SG/three-point clones retain marking when appended; new
            # put() groups and InsertData entries start unchecked.
            child['marked'] = bool(parent['marked'] and index == len(project['groups']) - 1
                                   and choice.method in ('savitzky_golay', 'three_point'))
            if child['processing_error']:
                fail(f"Could not process smoothed {parent['label']}: {child['processing_error']}")
            results.append((parent, child))
        return choice, results

    def preview_smoothing(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        choice, prepared = self._smoothing_results(project, request)
        results = []
        for parent, child in prepared:
            traces, errors = {space: [] for space in ('E', 'k', 'R')}, {}
            for role, group in [('original', parent), ('smoothed', child)]:
                if group['data_type'] != 'chi':
                    x = np.asarray(group['energy']) + group['parameters']['energy_shift']
                    traces['E'].append(dict(role=role, label=group['label'], x=x.tolist(), y=group['mu']))
                for space, xkey, ykey in [('k', 'k', 'weighted_chi'), ('R', 'r', 'chir_mag')]:
                    arrays = (group.get('result') or {}).get('arrays', {})
                    x, y = arrays.get(xkey, []), arrays.get(ykey, [])
                    if x and len(x) == len(y):
                        traces[space].append(dict(role=role, label=group['label'], x=x, y=y))
            for space, curves in traces.items():
                if len(curves) != 2:
                    traces[space] = []
                    errors[space] = f'{space}-space comparison is unavailable for this data type or processing recipe.'
            results.append(dict(group_id=parent['id'], label=child['label'], details=child['source']['details'],
                input_space='k' if parent['data_type'] == 'chi' else 'E', data_type=parent['data_type'],
                kweight=parent['parameters']['kweight'], traces=traces, errors=errors,
                smoothed_energy=child['energy'], smoothed_mu=child['mu'], parameters=child['parameters']))
        self.check(self.load(ident), request.version)
        return dict(project_id=ident, version=project['version'], options=choice.model_dump(), results=results)

    def _mee_results(self, project, request: Command):
        from .athena_mee import MEEOptions, group_input, subtract
        if request.action != 'multi_electron' or not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail('Choose MEE removal and distinct source groups.')
        choice = MEEOptions.model_validate(request.options)
        selected = {gid: self.group(project, gid) for gid in request.group_ids}
        results = []
        for parent in project['groups']:
            if parent['id'] not in selected:
                continue
            energy, norm, e0 = group_input(parent, choice)
            transformed = subtract(energy, norm, e0, choice)
            # Native mee_do assigns normalized-minus-model to the cloned xmu,
            # then the clone is processed with its retained normalization flag.
            params = dict(parent['parameters'], energy_shift=0, e0=e0)
            source = _derived_source(parent, 'multi_electron', options=choice.model_dump(),
                details=transformed['details'], parent_parameters=copy.deepcopy(parent['parameters']),
                parent_energy_shift=parent['parameters']['energy_shift'])
            child = self.make_group(parent['label'] + ' (MEE)', transformed['energy'], transformed['mu'],
                parameters=params, data_type=parent['data_type'], source=source,
                background_standard_id=parent.get('background_standard_id'), project=project,
                is_difference=_is_difference(parent), is_normalized=parent.get('is_normalized'))
            for key in ('notes', 'multiplier', 'offset'):
                child[key] = copy.deepcopy(parent[key])
            child['marked'] = parent['marked']
            if child['processing_error']:
                fail(f"Could not process MEE-corrected {parent['label']}: {child['processing_error']}")
            results.append((parent, child))
        return choice, results

    def preview_mee(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        choice, prepared = self._mee_results(project, request)
        results = []
        for parent, child in prepared:
            traces, errors = {}, {}
            for space, xkey, ykey in [('E', 'energy', 'norm'), ('k', 'k', 'weighted_chi'), ('R', 'r', 'chir_mag')]:
                traces[space] = []
                for role, group in [('original', parent), ('corrected', child)]:
                    arrays = group['result']['arrays']
                    x, y = arrays.get(xkey, []), arrays.get(ykey, [])
                    if not x or len(x) != len(y):
                        errors[space] = f'{space}-space data are unavailable for this group’s processing mode.'
                        continue
                    traces[space].append({'role': role, 'label': group['label'], 'x': x, 'y': y})
            results.append({'group_id': parent['id'], 'label': child['label'],
                'details': child['source']['details'], 'traces': traces, 'errors': errors,
                'kweight': parent['parameters']['kweight'], 'corrected_mu': child['mu'],
                'parameters': child['parameters']})
        self.check(self.load(ident), request.version)
        return {'project_id': ident, 'version': project['version'], 'options': choice.model_dump(), 'results': results}

    def preview_data_export(self, ident, request: DataExport):
        from .athena_export import prepare, preview
        project = self.load(ident)
        self.check(project, request.version)
        files = preview(prepare(project, request))
        self.check(self.load(ident), request.version)
        return dict(version=project['version'], project_id=ident, options=request.model_dump(), files=files)

    def export_data(self, ident, request: DataExport):
        from .athena_export import prepare, encode
        project = self.load(ident)
        self.check(project, request.version)
        result = encode(prepare(project, request), request.scope)
        self.check(self.load(ident), request.version)
        return result

    def parameter_report(self, ident, request: ParameterReport, *, download=False):
        from .athena_report import prepare_report, encode_report
        project = self.load(ident)
        self.check(project, request.version)
        report = prepare_report(project, request)
        result = encode_report(report) if download else report
        self.check(self.load(ident), request.version)
        return result

    def validate_xdi(self, ident, group_id, request: XDIValidation):
        from .athena_xdi_controls import effective_metadata, validate_fields
        project = self.load(ident)
        self.check(project, request.version)
        metadata = effective_metadata(self.group(project, group_id))
        report = validate_fields(metadata, request.family, request.tag)
        self.check(self.load(ident), request.version)
        return dict(version=project['version'], group_id=group_id, **report)

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
                for group in restore["groups"]:
                    group["is_difference"] = _is_difference(group)
                    _ensure_edge_identity(group)
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
                if action not in ("change_datatype", "metadata", "xdi_comments", "selection", "background_standard", "duplicate", "copy_series", "delete", "parameters", "set_e0", "copy_parameters", "reset_parameters", "align", "merge", "sum", "difference", "rebin", "multi_electron", "convolve", "deglitch", "truncate", "tie_reference", "untie_reference") and not (action == 'smooth' and 'method' in options) and any(g["frozen"] for g in groups):
                    fail("Unfreeze the selected groups before changing their data or processing.")
                if action == 'rebin':
                    choice, prepared, reasons = self._rebin_results(p, request)
                    created = {parent['id']: child for parent, child in prepared}
                    p['groups'] = [item for parent in p['groups'] for item in
                                   ([parent, created[parent['id']]] if parent['id'] in created else [parent])]
                    _exchange_budget(p['groups'], self.settings)
                    skipped = list(reasons)
                    operation_details = {'skipped_reasons': reasons, 'rebin_results': [
                        {'source_group_id': parent['id'], 'group_id': child['id'], 'label': child['label']}
                        for parent, child in prepared]}
                elif action == 'multi_electron':
                    choice, prepared = self._mee_results(p, request)
                    created = {parent['id']: child for parent, child in prepared}
                    p['groups'] = [item for parent in p['groups'] for item in
                                   ([parent, created[parent['id']]] if parent['id'] in created else [parent])]
                    _exchange_budget(p['groups'], self.settings)
                    operation_details = {'mee_results': [
                        {'source_group_id': parent['id'], 'group_id': child['id'], 'label': child['label']}
                        for parent, child in prepared]}
                elif action in ('deglitch','truncate'):
                    choice, edited, results, reasons, changed = self._point_edit_results(p, request)
                    if not changed:
                        fail('No points are selected for removal. Review the preview and change the limits.')
                    p['groups'] = edited['groups']
                    skipped = list(reasons)
                    operation_details = {'point_edit_results': [{k: row[k] for k in ('group_id','label','removed_indices','input_points','output_points','processing_error')} for row in results], 'skipped_reasons': reasons,
                                         'changed_group_ids': changed}
                elif action == 'convolve':
                    choice, prepared = self._convolution_results(p, request)
                    created = {parent['id']: child for parent, child in prepared}
                    p['groups'] = [item for parent in p['groups'] for item in
                                   ([parent, created[parent['id']]] if parent['id'] in created else [parent])]
                    _exchange_budget(p['groups'], self.settings)
                    operation_details = {'convolution_results': [
                        {'source_group_id': parent['id'], 'group_id': child['id'], 'label': child['label']}
                        for parent, child in prepared]}
                elif action == 'smooth' and 'method' in options:
                    choice, prepared = self._smoothing_results(p, request)
                    created = {parent['id']: child for parent, child in prepared}
                    p['groups'] = [item for parent in p['groups'] for item in
                                   ([parent, created[parent['id']]] if parent['id'] in created else [parent])]
                    _exchange_budget(p['groups'], self.settings)
                    operation_details = {'smoothing_results': [
                        {'source_group_id': parent['id'], 'group_id': child['id'], 'label': child['label']}
                        for parent, child in prepared]}
                elif action == "change_datatype":
                    operation_details = self.change_datatype(p, groups, options)
                    skipped = list(operation_details["skipped_reasons"])
                elif action == "selection":
                    field, mode = options.get("field", "marked"), options.get("mode", "invert")
                    if field not in ("marked", "frozen") or mode not in ("all", "none", "invert"):
                        fail("Choose marked or frozen groups and all, none, or invert.")
                    for g in groups:
                        g[field] = not g[field] if mode == "invert" else mode == "all"
                elif action == 'xdi_comments':
                    from .athena_xdi_controls import XDIComments, save_comments
                    choice = XDIComments.model_validate(options)
                    if len(groups) != 1:
                        fail('Save XDI comments for one current group at a time.')
                    save_comments(groups[0], choice.comments)
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
                elif action == "edge_identity":
                    from .athena_e0 import atomic_edge
                    choice = EdgeIdentityOptions.model_validate(options)
                    entry = atomic_edge(choice.element, choice.edge)
                    identity = {key: entry[key] for key in ("element", "edge")}
                    for g in groups:
                        g["source"]["edge_identity"] = {**identity, "origin": "selected"}
                        if g.get("result"):
                            g["result"]["effective"].update(identity)
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
                        from .athena_xdi_history import inherit_source
                        clone['source']['xdi_metadata'] = inherit_source(g, 'duplicate', {})
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
                            clone["is_difference"] = _is_difference(g)
                            clone["source"] = _derived_source(g, "copy_series", parameter=key, value=float(value))
                            self.process(clone, p)
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
                elif action == 'calibrate' and 'coordinate' in options:
                    calibrated, preview = self._calibration_results(p, request)
                    p['groups'] = calibrated['groups']
                    operation_details = {'calibration': {key: preview[key] for key in
                        ('group_id', 'options', 'energy_shift', 'shift_delta', 'actual_reference', 'changes', 'processing_errors')}}
                elif action == 'align' and 'method' in options:
                    aligned, preview = self._alignment_results(p, request)
                    if preview['options']['operation'] == 'inspect': fail('Preview an automatic or manual alignment before saving.')
                    p['groups'] = aligned['groups']
                    skipped = list(preview['skipped_reasons'])
                    operation_details = {'alignment': {key: preview[key] for key in
                        ('options','changes','processing_errors','skipped_reasons')}}
                elif action in ("calibrate", "align"):
                    reference = self.group(p, options.get("reference_id")) if action == "align" else None
                    if reference and reference["data_type"] == "detector":
                        fail("Choose an absorption spectrum as the alignment reference, not detector counts.")
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
                        if g["data_type"] == "detector" and (action != "calibrate" or options.get("observed") is None):
                            fail("Detector counts have no absorption edge; provide an observed calibration energy or an explicit energy shift.")
                        if action == "calibrate":
                            shift = calibrate_shift(g["energy"], g["mu"], float(options["target"]), options.get("observed"))
                            e0 = float(options["target"])
                        else:
                            own = self.group(p, g["reference_id"]) if options.get("use_reference") and g["reference_id"] else g
                            ref = self.group(p, reference["reference_id"]) if options.get("use_reference") and reference["reference_id"] else reference
                            if own["data_type"] == "detector" or ref["data_type"] == "detector":
                                fail("Tied detector counts cannot supply an absorption alignment reference.")
                            ref_x = np.asarray(ref["energy"]) + ref["parameters"]["energy_shift"]
                            shift = align_shift(own["energy"], own["mu"], ref_x, ref["mu"], options.get("xmin"), options.get("xmax"))
                            e0 = reference["result"]["effective"]["e0"]
                        self.parameter_updates(p, {g["id"]: {"energy_shift": float(shift), "e0": e0}})
                        updated_families.update(family_ids)
                elif action == "difference" and (set(options) - {"array", "label"}):
                    choice, results = self._difference_results(p, request)
                    if len(p["groups"]) + len(results) > 100:
                        fail("A project can contain at most 100 groups.")
                    operation_details["difference_results"] = []
                    for result in results:
                        parent = self.group(p, result["group_id"])
                        params = self._difference_parameters(parent, result)
                        source = _derived_source(parent, "difference", standard_id=choice.standard_id,
                            parents=[parent["id"], choice.standard_id], options=choice.model_dump(),
                            form=result["form"], data_form=result["data_form"], standard_form=result["standard_form"],
                            area=result["area"], integration=result["integration"], warnings=result["warnings"],
                            extrapolated_points=result["extrapolated_points"],
                            y_label=result["y_label"], area_label=result["area_label"])
                        derived = self.make_group(result["label"], result["energy"], result["difference"],
                            parameters=params, data_type="mu" if choice.form == "xmu" else "xanes",
                            source=source, is_difference=not choice.renormalize)
                        if derived["processing_error"]:
                            fail(f"Could not process difference for {parent['label']}: {derived['processing_error']}")
                        p["groups"].append(derived)
                        operation_details["difference_results"].append({"group_id": derived["id"],
                            "source_group_id": parent["id"], "label": derived["label"], "area": result["area"]})
                elif action=='merge' and 'method' in options:
                    merged,preview=self._merge_results(p,request)
                    p['groups'].extend(merged)
                    operation_details={'merge':dict(options=preview['options'],
                        group_ids=[g['id'] for g in merged],notes=preview['notes'],
                        outputs=[{k:row[k] for k in ('role','label','processing_error')} for row in preview['outputs']])}
                elif action in ("merge", "sum", "difference"):
                    if len(groups) < 2:
                        fail("Select at least two groups.")
                    array = options.get("array") if action != "difference" else None
                    if array not in (None, "mu", "norm", "chi"):
                        fail("Choose raw mu, normalized mu, or chi for the combination.")
                    if any(g["data_type"] == "detector" for g in groups) and (
                            array is not None or action == "difference" or any(g["data_type"] != "detector" for g in groups)):
                        fail("Combine detector counts only with other detector groups using Original data; correct the type before absorption-spectrum operations.")
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
                    source = _derived_source(groups[0], action, parents=[g['id'] for g in groups],
                        array=array or ('chi' if groups[0]['data_type'] == 'chi' else 'mu'))
                    is_difference = action == "difference" or all(_is_difference(g) for g in groups)
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
                    dtype = "norm" if is_difference and groups[0]["data_type"] != "chi" else groups[0]["data_type"]
                    if array in ("norm", "chi"):
                        dtype = array
                        if array == "norm":
                            params["step"] = None
                    if dtype != "mu":
                        params["fnorm"] = False
                    g = self.make_group(options.get("label", f"{action.title()} · {len(groups)} groups"), x, y,
                                        parameters=params, data_type=dtype, source=source,
                                        background_standard_id=groups[0].get("background_standard_id") if dtype != "chi" and not is_difference else None,
                                        project=p, is_difference=is_difference)
                    p["groups"].append(g)
                else:
                    from .athena_operations import transform_spectrum
                    allowed_options = {
                        "smooth": ("window", "order"), "deglitch": ("xmin", "xmax", "indices", "points"),
                        "truncate": ("xmin", "xmax"),
                        "convolve": ("form", "width"),
                        "deconvolve": ("form", "esigma", "width", "eshift", "smooth", "sgwindow", "sgorder"),
                        "self_absorption": ("formula", "element", "edge", "line", "angle_in", "angle_out", "e0", "pre1", "pre2", "norm1", "norm2", "nnorm"),
                        "dispersive": ("offset", "linear", "quadratic"),
                    }
                    if action not in allowed_options:
                        fail("Unknown processing operation.")
                    operation_options = {k: v for k, v in options.items() if k in allowed_options[action]}
                    for g in groups:
                        x = np.asarray(g["energy"]) + (0 if action == "dispersive" else g["parameters"]["energy_shift"])
                        if g["data_type"] == "chi" and action not in ("smooth", "deglitch", "truncate"):
                            fail("This operation requires energy-valued data.")
                        if g["data_type"] == "detector" and action not in ("smooth", "deglitch", "truncate", "convolve", "dispersive"):
                            fail("This operation requires an absorption spectrum; correct the detector data type first.")
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
                            parameters=params, data_type=dtype, source=_derived_source(g, action, options=operation_options, details=transformed["details"]),
                            background_standard_id=g.get("background_standard_id") if dtype in ("mu", "norm") else None,
                            project=p, is_difference=_is_difference(g),
                            is_normalized=g.get("is_normalized") if dtype == g["data_type"] else None)
                        if action == "deconvolve":
                            derived["source"]["energy_interval"] = [float(x[0]), float(x[-1])]
                        p["groups"].append(derived)
            message = f"{action.replace('_', ' ').capitalize()} · {len(groups)} selected groups" if groups else action.capitalize()
            if skipped:
                message += (f" · skipped {len(skipped)} groups" if action in ('set_e0', 'rebin', 'change_datatype') else
                            f" · skipped {len(skipped)} frozen groups or reference pairs")
            p["last_operation"] = {"action": action, "skipped_group_ids": skipped, **operation_details}
            return self.save(p, old, message)

    def _difference_results(self, project, request: Command):
        """Resolve a coherent, read-only set of DATA-minus-STANDARD results."""
        from .athena_difference import DifferenceOptions, difference_spectrum
        if request.action != "difference":
            fail("Choose the difference action for this preview.")
        if not request.group_ids or len(set(request.group_ids)) != len(request.group_ids):
            fail("Select distinct data groups for the difference.")
        try:
            choice = DifferenceOptions.model_validate(request.options)
            if choice.renormalize is None:
                choice = choice.model_copy(update={"renormalize": choice.form == "xmu"})
            if choice.standard_id in request.group_ids:
                fail("The difference standard cannot also be a data target.")
            standard = self.group(project, choice.standard_id)
            results = [difference_spectrum(self.group(project, gid), standard, choice)
                       for gid in request.group_ids]
        except (ValueError, TypeError, KeyError) as exc:
            if isinstance(exc, WebInputError):
                raise
            fail(str(exc))
        return choice, results

    @staticmethod
    def _difference_parameters(parent, result):
        # Difference coordinates already include calibration. Keep the target
        # E0 and numerical recipe, without applying its energy shift a second time.
        return dict(parent["parameters"], energy_shift=0, e0=result["e0"], fnorm=False)

    def preview_difference(self, ident, request: Command):
        project = self.load(ident)
        self.check(project, request.version)
        choice, results = self._difference_results(project, request)
        for result in results:
            result.update(k=[], weighted_chi=[], kweight=None, k_error=None, input_k=[])
            if choice.plot_space == "k":
                parent = self.group(project, result["group_id"])
                for role, original in (("DATA", parent), ("STANDARD", self.group(project, choice.standard_id))):
                    cached = original.get("result") or {}
                    arrays = cached.get("arrays", {})
                    k, chi = arrays.get("k", []), arrays.get("weighted_chi", [])
                    usable = (not original.get("processing_error") and isinstance(k, list) and isinstance(chi, list)
                              and len(k) > 0 and len(k) == len(chi))
                    result["input_k"].append({"role": role, "group_id": original["id"], "label": original["label"],
                        "k": list(k) if usable else [], "weighted_chi": list(chi) if usable else [],
                        "kweight": cached.get("effective", {}).get("kweight", original["parameters"]["kweight"]) if usable else None,
                        "error": None if usable else "The saved input has no usable processed chi(k). Repair its recipe to plot it in k space."})
                try:
                    processed = process_spectrum(result["energy"], result["difference"],
                        self._difference_parameters(parent, result),
                        data_type="mu" if choice.renormalize else "norm")
                    arrays = processed["arrays"]
                    if not arrays["k"] or not arrays["weighted_chi"]:
                        raise ValueError("The difference has no usable EXAFS interval with this recipe.")
                    result.update(k=arrays["k"], weighted_chi=arrays["weighted_chi"],
                                  kweight=processed["effective"]["kweight"])
                except (ValueError, TypeError, KeyError) as exc:
                    result["k_error"] = str(exc)
        # An edit during an expensive preview must not become a current result.
        self.check(self.load(ident), request.version)
        return {"version": project["version"], "options": choice.model_dump(), "results": results}

    def analyze(self, ident, request: Command):
        p = self.load(ident)
        self.check(p, request.version)
        groups = [self.group(p, gid) for gid in request.group_ids]
        o = request.options
        if request.action == "log_ratio":
            from larch import Group
            from larch.xafs import xftr
            from .athena_operations import log_ratio
            from .athena_science import _larch_window
            if len(groups) != 2 or not all(g["result"] and g["result"]["arrays"]["r"] for g in groups):
                fail("Choose two processed EXAFS groups: target first, reference second.")
            keys = ("e0", "kmin", "kmax", "dk", "window", "kweight", "rmin", "rmax", "dr", "rwindow", "nfft", "kstep")
            if any(groups[0]["result"]["effective"].get(k) != groups[1]["result"]["effective"].get(k) for k in keys):
                fail("Log-ratio analysis requires the same E₀, FT and shell-filter windows for both groups. Set explicit common limits first.")
            filtered = []
            window_warnings = []
            for g in groups:
                a, params = g["result"]["arrays"], g["parameters"]
                out = Group()
                chir = np.asarray(a["chir_re"]) + 1j * np.asarray(a["chir_im"])
                xftr(np.asarray(a["r"]), chir, group=out, rmin=params["rmin"], rmax=params["rmax"], dr=params["dr"],
                     window=_larch_window(params["rwindow"], params["dr"], window_warnings), nfft=params["nfft"], kstep=params["kstep"], qmax_out=min(g["result"]["effective"]["available_kmax"] for g in groups))
                filtered.append(out)
            opts = {key: value for key, value in o.items() if key in ("kmin", "kmax", "amplitude_min", "phase_offset", "fit_cumulants", "max_cumulant")}
            result = log_ratio(filtered[0].q, filtered[1].chiq, filtered[0].chiq, opts)
            result.setdefault("warnings", []).extend(window_warnings)
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
            args.update({"label": g["label"], "datatype": "xmu" if g["data_type"] in ("mu", "norm") else g["data_type"],
                    "is_xmu": int(g["data_type"] in ("mu", "norm", "xmudat")),
                    "is_xmudat": int(g["data_type"] == "xmudat"),
                    "is_xanes": int(g["data_type"] == "xanes"),
                    "is_nor": int(g.get("is_normalized", g["data_type"] in ("norm", "xmudat")) or (_is_difference(g) and g["data_type"] != "chi")),
                    "is_chi": int(g["data_type"] == "chi"), "marked": int(g["marked"]), "frozen": int(g["frozen"]),
                    "plot_scale": g["multiplier"], "plot_yoffset": g["offset"], "bkg_flatten": int(params["flatten"]),
                    "is_diff": int(_is_difference(g)),
                    "annotation": g["notes"], "referencegroup": g["reference_id"] or "",
                    "bkg_stan": g.get("background_standard_id") or ""})
            identity = _source_edge_identity(source)
            if source.get('rebin') or source.get('operation') == 'rebin':
                args['rebinned'] = 1
            if identity:
                args.update(bkg_z=identity["element"], fft_edge=identity["edge"])
            fraction = source.get("e0_fraction")
            if isinstance(fraction, (int, float)) and not isinstance(fraction, bool) and 0 < fraction <= 1:
                args["bkg_e0_fraction"] = fraction
            for key, target in _PARAMETER_MAP.items():
                value = params.get(key)
                if value is None:
                    value = effective.get("edge_step" if key == "step" else key)
                if value is not None:
                    if key == "nnorm" and isinstance(value, (int, float)) and not isinstance(value, bool):
                        # Keep the web sidecar in degrees; independent Athena
                        # readers receive the corresponding number of terms.
                        value += 1
                    args[target] = value
                    if target in _NATIVE_ALIASES:
                        args[_NATIVE_ALIASES[target]] = value
            args["bkg_fixstep"] = int(params["step"] is not None)
            merge = source.get('merge')
            if isinstance(merge,dict) and merge.get('details',{}).get('method')=='demeter-larch':
                args['is_merge'] = {'mu':'e','norm':'n','chi':'k'}[merge['details']['array']]
            if 'alignment' in source or 'bkg_delta_eshift' in args:
                from .athena_alignment import saved_fit
                alignment = saved_fit(g)
                args['bkg_delta_eshift'] = (alignment.get('native_shift_stderr') or 0.) if alignment else 0.
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
            from .athena_xdi import project_statement
            try:
                xdi_statement = project_statement(source, identity)
            except (ValueError, TypeError, KeyError) as exc:
                fail(f"{g['label']}: XDI acquisition metadata could not be exported: {exc}")
            if xdi_statement:
                lines.append(xdi_statement)
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
            meta["is_difference"] = _is_difference(g)
            meta["data_type"] = g["data_type"]
            meta["is_normalized"] = g.get("is_normalized", g["data_type"] in ("norm", "xmudat"))
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
        # Larch's own writer uses a Demeter header but stores nnorm as degree.
        # A Demeter header mentioning its Larch backend is a different case.
        larch_writer = any(line.startswith("# Using Larch version ") for line in text.splitlines()[:4])
        if text.lstrip().startswith("{"):
            document = _project_json(text)
            larch_writer = any(isinstance(document.get(f"_____header{i}"), str)
                               and document[f"_____header{i}"].startswith("# Using Larch version ")
                               for i in range(1, 5))
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
                normalized = record.get("is_normalized", dtype in ("norm", "xmudat"))
                if not isinstance(normalized, bool):
                    fail("The normalized input flag must be boolean.")
                is_difference = _is_difference(record)
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
                    params = _native_parameters(args, larch_writer=larch_writer)
                    if larch_writer:
                        source["native"]["producer"] = "larch"
                dtype = next((kind for kind, key in (("xmudat", "is_xmudat"), ("chi", "is_chi"), ("xanes", "is_xanes"), ("norm", "is_nor"))
                              if _native_flag(args.get(key))), {"chi": "chi", "xanes": "xanes", "xmudat": "xmudat"}.get(args.get("datatype"), "mu"))
                if args.get('datatype') == 'xmudat':
                    # is_nor is also true for FEFF data; it must not erase the
                    # specific type in native records that use datatype alone.
                    dtype = 'xmudat'
                elif args.get('datatype') in ('xanes', 'detector'):
                    dtype = args['datatype']
                normalized = dtype not in ("chi", "detector") and (_native_flag(args.get("is_nor")) or dtype in ("norm", "xmudat"))
                is_difference = _native_flag(args.get("is_diff"))
                if "is_difference" in meta and _is_difference(meta) != is_difference:
                    fail("Native and web-sidecar difference-spectrum flags disagree.")
                if is_difference and dtype != "detector":
                    # is_nor is independent of the native xmu/xanes type. A
                    # signed XANES difference must retain both flags on exchange.
                    if _native_flag(args.get("is_xanes")):
                        dtype = "xanes"
                    elif _native_flag(args.get("is_xmu")):
                        dtype = "mu"
                    source.setdefault("operation", "difference")
                if "data_type" in meta:
                    # Native xmu/is_nor plus is_diff cannot distinguish the
                    # web's mu/norm difference categories. The sidecar retains
                    # that distinction, but must not reinterpret a native axis.
                    native_family = lambda kind: "xmu" if kind in ("mu", "norm") else kind
                    if native_family(meta["data_type"]) != native_family(dtype):
                        fail("Native and web-sidecar data types disagree.")
                    dtype = meta["data_type"]
                if "is_normalized" in meta:
                    flag = meta["is_normalized"]
                    if not isinstance(flag, bool) or (flag != normalized and not is_difference):
                        fail("Native and web-sidecar normalized input flags disagree.")
                    normalized = flag
                label = args.get("label", old_id)
                notes = str(meta.get("notes", args.get("annotation", "")))
                reference = meta.get("reference_id", args.get("referencegroup", args.get("reference")))
                standard = meta.get("background_standard_id", args.get("bkg_stan"))
                if "background_standard_id" not in meta and standard in ("None", "none"):
                    standard = None
                marked = _native_flag(args.get("marked", args.get("project_marked")), True)
                frozen = _native_flag(args.get("frozen"))
                multiplier, offset = args.get("plot_scale", 1), args.get("plot_yoffset", 0)
                if "parameters" not in meta:
                    _native_processing_limits(params, x, dtype, source)
            if dtype not in ("mu", "norm", "xanes", "chi", "xmudat", "detector"):
                fail("Unsupported data type in project.")
            if (dtype in ("chi", "detector") and normalized) or (dtype in ("norm", "xmudat") and not normalized):
                fail("The normalized input flag disagrees with the data type.")
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
                recipe_error = ("Dormant detector settings need repair before absorption processing: " if dtype == "detector" else
                                "Native processing settings need repair: ") + str(exc)
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
                                "is_difference": is_difference, "is_normalized": normalized,
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
                "is_difference": record["is_difference"], "is_normalized": record["is_normalized"],
                "notes": record["notes"][:20_000], "result": None, "processing_error": record["recipe_error"],
                **{key: record[key] for key in ("marked", "frozen", "multiplier", "offset", "reference_id", "background_standard_id")}}

    def preview_project(self, ident, data, filename, *, prepared=None):
        self.load(ident)
        filename = Path(filename.replace("\\", "/")).name[:255] or "project.prj"
        from .athena_file_plugins import prepare_file, PreparedProject
        if prepared is None:
            prepared = prepare_file(data, max_bytes=self.settings.max_upload_bytes,
                max_points=self.settings.max_points, max_columns=self.settings.max_columns,
                enabled=AthenaPreferences(self.settings).read_plugins()['enabled'],
                read_configuration=self.plugin_configurations.read,
                                read_dispersive=lambda: AthenaPreferences(self.settings).read_dispersive()['coefficients'])
        original = None
        if isinstance(prepared, PreparedProject):
            original = data
            records = []
            for ordinal, group in enumerate(prepared.groups, 1):
                label = f'{filename} - {group["label"]}' if group.get('prefix_filename') else group['label']
                records.append(dict(id=f'channel-{ordinal}', label=label, energy=group['energy'], mu=group['mu'],
                    data_type=group['data_type'], parameters=AthenaParameters().model_dump(),
                    source=group['source'] | {'filename': filename}, notes='', result=None,
                    is_normalized=False, is_difference=False, reference_id=None, background_standard_id=None,
                    marked=False, frozen=False, multiplier=1, offset=0))
            data = json.dumps(dict(format='athena-web', schema_version=1, version=0, name=filename,
                journal=prepared.journal, groups=records), allow_nan=False).encode()
        parsed = self._parse_project(data, filename)
        groups = []
        for record in parsed["groups"]:
            x, y = self._preview_samples(self._preview_raw_axis(record), record["mu"])
            groups.append({"id": record["old_id"], "label": str(record["label"])[:200],
                           "data_type": record["data_type"], "points": len(record["energy"]),
                           "is_difference": record["is_difference"],
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
                if original is not None:
                    self.storage.write_bytes(ident, prefix + '.source', original)
                self.storage.write_json(ident, prefix + ".json", {"filename": filename,
                    **({'file_plugin': prepared.metadata} if original is not None else {})})
            except OSError:
                self.storage.path(ident, prefix + ".bin").unlink(missing_ok=True)
                self.storage.path(ident, prefix + '.source').unlink(missing_ok=True)
                raise
            cached = sorted(workspace.glob("project-upload-*.bin"), key=lambda path: path.stat().st_mtime_ns)
            def cached_size(path):
                source = path.with_suffix('.source')
                return path.stat().st_size + (source.stat().st_size if source.exists() else 0)
            size = sum(cached_size(path) for path in cached)
            while len(cached) > 10 or size > 2 * self.settings.max_upload_bytes:
                expired = cached.pop(0)
                size -= cached_size(expired)
                expired.unlink()
                expired.with_suffix(".json").unlink(missing_ok=True)
                expired.with_suffix('.source').unlink(missing_ok=True)
        return {"upload_id": upload_id, "filename": filename, "name": parsed["name"],
                "journal": parsed["journal"], "format": parsed["format"],
                "groups": groups, "warnings": parsed["warnings"],
                **({'file_plugin': prepared.metadata} if original is not None else {})}

    def project_upload_file(self, ident, upload_id, variant):
        self.storage._validate_id(upload_id)
        if variant not in ('source', 'converted'):
            fail('Choose source or converted project content.')
        with self.storage.lock(ident):
            self.load(ident)
            try:
                metadata = self.storage.read_json(ident, f'project-upload-{upload_id}.json')
                data = self.storage.path(ident, f'project-upload-{upload_id}.bin').read_bytes()
            except FileNotFoundError:
                fail('Project preview expired or belongs to another workspace; upload the file again.')
            filename = metadata['filename']
            source = self.storage.path(ident, f'project-upload-{upload_id}.source')
            if source.exists():
                if variant == 'source':
                    data = source.read_bytes()
                else:
                    filename = Path(filename).stem + '.athena.json'
            return data, filename

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
    preferences = AthenaPreferences(settings)

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

    @router.get('/preferences/rebin')
    def rebin_defaults():
        return guarded(preferences.read)

    @router.get('/preferences/smoothing')
    def smoothing_defaults():
        return guarded(store.smoothing_preferences.read)

    @router.put('/preferences/smoothing')
    def apply_smoothing_defaults(request: SGPreferenceRequest):
        return guarded(lambda: store.smoothing_preferences.apply(request))

    @router.put('/preferences/rebin')
    def save_rebin_defaults(request: RebinDefaults):
        return guarded(lambda: preferences.save(request))

    @router.get('/preferences/plugins')
    def file_plugins():
        return guarded(lambda: registry_view(preferences.read_plugins()))

    @router.get('/preferences/beamline')
    def beamline_defaults():
        return guarded(preferences.read_beamline)

    @router.put('/preferences/beamline')
    def save_beamline_defaults(request: BeamlineDefaults):
        return guarded(lambda: preferences.save_beamline(request))

    @router.get('/preferences/plugins/{reader}/configuration')
    def file_plugin_configuration(reader: str):
        return guarded(lambda: store.plugin_configurations.read(reader))

    @router.put('/preferences/plugins/{reader}/configuration')
    def apply_file_plugin_configuration(reader: str, request: ConfigurationRequest):
        return guarded(lambda: store.plugin_configurations.apply(reader, request))

    @router.put('/preferences/plugins')
    def save_file_plugins(request: PluginRegistry):
        return guarded(lambda: registry_view(preferences.save_plugins(request)))

    @router.get('/preferences/plugins/export')
    def export_file_plugins():
        return Response(guarded(lambda: encode_registry(preferences.read_plugins())), media_type='application/x-yaml',
                        headers={'Content-Disposition': 'attachment; filename="athena.plugin_registry"'})

    @router.post('/preferences/plugins/import')
    async def import_file_plugins(version: int = Query(ge=0), file: UploadFile = File(...)):
        data = await _read_bounded_upload(file, MAX_REGISTRY_BYTES)
        return guarded(lambda: registry_view(preferences.save_plugins(PluginRegistry(version=version, enabled=decode_registry(data)))))

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

    @router.post('/projects/{ident}/dispersive/inspect')
    async def inspect_dispersive(ident: str,file: UploadFile=File(...)):
        data=await _read_bounded_upload(file,settings.max_upload_bytes)
        return guarded(lambda: store.inspect_dispersive(ident,data,file.filename or 'pixels.dat'))

    @router.post('/projects/{ident}/dispersive/make')
    def make_dispersive(ident: str,request: DispersiveRequest):
        return guarded(lambda: store.make_dispersive(ident,request))

    @router.post('/projects/{ident}/dispersive/{action}')
    def dispersive(ident: str,action: Literal['columns','preview','guess','refine'],request: DispersiveRequest):
        return guarded(lambda: store.dispersive(ident,request,action))

    @router.get('/preferences/dispersive')
    def dispersive_defaults():
        return guarded(lambda: AthenaPreferences(settings).read_dispersive())

    @router.put('/preferences/dispersive')
    def save_dispersive_defaults(request: DispersiveDefaults):
        return guarded(lambda: AthenaPreferences(settings).save_dispersive(request))

    @router.get('/preferences/dispersive/file')
    def dispersive_file():
        from .athena_dispersive import encode_calibration
        content=guarded(lambda: encode_calibration(AthenaPreferences(settings).read_dispersive()['coefficients']))
        return Response(content,media_type='application/x-yaml',headers={'Content-Disposition':'attachment; filename="athena.dxas"'})

    @router.post('/preferences/dispersive/import')
    async def import_dispersive_defaults(version: int=Query(...,ge=0),file: UploadFile=File(...)):
        from .athena_dispersive import decode_calibration
        data=await _read_bounded_upload(file,4096)
        return guarded(lambda: AthenaPreferences(settings).save_dispersive(DispersiveDefaults(version=version,coefficients=decode_calibration(data))))

    @router.post("/projects/{ident}/import")
    def import_data(ident: str, request: ImportRequest):
        return guarded(lambda: store.import_data(ident, request))

    @router.get('/projects/{ident}/uploads/{upload_id}/inspection')
    def inspected_columns(ident: str, upload_id: str):
        return guarded(lambda: store.inspected_columns(ident, upload_id))

    @router.get('/projects/{ident}/uploads/{upload_id}/file')
    def inspected_file(ident: str, upload_id: str, variant: Literal['source', 'converted'] = 'source'):
        content, name = guarded(lambda: store.inspected_file(ident, upload_id, variant))
        return Response(content, media_type='application/octet-stream',
                        headers={'Content-Disposition': f'attachment; filename="{name}"'})

    @router.post("/projects/{ident}/preview-columns")
    def preview_columns(ident: str, request: ImportRequest):
        return guarded(lambda: store.preview_columns(ident, request))

    @router.get('/projects/{ident}/archives/{upload_id}/members/{member_index}')
    def archive_member(ident: str, upload_id: str, member_index: int):
        content, name = guarded(lambda: store.archive_member(ident, upload_id, member_index))
        return Response(content, media_type='application/octet-stream',
                        headers={'Content-Disposition': f'attachment; filename="{name}"'})

    @router.post("/projects/{ident}/command")
    def command(ident: str, request: Command):
        return guarded(lambda: store.command(ident, request))

    @router.get('/projects/{ident}/groups/{group_id}/xdi')
    def xdi_metadata(ident: str, group_id: str):
        return guarded(lambda: store.xdi_metadata(ident, group_id))

    @router.post('/projects/{ident}/groups/{group_id}/xdi/validate')
    def validate_xdi(ident: str, group_id: str, request: XDIValidation):
        return guarded(lambda: store.validate_xdi(ident, group_id, request))

    @router.post("/projects/{ident}/analyze")
    def analyze(ident: str, request: Command):
        return guarded(lambda: store.analyze(ident, request))

    @router.post("/projects/{ident}/difference/preview")
    def preview_difference(ident: str, request: Command):
        return guarded(lambda: store.preview_difference(ident, request))

    @router.post('/projects/{ident}/rebin/preview')
    def preview_rebin(ident: str, request: Command):
        return guarded(lambda: store.preview_rebin(ident, request))

    @router.post('/projects/{ident}/mee/preview')
    def preview_mee(ident: str, request: Command):
        return guarded(lambda: store.preview_mee(ident, request))

    @router.post('/projects/{ident}/point-edit/preview')
    def preview_point_edit(ident: str, request: Command):
        return guarded(lambda: store.preview_point_edit(ident, request))

    @router.get('/preferences/merge')
    def merge_preferences():
        return guarded(lambda:store.preferences.read_merge())

    @router.put('/preferences/merge')
    def save_merge_preferences(request: dict):
        return guarded(lambda:store.preferences.save_merge(request))

    @router.post('/projects/{ident}/merge/preview')
    def preview_merge(ident: str,request: Command):
        return guarded(lambda:store.preview_merge(ident,request))

    @router.post('/projects/{ident}/alignment/preview')
    def preview_alignment(ident: str, request: Command):
        return guarded(lambda: store.preview_alignment(ident, request))

    @router.post('/projects/{ident}/calibration/preview')
    def preview_calibration(ident: str, request: Command):
        return guarded(lambda: store.preview_calibration(ident, request))

    @router.post('/projects/{ident}/calibration/zero')
    def calibration_zero(ident: str, request: Command):
        return guarded(lambda: store.preview_calibration(ident, request, find_zero=True))

    @router.post('/projects/{ident}/convolve/preview')
    def preview_convolution(ident: str, request: Command):
        return guarded(lambda: store.preview_convolution(ident, request))

    @router.post('/projects/{ident}/smooth/preview')
    def preview_smoothing(ident: str, request: Command):
        return guarded(lambda: store.preview_smoothing(ident, request))

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

    @router.get('/projects/{ident}/preview-project/{upload_id}/file')
    def project_upload_file(ident: str, upload_id: str, variant: Literal['source', 'converted'] = 'source'):
        data, filename = guarded(lambda: store.project_upload_file(ident, upload_id, variant))
        from urllib.parse import quote
        return Response(data, media_type='application/octet-stream',
            headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quote(filename, safe='')}"})

    @router.post("/projects/{ident}/restore-upload")
    def restore_upload(ident: str, request: RestoreUploadRequest):
        return guarded(lambda: store.restore_upload(ident, request))

    @router.get("/projects/{ident}/export")
    def export(ident: str, format: Literal["json", "prj"] = "json",
               group_ids: list[str] | None = Query(default=None), marked_only: bool = False):
        content = guarded(lambda: store.export_project(ident, format, group_ids, marked_only))
        return Response(content, media_type="application/octet-stream" if format == "prj" else "application/json",
                        headers={"Content-Disposition": f'attachment; filename="athena-project.{format}"'})

    @router.post('/projects/{ident}/parameter-report/preview')
    def parameter_report_preview(ident: str, request: ParameterReport):
        return guarded(lambda: store.parameter_report(ident, request))

    @router.post('/projects/{ident}/parameter-report')
    def parameter_report(ident: str, request: ParameterReport):
        filename, media_type, content = guarded(lambda: store.parameter_report(ident, request, download=True))
        return Response(content, media_type=media_type, headers={
            'Content-Disposition': f'attachment; filename="{filename}"',
            'X-Athena-Project-Version': str(request.version)})

    @router.post('/projects/{ident}/export-data/preview')
    def preview_data_export(ident: str, request: DataExport):
        return guarded(lambda: store.preview_data_export(ident, request))

    @router.post('/projects/{ident}/export-data')
    def export_data(ident: str, request: DataExport):
        filename, media_type, content = guarded(lambda: store.export_data(ident, request))
        return Response(content, media_type=media_type, headers={
            'Content-Disposition': f'attachment; filename="{filename}"',
            'X-Athena-Project-Version': str(request.version)})

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
                merge = g['source'].get('merge',{})
                native_merge = g['source'].get('native',{}).get('args',{}).get('is_merge')
                if merge.get('details',{}).get('method')=='demeter-larch' or native_merge in ('e','n','k'):
                    scatter=g['source'].get('raw_arrays',{}).get('stddev')
                    if isinstance(scatter,list) and len(scatter)==len(output_x):
                        a['merge_stddev']=scatter;columns.append('merge_stddev')
                for key, label in (("stddev", "population_stddev"), ("uncertainty", "measurement_uncertainty")):
                    values = g["source"].get(key)
                    if isinstance(values, list) and len(values) == len(output_x):
                        a[label] = values
                        columns.append(label)
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["detector_signal" if key == "mu" and g["data_type"] == "detector" else key for key in columns])
        writer.writerows(zip(*(a[key] for key in columns), strict=True))
        return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="athena-{space}.csv"'})

    return router
