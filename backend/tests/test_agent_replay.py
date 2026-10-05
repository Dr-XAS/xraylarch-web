"""Replaying a transcript onto a fresh project.

The recorded runs are made here, by sending the commands an arm would send,
and then replayed from the transcript alone, as a later regression run would
replay them. A pass means the replayed project answers the suite's state
assertions the way the original did, with every group the transcript names
resolved to the right one.
"""
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite
from xraylarch_web.agent_replay import condensed, load_records, replay
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


def send(http, run, action, labels=(), key=None, **options):
    base = f"/api/athena/projects/{run['project_id']}"
    version = http.get(base, params={"view": "summary"}).json()["version"]
    return http.post(f"{base}/command", params={"view": "summary"},
                     json={"version": version, "action": action,
                           "group_ids": [run["groups"][label] for label in labels],
                           "options": options},
                     headers={"Idempotency-Key": key} if key else None)


def ok(http, run, action, labels=(), **options):
    response = send(http, run, action, labels, **options)
    assert response.status_code == 200, response.text
    return response.json()


def summary(http, ident):
    return http.get(f"/api/athena/projects/{ident}", params={"view": "summary"}).json()


def transcript(http, ident) -> dict:
    return http.get(f"/api/athena/projects/{ident}/transcript", params={"limit": 500}).json()


def failed(assertions):
    return [item.name for item in assertions if not item.ok]


def unlink_align_merge(http, run):
    ok(http, run, "assign_reference", FOILS, reference_id=None)
    ok(http, run, "align", FOILS[1:], method="demeter-larch", operation="auto",
       standard_id=run["groups"][FOILS[0]])
    ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)


def test_a_recorded_t2_run_replays_and_passes_the_same_check(http, run):
    unlink_align_merge(http, run)
    assert failed(check(http, "T2", run)) == []

    result = replay(http, transcript(http, run["project_id"])["records"])

    assert result.divergences == []
    assert result.project_id != run["project_id"]
    assert result.replayed() == 4, "example, assign_reference, align, merge"
    assert failed(check(http, "T2", result.setup)) == []
    # The standard was named by id in align's options, and the merge's
    # parents by id in its selection; both landed on the replayed foils.
    before = {group["label"]: group for group in summary(http, run["project_id"])["groups"]}
    after = {group["label"]: group for group in summary(http, result.project_id)["groups"]}
    for label in FOILS:
        assert after[label]["energy_shift"] == pytest.approx(before[label]["energy_shift"])
    assert after[label]["id"] != before[label]["id"]
    merged = after["merge"]["derived"]["parents"]
    assert merged == [result.setup["groups"][label] for label in FOILS]


def test_two_groups_under_one_label_are_told_apart_by_id(http, run):
    """A run that merged twice has two groups called merge; delete meant one of them."""
    foils = ok(http, run, "merge", FOILS, method="demeter-larch", exclude_short_data=False)
    first = next(group for group in foils["groups"] if group["id"] not in run["groups"].values())
    others = [label for label in run["groups"] if label not in FOILS]
    ok(http, run, "merge", others, method="demeter-larch", exclude_short_data=False)
    second = next(group for group in summary(http, run["project_id"])["groups"]
                  if group["id"] not in run["groups"].values() and group["id"] != first["id"])
    base = f"/api/athena/projects/{run['project_id']}"

    def by_id(action, gid, **options):
        version = summary(http, run["project_id"])["version"]
        response = http.post(f"{base}/command", params={"view": "summary"},
                             json={"version": version, "action": action,
                                   "group_ids": [gid], "options": options})
        assert response.status_code == 200, response.text
        return response.json()

    # The merge numbers its own labels, so the collision is made by renaming.
    renamed = by_id("metadata", second["id"], label=first["label"])
    assert [group["label"] for group in renamed["groups"]].count(first["label"]) == 2, \
        "the test needs two groups one label cannot tell apart"
    by_id("delete", first["id"])

    result = replay(http, transcript(http, run["project_id"])["records"])

    assert result.divergences == []
    merges = [group for group in summary(http, result.project_id)["groups"]
              if (group.get("derived") or {}).get("operation") == "merge"]
    assert len(merges) == 1
    assert merges[0]["derived"]["parents"] == [result.setup["groups"][label] for label in others]
    assert result.ids[first["id"]] not in {group["id"] for group in summary(http, result.project_id)["groups"]}


def test_condensed_options_stop_the_replay_and_say_so(http, run):
    ok(http, run, "deglitch", [FOILS[0]], indices=list(range(40)))
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    records = transcript(http, run["project_id"])["records"]
    assert condensed(records[1]["options"])

    result = replay(http, records)

    assert [step.status for step in result.steps] == ["replayed", "diverged"]
    assert "condensed" in result.divergences[0]
    assert "deglitch" in result.divergences[0]

    pressed_on = replay(http, records, keep_going=True)
    assert [step.status for step in pressed_on.steps] == ["replayed", "diverged", "replayed"]


def test_previews_rejections_and_answered_retries_are_skipped_and_counted(http, run):
    base = f"/api/athena/projects/{run['project_id']}"
    version = summary(http, run["project_id"])["version"]
    assert http.post(f"{base}/merge/preview", params={"view": "summary"},
                     json={"version": version, "action": "merge",
                           "group_ids": [run["groups"][label] for label in FOILS[:2]],
                           "options": {"method": "demeter-larch"}}).status_code == 200
    assert send(http, run, "align", [FOILS[1]], method="demeter-larch", operation="auto",
                standard_id=run["groups"][FOILS[0]]).status_code == 400
    assert send(http, run, "parameters", [FOILS[0]], key="k-1", kmax=18).status_code == 200
    stale = http.post(f"{base}/command", params={"view": "summary"},
                      json={"version": version, "action": "parameters",
                            "group_ids": [run["groups"][FOILS[0]]], "options": {"kmax": 18}},
                      headers={"Idempotency-Key": "k-1"})
    assert stale.status_code == 200 and "idempotent_replay" in stale.json()["last_operation"]

    result = replay(http, transcript(http, run["project_id"])["records"])

    assert result.divergences == []
    assert result.replayed() == 2, "example and the keyed parameters command"
    assert result.skipped() == {"preview": 1, "rejected": 1, "answered from the record": 1}
    kmax = next(group["effective"]["kmax"]
                for group in http.get(f"/api/athena/projects/{result.project_id}",
                                      params={"view": "parameters"}).json()["groups"]
                if group["id"] == result.setup["groups"][FOILS[0]])
    assert kmax == 18


def test_a_command_rejected_now_is_a_divergence(http, run):
    records = transcript(http, run["project_id"])["records"]
    records.append({"seq": 2, "action": "sharpen", "ok": True, "group_ids": [], "groups": [],
                    "options": {}, "version_before": records[-1]["version_after"],
                    "version_after": records[-1]["version_after"] + 1})
    records.append({"seq": 3, "action": "parameters", "ok": True,
                    "group_ids": [run["groups"][FOILS[0]]], "groups": [FOILS[0]],
                    "options": {"kmax": 18}, "version_before": records[-1]["version_after"],
                    "version_after": records[-1]["version_after"] + 1})

    result = replay(http, records)

    assert [step.status for step in result.steps] == ["replayed", "diverged"]
    assert "accepted then, rejected now" in result.divergences[0]
    assert not result.ok


def test_replay_keeps_original_rejections_in_task_grades(http, run):
    assert send(http, run, "align", [FOILS[1]], operation="auto",
                standard_id=run["groups"][FOILS[0]]).status_code == 400
    original_failures = failed(check(http, "T1", run))
    assert original_failures
    result = replay(http, transcript(http, run["project_id"])["records"])
    assert result.ok
    assert len(result.setup["source_rejections"]) == 1
    assert failed(check(http, "T1", result.setup)) == original_failures


def test_a_group_the_replay_never_saw_created_is_named_not_guessed(http, run):
    records = transcript(http, run["project_id"])["records"]
    records.append({"seq": 2, "action": "parameters", "ok": True,
                    "group_ids": ["never-created-id"], "groups": ["merge"],
                    "options": {"kmax": 18}})
    records.append({"seq": 3, "action": "align", "ok": True,
                    "group_ids": [run["groups"][FOILS[1]]], "groups": [FOILS[1]],
                    "options": {"method": "demeter-larch", "operation": "auto",
                                "standard_id": "another-never-created-id"}})

    result = replay(http, records, keep_going=True)

    assert [step.status for step in result.steps] == ["replayed", "diverged", "diverged"]
    assert "selects ['merge']" in result.divergences[0]
    assert "standard_id names a group" in result.divergences[1]


def test_a_change_outside_the_transcript_is_reported_but_not_fatal(http, run):
    ok(http, run, "parameters", [FOILS[0]], kmax=18)
    records = transcript(http, run["project_id"])["records"]
    records[1]["version_before"] += 1  # as if an import had happened in between

    result = replay(http, records)

    assert result.replayed() == 2
    assert len(result.divergences) == 1
    assert "outside the transcript" in result.divergences[0]


def test_the_transcript_is_read_as_json_lines_or_as_the_route_reply(tmp_path, http, run):
    log = transcript(http, run["project_id"])
    as_route = tmp_path / "log.json"
    as_route.write_text(json.dumps(log))
    as_lines = tmp_path / "transcript.jsonl"
    as_lines.write_text("".join(json.dumps(record) + "\n" for record in reversed(log["records"])))
    as_list = tmp_path / "list.json"
    as_list.write_text(json.dumps(log["records"]))

    assert load_records(as_route) == load_records(as_lines) == load_records(as_list) == log["records"]


def test_the_cli_replays_a_file_and_writes_a_run_file_check_can_read(tmp_path, http, run, capsys):
    unlink_align_merge(http, run)
    saved = tmp_path / "transcript.json"
    saved.write_text(json.dumps(transcript(http, run["project_id"])))
    out = tmp_path / "again.json"

    assert agent_suite.main(["replay", str(saved), "--out", str(out)], http=http) == 0
    printed = capsys.readouterr().out
    assert "replayed 4 commands" in printed
    assert "ok   seq 4 merge  +merge" in printed

    again = json.loads(out.read_text())
    assert again["project_id"] != run["project_id"]
    assert set(again["groups"]) == set(run["groups"])
    assert agent_suite.main(["check", "T2", str(out)], http=http) == 0
    assert "T2 PASS" in capsys.readouterr().out


def test_the_cli_exits_nonzero_on_a_divergence(tmp_path, http, run, capsys):
    ok(http, run, "deglitch", [FOILS[0]], indices=list(range(40)))
    saved = tmp_path / "transcript.json"
    saved.write_text(json.dumps(transcript(http, run["project_id"])))

    assert agent_suite.main(["replay", str(saved)], http=http) == 1
    assert "diverged: seq 2 deglitch" in capsys.readouterr().out
