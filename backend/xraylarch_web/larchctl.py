"""A command line over the Athena Web HTTP API.

    PYTHONPATH=backend python -m xraylarch_web.larchctl --help

This exists because "drive the app" and "write an HTTP client" are different
tasks, and only the first one is interesting. Every subcommand is one request or
two against a running backend; there is no local state beyond the project id,
which can come from --project or the LARCHCTL_PROJECT environment variable.

Two decisions are worth knowing about before reading further.

The first is that output is written for a reader, not a parser, unless --json
says otherwise. The whole point of this layer is that a caller who cannot open a
plot still gets the numbers, and a dense table carries far more of them per line
than the equivalent JSON. --json is there for when something downstream really
does need to parse it.

The second is that the project version is never asked of the caller. /command
takes a version and rejects a stale one, which is right for a browser with a
window open and pure friction here; this fetches the current version
immediately before sending. That narrows the race rather than closing it: if
something else writes in between, the 409 still surfaces, with its message.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from typing import Any

# The one piece of the backend this imports. It is pure, and the server applies
# the same elision under ?view=summary; sharing it keeps the marker a caller
# sees identical whichever side drew it.
from .agent_views import elide_arrays

BASE = os.environ.get("LARCHCTL_URL", "http://127.0.0.1:8006")


class Failed(Exception):
    """An error already phrased for the person who typed the command."""


class Client:
    """The API, with its error envelope turned back into a message."""

    def __init__(self, base: str, http=None):
        import httpx
        # Tests pass a client bound straight to the ASGI app, which is the only
        # way to exercise the CLI without a listening port. A borrowed client
        # belongs to its owner, so only a client made here gets closed here.
        self._borrowed = http is not None
        self._http = http or httpx.Client(base_url=base, timeout=120.0)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if not self._borrowed:
            self._http.close()

    def request(self, method: str, path: str, *, raw=False, api="athena", **kwargs) -> Any:
        import httpx
        try:
            response = self._http.request(method, f"/api/{api}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise Failed(f"Could not reach the backend at {self._http.base_url}: {exc}")
        if response.status_code >= 400:
            raise Failed(_envelope(response))
        # The array export answers in CSV. Everything else answers in JSON, and
        # asking a CSV body for .json() would report a parse error rather than
        # the file the caller asked for.
        return response.text if raw else response.json()

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)


def _envelope(response) -> str:
    """Unwrap ErrorEnvelope, keeping the recovery hint that comes with it."""
    try:
        error = response.json()["error"]
    except (ValueError, KeyError, TypeError):
        return f"HTTP {response.status_code}: {response.text[:400]}"
    parts = [error.get("message") or error.get("code", "request failed")]
    if fields := error.get("fields"):
        parts.append(f"(fields: {', '.join(map(str, fields))})")
    if recovery := error.get("recovery"):
        parts.append(recovery)
    return " ".join(parts)


# ---------------------------------------------------------------- value input

def parse_option(text: str) -> tuple[str, Any]:
    """Turn -o key=value into a typed pair.

    JSON first, so numbers, booleans, null and lists arrive as themselves rather
    than as strings that Pydantic will refuse in strict mode. Anything JSON
    cannot read is a bare string, which is what makes -o window=hanning work
    without quoting.
    """
    name, separator, value = text.partition("=")
    if not separator:
        raise Failed(f"Options look like key=value; got {text!r}.")
    try:
        return name, json.loads(value)
    except ValueError:
        return name, value


def _value(value) -> str:
    if value is None:
        return "auto"
    return f"{value:.3f}" if isinstance(value, float) else str(value)


# Options that name a group. They take labels the way positional groups do,
# because a caller reading a summary has labels in front of it, not ids.
GROUP_OPTIONS = ("standard_id", "reference_id", "background_standard_id")


def _fold(text: str) -> str:
    # NFKC turns the example's "Cu₂O" into "Cu2O", which is what gets typed.
    return unicodedata.normalize("NFKC", text).casefold()


def resolve_group(summary: dict, token: str) -> str:
    """Accept a group id or enough of its label to be unambiguous.

    Ids are opaque, and a caller working from a summary has the labels in front
    of it. Refusing an ambiguous prefix matters more than resolving it cleverly:
    silently picking one of two spectra is the kind of mistake that survives all
    the way into a result.
    """
    groups = summary["groups"]
    if any(group["id"] == token for group in groups):
        return token
    folded = _fold(token)
    # A whole label wins over the labels that contain it. Otherwise naming a
    # merge "Cu foil · 300 K + cold scans" makes "Cu foil · 300 K" ambiguous,
    # and the only way back to the scan is its id.
    exact = [group for group in groups if _fold(group["label"]) == folded]
    # So does a whole part of one: "300 K" is the scan "Cu foil · 300 K" more
    # than it is the merge "Cu foil · merge of 10 K, 50 K, 300 K".
    segment = [group for group in groups
               if folded in (part.strip() for part in _fold(group["label"]).split("·"))]
    matches = exact or segment or [group for group in groups if folded in _fold(group["label"])]
    if len(matches) == 1:
        return matches[0]["id"]
    if not matches:
        known = ", ".join(f"{g['id']} {g['label']!r}" for g in groups) or "none"
        raise Failed(f"No group matches {token!r}. This project has: {known}")
    labels = ", ".join(repr(group["label"]) for group in matches)
    raise Failed(f"{token!r} matches several groups: {labels}. Use an id.")


# ------------------------------------------------------------------ rendering

def _number(value, digits=3) -> str:
    if value is None:
        return "-"
    return f"{value:.{digits}f}" if isinstance(value, float) else str(value)


def _table(rows: list[list[str]], headers: list[str]) -> str:
    widths = [max(len(str(cell)) for cell in column)
              for column in zip(headers, *rows)] if rows else [len(h) for h in headers]
    line = lambda cells: "  ".join(
        str(cell).ljust(width) for cell, width in zip(cells, widths)).rstrip()
    return "\n".join([line(headers), *(line(row) for row in rows)])


def render_summary(summary: dict) -> str:
    counts = summary["counts"]
    head = [
        f"{summary['name']}  (id {summary['id']}, version {summary['version']})",
        f"{counts['groups']} groups · {counts['processed']} processed · "
        f"{counts['failed']} failed · {counts['marked']} marked · {counts['frozen']} frozen"
        f"   undo: {'yes' if summary['can_undo'] else 'no'}"
        f"  redo: {'yes' if summary['can_redo'] else 'no'}",
    ]
    rows = []
    labels = {group["id"]: group["label"] for group in summary["groups"]}
    for group in summary["groups"]:
        flags = [name for name in ("marked", "frozen") if group[name]]
        if group["exafs"]:
            flags.append("exafs")
        if group["processing_error"]:
            flags.append("ERROR")
        if group["warnings"]:
            flags.append(f"{len(group['warnings'])} warnings")
        if group.get("reference_id"):
            # A shared reference makes linked groups shift as one family, and
            # align refuses to move one away from its standard's family.
            flags.append(f"ref:{labels.get(group['reference_id'], group['reference_id'])[:16]}")
        if derived := group.get("derived"):
            flags.append(f"{derived['operation']} of {len(derived['parents'])}"
                         + (f" ({derived['array']})" if derived.get("array") else ""))
            if derived.get("excluded"):
                flags.append(f"{len(derived['excluded'])} EXCLUDED")
        span = group["range"]
        # An alignment moves energy_shift and leaves E0 where it was, so
        # without this column the table looks identical before and after one
        # except for a range that slid by a few eV with nothing saying why.
        # It does not apply to a chi group, whose axis is k.
        shift = "-" if group["axis"] == "k" else _number(group["energy_shift"])
        rows.append([
            group["id"], group["label"][:34], group["data_type"],
            group["element"] or "-", _number(group["e0"], 2), shift,
            _number(group["edge_step"]),
            f"{span[0]:.0f}-{span[1]:.0f} {group['axis']}" if span else "-",
            str(group["points"]), ",".join(flags) or "-",
        ])
    body = _table(rows, ["ID", "LABEL", "TYPE", "EL", "E0", "SHIFT", "STEP",
                         "RANGE", "PTS", "FLAGS"])
    files = {group["label"]: group.get("file") for group in summary["groups"]}
    same = [f"same data: {' = '.join(labels)}"
            + (f"  ({files[labels[0]]})" if files.get(labels[0]) else "")
            for labels in summary.get("same_data") or ()]
    return "\n".join([*head, "", body, *same])


def render_compare(report: dict) -> str:
    base = report["reference"]
    lines = [f"against {base['label']}  (e0 {_number(base['e0'], 2)}, step {_number(base['edge_step'])},"
             f" {base['points']} pts, kmax avail {_number(base['available_kmax'], 2)})"]
    rows = []
    for row in report["groups"]:
        shift = row.get("energy_shift") or {}
        common = row.get("common_range")
        rows.append([
            row["label"][:34],
            _number(row.get("e0_difference"), 2),
            _number(shift.get("value")) if "value" in shift else ("n/a" if shift else "-"),
            _number(row.get("edge_step_ratio")),
            _number(row.get("xanes_max_difference")),
            f"{common[0]:.0f}-{common[1]:.0f}" if common else "-",
            str(row["points"]), _number(row.get("available_kmax"), 2),
            ", ".join(row.get("same_data_as") or ()) or "-",
        ])
    # ALIGN BY rather than SHIFT: the summary's SHIFT is the shift a group
    # already carries, and this is what align would add to it.
    lines.append(_table(rows, ["LABEL", "dE0", "ALIGN BY", "STEP/REF", "XANES", "COMMON",
                               "PTS", "KMAX", "SAME DATA AS"]))
    for row in report["groups"]:
        if amplitude := row.get("chi_amplitude"):
            lines.append(f"  chi amplitude {row['label'][:28]} (k^{amplitude['kweight']:g}): " + "  ".join(
                f"{entry['k'][0]:g}-{entry['k'][1]:g} {entry['ratio']:.2f}" for entry in amplitude["bins"]))
        if (shift := row.get("energy_shift") or {}).get("unavailable"):
            lines.append(f"  shift {row['label'][:28]}: {shift['unavailable']}")
    lines.append(report["note"])
    return "\n".join(lines)


def render_parameters(view: dict) -> str:
    blocks = []
    for group in view["groups"]:
        lines = [f"{group['id']}  {group['label']}  ({group['data_type']})"]
        if group["processing_error"]:
            lines.append(f"  ERROR: {group['processing_error']}")
        effective = group["effective"]
        for name, requested in sorted(group["requested"].items()):
            used = effective.get(name)
            if used is not None and requested != used:
                lines.append(f"  {name:<20} {_number(requested)}  ->  {_number(used)}  (resolved)")
            else:
                lines.append(f"  {name:<20} {_number(requested)}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def render_digest(digest: dict) -> str:
    group, lines = digest["group"], []
    lines.append(f"{group['label']}  ({group['id']})")
    # Where the data came from is the first thing a description of a scan
    # states, and the digest had it while the table left it out.
    lines.append(f"  from {group.get('file') or '?'}"
                 + (f": {digest['citation']}" if digest.get("citation") else ""))
    lines.append(f"  {group['data_type']}, {group['element'] or '?'} {group['edge'] or ''}"
                 f" ({group['edge_origin'] or 'unknown origin'}),"
                 f" e0 {_number(group['e0'], 2)}, edge step {_number(group['edge_step'])}")
    sampling = digest["sampling"]
    if step := sampling.get("step"):
        lines.append(f"  {sampling['points']} points, step "
                     f"{step['min']:.3f}/{step['median']:.3f}/{step['max']:.3f} (min/med/max)"
                     f", {'uniform' if sampling.get('uniform') else 'non-uniform'}")
    if unavailable := digest.get("unavailable"):
        lines.append(f"  NOT PROCESSED: {unavailable}")
        return "\n".join(lines)

    def pairs(title, block, skip=()):
        rows = []
        for name, value in block.items():
            if name in skip or not isinstance(value, dict) or "requested" not in value:
                continue
            # A parameter left unset is not the same fact as one set to the
            # value processing happened to pick, so say which it was.
            asked = "auto" if value["requested"] is None else _number(value["requested"])
            arrow = (f"{asked}->{_number(value['used'])}"
                     if value["requested"] != value["used"] else _number(value["used"]))
            rows.append(f"{name}={arrow}")
        if rows:
            lines.append(f"  {title}: " + "  ".join(rows))

    if normalization := digest.get("normalization"):
        pairs("normalization", normalization)
        for adjustment in normalization.get("adjustments") or ():
            lines.append(f"    clipped {adjustment['parameter']}: {adjustment.get('reason', '')}")
    if background := digest.get("background"):
        pairs("background", background)
    if transform := digest.get("transform"):
        pairs("transform", transform)
        lines.append(f"    available kmax {_number(transform.get('available_kmax'), 2)}")
    if peaks := digest.get("chir_peaks"):
        lines.append("  |chi(R)| peaks: " + "  ".join(
            f"{peak['r']:.2f} A ({peak['magnitude']:.3g})" for peak in peaks))
        lines.append(f"    {digest['chir_peaks_note']}")
    if noise := digest.get("noise"):
        if "unavailable" in noise:
            lines.append(f"  noise: {noise['unavailable']}")
        else:
            lines.append(f"  noise: epsilon_k {noise.get('epsilon_k'):.3g}"
                         f" over the current transform range, "
                         f"independent points {_number(noise.get('nidp'), 1)}"
                         f", Larch suggests kmax {_number(noise.get('recommended_kmax'), 2)}")
    if snr := digest.get("signal_to_noise"):
        if "unavailable" in snr:
            lines.append(f"  chi/noise by k: {snr['unavailable']}")
        else:
            lines.append("  chi/noise by k: " + "  ".join(
                f"{b['k'][0]:g}-{b['k'][1]:g}:{b['ratio']:g}" for b in snr["bins"]))
            lines.append(f"    floor epsilon_k {snr['epsilon_k']:.3g} measured over "
                         f"k {snr['over'][0]:g}-{snr['over'][1]:g}; "
                         f"a window near 1 is noise, not signal")
    for warning in digest.get("warnings") or ():
        lines.append(f"  WARNING: {warning}")
    return "\n".join(lines)


def render_capabilities(listing: dict) -> str:
    rows = [[row["action"], row["selection"],
             "new" if row["creates_groups"] else "", "preview" if row["has_preview"] else "",
             row["summary"]] for row in listing["actions"]]
    return "\n".join([
        f"POST {listing['post']}   detail: larchctl describe <action>",
        "selection: " + "; ".join(f"{k}={v}" for k, v in listing["selections"].items()),
        "",
        _table(rows, ["ACTION", "SEL", "", "", "SUMMARY"]),
        "",
        "analyses (POST " + listing["analyses"]["post"] + "): "
        + ", ".join(listing["analyses"]["actions"]),
        # The reads are subcommands here rather than actions, and without this
        # line the only list of them is --help.
        "reads: larchctl summary | params | digest G | compare G G... | log | export G"
        " | fit G (distances) | structures",
    ])


def render_action(action: dict) -> str:
    lines = [f"{action['action']}  -  {action['summary']}",
             f"  groups: {action['selection_meaning']}"]
    if action["creates_groups"]:
        lines.append("  creates new groups")
    if preview := action.get("preview"):
        lines.append(f"  preview: POST {preview}")
        lines.append(f"    {action['preview_note']}")
    if note := action.get("note"):
        lines.append(f"  note: {note}")
    if action["options"]:
        lines.append("  options:")
        width = max(len(name) for name in action["options"])
        lines += [f"    {name.ljust(width)}  {text}"
                  for name, text in action["options"].items()]
        if source := action.get("options_source"):
            lines.append(f"    ({source})")
    else:
        lines.append("  options: none")
    return "\n".join(lines)


def render_preview(payload: dict) -> str:
    """A preview without its curves, which is the part a caller can act on.

    The merge preview gets a table, because what it is read for (who went in,
    who was left out, whether they agree) is a few numbers per member that
    JSON spreads over a hundred lines. Others are JSON with the curves elided.
    """
    if payload.get("rows") and all("shift_delta" in row for row in payload["rows"]):
        return _render_alignment_preview(payload)
    outputs = payload.get("outputs") or []
    if not outputs or not all("members" in (output.get("result") or {}) for output in outputs):
        return json.dumps(payload, indent=1)
    lines = []
    for output in outputs:
        result, agreement = output["result"], output.get("agreement") or {}
        details = result.get("details") or {}
        rms = {row["label"]: row["rms_to_range"] for row in agreement.get("members") or ()}
        lines.append(f"{output['role']} merge of {details.get('array', '?')}, "
                     f"{details.get('count', len(result['members']))} members, weighted by "
                     f"{details.get('weightby', '?')}, over {_number(details.get('xmin'), 1)}"
                     f"-{_number(details.get('xmax'), 1)}")
        rows = [[member["label"][:34], str(member["points"]), _number(member["coefficient"], 3),
                 str(member["extrapolated_points"] or "-"), _number(rms.get(member["label"]), 4)]
                for member in result["members"]]
        lines.append(_table(rows, ["MEMBER", "PTS", "COEF", "EXTRAP", "RMS/RANGE"]))
        for left_out in result.get("excluded") or ():
            lines.append(f"  EXCLUDED {left_out['label']}: {left_out['reason']}")
        if agreement:
            lines.append(f"  scatter/range median {agreement['scatter_to_range']:.4f}, "
                         f"max {agreement['max_scatter_to_range']:.4f}")
        for warning in result.get("warnings") or ():
            lines.append(f"  WARNING: {warning}")
        lines.append("")
    if note := next((output["agreement"]["note"] for output in outputs if output.get("agreement")), None):
        lines.append(note)
    lines.append("Nothing was saved. Run the same command without --preview to merge.")
    return "\n".join(lines)


def _render_alignment_preview(payload: dict) -> str:
    rows = []
    for row in payload["rows"]:
        summary = (row.get("fit") or {}).get("summary") or {}
        rows.append([row["label"][:34], _number(row.get("energy_shift"), 3),
                     _number(row.get("shift_delta"), 3),
                     _number(summary.get("native_shift_stderr", summary.get("shift_stderr")), 3),
                     _number((row.get("after") or {}).get("e0"), 2)])
    standard = next((row["standard"]["label"] for row in payload["rows"] if row.get("standard")), "?")
    lines = [f"align to {standard}",
             _table(rows, ["GROUP", "SHIFT", "CHANGE", "STDERR", "E0 KEPT"])]
    for gid, reason in (payload.get("skipped_reasons") or {}).items():
        lines.append(f"  SKIPPED {gid}: {reason}")
    for gid, error in (payload.get("processing_errors") or {}).items():
        lines.append(f"  ERROR {gid}: {error}")
    lines.append("SHIFT is the energy_shift the group would carry; CHANGE is the move from its "
                 "current one. E0 stays where it was, so it reads about the shift away from the "
                 "edge afterwards. Nothing was saved. Run the same command without --preview to align.")
    return "\n".join(lines)


def render_log(log: dict) -> str:
    """The command history, one line per attempt, failures included.

    Failures are the interesting lines. A caller reading this back is usually
    trying to remember what it already tried, and what did not work is worth
    more than what did.
    """
    lines = [f"{log['count']} records (project at version {log['version']})"]
    for record in log["records"]:
        head = f"{record['seq']:>4}  {record['time'][11:19]}  {record['action']}"
        if record.get("preview"):
            head += " (preview)"
        if groups := record.get("groups"):
            head += " [" + ", ".join(groups) + "]"
        options = record.get("options")
        if isinstance(options, dict) and options:
            head += "  " + " ".join(f"{k}={json.dumps(v)}" for k, v in options.items())
        elif options:
            head += f"  {options}"   # oversized, replaced by its own description
        lines.append(head)
        if replayed := record.get("replay_of"):
            lines.append(f"        answered from record {replayed}; not run again")
            continue
        if not record.get("ok"):
            error = record.get("error") or {}
            lines.append(f"        FAILED {error.get('code')}: {error.get('message')}")
            continue
        if record.get("preview"):
            # A preview has no version_after because it saved nothing; say the
            # body was accepted rather than printing a version that did not move.
            lines.append(f"        accepted at v{record.get('version_before')}; nothing saved")
            continue
        detail = [f"v{record.get('version_before')}->{record['version_after']}"]
        for created in record.get("created") or ():
            detail.append(f"+{created['label']}"
                          + (" ERROR" if created.get("processing_error") else ""))
        if removed := record.get("removed"):
            detail.append(f"-{len(removed)} groups")
        if skipped := record.get("skipped"):
            detail.append(f"skipped {len(skipped)}")
        lines.append("        " + "  ".join(detail))
    return "\n".join(lines)


def _label(groups: dict, gid: str) -> str:
    return groups[gid]["label"] if gid in groups else gid


def render_result(project: dict, before: dict) -> str:
    """What a /command actually did, by diffing the group lists around it."""
    was = {group["id"] for group in before["groups"]}
    now = {group["id"]: group for group in project.get("groups", ())}
    operation = project.get("last_operation") or {}
    if replay := operation.get("idempotent_replay"):
        return (f"already ran under this key as record {replay['seq']} "
                f"(version {replay['version_after']}); nothing was run again. "
                f"The project is at version {project['version']}.")
    lines = [f"version {before['version']} -> {project['version']}"]
    for added in [group for gid, group in now.items() if gid not in was]:
        lines.append(f"  + {added['id']}  {added['label']}"
                     + (f"   ERROR: {added['processing_error']}"
                        if added.get("processing_error") else ""))
        # A merge can leave out groups that were selected for it, and saying
        # "+ merge" with nothing else reads as though it took all of them.
        derived = added.get("derived") or {}
        if derived.get("parents"):
            lines.append(f"      from {', '.join(_label(now, gid) for gid in derived['parents'])}"
                         + (f", averaging {derived['array']}" if derived.get("array") else ""))
        for left_out in derived.get("excluded") or ():
            lines.append(f"      EXCLUDED {left_out['label']}: {left_out['reason']}")
    for removed in sorted(was - set(now)):
        lines.append(f"  - {removed}")
    # Align, calibrate and set_e0 change no group list either; without this
    # their reply was "version 2 -> 3" and the shift took another read.
    previous = {group["id"]: group for group in before["groups"]}
    for gid, group in now.items():
        if gid in previous and (changes := _changed(previous[gid], group, now)):
            lines.append(f"  ~ {group['label']}  " + "  ".join(changes)
                         + (f"   ERROR: {group['processing_error']}" if group.get("processing_error") else ""))
    # A parameters command changes no group list, so without this the reply is
    # just the version, and whether Larch honoured the value takes another read.
    for group in operation.get("applied") or ():
        values = "  ".join(f"{key} {_value(entry['requested'])}->{_value(entry['effective'])}"
                           for key, entry in group["values"].items())
        lines.append(f"  {group['label']}  {values}"
                     + (f"   ERROR: {group['processing_error']}" if group["processing_error"] else ""))
    if skipped := operation.get("skipped_group_ids"):
        lines.append(f"  skipped {len(skipped)}: {', '.join(_label(now, gid) for gid in skipped)}")
    for block in [operation, *(value for value in operation.values() if isinstance(value, dict))]:
        reasons = block.get("skipped_reasons") or ()
        for gid, reason in reasons.items() if isinstance(reasons, dict) else ((None, r) for r in reasons):
            lines.append(f"    {_label(now, gid) + ': ' if gid else ''}{reason}")
        for gid, error in (block.get("processing_errors") or {}).items():
            lines.append(f"  ERROR {_label(now, gid)}: {error}")
        for warning in block.get("warnings") or ():
            lines.append(f"  WARNING: {warning}")
    return "\n".join(lines)


# The summary fields a command can move on a group it does not create.
_WATCHED = ("label", "energy_shift", "e0", "edge_step", "points", "range", "available_kmax",
            "reference_id", "background_standard_id", "marked", "frozen", "is_normalized")


def _changed(before: dict, after: dict, groups: dict) -> list[str]:
    changes = []
    for key in _WATCHED:
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        if key in ("reference_id", "background_standard_id"):
            old, new = (_label(groups, ident) if ident else "none" for ident in (old, new))
        elif key == "range":
            old, new = (f"{_number(pair[0], 1)}-{_number(pair[1], 1)}" if pair else "-" for pair in (old, new))
        elif isinstance(old, float) or isinstance(new, float):
            old, new = _number(old, 3), _number(new, 3)
        if old != new:  # a value that moved in its fifth figure is not news
            changes.append(f"{key} {old}->{new}")
    return changes


# ------------------------------------------------------------------- commands

def need_project(args) -> str:
    if not args.project:
        raise Failed("Name a project with --project or LARCHCTL_PROJECT. "
                     "`larchctl projects` lists them, `larchctl new` makes one.")
    return args.project


def command_projects(client, args):
    listing = client.get("/projects")
    rows = [[item["id"], item.get("name", ""), str(item.get("groups", "")),
             item.get("updated", "")] for item in listing]
    return listing, _table(rows, ["ID", "NAME", "GROUPS", "UPDATED"])


def command_new(client, args):
    project = client.post("/projects")
    if args.name:
        summary = client.post(f"/projects/{project['id']}/command", json={
            "version": project["version"], "action": "project",
            "group_ids": [], "options": {"name": args.name}}, params={"view": "summary"})
    else:
        summary = client.get(f"/projects/{project['id']}", params={"view": "summary"})
    return summary, f"{summary['id']}\n{render_summary(summary)}"


def command_summary(client, args):
    summary = client.get(f"/projects/{need_project(args)}", params={"view": "summary"})
    return summary, render_summary(summary)


def command_params(client, args):
    view = client.get(f"/projects/{need_project(args)}", params={"view": "parameters"})
    return view, render_parameters(view)


def command_digest(client, args):
    ident = need_project(args)
    summary = client.get(f"/projects/{ident}", params={"view": "summary"})
    group_id = resolve_group(summary, args.group)
    digest = client.get(f"/projects/{ident}/groups/{group_id}/digest")
    return digest, render_digest(digest)


def command_compare(client, args):
    ident = need_project(args)
    summary = client.get(f"/projects/{ident}", params={"view": "summary"})
    ids = [resolve_group(summary, token) for token in args.groups]
    report = client.get(f"/projects/{ident}/compare", params={"groups": ",".join(ids)})
    return report, render_compare(report)


# The four guesses both bundled Artemis setups use, and the names a FEFF path's
# s02, e0, deltar and sigma2 default to, so bare path files fit as they are.
DEFAULT_FIT_PARAMETERS = [
    {"name": "amp", "kind": "guess", "value": 1.0, "min": 0.0, "max": 2.0},
    {"name": "del_e0", "kind": "guess", "value": 0.0, "min": -30.0, "max": 30.0},
    {"name": "del_r", "kind": "guess", "value": 0.0, "min": -0.2, "max": 0.2},
    {"name": "sig2", "kind": "guess", "value": 0.008, "min": 0.0, "max": 0.05},
]


def _feff_paths(client, args, absorber: str | None) -> list[dict]:
    """Run FEFF on a bundled AMCSD structure and name the paths it made.

    The job's full status reply carries the CIF, the FEFF log and every path
    file, about 20 KB for one path, so it is polled under ?view=summary and
    never read in full: the fit names each path by its job, and the server
    reads the file out of the job itself.
    """
    import time

    details = client.get(f"/structures/{args.structure}", api="artemis")
    if not details.get("supported"):
        raise Failed(f"AMCSD {args.structure} cannot be used: {' '.join(details.get('warnings') or ())}")
    sites = [site for site in details["sites"] if absorber is None or site["element"] == absorber]
    if args.site is None and not sites:
        raise Failed(f"AMCSD {args.structure} ({details['formula']}) has no {absorber} site.")
    site = args.site or sites[0]["index"]
    job = client.post("/feff/jobs", api="artemis", params={"view": "summary"}, json={
        "amcsd_id": args.structure, "absorber": absorber or sites[0]["element"],
        "site_index": site, "path_radius": args.path_radius,
        "cluster_radius": max(5.0, args.path_radius)})
    deadline = time.monotonic() + 300
    while job["status"] in ("queued", "running"):
        if time.monotonic() > deadline:
            raise Failed(f"FEFF job {job['id']} is still {job['status']} after five minutes.")
        time.sleep(0.5)
        job = client.get(f"/feff/jobs/{job['id']}", api="artemis", params={"view": "summary"})
    if job["status"] != "complete":
        raise Failed(f"FEFF job {job['id']} {job['status']}: {job.get('message')}")
    chosen = job["paths"][:args.max_paths]
    # FEFF stops its calculation at a k of its own (20 for these jobs), and a
    # fit asked to run past it has nothing to compare the data with.
    limits = [path["kmax"] for path in chosen if path.get("kmax")]
    return ([{"feff_job": job["id"], "feff_path": path["id"]} for path in chosen],
            min(limits) if limits else None)


# Where the fit takes its k range from when -t does not say. The route's own
# defaults (k 3-12, dk 2) are the browser's starting point, and a caller who
# has already set the group's transform expects the fit to use it.
_FROM_GROUP = ("kmin", "kmax", "dk")


def _kweight(value):
    """-t kweight=2 and kweight=1,2,3 as well as the list the route takes."""
    if isinstance(value, bool):
        raise Failed(f"kweight needs integers 0-3; got {value!r}.")
    if isinstance(value, int):
        return [value]
    if isinstance(value, str):
        try:
            return [int(part) for part in value.split(",")]
        except ValueError:
            raise Failed(f"kweight needs integers 0-3; got {value!r}.")
    return value


def _group_transform(client, ident: str, group_id: str) -> dict:
    """The group's own k window, once someone has chosen its kmax.

    Every group's recipe names a kmin and a dk, so their presence says nothing
    about intent; a kmax left to Larch runs to the end of the data, noise and
    all. The window is taken whole or not at all, so a fit never mixes the
    group's dk with the route's kmax.
    """
    digest = client.get(f"/projects/{ident}/groups/{group_id}/digest")
    block = digest.get("transform") or {}
    if not isinstance(block.get("kmax"), dict) or block["kmax"].get("requested") is None:
        return {}
    return {key: block[key]["used"] for key in _FROM_GROUP
            if isinstance(block.get(key), dict) and block[key].get("used") is not None}


def _fit_body(client, args, absorber: str | None = None, group: dict | None = None) -> tuple[dict, dict]:
    """The fit request, and where each transform key in it came from.

    FEFF paths and a starting model, with the group's own k range where it set
    one, then -p/--fix/-t applied on top.
    """
    sources, feff_kmax = {}, None
    if args.example:
        example = client.get(f"/examples/{args.example}", api="artemis")
        paths = [{"filename": path["filename"], "content": path["content"]} for path in example["paths"]]
        parameters, transform = example["parameters"], dict(example["transform"])
        sources = {key: f"the {args.example} example" for key in transform}
    else:
        paths, parameters, transform = [], [dict(row) for row in DEFAULT_FIT_PARAMETERS], {}
        if args.structure:
            paths, feff_kmax = _feff_paths(client, args, absorber)
            # Fit out to the farthest path asked for, not to the route's 3 A default.
            transform["rmax"] = max(3.0, args.path_radius)
            sources["rmax"] = "--path-radius"
        for key, value in (group or {}).items():
            transform[key], sources[key] = value, "the group's transform"
        if feff_kmax is not None and transform.get("kmax", 0) > feff_kmax:
            transform["kmax"], sources["kmax"] = feff_kmax, "the group's, cut to where FEFF stops"
    for name in args.path:
        try:
            with open(name, encoding="utf-8") as handle:
                paths.append({"filename": os.path.basename(name), "content": handle.read()})
        except OSError as exc:
            raise Failed(f"Could not read the FEFF path {name}: {exc}")
    if not paths:
        raise Failed("Give FEFF paths with --path feffNNNN.dat, a bundled structure with "
                     "--structure AMCSD_ID, or a bundled setup with --example cuprite.")
    for index, path in enumerate(paths, start=1):
        path["id"] = f"p{index}"
    by_name = {row["name"]: row for row in parameters}
    for text, kind in [(text, "guess") for text in args.param] + [(text, "set") for text in args.fix]:
        name, value = parse_option(text)
        if name not in by_name:
            raise Failed(f"No fit parameter {name!r}; the model has {', '.join(by_name)}.")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise Failed(f"{name} needs a number; got {value!r}.")
        by_name[name].update(value=float(value), kind=kind)
    for text in args.transform:
        name, value = parse_option(text)
        transform[name], sources[name] = _kweight(value) if name == "kweight" else value, "-t"
    return {"parameters": parameters, "paths": paths, "transform": transform}, sources


def _vary(texts: list[str], parameters: list[dict]) -> list[tuple[str, Any]]:
    """--vary kmax=14,16,18 as (key, value) pairs, one fit each."""
    names = {row["name"] for row in parameters}
    runs = []
    for text in texts:
        name, separator, values = text.partition("=")
        if not separator or not values:
            raise Failed(f"--vary looks like key=v1,v2,...; got {text!r}.")
        try:
            parsed = json.loads(f"[{values}]")
        except ValueError:
            parsed = values.split(",")
        if name not in names and name not in TRANSFORM_KEYS:
            raise Failed(f"--vary takes a transform key ({', '.join(TRANSFORM_KEYS)}) or a fit "
                         f"parameter to hold ({', '.join(sorted(names))}); got {name!r}.")
        runs += [(name, value) for value in parsed]
    return runs


TRANSFORM_KEYS = ("kmin", "kmax", "kweight", "dk", "rmin", "rmax", "fitspace", "window")


def _variant(body: dict, name: str, value) -> dict:
    changed = {**body, "transform": dict(body["transform"]),
               "parameters": [dict(row) for row in body["parameters"]]}
    if name in TRANSFORM_KEYS:
        changed["transform"][name] = _kweight(value) if name == "kweight" else value
    else:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise Failed(f"{name} needs numbers to be held at; got {value!r}.")
        row = next(row for row in changed["parameters"] if row["name"] == name)
        row.update(kind="set", value=float(value))
        row.pop("min", None), row.pop("max", None)
    return changed


def command_fit(client, args):
    ident = need_project(args)
    summary = client.get(f"/projects/{ident}", params={"view": "summary"})
    group_id = resolve_group(summary, args.group)
    if args.example and args.structure:
        raise Failed("Use --example or --structure, not both.")
    element = next(group["element"] for group in summary["groups"] if group["id"] == group_id)
    own = {} if args.example else _group_transform(client, ident, group_id)
    body, sources = _fit_body(client, args, element, own)
    body["version"] = summary["version"]
    route = f"/projects/{ident}/groups/{group_id}/fit"
    result = client.post(route, api="artemis", params={"view": "summary"}, json=body)
    result["transform_from"] = {key: sources.get(key, "the fit's default") for key in result["transform"]}
    if not args.vary:
        return result, render_fit(result)
    # Each variant is one fit from the same FEFF paths, so a range scan costs
    # one FEFF calculation rather than one per invocation.
    scan = [{"vary": "base", "value": None, "fit": result}]
    for name, value in _vary(args.vary, body["parameters"]):
        try:
            fitted = client.post(route, api="artemis", params={"view": "summary"},
                                 json=_variant(body, name, value))
        except Failed as exc:
            fitted = {"error": str(exc)}
        scan.append({"vary": name, "value": value, "fit": fitted})
    report = {"base": result, "scan": scan}
    return report, render_fit(result) + "\n\n" + render_scan(scan)


def render_fit(result: dict) -> str:
    stats, transform = result["statistics"], result["transform"]
    lines = [f"fit {result['group_label']}: {result['message']}",
             f"  r-factor {_number(stats.get('r_factor'), 4)}, reduced chi-square "
             f"{_number(stats.get('reduced_chi_square'), 1)}, {stats.get('n_varys')} variables "
             f"against {_number(stats.get('n_independent'), 1)} independent points",
             f"  k {transform['kmin']:g}-{transform['kmax']:g} (kweight "
             f"{','.join(map(str, transform['kweight']))}, dk {transform['dk']:g}), "
             f"R {transform['rmin']:g}-{transform['rmax']:g}, fit in {transform['fitspace']}"]
    if sources := result.get("transform_from"):
        by_source: dict[str, list[str]] = {}
        for key in ("kmin", "kmax", "dk", "kweight", "rmin", "rmax"):
            by_source.setdefault(sources.get(key, "the fit's default"), []).append(key)
        lines.append("  " + "; ".join(f"{', '.join(keys)} from {source}"
                                      for source, keys in by_source.items()))
    lines.append("")
    rows = [[row["name"], row["kind"], _number(row["value"], 4),
             "-" if row.get("stderr") is None else _number(row["stderr"], 4),
             _number(row["initial"], 4), "AT " + row["at_bound"].upper() if row.get("at_bound") else ""]
            for row in result["parameters"]]
    lines.append(_table(rows, ["PARAM", "KIND", "VALUE", "STDERR", "INITIAL", "BOUND"]))
    lines.append("")
    rows = [[path["label"][:20], path["scatterers"], _number(path.get("degen"), 0),
             _number(path.get("reff"), 4), _number(path.get("r"), 4),
             _number(path.get("sigma2"), 5), _number(path.get("s02"), 3)]
            for path in result["paths"]]
    lines.append(_table(rows, ["PATH", "SCATTERERS", "N", "REFF", "R", "SIGMA2", "S02"]))
    if correlations := result.get("correlations"):
        lines.append("  correlations: " + ", ".join(
            f"{row['left']}/{row['right']} {row['value']:+.2f}" for row in correlations[:6]))
    for warning in result.get("warnings") or ():
        lines.append(f"  WARNING: {warning}")
    for concern in result.get("concerns") or ():
        lines.append(f"  CONCERN: {concern}")
    lines.append(result["note"])
    return "\n".join(lines)


def render_scan(scan: list[dict]) -> str:
    """One row per variant: the first path's distance and disorder, and the fit's quality."""
    rows, distances = [], {}
    for entry in scan:
        fit = entry["fit"]
        label = "base" if entry["vary"] == "base" else f"{entry['vary']}={json.dumps(entry['value'])}"
        if "error" in fit:
            rows.append([label, "refused", "", "", "", "", fit["error"][:60]])
            continue
        first = fit["paths"][0] if fit.get("paths") else {}
        values = {row["name"]: row for row in fit["parameters"]}
        e0 = values.get("del_e0", {}).get("value", first.get("e0"))
        if first.get("r") is not None:
            distances.setdefault(entry["vary"], []).append(first["r"])
        count = len(fit.get("concerns") or ())
        rows.append([label, _number(first.get("r"), 4), _number(first.get("sigma2"), 5),
                     _number(first.get("s02"), 3), _number(e0, 2),
                     _number(fit["statistics"].get("r_factor"), 4),
                     f"{count} concern{'s' if count > 1 else ''}" if count else ""])
    first_path = next((entry["fit"]["paths"][0] for entry in scan if entry["fit"].get("paths")), {})
    lines = [f"scan, first path {first_path.get('label', '?')} ({first_path.get('scatterers', '?')}):",
             _table(rows, ["VARIANT", "R", "SIGMA2", "S02", "E0", "R-FACTOR", ""])]
    base = distances.pop("base", [])
    for key, values in distances.items():
        values = base + values
        lines.append(f"  varying {key}: r spans {min(values):.4f}-{max(values):.4f} "
                     f"({max(values) - min(values):.4f}) over {len(values)} fits, base included")
    if distances:
        lines.append("  A spread is how far that choice moves the distance, which the stderr of "
                     "any one fit leaves out. Weigh each row by its R-factor: a held parameter "
                     "that makes the fit worse is a bound on the error, not a second answer. "
                     "Run `fit` again without --vary for the concerns behind any row.")
    return "\n".join(lines)


def command_structures(client, args):
    found = client.get("/structures", api="artemis",
                       params={"q": " ".join(args.query), "element": args.element or "", "limit": args.limit})
    rows = [[str(row["id"]), (row.get("mineral") or "")[:24], row.get("formula") or "",
             row.get("space_group") or "", _number((row.get("cell") or {}).get("a"), 4),
             _measured(row.get("measured_at") or {}), str(row.get("year") or ""),
             " ".join((row.get("title") or "").split())[:60]] for row in found["results"]]
    text = _table(rows, ["AMCSD", "MINERAL", "FORMULA", "GROUP", "A", "MEASURED", "YEAR", "TITLE"])
    note = ("MEASURED is what the entry's title states; '-' means it states nothing, which "
            "usually but not always means room temperature and pressure.")
    return found, f"{text}\n{note}\n{found['source']}" if rows else f"No structure matches. {found['source']}"


def _measured(conditions: dict) -> str:
    """'577 K', '22 GPa 1400 K', '?' when the title gives two, '-' when it gives none."""
    parts = []
    if conditions.get("pressure_gpa") is not None:
        parts.append(f"{conditions['pressure_gpa']:g} GPa")
    if conditions.get("temperature_k") is not None:
        parts.append(f"{conditions['temperature_k']:g} K")
    return " ".join(parts) or ("?" if conditions.get("stated") else "-")


def command_export(client, args):
    """The one route that hands back arrays, written to a file rather than stdout.

    Every other subcommand exists to keep numbers out of a context window; this
    one exists because sometimes the numbers are the answer. Printing 29 KB of
    CSV would undo the rest of the tool by accident, so the default is a file
    and a line saying what went into it. `--out -` is how a caller asks for the
    body on stdout on purpose.
    """
    ident = need_project(args)
    summary = client.get(f"/projects/{ident}", params={"view": "summary"})
    group_id = resolve_group(summary, args.group)
    body = client.get(f"/projects/{ident}/groups/{group_id}/export",
                      params={"space": args.space}, raw=True)
    rows = [line for line in body.splitlines() if line]
    columns = rows[0].split(",") if rows else []
    report = {"project_id": ident, "group_id": group_id, "space": args.space,
              "columns": columns, "rows": max(len(rows) - 1, 0)}
    if args.out == "-":
        # Returned as a string rather than as the report, so that --json does
        # not answer an explicit request for the body with a description of it.
        return body, body
    destination = args.out or f"athena-{args.space}.csv"
    with open(destination, "w", encoding="utf-8", newline="") as handle:
        handle.write(body)
    report["path"] = destination
    return report, (f"wrote {destination}: {report['rows']} rows in "
                    f"{args.space}, columns {', '.join(columns)}")


def command_log(client, args):
    log = client.get(f"/projects/{need_project(args)}/transcript",
                     params={"limit": args.limit, "since": args.since})
    return log, render_log(log)


def command_describe(client, args):
    if not args.action:
        listing = client.get("/capabilities")
        return listing, render_capabilities(listing)
    action = client.get(f"/capabilities/{args.action}")
    return action, render_action(action)


def command_do(client, args):
    ident = need_project(args)
    summary = client.get(f"/projects/{ident}", params={"view": "summary"})
    body = {
        "version": summary["version"], "action": args.action,
        "group_ids": [resolve_group(summary, token) for token in args.groups],
        "options": dict(parse_option(text) for text in args.option),
    }
    for key in GROUP_OPTIONS:
        if isinstance(body["options"].get(key), str):
            body["options"][key] = resolve_group(summary, body["options"][key])
    # The server does the eliding. Doing it here instead meant receiving the
    # whole project after every command, 500 KB to 1 MB on the copper example,
    # in order to print a few lines about it.
    view = {"view": "full" if args.arrays else "summary"}
    if args.preview:
        described = client.get(f"/capabilities/{args.action}")
        if not (path := described.get("preview")):
            raise Failed(f"{args.action} has no preview endpoint. "
                         "Run it without --preview, or undo afterwards.")
        result = client.post(path.replace("/projects/{id}", f"/projects/{ident}"),
                             json=body, params=view)
        return result, render_preview(result)
    # A key makes the retry after a timeout safe: the backend answers from its
    # record rather than running the command a second time.
    headers = {"Idempotency-Key": args.key} if args.key else None
    try:
        result = client.post(f"/projects/{ident}/command", json=body,
                             headers=headers, params=view)
    except Failed as exc:
        raise _clarify(client, args.action, exc)
    return result, render_result(result, summary)


def _clarify(client, action: str, failure: Failed) -> Failed:
    """Say 'no such action' when that is the real problem.

    /command validates the selection before it looks the action up, so a
    misremembered name comes back as a complaint about groups. That sends a
    caller off correcting something that was never wrong.
    """
    try:
        known = {row["action"] for row in client.get("/capabilities")["actions"]}
    except Failed:
        return failure
    if action in known:
        return failure
    return Failed(f"There is no {action!r} action, which may be the real problem "
                  f"rather than: {failure}  Run `larchctl describe` for the list.")


COMMANDS = {
    "projects": command_projects, "new": command_new, "summary": command_summary,
    "params": command_params, "digest": command_digest, "compare": command_compare,
    "describe": command_describe,
    "do": command_do, "log": command_log, "export": command_export, "fit": command_fit,
    "structures": command_structures,
}


def _output_flags(parser, *, optional=False) -> None:
    """How the response is printed, accepted on either side of the subcommand."""
    default = {"default": argparse.SUPPRESS} if optional else {}
    parser.add_argument("--json", action="store_true", **default,
                        help="print the response as JSON instead of a table; "
                             "plotting arrays are still elided")
    parser.add_argument("--arrays", action="store_true", **default,
                        help="keep the plotting arrays a preview returns; "
                             "expect tens of thousands of numbers")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="larchctl", description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Start with `larchctl describe` to see what `larchctl do` accepts.")
    parser.add_argument("--base", default=BASE, help=f"backend URL (default {BASE})")
    parser.add_argument("--project", default=os.environ.get("LARCHCTL_PROJECT"),
                        help="project id; defaults to $LARCHCTL_PROJECT")
    _output_flags(parser)
    # The same two flags again, accepted after the subcommand as well as
    # before it, because `do merge ... --preview --json` is the order anyone
    # types and argparse would otherwise answer it with "unrecognized
    # arguments: --json". SUPPRESS is what keeps the trailing copy from
    # overwriting a leading one with its own default.
    trailing = argparse.ArgumentParser(add_help=False)
    _output_flags(trailing, optional=True)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=(
        lambda **kwargs: argparse.ArgumentParser(parents=[trailing], **kwargs)))

    sub.add_parser("projects", help="list projects")
    new = sub.add_parser("new", help="create a project")
    new.add_argument("--name")
    sub.add_parser("summary", help="the project without any arrays")
    sub.add_parser("params", help="every group's parameters, requested against used")

    digest = sub.add_parser("digest", help="describe one spectrum in numbers")
    digest.add_argument("group", help="group id, or part of its label")

    compared = sub.add_parser("compare", help="groups measured against the first, in numbers")
    compared.add_argument("groups", nargs="+", help="two or more groups; the first is the reference")

    describe = sub.add_parser("describe", help="what `do` accepts")
    describe.add_argument("action", nargs="?")

    export = sub.add_parser("export", help="one group's arrays, as a CSV file")
    export.add_argument("group", help="group id, or part of its label")
    export.add_argument("--space", choices=("E", "k", "R", "q"), default="E",
                        help="which axis to export (default E)")
    export.add_argument("--out", metavar="PATH",
                        help="file to write; '-' prints the CSV instead "
                             "(default athena-<space>.csv)")

    fit = sub.add_parser("fit", help="fit FEFF paths to one group with Artemis; nothing is saved")
    fit.add_argument("group", help="group id, or part of its label")
    fit.add_argument("--example", choices=("cuprite",),
                     help="start from a bundled setup: its paths, parameters and ranges")
    fit.add_argument("--structure", type=int, metavar="AMCSD_ID",
                     help="run FEFF on a bundled AMCSD structure and fit its paths; "
                          "find ids with `larchctl structures copper`")
    fit.add_argument("--site", type=int, help="absorber site in the structure (default: the first)")
    fit.add_argument("--path-radius", type=float, default=3.0, metavar="A",
                     help="longest path FEFF keeps, in angstrom (default 3.0: the first shell "
                          "of most solids); the fit's rmax follows it")
    fit.add_argument("--max-paths", type=int, default=24, help="fit at most this many FEFF paths")
    fit.add_argument("--path", action="append", default=[], metavar="FEFF.dat",
                     help="a FEFF path file to add; repeat for several")
    fit.add_argument("-p", "--param", action="append", default=[], metavar="NAME=VALUE",
                     help="start a guess parameter at VALUE. Without --example the model is "
                          "amp (S0^2, 1, 0-2), del_e0 (eV, 0, -30-30), del_r (A, 0, -0.2-0.2) and "
                          "sig2 (A^2, 0.008, 0-0.05), shared by every path")
    fit.add_argument("--fix", action="append", default=[], metavar="NAME=VALUE",
                     help="hold a parameter at VALUE instead of fitting it")
    fit.add_argument("-t", "--transform", action="append", default=[], metavar="KEY=VALUE",
                     help="kmin, kmax, kweight, dk, rmin, rmax, fitspace, window. Once the "
                          "group's kmax has been set, unset kmin, kmax and dk come from the group "
                          "(kmax cut to FEFF's 20); otherwise from the fit's defaults: k 3-12, kweight 0,1,2,3, dk 2, "
                          "R 1-3 (rmax follows --path-radius), fitspace r. kweight=2 or 1,2,3")
    fit.add_argument("--vary", action="append", default=[], metavar="KEY=V1,V2",
                     help="refit once per value, from the same FEFF paths, and tabulate how the "
                          "first path's distance moves: a transform key (kmax=14,16,18) or a "
                          "parameter to hold at each value (del_e0=3,6,9). Repeat for several")

    structures = sub.add_parser("structures", help="search the bundled crystal structures for `fit --structure`")
    structures.add_argument("query", nargs="*", help="mineral, formula or words from the title")
    structures.add_argument("--element", help="only structures containing this element")
    structures.add_argument("--limit", type=int, default=10)

    log = sub.add_parser("log", help="every command issued against this project")
    log.add_argument("--limit", type=int, default=20)
    log.add_argument("--since", type=int, default=0, metavar="SEQ",
                     help="only records after this seq")

    do = sub.add_parser("do", help="run one action")
    do.add_argument("action")
    do.add_argument("groups", nargs="*", help="group ids, or parts of their labels")
    do.add_argument("-o", "--option", action="append", default=[], metavar="KEY=VALUE")
    do.add_argument("--key", metavar="TOKEN",
                    help="idempotency key; a retry under the same key is answered, not rerun")
    do.add_argument("--preview", action="store_true",
                    help="use the action's preview endpoint and save nothing; a merge "
                         "prints as a table, others as JSON with their curves elided")
    return parser


def main(argv: list[str] | None = None, http=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        with Client(args.base, http=http) as client:
            payload, text = COMMANDS[args.command](client, args)
        # --json used to mean "the untouched response", which on a preview
        # meant every curve it wanted drawn: one `--json do align --preview`
        # came back at 170 KB against 1.5 KB for the same call without it. A
        # flag that multiplies a response by a hundred is the worst thing to
        # reach for by accident in a tool whose whole job is protecting a
        # context window, so the elision applies here too and --arrays is how
        # a caller asks for the numbers on purpose.
        if args.json and not isinstance(payload, str):
            print(json.dumps(payload if args.arrays else elide_arrays(payload), indent=1))
        else:
            print(text)  # a str payload is already the body the caller asked for
        return 0
    except Failed as exc:
        print(f"larchctl: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
