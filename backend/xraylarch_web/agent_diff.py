"""Two final projects against each other, with a tolerance per quantity.

The suite's state assertions say whether a run did the task. They do not say
whether two runs that both did it arrived at the same numbers, and that is
the question a regression run and the native-against-app comparison both
ask. The two arms run different Larch revisions, and a replay runs on later
code than the transcript it came from, so the comparison is per quantity
with a tolerance, the way the suite's answer assertions are written: an edge
step within 0.005, an energy within 0.1 eV, a k within 0.01 Å⁻¹. Arrays are
never compared; see `agent-interface-scope.md`, question 3.

Groups are matched by label, in order, so two groups called "merge" on each
side pair first with first. A group with no partner is a difference in its
own right. For each pair the summary's state and the effective parameters
are compared, and ids are compared through the labels they point at, since
ids differ between any two projects.

    python -m xraylarch_web.agent_suite diff run.json again.json

Each argument is a run file carrying a `final` snapshot, which `finish` and
`replay --out` write, or a project id on the backend, read live.
"""
from __future__ import annotations

from dataclasses import dataclass
from collections import Counter

EV, STEP, K = 0.1, 0.005, 0.01
TOLERANCES = {
    "e0": EV, "energy_shift": EV, "range": EV,
    "pre1": EV, "pre2": EV, "norm1": EV, "norm2": EV,
    "edge_step": STEP, "step": STEP, "fnorm_edge_step": STEP,
    "kmin": K, "kmax": K, "bkg_kmin": K, "bkg_kmax": K, "available_kmax": K,
    "background_standard_kmin": K, "background_standard_kmax": K,
    "rbkg": K, "rmin": K, "rmax": K, "rstep": 1e-6, "kstep": 1e-6,
}
# Summary fields that describe the group's state rather than its identity.
STATE = ("data_type", "is_normalized", "is_difference", "marked", "frozen",
         "element", "edge", "e0", "edge_step", "energy_shift", "range", "points",
         "processed", "exafs", "available_kmax")
# Effective parameters that repeat the summary, or hold ids.
SKIP = {"background_standard_id", "element", "edge", "data_type", "is_normalized",
        "edge_step", "available_kmax", "energy_shift"}


@dataclass
class Difference:
    label: str
    field: str
    a: object
    b: object
    tolerance: float | None = None


def snapshot(http, project_id: str) -> dict:
    """What `diff` compares: the summary and parameters views, as the arm read them."""
    base = f"/api/athena/projects/{project_id}"
    result = {}
    for view in ("summary", "parameters"):
        response = http.get(base, params={"view": view})
        response.raise_for_status()
        result[view] = response.json()
    return result


def _same(a, b, tolerance: float | None) -> bool:
    if tolerance is None or not isinstance(a, (int, float)) or not isinstance(b, (int, float)) \
            or isinstance(a, bool) or isinstance(b, bool):
        return a == b
    return abs(a - b) <= tolerance


def _labels(summary: dict) -> dict[str, tuple[str, int]]:
    counts = Counter()
    labels = {}
    for group in summary["groups"]:
        label = group["label"]
        counts[label] += 1
        labels[group["id"]] = (label, counts[label])
    return labels


def _by_label(group: dict, labels: dict[str, tuple[str, int]]) -> dict:
    """Replace ids with label and occurrence, preserving duplicate relationships."""
    state = {key: group.get(key) for key in STATE}
    state["reference"] = labels.get(group.get("reference_id"), group.get("reference_id"))
    state["background_standard"] = labels.get(group.get("background_standard_id"),
                                              group.get("background_standard_id"))
    derived = group.get("derived")
    state["derived"] = derived and {
        "operation": derived.get("operation"),
        "parents": [labels.get(gid, gid) for gid in derived.get("parents") or []],
        **({"array": derived.get("array"),
            "excluded": [labels.get(item.get("id"), item["label"])
                         for item in derived.get("excluded") or []]}
           if derived.get("operation") == "merge" else {}),
    }
    state["warnings"] = len(group.get("warnings") or [])
    return state


def _pairs(a: list[dict], b: list[dict]) -> list[tuple[str, dict | None, dict | None]]:
    """Match groups by label in order; a label with no partner pairs with None."""
    remaining = list(b)
    pairs = []
    for group in a:
        match = next((other for other in remaining if other["label"] == group["label"]), None)
        if match is not None:
            remaining.remove(match)
        pairs.append((group["label"], group, match))
    pairs.extend((group["label"], None, group) for group in remaining)
    return pairs


def _effective(parameters: dict) -> dict[str, dict]:
    return {group["id"]: group.get("effective") or {} for group in parameters["groups"]}


def compare(a: dict, b: dict) -> list[Difference]:
    """Every quantity on which two snapshots disagree beyond its tolerance."""
    differences = []
    labels_a, labels_b = _labels(a["summary"]), _labels(b["summary"])
    effective_a, effective_b = _effective(a["parameters"]), _effective(b["parameters"])
    counts_a, counts_b = len(a["summary"]["groups"]), len(b["summary"]["groups"])
    if counts_a != counts_b:
        differences.append(Difference("(project)", "groups", counts_a, counts_b))
    for label, group_a, group_b in _pairs(a["summary"]["groups"], b["summary"]["groups"]):
        if group_a is None or group_b is None:
            differences.append(Difference(label, "present", group_a is not None, group_b is not None))
            continue
        state_a, state_b = _by_label(group_a, labels_a), _by_label(group_b, labels_b)
        for field in state_a:
            tolerance = TOLERANCES.get(field)
            left, right = state_a[field], state_b[field]
            if field == "range" and left and right:
                if all(_same(x, y, tolerance) for x, y in zip(left, right)):
                    continue
            elif _same(left, right, tolerance):
                continue
            differences.append(Difference(label, field, left, right, tolerance))
        params_a = effective_a.get(group_a["id"], {})
        params_b = effective_b.get(group_b["id"], {})
        for field in sorted(set(params_a) | set(params_b)):
            if field in SKIP:
                continue
            tolerance = TOLERANCES.get(field)
            if not _same(params_a.get(field), params_b.get(field), tolerance):
                differences.append(Difference(label, field, params_a.get(field),
                                              params_b.get(field), tolerance))
    return differences


def _show(value) -> str:
    if isinstance(value, float):
        return f"{value:.4f}"
    if isinstance(value, list):
        return "[" + ", ".join(_show(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{key}: {_show(item)}" for key, item in value.items()) + "}"
    return str(value)


def render(differences: list[Difference]) -> str:
    if not differences:
        return "no differences beyond tolerance"
    lines = [f"{len(differences)} differences"]
    for item in differences:
        within = f"  (tolerance {item.tolerance})" if item.tolerance is not None else ""
        lines.append(f"  {item.label}  {item.field}: {_show(item.a)} -> {_show(item.b)}{within}")
    return "\n".join(lines)
