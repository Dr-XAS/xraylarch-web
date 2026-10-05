import copy
import hashlib
import json

from xraylarch_web.agent_fixture import fixture


def test_fixture_preserves_raw_measurements_without_computed_arrays_or_answers():
    group = {"id": "one", "label": "foil", "energy": [10., 20.], "mu": [1., 2.],
             "source": {"filename": "foil.xmu", "citation": "fixture citation"},
             "parameters": {"e0": None, "kmax": None}, "marked": True,
             "reference_id": "ref", "result": {"norm": [99., 100.], "effective": {"e0": 15.}}}
    reference = {**copy.deepcopy(group), "id": "ref", "label": "reference", "reference_id": None}
    project = {"groups": [group, reference]}
    before = copy.deepcopy(project)
    payload = fixture(project, revision="test-revision", structure={"cif": "example cif"})
    assert project == before
    first = payload["spectra"][0]
    assert first["energy"] == group["energy"] and first["mu"] == group["mu"]
    assert first["parameters"] == {"e0": None, "kmax": None}
    assert first["reference_label"] == "reference"
    assert "result" not in first and "effective" not in first and "norm" not in first
    assert set(payload["tasks"]) == {"T1", "T2", "T3", "T4", "T5"}
    assert all(set(task) == {"prompt"} for task in payload["tasks"].values())
    encoded = json.dumps({"energy": first["energy"], "mu": first["mu"]}, separators=(",", ":"))
    assert first["measurement_sha256"] == hashlib.sha256(encoded.encode()).hexdigest()
    assert payload["structure"]["cif_sha256"] == hashlib.sha256(b"example cif").hexdigest()
