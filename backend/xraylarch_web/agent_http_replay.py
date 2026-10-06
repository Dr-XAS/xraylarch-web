"""Replay saved HTTP science evidence in a fresh, private backend.

Unlike command transcripts, HTTP evidence includes FEFF inputs and read-only
fits. Replay requires the setup transcript prefix because the retained agent
runs begin after the copper example was loaded. No original backend is used.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from .agent_replay import ID_KEYS, _translate, condensed, load_records, replay

# Fit summaries retain six significant figures; distances r retain four decimals.
# A 1e-4 A distance change fails; deltar is also checked at six-figure precision.
TOLERANCES = {"relative": 2e-5, "absolute": 1e-9, "distance_absolute": 5e-5}
FIT_FIELDS = ("success", "statistics", "transform", "parameters", "paths",
              "correlations", "concerns", "warnings")
STATS = ("n_varys", "n_independent", "n_data", "chi_square", "reduced_chi_square",
         "r_factor", "aic", "bic", "errorbars")
TRANSFORM = ("fitspace", "kmin", "kmax", "kweight", "dk", "window", "rmin", "rmax", "dr")
PROJECT = re.compile(r"/api/(?:athena|artemis)/projects/([^/]+)")
FIT = re.compile(r"/api/artemis/projects/([^/]+)/groups/([^/]+)/fit$")
COMMAND = re.compile(r"/api/athena/projects/([^/]+)/command$")
JOB = re.compile(r"/api/artemis/feff/jobs/([^/]+)$")


def _require(value, condition, message):
    if not condition:
        raise ValueError(message)
    return value


def _number(value, name, *, nullable=False):
    if nullable and value is None:
        return
    _require(value, type(value) in (int, float) and math.isfinite(value),
             f"{name} must be a finite number")


def _finite(value, name="body"):
    if isinstance(value, dict):
        for key, item in value.items():
            _finite(item, f"{name}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _finite(item, f"{name}[{index}]")
    elif isinstance(value, float):
        _number(value, name)


def _keys(value, keys, name):
    _require(value, isinstance(value, dict), f"{name} must be an object")
    missing = set(keys) - value.keys()
    _require(value, not missing, f"{name} missing {sorted(missing)}")


def _rows(value, key, name, *, nonempty=True):
    _require(value, isinstance(value, list) and (bool(value) or not nonempty),
             f"{name} must be {'a nonempty' if nonempty else 'a'} list")
    seen = set()
    for row in value:
        _keys(row, (key,), name)
        ident = row[key]
        _require(ident, isinstance(ident, str) and ident and ident not in seen,
                 f"{name} has missing or duplicate {key}")
        seen.add(ident)


def fit_science(body: dict, request: dict | None = None) -> dict:
    """Validate all required summary quantities before selecting comparisons."""
    _keys(body, FIT_FIELDS, "fit")
    _finite(body)
    _require(body, not condensed(body), "fit response contains condensed scientific data")
    _require(body, type(body["success"]) is bool, "fit.success must be boolean")
    _keys(body["statistics"], STATS, "statistics")
    for key in STATS:
        if key == "errorbars":
            _require(body, type(body["statistics"][key]) is bool, "errorbars must be boolean")
        else:
            _number(body["statistics"][key], f"statistics.{key}")
    _keys(body["transform"], TRANSFORM, "transform")
    for key in ("kmin", "kmax", "dk", "rmin", "rmax", "dr"):
        _number(body["transform"][key], f"transform.{key}")
    _require(body, body["transform"]["fitspace"] in ("k", "r"), "invalid fitspace")
    _require(body, body["transform"]["window"] in ("hanning", "kaiser", "parzen", "welch"), "invalid window")
    weights = body["transform"]["kweight"]
    _require(weights, isinstance(weights, list) and bool(weights)
             and all(type(item) is int and 0 <= item <= 3 for item in weights),
             "transform.kweight must contain integer weights")
    _rows(body["parameters"], "name", "parameters")
    for row in body["parameters"]:
        _require(row, row.get("kind") in ("guess", "set", "def"), "invalid parameter kind")
        _require(row, row.get("at_bound") in (None, "min", "max"), "invalid at_bound flag")
        _keys(row, ("kind", "value", "stderr", "initial"), "parameter")
        for key in ("value", "initial", "stderr"):
            _number(row[key], f"parameter.{key}", nullable=key == "stderr")
    _rows(body["paths"], "id", "paths")
    for row in body["paths"]:
        _keys(row, ("label", "scatterers", "nleg", "degen", "reff", "r", "s02", "sigma2", "e0", "deltar"), "path")
        for key in ("nleg", "degen", "reff", "r", "s02", "sigma2", "e0", "deltar"):
            _number(row[key], f"path.{key}")
    for key in ("concerns", "warnings"):
        _require(body[key], isinstance(body[key], list) and all(isinstance(x, str) for x in body[key]),
                 f"{key} must be a list of strings")
    _require(body["correlations"], isinstance(body["correlations"], list), "correlations must be a list")
    pairs = set()
    for row in body["correlations"]:
        _keys(row, ("left", "right", "value"), "correlation")
        _number(row["value"], "correlation.value")
        pair = (row["left"], row["right"])
        _require(row, all(isinstance(x, str) for x in pair) and pair not in pairs,
                 "correlations have invalid or duplicate parameter pairs")
        pairs.add(pair)
    result = {key: copy.deepcopy(body[key]) for key in FIT_FIELDS}
    # Iteration counts and wall time are optimizer diagnostics, not science.
    result["statistics"].pop("nfev", None)
    result["parameters"].sort(key=lambda row: row["name"])
    if request is not None:
        expressions = {row["id"]: row.get("sigma2", "sig2") for row in request["paths"]}
        for row in result["paths"]:
            # Older summaries omitted this field; the recorded request retains it.
            row.setdefault("sigma2_expression", expressions[row["id"]])
    result["paths"].sort(key=lambda row: row["id"])
    result["correlations"].sort(key=lambda row: (row["left"], row["right"]))
    return result


def differences(expected, actual, path="") -> list[str]:
    """Compare complete typed trees; missing fields and nonfinite numbers fail."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        output = []
        for key in sorted(set(expected) | set(actual)):
            child = f"{path}.{key}" if path else key
            if key not in expected or key not in actual:
                output.append(f"{child}: field missing from {'expected' if key not in expected else 'actual'}")
            else:
                output.extend(differences(expected[key], actual[key], child))
        return output
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{path}: length {len(expected)} -> {len(actual)}"]
        return [line for index, (a, b) in enumerate(zip(expected, actual))
                for line in differences(a, b, f"{path}[{index}]")]
    if type(expected) in (int, float) and type(actual) in (int, float):
        atol = TOLERANCES["distance_absolute"] if path.endswith(".r") else TOLERANCES["absolute"]
        rtol = 0 if path.endswith(".r") or path.startswith("transform.") else TOLERANCES["relative"]
        if math.isfinite(expected) and math.isfinite(actual) and math.isclose(expected, actual, rel_tol=rtol, abs_tol=atol):
            return []
    elif type(expected) is type(actual) and expected == actual:
        return []
    return [f"{path}: {expected!r} -> {actual!r}"]


def load_http_records(path: Path | str) -> list[dict]:
    """Normalize combined middleware evidence or correlated runner tool events.

    The runner's bare http_result rows have no request ID and can arrive out
    of order. Only tool_result.call_seq provides a safe request association.
    """
    records = load_records(path)
    _require(records, bool(records), "empty HTTP evidence")
    if all("method" in row and "response" in row for row in records):
        return [{"seq": index, "method": row["method"], "path": row["path"],
                 "body": row.get("request"), "status": row["status"], "response": row["response"]}
                for index, row in enumerate(records, 1)]
    calls, replies = {}, {}
    for row in records:
        if row.get("kind") == "tool_call":
            _require(row, row.get("tool") == "http_request", "unsupported tool evidence; supply HTTP evidence.jsonl")
            _require(row, row["seq"] not in calls, "duplicate tool call sequence")
            calls[row["seq"]] = row
        elif row.get("kind") == "tool_result":
            _require(row, row.get("tool") == "http_request", "unsupported tool result")
            seq = row.get("call_seq")
            _require(row, seq not in replies, "duplicate result for tool call")
            replies[seq] = row
    _require(calls, bool(calls), "no correlated HTTP calls in evidence")
    _require(calls, set(calls) == set(replies), "missing or unmatched HTTP tool result")
    output = []
    for seq, call in sorted(calls.items()):
        args, reply = call["arguments"], replies[seq]["output"]
        _keys(args, ("method", "path"), f"call {seq}")
        _keys(reply, ("status", "body"), f"result {seq}")
        output.append({"seq": seq, "method": args["method"], "path": args["path"],
                       "body": args.get("body"), "status": reply["status"], "response": reply["body"]})
    return output


def _job_science(body):
    if any("metadata" in row for row in body.get("paths", [])):
        from .agent_fit import feff_job_summary
        body = feff_job_summary(body)
    _keys(body, ("status", "total_paths", "truncated", "warnings", "paths"), "FEFF job")
    _finite(body)
    _number(body["total_paths"], "FEFF total_paths")
    _require(body, type(body["truncated"]) is bool, "FEFF truncated must be boolean")
    _rows(body["paths"], "id", "FEFF paths")
    for row in body["paths"]:
        _keys(row, ("filename", "scatterers", "nleg", "degen", "reff", "kmax"), "FEFF path")
        for key in ("nleg", "degen", "reff", "kmax"):
            _number(row[key], f"FEFF path.{key}")
    return {key: body[key] for key in ("status", "total_paths", "truncated", "warnings", "paths")}


def _wait_job(http, job_id, timeout):
    deadline = time.monotonic() + timeout
    while True:
        response = http.get(f"/api/artemis/feff/jobs/{job_id}", params={"view": "summary"})
        response.raise_for_status()
        body = response.json()
        if body.get("status") == "complete":
            return body
        if body.get("status") not in ("pending", "queued", "running"):
            raise ValueError(f"FEFF job failed: {body.get('status')}: {body.get('message')}")
        if time.monotonic() >= deadline:
            raise ValueError(f"FEFF job timed out after {timeout:g} seconds")
        time.sleep(0.05)


def replay_http(http, records: list[dict], setup_records: list[dict], *, setup_seq: int,
                job_timeout: float = 180) -> dict:
    """Replay supported science operations. The caller owns an isolated client."""
    report = {"ok": False, "tolerances": TOLERANCES.copy(), "steps": [], "divergences": [],
              "fits": 0, "feff_jobs": 0, "commands": 0,
              "coverage": {"athena": "summary checkpoints only; use agent_suite diff for effective parameters",
                           "artemis": "completed FEFF path metadata and fit summary quantities",
                           "excluded": "arrays, digest/parameters observations, previews, rejected requests"},
              "ignored_fit_fields": ["statistics.nfev", "message", "note", "identity"]}
    try:
        _number(job_timeout, "job_timeout")
        _require(job_timeout, job_timeout > 0, "job_timeout must be positive")
        _require(records, bool(records), "empty HTTP evidence")
        prefix = [row for row in setup_records if row.get("seq", 0) <= setup_seq]
        _require(prefix, bool(prefix) and prefix[-1].get("seq") == setup_seq,
                 "setup transcript does not include the explicit setup sequence")
        _require(prefix, prefix[0].get("seq") == 1 and prefix[0].get("action") == "example",
                 "setup must start with the recorded example; imports need complete setup evidence")
        prepared = replay(http, prefix, name="HTTP scientific replay", setup_seq=setup_seq)
        _require(prepared, prepared.ok, f"setup replay diverged: {prepared.divergences}")
        ids = prepared.ids.copy()
        source_projects = {match.group(1) for row in records
                           if (match := PROJECT.match(urlsplit(row["path"]).path))}
        _require(source_projects, len(source_projects) == 1, "evidence must name exactly one source project")
        source_project = source_projects.pop()
        ids[source_project] = prepared.project_id
        version = prepared.version
        source_version = prefix[-1].get("version_after")
        report["project_id"] = prepared.project_id
        report["setup"] = prepared.setup
        jobs = {}
        verified_jobs = set()
        base = f"/api/athena/projects/{prepared.project_id}"
        current = http.get(base, params={"view": "summary"}).json()
        for record in records:
            seq, method = record["seq"], record["method"].upper()
            path = urlsplit(record["path"]).path
            step = {"seq": seq, "method": method, "path": path, "status": "replayed"}
            report["steps"].append(step)
            try:
                _require(record, record.get("status") is not None, "missing recorded response status")
                if record["status"] >= 400:
                    step.update(status="skipped", note="original rejected request")
                    continue
                body, expected = record.get("body"), record["response"]
                if method == "POST":
                    _require(body, isinstance(body, dict), "missing JSON request body")
                    _require(body, not condensed(body) and not re.search(r"<[^>]*(?:omitted|truncated)[^>]*>", json.dumps(body)),
                             "request scientific inputs were condensed or omitted")
                    _finite(body)
                if fit := FIT.fullmatch(path):
                    _require(method, method == "POST", "unsupported fit method")
                    from .artemis import FitRouteRequest
                    FitRouteRequest.model_validate(body, strict=True)
                    _require(body, "transform" in body, "missing recorded fit transform")
                    _require(body, body["version"] == source_version, "fit version disagrees with replay checkpoint; missing mutation")
                    _require(fit, fit.group(2) in ids, "fit group was never created")
                    for item in body["paths"]:
                        if "feff_job" in item:
                            _require(item, item["feff_job"] in jobs, "fit references FEFF job without a recorded submission")
                    _keys(expected, ("project_id", "group_id", "version"), "fit response identity")
                    _require(expected, (expected["project_id"], expected["group_id"], expected["version"])
                             == (source_project, fit.group(2), source_version),
                             "recorded fit response identity disagrees with its request")
                    expected_science = fit_science(expected, body)
                    request = _translate(body, ids | jobs)
                    request["version"] = version
                    target = f"/api/artemis/projects/{prepared.project_id}/groups/{ids[fit.group(2)]}/fit"
                    response = http.post(target, params={"view": "summary"}, json=request)
                    response.raise_for_status()
                    actual = response.json()
                    _require(actual, (actual.get("project_id"), actual.get("group_id"), actual.get("version"))
                             == (prepared.project_id, ids[fit.group(2)], version),
                             "replayed fit response identity disagrees with its request")
                    actual_science = fit_science(actual, body)
                    # Older summaries omitted the measured noise; compare it when recorded.
                    if "epsilon_k" not in expected_science["statistics"]:
                        actual_science["statistics"].pop("epsilon_k", None)
                    delta = differences(expected_science, actual_science)
                    step.update(expected=expected_science, actual=actual_science, differences=delta)
                    report["fits"] += 1
                elif path == "/api/artemis/feff/jobs" and method == "POST":
                    _require(body, "amcsd_id" in body and "attachment_id" not in body,
                             "only bundled AMCSD FEFF inputs supported; attached CIF setup is not recorded")
                    _keys(expected, ("id", "status"), "recorded FEFF submission")
                    response = http.post(path, params={"view": "summary"}, json=body)
                    response.raise_for_status()
                    new_job = response.json()["id"]
                    jobs[expected["id"]] = new_job
                    actual = _wait_job(http, new_job, job_timeout)
                    report["feff_jobs"] += 1
                    delta = differences(_job_science(expected), _job_science(actual)) if expected["status"] == "complete" else []
                    if expected["status"] == "complete":
                        verified_jobs.add(expected["id"])
                    step.update(actual=_job_science(actual), differences=delta)
                elif job := JOB.fullmatch(path):
                    _require(method, method == "GET", "unsupported FEFF operation")
                    _require(job, job.group(1) in jobs, "FEFF poll has no recorded submission")
                    if expected.get("status") != "complete":
                        step.update(status="skipped", note="transient FEFF poll; completion checked at submission")
                        continue
                    actual = _wait_job(http, jobs[job.group(1)], job_timeout)
                    delta = differences(_job_science(expected), _job_science(actual))
                    verified_jobs.add(job.group(1))
                    step.update(expected=_job_science(expected), actual=_job_science(actual), differences=delta)
                elif COMMAND.fullmatch(path) and method == "POST":
                    _keys(body, ("action", "version", "group_ids", "options"), "command")
                    _require(body, body["version"] == source_version, "command version disagrees with replay checkpoint; missing mutation or idempotency headers")
                    for gid in body["group_ids"]:
                        _require(gid, gid in ids, f"unknown command group {gid}")
                    for key in ID_KEYS:
                        gid = body["options"].get(key)
                        _require(gid, gid is None or gid in ids, f"unknown command {key}")
                    request = _translate(body, ids)
                    request["version"] = version
                    response = http.post(f"{base}/command", params={"view": "summary"}, json=request)
                    response.raise_for_status()
                    actual = response.json()
                    _keys(expected, ("groups", "version"), "command response")
                    _require(expected, expected["version"] - source_version == actual["version"] - version,
                             "command changed version by a different amount")
                    old_ids = {group["id"] for group in current["groups"]}
                    made = [group for group in actual["groups"] if group["id"] not in old_ids]
                    recorded_made = [group for group in expected["groups"] if ids.get(group["id"]) not in old_ids]
                    _require(made, len(made) == len(recorded_made), "command created a different number of groups")
                    for a, b in zip(recorded_made, made):
                        ids[a["id"]] = b["id"]
                    delta = _project_differences(expected, actual, ids)
                    version, source_version = actual["version"], expected["version"]
                    current = actual
                    step.update(differences=delta)
                    report["commands"] += 1
                elif method == "GET" and path == f"/api/athena/projects/{source_project}" and "counts" in expected:
                    _require(expected, expected.get("version") == source_version, "project observation reveals an unrecorded mutation")
                    actual = http.get(base, params={"view": "summary"}).json()
                    delta = _project_differences(expected, actual, ids)
                    step.update(differences=delta)
                elif method == "GET" or (method == "POST" and path.endswith("/preview")):
                    step.update(status="skipped", note="observation or preview outside scientific replay scope")
                    continue
                else:
                    raise ValueError(f"unsupported operation {method} {path}")
                if delta:
                    raise ValueError("; ".join(delta))
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                step.update(status="diverged", note=str(exc))
                report["divergences"].append(f"seq {seq}: {exc}")
                break
        report["ids"] = ids
        report["jobs"] = jobs
        from .agent_diff import snapshot
        report["final"] = snapshot(http, prepared.project_id)
        if set(jobs) - verified_jobs:
            report["divergences"].append("FEFF completion evidence missing for " + ", ".join(sorted(set(jobs) - verified_jobs)))
        if not (report["commands"] or report["feff_jobs"] or report["fits"]):
            report["divergences"].append("no scientific operations replayed")
        report["ok"] = not report["divergences"]
    except Exception as exc:
        # The CLI must retain a failed report even for a transport/FEFF error.
        report["divergences"].append(f"{type(exc).__name__}: {exc}")
        if report["steps"] and report["steps"][-1]["status"] == "replayed":
            report["steps"][-1].update(status="diverged", note=str(exc))
    completed = {step["seq"] for step in report["steps"]}
    report["steps"].extend({"seq": row["seq"], "method": row["method"], "path": row["path"],
                            "status": "not_replayed", "note": "blocked by earlier divergence"}
                           for row in records if row["seq"] not in completed)
    report["fit_validation"] = ("passed" if report["ok"] else "failed") if report["fits"] else "not_run"
    return report


def _project_differences(expected, actual, ids):
    _keys(expected, ("groups", "version"), "project summary")
    _rows(expected["groups"], "id", "project groups", nonempty=False)
    _rows(actual["groups"], "id", "project groups", nonempty=False)
    fields = ("id", "label", "data_type", "e0", "edge_step", "energy_shift", "range", "points",
              "processed", "processing_error", "reference_id", "background_standard_id", "derived", "warnings")
    def select(body):
        groups = []
        for group in body["groups"]:
            _keys(group, fields, "group summary")
            groups.append({key: group[key] for key in fields})
        return groups
    return differences(_translate(select(expected), ids), select(actual), "groups")


def private_replay(evidence: Path, transcript: Path, *, setup_seq: int, job_timeout=180) -> dict:
    """No network service or persistent FEFF cache participates in this replay."""
    from fastapi.testclient import TestClient
    from .config import Settings
    records, setup_records = load_http_records(evidence), load_records(transcript)
    with TemporaryDirectory(prefix="larch-science-replay-") as directory:
        previous = os.environ.get("XRAYLARCH_DATA_ROOT")
        os.environ["XRAYLARCH_DATA_ROOT"] = directory
        try:
            # main also builds its module-level app on first import.
            from .main import create_app
            with TestClient(create_app(Settings(data_root=Path(directory)))) as http:
                return replay_http(http, records, setup_records, setup_seq=setup_seq, job_timeout=job_timeout)
        finally:
            if previous is None:
                os.environ.pop("XRAYLARCH_DATA_ROOT", None)
            else:
                os.environ["XRAYLARCH_DATA_ROOT"] = previous
