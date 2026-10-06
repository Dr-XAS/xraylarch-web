"""Forward EXAFS from one CIF/FEFF site; no measured spectrum or minimisation."""
from __future__ import annotations

import hashlib
from typing import Literal

from pydantic import Field, model_validator

from .artemis import FitPath, FitTransform, PathPreviewRequest, StrictModel, preview_paths
from .errors import WebInputError


def register_simulation_route(router, jobs):
    @router.get("/capabilities/simulation")
    def capabilities():
        from .agent_actions import _model_options
        return dict(post="/api/artemis/feff/jobs/{job_id}/simulate?view=summary",
                    body=_model_options("artemis_simulation:SimulationRequest"),
                    transform=_model_options("artemis_simulation:SimulationTransform"),
                    notes=[
                        "Requires a completed FEFF job, no measured group or fit. Omit path_ids for all available paths (up to 100).",
                        "Shared defaults: S0 squared 1, sigma squared 0.003 A squared, delta E0 0 eV and delta R 0 A. Sigma squared is an assumption, not inferred from CIF displacement factors or temperature.",
                        "One absorbing site, native FEFF degeneracies; no automatic site-population average. Inspect warnings for omitted paths.",
                        "Full replies include unweighted k.chi, weighted k.total, complex Fourier curves and exact CIF/FEFF/path sources. Summary elides arrays and omits source files. Nothing is saved to the project.",
                    ])

    @router.post("/feff/jobs/{job_id}/simulate")
    def simulate(job_id: str, request: SimulationRequest, view: Literal["full", "summary"] = "full"):
        result = simulate_job(jobs.get(job_id), request)
        if view == "summary":
            from .agent_views import elide_arrays
            return elide_arrays({key: value for key, value in result.items() if key != "source"})
        return result


class SimulationTransform(FitTransform):
    kweight: list[int] = Field(default_factory=lambda: [2], min_length=1, max_length=1)
    kmax: float = Field(default=12, gt=0, le=20)


class SimulationRequest(StrictModel):
    path_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)
    s02: float = Field(default=1, ge=0, le=2)
    sigma2: float = Field(default=0.003, ge=0, le=0.1)
    e0: float = Field(default=0, ge=-50, le=50)
    deltar: float = Field(default=0, ge=-1, le=1)
    transform: SimulationTransform = Field(default_factory=SimulationTransform)

    @model_validator(mode="after")
    def simulation_ranges(self):
        if self.path_ids is not None and len(set(self.path_ids)) != len(self.path_ids):
            raise ValueError("Select each path only once.")
        return self


class SimulationPaths(PathPreviewRequest):
    # Forward sums can use the complete job; the 24-path fit limit still applies
    # to fitting and its interactive model preview.
    paths: list[FitPath] = Field(min_length=1, max_length=100)


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
