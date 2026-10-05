"""Comparing two final projects quantity by quantity.

A pass on the state assertions says a run did the task; `diff` says whether
two runs that did it got the same numbers, within the tolerances the suite's
answer assertions already use. The runs here are made by hand, replayed, and
nudged, so that each tolerance is seen holding and seen giving way.
"""
import copy
import json

import pytest
import httpx
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite
from xraylarch_web.agent_diff import compare, render, snapshot
from xraylarch_web.agent_replay import replay
from xraylarch_web.agent_suite import FOILS
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def run(http):
    return agent_suite.setup(http)


def ok(http, run, action, labels=(), **options):
    base = f"/api/athena/projects/{run['project_id']}"
    version = http.get(base, params={"view": "summary"}).json()["version"]
    response = http.post(f"{base}/command", params={"view": "summary"},
                         json={"version": version, "action": action,
                               "group_ids": [run["groups"][label] for label in labels],
                               "options": options})
    assert response.status_code == 200, response.text
    return response.json()


def transcript(http, ident):
    return http.get(f"/api/athena/projects/{ident}/transcript", params={"limit": 500}).json()["records"]


def fields(differences):
    return [(item.label, item.field) for item in differences]


def test_a_project_matches_itself(http, run):
    assert compare(snapshot(http, run["project_id"]), snapshot(http, run["project_id"])) == []


def test_a_replay_matches_the_run_it_came_from_down_to_the_ids_it_cannot_share(http, run):
    ok(http, run, "assign_reference", FOILS, reference_id=None)
    ok(http, run, "align", FOILS[1:], method="demeter-larch", operation="auto",
       standard_id=run["groups"][FOILS[0]])
    ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    again = replay(http, transcript(http, run["project_id"]))

    original, replayed = snapshot(http, run["project_id"]), snapshot(http, again.project_id)
    assert original["summary"]["id"] != replayed["summary"]["id"]
    assert compare(original, replayed) == []


def test_small_moves_stay_inside_the_tolerance_and_larger_ones_do_not(http, run):
    original = snapshot(http, run["project_id"])
    nudged = copy.deepcopy(original)
    foil = next(group for group in nudged["summary"]["groups"] if group["label"] == FOILS[0])
    foil["e0"] += 0.05
    foil["edge_step"] += 0.004
    foil["range"][1] += 0.05
    assert compare(original, nudged) == []

    foil["e0"] += 0.1
    foil["edge_step"] += 0.01
    foil["range"][1] += 0.1
    assert fields(compare(original, nudged)) == [(FOILS[0], "e0"), (FOILS[0], "edge_step"),
                                                 (FOILS[0], "range")]


def test_a_parameter_change_shows_as_the_effective_value_that_moved(http, run):
    before = snapshot(http, run["project_id"])
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    after = snapshot(http, run["project_id"])

    differences = compare(before, after)
    assert fields(differences) == [(FOILS[0], "kmax")]
    assert (differences[0].a, differences[0].b, differences[0].tolerance) == (24.0, 18.0, 0.01)


def test_ids_are_compared_through_labels_and_a_group_without_a_partner_is_a_difference(http, run):
    merged = ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    with_merge = snapshot(http, run["project_id"])
    other = agent_suite.setup(http)
    ok(http, other, "merge", FOILS[:2], method="demeter-larch")
    other_merge = snapshot(http, other["project_id"])

    # Same labels on both sides, different ids on both sides: the merge's
    # parents and each foil's reference compare equal through their labels,
    # and the only differences are the ones that are real.
    differences = compare(with_merge, other_merge)
    assert ("merge", "derived") in fields(differences)
    derived = next(item for item in differences if item.field == "derived")
    assert derived.a["parents"] == [(label, 1) for label in FOILS]
    assert derived.b["parents"] == [(label, 1) for label in FOILS[:2]]
    assert not any(label in FOILS and field in ("reference", "derived")
                   for label, field in fields(differences))

    ok(http, other, "delete", [FOILS[2]])
    differences = compare(with_merge, snapshot(http, other["project_id"]))
    assert ("(project)", "groups") in fields(differences)
    missing = next(item for item in differences if item.field == "present")
    assert (missing.label, missing.a, missing.b) == (FOILS[2], True, False)
    assert merged["counts"]["groups"] == 6


def test_two_groups_under_one_label_pair_in_order(http, run):
    ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    ok(http, run, "merge", FOILS[:2], method="demeter-larch")
    base = f"/api/athena/projects/{run['project_id']}"
    summary = http.get(base, params={"view": "summary"}).json()
    second = next(group for group in summary["groups"] if group["label"] == "merge 2")
    response = http.post(f"{base}/command", params={"view": "summary"},
                         json={"version": summary["version"], "action": "metadata",
                               "group_ids": [second["id"]], "options": {"label": "merge"}})
    assert response.status_code == 200, response.text
    both = snapshot(http, run["project_id"])
    assert [group["label"] for group in both["summary"]["groups"]].count("merge") == 2

    assert compare(both, both) == []
    swapped = copy.deepcopy(both)
    merges = [group for group in swapped["summary"]["groups"] if group["label"] == "merge"]
    merges[0]["derived"], merges[1]["derived"] = merges[1]["derived"], merges[0]["derived"]
    assert fields(compare(both, swapped)) == [("merge", "derived"), ("merge", "derived")]


def test_render_names_each_quantity_with_its_tolerance(http, run):
    before = snapshot(http, run["project_id"])
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    text = render(compare(before, snapshot(http, run["project_id"])))
    assert text.splitlines()[0] == "1 differences"
    assert f"{FOILS[0]}  kmax: 24.0000 -> 18.0000  (tolerance 0.01)" in text
    assert render([]) == "no differences beyond tolerance"


def test_relationships_distinguish_groups_with_duplicate_labels(http, run):
    before = snapshot(http, run["project_id"])
    first, second, child = before["summary"]["groups"][:3]
    first["label"] = second["label"] = "same label"
    child["reference_id"] = first["id"]
    child["background_standard_id"] = first["id"]
    child["derived"] = {"operation": "copy", "parents": [first["id"]]}
    after = copy.deepcopy(before)
    moved = after["summary"]["groups"][2]
    moved["reference_id"] = second["id"]
    moved["background_standard_id"] = second["id"]
    moved["derived"]["parents"] = [second["id"]]
    assert fields(compare(before, after)) == [
        (child["label"], "reference"), (child["label"], "background_standard"),
        (child["label"], "derived"),
    ]


def test_snapshot_refuses_an_http_error_body():
    def respond(request):
        return httpx.Response(404, json={"message": "project missing"})
    with httpx.Client(transport=httpx.MockTransport(respond), base_url="http://test") as client:
        with pytest.raises(httpx.HTTPStatusError):
            snapshot(client, "missing")


def test_finish_keeps_a_snapshot_the_cli_diff_can_read_later(tmp_path, http, run, capsys):
    saved = tmp_path / "run.json"
    saved.write_text(json.dumps(run))
    assert agent_suite.main(["finish", str(saved)], http=http) == 0
    finished = json.loads(saved.read_text())
    assert finished["final"]["summary"]["id"] == run["project_id"]
    assert "finished" in finished

    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    assert agent_suite.main(["diff", str(saved), run["project_id"]], http=http) == 1
    out = capsys.readouterr().out
    assert "kmax: 24.0000 -> 18.0000" in out
    # The snapshot in the file is what was compared, not the project as it is now.
    assert agent_suite.main(["diff", str(saved), str(saved)], http=http) == 0
    assert "no differences" in capsys.readouterr().out


def test_replay_writes_a_run_file_diff_can_compare_with_the_original(tmp_path, http, run, capsys):
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    original = tmp_path / "run.json"
    original.write_text(json.dumps(run))
    assert agent_suite.main(["finish", str(original)], http=http) == 0
    log = tmp_path / "transcript.json"
    log.write_text(json.dumps({"records": transcript(http, run["project_id"])}))
    again = tmp_path / "again.json"
    assert agent_suite.main(["replay", str(log), "--out", str(again)], http=http) == 0
    assert agent_suite.main(["diff", str(original), str(again)], http=http) == 0
    assert "no differences" in capsys.readouterr().out
