"""Replay a transcript onto a fresh project.

A transcript records what an arm did to a project: every command it sent, the
selection by id and by label, and the groups each command created, in project
order. Sent again against a fresh project, in order, those commands build the
same project. That is what makes a recorded run reusable: it can be replayed
on later code to see whether the same commands still give the same answer,
and the suite's state assertions can be run against the result exactly as they
were run against the original.

The one thing a replay has to work out for itself is which group each command
meant. A fresh project mints fresh ids, and a label is not enough: a run that
merged twice has two groups called "merge", and the transcript names the one
the next command selected only by its id. The record of the command that
created a group carries that id, so the replay keeps a map from recorded id to
replayed id, extended each time a command creates groups. Creation order is
project order on both sides, so the n-th group a command made then is the n-th
it makes now. The selection and any option that names a group (`standard_id`,
`reference_id`, `source_id`) are translated through the map before sending.

What a replay cannot do, it says rather than guesses. A record whose options
were condensed to a shape (a deglitch of forty points is recorded as
`<40 numbers, 0 .. 39>`) cannot be sent, and the replay stops there. A command
that was accepted then and is rejected now is a divergence, as is a command
that creates a different number of groups, or a group under a different label.
Previews, rejected commands and retries answered from the record are skipped,
because they changed nothing, and counted, because they are still part of
what the run cost.

    python -m xraylarch_web.agent_suite replay transcript.jsonl --out run.json
    python -m xraylarch_web.agent_suite check T2 run.json

The transcript is the project's `transcript.jsonl`, or the JSON that
`GET .../transcript?limit=500` or `larchctl log --json` returns.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# The markers agent_transcript._condense and _trim leave behind.
CONDENSED = re.compile(r"<\d+ numbers, |<\+\d+ (?:more|chars)>|^<omitted, \d+ bytes>$")
ID_KEYS = ("standard_id", "reference_id", "source_id", "background_standard_id")


@dataclass
class Step:
    """One transcript record, and what the replay did with it."""
    seq: int
    action: str
    status: str  # replayed | skipped | diverged
    note: str = ""


@dataclass
class Replay:
    project_id: str
    version: int
    steps: list[Step] = field(default_factory=list)
    divergences: list[str] = field(default_factory=list)
    ids: dict[str, str] = field(default_factory=dict)
    setup: dict | None = None

    @property
    def ok(self) -> bool:
        return not self.divergences

    def replayed(self) -> int:
        return sum(1 for step in self.steps if step.status == "replayed")

    def skipped(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for step in self.steps:
            if step.status == "skipped":
                counts[step.note] = counts.get(step.note, 0) + 1
        return counts


def load_records(path: Path | str) -> list[dict]:
    """Records from a transcript file, oldest first.

    Takes the JSON Lines file the server keeps, or the JSON reply of the
    transcript route (a dict with `records`), or a bare JSON list.
    """
    text = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except ValueError:
        data = [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(data, dict):
        data = data["records"] if "records" in data else [data]
    return sorted(data, key=lambda record: record.get("seq", 0))


def condensed(value) -> bool:
    """Whether the recorded options lost something a replay would need."""
    if isinstance(value, dict):
        return any(condensed(item) for item in value.values())
    if isinstance(value, list):
        return any(condensed(item) for item in value)
    return isinstance(value, str) and bool(CONDENSED.search(value))


def _translate(value, ids: dict[str, str]):
    """Rewrite every recorded group id in an options value to its replayed id."""
    if isinstance(value, dict):
        return {key: _translate(item, ids) for key, item in value.items()}
    if isinstance(value, list):
        return [_translate(item, ids) for item in value]
    if isinstance(value, str):
        return ids.get(value, value)
    return value


def _unknown_ids(options: dict, ids: dict[str, str]) -> list[str]:
    """Option fields that name a group the replay has not seen created."""
    return [key for key in ID_KEYS
            if isinstance(options.get(key), str) and options[key] not in ids]


def _message(response) -> str:
    """The error envelope's message, or the body when there is no envelope."""
    try:
        body = response.json()
    except ValueError:
        return response.text
    envelope = body.get("error", body) if isinstance(body, dict) else {}
    return (envelope.get("message") if isinstance(envelope, dict) else None) or response.text


def _skip_reason(record: dict) -> str | None:
    if record.get("replay_of"):
        return "answered from the record"
    if record.get("preview"):
        return "preview"
    if not record.get("ok"):
        return "rejected"
    return None


def _made(before: list[dict], after: list[dict]) -> tuple[list[dict], set[str]]:
    """Groups created and ids removed, read off two summaries in project order."""
    was = {group["id"] for group in before}
    now = {group["id"] for group in after}
    return [group for group in after if group["id"] not in was], was - now


def replay(http, records: list[dict], *, name: str = "replay",
           setup_seq: int | None = None, keep_going: bool = False) -> Replay:
    """Send a transcript's successful commands, in order, to a new project.

    `setup_seq` names the record after which the arm started; the result's
    `setup` is then a run file for `agent_suite.check`, describing the project
    as the arm found it. It defaults to the first successful `example`, which
    is how the suite's `setup` makes a project.
    """
    created = http.post("/api/athena/projects", json={"name": name})
    created.raise_for_status()
    base = f"/api/athena/projects/{created.json()['id']}"
    summary = http.get(base, params={"view": "summary"}).json()
    result = Replay(project_id=summary["id"], version=summary["version"])
    groups: list[dict] = summary["groups"]
    if setup_seq is None:
        setup_seq = next((record["seq"] for record in records
                          if record.get("ok") and record.get("action") == "example"
                          and not record.get("preview")), None)
    last_after = None

    def diverge(seq: int, action: str, note: str) -> None:
        result.divergences.append(f"seq {seq} {action}: {note}")
        result.steps.append(Step(seq, action, "diverged", note))

    for record in records:
        seq, action = record.get("seq", 0), record.get("action", "?")
        reason = _skip_reason(record)
        if reason:
            result.steps.append(Step(seq, action, "skipped", reason))
            continue
        before = record.get("version_before")
        if last_after is not None and before is not None and before != last_after:
            # Not a stop: the replay may still work. But a reader comparing
            # the two projects needs to know the original was changed by
            # something the transcript did not see, an import or a restore.
            result.divergences.append(
                f"seq {seq} {action}: the project moved from version {last_after} to "
                f"{before} outside the transcript")
        last_after = record.get("version_after")

        options = record.get("options") or {}
        if condensed(options):
            diverge(seq, action, "its options were condensed in the record and cannot be sent")
            if keep_going:
                continue
            break
        unknown = _unknown_ids(options, result.ids)
        if unknown:
            diverge(seq, action, f"{', '.join(unknown)} names a group the replay never saw created")
            if keep_going:
                continue
            break
        selection, missing = [], []
        labels = record.get("groups") or []
        for position, gid in enumerate(record.get("group_ids") or []):
            if gid in result.ids:
                selection.append(result.ids[gid])
                continue
            label = labels[position] if position < len(labels) else gid
            matches = [group["id"] for group in groups if group["label"] == label]
            if len(matches) == 1:
                selection.append(matches[0])
            else:
                missing.append(label)
        if missing:
            diverge(seq, action, f"selects {missing}, which the replay never saw created")
            if keep_going:
                continue
            break

        response = http.post(f"{base}/command", params={"view": "summary"},
                             json={"version": result.version, "action": action,
                                   "group_ids": selection,
                                   "options": _translate(options, result.ids)})
        if response.status_code != 200:
            diverge(seq, action, f"accepted then, rejected now ({response.status_code}): "
                                 f"{_message(response)[:200]}")
            if keep_going:
                continue
            break
        after = response.json()
        result.version = after["version"]
        made, removed = _made(groups, after["groups"])
        groups = after["groups"]
        recorded = record.get("created") or []
        differences = []
        if len(made) != len(recorded):
            differences.append(f"created {len(made)} groups where the record says {len(recorded)}")
        for old, new in zip(recorded, made):
            result.ids[old["id"]] = new["id"]
            if old.get("label") != new["label"]:
                differences.append(f"created '{new['label']}' where the record says '{old.get('label')}'")
            if bool(old.get("processing_error")) != bool(new.get("processing_error")):
                differences.append(f"'{new['label']}' "
                                   + ("failed to process now and did not then"
                                      if new.get("processing_error") else "processed now and did not then"))
        recorded_removed = {result.ids.get(gid, gid) for gid in record.get("removed") or []}
        if recorded_removed != removed:
            differences.append(f"removed {len(removed)} groups where the record says {len(recorded_removed)}")
        result.divergences.extend(f"seq {seq} {action}: {note}" for note in differences)
        notes = [f"+{group['label']}" for group in made] + [f"-{gid}" for gid in sorted(removed)]
        result.steps.append(Step(seq, action, "replayed",
                                 " ".join(notes + [f"({note})" for note in differences])))

        if seq == setup_seq:
            log = http.get(f"{base}/transcript").json()
            result.setup = {
                "project_id": result.project_id, "version": result.version,
                "seq": max((item["seq"] for item in log["records"]), default=0),
                "groups": {group["label"]: group["id"] for group in groups},
            }
    if result.setup is None:
        result.setup = {"project_id": result.project_id, "version": summary["version"],
                        "seq": 0, "groups": {}}
    # Replaying successful mutations must not erase the original arm's errors
    # from transcript-dependent task assertions.
    result.setup["source_rejections"] = [
        record for record in records
        if not record.get("ok") and record.get("seq", 0) > (setup_seq or 0)
    ]
    return result
