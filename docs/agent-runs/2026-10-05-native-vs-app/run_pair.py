"""Run matched native-tool and app-driving agents in separate processes.

Credentials are inherited from the launch environment and never recorded.
Each arm has private data; existing output directories are never reused.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import time

import httpx


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def measurements_match(groups, spectra):
    """Allow only floating-point roundoff from the bundled Cu2O log conversion."""
    actual = {g["label"]: g for g in groups}
    expected = {g["label"]: g for g in spectra}
    if actual.keys() != expected.keys():
        return False
    return all(len(actual[label][key]) == len(row[key]) and all(
        math.isclose(a, b, rel_tol=0, abs_tol=1e-14)
        for a, b in zip(actual[label][key], row[key]))
        for label, row in expected.items() for key in ("energy", "mu"))


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def model_run(args, arm, task, output, extra=()):
    command = [str(args.python), "-m", "eval.native_app_comparison", "--fixture",
               str(args.fixture), "--arm", arm, "--task", task, "--model", args.model,
               "--out", str(output), *extra]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(args.native_root / "backend")
    started = time.time()
    with (args.out / f"{arm}-{task}.log").open("w") as log:
        process = subprocess.Popen(command, cwd=args.native_root / "backend", env=env,
                                   stdout=log, stderr=log)
        try:
            code = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            stop(process)
            code = 124
    return {"returncode": code, "started": started, "finished": time.time()}


def run_app(args, task):
    runtime = args.out / f"app-{task}-runtime"
    runtime.mkdir()
    port = available_port()
    url = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.update(PYTHONPATH=os.pathsep.join((str(args.app_root / "backend"), str(args.app_root))),
               XRAYLARCH_DATA_ROOT=str(runtime / "data"),
               XRAYLARCH_AGENT_METER=str(runtime / "meter.jsonl"))
    command = [str(args.app_python), "-m", "uvicorn", "--factory",
               "xraylarch_web.agent_suite:metered_app", "--host", "127.0.0.1", "--port", str(port)]
    with (runtime / "server.log").open("w") as log:
        server = subprocess.Popen(command, cwd=args.app_root, env=env, stdout=log, stderr=log)
    try:
        with httpx.Client(base_url=url, timeout=180, trust_env=False) as client:
            for attempt in range(120):
                if server.poll() is not None:
                    raise RuntimeError(f"App backend exited; see {runtime / 'server.log'}")
                try:
                    response = client.get("/openapi.json")
                    if response.status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.5)
            else:
                raise TimeoutError("App backend startup timeout")
            created = client.post("/api/athena/projects", json={"name": f"comparison-{task}"})
            created.raise_for_status()
            project = created.json()
            loaded = client.post(f"/api/athena/projects/{project['id']}/command?view=summary",
                                 json={"version": project["version"], "action": "example",
                                       "group_ids": [], "options": {}})
            loaded.raise_for_status()
            summary = loaded.json()
            if any(g.get("processing_error") for g in summary["groups"]):
                raise RuntimeError("App example processing failed")
            transcript = client.get(f"/api/athena/projects/{project['id']}/transcript").json()
            run = {"project_id": project["id"], "version": summary["version"],
                   "seq": max(r["seq"] for r in transcript["records"]),
                   "groups": {g["label"]: g["id"] for g in summary["groups"]}}
            # Compare measured inputs, without exposing arrays to either model.
            full = client.get(f"/api/athena/projects/{project['id']}").json()
            actual = {g["label"]: hashlib.sha256(json.dumps(
                {key: g[key] for key in ("energy", "mu")}, separators=(",", ":"),
                allow_nan=False).encode()).hexdigest() for g in full["groups"]}
            fixture = json.loads(args.fixture.read_text())
            expected = {g["label"]: g["measurement_sha256"] for g in fixture["spectra"]}
            if not measurements_match(full["groups"], fixture["spectra"]):
                raise RuntimeError("App measurements differ from native fixture")
            save(runtime / "initial-summary.json", summary)
            save(runtime / "measurement-hashes.json", actual)
            output = args.out / f"app-{task}"
            timing = model_run(args, "app", task, output,
                               ("--url", url, "--project", project["id"],
                                "--guide", str(args.fixture.parent / "app-guide.md")))
            run.update(started=timing["started"], finished=timing["finished"])
            run_path = runtime / "run.json"
            save(run_path, run)
            suite = [str(args.app_python), "-m", "xraylarch_web.agent_suite", "--url", url]
            # finish stamps before its own requests; restore model-only cutoff afterward.
            subprocess.run([*suite, "finish", str(run_path)], cwd=args.app_root, env=env, check=True)
            run = json.loads(run_path.read_text())
            if not run.get("final"):
                raise RuntimeError("App final snapshot is missing")
            run["finished"] = timing["finished"]
            save(run_path, run)
            records = client.get(f"/api/athena/projects/{project['id']}/transcript?limit=500").json()["records"]
            (runtime / "transcript.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
            with (runtime / "report.txt").open("w") as report:
                check = subprocess.run([*suite, "report", task, str(run_path), "--meter",
                                        str(runtime / "meter.jsonl")], cwd=args.app_root,
                                       env=env, stdout=report, stderr=report)
            meter = [json.loads(line) for line in (runtime / "meter.jsonl").read_text().splitlines()]
            arm_meter = [r for r in meter if r["path"].startswith("/api/") and
                         run["started"] <= r["time"] <= run["finished"]]
            (runtime / "arm-meter.jsonl").write_text("".join(json.dumps(r) + "\n" for r in arm_meter))
            return {**timing, "state_returncode": check.returncode,
                    "requests": len(arm_meter), "response_bytes": sum(r["bytes"] for r in arm_meter),
                    "request_errors": sum(r["status"] >= 400 for r in arm_meter),
                    "measurement_hashes_match": actual == expected,
                    "measurements_match_atol": 1e-14}
    finally:
        stop(server)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--app-python", type=Path, required=True)
    parser.add_argument("--native-root", type=Path, required=True)
    parser.add_argument("--app-root", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--tasks", nargs="+", choices=[f"T{i}" for i in range(1, 6)], default=["T1"])
    parser.add_argument("--native-revision", required=True)
    parser.add_argument("--app-revision", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--arms", nargs="+", choices=("native", "app"), default=["native", "app"])
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    manifest = {"model": args.model, "tasks": args.tasks, "native_revision": args.native_revision,
                "app_revision": args.app_revision, "fixture_sha256": hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
                "pairs": {}}
    save(args.out / "manifest.json", manifest)
    for task in args.tasks:
        manifest["pairs"][task] = {}
        for arm in args.arms:
            print(f"START {arm} {task}", flush=True)
            result = (model_run(args, arm, task, args.out / f"{arm}-{task}")
                      if arm == "native" else run_app(args, task))
            manifest["pairs"][task][arm] = result
            save(args.out / "manifest.json", manifest)
        print(f"DONE {task}: " + json.dumps(manifest["pairs"][task]), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
