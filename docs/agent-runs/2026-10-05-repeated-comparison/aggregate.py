"""Deterministically aggregate frozen attempt evidence; missing checks stay unknown."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import statistics

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("paired_science", BASE.parent / "2026-10-05-native-vs-app/compare_science.py")
science = importlib.util.module_from_spec(spec)
spec.loader.exec_module(science)
FOILS = science.FOILS


def correlated_http_results(events):
    """Join overlapping requests by tool call identity, in request-start order."""
    calls = {e["seq"]: e for e in events if e.get("kind") == "tool_call" and e.get("tool") == "http_request"}
    results = {e.get("call_seq"): e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "http_request"}
    for seq, call in sorted(calls.items()):
        event = results.get(seq)
        if event is None:
            continue
        output = event.get("output") or {}
        if not isinstance(output, dict):
            continue
        body, code = output.get("body"), output.get("status")
        if isinstance(code, int) and 200 <= code < 300 and science.successful(body):
            yield event, call.get("arguments") or {}, body


def correlated_native_results(events):
    """Keep native result identity and select qualifying fits in call-start order."""
    calls = {e["seq"]: e for e in events if e.get("kind") == "tool_call"}
    results = {e.get("call_seq"): e for e in events if e.get("kind") == "tool_result"}
    for seq, call in sorted(calls.items()):
        event = results.get(seq)
        if event is not None and science.successful(event.get("output")):
            yield event, call.get("arguments") or {}, event["output"]


# The baseline comparator assumes serial http_request/http_result events. The SDK
# can overlap calls despite its configured setting, so use identity-aware joins.
science.http_results = correlated_http_results
science.native_tool_results = correlated_native_results


def read(path, default=None):
    return json.loads(path.read_text()) if path.is_file() else default


def status(checks):
    values = list(checks.values())
    return "fail" if False in values else "unknown" if not values or None in values else "pass"


def close(value, expected, tolerance):
    value = science.number(value)
    return None if value is None else abs(value - expected) <= tolerance


def bounded(value, low, high):
    value = science.number(value)
    return None if value is None else low <= value <= high


def all_known(values):
    values = list(values)
    return False if False in values else None if not values or None in values else True


def numeric_range(values):
    values = [v for v in values if science.number(v) is not None]
    return {"n": len(values), "min": min(values), "max": max(values)} if values else {"n": 0, "min": None, "max": None}


def metric_median(rows, name):
    values = [r[name] for r in rows if science.number(r.get(name)) is not None]
    return {"n": len(values), "median": statistics.median(values) if values else None}


def analyze_attempt(root, repeat, task, arm, pair, fixture, grades):
    unit = root / f"repeat-{repeat}" / task
    directory = unit / f"{arm}-{task}"
    run = read(directory / "run.json", {})
    partial = read(directory / "run.partial.json", {})
    native = read(unit / f"native-{task}/science.json", {})
    event_path = directory / "events.jsonl"
    events = [json.loads(line) for line in event_path.read_text().splitlines()] if event_path.is_file() else []
    runtime = read(unit / f"app-{task}-runtime/run.json", {})
    initial = read(unit / f"app-{task}-runtime/initial-summary.json", {})
    snapshot = runtime.get("final", {})
    checks, values, caveats = {}, {}, []
    manifest = read(unit / "manifest.json", {})
    launch = manifest.get("pairs", {}).get(task, {}).get(arm, {})
    if arm == "native":
        raw = read(directory / "native-state.json", {})
        raw_checks = raw.get("checks", {})
        raw_pass = raw.get("state_passed")
    else:
        raw_checks = {"frozen_suite_returncode": launch.get("state_returncode")}
        raw_pass = launch.get("state_returncode") == 0 if "state_returncode" in launch else None
        if raw_pass is None:
            report_path = unit / f"app-{task}-runtime/report.txt"
            header = report_path.read_text().splitlines()[0] if report_path.is_file() else None
            raw_pass = True if header == f"{task} PASS" else False if header == f"{task} FAIL" else None
            raw_checks["recovered_from_report_header"] = header
    task_state = {"frozen_suite": raw_pass}
    details = pair["details"]
    if task == "T1":
        originals = science.original_map(native) if arm == "native" else science.group_map(initial)
        expected = ((8977.58, 2.2987522766566553), (8977.58, 2.2895627605421636), (8980.5, 2.729378951827502))
        for label, (e0, step) in zip(FOILS, expected):
            row = originals.get(label, {})
            for key, target, tolerance in (("e0", e0, .1), ("edge_step", step, .005)):
                values[label + "." + key] = row.get(key)
                checks[label + "." + key] = close(row.get(key), target, tolerance)
    elif task == "T2":
        for label, expected in zip(FOILS[1:], (-.018, -2.959)):
            row = next((r for r in pair["comparisons"] if r["field"] == label + ".alignment_shift_ev"), {})
            value = row.get(arm)
            values[label + ".alignment_shift_ev"] = value
            checks[label + ".alignment_shift_ev"] = close(value, expected, .1)
        checks["merge_and_alignment_workflow"] = raw_pass
    elif task == "T3":
        transform = details.get(arm + "_transform") or {}
        for key in ("kmin", "kmax", "r_peak"):
            values[key] = transform.get(key)
        checks["kmin_preserved"] = close(transform.get("kmin"), 3, 1e-6)
        checks["kmax_reduced"] = (transform.get("kmax") < 24 if science.number(transform.get("kmax")) is not None else None)
        checks["peak_near_2.30"] = close(transform.get("r_peak"), 2.3, .1)
        task_state["kmin_preserved"] = checks["kmin_preserved"]
        if arm == "app":
            params = {g["label"]: g for g in snapshot.get("parameters", {}).get("groups", [])}
            other = [params.get(g["label"], {}).get("requested") == g["parameters"]
                     if g["label"] in params else None for g in fixture["spectra"] if g["label"] != FOILS[0]]
            task_state["other_group_parameters_unchanged"] = all_known(other)
            actual = (params.get(FOILS[0]) or {}).get("requested") or {}
            expected = next(g["parameters"] for g in fixture["spectra"] if g["label"] == FOILS[0])
            changes = {k: {"initial": v, "final": actual.get(k)} for k, v in expected.items()
                       if k != "kmax" and actual.get(k) != v}
        else:
            task_state["other_group_parameters_unchanged"] = raw_checks.get("no_other_spectrum_processed")
            expected = next((g.get("ft") for g in native.get("originals", []) if g.get("label") == FOILS[0]), {}) or {}
            final_science = read(directory / "final-science.json", {})
            artifact = final_science.get("artifacts", {}).get(transform.get("xas_ref"), {})
            actual = artifact.get("ft") or transform.get("requested") or transform.get("ft") or {}
            # Normalized evidence records the effective transform in direct fields.
            actual = {**actual, **{k: transform[k] for k in expected if k in transform}}
            changes = {k: {"initial": v, "final": actual[k]} for k, v in expected.items()
                       if k != "kmax" and k in actual and actual[k] != v}
        missing = sorted(k for k in expected if k != "kmax" and k not in actual)
        if missing:
            caveats.append({"unobserved_transform_parameters": missing})
        if changes:
            caveats.append({"unrequested_parameter_changes": changes})
        checks["task_state"] = {"pass": True, "fail": False, "unknown": None}[status(task_state)]
    elif task == "T4":
        value = pair["comparisons"][0].get(arm)
        values["merged_energy_max_ev"] = value
        checks["endpoint_near_10140"] = close(value, 10140, 15)
        checks["all_three_parents_and_one_merge"] = raw_pass
    elif task == "T5":
        fit = details.get("fits", {}).get(arm + "_first") or {}
        for key in ("r", "stderr", "sigma2", "rfactor"):
            values[key] = fit.get(key)
        checks["qualifying_10K_12_neighbour_fit"] = True if fit else None
        checks["distance_2.52_to_2.58"] = bounded(fit.get("r"), 2.52, 2.58)
        if fit.get("concerns"):
            caveats.append({"fit_concerns": fit["concerns"]})
    completed = run.get("status") == "completed"
    usage = run if completed else (partial.get("usage") or {})
    elapsed = run.get("agent_wall_seconds")
    if not completed:
        caveats.append({"incomplete_attempt": partial or {"status": "missing"}})
    checks["attempt_completed"] = completed
    task_state["attempt_completed"] = completed
    timing = runtime if arm == "app" else launch
    process_seconds = timing["finished"] - timing["started"] if "finished" in timing and "started" in timing else None
    timing_source = "app runtime run.json model-only started/finished" if arm == "app" else "pair manifest model_run started/finished"
    outstanding, peak_outstanding = set(), 0
    for event in events:
        if event.get("kind") == "tool_call":
            outstanding.add(event["seq"])
            peak_outstanding = max(peak_outstanding, len(outstanding))
        elif event.get("kind") in {"tool_result", "tool_error"}:
            outstanding.discard(event.get("call_seq"))
    key = f"repeat-{repeat}/{task}/{arm}"
    grade = grades.get(key, {})
    combined = {"state": {"pass": True, "fail": False, "unknown": None}[status(task_state)],
                "science": {"pass": True, "fail": False, "unknown": None}[status(checks)],
                "answer": {"pass": True, "fail": False}.get(grade.get("status"))}
    return {"repeat": repeat, "task": task, "arm": arm, "status": run.get("status", partial.get("status", "missing")),
            "frozen_state_passed": raw_pass, "frozen_state_checks": raw_checks,
            "task_state_status": status(task_state), "task_state_checks": task_state,
            "scientific_status": status(checks), "scientific_checks": checks, "values": values,
            "cross_arm_status": pair["numerical_status"], "caveats": caveats,
            "answer_grade": grade or {"status": "ungraded"}, "combined_status": status(combined),
            "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
            "tool_calls": run.get("tool_calls", sum(e.get("kind") == "tool_call" for e in events) if events else None),
            "rejected_tool_calls": run.get("rejected_tool_calls", sum(e.get("kind") == "tool_error" for e in events) if events else None),
            "max_outstanding_tool_calls": peak_outstanding if events else None,
            "process_wall_seconds": process_seconds, "process_timing_provenance": timing_source,
            "agent_wall_seconds": elapsed, "incomplete_total_wall_seconds": partial.get("total_wall_seconds"),
            "provider_metadata": read(directory / "provider.json", run.get("provider_metadata")),
            "answer": str(directory.relative_to(BASE) / "answer.md") if (directory / "answer.md").is_file() else None}


def aggregate(root, fixture, grades):
    rows, paired = [], {}
    for repeat in range(1, 4):
        compared = science.compare_runs(root / f"repeat-{repeat}")
        paired[f"repeat-{repeat}"] = compared
        for task in science.TASKS:
            for arm in ("native", "app"):
                rows.append(analyze_attempt(root, repeat, task, arm, compared["tasks"][task], fixture, grades))
    summaries = []
    for task in science.TASKS:
        for arm in ("native", "app"):
            selected = [r for r in rows if r["task"] == task and r["arm"] == arm]
            summaries.append({"task": task, "arm": arm, "attempts": 3,
                "completed": sum(r["status"] == "completed" for r in selected),
                "frozen_state_passes": sum(r["frozen_state_passed"] is True for r in selected),
                "task_state": {s: sum(r["task_state_status"] == s for r in selected) for s in ("pass", "fail", "unknown")},
                "scientific": {s: sum(r["scientific_status"] == s for r in selected) for s in ("pass", "fail", "unknown")},
                "combined": {s: sum(r["combined_status"] == s for r in selected) for s in ("pass", "fail", "unknown")},
                "answer": {s: sum(r["answer_grade"].get("status") == s for r in selected) for s in ("pass", "fail", "ungraded")},
                "metrics": {name: metric_median(selected, name) for name in ("input_tokens", "output_tokens", "tool_calls", "agent_wall_seconds", "process_wall_seconds")},
                "numeric_ranges": {key: numeric_range(r["values"].get(key) for r in selected) for key in sorted({k for r in selected for k in r["values"]})}})
    return {"schema_version": 1, "scheduled_attempts": 30, "runs": rows, "summaries": summaries, "paired_science": paired,
            "interpretation": "Observed counts in three fixed attempts per task and arm; no population reliability or general ranking estimate."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, default=BASE / "runs")
    parser.add_argument("--grades", type=Path, default=BASE / "answer-grades.json")
    parser.add_argument("--out", type=Path, default=BASE / "results.json")
    args = parser.parse_args()
    fixture = read(BASE.parent / "2026-10-05-native-vs-app/fixture/fixture.json")
    result = aggregate(args.runs.resolve(), fixture, read(args.grades, {}))
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"attempts": len(result["runs"]), "completed": sum(r["status"] == "completed" for r in result["runs"])}))

if __name__ == "__main__":
    main()
