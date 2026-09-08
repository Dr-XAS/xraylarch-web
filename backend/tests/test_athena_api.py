"""Exercise Athena's real HTTP boundary, including scientific array serialization."""
from io import StringIO
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


def create(client):
    r = client.post("/api/athena/projects")
    assert r.status_code == 200, r.text
    return r.json()


def command(client, p, action, ids=(), **options):
    return client.post(f"/api/athena/projects/{p['id']}/command", json={
        "version": p["version"], "action": action, "group_ids": list(ids), "options": options})


def example(client):
    p = create(client)
    response = command(client, p, "example")
    assert response.status_code == 200, response.text
    return response.json()


def test_edge_catalog_and_e0_batch_through_http(client):
    catalog = client.get("/api/athena/edges", params={"element": "cu"})
    assert catalog.status_code == 200, catalog.text
    assert catalog.json()["element"] == "Cu"
    assert {item["edge"]: item["energy"] for item in catalog.json()["edges"]}["K"] == 8979
    assert client.get("/api/athena/edges", params={"element": "not-an-element"}).status_code == 400
    p = example(client)
    ids = [g["id"] for g in p["groups"]]
    response = command(client, p, "set_e0", ids, method="atomic", element="Cu", edge="K")
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["version"] == p["version"] + 1
    assert len(after["last_operation"]["e0_results"]) == 3
    assert all(g["parameters"]["e0"] == g["result"]["effective"]["e0"] == 8979 for g in after["groups"])
    assert all(g["parameters"]["energy_shift"] == 0 for g in after["groups"])
    invalid = command(client, after, "set_e0", ids, method="fraction", fraction=1.1)
    assert invalid.status_code == 400
    assert invalid.json()["error"]["recovery"]
    assert command(client, p, "set_e0", ids, method="manual", value=8980).status_code == 409
    assert client.get(f"/api/athena/projects/{p['id']}").json() == after


def _inspect_edge_policy_data(client, project, energy, mu):
    output = StringIO()
    np.savetxt(output, np.column_stack((energy, mu)), header="energy mu")
    response = client.post(f"/api/athena/projects/{project['id']}/inspect",
                           files={"file": ("policy-data.dat", output.getvalue().encode())})
    assert response.status_code == 200, response.text
    inspection = response.json()
    columns = {col["name"]: col["column_id"] for col in inspection["columns"]}
    return {"version": project["version"], "upload_id": inspection["upload_id"],
            "energy_column": columns["energy"], "numerator": [columns["mu"]]}


def test_import_edge_policy_is_request_scoped_and_exported_as_provenance(client, xas_arrays):
    p = create(client)
    body = _inspect_edge_policy_data(client, p, *xas_arrays)
    endpoint = f"/api/athena/projects/{p['id']}/import"
    first = client.post(endpoint, json=body)
    assert first.status_code == 200, first.text
    before = first.json()
    response = client.post(endpoint, json={**body, "version": before["version"],
        "edge_policy": {"element": "cu", "edge": "k", "fraction": 0.5}})
    assert response.status_code == 200, response.text
    enforced = response.json()
    assert enforced["groups"][0] == before["groups"][0]
    group = enforced["groups"][-1]
    assert group["source"]["edge_identity"] == {"element": "Cu", "edge": "K", "origin": "enforced"}
    assert group["source"]["edge_policy"] == {"element": "Cu", "edge": "K", "fraction": 0.5}
    assert group["source"]["e0_selection"]["seed_e0"] == 8979
    assert group["parameters"]["e0"] == group["result"]["effective"]["e0"]
    assert group["result"]["effective"]["element"] == "Cu"
    assert group["parameters"]["energy_shift"] == 0
    assert "edge_policy" not in enforced
    assert "edge_policy" not in group["source"]["mapping"]
    stopped = client.post(endpoint, json={**body, "version": enforced["version"], "edge_policy": None})
    assert stopped.status_code == 200, stopped.text
    off = stopped.json()
    assert off["groups"][:-1] == enforced["groups"]
    assert off["groups"][-1]["parameters"]["e0"] is None
    assert "edge_policy" not in off["groups"][-1]["source"]
    exported = client.get(f"/api/athena/projects/{p['id']}/export", params={"format": "json"})
    assert exported.status_code == 200
    assert exported.json()["groups"][1]["source"]["edge_policy"] == group["source"]["edge_policy"]
    bad_edge = client.post(endpoint, json={**body, "version": off["version"],
        "edge_policy": {"element": "Fe", "edge": "K"}})
    assert bad_edge.status_code == 400  # Fe K is outside these Cu scan energies.
    assert bad_edge.json()["error"]["recovery"]
    assert client.get(f"/api/athena/projects/{p['id']}").json() == off


@pytest.mark.parametrize("policy", [False, [], "Cu K", {}, {"element": "Cu"},
    {"element": "Cu", "edge": "K", "fraction": True},
    {"element": "Cu", "edge": "K", "fraction": 0},
    {"element": "Cu", "edge": "K", "fraction": 1.1},
    {"element": "Cu", "edge": "K", "unrecognized": "ignore"}])
def test_invalid_import_edge_policy_is_rejected_before_mutation(client, xas_arrays, policy):
    p = create(client)
    body = _inspect_edge_policy_data(client, p, *xas_arrays)
    response = client.post(f"/api/athena/projects/{p['id']}/import", json={**body, "edge_policy": policy})
    assert response.status_code == 422, response.text
    assert client.get(f"/api/athena/projects/{p['id']}").json() == p


def test_example_api_all_four_spaces_and_exchange_files(client):
    p = example(client)
    assert len(p["groups"]) == 3
    assert all(g["processing_error"] is None for g in p["groups"])
    gid = p["groups"][0]["id"]
    for space, axis in (("E", "energy"), ("k", "k"), ("R", "r"), ("q", "q")):
        response = client.get(f"/api/athena/projects/{p['id']}/groups/{gid}/export", params={"space": space})
        assert response.status_code == 200, response.text
        assert response.text.splitlines()[0].split(",")[0] == axis
        assert len(response.text.splitlines()) > 100
        assert "attachment" in response.headers["content-disposition"]
    exported = client.get(f"/api/athena/projects/{p['id']}/export?format=prj")
    assert exported.content[:2] == b"\x1f\x8b"
    target = create(client)
    restored = client.post(f"/api/athena/projects/{target['id']}/restore?version=0", files={"file": ("copper.prj", exported.content)})
    assert restored.status_code == 200, restored.text
    assert [g["label"] for g in restored.json()["groups"]] == [g["label"] for g in p["groups"]]
    listing = client.get("/api/athena/projects").json()
    assert {item["id"] for item in listing} == {p["id"], target["id"]}


def test_combination_exports_distinguish_scatter_from_measurement_error(client):
    p = example(client)
    ids = [g["id"] for g in p["groups"][:2]]
    response = command(client, p, "merge", ids, array="mu", weights=[1, 3], uncertainties=[.1, .2])
    assert response.status_code == 200, response.text
    p = response.json()
    merged = p["groups"][-1]
    response = client.get(f"/api/athena/projects/{p['id']}/groups/{merged['id']}/export?space=E")
    assert response.status_code == 200, response.text
    exported = np.genfromtxt(StringIO(response.text), delimiter=",", names=True)
    np.testing.assert_allclose(exported["mu"], merged["mu"])
    np.testing.assert_allclose(exported["population_stddev"], merged["source"]["stddev"])
    np.testing.assert_allclose(exported["measurement_uncertainty"], merged["source"]["uncertainty"])


def test_failed_normalization_does_not_prevent_exporting_an_exact_zero_sum(client):
    p = example(client)
    gid = p["groups"][0]["id"]
    p = command(client, p, "duplicate", [gid]).json()
    response = command(client, p, "sum", [gid, p["groups"][-1]["id"]], array="mu", weights=[1, -1])
    assert response.status_code == 200, response.text
    p = response.json()
    summed = p["groups"][-1]
    assert summed["processing_error"] and summed["result"] is None
    response = client.get(f"/api/athena/projects/{p['id']}/groups/{summed['id']}/export?space=E")
    assert response.status_code == 200, response.text
    exported = np.genfromtxt(StringIO(response.text), delimiter=",", names=True)
    assert exported.dtype.names == ("energy", "mu")
    np.testing.assert_array_equal(exported["mu"], np.zeros(len(summed["mu"])))


@pytest.mark.parametrize("action,options", [
    ("smooth", {"window": 7, "order": 2}),
    ("deglitch", {"xmin": 9100, "xmax": 9110}),
    ("truncate", {"xmin": 8800, "xmax": 11000}),
    ("rebin", {"e0": 8978, "pre_step": 5, "xanes_step": 1, "exafs_kstep": .1}),
    ("convolve", {"form": "gaussian", "width": 1}),
    ("deconvolve", {"form": "gaussian", "width": 1, "xmin": 8950, "xmax": 9100}),
    ("self_absorption", {"formula": "Cu", "element": "Cu", "edge": "K", "angle_in": 45, "angle_out": 45}),
    ("dispersive", {"offset": 1, "linear": 1, "quadratic": 0}),
    ("multi_electron", {"method": "arctangent", "e0": 8978, "shift": 100, "amplitude": .03, "width": 2, "edge_step": 2.3}),
])
def test_transform_dialog_payloads_create_a_finite_derived_group(client, action, options):
    p = example(client)
    original = p["groups"][0]
    response = command(client, p, action, [original["id"]], **options)
    assert response.status_code == 200, response.text
    next = response.json()
    assert len(next["groups"]) == 4
    assert next["groups"][0] == original
    derived = next["groups"][-1]
    assert derived["source"]["operation"] == action
    assert np.isfinite(derived["energy"]).all() and np.isfinite(derived["mu"]).all()
    assert derived["processing_error"] is None, derived["processing_error"]
    if action == "self_absorption":
        np.testing.assert_allclose(derived["result"]["arrays"]["norm"], derived["source"]["details"]["normalized_mu"], rtol=0, atol=0)


def test_analysis_routes_persist_reports_without_changing_source_revision(client, xas_arrays):
    p = create(client)
    x = xas_arrays[0]
    first = 1 / (1 + np.exp(-(x - 8978) / 3))
    second = 1 / (1 + np.exp(-(x - 8990) / 4))
    for label, y in (("target", .3 * first + .7 * second), ("standard A", first), ("standard B", second)):
        data = StringIO()
        np.savetxt(data, np.column_stack((x, y)), header="energy mu")
        inspected = client.post(f"/api/athena/projects/{p['id']}/inspect", files={"file": (label + ".dat", data.getvalue().encode())}).json()
        response = client.post(f"/api/athena/projects/{p['id']}/import", json={"version": p["version"],
            "upload_id": inspected["upload_id"], "energy_column": inspected["columns"][0]["column_id"],
            "numerator": [inspected["columns"][1]["column_id"]], "data_type": "norm"})
        assert response.status_code == 200, response.text
        p = response.json()
    ids = [g["id"] for g in p["groups"]]
    for action in ("lcf", "pca", "peaks"):
        options = {"xmin": 8960, "xmax": 9020, "array": "norm"}
        if action == "peaks":
            options.update(array="dmude", peaks=[{"center": 8978, "sigma": 3, "amplitude": .3, "kind": "gaussian"},
                                                 {"center": 8990, "sigma": 4, "amplitude": .7, "kind": "gaussian"}])
        response = client.post(f"/api/athena/projects/{p['id']}/analyze", json={"version": p["version"], "action": action,
            "group_ids": ids if action != "peaks" else ids[:1], "options": options})
        assert response.status_code == 200, response.text
        result = response.json()["result"]
        if action == "lcf":
            np.testing.assert_allclose(result["weights"], [.3, .7], atol=1e-6)
        elif action == "pca":
            assert sum(result["explained_variance_ratio"]) == pytest.approx(1)
        else:
            assert np.isfinite(result["fit"]).all()
    restored = client.get(f"/api/athena/projects/{p['id']}").json()
    reports = restored.pop("analyses")
    p.pop("analyses", None)
    assert restored == p
    assert [r["kind"] for r in reports] == ["lcf", "pca", "peaks"]
    assert all(r["project_version"] == p["version"] for r in reports)
    assert len({r["id"] for r in reports}) == 3


def test_bad_requests_and_stale_writes_return_actionable_errors(client):
    p = example(client)
    gid = p["groups"][0]["id"]
    invalid = command(client, p, "parameters", [gid], rmin=5, rmax=1)
    assert invalid.status_code == 400
    assert "rmax" in invalid.json()["error"]["message"]
    old = dict(p, version=0)
    conflict = command(client, old, "delete", [gid])
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "stale_revision"
    malformed = client.post(f"/api/athena/projects/{p['id']}/restore?version={p['version']}", files={"file": ("bad.prj", b"# Athena project file -- Demeter version 0.9.26\n@x = invalid(;")})
    assert malformed.status_code == 400
    assert client.get(f"/api/athena/projects/{p['id']}").json() == p
