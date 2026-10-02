# XAS spectrum processing (xraylarch-web)

A browser implementation of desktop Athena's XAS workflows, built on this checkout of the `xraylarch` scientific library. It exists so that Athena's multi-spectrum processing can run as a web service and hand results back to Dr.XAS, without a wxPython desktop install.

## Language

### Project and groups

**Project**:
The top-level container a user works in, holding an ordered list of groups plus the project name, version counter, journal, history, undo and redo stacks, and saved analyses. Its on-disk format is `athena-web`, and it is the web counterpart of a desktop Athena `.prj` file.
_Avoid_: session, document, workbook

**Group**:
One spectrum inside a project, carrying its own measured arrays, processing parameters, computed result and source record. Everything the user marks, freezes, plots, merges or exports is a group.
_Avoid_: dataset, spectrum record, data group, trace

**Mark**:
A per-group boolean saying the group is included in the next batch operation. Marks are independent of which group is currently highlighted, so a command can act on the marked set, the current group, or all groups.
_Avoid_: selected, checked, tagged

**Freeze**:
A per-group lock that rejects changes to that group's processing parameters, and to any group that depends on it as a linked reference or background standard. A frozen group can still be plotted, exported and deleted.
_Avoid_: locked, read-only, pinned

**Linked reference**:
A second group, usually a reference-foil channel measured simultaneously with the sample, tied to a sample group through `reference_id`. The pair shares one energy shift while each keeps its own E0.
_Avoid_: reference channel, tied group, paired group

**Background standard**:
A group whose processed, unweighted chi(k) is supplied to AUTOBK as the spline standard when another group's background is fitted. Stored on the dependent group as `background_standard_id`.
_Avoid_: spline standard, standard group

**Data type**:
What a group's y array physically is: `mu`, `xanes`, `norm`, `chi`, `xmudat` (a FEFF calculation) or `detector` (raw counts that get no normalization or EXAFS processing). It decides which processing steps and plot spaces are legal.
_Avoid_: kind, group type, datatype

**Edge identity**:
The element and absorption edge recorded as metadata on a group, with an `origin` of native, enforced, inferred or selected. It is descriptive metadata and is deliberately separate from the numeric E0 used in calculations.
_Avoid_: absorber, element/edge pair

**Import policy**:
An element, edge and fraction applied at import time to seed E0 from the tabulated edge energy and to resolve automatic normalization and spline defaults. It affects only groups being imported, never groups already in the project.
_Avoid_: edge policy, edge enforcement, absorber enforcement

**Importance**:
A per-group nonnegative weight used when merging groups, alongside the alternative weightings by measurement noise or edge step. Native Athena projects carry it, and merges honour it by default.
_Avoid_: weight, priority

**Analysis**:
A saved fit record from `/analyze`, such as a linear combination fit, a principal component analysis, a peak fit or a log-ratio result. Each one pins the group ids and the project version it was computed against, so it can be shown as stale once the project moves on.
_Avoid_: fit, result, report

### Processing

**Parameters**:
The validated set of numbers controlling one group's normalization, AUTOBK background, forward transform and reverse transform. Null-valued range and order fields mean "resolve automatically"; every other value is explicit and survives reprocessing.
_Avoid_: recipe, settings, config

**Effective parameters**:
The values actually used for a computed result, after automatic resolution and after Larch clipped ranges to the measured energy support. They are reported next to the requested parameters so a user can see what was chosen for them.
_Avoid_: resolved parameters, applied recipe

**E0**:
The absorption-edge energy for a group, on the energy axis after the energy shift is applied. It can be found by derivative, zero crossing, white line, tabulated atomic value, a fraction of the edge step, or entered by hand.
_Avoid_: edge energy, e_zero

**Edge step**:
The height of the absorption edge, the scalar that normalizes mu(E). It doubles as a merge weight and as the scale for artificial noise added during convolution.
_Avoid_: step, jump, edge jump

**Energy shift**:
A value added to a group's measured energy axis, produced by calibration against a known edge or by aligning to a standard. A linked sample and reference share one shift.
_Avoid_: eshift, offset, calibration offset

**Space**:
Which independent variable a curve is drawn or merged in: E for energy, k for photoelectron wavenumber, R after the forward transform, q after the back transform. "Plot space" and "merge space" are the same idea applied to display and to merging.
_Avoid_: domain, view, plot type

**Operation**:
One named transformation a command applies to selected groups, such as merge, sum, difference, align, calibrate, rebin, deglitch, truncate, smooth, convolve, deconvolve, self-absorption correction or multi-electron excitation removal. Every operation makes a new derived group and leaves its sources intact.
_Avoid_: action, tool, transform, processing step

### Native Athena fidelity

**Native**:
Belonging to desktop Athena or Demeter rather than to this web application. It qualifies file formats (a native `.prj`), numerical behavior being reproduced, and stored preferences imported from or exported to a desktop install.
_Avoid_: desktop, original, legacy, upstream Athena

**Oracle**:
The pinned Demeter source revision and Athena documentation that a module's behavior is copied from, named in the module docstring together with the exact Perl file. It is the authority a disagreement is settled against.
_Avoid_: source of truth, reference implementation

**Parity**:
Documented agreement between this implementation and the native one, tracked per feature with recorded evidence. Also the enum on integration envelopes, where a sealed import is `matched`, `mismatched` or `not_checked`.
_Avoid_: equivalence, fidelity, compatibility

**File plugin**:
An adapter for one beamline's file format, which recognizes a file, converts a copy of it into columns Larch can read, and suggests transmission or fluorescence channels. Each one corresponds to a registered Demeter `Plugins/*.pm`.
_Avoid_: reader, importer, parser, file adapter

**Plugin registry**:
The persisted set of which file plugins are enabled, which starts with everything unchecked and can be exchanged with a desktop `athena.plugin_registry` file. Separate from a plugin's own saved configuration.
_Avoid_: plugin settings, reader registry

**XDI**:
X-ray Data Interchange metadata, the standard header block of beamline and sample facts that travels with a spectrum. The application reads it as inert data, validates saved fields, and tracks how it is inherited by derived groups.
_Avoid_: header metadata, acquisition metadata

### Dr.XAS integration

**Draft**:
A server-side working session created when Dr.XAS hands over a spectrum, owning exactly one project and one group inside it, and moving through active, importing, sealed, discarded, expired or failed. Only a holder of the draft's capability may read or change it.
_Avoid_: session, handoff, integration workspace

**Launch envelope**:
The signed, hash-checked payload Dr.XAS sends to start a draft, carrying the artifact identity it came from, the provenance, the energy and mu arrays, and a portable processing recipe. It is valid for at most 300 seconds and is redeemed once through a launch handle.
_Avoid_: handoff payload, launch payload, bootstrap request

**Sealed import envelope**:
The frozen result sent back to Dr.XAS when a draft is sealed, repeating the source identity with the final spectrum, the final recipe, both digests and a parity status. Sealing ends the draft's editable life.
_Avoid_: export envelope, final payload

### Classic interface

**Workspace**:
The container used by the older single-spectrum interface at `/classic`, holding uploads and an append-only chain of revisions of one mapped spectrum. It is a separate lineage from a project and does not hold multiple groups.
_Avoid_: classic project, legacy project

## Relationships

- A **Group** belongs to exactly one **Project**, and group order is the file order it was imported in.
- A **Group** may point at one other group as its **Linked reference**. The link is stored one way, from sample to reference, but the **Energy shift** moves both ways.
- A **Group** may name another group as its **Background standard**, and that standard must already have a processed chi(k).
- An **Analysis** records the group ids and the project version it ran against, so it can be recognized as stale after later edits.
- A **Draft** owns exactly one **Project** and one **Group** in it, and permits only metadata, parameters, set_e0, undo, redo and export while active.
- A **Workspace** and a **Project** never mix. The classic interface creates workspaces, the Athena interface creates projects.

## Flagged ambiguities

- **Parameters** has three names. Athena groups use `AthenaParameters`, the classic interface uses `RecipeDraft` and `EffectiveRecipe`, and the Dr.XAS wire format uses `CoreProcessingRecipe`. They describe the same physics with different field spellings.
- **Workbench** names two different screens. `AthenaWorkbench` is the multi-group Athena interface at `/`, and `WorkbenchShell` is the single-spectrum classic interface at `/classic`.
- **File plugin** and **reader** are used interchangeably. Code says `FilePlugin`, `plugin_catalog` and `plugin_registry`, while the docs say "angle readers" and "scalar readers" and the import panel says "Configure reader".
- **Mark** is spelled three ways. The group field is `marked`, the command that changes it is `selection`, and the plot control says "All selected".
- **Project** and **Workspace** both mean the top container, and the integration route `GET /drafts/{id}/workspace` returns a project, not a classic workspace.
- A difference group is detected two ways, through the `is_difference` flag and through `source.operation == "difference"`, with the flag recomputed on load from the source record.

## Cross-repo vocabulary

Five repos share this domain: `Dr.XAS`, `DrXAS_Database`, `DrXASDemo`, `xraylarch-web`,
and `xray-sample-db`. The decisions in this section are binding across all five, so that
the same concept is not called two things depending on which repo you opened.

These are documentation decisions. None of them is an instruction to rename code. Where a
term crosses a service boundary it is marked frozen, which means the spelling is load
bearing and changing it is a code change with tests, not a glossary edit.

### Project names in prose

Write **Dr.XAS**, **Dr.XAS Database**, **Dr.XAS Demo**, **xraylarch-web**, **xray-sample-db**.
Directory and repository names keep their own spelling (`DrXAS_Database`, `DrXASDemo`).
_Avoid_: DrXAS Database, Dr.XAS_Database, DrXAS Demo, drxas-database

### Absorption edges

One concept, four sloppy spellings across the repos. The split below is the decision.

**Absorbing element**:
The one or two letter chemical symbol, `Fe`, `Pt`. Capitalised as in the periodic table.
_Avoid_: absorber, target element

**Absorption edge**:
The core-level code alone, uppercase, no suffix and no space: `K`, `L1`, `L2`, `L3`, `M5`.
_Avoid_: `K Edge`, `K edge`, `k-edge`, `K-edge` when a bare code is meant

**Element edge pair**:
XrayDB and Hephaestus style, the element, one space, then the edge code: `Fe K`, `Pt L3`.
This is the storage and interchange form. Anything crossing a repo boundary uses it.
_Avoid_: `Fe-K`, `FeK`, `Fe K-edge` as a stored value

**Edge label**:
The display string, and only ever the display string: `K-edge`, `L3-edge`.
_Avoid_: using a label where a code belongs

**Edge energy**:
The threshold energy in eV. A mapping such as `{'K': 7112}` is edge energy data. It is
never an edge code, and storing one in an edge column is a defect, not a spelling variant.

### Shared physics vocabulary

These mean the same thing in every repo that has them, and no repo may redefine them:
**Spectrum**, **Energy**, **Mu**, **Normalized mu**, **Edge step**, **Energy shift**,
**E0**, **Acquisition mode** (transmission, fluorescence, direct), **Detection mode**
(transmission, fluorescence, TEY, HERFD), **Normalization method** (`pre_edge`, `mback`,
both from Larch), **XANES**, **EXAFS**, **chi(k)**, **chi(R)**, **Scattering path**,
**Reference spectrum**, **Beamline**.

One warning that matters. In `ScholarMap`, an unrelated repo by the same author, a
"spectrum record" is a curve digitized out of a published figure, not an instrument
measurement. The two vocabularies must not be merged.

### Decisions that land in this repo

**Athena workbench** is the multi-group screen at `/`
(`frontend/components/athena-workbench.tsx`). **Classic workspace** is the single-spectrum
screen at `/classic` (`frontend/components/workbench-shell.tsx`). A bare "workbench" is
retired, because Dr.XAS has a **Guided workbench** that is a third, different thing.
_Avoid_: workbench (unqualified)

**Processing recipe** is the cross-repo concept for the normalization and background
parameters. This repo spells it three ways for three audiences and all three stay, because
two of them are load bearing: `AthenaParameters` for Athena groups, `RecipeDraft` and
`EffectiveRecipe` for the classic interface, and `CoreProcessingRecipe` on the Dr.XAS wire.
Field names differ too, `bkg_kmin` against `autobk.kmin`. Document the mapping, do not
unify the spellings.

**Mark** is the per-group flag. The field is `marked`, the command action is `selection`,
and the plot control says "All selected". Mark wins in prose.
_Avoid_: selection, checked groups

**File plugin** is the beamline format adapter. The docs' "angle readers" and "scalar
readers" and the UI's "Configure reader" are the same thing.
_Avoid_: reader

**Project** is the top container of ordered groups, the web equivalent of a `.prj`.
**Workspace** is the classic interface's single-spectrum container. These are different.
Note that `GET /drafts/{draft_id}/workspace` returns a project, which is a route naming
defect rather than a vocabulary question.

**Difference group** is detected two ways, through the `is_difference` flag and through
`source.operation == "difference"`. The source record is authoritative and the flag is a
cache of it.

**Operation** is one named group-producing transformation. The API calls the same things
`action` strings on a `Command` while `athena_operations.py` calls them `operation`.
Operation wins in prose.

### Frozen, do not rename

Everything in `backend/xraylarch_web/integration_contracts.py` is wire vocabulary matched
field for field against Dr.XAS, over `x-drxas-*` headers: **Draft**, **Launch envelope**,
**One-time launch handle**, **Sealed import envelope**, **Core processing recipe**,
**Parity status**, **Artifact source identity**, **Portable provenance**, **Authoritative
spectrum**, and the numerical tolerances.

The wavelet code in `backend/xraylarch_web/athena_wavelet.py` already states that it matches
Dr.XAS's `add_wavelet_payload` and its unwindowed Cauchy transform. That coupling is
deliberate and the naming follows Dr.XAS.

### Upstream terms are not ours to rename

**Group**, **E0**, **edge step**, **AUTOBK**, **rbkg**, `xftf` and `xftr`, **k-weight**, and
the array names `norm`, `flat`, `chir_mag`, `chiq_re` come from Larch. **Project**, **Mark**,
**Freeze**, **Linked reference**, **Background standard**, **Importance**, **Data type**,
and **File plugin** come from desktop Athena and Demeter. **Oracle**, **Parity**, **Import
policy**, and **Effective parameters** are this repo's own inventions and are the only ones
in that list it may redefine.
