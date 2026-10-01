"""Shared references retain independent links and apply calibration atomically."""

from copy import deepcopy
from io import StringIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_preprocessing import ImportPreprocessing
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def workspace(tmp_path, xas_arrays):
    store = AthenaStore(Settings(data_root=tmp_path))
    original = store.create()
    project = deepcopy(original)
    x, y = xas_arrays
    for label, shift in (("sample A", 0), ("sample B", 0), ("sample C", 0),
                         ("foil", 2), ("other foil", -1)):
        project["groups"].append(store.make_group(label, x, y, parameters={
            "energy_shift": shift, "e0": 8980 + shift}))
    return store, store.save(project, original, "Measured spectra")


def run(store, project, action, indices=(), **options):
    return store.command(project["id"], Command(version=project["version"], action=action,
        group_ids=[project["groups"][index]["id"] for index in indices], options=options))


def assign(store, project, indices, reference=3, action="assign_reference"):
    return run(store, project, action, indices,
               reference_id=project["groups"][reference]["id"] if reference is not None else None)


@pytest.mark.parametrize("action", ["assign_reference", "metadata"])
def test_multiple_samples_share_reference_without_removing_existing_consumers(workspace, action):
    store, project = workspace
    original = deepcopy(project)
    project = assign(store, project, [0], action=action)
    project = assign(store, project, [1, 2], action=action)
    reference = project["groups"][3]
    assert [group["reference_id"] for group in project["groups"][:3]] == [reference["id"]] * 3
    assert reference == original["groups"][3]
    assert project["groups"][4] == original["groups"][4]
    for group, before in zip(project["groups"][:3], original["groups"][:3], strict=True):
        assert group["parameters"]["energy_shift"] == 2
        assert group["parameters"]["e0"] == 8982
        assert group["energy"] == before["energy"] and group["mu"] == before["mu"]
        np.testing.assert_allclose(group["result"]["arrays"]["energy"], np.asarray(before["energy"]) + 2)
    assert AthenaStore(store.settings).load(project["id"]) == project


def test_reassignment_preserves_old_shared_reference_family_and_undo(workspace):
    store, project = workspace
    project = assign(store, project, [0, 1, 2])
    before = deepcopy(project)
    project = assign(store, project, [0], reference=4)
    assert project["groups"][0]["reference_id"] == project["groups"][4]["id"]
    assert project["groups"][0]["parameters"]["energy_shift"] == -1
    assert project["groups"][1:] == before["groups"][1:]
    restored = run(store, project, "undo")
    assert restored["groups"] == before["groups"]


@pytest.mark.parametrize("action", ["assign_reference", "metadata", "untie_reference"])
def test_removing_one_link_preserves_other_samples_and_calibration(workspace, action):
    store, project = workspace
    project = assign(store, project, [0, 1, 2])
    before = deepcopy(project)
    project = (run(store, project, action, [0]) if action == "untie_reference"
               else assign(store, project, [0], reference=None, action=action))
    assert project["groups"][0]["reference_id"] is None
    assert project["groups"][0]["parameters"] == before["groups"][0]["parameters"]
    assert project["groups"][1:] == before["groups"][1:]
    project = run(store, project, "parameters", [3], energy_shift=4)
    assert [group["parameters"]["energy_shift"] for group in project["groups"]] == [2, 4, 4, 4, -1]


def test_shared_reference_shift_calibration_propagates_and_delete_clears_links(workspace):
    store, project = workspace
    project = assign(store, project, [0, 1, 2])
    project = run(store, project, "parameters", [0], energy_shift=3)
    assert [group["parameters"]["energy_shift"] for group in project["groups"]] == [3, 3, 3, 3, -1]
    project = run(store, project, "calibrate", [3], observed=8980, target=8984)
    assert [group["parameters"]["energy_shift"] for group in project["groups"]] == [4, 4, 4, 4, -1]
    before = deepcopy(project)
    project = run(store, project, "delete", [3])
    assert all(group["reference_id"] is None for group in project["groups"])
    assert run(store, project, "undo")["groups"] == before["groups"]


def test_legacy_tie_retains_sample_shift_and_other_reference_consumers(workspace):
    store, project = workspace
    project = assign(store, project, [0, 1])
    project = run(store, project, "tie_reference", [2, 3])
    assert [group["reference_id"] for group in project["groups"][:3]] == [project["groups"][3]["id"]] * 3
    assert [group["parameters"]["energy_shift"] for group in project["groups"][:4]] == [0] * 4


@pytest.mark.parametrize("operation", ["add", "remove", "reassign"])
def test_legacy_reciprocal_pair_can_be_shared_detached_or_reassigned(workspace, operation):
    store, project = workspace
    project = assign(store, project, [0])
    old = deepcopy(project)
    project["groups"][3]["reference_id"] = project["groups"][0]["id"]
    project = store.save(project, old, "Legacy reciprocal pair")
    if operation == "add":
        project = assign(store, project, [1])
        assert project["groups"][0]["reference_id"] == project["groups"][3]["id"]
        assert project["groups"][1]["reference_id"] == project["groups"][3]["id"]
    else:
        project = assign(store, project, [0], reference=None if operation == "remove" else 4)
        assert project["groups"][0]["reference_id"] == (None if operation == "remove" else project["groups"][4]["id"])
    assert project["groups"][3]["reference_id"] is None
    assert project["groups"][3]["parameters"]["energy_shift"] == 2


def test_new_reference_cycles_are_rejected_atomically(workspace):
    store, project = workspace
    project = assign(store, project, [0], reference=1)
    project = assign(store, project, [1], reference=3)
    with pytest.raises(WebInputError, match="cycle"):
        assign(store, project, [3], reference=0)
    assert store.load(project["id"]) == project


@pytest.mark.parametrize("case", ["self", "missing", "chi_sample", "chi_reference", "missing_option", "invalid_option"])
def test_invalid_assignment_is_atomic(workspace, case):
    store, project = workspace
    if case.startswith("chi_"):
        old = deepcopy(project)
        k = np.arange(0, 12, .05)
        index = 0 if case == "chi_sample" else 3
        project["groups"][index] = store.make_group("chi", k, np.sin(k), data_type="chi")
        project = store.save(project, old, "Chi spectrum")
    options = {"reference_id": project["groups"][3]["id"]}
    if case == "self":
        options["reference_id"] = project["groups"][0]["id"]
    elif case == "missing":
        options["reference_id"] = "missing"
    elif case == "missing_option":
        options = {}
    elif case == "invalid_option":
        options["reference_id"] = True
    with pytest.raises(WebInputError):
        run(store, project, "assign_reference", [0], **options)
    assert store.load(project["id"]) == project


def test_frozen_sample_blocks_shift_but_frozen_reference_can_be_used(workspace):
    store, project = workspace
    project = run(store, project, "metadata", [0], frozen=True)
    with pytest.raises(WebInputError, match="Unfreeze"):
        assign(store, project, [0, 1])
    assert store.load(project["id"]) == project
    project = run(store, project, "metadata", [0], frozen=False)
    project = run(store, project, "metadata", [3], frozen=True)
    project = assign(store, project, [0, 1])
    assert [group["parameters"]["energy_shift"] for group in project["groups"][:2]] == [2, 2]
    with pytest.raises(WebInputError, match="Unfreeze"):
        run(store, project, "parameters", [0], energy_shift=3)
    assert store.load(project["id"]) == project
    project = run(store, project, "metadata", [0], frozen=True)
    project = assign(store, project, [0], reference=None)
    assert project["groups"][0]["reference_id"] is None


@pytest.mark.parametrize("format", ["json", "prj"])
def test_shared_references_survive_project_exchange_with_remapped_ids(workspace, format):
    store, project = workspace
    project = assign(store, project, [0, 1, 2])
    payload = store.export_project(project["id"], format)
    target = store.create()
    restored = store.restore(target["id"], target["version"], payload, f"shared.{format}")
    assert {group["id"] for group in restored["groups"]}.isdisjoint({group["id"] for group in project["groups"]})
    assert [group["reference_id"] for group in restored["groups"][:3]] == [restored["groups"][3]["id"]] * 3
    assert restored["groups"][3]["reference_id"] is None


def test_assign_reference_http_contract(workspace):
    store, project = workspace
    with TestClient(create_app(store.settings)) as client:
        response = client.post(f'/api/athena/projects/{project["id"]}/command', json={
            "version": project["version"], "action": "assign_reference",
            "group_ids": [group["id"] for group in project["groups"][:2]],
            "options": {"reference_id": project["groups"][3]["id"]}})
    assert response.status_code == 200, response.text
    assert [group["reference_id"] for group in response.json()["groups"][:2]] == [project["groups"][3]["id"]] * 2


def test_import_alignment_uses_explicit_shared_foil_instead_of_first_sibling(workspace, xas_arrays):
    store, project = workspace
    project = assign(store, project, [0, 1, 2])
    x, y = xas_arrays
    # The first sibling has a different chemical edge, so choosing it as a
    # reference would introduce an erroneous six-eV shift to the imported scan.
    original = deepcopy(project)
    project["groups"][0]["mu"] = np.interp(x - 6, x, y).tolist()
    store.process(project["groups"][0], project)
    project = store.save(project, original, "Different sample chemistry")
    stream = StringIO()
    np.savetxt(stream, np.column_stack([x + 3, np.interp(x - 4, x, y), y]),
               header="energy sample ref", fmt="%.17g")
    info = store.inspect(project["id"], stream.getvalue().encode(), "with-reference.dat")
    columns = {column["name"]: column["column_id"] for column in info["columns"]}
    request = ImportRequest(version=project["version"], upload_id=info["upload_id"],
        energy_column=columns["energy"], numerator=[columns["sample"]],
        reference_numerator=columns["ref"], reference_log=False,
        preprocessing=ImportPreprocessing(standard_id=project["groups"][1]["id"], align=True))
    result = store.import_data(project["id"], request)
    assert result["groups"][:5] == project["groups"]
    sample = result["groups"][5]
    alignment = sample["source"]["import_preprocessing"]["alignment"]
    assert alignment["used_references"] is True
    assert alignment["standard_id"] == project["groups"][3]["id"]
    assert alignment["energy_shift"] == pytest.approx(-1, abs=.03)


def test_copper_example_contains_honestly_labelled_shared_foil(workspace):
    store, _ = workspace
    project = run(store, store.create(), "example")
    reference = next(group for group in project["groups"] if group["label"] == "Cu foil · shared reference")
    measured = np.loadtxt(Path(__file__).parents[2] / "examples/xafsdata/cu_rt01.xmu")
    np.testing.assert_array_equal(reference["energy"], measured[:, 0])
    np.testing.assert_array_equal(reference["mu"], measured[:, 1])
    assert not reference["marked"] and reference["source"]["mapping"]["is_reference"]
    assert "2001-06-26" in reference["source"]["citation"]
    assert "do not represent simultaneous reference measurements" in reference["notes"]
    assert [group["reference_id"] for group in project["groups"][:3]] == [reference["id"]] * 3
    assert project["last_operation"]["artemis_example"]["group_id"] == project["groups"][3]["id"]
