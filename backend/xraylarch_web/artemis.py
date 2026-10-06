"""Artemis-style, single-dataset FEFF fitting with the native Larch core.

FEFF files are supplied as contents, never as server paths. Fits are read-only
snapshots of processed Athena chi(k); no processing recipe is changed.
"""
from __future__ import annotations

import ast
import hashlib
import keyword
import math
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, Union

import numpy as np
from fastapi import APIRouter, Query
from larch import Group
from larch.fitting import ParameterGroup, param, param_group
from larch.xafs import feffit, feffit_dataset, feffit_report, feffit_transform, feffpath
from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, model_validator

from .errors import WebInputError
from .artemis_disorder import DISORDER_FUNCTIONS, evaluate_disorder, prepare_disorder_dataset, runtime_expression

_LARCH_LOCK = threading.RLock()
_EXAMPLE = Path(__file__).parent / "resources" / "artemis" / "feffcu01.dat"
_CUPRITE_EXAMPLE = Path(__file__).parent / "resources" / "artemis" / "cuprite_15851"
_CUPRITE_RESOURCE_SHA256 = {
    "source.cif": "3211a84a3d7bd18a72d171ee0b4e1cb6615c6770979db0ae04252b51e2d0c994",
    "feff.inp": "6f44c00340b6f5e745552c322bb3d033e2c25dd58b24a7d95c39cdf972e994e4",
    "feff0001.dat": "4a8f3aec51d3574656f82ecfcb4e9118e33ccd1b70571c61b4be2e5c191036cd",
    "feff0002.dat": "b6b3ff362105459a8d120458baeadf5b30f8d4c9dc88efe77e0a8e96b2e16937",
    "feff0003.dat": "4ba837f299673304b411d26a4d9b7cf0d1031812acc98179a17b7490b807c75e",
    "feff0004.dat": "0156612dee62d0242f161c0e4c920a168ef2dff829ff8411a20ece25556aea6b",
}
_FUNCTIONS = {name: getattr(math, name) for name in ("sqrt", "exp", "log", "sin", "cos", "tan")}
_FUNCTIONS["abs"] = abs
_CONSTANTS = {"pi": math.pi, "e": math.e}
_PATH_NAMES = {"reff", "degen", "nleg"}
_RESERVED = set(_FUNCTIONS) | DISORDER_FUNCTIONS | set(_CONSTANTS) | _PATH_NAMES | {
    "rmass", "rnorman", "gam_ch", "rs_int", "vint", "vmu", "vfermi", "feffpath",
    "True", "False", "None", "nan", "inf", "skip",
}
_RESERVED.update(name for name in dir(ParameterGroup) if not name.startswith("_"))
_PATH_PARAMETERS = ("s02", "e0", "deltar", "sigma2")
PREVIEW_KMAX = 20.0


def _fail(message: str, field: str = "fit"):
    raise WebInputError("invalid_artemis_fit", message, fields=(field,),
                        recovery="Review the FEFF paths, GDS parameters, and fitting ranges, then retry.")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class PathInput(StrictModel):
    filename: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=500_000)

    @model_validator(mode="after")
    def safe_filename(self):
        if (self.filename in (".", "..") or "/" in self.filename or "\\" in self.filename
                or any(ord(char) < 32 for char in self.filename)):
            raise ValueError("Use a file name without directories or control characters.")
        if "\x00" in self.content:
            raise ValueError("FEFF contents must be plain text.")
        return self


class PathSettings(StrictModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    label: str = Field(default="", max_length=120)
    enabled: bool = True
    s02: str = Field(default="amp", max_length=256)
    e0: str = Field(default="del_e0", max_length=256)
    deltar: str = Field(default="del_r", max_length=256)
    sigma2: str = Field(default="sig2", max_length=256)


class FitPath(PathInput, PathSettings):
    pass


class FeffJobPath(PathSettings):
    """A path named by the FEFF job that made it, so its file need not travel back.

    Only the fit route takes these. A saved model keeps the file text, because a
    job is deleted after 24 hours and the model has to outlive it.
    """
    feff_job: str = Field(pattern=r"^[0-9a-f]{32}$", description="a FEFF job id, complete and under 24 hours old")
    feff_path: str = Field(pattern=r"^feff[0-9]{4}$", description="one of that job's paths[].id, such as feff0001")


class FitParameter(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
    kind: Literal["guess", "set", "def"] = "guess"
    value: float = 0
    expression: str = Field(default="", max_length=256)
    min: float | None = None
    max: float | None = None

    @model_validator(mode="after")
    def valid_definition(self):
        if self.name in _RESERVED or keyword.iskeyword(self.name):
            raise ValueError("This name is reserved for mathematical or FEFF symbols.")
        if self.kind == "def":
            if not self.expression.strip():
                raise ValueError("A Def parameter requires an expression.")
            if self.min is not None or self.max is not None:
                raise ValueError("Bounds apply to Guess parameters, not Def expressions.")
        else:
            if self.expression.strip():
                raise ValueError("Only Def parameters can have an expression.")
            if self.min is not None and self.max is not None and self.min >= self.max:
                raise ValueError("Minimum must be less than maximum.")
            if (self.min is not None and self.value < self.min) or (self.max is not None and self.value > self.max):
                raise ValueError("The initial value must be within its bounds.")
        return self


class FitTransform(StrictModel):
    fitspace: Literal["k", "r"] = "r"
    kmin: float = Field(default=3, ge=0, le=50)
    kmax: float = Field(default=12, gt=0, le=50)
    kweight: list[int] = Field(default_factory=lambda: [0, 1, 2, 3], min_length=1, max_length=4)
    dk: float = Field(default=2, ge=0, le=10)
    window: Literal["hanning", "kaiser", "parzen", "welch"] = "hanning"
    rmin: float = Field(default=1, ge=0, le=10)
    rmax: float = Field(default=3, gt=0, le=10)
    dr: float = Field(default=0, ge=0, le=5)

    @model_validator(mode="after")
    def ordered_ranges(self):
        # Decimal endpoints lose a few ulps on subtraction (4.1 - 3.1 < 1), as
        # in Athena's FT window check. Accept the minimum width itself.
        def narrower(width, minimum):
            return width < minimum and not np.isclose(width, minimum, rtol=1e-12, atol=1e-12)
        if narrower(self.kmax - self.kmin, 1) or narrower(self.rmax - self.rmin, 0.1):
            raise ValueError("Use a k interval of at least 1 inverse angstrom and an R interval of at least 0.1 angstrom.")
        if any(weight not in range(4) for weight in self.kweight) or len(set(self.kweight)) != len(self.kweight):
            raise ValueError("Select unique integer k weights between zero and three.")
        return self


class FitRequest(StrictModel):
    version: int = Field(ge=0)
    parameters: list[FitParameter] = Field(min_length=1, max_length=32)
    paths: list[FitPath] = Field(min_length=1, max_length=24)
    transform: FitTransform = Field(default_factory=FitTransform)


class PathPreviewRequest(StrictModel):
    """What each path would contribute at the current starting values, with no fit.

    Every name a path expression uses must appear in `parameters`; nothing is
    assumed, so the preview shows the model the user actually typed.
    """

    parameters: list[FitParameter] = Field(default_factory=list, max_length=32)
    paths: list[FitPath] = Field(min_length=1, max_length=24)
    transform: FitTransform = Field(default_factory=FitTransform)


def _path_source(value) -> str:
    return "job" if isinstance(value, dict) and ("feff_job" in value or "feff_path" in value) else "file"


class FitRouteRequest(FitRequest):
    """The fit route's body: each path either carries its file or names a FEFF job's."""
    paths: list[Annotated[Union[Annotated[FitPath, Tag("file")], Annotated[FeffJobPath, Tag("job")]],
                          Discriminator(_path_source)]] = Field(min_length=1, max_length=24)

    def resolve(self, jobs) -> FitRequest:
        """Read each named path's file out of its job, once per job."""
        records, paths = {}, []
        for path in self.paths:
            if isinstance(path, FitPath):
                paths.append(path)
                continue
            if path.feff_job not in records:
                record = jobs.get(path.feff_job)
                if record["status"] != "complete":
                    _fail(f"FEFF job {path.feff_job} is {record['status']}, not complete; poll it until "
                          "status is 'complete'.", "feff_job")
                records[path.feff_job] = {item["id"]: item for item in record["paths"]}
            source = records[path.feff_job].get(path.feff_path)
            if source is None:
                _fail(f"FEFF job {path.feff_job} has no path {path.feff_path}; it has "
                      f"{', '.join(sorted(records[path.feff_job])) or 'none'}.", "feff_path")
            paths.append(FitPath(filename=source["filename"], content=source["content"],
                                 **path.model_dump(exclude={"feff_job", "feff_path"})))
        return FitRequest(version=self.version, parameters=self.parameters, paths=paths, transform=self.transform)


def _expression(expression: str, names: set[str], field: str, *, allow_disorder=False) -> tuple[ast.AST, set[str]]:
    """Allow a small numerical grammar before passing expressions to lmfit.

    In particular there are no attributes, indexing, collections, comprehensions,
    user functions, or statements. Exponents cannot grow as parameters change.
    """
    try:
        node = ast.parse(expression.strip(), mode="eval").body
    except (SyntaxError, RecursionError):
        _fail(f"{field}: enter a valid mathematical expression.", field)
    if sum(1 for _ in ast.walk(node)) > 80:
        _fail(f"{field}: the expression is too complex.", field)
    used: set[str] = set()

    def visit(value):
        if isinstance(value, ast.Constant) and type(value.value) in (int, float):
            if not math.isfinite(value.value) or abs(value.value) > 1e12:
                _fail(f"{field}: constants must be finite and at most 1e12.", field)
        elif isinstance(value, ast.Name) and value.id in names | set(_CONSTANTS):
            if value.id in names:
                used.add(value.id)
        elif isinstance(value, ast.UnaryOp) and isinstance(value.op, (ast.UAdd, ast.USub)):
            visit(value.operand)
        elif isinstance(value, ast.BinOp) and isinstance(value.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            if isinstance(value.op, ast.Pow):
                exponent = value.right
                if isinstance(exponent, ast.UnaryOp) and isinstance(exponent.op, (ast.USub, ast.UAdd)):
                    exponent = exponent.operand
                if (not isinstance(exponent, ast.Constant) or type(exponent.value) is not int
                        or abs(exponent.value) > 8):
                    _fail(f"{field}: powers require an integer exponent between -8 and 8.", field)
            visit(value.left)
            visit(value.right)
        elif (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
              and value.func.id in _FUNCTIONS and len(value.args) == 1 and not value.keywords):
            visit(value.args[0])
        elif (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
              and value.func.id in DISORDER_FUNCTIONS):
            if not allow_disorder:
                _fail(f"{field}: Debye/Einstein functions require a current FEFF path; use them directly in the path's sigma2 expression, not a global Def.", field)
            if len(value.args) != 2 or value.keywords:
                _fail(f"{field}: {value.func.id} takes exactly two arguments: sample temperature and characteristic temperature, both in K.", field)
            for argument in value.args:
                visit(argument)
        else:
            _fail(f"{field}: use parameter names, arithmetic, or sqrt/exp/log/sin/cos/tan/abs only.", field)
    visit(node)
    return node, used


def _evaluate(node: ast.AST, values: dict[str, float], field: str, *, path=None) -> float:
    def evaluate(value):
        if isinstance(value, ast.Constant):
            result = float(value.value)
        elif isinstance(value, ast.Name):
            result = values[value.id] if value.id in values else _CONSTANTS[value.id]
        elif isinstance(value, ast.UnaryOp):
            result = evaluate(value.operand) * (-1 if isinstance(value.op, ast.USub) else 1)
        elif isinstance(value, ast.Call):
            if value.func.id in DISORDER_FUNCTIONS:
                try:
                    result = evaluate_disorder(value.func.id, *(evaluate(arg) for arg in value.args), path)
                except ValueError as exc:
                    _fail(f"{field}: {exc}", field)
            else:
                result = _FUNCTIONS[value.func.id](evaluate(value.args[0]))
        else:
            left, right = evaluate(value.left), evaluate(value.right)
            if isinstance(value.op, ast.Add): result = left + right
            elif isinstance(value.op, ast.Sub): result = left - right
            elif isinstance(value.op, ast.Mult): result = left * right
            elif isinstance(value.op, ast.Div): result = left / right
            else: result = left ** right
        if not isinstance(result, (float, int)) or not math.isfinite(result) or abs(result) > 1e100:
            raise ValueError("nonfinite expression")
        return result
    try:
        return float(evaluate(node))
    except WebInputError:
        raise
    except (ValueError, ZeroDivisionError, OverflowError, KeyError):
        _fail(f"{field}: the expression is not finite at the initial parameter values.", field)


def _initial_values(parameters: list[FitParameter]):
    """Resolve every GDS name to its starting number, Def expressions included.

    Returns the definitions by name, those numbers, the evaluation order, and
    each Def's direct dependencies.
    """
    definitions = {item.name: item for item in parameters}
    if len(definitions) != len(parameters):
        _fail("GDS parameter names must be unique.", "parameters")
    trees, dependencies = {}, {}
    for item in parameters:
        if item.kind == "def":
            trees[item.name], dependencies[item.name] = _expression(item.expression, set(definitions), item.name)
    values = {item.name: item.value for item in parameters if item.kind != "def"}
    ordered = [item for item in parameters if item.kind != "def"]
    pending = set(trees)
    while pending:
        ready = [name for name in definitions if name in pending and dependencies[name] <= values.keys()]
        if not ready:
            _fail("Def parameters have a circular dependency.", "parameters")
        for name in ready:
            values[name] = _evaluate(trees[name], values, name)
            ordered.append(definitions[name])
            pending.remove(name)
    return definitions, values, ordered, dependencies


def _path_trees(paths: list[FitPath], names: set[str]):
    """Parse the four path-parameter expressions of every enabled path."""
    trees, used = {}, set()
    for path in paths:
        if not path.enabled:
            continue
        trees[path.id] = {}
        for field in _PATH_PARAMETERS:
            tree, references = _expression(getattr(path, field), names | _PATH_NAMES, f"{path.label or path.id}.{field}",
                                           allow_disorder=field == "sigma2")
            trees[path.id][field] = tree
            used.update(references - _PATH_NAMES)
    return trees, used


def _parameters(request: FitRequest):
    definitions, values, ordered, dependencies = _initial_values(request.parameters)
    path_trees, used = _path_trees(request.paths, set(definitions))
    while True:
        expanded = used | set().union(*(dependencies.get(name, set()) for name in used))
        if expanded == used:
            break
        used = expanded
    guesses = {item.name for item in request.parameters if item.kind == "guess"}
    if not guesses:
        _fail("Add at least one Guess parameter to fit.", "parameters")
    if guesses - used:
        _fail(f"Unused Guess parameters: {', '.join(sorted(guesses - used))}.", "parameters")
    n_independent = 1 + 2 * (request.transform.kmax - request.transform.kmin) * (request.transform.rmax - request.transform.rmin) / math.pi
    if len(guesses) >= n_independent:
        _fail(f"The model has {len(guesses)} variables but only {n_independent:.2f} independent points. Reduce variables or expand the fitting ranges.", "parameters")
    group = param_group()
    for item in ordered:
        options = {"vary": item.kind == "guess"}
        if item.kind == "def": options["expr"] = item.expression.strip()
        if item.min is not None: options["min"] = item.min
        if item.max is not None: options["max"] = item.max
        setattr(group, item.name, param(values[item.name], **options))
    return group, values, path_trees


def _read_path(source: PathInput, directory: Path, index: int = 0):
    # A generated filename means even unusual client names never select a path.
    filename = directory / f"feff{index:04d}.dat"
    filename.write_text(source.content.rstrip() + "\n", encoding="utf-8")
    try:
        path = feffpath(str(filename))
        native = path._feffdat
        data = np.asarray([native.k, native.real_phc, native.mag_feff, native.pha_feff,
                           native.red_fact, native.lam, native.rep], dtype=float)
        if (data.ndim != 2 or data.shape[0] != 7 or not 8 <= data.shape[1] <= 10000
                or not np.isfinite(data).all() or not np.all(np.diff(native.k) > 0)
                or native.k[0] < 0 or np.any(native.lam <= 0)
                or not 0 < native.reff <= 100 or not 0 < native.degen <= 100000
                or not 2 <= native.nleg <= 20 or len(native.geom) != native.nleg):
            raise ValueError("invalid FEFF data")
        geometry = [dict(atom=str(atom), ipot=int(ipot), x=float(x), y=float(y), z=float(z))
                    for atom, _, ipot, _, x, y, z in native.geom]
        if not np.isfinite([[atom[key] for key in ("x", "y", "z")] for atom in geometry]).all():
            raise ValueError("invalid geometry")
        metadata = dict(reff=float(native.reff), degen=float(native.degen), nleg=int(native.nleg),
                        absorber=str(path.absorber), edge=str(path.shell).split()[0], geometry=geometry,
                        kmin=float(native.k[0]), kmax=float(native.k[-1]))
    except Exception as exc:
        raise WebInputError("invalid_feff_path", f"{source.filename}: this is not a usable FEFF feffNNNN.dat scattering path.",
                            fields=("paths",), recovery="Upload the complete FEFF path file, including its header, geometry, and seven-column data.") from exc
    return path, metadata


def inspect_path(source: PathInput) -> dict:
    with _LARCH_LOCK, tempfile.TemporaryDirectory(prefix="artemis-path-") as directory:
        _, metadata = _read_path(source, Path(directory))
    return dict(filename=source.filename, content=source.content, metadata=metadata)


def copper_example() -> dict:
    source = PathInput(filename="feffcu01.dat", content=_EXAMPLE.read_text())
    parameters = [
        FitParameter(name="amp", value=1, min=0, max=2),
        FitParameter(name="del_e0", value=0, min=-30, max=30),
        FitParameter(name="del_r", value=0, min=-0.2, max=0.2),
        FitParameter(name="sig2", value=0.008, min=0, max=0.05),
    ]
    return dict(path=inspect_path(source), parameters=[item.model_dump() for item in parameters],
                transform=FitTransform(kmin=3, kmax=12, rmin=1.4, rmax=3).model_dump(),
                description="Cu metal first shell from Larch examples/feffit/feffcu01.dat: 12 Cu neighbors at Reff = 2.5478 Å. Use with a Cu K-edge spectrum.")


def cuprite_example() -> dict:
    """A fixed FEFF8L calculation for the bundled Cuprite AMCSD 15851 CIF."""
    from .artemis_structures import structure_details

    try:
        resources = {name: (_CUPRITE_EXAMPLE / name).read_bytes() for name in _CUPRITE_RESOURCE_SHA256}
    except OSError as exc:
        raise WebInputError("artemis_example_unavailable", "A bundled Cuprite example resource is unavailable.",
                            recovery="Restore the Cuprite example resources and retry.") from exc
    for name, expected in _CUPRITE_RESOURCE_SHA256.items():
        if hashlib.sha256(resources[name]).hexdigest() != expected:
            raise WebInputError("artemis_example_unavailable", f"The bundled Cuprite example {name} failed its provenance check.",
                                recovery="Restore the Cuprite example resources and retry.")
    source_hash = _CUPRITE_RESOURCE_SHA256["source.cif"]
    bundled_hash = hashlib.sha256(structure_details(15851)["cif"].encode("utf-8")).hexdigest()
    if bundled_hash != source_hash:
        raise WebInputError("artemis_example_unavailable", "The Cuprite example CIF does not match the bundled AMCSD 15851 structure.",
                            recovery="Restore the bundled AMCSD database and Cuprite example resources, then retry.")

    paths = [inspect_path(PathInput(filename=f"feff{index:04d}.dat",
                                    content=resources[f"feff{index:04d}.dat"].decode("utf-8")))
             for index in range(1, 5)]
    # The Cu–O first shell (feff0001) is stiff and the Cu–Cu shells beyond it
    # are not, so one ΔR and one σ² across all four paths forces a compromise
    # that can misfit both. This example changes both the model and the fit
    # objective: separate Cu-O parameters and kweight [2], not [0, 1, 2, 3].
    # The first shell
    # gets its own pair; the Cu–Cu path, the Cu–Cu–O triangle and the distant
    # oxygen share the second, which is six guesses against about 18
    # independent points.
    shells = ["o", "cu", "cu", "cu"]
    path_parameters = [dict(s02="amp", e0="del_e0", deltar=f"del_r_{shell}", sigma2=f"sig2_{shell}")
                       for shell in shells]
    parameters = [
        FitParameter(name="amp", value=1, min=0, max=2),
        FitParameter(name="del_e0", value=0, min=-30, max=30),
        FitParameter(name="del_r_o", value=0, min=-0.2, max=0.2),
        FitParameter(name="sig2_o", value=0.003, min=0, max=0.05),
        FitParameter(name="del_r_cu", value=0, min=-0.3, max=0.3),
        FitParameter(name="sig2_cu", value=0.01, min=0, max=0.05),
    ]
    return dict(amcsd_id=15851, cif_sha256=source_hash,
                feff_input=resources["feff.inp"].decode("utf-8"), paths=paths,
                path_parameters=path_parameters,
                parameters=[item.model_dump() for item in parameters],
                # k² alone: the fit and the plotted curves are then the same thing.
                transform=FitTransform(kmin=3, kmax=12, kweight=[2], dk=1, rmin=1, rmax=4).model_dump(),
                description="Cuprite Cu₂O (AMCSD 0015851), Cu K edge, site 1: the first four FEFF8L paths calculated from the attached crystal structure. "
                            "The Cu–O first shell has its own ΔR and σ²; the three longer paths share a second pair.")


def _processed_data(group: dict, options: FitTransform):
    arrays = (group.get("result") or {}).get("arrays") or {}
    if group.get("data_type") in ("detector", "xanes") or group.get("processing_error"):
        _fail("Process an EXAFS group successfully before fitting its chi(k).", "group")
    try:
        k, chi = (np.asarray(arrays.get(name, []), dtype=float) for name in ("k", "chi"))
        if (k.ndim != 1 or k.shape != chi.shape or not 20 <= len(k) <= 250000
                or not np.isfinite(k).all() or not np.isfinite(chi).all()
                or k[0] < 0 or not np.all(np.diff(k) > 0)):
            raise ValueError("invalid arrays")
    except (TypeError, ValueError):
        _fail("The selected group needs matching, finite, increasing k and chi(k) arrays with at least 20 points.", "group")
    if options.kmin < k[0] or options.kmax > k[-1] + 1e-8:
        _fail(f"The fitting k range must be within the measured range {k[0]:.3f}–{k[-1]:.3f} Å⁻¹.", "kmax")
    if np.count_nonzero((k >= options.kmin) & (k <= options.kmax)) < 20:
        _fail("At least 20 measured points must lie within the fitting k range.", "kmax")
    if not np.any(np.abs(chi[(k >= options.kmin) & (k <= options.kmax)]) > 1e-15):
        _fail("The selected chi(k) is zero in the fitting range.", "group")
    # Native FEFF fitting and output transforms share this grid. Supplying raw,
    # nonuniform chi directly would make save_outputs label its Fourier data wrong.
    k_out = np.arange(int(min(float(k[-1]), 50) / 0.05 + 1e-6) + 1) * 0.05
    # The grid has to start at zero, but chi imported from a file need not. Leave
    # the unmeasured stretch empty: np.interp would otherwise hold the first
    # measured point flat across it, and a window taper reaching down there would
    # transform that fabricated plateau as if it were data.
    chi_out = np.where(k_out < k[0], 0.0, np.interp(k_out, k, chi))
    return Group(k=k_out, chi=chi_out,
                 filename=group.get("label", "Athena group"), groupname=group.get("label", "Athena group"))


def _finite_array(values, field):
    data = np.asarray(values, dtype=float)
    if data.ndim != 1 or not np.isfinite(data).all():
        _fail(f"Larch returned nonfinite {field}. Check parameter bounds and fit ranges.")
    return data.tolist()


def _number(value, *, nullable=False):
    if value is not None and np.isfinite(value):
        return float(value)
    if nullable:
        return None
    _fail("Larch returned nonfinite fit statistics. Check the model and fit ranges.")


@dataclass
class FitInputs:
    """The validated Larch objects a fit runs on, whichever backend runs it."""

    data: object
    dataset: object
    transform: object
    parameters: object
    initial_values: dict
    trees: dict
    paths: list
    path_records: list
    active: list
    notices: list
    disorder: bool


def _identity_notices(group: dict, path_records: list) -> list[str]:
    """Refuse FEFF paths calculated for another absorber or edge than the spectrum's.

    Every path must share one absorber and edge, and when the spectrum's
    element and edge are known they must be those. A Cu K path fitted to a
    Mn K spectrum runs without complaint and returns numbers that mean nothing,
    so a known mismatch is refused; an unknown identity cannot be checked,
    and the fit says so rather than passing silently.
    """
    from .athena import _source_edge_identity

    identities = {(record["metadata"]["absorber"].strip().capitalize(), record["metadata"]["edge"].strip().upper())
                  for record in path_records}
    if len(identities) > 1:
        named = ", ".join(f"{record['filename']} ({record['metadata']['absorber']} {record['metadata']['edge']})"
                          for record in path_records)
        _fail(f"The included FEFF paths were calculated for different absorbers or edges: {named}. "
              "A single-spectrum fit uses paths for one absorber and edge.", "paths")
    # Use the spectrum's recorded identity, with the processed identity as a
    # fallback for older projects. Do not guess an edge for chi-only inputs.
    effective = (group.get("result") or {}).get("effective") or {}
    identity = (_source_edge_identity(group.get("source") or {})
                or _source_edge_identity({"edge_identity": effective}))
    for record in path_records:
        path_identity = _source_edge_identity({"edge_identity": {
            "element": record["metadata"]["absorber"], "edge": record["metadata"]["edge"],
        }})
        if identity and path_identity and identity != path_identity:
            _fail(f"{record['filename']}: this FEFF path was calculated for "
                  f"{path_identity['element']} {path_identity['edge']}, but the selected spectrum is "
                  f"{identity['element']} {identity['edge']}. Regenerate the FEFF paths for "
                  f"{identity['element']} {identity['edge']}, or correct the spectrum's element/edge "
                  "assignment if it is wrong.", "paths")
    if not identity:
        absorber, edge = next(iter(identities))
        return [f"This spectrum has no recorded element and edge, so the {absorber} {edge} FEFF paths "
                "could not be checked against it."]
    return []


def fit_inputs(group: dict, request: FitRequest, directory: Path) -> FitInputs:
    """Check a fit request and build everything a fit needs from it.

    Both the reference backend and the differentiable one come through here, so
    they fit the same data with the same paths, window, and noise scale; a
    comparison between them measures the optimizer and the forward model rather
    than a difference in how the request was read.
    """
    active = [path for path in request.paths if path.enabled]
    if not active:
        _fail("Enable at least one FEFF path.", "paths")
    if len({path.id for path in request.paths}) != len(request.paths):
        _fail("Each path must have a unique id.", "paths")
    if sum(len(path.content) for path in request.paths) > 4_000_000:
        _fail("The total FEFF file content must not exceed 4 MB.", "paths")
    data = _processed_data(group, request.transform)
    notices = ["Uncertainties use Larch's high-R noise estimate; systematic model errors are not included."]
    measured_k = group["result"]["arrays"]["k"]
    if request.transform.kmin - request.transform.dk / 2 < measured_k[0] or request.transform.kmax + request.transform.dk / 2 > measured_k[-1]:
        notices.append("The Fourier window taper extends beyond the measured k range; reduce the taper or narrow the fitting interval.")
    if len(request.transform.kweight) > 1:
        weights = ", ".join(f"{weight:g}" for weight in request.transform.kweight)
        notices.append(f"The fit minimized k weights {weights} together; the curves below are drawn at "
                       f"k^{request.transform.kweight[0]:g} only, so the plotted residual is one term of the fit.")
    effective = (group.get("result") or {}).get("effective") or {}
    rbkg = effective.get("rbkg")
    if rbkg is not None and request.transform.rmin < rbkg:
        notices.append(f"Rmin ({request.transform.rmin:g} Å) is below the background cutoff Rbkg ({rbkg:g} Å); this fit does not refine the background.")
    parameters, initial_values, trees = _parameters(request)
    paths, path_records = [], []
    for index, definition in enumerate(active):
        path, metadata = _read_path(definition, Path(directory), index)
        if request.transform.kmax > metadata["kmax"] or request.transform.kmin < metadata["kmin"]:
            _fail(f"{definition.filename}: the fit range must be within the FEFF calculation's {metadata['kmin']:g}–{metadata['kmax']:g} Å⁻¹ range.", "kmax")
        initial_path = {field: _evaluate(trees[definition.id][field], initial_values | {key: metadata[key] for key in _PATH_NAMES}, f"{definition.label or definition.id}.{field}", path=path)
                        for field in _PATH_PARAMETERS}
        if initial_path["sigma2"] < 0 or initial_path["s02"] < 0 or initial_path["deltar"] + metadata["reff"] <= 0:
            _fail(f"{definition.label or definition.id}: initial S0² and sigma² must be nonnegative, and Reff + ΔR must be positive.", "paths")
        if request.transform.kmax + request.transform.dk / 2 > metadata["kmax"]:
            notices.append(f"{definition.label or definition.id}: the window taper extends beyond the FEFF k grid; Larch may extrapolate the path. Energy shifts can also extend the required FEFF range.")
        path.label = definition.id
        for field in _PATH_PARAMETERS:
            expression = getattr(definition, field).strip()
            has_thermal_call = field == "sigma2" and any(isinstance(node, ast.Call) and node.func.id in DISORDER_FUNCTIONS
                                                        for node in ast.walk(trees[definition.id][field]))
            setattr(path, field, runtime_expression(expression) if has_thermal_call else expression)
        paths.append(path)
        path_records.append(dict(id=definition.id, label=definition.label or definition.filename,
                                 filename=definition.filename, metadata=metadata,
                                 sigma2_expression=definition.sigma2))
    notices.extend(_identity_notices(group, path_records))
    transform_options = request.transform.model_dump()
    # This Larch version collapses noise estimates for a one-element list
    # to a scalar; pass the matching scalar weight to its residual routine.
    if len(transform_options["kweight"]) == 1:
        transform_options["kweight"] = transform_options["kweight"][0]
    transform = feffit_transform(**transform_options, kstep=0.05, nfft=2048, rwindow="hanning")
    dataset = feffit_dataset(data=data, paths=paths, transform=transform)
    disorder = any(isinstance(node, ast.Call) and node.func.id in DISORDER_FUNCTIONS
                   for fields in trees.values() for node in ast.walk(fields["sigma2"]))
    if disorder:
        prepare_disorder_dataset(dataset)
        notices.append("Debye/Einstein temperatures are in K and sigma² is in Å². A single-temperature fit generally cannot separate a free static offset from a free characteristic temperature; constrain one or use temperature-series evidence.")
    return FitInputs(data=data, dataset=dataset, transform=transform, parameters=parameters,
                     initial_values=initial_values, trees=trees, paths=paths,
                     path_records=path_records, active=active, notices=notices, disorder=disorder)


def bound_notices(rows: list[dict]) -> list[str]:
    """Name every fitted Guess that finished on one of its bounds.

    A standard error is a curvature at the minimum; when the minimum is a bound
    the optimizer was stopped there rather than finding one, so that error does
    not describe the parameter. Both engines report through this one rule.
    """
    notices = []
    for row in rows:
        if row["kind"] != "guess":
            continue
        for side, bound in (("lower", row["min"]), ("upper", row["max"])):
            if bound is not None and abs(row["value"] - bound) <= 1e-6 * max(1.0, abs(bound)):
                notices.append(f"{row['name']} finished at its {side} bound ({bound:g}); its uncertainty does not describe it. "
                               "Widen the bound or fix the parameter.")
    return notices


def fit_group(group: dict, request: FitRequest) -> dict:
    handler_started = time.perf_counter()
    with _LARCH_LOCK, tempfile.TemporaryDirectory(prefix="artemis-fit-") as directory:
        inputs = fit_inputs(group, request, Path(directory))
        data, dataset, parameters = inputs.data, inputs.dataset, inputs.parameters
        initial_values, trees = inputs.initial_values, inputs.trees
        path_records, active, notices = inputs.path_records, inputs.active, inputs.notices
        # lmfit calls this after every residual evaluation, so the first and last
        # calls bracket the optimizer loop inside feffit -- the same phase the fast
        # backend times around its least-squares call. It returns None, which
        # lmfit reads as "carry on"; the fit itself is unchanged.
        evaluations: list[float] = []

        def mark(*_args, **_kws):
            evaluations.append(time.perf_counter())
        try:
            started = time.perf_counter()
            with np.errstate(over="raise", invalid="raise", divide="raise"):
                result = feffit(parameters, dataset, rmax_out=10, path_outputs=True, max_nfev=2000, iter_cb=mark)
            fit_seconds = time.perf_counter() - started
            report = feffit_report(result)
        except Exception as exc:
            raise WebInputError("artemis_fit_failed", "Larch could not fit this model. Check parameter expressions, bounds, path files, and fitting ranges.",
                                fields=("fit",), recovery="Try physically meaningful starting values and tighter bounds; reduce free parameters if the model is underdetermined.") from exc
        for index, definition in enumerate(active):
            report = report.replace(str(Path(directory) / f"feff{index:04d}.dat"), definition.filename)
            report = report.replace(f"'{runtime_expression(definition.sigma2)}'", f"'{definition.sigma2}'")
        parameter_rows, correlations = [], []
        for definition in request.parameters:
            fitted = result.params[definition.name]
            parameter_rows.append(dict(name=definition.name, kind=definition.kind, value=_number(fitted.value),
                                       initial=initial_values[definition.name], stderr=_number(fitted.stderr, nullable=True),
                                       min=definition.min, max=definition.max, expression=definition.expression))
            for other, value in (fitted.correl or {}).items():
                if definition.name < other and other in initial_values:
                    correlations.append(dict(left=definition.name, right=other, value=_number(value)))
        correlations.sort(key=lambda row: -abs(row["value"]))
        if not result.errorbars:
            notices.append("Larch could not determine reliable parameter uncertainties; inspect parameter correlations and model constraints.")
        if not result.success:
            notices.append("The optimizer did not converge. These are the final attempted parameters, not a converged fit.")
        notices.extend(bound_notices(parameter_rows))
        arrays = fit_arrays(request, inputs)
        statistics = dict(n_varys=int(result.nvarys), n_independent=_number(result.n_independent),
                          n_data=int(result.ndata), nfev=int(result.nfev), chi_square=_number(result.chi_square),
                          reduced_chi_square=_number(result.chi2_reduced), r_factor=_number(result.rfactor),
                          aic=_number(result.aic), bic=_number(result.bic), errorbars=bool(result.errorbars),
                          epsilon_k=_number(display_epsilon(dataset)))
        seconds = dict(fit=fit_seconds, optimizer=evaluations[-1] - evaluations[0] if len(evaluations) > 1 else None,
                       total=time.perf_counter() - handler_started)
        return dict(group_id=group["id"], group_label=group.get("label", ""), success=bool(result.success),
                    message=str(result.message), report=report, warnings=notices, statistics=statistics,
                    parameters=parameter_rows, correlations=correlations, paths=path_records,
                    transform=request.transform.model_dump(),
                    metadata=dict(engine="larch.feffit", kstep=0.05, nfft=2048, rwindow="hanning", phase_corrected=False,
                                  noise="Larch high-R estimate (15–30 Å)", background_refined=False,
                                  r_residual="complex data minus model; residual_mag is its magnitude",
                                  seconds=_timing(seconds)),
                    **arrays)


def _timing(seconds: dict) -> dict:
    """Phase timings, rounded to microseconds, with unmeasured phases left out.

    Both engines report the same phases so a reader compares like with like:
    ``total`` is the whole fit on the server, from reading the request to the
    finished curves; ``fit`` is the fit call itself (set-up, minimization,
    uncertainties and output arrays); ``optimizer`` is the minimization loop
    alone. Only the fast engine has a ``compile`` phase.
    """
    return {name: round(value, 6) for name, value in seconds.items() if value is not None}


def display_epsilon(dataset) -> float:
    """The noise scale the reported uncertainties were measured against.

    Every uncertainty and every chi-square in a fit is relative to this one
    number, so two fits cannot be compared until both are known to have used
    the same epsilon(k). Larch estimates one scale per k weight; this is the
    one belonging to the weight that is plotted.
    """
    epsilon_k = dataset.epsilon_k
    return float(np.mean(epsilon_k[0] if isinstance(epsilon_k, (list, tuple)) else epsilon_k))


def fit_arrays(request: FitRequest, inputs: FitInputs) -> dict:
    """Read the fitted curves off the dataset, for the plots and the path list.

    Called after either backend has left the dataset standing at its converged
    parameters, so the curves a reader compares are built the same way and
    any difference between the two is the fit rather than the drawing.
    """
    data, dataset = inputs.data, inputs.dataset
    model = dataset.model
    weight = request.transform.kweight[0]
    k_weight = data.k ** weight
    for definition, fitted_path, record in zip(inputs.active, dataset.pathlist, inputs.path_records):
        actual = fitted_path.path_paramvals()
        record["values"] = {field: _number(actual[field]) for field in _PATH_PARAMETERS}
        # The dataset owns these paths and has recalculated them at the final
        # fitted parameters. Their saved R outputs already use the model
        # transform and the first k weight; chi(k) still needs the display weight.
        if not np.array_equal(fitted_path.r, model.r):
            _fail("Larch returned inconsistent path and model R grids.")
        record["k"] = dict(chi=_finite_array(
            np.interp(data.k, fitted_path.k, fitted_path.chi) * k_weight, f"{definition.id} chi(k)"))
        record["r"] = {name: _finite_array(function(fitted_path.chir), f"{definition.id} R {name}")
                       for name, function in (("mag", np.abs), ("re", np.real), ("im", np.imag))}
        if actual["sigma2"] < 0 or actual["s02"] < 0 or fitted_path.reff + actual["deltar"] <= 0:
            inputs.notices.append(f"{definition.label or definition.id}: fitted path parameters are outside physical bounds. Constrain S0², sigma², and distance.")
    model_chi = np.interp(data.k, model.k, model.chi)
    # Retain unweighted values, including k=0, so display transforms can
    # change weights without reading current group data or rerunning a fit.
    plot_source = dict(schema_version=1, data=_finite_array(data.chi, "unweighted data"),
                       model=_finite_array(model_chi, "unweighted model"),
                       paths=[dict(id=record["id"], chi=_finite_array(
                           np.interp(data.k, path.k, path.chi), "unweighted path"))
                              for record, path in zip(inputs.path_records, dataset.pathlist)])
    weighted_data, weighted_model = data.chi * k_weight, model_chi * k_weight
    r_data, r_model = dataset.data.chir, model.chir
    difference = r_data - r_model
    return dict(
        plot_source=plot_source,
        k=dict(x=_finite_array(data.k, "k"), data=_finite_array(weighted_data, "data"),
               model=_finite_array(weighted_model, "model"),
               residual=_finite_array(weighted_data - weighted_model, "residual"), weight=weight),
        r=dict(x=_finite_array(model.r, "R"),
               **{f"{name}_{suffix}": _finite_array(function(array), f"{name} {suffix}")
                  for name, array in (("data", r_data), ("model", r_model), ("residual", difference))
                  for suffix, function in (("mag", np.abs), ("re", np.real), ("im", np.imag))}))


def _preview_metrics(r, chir_mag, options: FitTransform, chi, k, weight) -> dict:
    """How large a path is, in the two places a user judges it."""
    window = (r >= options.rmin) & (r <= options.rmax)
    inside = (k >= options.kmin) & (k <= options.kmax)
    peak = int(np.argmax(chir_mag))
    return dict(amplitude=float(chir_mag[peak]), r_at_amplitude=float(r[peak]),
                window_area=float(np.trapezoid(chir_mag[window], r[window])) if window.any() else 0.0,
                chi_k_peak=float(np.max(np.abs(chi[inside] * k[inside] ** weight))) if inside.any() else 0.0)


def preview_paths(request: PathPreviewRequest) -> dict:
    """Each enabled path's own chi(k) and chi(R) at the starting values.

    The Fourier transform is the one the fit would use, so a path drawn here
    and the same path drawn after a fit differ only by the fitted parameters.
    """
    enabled = [path for path in request.paths if path.enabled]
    if not enabled:
        _fail("Enable at least one FEFF path.", "paths")
    if len({path.id for path in request.paths}) != len(request.paths):
        _fail("Each path must have a unique id.", "paths")
    if sum(len(path.content) for path in request.paths) > 4_000_000:
        _fail("The total FEFF file content must not exceed 4 MB.", "paths")
    definitions, values, _, _ = _initial_values(request.parameters)
    trees, _ = _path_trees(request.paths, set(definitions))
    options, weight, warnings = request.transform, request.transform.kweight[0], []
    with _LARCH_LOCK, tempfile.TemporaryDirectory(prefix="artemis-preview-") as directory:
        loaded = [(definition, *_read_path(definition, Path(directory), index))
                  for index, definition in enumerate(enabled)]
        reach = min(metadata["kmax"] for _, _, metadata in loaded)
        if options.kmax > reach:
            warnings.append(f"The FEFF paths only reach {reach:g} Å⁻¹, below the fit's kmax of {options.kmax:g} Å⁻¹; the preview stops there.")
        # The preview grid stops at PREVIEW_KMAX to stay cheap; a fit range past it
        # would otherwise be drawn as if the preview covered it.
        if options.kmax > PREVIEW_KMAX and reach > PREVIEW_KMAX:
            warnings.append(f"The preview stops at {PREVIEW_KMAX:g} Å⁻¹, below the fit's kmax of {options.kmax:g} Å⁻¹; "
                            "the curves and sizes here leave out the rest of the fit range.")
        k = np.arange(int(min(reach, PREVIEW_KMAX) / 0.05 + 1e-6) + 1) * 0.05
        transform = feffit_transform(**(request.transform.model_dump() | {"kweight": weight}),
                                     kstep=0.05, nfft=2048, rwindow="hanning")
        records, total_chi, grid = [], np.zeros_like(k), None
        for definition, path, metadata in loaded:
            name = definition.label or definition.id
            resolved = {field: _evaluate(trees[definition.id][field], values | {key: metadata[key] for key in _PATH_NAMES}, f"{name}.{field}", path=path)
                        for field in _PATH_PARAMETERS}
            if resolved["sigma2"] < 0 or resolved["s02"] < 0 or resolved["deltar"] + metadata["reff"] <= 0:
                _fail(f"{name}: S0² and sigma² must be nonnegative, and Reff + ΔR must be positive.", "paths")
            try:
                with np.errstate(over="raise", invalid="raise", divide="raise"):
                    path._calc_chi(k=k, **resolved)
                fourier = Group()
                transform._xafsft(np.asarray(path.chi, dtype=float), group=fourier, rmax_out=10)
            except Exception as exc:
                raise WebInputError("artemis_preview_failed", f"{name}: Larch could not evaluate this path at the current values.",
                                    fields=("paths",), recovery="Check the path parameter expressions and their starting values.") from exc
            chi, grid = np.asarray(path.chi, dtype=float), np.asarray(fourier.r, dtype=float)
            total_chi = total_chi + chi
            records.append(dict(id=definition.id, label=definition.label or definition.filename,
                                filename=definition.filename, metadata=metadata, values=resolved,
                                k=dict(chi=_finite_array(chi * k ** weight, f"{definition.id} chi(k)")),
                                r={key: _finite_array(function(fourier.chir), f"{definition.id} R {key}")
                                   for key, function in (("mag", np.abs), ("re", np.real), ("im", np.imag))},
                                metrics=_preview_metrics(grid, np.asarray(fourier.chir_mag, dtype=float), options, chi, k, weight)))
        total = Group()
        transform._xafsft(total_chi, group=total, rmax_out=10)
    return dict(paths=records, warnings=warnings, transform=request.transform.model_dump(),
                k=dict(x=_finite_array(k, "k"), weight=weight,
                       chi=_finite_array(total_chi, "unweighted total chi(k)"),
                       total=_finite_array(total_chi * k ** weight, "total chi(k)")),
                r=dict(x=_finite_array(grid, "R"),
                       **{f"total_{key}": _finite_array(function(total.chir), f"total R {key}")
                          for key, function in (("mag", np.abs), ("re", np.real), ("im", np.imag))}),
                metadata=dict(engine="larch.feffdat", kstep=0.05, nfft=2048, rwindow="hanning",
                              note="Starting values only; no fit is run and no measured spectrum is used.",
                              metrics="amplitude is the tallest |chi(R)| of the path, window_area its |chi(R)| integrated over the fit R range, chi_k_peak the tallest weighted |chi(k)| in the fit k range"))


def build_artemis_router(store) -> APIRouter:
    router = APIRouter(prefix="/api/artemis", tags=["Artemis"])

    @router.post("/paths/inspect")
    def inspect(source: PathInput):
        return inspect_path(source)

    @router.post("/paths/preview")
    def preview(request: PathPreviewRequest):
        return preview_paths(request)

    @router.get("/capabilities")
    def capabilities():
        """The fit and FEFF request bodies, for a caller with no form to fill in."""
        from .agent_fit import capabilities as describe

        return describe()

    @router.get("/examples/cuprite")
    def example():
        return cuprite_example()

    from .artemis_structures import FeffJobs

    jobs = FeffJobs(store.settings.data_root, store=store)

    from .artemis_simulation import register_simulation_route
    register_simulation_route(router, jobs)

    def _run_fit(ident: str, group_id: str, request: FitRouteRequest, view: str, backend):
        project = store.load(ident)
        # Draft access is capability-guarded by Athena's integration router.
        # Do not create an unguarded alternative entry point to those spectra.
        if project.get("integration") is True:
            _fail("Import the integration draft into a local project before fitting.", "project")
        store.check(project, request.version)
        result = backend(store.group(project, group_id), request.resolve(jobs))
        store.check(store.load(ident), request.version)
        reply = dict(project_id=ident, version=request.version, **result)
        if view == "summary":
            from .agent_fit import fit_summary

            return fit_summary(reply)
        return reply

    @router.post("/projects/{ident}/groups/{group_id}/fit")
    def fit(ident: str, group_id: str, request: FitRouteRequest,
            view: Literal["full", "summary"] = Query(default="full")):
        """Fit one group. `?view=summary` returns the fitted values without the curves."""
        return _run_fit(ident, group_id, request, view, fit_group)

    @router.get("/fast-fit/status")
    def fast_status():
        """Whether the differentiable backend can run here, and why not if it cannot.

        The client asks before offering the option, so that an absent engine
        reads as a disabled control with a reason rather than a failed fit.
        """
        from .artemis_fast import fast_engine_status

        return fast_engine_status()

    @router.post("/projects/{ident}/groups/{group_id}/fit/fast")
    def fit_fast(ident: str, group_id: str, request: FitRouteRequest,
                 view: Literal["full", "summary"] = Query(default="full")):
        """The same fit, minimized with an exact Jacobian instead of differences.

        It takes the identical request body and returns the identical response
        shape as the reference route, which is what makes the two comparable in
        one click; `metadata.engine_parity` and `metadata.seconds` say how far
        the two forward models differ and what the speed cost or gain was.
        """
        from .artemis_fast import fast_fit_group

        return _run_fit(ident, group_id, request, view, fast_fit_group)

    from .artemis_structures import build_structures_router

    router.include_router(build_structures_router(store, jobs))
    from .artemis_persistence import build_persistence_router

    router.include_router(build_persistence_router(store))
    from .artemis_plot import build_plot_router

    router.include_router(build_plot_router(store))
    return router
