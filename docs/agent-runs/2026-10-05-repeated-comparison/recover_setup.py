"""Repair archive-only version metadata, preflight app, then run only unstarted arms."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
import httpx
import run_pair


def preflight(root, python):
    runtime = root / "preflight"
    runtime.mkdir(exist_ok=False)
    port = run_pair.available_port()
    env = os.environ.copy()
    env.update(PYTHONPATH=f"{root}/app/backend:{root}/app", XRAYLARCH_DATA_ROOT=str(runtime / "data"),
               XRAYLARCH_AGENT_METER=str(runtime / "meter.jsonl"))
    with (runtime / "server.log").open("w") as log:
        process = subprocess.Popen([str(python), "-m", "uvicorn", "--factory", "xraylarch_web.agent_suite:metered_app",
                                    "--host", "127.0.0.1", "--port", str(port)], cwd=root / "app", env=env,
                                   stdout=log, stderr=log)
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=180, trust_env=False) as client:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError("preflight backend stopped")
                try:
                    if client.get("/openapi.json").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(.5)
            else:
                raise TimeoutError("preflight startup")
            response = client.post("/api/athena/projects", json={"name": "repeated-preflight"})
            response.raise_for_status()
            project = response.json()
            response = client.post(f"/api/athena/projects/{project['id']}/command?view=summary", json={
                "version": project["version"], "action": "example", "group_ids": [], "options": {}})
            response.raise_for_status()
            summary = response.json()
            full = client.get(f"/api/athena/projects/{project['id']}").json()
            fixture = json.loads((root / "fixture/fixture.json").read_text())
            matched = run_pair.measurements_match(full["groups"], fixture["spectra"])
            success = matched and not any(g.get("processing_error") for g in summary["groups"])
            run_pair.save(root / "preflight.json", {"success": success, "measurements_match_atol": 1e-14,
                "measurements_match": matched, "groups": len(summary["groups"]), "model_calls": 0,
                "app_version_metadata_sha256": hashlib.sha256((root / "app/larch/_version.py").read_bytes()).hexdigest()})
            if not success:
                raise RuntimeError("preflight fixture failed")
    finally:
        run_pair.stop(process)


def attempt_started(directory):
    """Retain both completed and failed model attempts; never decide from an answer."""
    return directory.exists() and any(directory.iterdir())


def record_arm(manifest, task, arm, result):
    manifest.setdefault("pairs", {}).setdefault(task, {})[arm] = result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if not (root / "preflight.json").is_file():
        preflight(root, args.python)
    schedule = json.loads((root / "schedule.json").read_text())
    resumed = {"reason": "git archive lacks generated larch/_version.py; no app model began before repair",
               "ordering_deviation": "completed native attempts retained; remaining unstarted arms follow original schedule order",
               "source_version": "2026.3.1.post321+g7f82058f3", "completed_before_recovery": [], "pending": [], "results": []}
    for unit in schedule["schedule"]:
        for arm in unit["arms"]:
            directory = root / "runs" / f"repeat-{unit['repeat']}" / unit["task"] / f"{arm}-{unit['task']}"
            record = {"repeat": unit["repeat"], "task": unit["task"], "arm": arm}
            # Any attempt evidence means started; failed attempts are never rerun.
            if attempt_started(directory):
                resumed["completed_before_recovery"].append(record)
            else:
                resumed["pending"].append(record)
    if (root / "recovery.json").exists():
        previous = json.loads((root / "recovery.json").read_text())
        resumed["previous_recovery"] = previous
        resumed["coordinator_error"] = "KeyError T2 after successful app model and snapshot; recovered without repeating model"
    run_pair.save(root / "recovery.json", resumed)
    for record in resumed["pending"]:
        task, arm = record["task"], record["arm"]
        out = root / "runs" / f"repeat-{record['repeat']}" / task
        out.mkdir(parents=True, exist_ok=True)
        manifest = json.loads((out / "manifest.json").read_text()) if (out / "manifest.json").exists() else {
            "model": "gpt56luna", "tasks": [task], "native_revision": schedule["native_revision"],
            "app_revision": schedule["app_revision"], "fixture_sha256": hashlib.sha256((root / "fixture/fixture.json").read_bytes()).hexdigest(),
            "pairs": {task: {}}}
        if arm == "app" and (out / f"app-{task}-runtime").exists():
            (out / f"app-{task}-runtime").rename(out / f"app-{task}-setup-failure")
            manifest.setdefault("setup_failures", []).append({"arm": "app", "task": task,
                "error_type": "ModuleNotFoundError", "missing_module": "larch._version", "model_started": False})
        config = SimpleNamespace(python=args.python, app_python=args.python, native_root=root / "native", app_root=root / "app",
            fixture=root / "fixture/fixture.json", out=out, model="gpt56luna", timeout=600)
        print(f"RESUME {record['repeat']} {task} {arm}", flush=True)
        result = run_pair.run_app(config, task) if arm == "app" else run_pair.model_run(config, arm, task, out / f"{arm}-{task}")
        record_arm(manifest, task, arm, result)
        run_pair.save(out / "manifest.json", manifest)
        resumed["results"].append({**record, **result})
        run_pair.save(root / "recovery.json", resumed)
    return 0

if __name__ == "__main__":
    sys.exit(main())
