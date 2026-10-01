"""The task suite in docs/agent-task-suite.md, as something a harness can run.

Three pieces, each usable without the others:

- ``TASKS`` holds each task's prompt and answer key, worded as in the doc.
- ``check()`` runs a task's state assertions against a live project, through
  the same views an arm reads, so a pass means what the arm could have seen.
- ``metered_app()`` is the app behind a meter that logs every request's
  method, path and response size, which is how turns and wire bytes get
  counted without trusting the arm to count them.

The suite was graded by hand twice, and both times the hand check read the
wrong thing: the selection sent to merge rather than what the merge used. The
assertions here read ``derived.parents`` and nothing else.

    python -m xraylarch_web.agent_suite setup --out run.json
    python -m xraylarch_web.agent_suite check T2 run.json
    python -m xraylarch_web.agent_suite finish run.json
    python -m xraylarch_web.agent_suite report T2 run.json --meter meter.jsonl

``setup`` makes a fresh project with the example loaded and records its id,
version and group ids. ``check`` and ``report`` read that file, so the checks
know which groups were there before the arm started and which it made.
``finish`` stamps the moment the arm stopped, so the meter counts the arm's
requests and not the ones made afterwards to look at what it did.

To meter a backend, serve it through the factory with a log path set:

    XRAYLARCH_AGENT_METER=meter.jsonl XRAYLARCH_DATA_ROOT=/tmp/run \\
        uvicorn --factory xraylarch_web.agent_suite:metered_app --port 8106
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

FOILS = ("Cu foil · 10 K", "Cu foil · 50 K", "Cu foil · 300 K")
EXAMPLE_GROUPS = 5


@dataclass
class Assertion:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Task:
    key: str
    prompt: str
    answer: str
    check: Callable[["Observed"], list[Assertion]]


@dataclass
class Observed:
    """What the checks may look at: the project now, and the project at setup."""
    setup: dict
    summary: dict
    parameters: dict
    transcript: list[dict]
    groups: dict[str, dict] = field(init=False)

    def __post_init__(self):
        self.groups = {group["id"]: group for group in self.summary["groups"]}

    def foil(self, label: str) -> dict | None:
        return self.groups.get(self.setup["groups"][label])

    def made(self) -> list[dict]:
        """Groups the arm created, in project order."""
        before = set(self.setup["groups"].values())
        return [group for group in self.summary["groups"] if group["id"] not in before]

    def merges_of(self, parents: set[str]) -> list[dict]:
        return [group for group in self.made()
                if (group.get("derived") or {}).get("operation") == "merge"
                and set(group["derived"]["parents"]) == parents]

    def rejected(self) -> list[dict]:
        return [record for record in self.transcript
                if not record["ok"] and record["seq"] > self.setup["seq"]]


def _count(observed: Observed, expected: int) -> Assertion:
    count = observed.summary["counts"]["groups"]
    return Assertion(f"{expected} groups", count == expected, f"found {count}")


def _merged_foils(observed: Observed) -> Assertion:
    """Exactly one new merge whose parents are the three foil scans, read off derived."""
    foils = {observed.setup["groups"][label] for label in FOILS}
    found = observed.merges_of(foils)
    detail = ", ".join(
        f"{group['label']} <- {[observed.groups.get(p, {}).get('label', p) for p in group['derived']['parents']]}"
        + (f" excluded {[item['label'] for item in group['derived']['excluded']]}"
           if group["derived"].get("excluded") else "")
        for group in observed.made() if group.get("derived")) or "no derived groups"
    return Assertion("one merge of all three foils, by derived.parents", len(found) == 1, detail)


def _check_t1(observed: Observed) -> list[Assertion]:
    version = observed.summary["version"]
    return [
        Assertion("version unchanged", version == observed.setup["version"],
                  f"{observed.setup['version']} -> {version}"),
        _count(observed, EXAMPLE_GROUPS),
        Assertion("no rejected commands", not observed.rejected(),
                  "; ".join(f"{r['action']}: {r.get('error', {}).get('message', '')[:80]}"
                            for r in observed.rejected())),
    ]


def _check_t2(observed: Observed) -> list[Assertion]:
    shifts = {label: (observed.foil(label) or {}).get("energy_shift") for label in FOILS}
    return [
        _count(observed, EXAMPLE_GROUPS + 1),
        _merged_foils(observed),
        Assertion("50 K and 300 K shifted, 10 K not",
                  shifts[FOILS[0]] == 0 and bool(shifts[FOILS[1]]) and bool(shifts[FOILS[2]]),
                  ", ".join(f"{label[8:]} {value}" for label, value in shifts.items())),
    ]


def _check_t3(observed: Observed) -> list[Assertion]:
    target = observed.setup["groups"][FOILS[0]]
    effective = next((group["effective"] for group in observed.parameters["groups"]
                      if group["id"] == target), {})
    kmax, available = effective.get("kmax"), effective.get("available_kmax")
    return [
        Assertion("10 K effective kmax below 24", kmax is not None and kmax < 24, f"kmax {kmax}"),
        Assertion("and within available_kmax",
                  kmax is not None and available is not None and kmax <= available,
                  f"available {available}"),
    ]


def _check_t4(observed: Observed) -> list[Assertion]:
    # Truncating first is allowed and changes nothing; only the merge is checked.
    # Until 2026-10-01 this also required the foils' ranges to end within 15 eV,
    # which rewarded a cut the merge already makes for itself.
    return [_count(observed, EXAMPLE_GROUPS + 1), _merged_foils(observed)]


def _check_t5(observed: Observed) -> list[Assertion]:
    # A fit reads the group and saves nothing, so the right path leaves the
    # project as it found it. Whatever was refused on the way is worth a look.
    version = observed.summary["version"]
    return [
        Assertion("version unchanged", version == observed.setup["version"],
                  f"{observed.setup['version']} -> {version}"),
        _count(observed, EXAMPLE_GROUPS),
    ]


TASKS = {task.key: task for task in (
    Task("T1",
         "I have three copper foil scans taken at different temperatures. Before I do "
         "anything with them, tell me whether they're comparable, and if one of them "
         "isn't, why.",
         "Names Cu foil · 300 K, and gives at least two of: E0 about 3 eV above the others "
         "(8980.5 against 8977.6); edge step about 19% larger (2.73 against 2.29); energy "
         "axis stops at 10146 eV where the others run past 11360.",
         _check_t1),
    Task("T2",
         "Align all three scans to the 10 K one, merge them, and tell me how much the edge "
         "step varies across the three originals.",
         "A spread within 0.005 of 0.439 (max minus min edge step over the three "
         "originals), or the post-alignment spread if the arm says that is what it gave.",
         _check_t2),
    Task("T3",
         "The EXAFS Fourier transform on the 10 K scan is running out to k = 24, and the "
         "data up there is noise. Bring the k range in to where the data is real, then "
         "tell me where the first shell sits.",
         "Gives the first |chi(R)| peak near 2.30 Å and says it is not the bond length, "
         "or not phase-corrected, or sits below the true Cu-Cu distance.",
         _check_t3),
    Task("T4",
         "The 300 K scan is shorter than the other two, and I want all three in one merge. "
         "Do I need to cut the long ones down to match first? Do whatever it takes, merge "
         "them, and tell me where the merged spectrum ends.",
         "Says the cut is unnecessary, because the merge covers only the energy range all "
         "three share (or, having cut, that it changed nothing), and gives the merge's end "
         "within 15 eV of 10140.",
         _check_t4),
    Task("T5",
         "How far apart are the copper atoms in the 10 K foil? I need the nearest-neighbour "
         "distance to a couple of hundredths of an angstrom, and how far to trust it.",
         "Between 2.52 and 2.58 A, from a fit of FEFF paths (twelve Cu neighbours) rather "
         "than the |chi(R)| peak near 2.30, with an uncertainty or a reason to doubt it.",
         _check_t5),
)}


def setup(http: httpx.Client, name: str = "suite") -> dict:
    """A fresh project with the example loaded, and what it held before the arm."""
    created = http.post("/api/athena/projects", json={"name": name})
    created.raise_for_status()
    project = created.json()
    loaded = http.post(f"/api/athena/projects/{project['id']}/command",
                       params={"view": "summary"},
                       json={"version": project["version"], "action": "example",
                             "group_ids": [], "options": {}})
    loaded.raise_for_status()
    summary = loaded.json()
    log = http.get(f"/api/athena/projects/{project['id']}/transcript").json()
    return {"project_id": summary["id"], "version": summary["version"],
            "seq": max((record["seq"] for record in log["records"]), default=0),
            "groups": {group["label"]: group["id"] for group in summary["groups"]}}


def observe(http: httpx.Client, run: dict) -> Observed:
    base = f"/api/athena/projects/{run['project_id']}"
    summary = http.get(base, params={"view": "summary"}).json()
    parameters = http.get(base, params={"view": "parameters"}).json()
    transcript = http.get(f"{base}/transcript", params={"limit": 500}).json()["records"]
    return Observed(setup=run, summary=summary, parameters=parameters, transcript=transcript)


def check(http: httpx.Client, task: str, run: dict) -> list[Assertion]:
    return TASKS[task].check(observe(http, run))


def meter_totals(path: Path, since: float = 0.0, until: float | None = None) -> dict:
    """Requests and response bytes from a meter log, the API only, health checks out."""
    totals = {"requests": 0, "gets": 0, "posts": 0, "bytes": 0, "status": {}}
    if not path.exists():
        return totals
    for line in path.read_text().splitlines():
        entry = json.loads(line)
        if not entry["path"].startswith("/api/") or entry["time"] < since:
            continue
        if until is not None and entry["time"] > until:
            continue
        totals["requests"] += 1
        totals["gets" if entry["method"] == "GET" else "posts"] += 1
        totals["bytes"] += entry["bytes"]
        totals["status"][str(entry["status"])] = totals["status"].get(str(entry["status"]), 0) + 1
    return totals


class Meter:
    """ASGI middleware that appends one JSON line per request to a log file."""

    def __init__(self, app, path: Path):
        self.app, self.path = app, path

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        record: dict[str, Any] = {"time": time.time(), "method": scope["method"],
                                  "path": scope["path"],
                                  "query": scope.get("query_string", b"").decode(),
                                  "status": None, "bytes": 0}

        async def metered(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body":
                record["bytes"] += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, metered)
        finally:
            with self.path.open("a") as log:
                log.write(json.dumps(record) + "\n")


def metered_app():
    from .main import create_app
    return Meter(create_app(), Path(os.environ["XRAYLARCH_AGENT_METER"]))


def _print_check(task: str, assertions: list[Assertion]) -> bool:
    passed = all(item.ok for item in assertions)
    print(f"{task} {'PASS' if passed else 'FAIL'}")
    for item in assertions:
        print(f"  {'ok  ' if item.ok else 'FAIL'} {item.name}" + (f"  ({item.detail})" if item.detail else ""))
    return passed


def main(argv: list[str] | None = None, http: httpx.Client | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent_suite", description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", default=os.environ.get("LARCHCTL_URL", "http://127.0.0.1:8006"))
    sub = parser.add_subparsers(dest="command", required=True)
    made = sub.add_parser("setup", help="a fresh project with the example loaded")
    made.add_argument("--out", type=Path, required=True)
    made.add_argument("--name", default="suite")
    sub.add_parser("tasks", help="print each task's prompt and answer key")
    finished = sub.add_parser("finish", help="record that the arm has stopped")
    finished.add_argument("run", type=Path)
    checked = sub.add_parser("check", help="run one task's state assertions")
    checked.add_argument("task", choices=sorted(TASKS))
    checked.add_argument("run", type=Path)
    reported = sub.add_parser("report", help="state assertions plus rejected commands and meter totals")
    reported.add_argument("task", choices=sorted(TASKS))
    reported.add_argument("run", type=Path)
    reported.add_argument("--meter", type=Path)
    args = parser.parse_args(argv)

    if args.command == "tasks":
        for task in TASKS.values():
            print(f"{task.key}\n  prompt: {task.prompt}\n  answer: {task.answer}\n")
        return 0
    if args.command == "finish":
        run = json.loads(args.run.read_text())
        run["finished"] = time.time()
        args.run.write_text(json.dumps(run, indent=2, ensure_ascii=False))
        return 0
    http = http or httpx.Client(base_url=args.url, timeout=120)
    if args.command == "setup":
        run = setup(http, args.name)
        run["started"] = time.time()
        args.out.write_text(json.dumps(run, indent=2, ensure_ascii=False))
        print(run["project_id"])
        return 0
    run = json.loads(args.run.read_text())
    # Read the meter before observing, so the checks' own requests aren't
    # counted; `finished` keeps out whatever was read after the arm stopped.
    totals = (meter_totals(args.meter, since=run.get("started", 0.0), until=run.get("finished"))
              if getattr(args, "meter", None) else None)
    observed = observe(http, run)
    passed = _print_check(args.task, TASKS[args.task].check(observed))
    if args.command == "report":
        rejected = observed.rejected()
        previews = sum(1 for r in observed.transcript if r["seq"] > run["seq"] and r.get("preview"))
        commands = sum(1 for r in observed.transcript if r["seq"] > run["seq"] and not r.get("preview"))
        print(f"  transcript: {commands} commands, {previews} previews, {len(rejected)} rejected")
        for record in rejected:
            message = (record.get("error") or {}).get("message", "")
            print(f"    rejected {record['action']}{' preview' if record.get('preview') else ''}: {message[:120]}")
        if totals:
            print(f"  meter: {totals['requests']} requests ({totals['gets']} GET, {totals['posts']} POST), "
                  f"{totals['bytes']:,} response bytes, ~{totals['bytes'] // 4:,} tokens, status {totals['status']}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
