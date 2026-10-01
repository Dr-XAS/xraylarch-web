import hashlib

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pymatgen.core import Lattice, Structure

from xraylarch_web.artemis_shells import radial_shells, _distance_groups
from xraylarch_web.artemis_structures import structure_details
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.mark.parametrize("amcsd,element,site,counts,distances", [
    (13088, "Cu", 1, [12, 6, 24], [2.566798, 3.63, 4.445824]),
    (15851, "Cu", 1, [2, 12, 6], [1.841170, 3.006618, 3.525572]),
    (15851, "O", 2, [4, 12, 8], [1.841170, 3.525572, 3.682340]),
])
def test_native_periodic_radial_shells(amcsd, element, site, counts, distances):
    data = radial_shells(structure_details(amcsd)["cif"], element, site)
    assert [shell["coordination_number"] for shell in data["shells"][:3]] == counts
    assert [shell["r_mean"] for shell in data["shells"][:3]] == pytest.approx(distances, abs=1e-6)
    assert any(min(neighbor["image"]) < 0 for neighbor in data["neighbors"])
    ids = [index for shell in data["shells"] for index in shell["neighbor_ids"]]
    assert sorted(ids) == list(range(len(data["neighbors"])))
    for shell in data["shells"]:
        assert shell["r_max"] - shell["r_min"] <= data["tolerance"] + 1e-9
        assert sum(group["coordination_number"] for group in shell["groups"]) == shell["coordination_number"]


def test_complete_linkage_avoids_greedy_and_adjacent_chaining():
    assert _distance_groups([1, 1.05, 1.08], 0.06) == [[0], [1, 2]]


def test_split_octahedron_preserves_pair_groups_when_display_shells_merge():
    structure = Structure(Lattice.cubic(20), ["Cu"] + ["O"] * 6,
                          [[0, 0, 0], [2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2.2], [0, 0, -2.2]], coords_are_cartesian=True)
    cif = structure.to(fmt="cif")
    narrow = radial_shells(cif, "Cu", 1, 3, 0.1)
    wide = radial_shells(cif, "Cu", 1, 3, 0.25)
    assert [shell["coordination_number"] for shell in narrow["shells"]] == [4, 2]
    assert len(wide["shells"]) == 1
    assert sorted(group["coordination_number"] for group in wide["shells"][0]["groups"]) == [2, 4]
    assert [item["cartesian_offset"] for item in narrow["neighbors"]] == [item["cartesian_offset"] for item in wide["neighbors"]]
    translated = structure.copy()
    translated.translate_sites(range(len(structure)), [0.25, 0.3, 0.35], frac_coords=True)
    shifted = radial_shells(translated.to(fmt="cif"), "Cu", 1, 3, 0.25)
    assert sorted(group["coordination_number"] for group in shifted["shells"][0]["groups"]) == [2, 4]


def test_same_element_distance_does_not_imply_pair_equivalence():
    structure = Structure(Lattice.from_parameters(20, 21, 22, 87, 94, 103), ["Cu", "O", "O", "H"],
                          [[5, 6, 7], [7, 6, 7], [5, 8, 7], [8, 8, 8]], coords_are_cartesian=True)
    result = radial_shells(structure.to(fmt="cif"), "Cu", 1, 3, 0.05)
    assert result["shells"][0]["coordination_number"] == 2
    assert [group["coordination_number"] for group in result["shells"][0]["groups"]] == [1, 1]
    cuprite = radial_shells(structure_details(15851)["cif"], "Cu", 1)
    assert [group["coordination_number"] for group in cuprite["shells"][1]["groups"]] == [6, 6]


def test_oblique_cell_frames_and_empty_cutoff():
    structure = Structure(Lattice.from_parameters(10, 10, 10, 90, 110, 90), ["Cu", "O"], [[0, 0, 0], [0.2, 0, 0]])
    cif = structure.to(fmt="cif")
    neighbor = radial_shells(cif, "Cu", 1, 3)["neighbors"][0]
    assert neighbor["fractional_offset"] == pytest.approx([0.2, 0, 0])
    assert neighbor["cartesian_offset"] == pytest.approx([1.87938524, 0, -0.68404029], abs=1e-6)
    assert np.linalg.norm(neighbor["cartesian_offset"]) == pytest.approx(2)
    empty = radial_shells(cif, "Cu", 1, 1)
    assert empty["shells"] == []
    assert "No neighbors" in empty["warnings"][0]


def test_disorder_wrong_center_and_bound_fail():
    with pytest.raises(WebInputError, match="occupancies"):
        radial_shells(structure_details(1735)["cif"], "Ti", 1)
    with pytest.raises(WebInputError, match="belonging"):
        radial_shells(structure_details(15851)["cif"], "Cu", 2)
    cif = Structure(Lattice.cubic(0.5), ["Cu"], [[0, 0, 0]]).to(fmt="cif")
    with pytest.raises(WebInputError, match="too many periodic images"):
        radial_shells(cif, "Cu", 1, 12)


def test_api_snapshot_and_parameter_validation(tmp_path, monkeypatch):
    from xraylarch_web import artemis_structures
    cif = structure_details(13088)["cif"] + "\n# Exact project snapshot\n"
    monkeypatch.setattr(artemis_structures, "_connection", lambda: pytest.fail("No database read"))
    body = dict(cif=cif, absorber="Cu", site_index=1, radius=4.5, tolerance=0.05)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        result = client.post("/api/artemis/structures/radial-shells", json=body)
        assert result.status_code == 200, result.text
        assert result.json()["cif_sha256"] == hashlib.sha256(cif.encode()).hexdigest()
        assert len(result.json()["shells"]) == 3
        for changes in ({"radius": 0}, {"radius": 13}, {"tolerance": 0}, {"tolerance": 1}, {"site_index": True}, {"radius": "NaN"}, {"extra": 1}):
            assert client.post("/api/artemis/structures/radial-shells", json=body | changes).status_code == 422
