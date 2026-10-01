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
    "out; above about 0.9 they mean the pair is not separately determined by this data. Nothing was "
    "saved: the fit route reads the group and returns."
)

# How close to a bound counts as on it, as a fraction of the allowed span.
_AT_BOUND = 1e-3
_CORRELATION_FLOOR = 0.1


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
        "note": NOTE,
    })
