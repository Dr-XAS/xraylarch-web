"""An append-only record of every command issued against a project.

Three jobs, in descending order of how much they justify the file existing.

It is the experiment's primary data. Comparing a native-tool-calling arm against
an arm that drives this app needs to know what the second one actually did:
which actions it chose, how many of them were rejected, and how many turns it
spent recovering from its own mistakes. None of that is recoverable from the
project record, which keeps only the outcome.

It is the agent's memory. A caller that has lost its context can read back what
it already tried instead of trying it again. `history` inside the project holds
one prose line per saved version and nothing about what was asked for, so it
cannot answer "did I already try kmax=12".

And it is where an idempotency key lives. A command that times out leaves the
caller unable to tell a lost request from a lost response; retrying it blind
either merges twice or, because the retry still carries the old version, comes
back as a stale-revision error blaming another tab for the caller's own write.
A key turns that into a clean answer: the record says the command already ran,
so it is not run again.

This records a rejected command as carefully as one that worked, and a preview
as carefully as a mutation. An agent's error rate is a measurement, not an
embarrassment, and a log that kept only the successes would flatter every arm
equally and tell us nothing. Previews are marked as such, so a reader counting
commands can leave them out; what a reader must not have to do is guess that
four accepted commands were preceded by nine rejected previews.

The browser pays for none of this beyond one short appended line per mutation,
written under a lock of its own so it never contends with the project lock.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone

from .agent_views import describe_numbers

# A run of numbers this long in an options dict is data — deglitch point
# indices, a reorder's id list — not a setting anyone will read back. The
# marker keeps the length and both ends so a reader can tell what was elided.
ARRAY_FLOOR = 8
LIST_CAP = 32
STRING_CAP = 200
RECORD_CAP = 4096
MAX_RECORDS = 2000
FILE = "transcript.jsonl"
LOCK = "transcript.lock"


def _condense(value):
    """Shrink a recorded options dict to something worth reading back."""
    if isinstance(value, dict):
        return {key: _condense(item) for key, item in value.items()}
    if isinstance(value, list):
        numbers = [item for item in value
                   if isinstance(item, (int, float)) and not isinstance(item, bool)]
        if len(value) > ARRAY_FLOOR and len(numbers) == len(value):
            return describe_numbers(value)
        kept = [_condense(item) for item in value[:LIST_CAP]]
        # A reorder of a hundred groups sends a hundred ids. Truncating them is
        # fine; doing it without saying so is not, because a reader has no way
        # to tell a short list from the start of a long one.
        return kept if len(value) <= LIST_CAP else kept + [f"<+{len(value) - LIST_CAP} more>"]
    if isinstance(value, str) and len(value) > STRING_CAP:
        return value[:STRING_CAP] + f"<+{len(value) - STRING_CAP} chars>"
    # inf and nan reach an options dict whenever a caller builds a Command in
    # Python instead of over HTTP, and no JSON encoder will take them. They are
    # usually the reason the command was rejected, so the record keeps them as
    # the words the caller will recognise.
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    return value


def _trim(record: dict) -> dict:
    """Drop empty fields, then the options if the record is still oversized."""
    record = {key: value for key, value in record.items()
              if value not in (None, [], {}, "")}
    if len(json.dumps(record)) > RECORD_CAP and "options" in record:
        record["options"] = f"<omitted, {len(json.dumps(record['options']))} bytes>"
    return record


class Transcript:
    """The transcript of one workspace, stored beside its project.

    JSON Lines rather than a JSON array, because the common operation is
    appending one record and the second most common is reading the last few.
    """

    def __init__(self, storage):
        self.storage = storage

    def _path(self, ident: str):
        return self.storage.path(ident, FILE)

    def read(self, ident: str, *, limit: int | None = None, since: int = 0) -> list[dict]:
        """Records with seq > since, oldest first, at most `limit` of them.

        A malformed line is skipped rather than raising. The transcript is
        diagnostic; refusing to show the ninety good records because the
        ninety-first was half-written during a crash would be the wrong trade.
        """
        try:
            with open(self._path(ident), encoding="utf-8") as handle:
                lines = handle.readlines()
        except FileNotFoundError:
            return []
        records = []
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("seq", 0) > since:
                records.append(record)
        return records[-limit:] if limit is not None else records

    def find(self, ident: str, key: str) -> dict | None:
        """The earliest record written under this idempotency key.

        Earliest, not latest: a second retry must be answered by the command
        that actually ran, not by the reply sent to the first retry.
        """
        for record in self.read(ident):
            if record.get("key") == key and not record.get("replay_of"):
                return record
        return None

    def append(self, ident: str, record: dict) -> dict:
        """Add one record, numbering it under the transcript's own lock."""
        with self.storage.lock(ident, LOCK):
            existing = self.read(ident)
            record = _trim({
                "seq": (existing[-1]["seq"] if existing else 0) + 1,
                "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                **record,
            })
            line = json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n"
            if len(existing) >= MAX_RECORDS:
                self._rewrite(ident, existing[-(MAX_RECORDS - 1):], line)
            else:
                descriptor = os.open(self._path(ident),
                                     os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
                try:
                    os.write(descriptor, line.encode("utf-8"))
                finally:
                    os.close(descriptor)
        return record

    def _rewrite(self, ident: str, keep: list[dict], line: str) -> None:
        """Drop the oldest records so one project cannot grow without bound."""
        body = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in keep) + line
        self.storage.write_bytes(ident, FILE, body.encode("utf-8"))


def _groups(project: dict | None, group_ids: list[str]) -> list[str]:
    """Label the selection, so a record stays legible after the ids are gone."""
    if not project:
        return []
    labels = {group["id"]: group["label"] for group in project["groups"]}
    return [labels.get(gid, gid) for gid in group_ids]


def _outcome(before: dict | None, after: dict) -> dict:
    """What the command did to the group list, by diffing around it."""
    was = {group["id"] for group in (before or {}).get("groups", ())}
    now = {group["id"]: group for group in after.get("groups", ())}
    operation = after.get("last_operation") or {}
    return {
        "created": [
            {"id": gid, "label": group["label"],
             # The POST returning 200 does not mean the new group processed.
             # Recording the error here is what makes that visible in a log.
             "processing_error": group.get("processing_error")}
            for gid, group in now.items() if gid not in was
        ],
        "removed": sorted(was - set(now)),
        "skipped": operation.get("skipped_group_ids") or [],
        "skipped_reasons": operation.get("skipped_reasons") or [],
    }


def _failure(error: Exception) -> dict:
    """The rejection, as the caller saw it. The message is the useful part."""
    envelope = getattr(error, "envelope", None)
    return {
        "code": getattr(error, "code", error.__class__.__name__),
        "message": str(error)[:STRING_CAP],
        "recovery": getattr(envelope, "recovery", None),
    }


def preview_entry(request, project: dict | None,
                  error: Exception | None = None) -> dict:
    """The record for a preview, which saved nothing whether or not it worked.

    Previews are the look-before-you-leap path, and so they are where a caller
    that is guessing spends most of its turns. A transcript that held only
    /command therefore started counting an agent's mistakes at the point where
    it had stopped making them: a run that probed four bodies against a preview
    and sent the fifth to /command showed up as four commands, none rejected.

    A preview record carries `preview: true` and no version_after, because
    nothing moved. That flag is what lets a reader count previews in or out
    rather than having to guess which records were real.
    """
    record = {
        "action": request.action,
        "preview": True,
        "group_ids": list(request.group_ids),
        "groups": _groups(project, request.group_ids),
        "options": _condense(request.options),
        "requested_version": request.version,
        "version_before": (project or {}).get("version"),
    }
    if error is None:
        return {**record, "ok": True}
    return {**record, "ok": False, "error": _failure(error)}


def entry(request, key: str | None, seen: dict, project: dict | None,
          error: Exception | None = None) -> dict:
    """Build the record for one attempted command, successful or not.

    `seen["before"]` is the project as the dispatcher loaded it; it is absent
    when the command failed before getting that far, which is itself worth
    being able to tell apart from a command that failed during processing.
    """
    before = seen.get("before")
    record = {
        "action": request.action,
        "group_ids": list(request.group_ids),
        "groups": _groups(before or project, request.group_ids),
        "options": _condense(request.options),
        "key": key,
        "requested_version": request.version,
        "version_before": (before or {}).get("version"),
    }
    if error is not None:
        record["ok"] = False
        record["error"] = _failure(error)
        return record
    history = (project or {}).get("history") or []
    return {
        **record,
        "ok": True,
        "version_after": project["version"],
        "message": (history[-1]["message"] if history else None),
        **_outcome(before, project),
    }


def replay_entry(prior: dict, key: str) -> dict:
    """The record for a retry that was answered instead of executed."""
    return {"action": prior.get("action"), "key": key, "ok": True,
            "replay_of": prior["seq"]}


def replayed(project: dict, prior: dict) -> dict:
    """The response to a retry: current state, told what happened to it.

    last_operation is already this response's channel for "what just
    happened", so an answered retry says so there rather than inventing a
    field. Nothing is written, and the project is a copy: the stored record
    keeps whatever last_operation it had.
    """
    return {**project, "last_operation": {
        **(project.get("last_operation") or {}),
        "idempotent_replay": {
            "seq": prior["seq"],
            "action": prior.get("action"),
            "version_after": prior.get("version_after"),
            # The project may have moved on since. Saying so is cheaper than
            # letting a caller assume this response is the original one.
            "note": "This command already ran under the same key and was not "
                    "run again. The project shown is its current state, which "
                    "may include later changes.",
        },
    }}
