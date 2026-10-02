"""Scoped native Larix sessions for a saved single-spectrum EXAFS model.

Export only constructs native objects and serializes existing data. It never
runs background subtraction, Fourier transforms, model chi, or an optimizer.
"""
from __future__ import annotations

import ast
import copy
import gzip
import re
import string
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import larch
from larch import Group, Journal
from larch.io import save_session
from larch.xafs import feffit_transform

from .artemis import (
    _LARCH_LOCK, _PATH_NAMES, _PATH_PARAMETERS, _evaluate, _expression,
    _parameters, _read_path,
)
from .errors import WebInputError
from .artemis_disorder import canonical_expression


def _fail(message):
    raise WebInputError(
        "invalid_artemis_export", message, fields=("artemis",),
        recovery="Complete the saved model and process its EXAFS data, then retry. The web project retains unfinished drafts.",
    )


def _array(values, name, *, minimum=1):
    try:
        result = np.asarray(values, dtype=float)
        if result.ndim != 1 or len(result) < minimum or not np.isfinite(result).all():
            raise ValueError("Invalid array")
    except (TypeError, ValueError):
        _fail(f"Larix export requires finite {name} data.")
    return result.copy()


def compatibility_warnings(request):
    """Known limits of the bundled Larix FEFF GUI, not of native storage."""
    warnings = []
    weights = request.transform.kweight
    if weights not in ([1], [2], [3], [2, 3], [2, 1, 3]):
        warnings.append("The session preserves all selected k weights, but some Larix GUI versions replace this selection when rebuilding the model. Check k weights before fitting.")
    if request.transform.dr != 0:
        warnings.append("The session preserves the R-window taper dr, but some Larix GUI versions reset it when rebuilding the model. Check the transform before plotting back-transformed chi(k).")
    if any(getattr(request.transform, name) != round(getattr(request.transform, name), digits)
           for name, digits in (("kmin", 3), ("kmax", 3), ("rmin", 3), ("rmax", 3), ("dk", 4))):
        warnings.append("The session preserves exact fit ranges and tapers, but some Larix GUI versions round them when rebuilding the model. Check the transform before fitting.")
    if any(not path.enabled for path in request.paths):
        warnings.append("The session preserves disabled paths, but some Larix GUI versions enable them when opening the FEFF panel. Check path selections before fitting.")
    direct = set()
    for path in request.paths:
        if not path.enabled:
            continue
        for field in _PATH_PARAMETERS:
            try:
                direct.update(node.id for node in ast.walk(ast.parse(getattr(path, field), mode="eval")) if isinstance(node, ast.Name))
            except SyntaxError:
                pass  # The export validation below reports incomplete expressions.
    indirect = [parameter.name for parameter in request.parameters if parameter.kind == "guess" and parameter.name not in direct]
    if indirect:
        warnings.append("The session preserves Def constraints, but some Larix GUI versions fix Guess parameters used only through a Def expression. Check these parameters before fitting: " + ", ".join(indirect) + ".")
    if warnings:
        warnings.insert(0, f"Native model preserved; GUI compatibility checked against Larch {larch.__version__}.")
    return warnings


def _native_data(group):
    arrays = (group.get("result") or {}).get("arrays") or {}
    if group.get("processing_error") or group.get("data_type") in ("detector", "xanes"):
        _fail("Process an EXAFS spectrum successfully before exporting a Larix session.")
    k, chi = (_array(arrays.get(name, []), name, minimum=20) for name in ("k", "chi"))
    if k.shape != chi.shape or k[0] < 0 or not np.all(np.diff(k) > 0):
        _fail("Larix export requires matching, increasing k and chi(k) arrays.")
    groupname = "artemis_" + re.sub(r"[^A-Za-z0-9_]", "_", group["id"])
    data = Group(groupname=groupname, filename=group["label"], k=k, chi=chi,
                 title=group["label"], is_frozen=True,
                 journal=Journal(source_desc=group["label"], source="Artemis web model export"))
    # Retain the measured source independently of the processed energy axis.
    # chi imports use Athena's energy/mu storage slots for k/chi, not eV/mu.
    measured_x = _array(group.get("energy", []), "measured coordinates", minimum=20)
    measured_y = _array(group.get("mu", []), "measured signal", minimum=20)
    if measured_x.shape != measured_y.shape:
        _fail("The measured coordinates and signal have different lengths.")
    if group.get("data_type") == "chi":
        data.datatype = "xydata"
        data.xdat, data.ydat = k.copy(), chi.copy()
        data.xplot, data.yplot = k.copy(), chi.copy()
        data.plot_xlabel, data.plot_ylabel = "k (1/Angstrom)", "chi(k)"
        data.raw = Group(k=measured_x, chi=measured_y)
    else:
        data.datatype = "xas"
        data.raw = Group(energy=measured_x, mu=measured_y)
        for name in ("energy", "mu", "norm", "flat", "pre_edge", "post_edge", "bkg", "dmude", "d2mude"):
            if len(arrays.get(name, [])):
                setattr(data, name, _array(arrays[name], name))
        if not hasattr(data, "energy") or not hasattr(data, "mu"):
            _fail("The processed spectrum has no energy or absorption arrays.")
        if len(data.energy) != len(data.mu):
            _fail("The processed energy and absorption arrays have different lengths.")
        data.xdat = data.xplot = data.energy.copy()
        data.ydat = data.yplot = data.mu.copy()
        data.energy_units = "eV"
        data.energy_orig = data.energy.copy()
        data.energy_shift = 0.0  # The saved processed axis already includes its shift.
        data.plot_xlabel, data.plot_ylabel = "Energy (eV)", "mu(E)"
        effective = (group.get("result") or {}).get("effective") or {}
        for name in ("e0", "edge_step", "rbkg"):
            value = effective.get(name)
            if value is not None and np.isfinite(value):
                setattr(data, name, float(value))
    data.raw.data_type = group["data_type"]
    for name in ("is_normalized", "is_difference"):
        if name in group:
            setattr(data.raw, name, group[name])
    for name, values in (group.get("source", {}).get("raw_arrays") or {}).items():
        setattr(data.raw, name, _array(values, name))
    return data


def _path_title(path, existing):
    """Match Larix FeffitPanel.add_path's geometry-derived cache keys."""
    atoms = [f"[{item[0]}]" if item[2] == 0 else item[0] for item in path.geom]
    title = "_".join(atoms) + str(round(100 * path.reff))
    for char in ',.[](){}<>+=-?/\\&%$#@!|:;"\'':
        title = title.replace(char, "")
    if title in existing:
        base = title
        for suffix in string.ascii_lowercase:
            title = f"{base}_{suffix}"
            if title not in existing:
                break
    return title


class _SubstituteDegeneracy(ast.NodeTransformer):
    def __init__(self, value):
        self.value = value

    def visit_Name(self, node):
        return ast.copy_location(ast.Constant(self.value), node) if node.id == "degen" else node


def _gui_config(transform):
    window = {"hanning": "Hanning", "kaiser": "Kaiser-Bessel", "parzen": "Parzen", "welch": "Welch"}[transform.window]
    weights = transform.kweight
    return {"fit_space": transform.fitspace, "fit_kmin": transform.kmin,
            "fit_kmax": transform.kmax, "fit_dk": transform.dk,
            "fit_kwindow": window, "fit_kwstring": str(weights[0]) if len(weights) == 1 else str(weights),
            "fit_rmin": transform.rmin, "fit_rmax": transform.rmax,
            "fit_dr": transform.dr, "fit_rwindow": "Hanning", "refine_bkg": False}


class FeffPathGroup:
    """Select Larch's supported stateful path serialization, by native type name.

    This adapter is deliberately not a larch.Group. The current encode4js
    checks Group before __getstate__, and its generic FeffPathGroup decoder
    rereads filename even when embedded FEFF data exists. The native stateful
    decoder instead calls FeffPathGroup.__setstate__, restoring all FEFF arrays
    without disk access. No adapter is needed on the receiving side.
    """
    def __init__(self, path):
        self.state = path.__getstate__()

    def __getstate__(self):
        return self.state


def export_larix(group, version):
    """Return native session bytes and explicit GUI compatibility notices."""
    # Lazy import avoids a cycle with the persistence router.
    from .artemis_persistence import request_from_model

    model = (group.get("artemis") or {}).get("model")
    if model is None:
        _fail("This spectrum has no saved EXAFS model to export.")
    try:
        request = request_from_model(model, version)
    except (ValueError, TypeError) as exc:
        _fail(f"Complete the model before exporting a Larix session: {exc}")
    if not any(path.enabled for path in request.paths):
        _fail("Enable at least one FEFF path before exporting a Larix session.")
    data = _native_data(group)
    warnings = compatibility_warnings(request)
    if data.datatype == "xas":
        warnings.append("Processed chi(k) is preserved as a snapshot. Reprocessing in Larix uses its own background settings; the web processing recipe is retained as metadata, not translated into a Larix recipe.")
    if group.get("artemis", {}).get("history"):
        warnings.append("This session contains the current model and data. Saved web fit results remain in the web project and are not exported as native Larix fit history.")
    with _LARCH_LOCK, tempfile.TemporaryDirectory(prefix="artemis-export-") as directory:
        # This validates the bounded numeric expression grammar and builds
        # editable lmfit Parameters; no model curve or fit is evaluated.
        try:
            parameters, values, _ = _parameters(request)
        except WebInputError as exc:
            _fail(f"Complete the model before exporting a Larix session: {exc}")
        paths, path_ids = {}, {}
        for index, definition in enumerate(request.paths):
            path, metadata = _read_path(definition, Path(directory), index)
            title = _path_title(path, paths)
            path.label = title
            # Larix uses degeneracy=1 and includes N in its amplitude field.
            # Adopt that equivalent representation so GUI cache reconstruction
            # cannot drop or double the FEFF degeneracy. Substitute the `degen`
            # symbol first to retain its original meaning in every expression.
            for field in _PATH_PARAMETERS:
                tree, _ = _expression(getattr(definition, field), set(values) | _PATH_NAMES,
                                      f"{definition.label or definition.id}.{field}", allow_disorder=field == "sigma2")
                _evaluate(tree, values | {name: metadata[name] for name in _PATH_NAMES}, field, path=path)
                expression = canonical_expression(ast.unparse(_SubstituteDegeneracy(metadata["degen"]).visit(tree)))
                setattr(path, field, f"{metadata['degen']!r} * ({expression})" if field == "s02" else expression)
            path.degen = 1.0
            path.use = definition.enabled
            path.third = path.fourth = path.ei = "0"
            # The complete FeffDatFile state is embedded by native serialization.
            # Keep only a logical filename, never the temporary server path.
            path.filename = path._feffdat.filename = f"artemis/feff{index:04d}.dat"
            path.feffrun = "artemis"
            paths[title] = path
            path_ids[title] = definition.id
        options = request.transform.model_dump()
        if len(options["kweight"]) == 1:
            options["kweight"] = options["kweight"][0]
        transform = feffit_transform(**options, kstep=0.05, nfft=2048, rwindow="hanning")
        stored_paths = {name: FeffPathGroup(path) for name, path in paths.items()}
        data.feffit_model = (stored_paths, parameters, transform)
        data.config = Group(feffit=_gui_config(request.transform))
        data.artemis_export = {"schema_version": 1, "model": copy.deepcopy(model),
            "group_id": group["id"], "project_version": version,
            "larch_version": larch.__version__, "path_ids": path_ids,
            "processing_parameters": copy.deepcopy(group.get("parameters", {})),
            "warnings": warnings,
            "notes": "Measured source arrays are in raw. chi(k) is the saved processed data. FEFF degeneracy is included in the native amplitude expression. Web fit history is not a native Larix fit history."}
        # Supply a minimal symbol table: no interpreter environment, session
        # history, unrelated groups, configuration files, or startup commands.
        symbols = Group(_sys=Group(core_groups=["_sys"], config=Group()),
                        _xasgroups={data.filename: data.groupname},
                        _feffcache={"paths": stored_paths, "runs": {}},
                        _feffpaths=stored_paths)
        setattr(symbols, data.groupname, data)
        output = Path(directory) / "model.larix"
        save_session(str(output), symbols=[data.groupname, "_feffcache", "_feffpaths"],
                     histbuff=[], _larch=SimpleNamespace(symtable=symbols))
        # Native save_session always writes host identifiers. Omit those
        # optional comments from a downloadable scientific exchange file.
        text = gzip.decompress(output.read_bytes()).decode("utf-8")
        text = "\n".join(line for line in text.split("\n")
                         if not line.startswith(("##Machine ", "##Python ")))
        return gzip.compress(text.encode("utf-8"), mtime=0), warnings
