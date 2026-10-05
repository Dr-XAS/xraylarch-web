"""Check saved native T2/T3 artifacts independently of tool success and lineage."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

FOILS = ("Cu foil · 10 K", "Cu foil · 50 K", "Cu foil · 300 K")
EXPECTED_SHIFTS = {FOILS[1]: -0.018, FOILS[2]: -2.959}
MODEL = "gpt-5.6-luna-2026-07-09"


def read(directory, name):
    return json.loads((directory / name).read_text())


def close(a, b, tolerance=1e-8):
    return (type(a) in (int, float) and type(b) in (int, float)
            and math.isfinite(a) and math.isfinite(b) and abs(a - b) <= tolerance)


def verify_task(directory, baseline):
    run = read(directory, "run.json")
    config = read(directory, "configuration.json")
    old_config = read(baseline, "configuration.json")
    initial = read(directory, "initial-science.json")
    final = read(directory, "final-science.json")
    artifacts = final["artifacts"]
    refs = final["originals"]
    checks = {
        "completed": run.get("status") == "completed",
        "explicit_model": run.get("model") == config.get("model") == "gpt56luna",
        "served_model": run.get("provider_models") == [MODEL]
            and read(directory, "provider.json").get("provider_model_id") == MODEL,
        "frozen_task_prompt": config.get("prompt") == old_config.get("prompt"),
        "frozen_fixture": config.get("fixture_sha256") == old_config.get("fixture_sha256"),
        "originals_unchanged": bool(initial) and all(
            artifacts.get(refs.get(label), {}).get("payload_sha256") == row["payload_sha256"]
            for label, row in initial.items()),
        "workflow_state": read(directory, "native-state.json").get("state_passed") is True,
    }
    values = {}
    if run["task"] == "T2":
        for label, expected in EXPECTED_SHIFTS.items():
            aligned = [(ref, row) for ref, row in artifacts.items()
                       if (row.get("alignment") or {}).get("source_ref") == refs[label]]
            checks[f"{label}.one_alignment"] = len(aligned) == 1
            if len(aligned) != 1:
                continue
            ref, row = aligned[0]
            alignment = row["alignment"]
            shift = alignment.get("energy_shift_ev")
            residual = row["e0"] - initial[FOILS[0]]["e0"]
            checks[f"{label}.reference"] = alignment.get("reference_ref") == refs[FOILS[0]]
            checks[f"{label}.shift"] = close(shift, expected, 0.1)
            checks[f"{label}.edge_residual"] = close(residual, 0, 0.15)
            for endpoint in ("energy_min", "energy_max"):
                checks[f"{label}.{endpoint}_shift"] = close(
                    row[endpoint] - initial[label][endpoint], shift)
            checks[f"{label}.point_count"] = row["n_points"] == initial[label]["n_points"]
            values[label] = {"artifact": ref, "shift_ev": shift,
                             "app_shift_ev": expected, "edge_residual_ev": residual}
        values["original_edge_step_spread"] = max(initial[x]["edge_step"] for x in FOILS) - min(
            initial[x]["edge_step"] for x in FOILS)
    elif run["task"] == "T3":
        transformed = [(ref, row) for ref, row in artifacts.items()
                       if (row.get("ft") or {}).get("source_ref") == refs[FOILS[0]]]
        checks["one_transform"] = len(transformed) == 1
        if len(transformed) == 1:
            ref, row = transformed[0]
            before, after = initial[FOILS[0]]["ft"], row["ft"]
            for key, value in before.items():
                if key != "kmax":
                    checks[f"preserved.{key}"] = after.get(key) == value
            upper = after.get("kmax")
            checks["upper_limit_reduced"] = (type(upper) in (int, float)
                and before["kmin"] < upper < before["kmax"]
                and upper <= row["available_kmax"])
            checks["first_shell_peak"] = close(after.get("r_peak"), 2.27, 0.1)
            for key in ("energy_min", "energy_max", "e0", "edge_step", "n_points", "processing"):
                checks[f"unchanged.{key}"] = row[key] == initial[FOILS[0]][key]
            values = {"artifact": ref, "initial_ft": before, "final_ft": after}
    else:
        raise ValueError("Only the frozen T2 and T3 tasks are supported")
    return {"task": run["task"], "passed": all(checks.values()), "checks": checks,
            "values": values, "scope": "Saved artifact summaries; full-array checks are separate"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, default=Path(__file__).resolve().parent.parent
                        / "2026-10-05-native-vs-app/runs/t2-t5")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    tasks = {task: verify_task(args.runs / f"native-{task}", args.baseline / f"native-{task}")
             for task in ("T2", "T3")}
    result = {"passed": all(row["passed"] for row in tasks.values()), "tasks": tasks,
              "tolerances": {"shift_ev": 0.1, "edge_residual_ev": 0.15, "r_peak_A": 0.1}}
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({task: row["passed"] for task, row in tasks.items()}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
