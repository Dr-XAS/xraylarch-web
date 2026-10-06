"""An Artemis fit reported in numbers, without the curves drawn from it.

The fit route answers with everything the browser plots: data, model and
residual in k and in R, and the same again for every path. On the bundled
Cuprite setup that is about 250 KB, of which the fitted values are under 2 KB.

The values are also what an agent was told to fit for. The digest's |chi(R)|
peaks sit a few tenths of an angstrom short of the bond, and a path's
reff + deltar is the distance with the phase shift accounted for, so this is
where a distance comes from.
"""
from __future__ import annotations

NOTE = (
    "r is reff + deltar for each path: a fitted distance, with the scattering "
    "phase taken from the FEFF calculation, unlike the digest's |chi(R)| peaks. "
    "A parameter flagged at_bound stopped at its min or max, so its stderr says "
    "nothing and the bound is doing the fitting. Correlations below 0.1 are left "
    "out; above about 0.9 they mean the pair is not separately determined by this data. "
    "concerns lists what a plot of the fit would have shown at a glance; success only "
    "means the minimiser stopped. Nothing was saved: the fit route reads the group and returns."
)

# How close to a bound counts as on it, as a fraction of the allowed span.
_AT_BOUND = 1e-3
_CORRELATION_FLOOR = 0.1
_CORRELATION_HIGH = 0.9
# The usual rule of thumb: an R-factor under about 0.02 is a good EXAFS fit,
# and past 0.05 the model is not describing the data.
_R_FACTOR_POOR = 0.05


def _round(value):
    """Six significant figures: a fit's stderr makes the seventh noise anyway."""
    if isinstance(value, float):
        return float(f"{value:.6g}")
    if isinstance(value, dict):
        return {key: _round(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_round(item) for item in value]
    return value


def _at_bound(row: dict) -> str | None:
    low, high = row.get("min"), row.get("max")
    if row.get("kind") != "guess" or low is None or high is None or high <= low:
        return None
    margin = (high - low) * _AT_BOUND
    if row["value"] <= low + margin:
        return "min"
    if row["value"] >= high - margin:
        return "max"
    return None


def _scatterers(geometry: list[dict]) -> str:
    # The absorber leads the geometry; the rest is the scattering path.
    return "-".join(atom["atom"] for atom in geometry) if geometry else "?"


def _concerns(result: dict, parameters: list[dict]) -> list[str]:
    """What a plot of the fit would have shown at a glance.

    A blind run fitted in k space, read "Fit succeeded", and was one step from
    quoting values from an R-factor of 0.37. success means the minimiser
    stopped, not that the model fits.
    """
    concerns = []
    stats = result.get("statistics") or {}
    if (r_factor := stats.get("r_factor")) is not None and r_factor > _R_FACTOR_POOR:
        concerns.append(f"R-factor {r_factor:.3g} is above {_R_FACTOR_POOR}: under about 0.02 is a "
                        "good fit, and at this level the model leaves much of the data unexplained. "
                        "Check what the model misses before quoting its values or their errors; the "
                        "residual is in the full view of this route, under k and r.")
    varys, independent = stats.get("n_varys"), stats.get("n_independent")
    if varys is not None and independent is not None and varys >= independent:
        concerns.append(f"{varys} variables against {independent:.3g} independent points: the data "
                        "cannot determine this many. Widen the k or R range or set some parameters.")
    for row in parameters:
        if row.get("at_bound"):
            concerns.append(f"{row['name']} stopped at its {row['at_bound']} bound; widen the bound or "
                            "set it, since its value is the bound's, not the data's.")
    for row in result.get("correlations") or ():
        if abs(row["value"]) > _CORRELATION_HIGH:
            concerns.append(f"{row['left']} and {row['right']} are {row['value']:+.2f} correlated: this "
                            "data does not determine them separately.")
    if not stats.get("errorbars", True):
        concerns.append("Larch could not estimate error bars for this fit, so stderr is missing.")
    return concerns


def fit_summary(result: dict) -> dict:
    parameters = []
    for row in result["parameters"]:
        entry = {key: row[key] for key in ("name", "kind", "value", "stderr", "initial")}
        if row.get("expression"):
            entry["expression"] = row["expression"]
        if bound := _at_bound(row):
            entry["at_bound"] = bound
        parameters.append(entry)
    paths = []
    for record in result["paths"]:
        metadata, values = record["metadata"], record.get("values") or {}
        paths.append({
            "id": record["id"],
            "label": record["label"],
            "scatterers": _scatterers(metadata.get("geometry") or []),
            "nleg": metadata.get("nleg"),
            "degen": metadata.get("degen"),
            "reff": metadata.get("reff"),
            "r": round(metadata["reff"] + values["deltar"], 4) if "deltar" in values else None,
            **{key: values[key] for key in ("s02", "sigma2", "e0", "deltar") if key in values},
            **({"sigma2_expression": record["sigma2_expression"]} if "sigma2_expression" in record else {}),
        })
    return _round({
        **{key: result[key] for key in ("project_id", "version", "group_id", "group_label",
                                        "success", "message", "warnings", "statistics",
                                        "transform") if key in result},
        "parameters": parameters,
        # Larch's own report leaves out correlations below 0.1, and so does this.
        "correlations": [row for row in result.get("correlations") or ()
                         if abs(row["value"]) >= _CORRELATION_FLOOR],
        "paths": paths,
        "concerns": _concerns(result, parameters),
        "note": NOTE,
    })


def feff_job_summary(record: dict) -> dict:
    """A FEFF job's state and what its paths are, without their files.

    The full status reply is about 20 KB for one path, half of it the CIF and
    the FEFF input under provenance, and it is the same 20 KB on every poll.
    A run that polled while fitting twenty times read 445 KB of it.
    """
    summary = {key: record[key] for key in ("id", "status", "stage", "message", "elapsed_seconds",
                                            "total_paths", "truncated", "reused", "warnings") if key in record}
    if "paths" in record:
        summary["paths"] = [{
            "id": path.get("id"), "filename": path.get("filename"),
            "scatterers": _scatterers((path.get("metadata") or {}).get("geometry") or []),
            **{key: (path.get("metadata") or {}).get(key) for key in ("nleg", "degen", "reff", "kmax")},
        } for path in record["paths"]]
        summary["note"] = ("The path files are left out of this view. A fit can name them "
                           "instead of carrying them: send each path as {id, feff_job, feff_path} "
                           "with feff_job this job's id and feff_path a paths[].id below.")
    return _round(summary)


def capabilities() -> dict:
    """The Artemis bodies an agent sends, read off the models that validate them.

    Both blind HTTP arms that were asked for a distance went looking for
    /api/artemis/capabilities, found a 404, and rebuilt the fit body from the
    cuprite example by trial: which path fields are required, which parameter
    kinds exist, whether kweight is a list, whether site_index counts from 0.
    """
    from .agent_actions import _model_options

    return {
        "workflow": [
            "GET /api/artemis/structures?q=copper&element=Cu; GET /api/artemis/structures/{id} "
            "for sites (indices from 1). For DFT-relaxed MP structures, add provider=materials_project "
            "and use q=Cu2O. Attach with POST /api/artemis/projects/{id}/structures "
            "{version,provider:'materials_project',material_id}; use project_id,attachment_id,version for FEFF.",
            "POST /api/artemis/feff/jobs?view=summary with feff_job: 202 running; "
            "200 complete with reused=true for an identical finished request",
            "GET /api/artemis/feff/jobs/{job_id}?view=summary until status='complete'",
            "POST /api/artemis/projects/{id}/groups/{gid}/fit?view=summary with fit "
            "and path_from_feff_job paths; paths[].r is the fitted distance",
        ],
        "fit": {
            "post": "/api/artemis/projects/{id}/groups/{gid}/fit?view=summary",
            "body": {"version": "int — the project's current version. Nothing is saved, so it "
                                "does not move",
                     "parameters": "list of parameter, 1-32",
                     "paths": "list of path, 1-24",
                     "transform": "transform; every key optional"},
            "parameter": _model_options("artemis:FitParameter"),
            "path": _model_options("artemis:FitPath"),
            "path_from_feff_job": _model_options("artemis:FeffJobPath"),
            "transform": _model_options("artemis:FitTransform"),
            "disorder": {
                "units": "sigma2 in Å²; T and theta in K",
                "expressions": ["sig2", "0.003", "sigma2_eins(T, theta_e)",
                                "sigma2_debye(T, theta_d)",
                                "sig2_static + sigma2_eins(T, theta_e)",
                                "sig2_static + sigma2_debye(T, theta_d)"],
                "aliases": {"eins": "sigma2_eins", "debye": "sigma2_debye"},
                "scope": "sigma2 fields only, not global Defs; uses each current FEFF path's masses and geometry.",
                "constraints": "T >= 0, theta > 0. Fix measured T. At one T constrain static disorder or theta. Shared names couple paths.",
                "engine": "Larch Einstein / Python FEFF6 correlated Debye",
            },
            "notes": [
                "Each path's s02, e0, deltar and sigma2 are expressions, and default to the "
                "parameter names amp, del_e0, del_r and sig2. Define those four as guesses and "
                "every path shares them; give a path its own names to fit it separately.",
                "kind 'guess' is fitted between min and max, 'set' is held at value, 'def' is "
                "computed from expression. Bounds apply to guesses only.",
                "A path is the filename and content of a FEFF feffNNNN.dat, plus an id you "
                "choose; unlisted keys, such as a FEFF job's metadata, are rejected. A path from a "
                "FEFF job can be named instead, as path_from_feff_job: {id, feff_job, "
                "feff_path: 'feff0001'}, and the server reads the file out of the job. Jobs are "
                "kept 24 hours.",
                "kweight is a list even for one weight: [2], not 2. Several weights fit "
                "together.",
                "The transform defaults are this route's, not the group's: k 3-12 whatever the "
                "group's own kmax is. FEFF's paths stop at k 20, and Larch refuses a kmax past "
                "the data's.",
                "GET /api/artemis/examples/cuprite is a complete body for the Cu2O group, "
                "paths included; merge path_parameters[i] into paths[i].",
            ],
        },
        "feff_job": {
            "post": "/api/artemis/feff/jobs?view=summary",
            "body": _model_options("artemis_structures:FeffJobRequest"),
            "notes": [
                "Send amcsd_id, absorber and site_index; the project_id, attachment_id and "
                "version trio is for a CIF attached to a project instead.",
                "site_index counts from 1, as the structure's sites[].index does, and must name "
                "a site of the absorber element.",
                "path_radius may not exceed cluster_radius. 3 A keeps the first shell of most "
                "metals and oxides.",
                "Poll with ?view=summary for scatterers, degeneracy and reff; full replies include "
                "CIF, logs and path files. Fits can reference paths by job and path ID.",
                "Identical requests reuse completed jobs for 23 hours (200, reused=true). "
                "Changing fit ranges does not require another FEFF calculation.",
            ],
        },
        "fit_reply": NOTE,
    }
