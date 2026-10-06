"""Exercise Athena's real HTTP boundary, including scientific array serialization."""
from io import StringIO
import hashlib
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


def test_uploaded_group_preserves_sanitized_parse_provenance(client):
    project = create(client)
    raw = ("energy i0 it\n" + "".join(
        f"{100 + index} {10 + index} {5 + index / 2}\n" for index in range(12)
    )).encode()
    inspected = client.post(
        f"/api/athena/projects/{project['id']}/inspect",
        files={"file": ("../unsafe sample.dat", raw)},
    ).json()
    columns = {column["name"]: column["column_id"] for column in inspected["columns"]}

    imported = client.post(
        f"/api/athena/projects/{project['id']}/import",
        json={
            "version": 0,
            "upload_id": inspected["upload_id"],
            "energy_column": columns["energy"],
            "numerator": [columns["i0"]],
            "denominator": columns["it"],
            "mode": "transmission",
        },
    )

    assert imported.status_code == 200, imported.text
    source = imported.json()["groups"][0]["source"]
    assert source["original_filename"] == "unsafe sample.dat"
    assert source["source_sha256"] == hashlib.sha256(raw).hexdigest()
    assert source["parser_identity"] == "xraylarch.parse_upload"
    assert source["parse_metadata"] == {"row_count": 12, "column_count": 3}


def test_selected_group_export_recursively_redacts_sensitive_keys(tmp_path):
    from xraylarch_web.athena import AthenaStore

    configured = Settings(data_root=tmp_path)
    store = AthenaStore(configured)
    with TestClient(create_app(configured)) as client:
        project = example(client)
    group = project["groups"][0]
    group["source"]["native"] = {
        "path": "/private/source",
        "fields": [{"owner": "person", "safe": "kept"}],
    }
    project["analyses"] = [{
        "id": "analysis-1",
        "group_ids": [group["id"]],
        "project_version": project["version"],
        "options": {"cache_path": "/private/cache", "nested": [{"handle": "secret"}]},
        "result": {"identity": "secret", "value": 7},
    }]
    store.storage.write_json(project["id"], "project.json", project)

    exported = store.export_selected_groups(project["id"], [group["id"]])

    encoded = json.dumps(exported)
    assert "/private" not in encoded
    assert "secret" not in encoded
    assert exported["groups"][0]["source"]["native"]["fields"] == [{"safe": "kept"}]
    assert exported["analyses"][0]["result"] == {"value": 7}


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
    assert len(after["last_operation"]["e0_results"]) == len(ids)
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


def test_group_edge_identity_http_preserves_science_and_rejects_invalid_edits(client):
    p = example(client)
    ident = p["groups"][0]["id"]
    response = command(client, p, "edge_identity", [ident], element="fe", edge="l3")
    assert response.status_code == 200, response.text
    after = response.json()
    expected = json.loads(json.dumps(p["groups"]))
    expected[0]["source"]["edge_identity"] = {"element": "Fe", "edge": "L3", "origin": "selected"}
    expected[0]["result"]["effective"].update(element="Fe", edge="L3")
    assert after["groups"] == expected
    for invalid in ({"element": "Cu", "edge": "L9"}, {"element": "Cu", "edge": "K", "e0": 8979}):
        rejected = command(client, after, "edge_identity", [ident], **invalid)
        assert rejected.status_code == 400
        assert rejected.json()["error"]["recovery"]
        assert client.get(f"/api/athena/projects/{p['id']}").json() == after
    frozen = command(client, after, "metadata", [ident], frozen=True).json()
    assert command(client, frozen, "edge_identity", [ident], element="Cu", edge="K").status_code == 400
    assert client.get(f"/api/athena/projects/{p['id']}").json() == frozen
    assert command(client, p, "edge_identity", [ident], element="Cu", edge="K").status_code == 409


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
    assert len(p["groups"]) == 5
    assert [folder["name"] for folder in p["group_folders"]] == ["Temperature series", "reference"]
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
    assert [folder["name"] for folder in restored.json()["group_folders"]] == ["Temperature series", "reference"]
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
    original_ids = {g["id"] for g in p["groups"]}
    p = command(client, p, "duplicate", [gid]).json()
    duplicate_id = next(g["id"] for g in p["groups"] if g["id"] not in original_ids)
    response = command(client, p, "sum", [gid, duplicate_id], array="mu", weights=[1, -1])
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
    ("multi_electron", {"method": "arctangent", "shift": 100, "amplitude": .03, "width": 2}),
])
def test_transform_dialog_payloads_create_a_finite_derived_group(client, action, options):
    p = example(client)
    original = p["groups"][0]
    response = command(client, p, action, [original["id"]], **options)
    assert response.status_code == 200, response.text
    next = response.json()
    inplace = action in ('deglitch', 'truncate')
    assert len(next["groups"]) == len(p["groups"]) + (0 if inplace else 1)
    if inplace:
        assert next['groups'][1:] == p['groups'][1:]
        assert next['groups'][0]['id'] == original['id']
        assert len(next['groups'][0]['mu']) < len(original['mu'])
    else:
        assert next["groups"][0] == original
    original_ids = {group["id"] for group in p["groups"]}
    derived = next['groups'][0] if inplace else [
        group for group in next["groups"] if group["id"] not in original_ids
    ][0]
    assert (derived["source"]["point_edits"][-1]["action"] if inplace else derived["source"]["operation"]) == action
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


def mixture_project(client, x, mixture, references):
    """Import a target spectrum followed by its candidate references."""
    p = create(client)
    for label, y in (("target", mixture), *references):
        data = StringIO()
        np.savetxt(data, np.column_stack((x, y)), header="energy mu")
        inspected = client.post(f"/api/athena/projects/{p['id']}/inspect",
                                files={"file": (label + ".dat", data.getvalue().encode())}).json()
        response = client.post(f"/api/athena/projects/{p['id']}/import", json={"version": p["version"],
            "upload_id": inspected["upload_id"], "energy_column": inspected["columns"][0]["column_id"],
            "numerator": [inspected["columns"][1]["column_id"]], "data_type": "norm"})
        assert response.status_code == 200, response.text
        p = response.json()
    return p


def test_combination_search_route_picks_the_right_references_with_errors(client, xas_arrays):
    """Catches a search route that cannot reject a reference absent from the mixture."""
    x = xas_arrays[0]
    edges = {name: 1 / (1 + np.exp(-(x - centre) / width)) for name, centre, width in
             (("A", 8978, 3.0), ("B", 8990, 4.0), ("C", 9005, 2.0), ("decoy", 8955, 1.0))}
    mixture = .3 * edges["A"] + .7 * edges["B"] + np.random.default_rng(0).normal(0, 2e-3, x.size)
    p = mixture_project(client, x, mixture, list(edges.items()))
    ids = [g["id"] for g in p["groups"]]
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json={
        "version": p["version"], "action": "lcf_search", "group_ids": ids,
        "options": {"xmin": 8960, "xmax": 9020, "array": "norm", "max_components": 2, "top": 3}})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["labels"] == ["A.dat", "B.dat", "C.dat", "decoy.dat"]
    best = result["combinations"][0]
    assert [result["labels"][i] for i in best["indices"]] == ["A.dat", "B.dat"]
    np.testing.assert_allclose(best["weights"], [.3, .7], atol=5e-3)
    assert all(stderr is not None and 0 < stderr < .05 for stderr in best["weight_stderr"])
    assert result["tried"] == 4 + 6 and result["skipped"] == 0
    assert [entry["rfactor"] for entry in result["combinations"]] == sorted(
        entry["rfactor"] for entry in result["combinations"])
    np.testing.assert_allclose(result["best"]["weights"], best["weights"])
    assert len(result["best"]["fit"]) == len(result["best"]["x"])
    assert client.get(f"/api/athena/projects/{p['id']}").json()["analyses"][-1]["kind"] == "lcf_search"


def test_series_lcf_tracks_known_weights_scan_by_scan_and_names_a_scan_it_cannot_fit(client, xas_arrays):
    """An operando series against fixed end members, with one short scan in it.

    The weights of A move 0.2 -> 0.5 -> 0.8 through the series and each row must
    recover its own; the short scan keeps its row with the reason rather than
    failing the series, and a group ticked as both target and standard is refused.
    """
    x = xas_arrays[0]
    a, b = (1 / (1 + np.exp(-(x - centre) / width)) for centre, width in ((8978, 3.0), (8990, 4.0)))
    targets = [(f"scan {i}", w * a + (1 - w) * b) for i, w in enumerate((0.2, 0.5, 0.8), start=1)]
    p = mixture_project(client, x, a, [("B", b), *targets])
    short = x < 8990
    data = StringIO()
    np.savetxt(data, np.column_stack((x[short], (0.5 * a + 0.5 * b)[short])), header="energy mu")
    inspected = client.post(f"/api/athena/projects/{p['id']}/inspect", files={"file": ("short.dat", data.getvalue().encode())}).json()
    p = client.post(f"/api/athena/projects/{p['id']}/import", json={"version": p["version"],
        "upload_id": inspected["upload_id"], "energy_column": inspected["columns"][0]["column_id"],
        "numerator": [inspected["columns"][1]["column_id"]], "data_type": "norm"}).json()
    ids = [g["id"] for g in p["groups"]]
    standards, scans = ids[:2], ids[2:]
    request = {"version": p["version"], "action": "lcf_series", "group_ids": scans,
               "options": {"xmin": 8960, "xmax": 9020, "array": "norm", "standards": standards}}
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json=request)
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["labels"] == ["target.dat", "B.dat"]
    rows = result["targets"]
    assert [row["label"] for row in rows] == ["scan 1.dat", "scan 2.dat", "scan 3.dat", "short.dat"]
    for row, weight in zip(rows, (0.2, 0.5, 0.8)):
        np.testing.assert_allclose(row["weights"], [weight, 1 - weight], atol=1e-6)
        assert len(row["residual"]) == len(row["x"])
    assert "error" in rows[3] and rows[3]["error"].startswith("short.dat:")
    both = dict(request, group_ids=[*scans, standards[0]])
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json=both)
    assert response.status_code == 400
    assert "both a target and a standard" in response.json()["error"]["message"]


def test_a_series_step_sits_at_each_spectrum_own_e0(client, xas_arrays):
    """One step centre for a heating series misplaced the edge for most scans.

    Two spectra whose edges sit 4 eV apart: with ``center: "e0"`` each step is
    placed at that spectrum's own E0, as found on import.
    """
    x = xas_arrays[0]
    spectra = [(f"edge {shift}", 1 / (1 + np.exp(-(x - 8980 - shift) / 2.0))
                + 0.05 * np.exp(-((x - 8970 - shift) / 1.2) ** 2 / 2)) for shift in (0, 4)]
    p = mixture_project(client, x, spectra[0][1], [spectra[1]])
    ids = [g["id"] for g in p["groups"]]
    e0s = [g["result"]["effective"]["e0"] for g in p["groups"]]
    assert abs(e0s[1] - e0s[0] - 4) < 0.5
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json={
        "version": p["version"], "action": "peaks_series", "group_ids": ids,
        "options": {"array": "norm", "xmin": 8960, "xmax": 8978, "share": {"center": False, "sigma": True},
                    "peaks": [{"center": 8971, "sigma": 1.2, "amplitude": 0.1}],
                    "background": {"step": {"form": "arctan", "center": "e0", "sigma": 2}}}})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["details"]["step_centers"] == pytest.approx(e0s)


def test_combination_search_route_reports_an_actionable_refusal(client, xas_arrays):
    x = xas_arrays[0]
    edge = 1 / (1 + np.exp(-(x - 8978) / 3))
    p = mixture_project(client, x, edge, [("A", edge), ("B", edge * 2)])
    ids = [g["id"] for g in p["groups"]]
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json={
        "version": p["version"], "action": "lcf_search", "group_ids": ids[:2],
        "options": {"xmin": 8960, "xmax": 9020, "array": "norm"}})
    assert response.status_code == 400
    assert "at least two references" in response.json()["error"]["message"]
    response = client.post(f"/api/athena/projects/{p['id']}/analyze", json={
        "version": p["version"], "action": "lcf_search", "group_ids": ids,
        "options": {"xmin": 8960, "xmax": 9020, "array": "norm", "max_components": 5}})
    assert response.status_code == 400
    assert "exceeds the 2 references" in response.json()["error"]["message"]


@pytest.mark.parametrize("action, options, message", [
    ("lcf", {"sum_to_one": "false"}, "sum_to_one must be true or false"),
    ("lcf", {"nonnegative": "false"}, "nonnegative must be true or false"),
    ("lcf", {"nonnegative": 0}, "nonnegative must be true or false"),
    ("lcf", {"sum_to_1": False}, "Unsupported lcf options: sum_to_1"),
    ("pca", {"sum_to_one": False}, "Unsupported pca options: sum_to_one"),
    ("peaks", {"components": 2}, "Unsupported peaks options: components"),
    ("lcf_search", {"nonnegative": "false"}, "nonnegative must be true or false"),
    ("peaks_series", {"components": 2}, "Unsupported peaks_series options: components"),
])
def test_analysis_options_are_checked_before_fitting_a_different_model(client, xas_arrays, action, options, message):
    # XAS-QA-004: "false" used to pass bool() as true, and misspelled
    # constraints were dropped, so the saved request disagreed with the fit.
    p = create(client)
    x = xas_arrays[0]
    first = 1 / (1 + np.exp(-(x - 8978) / 3))
    second = 1 / (1 + np.exp(-(x - 8990) / 4))
    for label, y in (("target", .6 * first + 1.4 * second), ("standard A", first), ("standard B", second)):
        data = StringIO()
        np.savetxt(data, np.column_stack((x, y)), header="energy mu")
        inspected = client.post(f"/api/athena/projects/{p['id']}/inspect", files={"file": (label + ".dat", data.getvalue().encode())}).json()
        p = client.post(f"/api/athena/projects/{p['id']}/import", json={"version": p["version"],
            "upload_id": inspected["upload_id"], "energy_column": inspected["columns"][0]["column_id"],
            "numerator": [inspected["columns"][1]["column_id"]], "data_type": "norm"}).json()
    ids = [g["id"] for g in p["groups"]]
    analyze = lambda options: client.post(f"/api/athena/projects/{p['id']}/analyze", json={"version": p["version"],
        "action": action, "group_ids": ids[:1] if action == "peaks" else ids,
        "options": {"array": "norm", "xmin": 8960, "xmax": 9020, **options}})
    response = analyze(options)
    assert response.status_code == 400, response.text
    assert message in response.json()["error"]["message"]
    assert client.get(f"/api/athena/projects/{p['id']}").json().get("analyses", []) == []
    if action == "lcf":
        unconstrained = analyze({"sum_to_one": False, "nonnegative": False})
        assert unconstrained.status_code == 200, unconstrained.text
        np.testing.assert_allclose(unconstrained.json()["result"]["weights"], [.6, 1.4], atol=1e-6)


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


def test_import_retried_under_its_key_is_answered_not_imported_twice(client):
    """XAS-QA-007: a lost import response must not turn the retry into a second scan."""
    project = create(client)
    raw = ("energy i0 it\n" + "".join(
        f"{100 + index} {10 + index} {5 + index / 2}\n" for index in range(12)
    )).encode()
    inspected = client.post(
        f"/api/athena/projects/{project['id']}/inspect", files={"file": ("cu.dat", raw)},
    ).json()
    columns = {column["name"]: column["column_id"] for column in inspected["columns"]}
    endpoint = f"/api/athena/projects/{project['id']}/import"
    body = {"version": 0, "upload_id": inspected["upload_id"], "energy_column": columns["energy"],
            "numerator": [columns["i0"]], "denominator": columns["it"], "mode": "transmission"}

    first = client.post(endpoint, json=body, headers={"Idempotency-Key": "import-1"})
    assert first.status_code == 200, first.text
    imported = first.json()
    assert len(imported["groups"]) == 1

    # The browser never saw `first`, so it retries the same body: same key, stale version.
    retry = client.post(endpoint, json=body, headers={"Idempotency-Key": "import-1"})
    assert retry.status_code == 200, retry.text
    answered = retry.json()
    assert answered["version"] == imported["version"]
    assert [g["id"] for g in answered["groups"]] == [g["id"] for g in imported["groups"]]
    replay = answered["last_operation"]["idempotent_replay"]
    assert replay["version_after"] == imported["version"]
    assert replay["group_ids"] == [imported["groups"][0]["id"]]
    # Nothing was saved by the answered retry.
    stored = client.get(f"/api/athena/projects/{project['id']}").json()
    assert stored["version"] == imported["version"] and len(stored["groups"]) == 1
    assert "idempotent_replay" not in (stored.get("last_operation") or {})

    # Without the key a stale retry is still the ordinary conflict.
    unkeyed = client.post(endpoint, json=body)
    assert unkeyed.status_code == 409, unkeyed.text

    # A deliberate second import of the same upload, under a new key, still works.
    again = client.post(endpoint, json={**body, "version": imported["version"]},
                        headers={"Idempotency-Key": "import-2"})
    assert again.status_code == 200, again.text
    assert len(again.json()["groups"]) == 2
    assert "idempotent_replay" not in (again.json().get("last_operation") or {})
