"""Forward EXAFS from one CIF/FEFF site; no measured spectrum or minimisation."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
from typing import Literal

from fastapi import Header
import numpy as np
from pydantic import Field, field_validator, model_validator

from .artemis import FitPath, FitTransform, PathPreviewRequest, StrictModel, preview_paths
from .errors import WebInputError


_LOGGER = logging.getLogger(__name__)


def register_simulation_route(router, jobs, store):
    @router.get("/capabilities/simulation")
    def capabilities():
        from .agent_actions import _model_options
        return dict(post="/api/artemis/feff/jobs/{job_id}/simulate?view=summary",
                    body=_model_options("artemis_simulation:SimulationRequest"),
                    transform=_model_options("artemis_simulation:SimulationTransform"),
                    notes=[
                        "Requires a completed FEFF job, no measured group or fit. Omit path_ids for all available paths (up to 100).",
                        "Shared defaults: S0 squared 0.85, sigma squared 0.003 A squared, delta E0 0 eV and delta R 0 A. Sigma squared is an assumption, not inferred from CIF displacement factors or temperature.",
                        "One absorbing site, native FEFF degeneracies; no automatic site-population average. Inspect warnings for omitted paths.",
                        "Full replies include unweighted k.chi, weighted k.total, complex Fourier curves and exact CIF/FEFF/path sources. Summary elides arrays and omits source files. Nothing is saved to the project.",
                    ],
                    saved_view=dict(post="/api/artemis/projects/{project_id}/groups/{group_id}/simulation-view?view=summary",
                                    body=_model_options("artemis_simulation:SimulationViewRequest"),
                                    notes=["Read-only reconstruction from the theory group's saved FEFF files and original simulation parameters; no fit and no live FEFF job required.",
                                           "Display kweight accepts 0–3; null uses the saved simulation weight. Does not change the project or its processing recipe."]),
                    add_to_project=dict(post="/api/artemis/projects/{project_id}/simulation?view=summary",
                                        body=_model_options("artemis_simulation:AddSimulationRequest"),
                                        notes=["Send the completed simulation's request, not current unsimulated form values. The server recreates the exact unweighted chi(k) from the completed FEFF job.",
                                               "Adds one marked chi group with source.tags containing theory, saved parameters and exact CIF/FEFF/path provenance. Version checked, undoable; Idempotency-Key prevents duplicate additions on retry."]))

    @router.post("/feff/jobs/{job_id}/simulate")
    def simulate(job_id: str, request: SimulationRequest, view: Literal["full", "summary"] = "full"):
        result = simulate_job(jobs.get(job_id), request)
        if view == "summary":
            from .agent_views import elide_arrays
            return elide_arrays({key: value for key, value in result.items() if key != "source"})
        return result

    @router.post("/projects/{ident}/simulation")
    def add(ident: str, request: AddSimulationRequest,
            view: Literal["full", "summary", "parameters"] = "full",
            idempotency_key: str | None = Header(default=None, min_length=1, max_length=200, alias="Idempotency-Key")):
        from .agent_views import project_view
        return project_view(add_simulation(store, jobs, ident, request, idempotency_key=idempotency_key), view)

    @router.post("/projects/{ident}/groups/{group_id}/simulation-view")
    def simulation_view(ident: str, group_id: str, request: SimulationViewRequest,
                        view: Literal["full", "summary"] = "full"):
        from .artemis_attachments import local_project
        project = local_project(store, ident)
        store.check(project, request.version)
        result = view_simulation(store.group(project, group_id), request.kweight)
        store.check(store.load(ident), request.version)
        result.update(project_id=ident, group_id=group_id, version=request.version)
        if view == "summary":
            from .agent_views import elide_arrays
            return elide_arrays(result)
        return result


class SimulationTransform(FitTransform):
    kweight: list[int] = Field(default_factory=lambda: [2], min_length=1, max_length=1)
    kmax: float = Field(default=12, gt=0, le=20)


class SimulationRequest(StrictModel):
    path_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)
    s02: float = Field(default=0.85, ge=0, le=2)
    sigma2: float = Field(default=0.003, ge=0, le=0.1)
    e0: float = Field(default=0, ge=-50, le=50)
    deltar: float = Field(default=0, ge=-1, le=1)
    transform: SimulationTransform = Field(default_factory=SimulationTransform)

    @model_validator(mode="after")
    def simulation_ranges(self):
        if self.path_ids is not None and len(set(self.path_ids)) != len(self.path_ids):
            raise ValueError("Select each path only once.")
        return self


class AddSimulationRequest(StrictModel):
    version: int = Field(ge=0)
    feff_job_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    simulation: SimulationRequest
    label: str | None = Field(default=None, min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f-\x9f]+$")

    @field_validator("label", mode="before")
    @classmethod
    def trim_label(cls, value):
        return value.strip() if isinstance(value, str) else value


def add_simulation(store, jobs, ident: str, request: AddSimulationRequest, *, idempotency_key: str | None = None):
    """Add native unweighted chi(k), atomically and with the displayed recipe.

    The request carries parameters rather than client-generated arrays. Saving
    exact FEFF sources keeps the theory identifiable after a job expires and
    after JSON or native project exchange. A replay is checked before the
    revision or job, so a lost response cannot add a second group.
    """
    from .artemis_attachments import local_project, validate_attachments
    from .athena import _exchange_budget, now

    body_sha256 = hashlib.sha256(json.dumps(request.model_dump(exclude={"version"}), sort_keys=True,
                                           separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    key_sha256 = hashlib.sha256(idempotency_key.encode()).hexdigest() if idempotency_key is not None else None
    receipt_file = f"simulation-add-{key_sha256}.json" if key_sha256 is not None else None
    with store.storage.lock(ident):
        old = local_project(store, ident)
        if receipt_file is not None:
            try:
                receipt = store.storage.read_json(ident, receipt_file)
            except FileNotFoundError:
                # A process can stop after saving project.json but before the
                # receipt. Its persisted group is the same durable record.
                previous = next((g for g in old["groups"] if
                                 (g.get("source", {}).get("simulation_addition") or {}).get("key_sha256") == key_sha256), None)
                receipt = ({**previous["source"]["simulation_addition"], "group_id": previous["id"]}
                           if previous is not None else None)
            if receipt is not None:
                if receipt["body_sha256"] != body_sha256:
                    _fail("This Idempotency-Key was already used for different simulation inputs. Use a new key.", "Idempotency-Key")
                reply = copy.deepcopy(old)
                reply["last_operation"] = dict(action="simulation", skipped_group_ids=[],
                                                simulation=dict(group_id=receipt["group_id"]),
                                                idempotent_replay=dict(action="simulation", version_after=receipt.get("version_after"),
                                                                       group_ids=[receipt["group_id"]],
                                                                       note="This simulation already ran under the same key and was not added again. The project shown is its current state, which may include later changes."),
                                                group_present=any(g["id"] == receipt["group_id"] for g in old["groups"]))
                return reply
        store.check(old, request.version)
        job = jobs.get(request.feff_job_id)
        provenance, job_request = job.get("provenance", {}), job.get("request", {})
        if provenance.get("project_id") != ident or job_request.get("project_id") != ident:
            _fail("This FEFF calculation belongs to another project. Calculate FEFF from a CIF attached to this project.", "feff_job_id")
        attachment_id = provenance.get("attachment_id")
        attachment = next((record for record in validate_attachments(old.get("artemis_structures", []))
                           if record["id"] == attachment_id), None)
        if attachment is None or job_request.get("attachment_id") != attachment_id:
            _fail("The CIF used by this FEFF calculation is no longer attached to this project.", "feff_job_id")
        cif_sha256 = hashlib.sha256(provenance.get("cif", "").encode()).hexdigest()
        if provenance.get("cif_sha256") != attachment["sha256"] or cif_sha256 != attachment["sha256"]:
            _fail("The FEFF calculation does not match this project's attached CIF. Recalculate FEFF before adding the simulation.", "feff_job_id")
        result = simulate_job(job, request.simulation)
        transform = request.simulation.transform
        parameters = {key: getattr(transform, key) for key in ("kmin", "kmax", "dk", "window", "rmin", "rmax", "dr")}
        parameters.update(kweight=transform.kweight[0], kstep=result["metadata"]["kstep"],
                          nfft=result["metadata"]["nfft"], rmax_out=10,
                          rwindow=result["metadata"]["rwindow"])
        structure = attachment["structure"]
        default_label = (attachment.get("label") or structure.get("filename")
                         or structure["formula"] or structure["mineral"])
        label = request.label or f"{default_label} · {job_request['absorber']} {job_request['edge']} · theory"
        source = dict(operation="simulation", tags=["theory"], simulation=copy.deepcopy(result["simulation"]),
                      feff=copy.deepcopy(result["source"]), warnings=list(result["warnings"]),
                      edge_identity=dict(element=job_request["absorber"], edge=job_request["edge"], origin="selected"),
                      created_at=now())
        if key_sha256 is not None:
            source["simulation_addition"] = dict(key_sha256=key_sha256, body_sha256=body_sha256)
        group = store.make_group(label, result["k"]["x"], result["k"]["chi"], data_type="chi",
                                 parameters=parameters, source=source)
        if group["processing_error"]:
            _fail(f"The simulated chi(k) could not be processed: {group['processing_error']}", "simulation")
        group["result"]["warnings"] = list(dict.fromkeys([*result["warnings"], *group["result"]["warnings"]]))
        updated = copy.deepcopy(old)
        updated["groups"].append(group)
        updated["last_operation"] = dict(action="simulation", skipped_group_ids=[],
                                          simulation=dict(group_id=group["id"], feff_job_id=job["id"], tags=["theory"]))
        _exchange_budget(updated["groups"], store.settings)
        saved = store.save(updated, old, f"Added simulated EXAFS: {group['label']}")
        if receipt_file is not None:
            try:
                store.storage.write_json(ident, receipt_file, dict(body_sha256=body_sha256, group_id=group["id"],
                                                                version_after=saved["version"]))
            except OSError:
                _LOGGER.warning("Could not write simulation addition receipt for %s", ident, exc_info=True)
        return saved


class SimulationPaths(PathPreviewRequest):
    # Forward sums can use the complete job; the 24-path fit limit still applies
    # to fitting and its interactive model preview.
    paths: list[FitPath] = Field(min_length=1, max_length=100)


class SimulationViewRequest(StrictModel):
    version: int = Field(ge=0)
    kweight: int | None = Field(default=None, ge=0, le=3)


def view_simulation(group: dict, kweight: int | None = None) -> dict:
    """Replay saved theory sources, including after FEFF job expiry or project exchange.

    These are the original simulation and Fourier settings, not a fit or the
    current processing recipe. No project state or saved parameters are changed.
    """
    source = group.get("source", {})
    info, feff = source.get("simulation"), source.get("feff")
    if (group.get("data_type") != "chi" or not isinstance(source.get("tags"), list) or "theory" not in source["tags"]
            or not isinstance(info, dict) or info.get("kind") != "cif-exafs"
            or type(info.get("schema_version")) is not int or info["schema_version"] != 1
            or not isinstance(feff, dict)):
        _fail("This spectrum has no saved EXAFS simulation sources for path contributions.", "source")
    try:
        if not isinstance(info["request"], dict) or not {"s02", "sigma2", "e0", "deltar", "transform", "path_ids"} <= info["request"].keys():
            raise ValueError("Missing simulation parameters")
        request = SimulationRequest.model_validate(info["request"])
        scalars = {key: str(getattr(request, key)) for key in ("s02", "sigma2", "e0", "deltar")}
        files = feff["paths"]
        if not isinstance(files, list) or not 1 <= len(files) <= 100:
            raise ValueError("Invalid path files")
        paths = [FitPath.model_validate(dict(path, **scalars)) for path in files]
        ids = [path.id for path in paths]
        if (len(set(ids)) != len(ids) or ids != info["path_ids"]
                or (request.path_ids is not None and request.path_ids != ids)
                or not all(path.enabled for path in paths)):
            raise ValueError("Inconsistent path selection")
        available, total = info["available_paths"], info["total_paths"]
        if type(available) is not int or type(total) is not int or not len(ids) <= available <= 100 or total < available:
            raise ValueError("Invalid path counts")
        assumptions = info["assumptions"]
        warnings = source.get("warnings", [])
        if any(not isinstance(items, list) or not all(isinstance(item, str) for item in items)
               for items in (assumptions, warnings)):
            raise ValueError("Invalid simulation notes")
        model = SimulationPaths(paths=paths, transform=request.transform)
    except (KeyError, TypeError, ValueError) as exc:
        raise WebInputError("invalid_artemis_simulation", "The saved simulation sources are incomplete or inconsistent.",
                            fields=("source",), recovery="Recreate the theory spectrum from its CIF and FEFF paths.") from exc
    result = preview_paths(model, display_kweight=kweight)
    result["warnings"] = list(dict.fromkeys([*warnings, *result["warnings"]]))
    # Edits may retain provenance. Never imply its original decomposition is a
    # decomposition of a subsequently modified spectrum.
    matches = all(len(group[key]) == len(result["k"][curve]) and
                  np.allclose(group[key], result["k"][curve], rtol=1e-10, atol=1e-12)
                  for key, curve in (("energy", "x"), ("mu", "chi")))
    if not matches:
        result["warnings"].append("This spectrum differs from its saved simulation. The curves show the original theory and its path contributions.")
    result["group_label"] = group["label"]
    result["simulation"] = dict(request=request.model_dump(), path_ids=ids,
                                available_paths=available, total_paths=total, assumptions=list(assumptions))
    result["metadata"]["note"] = "Saved theoretical EXAFS; no fit. Uses the original simulation Fourier settings."
    return result


def _fail(message: str, field: str):
    raise WebInputError("invalid_artemis_simulation", message, fields=(field,),
                        recovery="Review the completed FEFF calculation and simulation parameters, then retry.")


def simulate_job(job: dict, request: SimulationRequest) -> dict:
    if job["status"] != "complete":
        _fail("Wait for the FEFF calculation to complete before simulating EXAFS.", "feff_job")
    available = {path["id"]: path for path in job["paths"]}
    selected = list(available) if request.path_ids is None else request.path_ids
    if not selected or any(ident not in available for ident in selected):
        _fail("Select paths belonging to this completed FEFF calculation.", "path_ids")
    sources = [available[ident] for ident in selected]
    reach = min(float(path["metadata"]["kmax"]) for path in sources)
    if request.transform.kmax > reach:
        _fail(f"These paths reach k = {reach:g} Å⁻¹. Reduce the Fourier kmax to this value or below.", "transform.kmax")
    settings = {key: str(getattr(request, key)) for key in ("s02", "sigma2", "e0", "deltar")}
    paths = [FitPath(id=path["id"], filename=path["filename"], content=path["content"], **settings)
             for path in sources]
    result = preview_paths(SimulationPaths(paths=paths, transform=request.transform))
    result["warnings"] = list(job.get("warnings", [])) + result["warnings"]
    if request.transform.kmax + request.transform.dk / 2 > min(reach, 20):
        result["warnings"].append("The upper Fourier window taper extends beyond the calculated k grid and is cut off.")
    if request.e0 < 0:
        result["warnings"].append("Negative ΔE0 shifts path evaluation toward higher k; the final grid points may extrapolate beyond FEFF support.")
    if job.get("truncated"):
        result["warnings"].append(f"FEFF returned {len(available)} of {job['total_paths']} paths. "
                                  "This simulation omits the remaining paths; increase Maximum paths and recalculate to include more.")
    if len(sources) < len(available):
        result["warnings"].append(f"Only {len(sources)} of {len(available)} available paths are included.")
    result["simulation"] = dict(
        kind="cif-exafs", schema_version=1, feff_job_id=job["id"],
        request=request.model_dump(), path_ids=selected,
        available_paths=len(available), total_paths=job["total_paths"],
        calculated_k_range=[result["k"]["x"][0], result["k"]["x"][-1]],
        cif_sha256=hashlib.sha256(job["provenance"]["cif"].encode("utf-8")).hexdigest(),
        assumptions=[
            "One selected absorbing site; inequivalent sites are not population averaged.",
            "FEFF path degeneracies are retained. S0², ΔE0, ΔR and σ² are shared by all included paths.",
            "σ² is an assumed mean-square relative displacement, not inferred from CIF displacement factors or temperature.",
            "χ(R) is not phase corrected; its peaks are not bond distances.",
        ],
    )
    result["source"] = dict(request=job["request"], provenance=job["provenance"],
                            paths=[{key: path[key] for key in ("id", "filename", "content")} for path in sources])
    result["metadata"]["note"] = "Simulated EXAFS from FEFF paths; no measured spectrum and no fit."
    return result
