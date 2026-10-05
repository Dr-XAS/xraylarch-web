"""Compare saved native/app numerical evidence without grading final prose."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

TASKS = ("T1", "T2", "T3", "T4", "T5")
FOILS = ("Cu foil · 10 K", "Cu foil · 50 K", "Cu foil · 300 K")


def number(value):
    return value if type(value) in (float, int) and math.isfinite(value) else None


def comparison(field, native, app, tolerance, *, kind="measurement", evidence=None):
    left, right = number(native), number(app)
    delta = right - left if left is not None and right is not None else None
    status = "unknown" if delta is None else "equivalent" if abs(delta) <= tolerance else "different"
    return {"field": field, "kind": kind, "native": left, "app": right,
            "app_minus_native": delta, "absolute_tolerance": tolerance,
            "status": status, "evidence": evidence or {}}


class Reader:
    def __init__(self, root):
        self.root = root
        self.warnings = []

    def directory(self, name):
        candidates = sorted(p for p in self.root.rglob(name) if p.is_dir())
        if len(candidates) != 1:
            self.warnings.append({"directory": name, "reason": "missing" if not candidates else "ambiguous",
                                  "candidates": [str(p) for p in candidates]})
            return None
        return candidates[0]

    def json(self, directory, name, default=None):
        if directory is None:
            return default
        path = directory / name
        if not path.is_file():
            self.warnings.append({"file": str(path), "reason": "missing"})
            return default
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            self.warnings.append({"file": str(path), "reason": type(exc).__name__})
            return default

    def events(self, directory):
        if directory is None:
            return []
        path = directory / "events.jsonl"
        if not path.is_file():
            self.warnings.append({"file": str(path), "reason": "missing"})
            return []
        events = []
        for index, line in enumerate(path.read_text().splitlines(), 1):
            try:
                event = json.loads(line)
                if isinstance(event, dict):
                    events.append(event)
            except ValueError:
                self.warnings.append({"file": str(path), "line": index, "reason": "invalid JSON"})
        return events


def successful(output):
    return (isinstance(output, dict) and output.get("success") is not False
            and not output.get("error") and "raw_output" not in output)


def native_tool_results(events):
    calls = {event["seq"]: event for event in events if event.get("kind") == "tool_call"}
    for event in events:
        output = event.get("output")
        if event.get("kind") == "tool_result" and successful(output):
            yield event, calls.get(event.get("call_seq"), {}).get("arguments") or {}, output


def http_results(events):
    request = None
    for event in events:
        if event.get("kind") == "http_request":
            request = event
        elif event.get("kind") == "http_result":
            output = event.get("output") or {}
            body = output.get("body")
            status = event.get("status", output.get("status"))
            if request and isinstance(status, int) and 200 <= status < 300 and successful(body):
                yield event, request, body
            request = None


def original_map(science):
    return {row["label"]: row for row in (science or {}).get("originals", []) if row.get("label")}


def group_map(summary):
    return {row["label"]: row for row in (summary or {}).get("groups", []) if row.get("label")}


def edge_spread(rows):
    values = [number((rows.get(label) or {}).get("edge_step")) for label in FOILS]
    return max(values) - min(values) if all(value is not None for value in values) else None


def labels_for_native(science, events):
    labels = {row["xas_ref"]: row["label"] for row in (science or {}).get("originals", [])
              if row.get("xas_ref") and row.get("label")}
    for _event, arguments, output in native_tool_results(events):
        source = arguments.get("xas_ref")
        if source in labels and output.get("xas_ref"):
            labels[output["xas_ref"]] = labels[source]
    return labels


def native_first_fit(science, events):
    """Choose chronological first qualifying fit, never the closest later fit."""
    labels = labels_for_native(science, events)
    for event, arguments, output in native_tool_results(events):
        if event.get("tool") not in {"fit_ffef_first_shell", "robust_first_shell_fit"}:
            continue
        label = labels.get(arguments.get("xas_ref") or output.get("xas_ref"))
        if label != FOILS[0]:
            continue
        if arguments.get("absorber") not in {None, "Cu"}:
            continue
        # The paired protocol confines structure resolution to the copper fixture.
        # Native Report does not expose a scatterer-species field. Preserve that
        # distinction rather than inventing Cu-Cu metadata in the result.
        for path in output.get("path_parameter") or []:
            if number(path.get("R")) is None or number(path.get("n_feff")) != 12:
                continue
            statistics = output.get("fitted_parameter")
            if not isinstance(statistics, dict):
                continue
            transform = {key: statistics.get(key) for key in ("kmin", "kmax", "rmin", "rmax")}
            for key in ("kweight", "dk", "auto_select_window", "fix_s02"):
                transform[key] = arguments.get(key)
            selection = output.get("window_selection") or {}
            transform.update(selection.get("transform") or {})
            return {"source_label": label, "seq": event.get("seq"), "r": path["R"],
                    "stderr": number(path.get("deltar_err")), "degeneracy": path["n_feff"],
                    "scatterers": None, "species_provenance": "protocol copper fixture",
                    "material_id": arguments.get("material_id"), "absorber_requested": arguments.get("absorber"),
                    "sigma2": number(path.get("sigma2")), "rfactor": number(statistics.get("rfactor")),
                    "transform": transform, "explicit_transform_arguments": {
                        key: arguments[key] for key in ("kmin", "kmax", "kweight", "dk", "rmin", "rmax",
                                                        "auto_select_window", "fix_s02") if key in arguments},
                    "requested_parameters": arguments.get("params"), "constraints": arguments.get("constraints"),
                    "defs": arguments.get("defs"), "fitted_parameters": statistics, "path": path,
                    "diagnostics": output.get("diagnostics"), "governance": output.get("governance"),
                    "stability_verdict": output.get("stability_verdict"), "window_selection": selection}
    return None


def app_first_fit(events):
    for event, request, output in http_results(events):
        if not urlsplit(request.get("path", "")).path.endswith("/fit") or output.get("success") is not True:
            continue
        if output.get("group_label") != FOILS[0]:
            continue
        for path in output.get("paths") or []:
            if (number(path.get("r")) is None or number(path.get("degen")) != 12
                    or path.get("scatterers") != "Cu-Cu"):
                continue
            parameters = output.get("parameters") or []
            delta_r = next((param for param in parameters if param.get("name") in {"del_r", "deltar"}), {})
            statistics = output.get("statistics") or {}
            body = request.get("body") or {}
            return {"source_label": output["group_label"], "seq": event.get("seq"), "r": path["r"],
                    "stderr": number(delta_r.get("stderr")), "degeneracy": path["degen"],
                    "scatterers": path["scatterers"], "sigma2": number(path.get("sigma2")),
                    "rfactor": number(statistics.get("r_factor")), "transform": output.get("transform"),
                    "requested_transform": body.get("transform"), "requested_parameters": body.get("parameters"),
                    "requested_paths": body.get("paths"), "fitted_parameters": parameters,
                    "statistics": statistics, "correlations": output.get("correlations"),
                    "concerns": output.get("concerns"), "warnings": output.get("warnings"), "path": path}
    return None


def fit_catalog(science, native_events, app_events):
    return {"selection": "first chronological successful 10 K fit with twelve neighbours; native species uses protocol fixture",
            "native_first": native_first_fit(science, native_events), "app_first": app_first_fit(app_events),
            "native_reported_fits": (science or {}).get("fits", []),
            "app_reported_fits": [{"seq": event.get("seq"), "request": request.get("body"), "result": output}
                                  for event, request, output in http_results(app_events)
                                  if urlsplit(request.get("path", "")).path.endswith("/fit")]}


def native_transform(science):
    rows = [row for row in (science or {}).get("transforms", []) if row.get("source_label") == FOILS[0]]
    return rows[-1] if rows else None


def app_transform(snapshot, events):
    summary = snapshot.get("summary") or {}
    ten = group_map(summary).get(FOILS[0]) or {}
    parameters = snapshot.get("parameters") or {}
    param = next((row for row in parameters.get("groups", []) if row.get("id") == ten.get("id")), {})
    effective = param.get("effective") or {}
    requested = param.get("requested") or param.get("parameters") or {}
    result = {"source_label": FOILS[0], "kmin": number(effective.get("kmin")),
              "kmax": number(effective.get("kmax")), "r_peak": None,
              "effective": effective, "requested": requested, "peak_seq": None,
              "peak_definition": "strongest reported local maximum of phase-uncorrected |chi(R)|"}
    for event, request, output in http_results(events):
        if not urlsplit(request.get("path", "")).path.endswith("/digest"):
            continue
        group = output.get("group") or {}
        if group.get("label") != FOILS[0] or group.get("id") != ten.get("id"):
            continue
        digest_transform = output.get("transform") or {}
        used = {key: (digest_transform.get(key) or {}).get("used") for key in ("kmin", "kmax", "kweight", "dk", "window")}
        if not effective or any(used[key] != effective.get(key) for key in used if key in effective):
            continue
        peaks = output.get("chir_peaks") or []
        if peaks:
            result.update(r_peak=number(peaks[0].get("r")), peak_seq=event.get("seq"), reported_peaks=peaks)
    return result


def app_merges(snapshot):
    groups = (snapshot.get("summary") or {}).get("groups", [])
    labels = {group.get("id"): group.get("label") for group in groups}
    return [{"label": group.get("label"), "energy_min": (group.get("range") or [None, None])[0],
             "energy_max": (group.get("range") or [None, None])[-1],
             "parents": (group.get("derived") or {}).get("parents"),
             "source_labels": [labels.get(parent) for parent in (group.get("derived") or {}).get("parents", [])],
             "derived": group.get("derived"), "processing_error": group.get("processing_error")}
            for group in groups if (group.get("derived") or {}).get("operation") == "merge"]


def compare_task(task, science, initial, snapshot, native_events, app_events):
    rows = []
    native_originals, app_originals = original_map(science), group_map(initial)
    details = {"initial_edge_step_spread": {
        "native": edge_spread(native_originals), "app": edge_spread(app_originals)}}
    if task == "T1":
        for label in FOILS:
            for field, tolerance in (("e0", 0.1), ("edge_step", 0.005)):
                rows.append(comparison(label + "." + field,
                    (native_originals.get(label) or {}).get(field), (app_originals.get(label) or {}).get(field), tolerance))
    elif task == "T2":
        app_final = group_map(snapshot.get("summary"))
        alignments = (science or {}).get("alignments", [])
        details["native_alignments"] = alignments
        for label in FOILS[1:]:
            native = next((row for row in reversed(alignments) if row.get("source_label") == label
                           and row.get("reference_label") == FOILS[0]), None)
            before = number((app_originals.get(label) or {}).get("energy_shift"))
            after = number((app_final.get(label) or {}).get("energy_shift"))
            shift = after - before if before is not None and after is not None else None
            rows.append(comparison(label + ".alignment_shift_ev",
                (native or {}).get("energy_shift_ev"), shift, 0.1,
                evidence={"native_seq": (native or {}).get("seq"), "app": "final minus initial energy_shift"}))
        rows.append(comparison("original_edge_step_spread", edge_spread(native_originals), edge_spread(app_originals), 0.005))
        details["native_merges"] = (science or {}).get("merges", [])
        details["app_merges"] = app_merges(snapshot)
    elif task == "T3":
        native, app = native_transform(science), app_transform(snapshot, app_events)
        details.update(native_transform=native, app_transform=app,
                       native_peak_definition="global maximum of phase-uncorrected |chi(R)| returned by native Fourier tool",
                       interpretation="kmin must remain 3; kmax choices may differ while both satisfy the task. Numerical comparison does not grade prose.")
        invariant = comparison("10 K.kmin", (native or {}).get("kmin"), app.get("kmin"), 1e-6,
                               kind="invariant", evidence={"native_seq": (native or {}).get("seq")})
        invariant["expected_unchanged_kmin"] = 3.0
        rows.append(invariant)
        for field in ("kmax", "r_peak"):
            rows.append(comparison("10 K." + field, (native or {}).get(field), app.get(field), 0.1,
                                   kind="choice_comparison", evidence={"native_seq": (native or {}).get("seq"),
                                       "app_peak_seq": app.get("peak_seq")}))
    elif task == "T4":
        native_merges, merged = (science or {}).get("merges", []), app_merges(snapshot)
        native, app = (native_merges[-1] if native_merges else None), (merged[-1] if merged else None)
        details.update(native_merges=native_merges, app_merges=merged)
        rows.append(comparison("merged_energy_max_ev", (native or {}).get("energy_max"),
                               (app or {}).get("energy_max") if not (app or {}).get("processing_error") else None, 15.0))
    else:
        details["fits"] = fit_catalog(science, native_events, app_events)
        native, app = details["fits"]["native_first"], details["fits"]["app_first"]
        rows.append(comparison("first_10K_12_neighbour_fit_r_angstrom", (native or {}).get("r"),
                               (app or {}).get("r"), 0.02,
                               evidence={"native_seq": (native or {}).get("seq"), "app_seq": (app or {}).get("seq")}))
    statuses = [row["status"] for row in rows]
    status = "unknown" if not statuses or "unknown" in statuses else "different" if "different" in statuses else "equivalent"
    return {"task": task, "numerical_status": status, "comparisons": rows, "details": details,
            "answer_grade": None, "state_grade": "separate coordinator assertions"}


def compare_runs(root):
    reader = Reader(root)
    tasks = {}
    for task in TASKS:
        native_dir = reader.directory("native-" + task)
        app_dir = reader.directory("app-" + task)
        runtime = reader.directory("app-" + task + "-runtime")
        science = reader.json(native_dir, "science.json", {})
        initial = reader.json(runtime, "initial-summary.json", {})
        runtime_run = reader.json(runtime, "run.json", {})
        result = compare_task(task, science, initial, (runtime_run or {}).get("final") or {},
                              reader.events(native_dir), reader.events(app_dir))
        result["sources"] = {"native": str(native_dir) if native_dir else None,
                              "app": str(app_dir) if app_dir else None,
                              "app_runtime": str(runtime) if runtime else None}
        tasks[task] = result
    return {"schema_version": 1, "runs_root": str(root), "tasks": tasks, "warnings": reader.warnings,
            "policy": {"missing_data": "unknown; never equivalent", "fit_selection": "first chronological qualifying fit",
                       "answer_grading": "not performed", "state_grading": "not performed"}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    result = compare_runs(args.runs.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({task: result["tasks"][task]["numerical_status"] for task in TASKS}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
