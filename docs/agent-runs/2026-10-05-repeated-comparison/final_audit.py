"""Audit fixed attempt count, prompts, source hashes, model identity, and evidence scope."""
import hashlib
import json
from pathlib import Path
import re

BASE = Path(__file__).resolve().parent
fixture = json.loads((BASE.parent / "2026-10-05-native-vs-app/fixture/fixture.json").read_text())
result = json.loads((BASE / "results.json").read_text())
checks, configs, order = {}, [], []
for row in result["runs"]:
    unit = BASE / "runs" / f"repeat-{row['repeat']}" / row["task"]
    arm = unit / f"{row['arm']}-{row['task']}"
    config = json.loads((arm / "configuration.json").read_text())
    configs.append(config)
    key = f"repeat-{row['repeat']}/{row['task']}/{row['arm']}"
    checks[key + "/frozen_prompt"] = config["prompt"] == fixture["tasks"][row["task"]]["prompt"]
    checks[key + "/model_alias"] = config["model"] == "gpt56luna"
    checks[key + "/requested_settings"] = config["settings"] == {"parallel_tool_calls": False}
    manifest = json.loads((unit / "manifest.json").read_text())
    timing = (json.loads((unit / f"app-{row['task']}-runtime/run.json").read_text()) if row["arm"] == "app"
              else manifest.get("pairs", {}).get(row["task"], {}).get("native", {}))
    if "started" in timing:
        order.append({"attempt": key, "started": timing["started"], "finished": timing["finished"],
                      "timing_provenance": row["process_timing_provenance"]})
checks["fixed_30_attempts"] = len(configs) == 30
checks["all_attempts_resolved"] = all(row["status"] in {"completed", "failed"} for row in result["runs"])
checks["one_served_model"] = {row["provider_metadata"]["provider_model_id"] for row in result["runs"]} == {"gpt-5.6-luna-2026-07-09"}
checks["all_answers_graded"] = all(row["answer_grade"]["status"] in {"pass", "fail"} for row in result["runs"])
checks["all_process_timestamps_retained"] = len(order) == 30
checks["one_fixture_digest"] = len({config["fixture_sha256"] for config in configs}) == 1
for arm in ("native", "app"):
    fingerprints = {hashlib.sha256(json.dumps(c["tools"], sort_keys=True).encode()).hexdigest() for c in configs if c["arm"] == arm}
    checks[arm + "_schemas_unchanged"] = len(fingerprints) == 1
forbidden = []
secret_hits = []
pattern = re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?i:authorization).{0,20}(?i:bearer)\s+[A-Za-z0-9._-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}')
for path in (BASE / "runs").rglob("*"):
    if not path.is_file():
        continue
    relative = path.relative_to(BASE)
    if path.suffix in {".db", ".sqlite", ".sqlite3", ".log"} or set(relative.parts) & {"private", "payloads", "session", "data"}:
        forbidden.append(str(relative))
    if pattern.search(path.read_bytes()):
        secret_hits.append(str(relative))
checks["no_private_runtime_files_exported"] = not forbidden
checks["secret_pattern_scan_clear"] = not secret_hits
payload = {"checks": checks, "all_passed": all(checks.values()), "forbidden_files": forbidden, "secret_pattern_files": secret_hits,
           "attempt_status_counts": {status: sum(row["status"] == status for row in result["runs"]) for status in ("completed", "failed")},
           "observed_process_start_order": sorted(order, key=lambda row: row["started"]),
           "concurrency_note": "parallel_tool_calls=false is requested configuration; events can overlap and joins use call_seq"}
(BASE / "evidence-audit.json").write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps({"all_passed": payload["all_passed"], "checks": len(checks), "statuses": payload["attempt_status_counts"]}))
raise SystemExit(0 if payload["all_passed"] else 1)
