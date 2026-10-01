"""Absorber-centered periodic radial shells, independent of bond connectivity."""
from __future__ import annotations

import hashlib
import math
import warnings
from collections import Counter
from functools import lru_cache

from pydantic import Field

from .artemis_coordination import FirstShellRequest
from .errors import WebInputError

SYMMETRY_TOLERANCE = 1e-5  # Cartesian angstroms; separate from shell width.
MAX_NEIGHBORS = 2000


class RadialShellRequest(FirstShellRequest):
    radius: float = Field(default=6.0, ge=0.5, le=12.0, allow_inf_nan=False)
    tolerance: float = Field(default=0.05, ge=0.001, le=0.5, allow_inf_nan=False)


def _fail(message):
    raise WebInputError("invalid_radial_shells", message, fields=("cif", "site_index", "radius"),
                        recovery="Choose an ordered CIF and absorber site, or reduce the shell search radius.")


def _distance_groups(distances, tolerance):
    """Actual complete linkage, not adjacent-gap chaining or greedy bins."""
    import numpy as np
    from scipy.cluster.hierarchy import fcluster, linkage

    if not len(distances):
        return []
    if len(distances) == 1:
        return [[0]]
    labels = fcluster(linkage(np.asarray(distances).reshape(-1, 1), method="complete"),
                      t=tolerance, criterion="distance")
    groups = {}
    for index, label in enumerate(labels):
        groups.setdefault(int(label), []).append(index)
    return sorted(groups.values(), key=lambda group: min(distances[i] for i in group))


def _pair_orbits(structure, center, neighbors, messages):
    """Pair equivalence under operations fixing this absorber modulo translation."""
    import numpy as np
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
    from scipy.spatial import cKDTree

    parent = list(range(len(neighbors)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    try:
        operations = SpacegroupAnalyzer(structure, symprec=SYMMETRY_TOLERANCE).get_symmetry_operations()
    except Exception:
        messages.append("Crystal symmetry could not be determined; each neighbor retains a separate pair group.")
        return parent
    lattice = structure.lattice.matrix
    by_element = {}
    for index, item in enumerate(neighbors):
        by_element.setdefault(item["element"], []).append(index)
    for indices in by_element.values():
        fractional = np.array([neighbors[i]["fractional_offset"] for i in indices])
        cartesian = fractional @ lattice
        tree = cKDTree(cartesian)
        for op in operations:
            translation = op.operate(center.frac_coords) - center.frac_coords
            if np.linalg.norm((translation - np.rint(translation)) @ lattice) > SYMMETRY_TOLERANCE:
                continue
            transformed = (fractional @ op.rotation_matrix.T) @ lattice
            distances, matches = tree.query(transformed, distance_upper_bound=SYMMETRY_TOLERANCE)
            for source, distance, target in zip(indices, distances, matches):
                if math.isfinite(float(distance)):
                    left, right = root(source), root(indices[int(target)])
                    parent[max(left, right)] = min(left, right)
    return [root(index) for index in range(len(neighbors))]


@lru_cache(maxsize=16)
def radial_shells(cif: str, absorber: str, site_index: int, radius: float = 6.0, tolerance: float = 0.05):
    from larixite.cif_cluster import CIF_Cluster
    from .artemis_structures import _CONVERSION_LOCK, snapshot_details

    with _CONVERSION_LOCK, warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", UserWarning)
        details = snapshot_details({"cif": cif})
        if not details["supported"]:
            _fail(" ".join(details["warnings"]) or "This CIF is not supported for radial shells.")
        if not any(site["index"] == site_index and site["element"] == absorber for site in details["sites"]):
            _fail("Select a crystallographic site belonging to the chosen absorber.")
        try:
            cluster = CIF_Cluster(ciftext="# Radial shell snapshot\n" + cif, absorber=absorber)
            structure = cluster.struct
            center = cluster.unique_sites[site_index - 1][0]
            extents = [math.ceil(radius * value) for value in structure.lattice.reciprocal_lattice_crystallographic.abc]
            if len(structure) * math.prod(2 * value + 3 for value in extents) > 100_000:
                _fail("This unit cell requires too many periodic images. Reduce the shell search radius.")
            sites = structure.get_neighbors(center, radius)
            if len(sites) > MAX_NEIGHBORS:
                _fail(f"The shell search exceeds {MAX_NEIGHBORS} neighbors. Reduce the search radius.")
            neighbors = []
            for neighbor in sites:
                distance = float(neighbor.nn_distance)
                if distance <= 1e-8:
                    _fail("The structure contains overlapping atomic sites.")
                neighbors.append(dict(element=neighbor.specie.symbol, structure_index=int(neighbor.index),
                                      image=[int(round(v)) for v in neighbor.image],
                                      fractional_offset=[float(v) for v in neighbor.frac_coords - center.frac_coords],
                                      cartesian_offset=[float(v) for v in neighbor.coords - center.coords],
                                      distance=distance))
            neighbors.sort(key=lambda item: (item["distance"], item["element"], item["fractional_offset"]))
            messages = []
            orbits = _pair_orbits(structure, center, neighbors, messages) if neighbors else []
            shells = []
            for number, indices in enumerate(_distance_groups([n["distance"] for n in neighbors], tolerance), 1):
                items = [neighbors[i] for i in indices]
                pair_groups = {}
                for index in indices:
                    pair_groups.setdefault((neighbors[index]["element"], orbits[index]), []).append(index)
                groups = []
                for group_number, ((element, _), members) in enumerate(sorted(pair_groups.items()), 1):
                    group_id = f"{number}.{group_number}"
                    distances = [neighbors[i]["distance"] for i in members]
                    groups.append(dict(id=group_id, element=element, coordination_number=len(members),
                                       r_min=min(distances), r_max=max(distances), neighbor_ids=members))
                    for index in members:
                        neighbors[index].update(id=index, shell_index=number, group_id=group_id)
                distances = [item["distance"] for item in items]
                shells.append(dict(index=number, r_min=min(distances), r_max=max(distances),
                                   r_mean=sum(distances) / len(distances), coordination_number=len(items),
                                   elements=dict(Counter(item["element"] for item in items)),
                                   groups=groups, neighbor_ids=indices))
        except WebInputError:
            raise
        except Exception as exc:
            _fail(f"Could not determine radial shells: {str(exc)[:200]}")
    messages.extend(str(item.message) for item in caught if issubclass(item.category, UserWarning))
    if not neighbors:
        messages.append("No neighbors were found within the search radius.")
    if shells and radius - shells[-1]["r_max"] < tolerance:
        messages.append("The outer shell is close to the search cutoff and may be incomplete. Increase the radius to check it.")
    if any(item["element"] == "H" for item in neighbors):
        messages.append("Hydrogen is included in these shells; FEFF generation omits hydrogen.")
    return dict(method="complete_linkage", cif=cif, cif_sha256=hashlib.sha256(cif.encode()).hexdigest(),
                absorber=absorber, site_index=site_index, radius=radius, tolerance=tolerance,
                symmetry_tolerance=SYMMETRY_TOLERANCE, shells=shells, neighbors=neighbors,
                warnings=list(dict.fromkeys(messages)))
