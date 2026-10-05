"""Capture two isolated evaluation arms, then check and replay each project.

Run with the backend virtualenv and PYTHONPATH=backend:
    python docs/agent-runs/2026-10-05/capture.py T1 --runtime /tmp/agent-baseline

Each arm writes started.json before operating and answer.md when finished.
The coordinator launches a fresh agent after this script prints READY.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import httpx


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


class Evidence:
    """Keep request bodies and replies for scientific answer review, without headers."""

    def __init__(self, app, path):
        self.app, self.path = app, path

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request, response = bytearray(), bytearray()
        record = {"time": time.time(), "method": scope["method"], "path": scope["path"],
                  "query": scope.get("query_string", b"").decode()}

        async def read():
            message = await receive()
            request.extend(message.get("body", b""))
            return message

        async def capture(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body":
                response.extend(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, read, capture)
        finally:
            for key, value in (("request", request), ("response", response)):
                try:
                    record[key] = json.loads(value) if value else None
                except ValueError:
                    record[key] = value.decode(errors="replace")
            with self.path.open("a") as log:
                log.write(json.dumps(record, ensure_ascii=False) + "\n")


def make_app():
    from xraylarch_web.agent_suite import metered_app
    return Evidence(metered_app(), Path(os.environ["BASELINE_EVIDENCE"]))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def finish(arm, client):
    from dataclasses import asdict
    from xraylarch_web import agent_suite
    folder = arm["folder"]
    run_path = folder / "run.json"
    run = json.loads(run_path.read_text())
    run["started"] = json.loads((folder / "started.json").read_text())["started"]
    write_json(run_path, run)
    agent_suite.main(["finish", str(run_path)], http=client)
    run = json.loads(run_path.read_text())
    assert "final" in run
    source = arm["data"] / "athena" / run["project_id"] / "transcript.jsonl"
    shutil.copyfile(source, folder / "transcript.jsonl")
    # Freeze only the arm's requests; verification uses a separate live log.
    for name in ("meter", "evidence"):
        lines = [line for line in (arm["runtime"] / f"{name}.jsonl").read_text().splitlines()
                 if run["started"] <= json.loads(line)["time"] <= run["finished"]]
        (folder / f"{name}.jsonl").write_text("\n".join(lines) + "\n")
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        status = agent_suite.main(["report", arm["task"], str(run_path),
                                   "--meter", str(folder / "meter.jsonl")], http=client)
    (folder / "report.txt").write_text(output.getvalue())
    assertions = agent_suite.check(client, arm["task"], run)
    results = {"state_pass": status == 0, "assertions": [asdict(x) for x in assertions],
               "meter": agent_suite.meter_totals(folder / "meter.jsonl"),
               "wall_seconds": run["finished"] - run["started"]}
    output = io.StringIO()
    replay_path = folder / "replay.json"
    with contextlib.redirect_stdout(output):
        results["replay_exit"] = agent_suite.main(
            ["replay", str(folder / "transcript.jsonl"), "--out", str(replay_path)], http=client)
        results["replay_check_exit"] = agent_suite.main(
            ["check", arm["task"], str(replay_path)], http=client)
        results["diff_exit"] = agent_suite.main(["diff", str(run_path), str(replay_path)], http=client)
    (folder / "replay.txt").write_text(output.getvalue())
    write_json(folder / "results.json", results)
    print("DONE", folder.name, json.dumps(results), flush=True)


def main():
    from xraylarch_web.agent_suite import TASKS, setup
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=TASKS)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    root = Path(__file__).resolve().parent
    processes, pending = [], []
    try:
        for interface in ("cli", "http"):
            name = f"{interface}-{args.task.lower()}"
            folder, runtime = root / name, args.runtime / name
            folder.mkdir()
            runtime.mkdir(parents=True)
            data = runtime / "data"
            port = free_port()
            url = f"http://127.0.0.1:{port}"
            env = os.environ.copy()
            env.update(PYTHONPATH=os.pathsep.join((str(repo / "backend"), str(root))),
                       XRAYLARCH_DATA_ROOT=str(data),
                       XRAYLARCH_AGENT_METER=str(runtime / "meter.jsonl"),
                       BASELINE_EVIDENCE=str(runtime / "evidence.jsonl"))
            log = (runtime / "server.log").open("w")
            proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "capture:make_app", "--factory",
                                     "--host", "127.0.0.1", "--port", str(port)], env=env, stdout=log, stderr=log)
            processes.append(proc)
            client = httpx.Client(base_url=url, timeout=120)
            for attempt in range(120):
                if proc.poll() is not None:
                    raise RuntimeError(f"Backend exited; see {runtime / 'server.log'}")
                try:
                    if client.get("/openapi.json").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError("Backend did not start")
            run = setup(client, name=f"baseline-2026-10-05-{name}")
            write_json(folder / "run.json", run)
            write_json(folder / "connection.json", {"url": url, "project_id": run["project_id"],
                                                     "interface": interface})
            (folder / "prompt.txt").write_text(TASKS[args.task].prompt + "\n")
            guide = (repo / "AGENTS.md").read_text().split("# Driving this app without a browser", 1)[1]
            (folder / "AGENTS.md").write_text("# Driving this app without a browser" + guide)
            pending.append(dict(folder=folder, runtime=runtime, data=data, task=args.task, client=client))
            print("READY", name, url, run["project_id"], flush=True)
        deadline = time.monotonic() + 1800
        while pending:
            if time.monotonic() > deadline:
                raise TimeoutError("Arms did not finish within 30 minutes")
            for arm in list(pending):
                if (arm["folder"] / "answer.md").exists():
                    finish(arm, arm["client"])
                    pending.remove(arm)
            time.sleep(0.25)
    finally:
        for proc in processes:
            proc.terminate()
        for proc in processes:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    main()
