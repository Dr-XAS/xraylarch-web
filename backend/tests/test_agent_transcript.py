"""The record of what was asked for, which the project record does not keep."""
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_transcript
from xraylarch_web.agent_transcript import Transcript, _condense, _trim
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def project(client):
    return client.post("/api/athena/projects").json()["id"]


def send(client, ident, action, groups=(), options=None, version=None, key=None):
    if version is None:
        version = client.get(f"/api/athena/projects/{ident}",
                             params={"view": "summary"}).json()["version"]
    return client.post(
        f"/api/athena/projects/{ident}/command",
        json={"version": version, "action": action,
              "group_ids": list(groups), "options": options or {}},
        headers={"Idempotency-Key": key} if key else None,
    )


def log(client, ident, **params):
    response = client.get(f"/api/athena/projects/{ident}/transcript", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def group_ids(client, ident):
    summary = client.get(f"/api/athena/projects/{ident}",
                         params={"view": "summary"}).json()
    return [group["id"] for group in summary["groups"]]


def test_a_successful_command_records_what_it_was_asked_and_what_it_made(client, project):
    assert send(client, project, "example").status_code == 200
    first, second = group_ids(client, project)[:2]
    assert send(client, project, "merge", [first, second]).status_code == 200

    records = log(client, project)["records"]
    assert [record["seq"] for record in records] == [1, 2]
    merge = records[1]
    assert merge["action"] == "merge"
    assert merge["ok"] is True
    assert merge["group_ids"] == [first, second]
    # Labels, so the record stays legible once the opaque ids mean nothing.
    assert merge["groups"] == ["Cu foil · 10 K", "Cu foil · 50 K"]
    assert (merge["version_before"], merge["version_after"]) == (1, 2)
    assert [created["label"] for created in merge["created"]] == ["Merge · 2 groups"]


def test_a_rejected_command_is_recorded_as_carefully_as_one_that_worked(client, project):
    send(client, project, "example")
    first = group_ids(client, project)[0]
    assert send(client, project, "sharpen", [first]).status_code == 400

    failure = log(client, project)["records"][-1]
    assert failure["ok"] is False
    assert failure["action"] == "sharpen"
    assert failure["error"]["code"] == "athena_invalid"
    # An agent's error rate is the measurement, so the attempt survives even
    # though nothing about the project changed.
    assert "version_after" not in failure


def test_a_stale_version_is_recorded_and_told_which_version_to_resend(client, project):
    send(client, project, "example")
    response = send(client, project, "merge", group_ids(client, project)[:2], version=0)
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "stale_revision"
    # The generic "review the values" recovery sends a caller hunting for a
    # mistake it did not make. The current version is the whole answer.
    assert "version 1" in error["recovery"]

    record = log(client, project)["records"][-1]
    assert (record["requested_version"], record["version_before"]) == (0, 1)


def test_a_retry_under_the_same_key_is_answered_rather_than_run_again(client, project):
    send(client, project, "example")
    loaded = group_ids(client, project)
    first, second = loaded[:2]
    version = client.get(f"/api/athena/projects/{project}",
                         params={"view": "summary"}).json()["version"]

    ran = send(client, project, "merge", [first, second], version=version, key="k-1")
    assert ran.status_code == 200
    # The same request a client would send after a timeout: same key, and the
    # version it still believes in, which is now stale.
    retry = send(client, project, "merge", [first, second], version=version, key="k-1")
    assert retry.status_code == 200, "a keyed retry must not come back as a conflict"

    assert len(ran.json()["groups"]) == len(retry.json()["groups"]) == len(loaded) + 1
    replay = retry.json()["last_operation"]["idempotent_replay"]
    assert replay["seq"] == 2 and replay["version_after"] == ran.json()["version"]

    records = log(client, project)["records"]
    assert records[-1]["replay_of"] == 2
    assert sum(1 for record in records if record["action"] == "merge") == 2


def test_a_third_retry_is_answered_by_the_command_that_actually_ran(client, project):
    send(client, project, "example")
    first = group_ids(client, project)[0]
    version = client.get(f"/api/athena/projects/{project}",
                         params={"view": "summary"}).json()["version"]
    send(client, project, "parameters", [first], {"kmax": 12}, version=version, key="k-2")
    for _ in range(2):
        send(client, project, "parameters", [first], {"kmax": 12}, version=version, key="k-2")
    # Every replay points at record 2, not at the previous replay.
    replays = [r for r in log(client, project)["records"] if r.get("replay_of")]
    assert [replay["replay_of"] for replay in replays] == [2, 2]


def test_a_different_key_runs_the_command_again(client, project):
    send(client, project, "example")
    loaded = group_ids(client, project)
    first, second = loaded[:2]
    send(client, project, "merge", [first, second], key="k-a")
    assert send(client, project, "merge", [first, second], key="k-b").status_code == 200
    assert len(group_ids(client, project)) == len(loaded) + 2


def test_since_returns_only_what_a_caller_has_not_read(client, project):
    send(client, project, "example")
    send(client, project, "project", options={"name": "Copper"})
    seen = log(client, project)["records"][-1]["seq"]
    send(client, project, "project", options={"name": "Copper series"})

    fresh = log(client, project, since=seen)["records"]
    assert [record["seq"] for record in fresh] == [seen + 1]
    assert log(client, project, limit=1)["records"][0]["seq"] == seen + 1


def test_the_log_stays_small_enough_to_read(client, project):
    send(client, project, "example")
    first = group_ids(client, project)[0]
    for kmax in range(8, 14):
        send(client, project, "parameters", [first], {"kmax": kmax})
    payload = log(client, project)
    assert payload["count"] == 7
    # Seven commands against a four-group project, well under the ~420 tokens
    # that the whole project summary costs.
    assert len(json.dumps(payload)) < 4000


def test_point_indices_are_recorded_as_a_shape_rather_than_as_digits(client, project):
    send(client, project, "example")
    first = group_ids(client, project)[0]
    send(client, project, "deglitch", [first], {"indices": list(range(40))})
    record = log(client, project)["records"][-1]
    assert record["options"]["indices"] == "<40 numbers, 0 .. 39>"


def test_an_oversized_options_dict_does_not_bloat_the_record():
    big = _trim({"action": "x", "options": {f"k{i}": "v" * 60 for i in range(200)}})
    assert big["options"].startswith("<omitted,")
    assert len(json.dumps(big)) < 200


def test_condensing_leaves_settings_alone():
    # Short lists are settings -- a two-point range, a pair of weights -- and
    # are worth keeping exactly.
    assert _condense({"range": [3.0, 12.0], "window": "hanning"}) == {
        "range": [3.0, 12.0], "window": "hanning"}


def test_the_transcript_does_not_grow_without_bound(tmp_path, monkeypatch):
    from xraylarch_web.storage import WorkspaceStorage
    monkeypatch.setattr(agent_transcript, "MAX_RECORDS", 20)
    storage = WorkspaceStorage(tmp_path)
    storage.workspace_dir("a" * 20, create=True)
    transcript = Transcript(storage)
    for _ in range(25):
        transcript.append("a" * 20, {"action": "parameters", "ok": True})
    records = transcript.read("a" * 20)
    assert len(records) == 20
    # Trimming drops the oldest; it never renumbers, so a `since` cursor held
    # across the trim still means what it meant.
    assert records[-1]["seq"] == 25
    assert records[0]["seq"] == 6


def test_a_half_written_line_does_not_hide_the_rest(tmp_path):
    from xraylarch_web.storage import WorkspaceStorage
    storage = WorkspaceStorage(tmp_path)
    storage.workspace_dir("b" * 20, create=True)
    transcript = Transcript(storage)
    transcript.append("b" * 20, {"action": "example", "ok": True})
    with open(storage.path("b" * 20, "transcript.jsonl"), "a") as handle:
        handle.write('{"seq": 2, "action": "mer\n')
    transcript.append("b" * 20, {"action": "merge", "ok": True})
    assert [record["action"] for record in transcript.read("b" * 20)] == ["example", "merge"]


def test_an_integration_project_keeps_no_transcript(tmp_path):
    """The v2 seam is the one place this must not touch.

    It snapshots every file in the workspace before a mutation and restores
    them if it raises, so a transcript there would count against the caller's
    byte quota and be rolled back for exactly the failures worth keeping.
    """
    from tests.test_integration_api import capability, enabled_settings, launch_session

    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        session = launch_session(client)
        ident = session["project_id"]
        response = client.post(
            f"/api/athena/projects/{ident}/command",
            headers=capability(session["owner_capability"]),
            json={"version": 0, "action": "metadata",
                  "group_ids": [session["group_id"]],
                  "options": {"label": "Renamed"}})
        assert response.status_code == 200, response.text

        workspace = tmp_path / "athena" / ident
        assert not (workspace / "transcript.jsonl").exists()
        # The route is deliberately absent from the seam's operation map, so
        # the project is invisible here rather than reporting an empty log.
        assert client.get(f"/api/athena/projects/{ident}/transcript",
                          headers=capability(session["owner_capability"])).status_code == 404


def test_a_truncated_list_says_that_it_was_truncated():
    # A reorder of a hundred groups sends a hundred ids, and a reader must be
    # able to tell a short list from the start of a long one.
    condensed = _condense({"ids": [f"g{index}" for index in range(40)]})["ids"]
    assert len(condensed) == 33 and condensed[-1] == "<+8 more>"


def preview(client, ident, path, action, groups=(), options=None, version=None):
    if version is None:
        version = client.get(f"/api/athena/projects/{ident}",
                             params={"view": "summary"}).json()["version"]
    return client.post(f"/api/athena/projects/{ident}/{path}", json={
        "version": version, "action": action,
        "group_ids": list(groups), "options": options or {}})


def test_a_refused_preview_is_recorded_where_a_refused_command_would_be(client, project):
    """Rejections in the look-before-you-leap path used to leave no trace.

    That is where an arm that is guessing spends its turns, so a transcript
    holding only /command reported every arm as having made no mistakes.
    """
    send(client, project, "example")
    first, second = group_ids(client, project)[:2]

    refused = preview(client, project, "alignment/preview", "align", [first, second],
                      {"method": "demeter-larch", "standard_id": second,
                       "operation": "inspect"})
    assert refused.status_code == 400

    record = log(client, project)["records"][-1]
    assert record["action"] == "align"
    assert record["preview"] is True
    assert record["ok"] is False
    assert "one current group at a time" in record["error"]["message"]
    assert record["groups"] == ["Cu foil · 10 K", "Cu foil · 50 K"]
    assert "version_after" not in record, "a preview saves nothing"


def test_an_accepted_preview_is_recorded_too_and_says_nothing_moved(client, project):
    send(client, project, "example")
    first, second = group_ids(client, project)[:2]
    version = client.get(f"/api/athena/projects/{project}",
                         params={"view": "summary"}).json()["version"]

    assert preview(client, project, "merge/preview", "merge", [first, second],
                   {"method": "demeter-larch"}).status_code == 200

    record = log(client, project)["records"][-1]
    assert (record["action"], record["preview"], record["ok"]) == ("merge", True, True)
    assert record["version_before"] == version
    assert "created" not in record
    assert client.get(f"/api/athena/projects/{project}",
                      params={"view": "summary"}).json()["version"] == version


def test_previews_can_be_counted_out_of_the_commands(client, project):
    """`preview: true` is what lets 'commands rejected' mean one thing or the other."""
    send(client, project, "example")
    first = group_ids(client, project)[0]

    # Two guesses at truncate's modes, one of them deglitch's, then the real one.
    preview(client, project, "point-edit/preview", "truncate", [first], {"mode": "range",
            "xmin": 9000.0, "xmax": 9500.0})
    preview(client, project, "point-edit/preview", "truncate", [first],
            {"mode": "truncate", "side": "after", "value": 10146.0})
    send(client, project, "truncate", [first],
         {"mode": "truncate", "side": "after", "value": 10146.0})

    records = log(client, project)["records"]
    previews = [record for record in records if record.get("preview")]
    commands = [record for record in records if not record.get("preview")]
    assert len(previews) == 2 and len(commands) == 2
    assert sum(1 for record in records if not record["ok"]) == 1
    assert sum(1 for record in commands if not record["ok"]) == 0, (
        "the mistake was made and recovered from entirely inside the preview path")


def test_a_preview_against_a_missing_project_records_nothing(client):
    """record_preview must not invent a workspace for a project that has none."""
    response = preview(client, "no" * 12, "merge/preview", "merge", ["x", "y"],
                       {"method": "demeter-larch"}, version=0)
    assert response.status_code == 404
    assert client.get(f"/api/athena/projects/{'no' * 12}/transcript").status_code == 404
