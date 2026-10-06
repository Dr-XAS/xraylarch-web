#!/usr/bin/env python3
"""Reproduce retained science replays without touching their source recordings."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

IMPLEMENTATION_REVISION = "ee1dde1cd"
ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
REPEATS = ROOT / "docs/agent-runs/2026-10-05-repeated-comparison/runs"
BASE = ROOT / "docs/agent-runs/2026-10-05-native-vs-app/runs/t2-t5"


def read(path):
    return json.loads(path.read_text())


def write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path):
    return str(path.relative_to(ROOT))


def cases():
    old = ROOT / "docs/agent-runs/2026-10-05/http-t5"
    yield "baseline-http-T5", "T5", old / "evidence.jsonl", old / "transcript.jsonl", old / "run.json"
    yield "baseline-app-T5", "T5", BASE / "app-T5/events.jsonl", BASE / "app-T5-runtime/transcript.jsonl", BASE / "app-T5-runtime/run.json"
    for repeat in range(1, 4):
        for task in range(1, 6):
            label = f"T{task}"
            base = REPEATS / f"repeat-{repeat}" / label
            yield (f"repeat-{repeat}-{label}", label, base / f"app-{label}/events.jsonl",
                   base / f"app-{label}-runtime/transcript.jsonl", base / f"app-{label}-runtime/run.json")


def command_replay(transcript, task):
    from fastapi.testclient import TestClient
    from xraylarch_web.agent_diff import snapshot
    from xraylarch_web.agent_replay import load_records, replay
    from xraylarch_web.agent_suite import check
    from xraylarch_web.config import Settings
    from xraylarch_web.main import create_app
    with TemporaryDirectory(prefix="command-verification-") as directory:
        with TestClient(create_app(Settings(data_root=Path(directory)))) as http:
            result = replay(http, load_records(transcript))
            return {"ok": result.ok, "divergences": result.divergences,
                    "commands": result.replayed(), "skipped": result.skipped(),
                    "steps": [asdict(step) for step in result.steps],
                    "state_assertions": [asdict(item) for item in check(http, task, result.setup)],
                    "final": snapshot(http, result.project_id)}


def verify_case(name, task, evidence, transcript, source, refresh):
    from xraylarch_web.agent_diff import compare
    from xraylarch_web.agent_http_replay import private_replay
    paths = [evidence, transcript, source]
    marker = None
    if evidence.name == "events.jsonl":
        candidates = [evidence.parent / "run.json", evidence.parent / "run.partial.json"]
        marker = next((path for path in candidates if path.exists()), candidates[0])
        paths.append(marker)
    if not all(path.exists() for path in paths) or "final" not in read(source):
        return {"name": name, "status": "pending", "missing": [relative(path) for path in paths if not path.exists()]}
    code = [ROOT / "backend/xraylarch_web" / filename for filename in
            ("agent_http_replay.py", "agent_replay.py", "agent_diff.py", "agent_suite.py")]
    hashes = {relative(path): digest(path) for path in paths + code + [Path(__file__)]}
    out = HERE / name
    summary_path = out / "validation.json"
    if not refresh and summary_path.exists() and read(summary_path).get("sha256") == hashes:
        return read(summary_path)
    original = read(source)
    source_outcome = read(marker) if marker else {"status": "completed"}
    try:
        scientific = private_replay(evidence, transcript, setup_seq=original["seq"])
    except (ValueError, KeyError, TypeError, OSError) as exc:
        scientific = {"ok": False, "fits": 0, "feff_jobs": 0, "commands": 0, "steps": [],
                      "fit_validation": "not_run", "divergences": [f"{type(exc).__name__}: {exc}"]}
    write(out / "http-replay.json", scientific)
    commands = command_replay(transcript, task)
    write(out / "command-replay.json", commands)
    command_diff = [asdict(item) for item in compare(original["final"], commands["final"])]
    http_diff = ([asdict(item) for item in compare(original["final"], scientific["final"])]
                 if scientific.get("final") else None)
    no_science = (scientific.get("divergences") == ["no scientific operations replayed"]
                  and scientific["fits"] == scientific["feff_jobs"] == scientific["commands"] == 0)
    accepted = commands["ok"] and not command_diff and not http_diff and (scientific["ok"] or no_science)
    summary = {"name": name, "task": task,
               "status": "source_failed" if source_outcome.get("status") == "failed" else "pass" if accepted else "fail",
               "implementation_revision": IMPLEMENTATION_REVISION, "sha256": hashes,
               "source_outcome": source_outcome.get("status", "completed"),
               "source_error_type": source_outcome.get("error_type"),
               "source": relative(source), "evidence": relative(evidence), "setup_seq": original["seq"],
               "http_status": "no_scientific_operations" if no_science else "pass" if scientific["ok"] else "fail",
               "fit_validation": scientific["fit_validation"], "fits": scientific["fits"],
               "feff_jobs": scientific["feff_jobs"], "http_commands": scientific["commands"],
               "http_divergences": scientific["divergences"],
               "http_skipped": sum(step["status"] == "skipped" for step in scientific["steps"]),
               "command_replay_ok": commands["ok"], "command_replay_count": commands["commands"],
               "command_divergences": commands["divergences"],
               "state_assertions_passed": all(row["ok"] for row in commands["state_assertions"]),
               "command_snapshot_differences": command_diff, "http_snapshot_differences": http_diff}
    write(summary_path, summary)
    print(f"{name}: {summary['status']}, {summary['fits']} fits, {summary['feff_jobs']} FEFF jobs; "
          f"HTTP {summary['http_status']}", flush=True)
    return summary


def negative_controls(refresh):
    from xraylarch_web.agent_http_replay import private_replay
    original = BASE / "app-T5/events.jsonl"
    transcript = BASE / "app-T5-runtime/transcript.jsonl"
    output = HERE / "negative-controls"
    records = [json.loads(line) for line in original.read_text().splitlines()]
    changed = []
    for row in records:
        if row.get("kind") == "tool_result" and row.get("call_seq") == 25:
            body = row["output"]["body"]
            before_r, before_stderr = body["paths"][0]["r"], body["parameters"][0]["stderr"]
            body["paths"][0]["r"] += 0.001
            body["parameters"][0]["stderr"] *= 2
            changed = [{"field": "paths[0].r", "before": before_r, "after": body["paths"][0]["r"]},
                       {"field": "parameters[0].stderr", "before": before_stderr, "after": body["parameters"][0]["stderr"]}]
    assert len(changed) == 2
    output.mkdir(parents=True, exist_ok=True)
    altered = output / "altered-events.jsonl"
    altered.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records) + "\n")
    report = private_replay(altered, transcript, setup_seq=1)
    write(output / "http-replay.json", report)
    divergent = "\n".join(report["divergences"])
    summary = {"status": "pass" if not report["ok"] and all(item["field"] in divergent for item in changed) else "fail",
               "expected": "reject both changed distance and doubled uncertainty", "alterations": changed,
               "source": relative(original), "source_sha256": digest(original), "altered_sha256": digest(altered),
               "fit_validation": report["fit_validation"], "divergences": report["divergences"]}
    write(output / "validation.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="rerun unchanged completed cases")
    args = parser.parse_args()
    # main builds a module-level app on first import; keep that store private too.
    with TemporaryDirectory(prefix="replay-verification-bootstrap-") as bootstrap:
        prior = os.environ.get("XRAYLARCH_DATA_ROOT")
        os.environ["XRAYLARCH_DATA_ROOT"] = bootstrap
        try:
            results = [verify_case(*case, refresh=args.refresh) for case in cases()]
            negative = negative_controls(args.refresh)
        finally:
            if prior is None:
                os.environ.pop("XRAYLARCH_DATA_ROOT", None)
            else:
                os.environ["XRAYLARCH_DATA_ROOT"] = prior
    repeated = [row for row in results if row["name"].startswith("repeat-")]
    aggregate = {"complete": all(row["status"] != "pending" for row in repeated),
                 "expected_repeated_runs": 15, "completed_repeated_runs": sum(row["status"] != "pending" for row in repeated),
                 "passed_repeated_runs": sum(row["status"] == "pass" for row in repeated),
                 "source_failed_repeated_runs": sum(row["status"] == "source_failed" for row in repeated),
                 "implementation_revision": IMPLEMENTATION_REVISION,
                 "fits_checked": sum(row.get("fits", 0) for row in results),
                 "feff_jobs_rerun": sum(row.get("feff_jobs", 0) for row in results),
                 "results": results, "negative_controls": negative}
    write(HERE / "results.json", aggregate)
    print(json.dumps({key: value for key, value in aggregate.items() if key not in ("results", "negative_controls")}), flush=True)
    return int(any(row["status"] in ("fail", "source_failed") for row in results) or negative["status"] != "pass")


if __name__ == "__main__":
    raise SystemExit(main())
