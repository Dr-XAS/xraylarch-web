"""Scientific replay checks saved fits, including deliberate numerical drift."""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite
from xraylarch_web.agent_http_replay import (
    differences, fit_science, load_http_records, private_replay, replay_http, _wait_job,
)
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

ROOT = Path(__file__).resolve().parents[2]
T5 = ROOT / "docs/agent-runs/2026-10-05-native-vs-app/runs/t2-t5"


@pytest.fixture(scope="module")
def evidence():
    return load_http_records(T5 / "app-T5/events.jsonl")


@pytest.fixture
def fit(evidence):
    return copy.deepcopy(next(row["response"] for row in evidence if "/fit?" in row["path"]))


@pytest.mark.parametrize("section,key,delta", [
    ("paths", "r", 0.0001), ("paths", "sigma2", 1e-6),
    ("parameters", "stderr", 1e-4), ("parameters", "value", 0.001),
    ("statistics", "r_factor", 0.00001), ("transform", "kmax", 0.01),
])
def test_scientific_changes_fail(fit, section, key, delta):
    changed = copy.deepcopy(fit)
    target = changed[section][0] if isinstance(changed[section], list) else changed[section]
    target[key] += delta
    assert differences(fit_science(fit), fit_science(changed))


@pytest.mark.parametrize("section", ["paths", "parameters", "statistics", "transform", "concerns"])
def test_missing_science_is_rejected(fit, section):
    del fit[section]
    with pytest.raises(ValueError, match="missing"):
        fit_science(fit)


@pytest.mark.parametrize("bad", [True, float("nan"), float("inf"), "0.001"])
def test_invalid_numeric_science_is_rejected(fit, bad):
    fit["paths"][0]["sigma2"] = bad
    with pytest.raises(ValueError, match="finite number"):
        fit_science(fit)


def test_deleted_parameter_uncertainty_and_paths_do_not_pass(fit):
    changed = copy.deepcopy(fit)
    del changed["parameters"][0]["stderr"]
    with pytest.raises(ValueError, match="missing"):
        fit_science(changed)
    changed = copy.deepcopy(fit)
    changed["parameters"].pop()
    assert differences(fit_science(fit), fit_science(changed))
    fit["paths"] = []
    with pytest.raises(ValueError, match="nonempty"):
        fit_science(fit)


def test_concerns_and_bound_flags_are_compared(fit):
    changed = copy.deepcopy(fit)
    changed["concerns"].append("A bound stopped the fit.")
    changed["parameters"][0]["at_bound"] = "max"
    delta = differences(fit_science(fit), fit_science(changed))
    assert any("concerns" in item for item in delta)
    assert any("at_bound" in item for item in delta)
    assert differences(True, 1) and differences(float("nan"), float("nan"))


def test_out_of_order_http_results_use_call_sequence(tmp_path):
    rows = [
        {"seq": 1, "kind": "tool_call", "tool": "http_request", "arguments": {"method": "GET", "path": "/one"}},
        {"seq": 2, "kind": "tool_call", "tool": "http_request", "arguments": {"method": "GET", "path": "/two"}},
        {"seq": 3, "kind": "http_result", "output": {"body": "WRONG"}},
        {"seq": 4, "kind": "tool_result", "tool": "http_request", "call_seq": 2, "output": {"status": 200, "body": "second"}},
        {"seq": 5, "kind": "tool_result", "tool": "http_request", "call_seq": 1, "output": {"status": 200, "body": "first"}},
    ]
    path = tmp_path / "events.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in rows))
    assert [row["response"] for row in load_http_records(path)] == ["first", "second"]
    path.write_text("\n".join(json.dumps(row) for row in rows[:-1]))
    with pytest.raises(ValueError, match="missing or unmatched"):
        load_http_records(path)


def test_empty_and_uncorrelated_evidence_fail(tmp_path):
    path = tmp_path / "events.jsonl"
    for contents in ("", '{"kind":"http_result","output":{}}'):
        path.write_text(contents)
        with pytest.raises(ValueError):
            load_http_records(path)


@pytest.fixture(scope="module")
def mixed(tmp_path_factory, evidence):
    """Real command, FEFF run and fit with an updated project checkpoint."""
    with TestClient(create_app(Settings(data_root=tmp_path_factory.mktemp("source")))) as http:
        run = agent_suite.setup(http)
        base = f"/api/athena/projects/{run['project_id']}"
        setup = http.get(f"{base}/transcript").json()["records"]
        rows = []
        def post(path, body):
            response = http.post(path, params={"view": "summary"}, json=body)
            assert response.status_code in (200, 202), response.text
            rows.append({"seq": len(rows) + 1, "method": "POST", "path": path,
                         "body": body, "status": response.status_code, "response": response.json()})
            return response.json()
        gid = run["groups"]["Cu foil · 10 K"]
        current = post(f"{base}/command", {"version": run["version"], "action": "parameters",
                                             "group_ids": [gid], "options": {"kmax": 14}})
        job = post("/api/artemis/feff/jobs", {"amcsd_id": 11145, "absorber": "Cu", "site_index": 1,
                                              "path_radius": 3, "cluster_radius": 5})
        completed = _wait_job(http, job["id"], 30)
        rows.append({"seq": len(rows) + 1, "method": "GET", "path": f"/api/artemis/feff/jobs/{job['id']}",
                     "body": None, "status": 200, "response": completed})
        request = copy.deepcopy(next(row["body"] for row in evidence if "/fit?" in row["path"]))
        request["version"] = current["version"]
        request["paths"][0]["feff_job"] = job["id"]
        request["transform"]["kmax"] = 14
        post(f"/api/artemis/projects/{run['project_id']}/groups/{gid}/fit", request)
        yield rows, setup


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


def test_mixed_replay_creates_fresh_state_and_checks_all_science(http, mixed):
    rows, setup = mixed
    result = replay_http(http, rows, setup, setup_seq=1)
    assert result["ok"], result["divergences"]
    assert result["commands"] == result["fits"] == result["feff_jobs"] == 1
    assert result["fit_validation"] == "passed"
    assert all(old != new for old, new in result["ids"].items())
    assert all(old != new for old, new in result["jobs"].items())
    assert result["final"]["summary"]["version"] == 2


def test_changed_distance_fails_real_replay(http, mixed):
    rows, setup = copy.deepcopy(mixed)
    rows[-1]["response"]["paths"][0]["r"] += 0.001
    result = replay_http(http, rows, setup, setup_seq=1)
    assert not result["ok"] and result["fit_validation"] == "failed"
    assert "paths[0].r" in result["divergences"][0]


@pytest.mark.parametrize("mutation,match", [("condensed", "condensed"), ("unknown_job", "without a recorded"),
                                           ("version", "checkpoint"), ("unsupported", "unsupported")])
def test_incomplete_inputs_fail_explicitly(http, mixed, mutation, match):
    rows, setup = copy.deepcopy(mixed)
    if mutation == "condensed":
        rows[0]["body"]["options"]["indices"] = "<40 numbers, 0 .. 39>"
    elif mutation == "unknown_job":
        rows[-1]["body"]["paths"][0]["feff_job"] = "f" * 32
    elif mutation == "version":
        rows[0]["body"]["version"] += 1
    else:
        rows[0]["path"] += "/unknown"
    result = replay_http(http, rows, setup, setup_seq=1)
    assert not result["ok"] and match in result["divergences"][0]
    if mutation in ("condensed", "version", "unsupported"):
        assert result["steps"][-1]["status"] == "not_replayed"


def test_cached_recording_still_runs_a_new_feff_job(http, mixed):
    rows, setup = copy.deepcopy(mixed)
    rows[1]["response"] = copy.deepcopy(rows[2]["response"])
    rows[1]["response"]["reused"] = True
    rows[1]["status"] = 200
    result = replay_http(http, rows, setup, setup_seq=1)
    assert result["ok"], result["divergences"]
    assert result["feff_jobs"] == 1


def test_cli_writes_failure_report_for_missing_evidence(tmp_path, capsys):
    out = tmp_path / "report.json"
    assert agent_suite.main(["replay-http", str(tmp_path / "absent"), "--setup-transcript", str(tmp_path / "absent"),
                             "--setup-seq", "1", "--out", str(out)]) == 1
    assert not json.loads(out.read_text())["ok"]
    assert "FAIL" in capsys.readouterr().out


def test_retained_t5_replays_six_fits_in_private_state(monkeypatch, tmp_path):
    data_root = tmp_path / "original-store"
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(data_root))
    result = private_replay(T5 / "app-T5/events.jsonl", T5 / "app-T5-runtime/transcript.jsonl", setup_seq=1)
    assert result["ok"], result["divergences"]
    assert result["fits"] == 6 and result["feff_jobs"] == 1
    assert not data_root.exists()


def test_feff_without_recorded_completion_is_unverified(http, mixed):
    rows, setup = copy.deepcopy(mixed)
    result = replay_http(http, rows[:2], setup, setup_seq=1)
    assert not result["ok"]
    assert "completion evidence missing" in result["divergences"][0]
    assert result["fit_validation"] == "not_run"


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0, -1, True])
def test_invalid_job_timeout_fails_before_setup(http, mixed, timeout):
    rows, setup = mixed
    result = replay_http(http, rows, setup, setup_seq=1, job_timeout=timeout)
    assert not result["ok"] and "job_timeout" in result["divergences"][0]
    assert "project_id" not in result


def test_fit_result_must_belong_to_recorded_request(http, mixed):
    rows, setup = copy.deepcopy(mixed)
    rows[-1]["response"]["group_id"] = "different-group"
    result = replay_http(http, rows, setup, setup_seq=1)
    assert not result["ok"] and "identity" in result["divergences"][0]


def test_delete_then_undo_maps_restored_group(http):
    run = agent_suite.setup(http)
    base = f"/api/athena/projects/{run['project_id']}"
    setup = http.get(f"{base}/transcript").json()["records"]
    rows = []
    version = run["version"]
    for action, groups in (("delete", [run["groups"]["Cu foil · 10 K"]]), ("undo", [])):
        body = {"version": version, "action": action, "group_ids": groups, "options": {}}
        response = http.post(f"{base}/command", params={"view": "summary"}, json=body)
        assert response.status_code == 200, response.text
        rows.append({"seq": len(rows)+1, "method": "POST", "path": f"{base}/command", "body": body,
                     "status": 200, "response": response.json()})
        version = response.json()["version"]
    result = replay_http(http, rows, setup, setup_seq=1)
    assert result["ok"], result["divergences"]
    assert result["commands"] == 2 and result["fit_validation"] == "not_run"
    assert len(result["final"]["summary"]["groups"]) == 5


def test_combined_evidence_format_preserves_file_order(tmp_path, mixed):
    rows, _ = mixed
    path = tmp_path / "evidence.jsonl"
    path.write_text("\n".join(json.dumps({"method": row["method"], "path": row["path"], "request": row["body"],
                                         "response": row["response"], "status": row["status"]}) for row in rows))
    assert load_http_records(path) == rows
