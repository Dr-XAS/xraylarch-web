"""The suite's state assertions, held against the paths that pass and the ones that don't.

Both hand-graded runs passed T2 against a merge that had left the 300 K scan
out, so each task here gets the wrong path the hand check missed as well as a
scripted right one. A checker that cannot fail the default merge is the same
checker as before.
"""
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite
from xraylarch_web.agent_suite import FOILS, check
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def run(http):
    return agent_suite.setup(http)


def send(http, run, action, labels=(), **options):
    base = f"/api/athena/projects/{run['project_id']}"
    version = http.get(base, params={"view": "summary"}).json()["version"]
    return http.post(f"{base}/command", params={"view": "summary"}, json={
        "version": version, "action": action,
        "group_ids": [run["groups"][label] for label in labels], "options": options})


def ok(http, run, action, labels=(), **options):
    response = send(http, run, action, labels, **options)
    assert response.status_code == 200, response.text
    return response.json()


def failed(assertions):
    return [item.name for item in assertions if not item.ok]


def test_setup_records_the_example_before_the_arm_touches_it(run):
    assert set(FOILS) <= set(run["groups"])
    assert len(run["groups"]) == agent_suite.EXAMPLE_GROUPS
    assert run["seq"] >= 1, "the example command itself is in the transcript"


def test_t1_passes_untouched_and_fails_once_anything_is_written(http, run):
    assert failed(check(http, "T1", run)) == []
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    assert "version unchanged" in failed(check(http, "T1", run))


def test_t1_counts_a_rejection_made_after_setup(http, run):
    assert send(http, run, "align", [FOILS[1]], method="demeter-larch", operation="auto",
                standard_id=run["groups"][FOILS[0]]).status_code == 400
    assert "no rejected commands" in failed(check(http, "T1", run))


def unlink_and_align(http, run):
    ok(http, run, "assign_reference", FOILS, reference_id=None)
    ok(http, run, "align", FOILS[1:], method="demeter-larch", operation="auto",
       standard_id=run["groups"][FOILS[0]])


def test_t2_fails_the_default_merge_that_both_hand_checks_passed(http, run):
    unlink_and_align(http, run)
    ok(http, run, "merge", FOILS, method="demeter-larch")
    results = check(http, "T2", run)
    assert failed(results) == ["one merge of all three foils, by derived.parents"]
    detail = next(item.detail for item in results if not item.ok)
    assert "excluded ['Cu foil · 300 K']" in detail, "the failure should say what was dropped"


def test_t2_passes_when_the_merge_keeps_the_short_scan(http, run):
    unlink_and_align(http, run)
    ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    assert failed(check(http, "T2", run)) == []


def test_t2_fails_a_merge_of_unaligned_scans(http, run):
    ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    assert failed(check(http, "T2", run)) == ["50 K and 300 K shifted, 10 K not"]


def test_t3_wants_the_effective_kmax_not_the_requested_one(http, run):
    assert failed(check(http, "T3", run)) == ["10 K effective kmax below 24"]
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    assert failed(check(http, "T3", run)) == []


def test_t4_passes_on_matched_ranges_and_a_merge_of_all_three(http, run):
    ok(http, run, "truncate", FOILS[:2], mode="truncate", side="after", value=10146)
    # Matching the range leaves the point counts apart, so the short scan goes first.
    ok(http, run, "merge", (FOILS[2], FOILS[0], FOILS[1]), method="demeter-larch")
    assert failed(check(http, "T4", run)) == []


def test_t4_fails_the_truncate_then_default_merge(http, run):
    ok(http, run, "truncate", FOILS[:2], mode="truncate", side="after", value=10146)
    ok(http, run, "merge", FOILS, method="demeter-larch")
    assert failed(check(http, "T4", run)) == ["one merge of all three foils, by derived.parents"]


def test_t5_passes_a_fit_because_a_fit_saves_nothing(http, run):
    example = http.get("/api/artemis/examples/cuprite").json()
    paths = [{"id": f"p{index}", "filename": path["filename"], "content": path["content"]}
             for index, path in enumerate(example["paths"], start=1)]
    fitted = http.post(f"/api/artemis/projects/{run['project_id']}/groups/{run['groups'][FOILS[0]]}/fit",
                       params={"view": "summary"},
                       json={"version": run["version"], "parameters": example["parameters"],
                             "paths": paths[:1], "transform": example["transform"]})
    assert fitted.status_code == 200, fitted.text
    assert failed(check(http, "T5", run)) == []
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    assert failed(check(http, "T5", run)) == ["version unchanged"]


def test_the_meter_logs_each_request_and_its_size(tmp_path):
    log = tmp_path / "meter.jsonl"
    app = agent_suite.Meter(create_app(Settings(data_root=tmp_path / "data")), log)
    with TestClient(app) as client:
        made = agent_suite.setup(client)
        summary = client.get(f"/api/athena/projects/{made['project_id']}", params={"view": "summary"})
        client.get("/health")
    entries = [json.loads(line) for line in log.read_text().splitlines()]
    assert entries[-2]["bytes"] == len(summary.content)
    assert entries[-2]["query"] == "view=summary"
    totals = agent_suite.meter_totals(log)
    assert totals["requests"] == len(entries) - 1, "health checks are not the arm's turns"
    assert totals["gets"] >= 2 and totals["posts"] == 2
    assert totals["bytes"] == sum(entry["bytes"] for entry in entries[:-1])


def test_report_prints_assertions_rejections_and_meter_totals(http, run, tmp_path, capsys):
    path = tmp_path / "run.json"
    path.write_text(json.dumps(run))
    send(http, run, "align", [FOILS[1]], method="demeter-larch", operation="auto",
         standard_id=run["groups"][FOILS[0]])
    code = agent_suite.main(["report", "T1", str(path)], http=http)
    out = capsys.readouterr().out
    assert code == 1
    assert "T1 FAIL" in out
    assert "rejected align: The alignment standard and its linked references stay fixed" in out


def test_finish_keeps_what_was_read_afterwards_out_of_the_meter(tmp_path, capsys):
    log = tmp_path / "meter.jsonl"
    app = agent_suite.Meter(create_app(Settings(data_root=tmp_path / "data")), log)
    path = tmp_path / "run.json"
    with TestClient(app) as client:
        path.write_text(json.dumps(agent_suite.setup(client) | {"started": 0.0}))
        assert agent_suite.main(["finish", str(path)]) == 0
        project = json.loads(path.read_text())["project_id"]
        client.get(f"/api/athena/projects/{project}")  # the operator looking, arrays and all
        agent_suite.main(["report", "T1", str(path), "--meter", str(log)], http=client)
    out = capsys.readouterr().out
    before = agent_suite.meter_totals(log, until=json.loads(path.read_text())["finished"])
    assert f"meter: {before['requests']} requests" in out
    assert before["requests"] < agent_suite.meter_totals(log)["requests"]
