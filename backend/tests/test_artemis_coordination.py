"""Native CrystalNN chemistry and periodic/site identity contracts."""
import hashlib
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pymatgen.analysis.local_env import CrystalNN

from xraylarch_web.artemis_coordination import first_shell
from xraylarch_web.artemis_structures import structure_details
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.mark.parametrize("ident,element,site,cn,neighbor,distance", [
    (13088, "Cu", 1, 12, "Cu", 2.566798),
    (15851, "Cu", 1, 2, "O", 1.841170),
    (15851, "O", 2, 4, "Cu", 1.841170),
    (9994, "Fe", 1, 4, "O", 1.886047),
    (9994, "Fe", 2, 6, "O", 2.060677),
])
def test_native_coordination_uses_global_crystallographic_site(ident, element, site, cn, neighbor, distance):
    details = structure_details(ident)
    result = first_shell(details["cif"], element, site)
    assert result["coordination_number"] == len(result["neighbors"]) == cn
    assert {item["element"] for item in result["neighbors"]} == {neighbor}
    assert [item["distance"] for item in result["neighbors"]] == pytest.approx([distance] * cn, abs=1e-6)
    assert result["cif_sha256"] == hashlib.sha256(details["cif"].encode()).hexdigest()
    assert sum(item["weight"] for item in result["alternatives"]) == pytest.approx(1)
    assert 0 < result["coordination_weight"] <= 1
    json.dumps(result, allow_nan=False)


def test_periodic_offsets_preserve_distinct_images_and_distance():
    from larixite.cif_cluster import CIF_Cluster
    cif = structure_details(13088)["cif"]
    result = first_shell(cif, "Cu", 1)
    structure = CIF_Cluster(ciftext=cif).struct
    assert any(min(item["image"]) < 0 for item in result["neighbors"])
    assert len({(item["structure_index"], tuple(item["image"])) for item in result["neighbors"]}) == 12
    for item in result["neighbors"]:
        assert np.linalg.norm(np.array(item["fractional_offset"]) @ structure.lattice.matrix) == pytest.approx(item["distance"])


def test_disorder_and_wrong_absorber_fail_explicitly():
    with pytest.raises(WebInputError, match="occupancies"):
        first_shell(structure_details(1735)["cif"], "Ti", 1)
    with pytest.raises(WebInputError, match="belonging"):
        first_shell(structure_details(15851)["cif"], "Cu", 2)


def test_algorithm_failure_is_not_zero_coordination(monkeypatch):
    first_shell.cache_clear()
    def fail(*args):
        raise ValueError("No Voronoi neighbors found")
    monkeypatch.setattr(CrystalNN, "get_nn_data", fail)
    with pytest.raises(WebInputError, match="No Voronoi neighbors"):
        first_shell(structure_details(13088)["cif"], "Cu", 1)
    monkeypatch.setattr(CrystalNN, "get_nn_data", lambda *args: CrystalNN.NNData([], {0: 1.0}, {0: []}))
    result = first_shell(structure_details(13088)["cif"], "Cu", 1)
    assert result["coordination_number"] == 0
    assert any("zero" in message for message in result["warnings"])
    first_shell.cache_clear()


def test_api_analyzes_exact_snapshot_without_database(tmp_path, monkeypatch):
    from xraylarch_web import artemis_structures
    cif = structure_details(15851)["cif"] + "\n# a project-owned snapshot\n"
    monkeypatch.setattr(artemis_structures, "_connection", lambda: pytest.fail("Must not read AMCSD"))
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        response = client.post("/api/artemis/structures/first-shell", json={"cif": cif, "absorber": "Cu", "site_index": 1})
        assert response.status_code == 200, response.text
        assert response.json()["coordination_number"] == 2
        assert response.json()["cif_sha256"] == hashlib.sha256(cif.encode()).hexdigest()
        for changes in ({"cif": "/tmp/source.cif"}, {"site_index": 0}, {"site_index": True}, {"absorber": "xx"}, {"path": "bad"}):
            response = client.post("/api/artemis/structures/first-shell", json={"cif": cif, "absorber": "Cu", "site_index": 1} | changes)
            assert response.status_code == 422


def test_monoclinic_neighbors_keep_both_coordinate_frames():
    from pymatgen.core import Lattice, Structure
    lattice = Lattice.from_parameters(10, 10, 10, 90, 110, 90)
    cif = Structure(lattice, ["Cu", "O"], [[0, 0, 0], [0.2, 0, 0]]).to(fmt="cif")
    result = first_shell(cif, "Cu", 1)
    neighbor = result["neighbors"][0]
    assert neighbor["fractional_offset"] == pytest.approx([0.2, 0, 0])
    assert neighbor["cartesian_offset"] == pytest.approx([1.87938524, 0, -0.68404029], abs=1e-6)
    assert neighbor["distance"] == pytest.approx(2)


def test_adaptive_voronoi_candidate_bound_precedes_algorithm(monkeypatch):
    from pymatgen.core import Lattice, Structure
    cif = Structure(Lattice.orthorhombic(2, 2, 200), ["Cu"], [[0, 0, 0]]).to(fmt="cif")
    monkeypatch.setattr(CrystalNN, "get_nn_data", lambda *args: pytest.fail("Must reject before adaptive Voronoi search"))
    with pytest.raises(WebInputError, match="too many periodic images"):
        first_shell(cif, "Cu", 1)
