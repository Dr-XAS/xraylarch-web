"""A small bundled library of XANES reference standards, and shape matching against it.

The library is a manifest, not a copy of the data: each entry names one record
inside one of the Athena project files already shipped in `examples/`, by the
stable group key the native format gives it. Nothing is duplicated into the
package, and a reference the user adds to a project is read from the example
file at that moment.

Matching a reference to an unknown here is a single-component linear fit with a
free scale (`sum_to_one=False`), which asks "does this standard have the right
shape?" independently of how either edge step was normalized. That is the right
question when deciding which standards are worth putting into a combination
fit, but it is a different question from the one the combination search asks,
so the R-factors from the two are not comparable with each other.
"""
from __future__ import annotations

import gzip
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from .athena_science import ScientificError, linear_combination

_MANIFEST = json.loads(Path(__file__).with_name("athena_reference_library.json").read_text(encoding="utf-8"))
EXAMPLES = Path(__file__).resolve().parents[2] / "examples"
COLLECTION: str = _MANIFEST["collection"]
CITATION: str = _MANIFEST["citation"]
REFERENCES: tuple[dict, ...] = tuple(_MANIFEST["references"])
DESCRIPTIVE_KEYS = ("id", "name", "formula", "element", "edge", "oxidation_state", "technique")


def catalogue(element=None, edge=None) -> list[dict]:
    """Every bundled reference, or only those measured at one element and edge."""
    wanted_element = str(element).strip().lower() if element else None
    wanted_edge = str(edge).strip().lower() if edge else None
    return [dict(entry) for entry in REFERENCES
            if (wanted_element is None or entry["element"].lower() == wanted_element)
            and (wanted_edge is None or entry["edge"].lower() == wanted_edge)]


def families() -> list[dict]:
    """The element/edge pairs the library covers, with how many standards each has."""
    counts: dict[tuple[str, str], int] = {}
    for entry in REFERENCES:
        counts[(entry["element"], entry["edge"])] = counts.get((entry["element"], entry["edge"]), 0) + 1
    return [{"element": element, "edge": edge, "count": count}
            for (element, edge), count in sorted(counts.items())]


def find(reference_id) -> dict | None:
    """The manifest entry with this id, or None."""
    for entry in REFERENCES:
        if entry["id"] == reference_id:
            return dict(entry)
    return None


@lru_cache(maxsize=8)
def _records(filename: str) -> tuple[dict, bool]:
    """One example project file: its records by native group name, and who wrote it.

    Larch's project writer emits a Demeter header but stores the normalization
    order as a polynomial degree rather than Demeter's degree-plus-one, so the
    recipe cannot be read without knowing which program wrote the file. The
    import path decides this from the header; reading it here the same way is
    what makes a library standard identical to the imported group.
    """
    from .athena import _native_perl_document  # Lazy: athena imports this module.

    path = EXAMPLES / filename
    if not path.is_file():
        raise ScientificError(f"The bundled reference data file {filename} is not in this installation.")
    data = path.read_bytes()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    text = data.decode("utf-8-sig")
    larch_writer = any(line.startswith("# Using Larch version ") for line in text.splitlines()[:4])
    records = _native_perl_document(text)[0]
    return {record["old_group"]: record for record in records}, larch_writer


def reference_spectrum(entry: dict) -> dict:
    """One bundled reference: energy, mu, the recipe its author saved, and warnings.

    Using the native normalization parameters rather than letting the defaults
    reprocess the spectrum makes a library standard identical to the group you
    would get by importing the example project yourself, including the energy
    shift the author applied to align it. Native recipes carry settings that
    only the measured range can resolve, so they go through the same resolution
    the import path uses; whatever it had to change is returned as warnings
    rather than applied silently.

    No further shift is applied. The chemical shift between oxidation states is
    the signal a XANES fit lives on, so aligning standards onto the unknown's
    edge would throw away what distinguishes them.
    """
    from .athena import _native_parameters, _native_processing_limits  # Lazy: athena imports this module.

    records, larch_writer = _records(entry["file"])
    record = records.get(entry["group"])
    if record is None:
        raise ScientificError(f"Reference {entry['id']} names a group that {entry['file']} does not contain.")
    args = record.get("args", {})
    if args.get("datatype") == "chi" or str(args.get("is_chi", "0")) not in ("", "0", "None"):
        raise ScientificError(f"Reference {entry['id']} is chi(k) data, which is not a XANES standard.")
    energy = np.asarray(record["x"], dtype=float)
    parameters = _native_parameters(args, larch_writer=larch_writer)
    resolution: dict = {"native": {}, "warnings": []}
    _native_processing_limits(parameters, energy, "mu", resolution)
    return {"energy": energy, "mu": np.asarray(record["y"], dtype=float),
            "parameters": parameters, "warnings": resolution["warnings"]}


def rank_references(target: tuple, candidates: list[tuple], xmin, xmax, top=10) -> dict:
    """Rank candidate standards by how well each alone reproduces the unknown's shape.

    `candidates` holds (entry, energy, mu) triples, normalized the same way the
    target was. Each is fitted on its own with a free nonnegative scale over the
    same window, so the R-factors rank like with like. A standard whose measured
    range does not cover the window cannot be fitted there and is reported in
    `skipped` with the reason, rather than failing the whole suggestion.

    `scale` is the fitted multiplier. It establishes neither that the shapes
    agree (the R-factor ranks that) nor how much of the species is present: a
    scale away from 1 can come from a different edge-step normalization, a
    mixture, or a poor match.
    """
    ranked, skipped = [], []
    for entry, energy, mu in candidates:
        try:
            fit = linear_combination(target[0], target[1], [(energy, mu)], xmin, xmax,
                                     sum_to_one=False, nonnegative=True)
        except ScientificError as error:
            skipped.append({**{key: entry[key] for key in DESCRIPTIVE_KEYS if key in entry},
                            "reason": str(error)})
            continue
        ranked.append({**{key: entry[key] for key in DESCRIPTIVE_KEYS if key in entry},
                       "rfactor": fit["rfactor"], "scale": float(fit["weights"][0]),
                       "points": len(fit["x"])})
    ranked.sort(key=lambda suggestion: suggestion["rfactor"])
    return {"suggestions": ranked[:int(top)], "skipped": skipped,
            "considered": len(ranked) + len(skipped),
            "ranking": "single standard, free nonnegative scale; not comparable with combination R-factors"}
