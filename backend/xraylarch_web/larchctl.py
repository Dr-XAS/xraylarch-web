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

    def request(self, method: str, path: str, *, raw=False, **kwargs) -> Any:
        import httpx
        try:
            response = self._http.request(method, f"/api/athena{path}", **kwargs)
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
    matches = [group for group in groups if folded in _fold(group["label"])]
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
            flags.append(f"{derived['operation']} of {len(derived['parents'])}")
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
    same = [f"same data: {' = '.join(labels)}" for labels in summary.get("same_data") or ()]
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
    lines.append(_table(rows, ["LABEL", "dE0", "SHIFT", "STEP/REF", "XANES", "COMMON",
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
    """A preview without its curves, which is the part a caller can act on."""
    return json.dumps(payload, indent=1)


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
            lines.append(f"      from {', '.join(_label(now, gid) for gid in derived['parents'])}")
        for left_out in derived.get("excluded") or ():
            lines.append(f"      EXCLUDED {left_out['label']}: {left_out['reason']}")
    for removed in sorted(was - set(now)):
        lines.append(f"  - {removed}")
    # A parameters command changes no group list, so without this the reply is
    # just the version, and whether Larch honoured the value takes another read.
    for group in project.get("applied") or ():
        values = "  ".join(f"{key} {_value(entry['requested'])}->{_value(entry['effective'])}"
                           for key, entry in group["values"].items())
        lines.append(f"  {group['label']}  {values}"
                     + (f"   ERROR: {group['processing_error']}" if group["processing_error"] else ""))
    if skipped := operation.get("skipped_group_ids"):
        lines.append(f"  skipped {len(skipped)}: {', '.join(skipped)}")
    for reason in operation.get("skipped_reasons") or ():
        lines.append(f"    {reason}")
    return "\n".join(lines)


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
    "do": command_do, "log": command_log, "export": command_export,
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
                    help="use the action's preview endpoint and save nothing; prints "
                         "the preview as JSON with its curves elided")
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
