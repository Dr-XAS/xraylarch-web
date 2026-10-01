"""What /command accepts, described so a caller can discover it at runtime.

The dispatcher in `Store.command` is a long chain of `elif action == ...`
branches, which is fine to execute and impossible to read as a menu. This module
is that menu. It is deliberately a hand-written table rather than anything
derived from the chain: the branch conditions encode which options are legal,
not what an operation is for, and only a person can write the latter.

What is NOT hand-written is the option list. Most actions validate their options
with a Pydantic model, so the fields are read back off that model on request and
cannot drift from what the endpoint will actually accept. Only the actions whose
options are picked apart inline with `options.get(...)` carry a written-out
table, and `test_agent_actions` pins those against the dispatcher's behaviour.

Two actions ask for their model lazily. Several option models live in modules
that `Store.command` itself imports inside the branch, to keep import time down
and to avoid cycles; resolving them eagerly here would undo that. So a model is
named as "module:Class" and imported only when someone asks for the detail.
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from types import UnionType
from typing import Annotated, Any, Literal, Union, get_args, get_origin

from pydantic_core import PydanticUndefined

# How many groups an action expects in `group_ids`. The dispatcher enforces
# these, sometimes several branches apart; naming them here is what lets a
# caller get the selection right on the first try instead of by probing.
SELECTIONS = {
    "none": "Send an empty group_ids; this acts on the project.",
    "one": "Exactly one group.",
    "two": "Exactly two groups, in order.",
    "one+": "One or more groups; the action applies to each.",
    "two+": "Two or more groups, combined into a new one.",
}


@dataclass(frozen=True)
class Action:
    """One /command action, as a caller needs to understand it."""
    summary: str
    selection: str
    model: str | None = None
    options: dict[str, str] = field(default_factory=dict)
    preview: str | None = None
    creates: bool = False
    note: str | None = None
    # Appended to a model-derived option line, for what the model cannot say:
    # chiefly that the dispatcher reads a field's presence, not its default.
    option_notes: dict[str, str] = field(default_factory=dict)


# Keep alphabetical. The parity test fails loudly on anything missing, but
# ordering is for the human maintaining it.
ACTIONS: dict[str, Action] = {
    "align": Action(
        "Shift energies so selected spectra line up with a standard.",
        "one+", model="athena_alignment:AlignmentOptions",
        preview="/projects/{id}/alignment/preview",
        note="The preview and the command take the same body; method defaults "
             "to 'demeter-larch' on both. Preview "
             "with operation='auto': that is the only operation that fits a "
             "shift, that accepts more than one group at a time, and that "
             "reports the shift each group would take without saving it. "
             "operation='inspect' does not fit anything — it reads back the "
             "shift a group already carries, which is 0 until an alignment "
             "has been saved — and it refuses a multi-group selection. Send "
             "the previewed body again to /command, which rejects "
             "operation='inspect' and takes 'auto' or 'manual'; 'manual' also "
             "needs an explicit energy_shift. A group linked to the same "
             "reference as the standard is in its family and stays fixed, so "
             "it is skipped, and if nothing is left the command is refused. "
             "Check reference_id in ?view=summary and unlink with "
             "assign_reference first. Alignment changes energy_shift and pins "
             "each moved group's E0 at the value it had before the shift, as "
             "native Athena does, so afterwards E0 reads about the shift away "
             "from the edge on the shifted axis and the edge step can move "
             "slightly. Send parameters with e0=null, or set_e0, afterwards if "
             "you want E0 found again on the shifted data.",
        option_notes={
            "operation": "'inspect' is only the preview's default: /command refuses it, so "
                         "send 'auto' on the preview and the command alike",
            "standard_id": "the group the others move to; it never moves itself, so leaving "
                           "it out of group_ids or putting it in comes to the same thing",
        },
    ),
    "background_standard": Action(
        "Link selected groups to a group used as their background standard.",
        "one+", options={"standard_id": "str | null — group id, or null to unlink."},
    ),
    "calibrate": Action(
        "Move a spectrum's energy axis so a chosen feature lands on a known energy.",
        "one", model="athena_calibration:CalibrationOptions",
        preview="/projects/{id}/calibration/preview",
        note="Requires coordinate='displayed' to take effect.",
    ),
    "change_datatype": Action(
        "Reinterpret what a group's values mean, e.g. mu(E) as already-normalized.",
        "one+", options={"data_type": "'mu' | 'xanes' | 'norm' — the new reading."},
        note="chi and detector are not reachable from here; the API rejects them.",
    ),
    "context_parameters": Action(
        "Copy or reset group metadata and parameters through the context menu's rules.",
        "one+", model="athena_context:ContextParameters",
    ),
    "convolve": Action(
        "Broaden a spectrum, or add noise to it, into a new group.",
        "one+", model="athena_convolution:ConvolutionOptions",
        preview="/projects/{id}/convolve/preview", creates=True,
    ),
    "copy_parameters": Action(
        "Copy processing parameters from one group onto the selected groups.",
        "one+",
        options={
            "source_id": "str — group to copy from. Required.",
            "section": "'all' | 'normalization' | 'background' | 'forward' | "
                       "'reverse' | 'grid' — which block to copy. Default 'all'.",
            "parameter": "str — a single parameter name, instead of a section.",
            "parameters": "list[str] — several parameter names, instead of a section.",
            "values": "object — overrides applied on top of the source's values.",
        },
        note="parameter, parameters and section are mutually exclusive. "
             "'all' deliberately omits energy_shift, which is per-spectrum. "
             "Frozen destinations are skipped, not failed.",
    ),
    "copy_series": Action(
        "Fan one group out into a series of copies stepping one parameter.",
        "one+", creates=True,
        options={
            "parameter": "'e0' | 'rbkg' | 'kmin' | 'kmax' | 'dk' | 'rmin' | "
                         "'rmax' | 'energy_shift' — the value to step.",
            "start": "float — first value. Required.",
            "stop": "float — last value. Required.",
            "count": "int 2..20 — how many copies. Default 3.",
        },
    ),
    "deconvolve": Action(
        "Sharpen a normalized spectrum by removing an instrumental broadening.",
        "one+", creates=True,
        options={
            "form": "str — lineshape of the broadening to remove.",
            "esigma": "float — width of that lineshape.",
            "width": "float — alternative width parameter.",
            "eshift": "float — energy offset applied first.",
            "smooth": "bool — smooth before deconvolving.",
            "sgwindow": "int — Savitzky-Golay window for that smoothing.",
            "sgorder": "int — Savitzky-Golay polynomial order.",
            "xmin": "float — restrict to energies at or above this.",
            "xmax": "float — restrict to energies at or below this.",
        },
        note="Normalize the group first; this reads its norm array, not mu.",
    ),
    "deglitch": Action(
        "Remove individual bad points from a spectrum.",
        "one+", model="athena_point_edit:PointEditOptions",
        preview="/projects/{id}/point-edit/preview",
        note="mode chooses how the points to remove are named, and each mode "
             "takes its own fields and no others: 'point' takes point=<energy>; "
             "'points' takes points=[<energy>, ...]; 'indices' takes "
             "indices=[<row number>, ...] into the measured rows; 'range' takes "
             "xmin and xmax and removes everything between them; 'margins' takes "
             "emin, emax and tolerance, where emin and emax are relative to E0 "
             "and both on the same side of it, and removes points lying further "
             "than tolerance from the fitted pre-edge or post-edge line; "
             "'inspect' removes nothing and just reports. mode defaults to "
             "'indices', 'points' or 'range' depending on which of those you "
             "send. 'truncate' and 'interval' belong to the truncate action and "
             "are rejected here. Energies are on the shifted axis. Fails if the "
             "chosen limits select nothing, or if fewer than ten points would "
             "remain, so preview first.",
    ),
    "delete": Action("Remove the selected groups from the project.", "one+",
        note="Groups that used a deleted group as their background standard "
             "keep their data but lose their result and must be reprocessed."),
    "difference": Action(
        "Subtract a standard from each selected group, as a new group.",
        "one+", model="athena_difference:DifferenceOptions",
        preview="/projects/{id}/difference/preview", creates=True,
        note="With no options beyond array and label this instead means "
             "'combine the selected groups by subtraction', which needs two or "
             "more groups. Send standard_id to get the standard-subtraction form.",
    ),
    "dispersive": Action(
        "Convert a dispersive-geometry pixel axis to energy.",
        "one+", creates=True,
        options={"offset": "float — constant term of the pixel-to-energy fit.",
                 "linear": "float — linear term.",
                 "quadratic": "float — quadratic term."},
        note="Ignores energy_shift, and resets the new group's parameters to "
             "defaults, because the axis it produces is a different axis.",
    ),
    "duplicate": Action("Copy the selected groups, unfrozen and untied.", "one+",
                        creates=True),
    "edge_identity": Action(
        "Declare which element and edge a group measures.",
        "one+", model="athena:EdgeIdentityOptions",
        note="Metadata only. It does not move E0; use set_e0 for that.",
    ),
    "example": Action(
        "Load the bundled three-temperature copper foil series.",
        "none", creates=True,
        note="Useful as a fixture: it gives a project real EXAFS with no upload.",
    ),
    "merge": Action(
        "Average the selected groups into one new group.",
        "two+", model="athena_merge:MergeOptions",
        preview="/projects/{id}/merge/preview", creates=True,
        note="Send method='demeter-larch'. The preview refuses a body without "
             "it, because without method /command takes an older plain average "
             "over the array option that excludes nothing and has no preview. "
             "array ('mu', 'norm' or 'chi') applies with method too. "
             "The merge is computed on the first selected group's grid, limited "
             "to the energy range every member covers, with that range's upper "
             "endpoint dropped; keeping a short scan in therefore cuts the merge "
             "down to the short scan's range. A merge of array='norm' is stored "
             "as data_type 'mu' with is_normalized false, and its edge step "
             "reads about 1. With "
             "method, exclude_short_data defaults to true: any group more than "
             "short_data_margin (10) points shorter than the first group "
             "selected is left out, and the command still succeeds. The new "
             "group's `derived` field in ?view=summary lists the parents it "
             "really used and each excluded group with its reason; check it "
             "rather than the selection you sent. To keep a short group, send "
             "exclude_short_data=false or select the shortest group first. "
             "derived.excluded is always present on a merge; empty means none. "
             "The preview under ?view=summary adds each output's `agreement`: "
             "the merge's scatter and each member's rms from it, as fractions "
             "of the merged curve's range, so a member that does not belong "
             "shows without a plot.",
        option_notes={"method": "send it: omitted, /command takes the plain average "
                                "and the preview refuses"},
    ),
    "metadata": Action(
        "Edit a group's label, notes, and presentation.",
        "one+",
        options={
            "label": "str — display name, truncated at 200 characters.",
            "notes": "str — free text, truncated at 20000 characters.",
            "marked": "bool — include in marked-group operations.",
            "frozen": "bool — protect from further processing changes.",
            "multiplier": "float — plot scale factor.",
            "offset": "float — plot vertical offset.",
            "importance": "float >= 0 — merge weight.",
            "reference_id": "str | null — tie to this group as its reference.",
        },
        note="Changing importance on a frozen group fails; unfreeze it first.",
    ),
    "multi_electron": Action(
        "Remove a multi-electron excitation feature, into a new group.",
        "one+", model="athena_mee:MEEOptions",
        preview="/projects/{id}/mee/preview", creates=True,
    ),
    "parameters": Action(
        "Set processing parameters on the selected groups.",
        "one+", model="athena_science:AthenaParameters",
        note="Send only the keys you want to change. This is the main way to "
             "drive normalization, background removal and the transforms. "
             "On a key whose type includes null, null hands the value back to "
             "Larch's automatic choice; kmax null, for instance, means kmax from "
             "the measured support. Keys without null in their type need a value. "
             "Larch may clip a requested range to the measured support. With "
             "?view=summary the reply's `last_operation.applied` lists, for each selected group "
             "and each key sent, the requested and the effective value.",
    ),
    "project": Action(
        "Rename the project or replace its journal.",
        "none",
        options={"name": "str — project name, truncated at 200 characters.",
                 "journal": "str — free text, truncated at 50000 characters."},
    ),
    "rebin": Action(
        "Resample onto Athena's standard pre-edge/XANES/EXAFS grid, as a new group.",
        "one+", model="athena_rebin:PostRebin",
        preview="/projects/{id}/rebin/preview", creates=True,
    ),
    "redo": Action("Reapply the last undone change.", "none",
                   note="project.can_redo says whether there is anything to redo."),
    "reorder": Action(
        "Set the display order of the project's groups.",
        "none",
        options={"ids": "list[str] — every group id, exactly once, in the new order."},
    ),
    "reset_parameters": Action(
        "Return processing parameters to their defaults.",
        "one+",
        options={
            "section": "'all' | 'normalization' | 'background' | 'forward' | "
                       "'reverse' | 'grid'. Default 'all'.",
            "parameter": "str — a single parameter name, instead of a section.",
            "parameters": "list[str] — several parameter names, instead of a section.",
        },
        note="Same selector rules as copy_parameters.",
    ),
    "selection": Action(
        "Mark or freeze the selected groups in bulk.",
        "one+",
        options={"field": "'marked' | 'frozen'. Default 'marked'.",
                 "mode": "'all' | 'none' | 'invert'. Default 'invert'."},
    ),
    "self_absorption": Action(
        "Correct a fluorescence spectrum for self-absorption, as a new group.",
        "one+", creates=True,
        options={
            "formula": "str — chemical formula of the sample.",
            "element": "str — absorbing element.",
            "edge": "str — absorption edge.",
            "line": "str — fluorescence line measured.",
            "angle_in": "float — incidence angle, degrees.",
            "angle_out": "float — detection angle, degrees.",
            "e0": "float — edge energy override.",
            "pre1": "float — pre-edge range start, relative to e0.",
            "pre2": "float — pre-edge range end.",
            "norm1": "float — normalization range start.",
            "norm2": "float — normalization range end.",
            "nnorm": "int — post-edge polynomial order.",
        },
    ),
    "set_e0": Action(
        "Find and set the edge energy by a named method.",
        "one+", model="athena:SetE0Options",
        note="Unlike the e0 processing parameter, this resolves a value now "
             "rather than storing a recipe. Groups it cannot solve are skipped "
             "and named in last_operation.skipped_group_ids.",
    ),
    "smooth": Action(
        "Smooth a spectrum into a new group.",
        "one+", model="athena_smoothing:SmoothOptions",
        preview="/projects/{id}/smooth/preview", creates=True,
        note="Send method to get the full smoothing pipeline. Without method "
             "this is the plain three-point form taking only window and order.",
        option_notes={"method": "omitted, /command takes the plain three-point "
                                "form and the preview refuses"},
    ),
    "sum": Action("Add the selected groups together into one new group.", "two+",
                  creates=True,
                  options={"array": "'mu' | 'norm' | 'chi' — which array to add.",
                           "label": "str — name for the result."}),
    "assign_reference": Action(
        "Point the selected groups at one shared reference spectrum.",
        "one+",
        options={"reference_id": "str | null — the reference group's id, or "
                                 "null to remove the selected groups' links."},
        note="Linked groups take energy shifts as one family: assigning adopts "
             "the reference's shift, and a later shift on any member moves them "
             "all. That is why align refuses to move a group that shares a "
             "reference with the standard. Removing a link keeps the current "
             "shift. The bundled example links its three Cu foil scans to "
             "'Cu foil · shared reference'; send reference_id=null on them "
             "before aligning one to another.",
    ),
    "tie_reference": Action(
        "Declare the second selected group the reference channel of the first.",
        "two",
        note="Order matters: sample first, reference second. Tied groups then "
             "take energy shifts together.",
    ),
    "truncate": Action(
        "Cut a spectrum down to an energy range.",
        "one+", model="athena_point_edit:PointEditOptions",
        preview="/projects/{id}/point-edit/preview",
        note="Two ways to cut; the other six mode values are deglitch's and "
             "are refused here. "
             "(1) mode='interval', the default when mode is omitted: send xmin, "
             "xmax or both, and every point with xmin <= E <= xmax is kept, both "
             "ends inclusive. A missing bound means the end of the data, and a "
             "bound outside the measured range is refused, so to cut only the "
             "top send only xmax. "
             "(2) mode='truncate': side='before' or 'after' and value=<energy>, "
             "snapping to the nearest measured point and reporting it as "
             "`snapped` in the preview. side='before' keeps that point and drops "
             "everything below; side='after' drops it along with everything "
             "above, so the surviving axis ends one grid step below `snapped`. "
             "Read the preview's last kept energy, not `snapped`, for the new "
             "endpoint. "
             "Send one mode's fields and nothing from the other. Energies are on "
             "the shifted axis, and at least ten points must survive. To merge "
             "scans of different lengths there is no need to cut first: the "
             "merge already restricts itself to the range every member covers.",
    ),
    "undo": Action("Revert the last change.", "none",
                   note="project.can_undo says whether there is anything to undo."),
    "untie_reference": Action(
        "Break the reference link on the selected groups.", "one+",
        note="Clears each selected group's own link and every link that "
             "points at a selected group. Shifts are kept.",
    ),
    "xdi_comments": Action(
        "Replace the XDI comment block on one group.",
        "one", model="athena_xdi_controls:XDIComments",
    ),
}

# /analyze takes an action too, on its own route and with its own set. Naming it
# here keeps a caller from concluding those four do not exist because /command
# rejects them.
ANALYSES = {
    "lcf": "Linear combination fit of one spectrum against standards.",
    "pca": "Principal component analysis over the selected spectra.",
    "peaks": "Peak fitting over one spectrum.",
    "log_ratio": "Log-ratio / phase-difference analysis of two spectra.",
}


def _type_name(annotation: Any) -> str:
    """A short, readable name for a Pydantic field's annotation.

    Pydantic keeps the Annotated wrappers that carry its constraints, so the raw
    repr of something like dict[str, Weight] spills validator internals into the
    caller's face. Unwrap to the part that describes the shape.
    """
    origin = get_origin(annotation)
    if origin is Annotated:
        return _type_name(get_args(annotation)[0])
    if origin is Literal:
        return " | ".join(repr(value) for value in get_args(annotation))
    if origin in (Union, UnionType):
        inner = [a for a in get_args(annotation) if a is not type(None)]
        name = " | ".join(_type_name(a) for a in inner)
        return f"{name} | null" if len(inner) != len(get_args(annotation)) else name
    if origin is not None:
        name = getattr(origin, "__name__", str(origin))
        return f"{name}[{', '.join(_type_name(a) for a in get_args(annotation))}]"
    return getattr(annotation, "__name__", str(annotation))


def _default_note(info) -> str | None:
    """How to describe a field's default, or nothing if it has none worth saying."""
    if info.is_required():
        return "required"
    default = info.get_default(call_default_factory=True)
    if default is None or default is PydanticUndefined:
        return None
    # A model-valued default renders as a repr nobody can use. Say it is optional
    # and let the caller read that nested model's own entry if they need it.
    return f"default {default!r}" if isinstance(
        default, (str, int, float, bool, list, tuple, dict)) else "optional"


def _model_options(reference: str) -> dict[str, str]:
    """Read one option table straight off the model that validates it."""
    module_name, class_name = reference.split(":")
    model = getattr(importlib.import_module(f".{module_name}", __package__), class_name)
    options = {}
    for name, info in model.model_fields.items():
        notes = [note for note in (_default_note(info),) if note]
        # Constraints live on the field's metadata objects; render the common
        # numeric ones, which are the ones a caller actually trips over.
        for item in info.metadata:
            for bound in ("gt", "ge", "lt", "le", "min_length", "max_length"):
                if (value := getattr(item, bound, None)) is not None:
                    notes.append(f"{bound} {value}")
        if info.description:
            notes.append(info.description)
        options[name] = " \u2014 ".join([_type_name(info.annotation), ", ".join(notes)]) if notes \
            else _type_name(info.annotation)
    return options


def index() -> dict:
    """Every action in one line each, cheap enough to read before deciding."""
    return {
        "post": "/api/athena/projects/{id}/command",
        "body": {"version": "int — the project's current version; a stale one is "
                            "rejected with 409 and the current version in the error.",
                 "action": "str — one of the actions below.",
                 "group_ids": "list[str] — see each action's selection.",
                 "options": "object — see /capabilities/{action}."},
        "query": {"view": "'summary' — reply with the project summary and "
                           "last_operation instead of the full project, which "
                           "runs to about 1 MB after a merge. The default, "
                           "'full', is the browser's reply."},
        "detail": "/api/athena/capabilities/{action}",
        "selections": SELECTIONS,
        "actions": [
            {"action": name, "summary": entry.summary, "selection": entry.selection,
             "creates_groups": entry.creates, "has_preview": entry.preview is not None}
            for name, entry in sorted(ACTIONS.items())
        ],
        "analyses": {"post": "/api/athena/projects/{id}/analyze", "actions": ANALYSES},
        # The reads that answer most questions without arrays; none costs a version.
        "reads": {
            "/api/athena/projects/{id}?view=summary": "every group, no arrays",
            "/api/athena/projects/{id}?view=parameters": "each recipe, requested against effective",
            "/api/athena/projects/{id}/groups/{gid}/digest": "one spectrum in numbers",
            "/api/athena/projects/{id}/compare?groups={gid},{gid}": "groups against the first",
            "/api/athena/projects/{id}/transcript?since={seq}": "commands and previews tried so far",
            "/api/athena/projects/{id}/groups/{gid}/export?space=E|k|R|q": "arrays, as a file",
            # Distances need a fit; these are the Artemis routes one takes.
            "/api/artemis/projects/{id}/groups/{gid}/fit?view=summary":
                "POST FEFF paths and guesses; fitted distances and sigma2, no curves",
            "/api/artemis/examples/cuprite": "a complete Cu2O fit setup to POST to fit",
            "/api/artemis/structures?q={text}&element={el}": "bundled crystal structures",
            "/api/artemis/feff/jobs": "POST {amcsd_id, absorber, site_index}; poll for FEFF paths",
            "/api/artemis/capabilities": "the fit and FEFF bodies, with their defaults",
        },
    }


def detail(name: str) -> dict | None:
    """One action in full, including the options its validator will accept."""
    entry = ACTIONS.get(name)
    if entry is None:
        return None
    options = _model_options(entry.model) if entry.model else dict(entry.options)
    for key, extra in entry.option_notes.items():
        options[key] = f"{options[key]} — {extra}"
    result = {
        "action": name, "summary": entry.summary,
        "selection": entry.selection,
        "selection_meaning": SELECTIONS[entry.selection],
        "creates_groups": entry.creates,
        "options": options,
    }
    if entry.model:
        result["options_source"] = (
            f"Read from {entry.model.replace(':', '.')}; unlisted keys are rejected.")
    if entry.preview:
        result["preview"] = entry.preview
        result["preview_note"] = (
            "Same body as /command. It reports what would happen without saving, "
            "and does not consume the version. Add ?view=summary to leave out "
            "the plotting curves, 120-220 KB of them on the copper example.")
    if entry.note:
        result["note"] = entry.note
    return result
