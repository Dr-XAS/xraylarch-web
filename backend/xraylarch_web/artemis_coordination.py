"""CrystalNN coordination about the same crystallographic sites used by FEFF."""
from __future__ import annotations

import hashlib
import math
import re
import warnings
from functools import lru_cache
from importlib.metadata import version
from itertools import product

from pydantic import Field, field_validator

from .artemis import StrictModel
from .errors import WebInputError


class FirstShellRequest(StrictModel):
    cif: str = Field(min_length=40, max_length=500_000)
    absorber: str = Field(pattern=r"^[A-Z][a-z]?$")
    site_index: int = Field(ge=1, le=500)

    @field_validator("cif")
    @classmethod
    def cif_text(cls, value):
        if (len(value.encode("utf-8")) > 500_000 or "\x00" in value
                or not re.search(r"(?m)^\s*data_\S*", value) or "\n" not in value):
            raise ValueError("Supply full CIF text (at most 500 KB), not a file path.")
        return value


def _fail(message):
    raise WebInputError("invalid_first_shell", message, fields=("cif", "site_index"),
                        recovery="Choose an ordered CIF and an absorber site, then retry CrystalNN.")


@lru_cache(maxsize=32)
def first_shell(cif: str, absorber: str, site_index: int):
    # Cache by the exact snapshot, never by a mutable database/project identifier.
    from larixite.cif_cluster import CIF_Cluster
    from pymatgen.analysis.local_env import CrystalNN
    from .artemis_structures import _CONVERSION_LOCK, snapshot_details

    with _CONVERSION_LOCK, warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", UserWarning)
        details = snapshot_details({"cif": cif})
        if not details["supported"]:
            _fail(" ".join(details["warnings"]) or "This CIF is not supported by CrystalNN.")
        if not any(site["index"] == site_index and site["element"] == absorber for site in details["sites"]):
            _fail("Select a crystallographic site belonging to the chosen absorber.")
        try:
            cluster = CIF_Cluster(ciftext="# CrystalNN snapshot\n" + cif, absorber=absorber)
            structure = cluster.struct
            center = cluster.unique_sites[site_index - 1][0]
            center_index = structure.index(center)
            # Bound dense/small-cell Voronoi inputs before allocating periodic images.
            # VoronoiNN can expand its initial 7 Å search to the longest cell
            # diagonal. Bound that adaptive search too, including skewed cells.
            cutoff = max(7.0, max(math.sqrt(sum(sum(signs[i] * structure.lattice.matrix[i][axis]
                                                   for i in range(3)) ** 2 for axis in range(3)))
                                  for signs in product((-1, 1), repeat=3)) + 0.02)
            extents = [math.ceil(cutoff * length) for length in structure.lattice.reciprocal_lattice_crystallographic.abc]
            if len(structure) * math.prod(2 * extent + 3 for extent in extents) > 100_000:
                _fail("This unit cell requires too many periodic images for CrystalNN.")
            algorithm = CrystalNN(weighted_cn=False, cation_anion=False, distance_cutoffs=(0.5, 1),
                                  x_diff_weight=3.0, porous_adjustment=True, search_cutoff=7)
            data = algorithm.get_nn_data(structure, center_index)
            cn = max(data.cn_weights, key=data.cn_weights.get)
            neighbors = []
            for info in data.cn_nninfo[cn]:
                neighbor = info["site"]
                offset = neighbor.frac_coords - center.frac_coords
                neighbors.append(dict(element=neighbor.specie.symbol,
                                      structure_index=int(info["site_index"]),
                                      image=[int(round(value)) for value in info["image"]],
                                      fractional_offset=[float(value) for value in offset],
                                      cartesian_offset=[float(value) for value in neighbor.coords - center.coords],
                                      distance=float(math.dist(neighbor.coords, center.coords)),
                                      weight=float(info["weight"])))
        except WebInputError:
            raise
        except Exception as exc:
            _fail(f"CrystalNN could not determine this coordination environment: {str(exc)[:200]}")

    messages = list(dict.fromkeys(str(item.message) for item in caught if issubclass(item.category, UserWarning)))
    if not neighbors:
        messages.append("CrystalNN predicts zero bonded neighbors for this site. No first-shell paths are selected.")
    if any(neighbor["element"] == "H" for neighbor in neighbors):
        messages.append("This shell includes hydrogen. FEFF generation omits H atoms, so its paths cannot cover the full CrystalNN shell.")
    if float(data.cn_weights[cn]) < 0.8:
        messages.append("Several coordination environments have appreciable CrystalNN weights. Review the alternatives before choosing fit paths.")
    neighbors.sort(key=lambda item: (item["distance"], item["element"], item["fractional_offset"]))
    return dict(method="CrystalNN", pymatgen_version=version("pymatgen"),
                cif=cif, cif_sha256=hashlib.sha256(cif.encode("utf-8")).hexdigest(),
                absorber=absorber, site_index=site_index, coordination_number=int(cn),
                coordination_weight=float(data.cn_weights[cn]),
                alternatives=[dict(coordination_number=int(number), weight=float(weight))
                              for number, weight in sorted(data.cn_weights.items(), key=lambda item: -item[1])],
                neighbors=neighbors, warnings=messages,
                settings=dict(weighted_cn=False, cation_anion=False, distance_cutoffs=[0.5, 1.0],
                              x_diff_weight=3.0, porous_adjustment=True, search_cutoff=7.0))
