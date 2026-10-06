"""The action menu has to stay honest about the dispatcher behind it.

A catalog that drifts from the code is worse than no catalog: a caller who
cannot see the source trusts it completely. So the tests here are mostly parity
tests, and the important one reads the dispatcher itself rather than a list
somebody remembered to update.
"""
import ast
import inspect

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import athena
from xraylarch_web.agent_actions import ACTIONS, detail, index
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


def dispatched_actions() -> set[str]:
    """Every action string the dispatcher compares against.

    Read from the syntax tree rather than by matching text, because the word
    'smooth' also appears as an *option* of deconvolve and a text search cannot
    tell the two apart. Only comparisons whose left side is the `action` variable
    count, plus the keys of the catch-all's allowed_options table, which the
    branch immediately below it treats as the set of legal actions.
    """
    tree = ast.parse(inspect.getsource(athena.AthenaStore._apply_command).lstrip())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) \
                and node.left.id == "action":
            for comparator in node.comparators:
                elements = comparator.elts if isinstance(
                    comparator, (ast.Tuple, ast.List, ast.Set)) else [comparator]
                found.update(item.value for item in elements
                             if isinstance(item, ast.Constant) and isinstance(item.value, str))
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "allowed_options" for t in node.targets):
            if isinstance(node.value, ast.DictComp):
                # Built from a module-level table of action names.
                found.update(getattr(athena, node.value.generators[0].iter.id))
            else:
                found.update(key.value for key in node.value.keys
                             if isinstance(key, ast.Constant))
    return found


def test_the_catalog_and_the_dispatcher_name_the_same_actions():
    dispatched = dispatched_actions()
    assert dispatched, "the AST walk found nothing; the dispatcher was restructured"

    missing = dispatched - set(ACTIONS)
    assert not missing, (
        f"The dispatcher handles {sorted(missing)} but agent_actions does not "
        "describe them, so an agent reading /capabilities cannot discover them.")

    invented = set(ACTIONS) - dispatched
    assert not invented, (
        f"agent_actions advertises {sorted(invented)}, which the dispatcher no "
        "longer handles.")


def test_every_advertised_option_table_resolves():
    """A lazily named model that no longer exists must fail here, not in a response."""
    for name in ACTIONS:
        described = detail(name)
        assert described["options"] or not ACTIONS[name].model, name
        assert described["selection_meaning"], name


def test_the_index_is_cheap_enough_to_read_before_choosing():
    """The point of the split is that discovery costs less than the detail."""
    listing = index()
    assert len(listing["actions"]) == len(ACTIONS)
    # About 220 characters per action and analysis; 8,000 held 36 actions and
    # four analyses before add_references and the three series analyses came in.
    assert len(repr(listing)) < 8_500

    # Every index row must lead somewhere, or progressive disclosure is a lie.
    for row in listing["actions"]:
        assert detail(row["action"]) is not None


def test_option_tables_come_from_the_validator_not_a_copy(client):
    """The parameters table should track AthenaParameters, constraints included."""
    options = client.get("/api/athena/capabilities/parameters").json()["options"]
    from xraylarch_web.athena_science import AthenaParameters

    assert set(options) == set(AthenaParameters.model_fields)
    assert "le 4" in options["kweight"], "numeric bounds should survive"
    assert "'hanning'" in options["window"], "choices should be listed"
    assert "PydanticUndefined" not in repr(options), "internals must not leak"


def test_an_unknown_action_is_told_where_the_list_is(client):
    response = client.get("/api/athena/capabilities/sharpen")
    assert response.status_code == 400
    assert "/api/athena/capabilities" in response.json()["error"]["message"]


@pytest.mark.parametrize("action,body", [
    ("project", {"options": {"name": "Renamed"}}),
    ("selection", {"options": {"field": "marked", "mode": "all"}, "use_groups": True}),
])
def test_the_catalog_describes_bodies_that_actually_work(client, action, body):
    """A spot check that a caller following the catalog reaches a 200.

    The parity test above proves coverage; this proves the shape of the body the
    index documents is the shape /command wants.
    """
    project = client.post("/api/athena/projects").json()
    project = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "example",
        "group_ids": [], "options": {}}).json()

    group_ids = [g["id"] for g in project["groups"]] if body.get("use_groups") else []
    response = client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": action,
        "group_ids": group_ids, "options": body["options"]})
    assert response.status_code == 200, response.text


@pytest.fixture
def example(client):
    project = client.post("/api/athena/projects").json()
    return client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "example",
        "group_ids": [], "options": {}}).json()


def foils(project):
    """The three temperature scans, without the shared reference they link to."""
    return {g["label"]: g["id"] for g in project["groups"]
            if g["label"].startswith("Cu foil · ") and "reference" not in g["label"]}


def unlinked(client, example):
    """The example with its foil scans detached from their shared reference."""
    response = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "assign_reference",
        "group_ids": list(foils(example).values()), "options": {"reference_id": None}})
    assert response.status_code == 200, response.text
    return response.json()


def test_align_refuses_a_group_in_the_standard_s_family(client, example):
    """The example links all three foils to one reference, so they shift as one.

    Aligning one to another is refused rather than skipped silently, and the
    catalog has to say why and what to send instead, because the refusal
    names the rule and not the way out.
    """
    scans = foils(example)
    response = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "align",
        "group_ids": [scans["Cu foil · 50 K"], scans["Cu foil · 300 K"]],
        "options": {"method": "demeter-larch", "operation": "auto",
                    "standard_id": scans["Cu foil · 10 K"]}})
    assert response.status_code == 400
    message = response.json()["error"]["message"]
    assert "linked references stay fixed" in message
    assert "assign_reference and reference_id null" in message, "the refusal names the way out"

    note = client.get("/api/athena/capabilities/align").json()["note"]
    assert "assign_reference" in note
    assert "reference_id=null" in client.get(
        "/api/athena/capabilities/assign_reference").json()["note"]


def test_the_align_note_names_the_operation_that_actually_previews(client, example):
    """It used to send a caller to operation='inspect', which cannot fit a shift.

    The note is prose, so what is pinned here is the behaviour it describes:
    'inspect' refuses more than one group and reports the shift already stored,
    while 'auto' takes the whole selection and fits real ones.
    """
    note = client.get("/api/athena/capabilities/align").json()["note"]
    assert "operation='auto'" in note
    assert "'inspect'" in note

    example = unlinked(client, example)
    project, scans = example["id"], foils(example)
    standard = scans["Cu foil · 10 K"]
    # The foil scans against the 10 K foil; the Cu2O reference is a different
    # material, not a misaligned copy of the standard.
    moving = [scans["Cu foil · 50 K"], scans["Cu foil · 300 K"]]
    body = {"version": example["version"], "action": "align", "group_ids": moving,
            "options": {"method": "demeter-larch", "standard_id": standard}}

    refused = client.post(f"/api/athena/projects/{project}/alignment/preview",
                          json={**body, "options": {**body["options"], "operation": "inspect"}})
    assert refused.status_code == 400
    assert "one current group at a time" in refused.json()["error"]["message"]

    fitted = client.post(f"/api/athena/projects/{project}/alignment/preview",
                         json={**body, "options": {**body["options"], "operation": "auto"}})
    assert fitted.status_code == 200, fitted.text
    shifts = {row["label"]: row["energy_shift"] for row in fitted.json()["rows"]}
    assert len(shifts) == 2
    assert all(shift != 0 for shift in shifts.values()), (
        "inspect would have reported 0 for both; auto fits real shifts")
    assert shifts["Cu foil · 300 K"] == pytest.approx(-2.959, abs=0.05), (
        "the scan the first run was told was already aligned")


def test_the_truncate_note_says_which_modes_are_its_own(client, example):
    """Eight mode values are listed by the shared validator; two are legal here."""
    note = client.get("/api/athena/capabilities/truncate").json()["note"]
    for mode in ("'truncate'", "'interval'", "side=", "value=", "xmin", "xmax"):
        assert mode in note

    project = example["id"]
    target = [next(g["id"] for g in example["groups"] if "10 K" in g["label"])]
    body = {"version": example["version"], "action": "truncate", "group_ids": target}

    for rejected in ("point", "indices", "points", "range", "margins", "inspect"):
        response = client.post(f"/api/athena/projects/{project}/point-edit/preview",
                               json={**body, "options": {"mode": rejected}})
        assert response.status_code == 400, f"{rejected} is deglitch's, not truncate's"

    # And the two the note describes both work, on their own fields.
    cut = client.post(f"/api/athena/projects/{project}/point-edit/preview", json={
        **body, "options": {"mode": "truncate", "side": "after", "value": 10146.0}})
    assert cut.status_code == 200, cut.text
    result = cut.json()["results"][0]
    assert result["snapped"] == pytest.approx(10146, abs=10)

    # side='after' removes the snapped point too, so the axis ends one grid
    # step below it. A caller who reads `snapped` as the new endpoint is out
    # by that step, which is 6.75 eV here, and the note has to say so.
    assert result["snapped"] in result["selected_energy"]
    assert result["snapped"] not in result["energy"]
    assert result["energy"][-1] < result["snapped"]
    for phrase in ("side='before' keeps that point", "side='after' drops it",
                   "last kept energy", "both ends inclusive", "default when mode is omitted"):
        assert phrase in note

    kept = client.post(f"/api/athena/projects/{project}/point-edit/preview", json={
        **body, "options": {"mode": "interval", "xmax": 10146.0}})
    assert kept.status_code == 200, kept.text
    assert kept.json()["results"][0]["output_points"] < 612

    # Both ends inclusive: a bound on a measured point keeps that point.
    on_point = result["selected_energy"][0]
    inclusive = client.post(f"/api/athena/projects/{project}/point-edit/preview", json={
        **body, "options": {"xmax": on_point}}).json()["results"][0]
    assert inclusive["energy"][-1] == on_point

    beyond = client.post(f"/api/athena/projects/{project}/point-edit/preview", json={
        **body, "options": {"xmax": 1e6}})
    assert beyond.status_code == 400, "a bound outside the data is refused, as the note says"


def test_the_deglitch_note_says_what_each_of_its_modes_takes(client):
    note = client.get("/api/athena/capabilities/deglitch").json()["note"]
    for mode in ("'point'", "'points'", "'indices'", "'range'", "'margins'", "'inspect'"):
        assert mode in note
    assert "truncate" in note, "say where the other two modes went"


def test_an_align_command_takes_the_body_its_preview_took(client, example):
    """method has a default on the model, and the preview applies it.

    The command used to send a body without method down an older path that
    reads reference_id, so the same body previewed and then failed with
    "Selected group no longer exists", which names nothing the caller sent.
    """
    example = unlinked(client, example)
    scans = foils(example)
    body = {"version": example["version"], "action": "align",
            "group_ids": [scans["Cu foil · 50 K"], scans["Cu foil · 300 K"]],
            "options": {"operation": "auto", "standard_id": scans["Cu foil · 10 K"]}}
    preview = client.post(f"/api/athena/projects/{example['id']}/alignment/preview",
                          json=body, params={"view": "summary"})
    assert preview.status_code == 200, preview.text
    saved = client.post(f"/api/athena/projects/{example['id']}/command",
                        json=body, params={"view": "summary"})
    assert saved.status_code == 200, saved.text
    shifts = {g["label"]: g["energy_shift"] for g in saved.json()["groups"]}
    assert shifts["Cu foil · 300 K"] == pytest.approx(-2.959, abs=0.01)


def test_the_catalog_says_when_a_default_is_not_applied(client):
    method = client.get("/api/athena/capabilities/merge").json()["options"]["method"]
    assert "plain average" in method and "preview refuses" in method


def test_every_read_the_index_names_is_a_route(client):
    routes = {route.path for route in client.app.routes}
    for path in index()["reads"]:
        template = path.split("?")[0].replace("{id}", "{ident}").replace("{gid}", "{group_id}")
        assert template in routes, path


def test_the_align_options_say_what_the_validator_cannot(client, example):
    """A blind arm read "default 'inspect'" and sent it to /command, which refuses it;
    another could not tell whether the standard belonged in group_ids."""
    options = client.get("/api/athena/capabilities/align").json()["options"]
    assert "/command refuses it" in options["operation"]
    assert "comes to the same thing" in options["standard_id"]

    example = unlinked(client, example)
    scans = foils(example)
    response = client.post(f"/api/athena/projects/{example['id']}/command", params={"view": "summary"}, json={
        "version": example["version"], "action": "align", "group_ids": list(scans.values()),
        "options": {"operation": "auto", "standard_id": scans["Cu foil · 10 K"]}})
    assert response.status_code == 200, response.text
    operation = response.json()["last_operation"]
    assert operation["skipped_group_ids"] == [scans["Cu foil · 10 K"]]
    assert len(operation["alignment"]["changes"]) == 2
