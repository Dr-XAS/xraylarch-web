# Athena post-import rebinning and saved grid defaults

Reference revision: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.
This is evidence for the implemented portions of **PR-06**, **IM-07** and
**UI-11**, not a certificate of complete desktop equivalence.

## Primary-source contract

The [Athena rebin manual](https://bruceravel.github.io/demeter/documents/Athena/process/rebin.html)
describes energy and k previews, creation from the current group or marked
groups, and the same three-region algorithm used at import. The pinned
`documentation/Athena/process/rebin.rst` and implementation sources are recorded
with hashes in [the source manifest](athena-primary-sources.json).

- `lib/Demeter/UI/Athena/Rebin.pm` constructs the five region/grid controls,
  displays the current group's E0, and exposes E/k preview and current/marked
  creation. `push_values` disables the panel for chi or already-rebinned data;
  its `mode` handler does not reject frozen read-only sources. Preview passes
  the same region values to `Data::Process::rebin` as creation.
- `lib/Demeter/Data/Process.pm`, `rebin`, defines scalar energy/k grid stepping,
  PDL boxcar averaging, endpoint removal, clone creation, resetting child E0,
  resolving defaults, retaining type/pre-edge limits, and zeroing child shift.
  The detailed numerical contract and independent grid/covariance oracles are
  in [the import rebin reference](athena-import-rebin-reference.md).
- `lib/Demeter/UI/Athena/IO.pm` restores `rebin_*` fields from
  `athena.column_selection`, falling back to runtime/user and system defaults.
  It also restores `do_rebin` for identical column labels and resets it for a
  different layout; accepted imports save these choices. This is distinct from
  saving personal configuration defaults through the Preferences UI.
- `lib/Demeter/UI/Athena/Prefs.pm` distinguishes applying a runtime preference
  from applying and saving an INI preference. `process.demeter_conf` supplies
  the default grid and width. The web buttons provide an explicit saved-default
  lifecycle for these six fields. The separate
  [remembered-column implementation](athena-column-memory-reference.md) restores
  supported import choices; neither feature is a full INI editor.
- `lib/Demeter/UI/Athena.pm` implements `Wx::CheckListBox::AddData` and
  `InsertData`. **They differ:** AddData applies the cloned object's marked
  flag, while InsertData does not explicitly check the new item. `Demeter.pm`
  clones the object's attributes, including marked. Thus blanket claims that
  every native rebinned group starts unchecked are incorrect.

## Current scientific and transaction behavior

`AthenaStore._rebin_results` is shared by the read-only
`POST /api/athena/projects/{id}/rebin/preview` and the `rebin` command. It uses
the same `RebinPlan` as import, rather than the earlier command's `rebin_xafs`
implementation. The older lower-level `transform_spectrum('rebin')` helper
still exists and has its own tests; those are not evidence for this workflow.

The grid uses saved explicit/effective E0; the web dialog displays that value
and requires inspector edits to be applied first. The API additionally accepts
an explicit grid E0. Source energies are calibrated exactly once before grid
construction **and interpolation**. This corrects a mismatch in the pinned
native procedure: its endpoint grid adds `bkg_eshift` while the source energies
placed into the interpolation array are unshifted. Tests cover positive, zero
and negative shifts rather than claiming equality with that native bug.

Each child receives the accepted source processing parameters, with
`energy_shift=0` and automatic new absorption E0. A signed difference retains
its explicit edge anchor. The copied background standard remains a dependency;
creating the child leaves the standard and original group unchanged. E previews
show calibrated mu; k previews show the real Larch weighted-chi arrays for both
source and child. Failed background/FFT processing is reported explicitly,
while energy preview and retaining the rebinned data remain available.

The child retains type/identity, notes and display multiplier/offset. Source
provenance records parent parameters and shift. Original energy/mu, source
columns, detector readings, ordering and uncertainty are retained; resampled
detector and uncertainty arrays use the import plan. Original and resampled
arrays count toward the normal exchange budget. A new child is not attached to
its parent's reference family. Existing reference groups and links are untouched.

Selected sources are processed in project list order. New groups follow their
sources and currently start unmarked and unfrozen. Current chi/already-rebinned
sources are rejected; the marked action skips them with explicit reasons. All
other invalid/late failures occur before project save. One accepted command
creates one undo entry for the complete batch. Version checks reject stale
commands and previews, including a project revision changing during calculation.

Native `.prj` export writes `rebinned=1`; importing a bare project with the web
extension removed still recognizes that flag. The web extension retains full
originals. A native desktop re-save preserving those extended originals has not
been demonstrated.

## Shared saved grid defaults

`AthenaPreferences` stores six values—emin, emax, pre, xanes, exafs and width—in
`preferences/athena_preferences/rebin.json` under the configured data root.
`GET/PUT /api/athena/preferences/rebin` use a separate monotonically increasing
version. Writes use the existing atomic file replacement and cross-process
file locking. A stale window receives HTTP 409; invalid values and failed
replacement leave the last accepted settings intact. Malformed stored data
raise a recoverable error, rather than silently overwriting personal settings.

The workbench holds one current grid for import and post-import processing.
It loads saved defaults on startup; a late response cannot overwrite newer
edits. **Save grid as defaults** persists a validated snapshot. **Load saved
grid** refreshes from the server, including after a conflicting save. **Use
Athena default grid** changes the current values to system defaults; a further
Save is required to persist the reset. E0, selected groups, import enablement
and project recipes are excluded. Project save/export/undo do not alter these
preferences. Another browser session on the same local server sees saved
defaults; an already open window reloads them explicitly.

The browser controls retain failed save drafts, block duplicate saves and
validate returned versions and grids. Current-session changes affect both
dialogs. Automatic imports use their existing captured mapping, so a later
preference response cannot rewrite requests already being imported.

## Evidence and remaining obligations

- `backend/tests/test_athena_post_rebin.py`: 23 real-store/API cases, including
  independent native grid/value oracles across three types and three shifts,
  direct Larch k products, detector/original retention, mixed eligibility,
  frozen sources, background dependencies, list ordering, failures, resource
  limits, stale previews, undo/redo, JSON and bare/native-flag PRJ round trips.
- `backend/tests/test_athena_preferences.py`: 18 cases for defaults, disk/session
  persistence, isolation from projects, validation, concurrent writers,
  failed disk replacement, corrupt storage and real GET/PUT/conflict/reset.
- `frontend/components/athena-rebin.test.tsx`: native controls/payloads,
  saved E0, plotted arrays and markers, current/marked actions, retry, stale
  cancellation, unavailable k and ineligible-current recovery.
- `frontend/components/athena-rebin-defaults.test.tsx`: loaded/saved snapshots,
  late loading, unmount cancellation, invalid/corrupt values, conflict recovery,
  edits during a save and refusal to claim an unconfirmed save succeeded.
- `frontend/tests/e2e/athena-rebin.spec.ts`: measured Cu original/rebinned E
  and k traces compared to actual preview/store arrays; current and batch
  insertion, entire-batch undo/redo/reload; shared grid in both dialogs,
  cross-browser-session persistence, conflicting window, explicit reset, and
  desktop/mobile images. The full runs are recorded in [verification](athena-verification.md).

PR-06 and UI-11 remain **Partial**. Remaining requirements include:

1. Native child default/range resolution for every unusual saved recipe, all
   native-only parameters, reference-clone semantics and display-preference
   effects on previews. Copying web-supported parameters is not full parity.
2. Native append/insert mark behavior and the marked handler's current-index
   versus loop-index edge case. Web batches deliberately remain in adjacent
   source order and unmarked; complete native list-state fidelity is unresolved.
3. The native marked handler does not explicitly skip chi/already-rebinned
   entries despite disabling them in the current-group panel. The web's
   consistent eligibility rule is documented, not represented as identical.
4. The full native YAML/user/system preference tree, INI exchange and per-dataset
   default/range behavior. [Remembered import choices](athena-column-memory-reference.md)
   now restore supported mappings, references, preprocessing, five region values
   and matching-layout rebin activation after fresh file choice/restart. This
   implements that precedence subset, not the full native configuration system.
5. Full native wx execution and broader Ifeffit/Larch comparisons. Tests of
   transcribed scalar source algorithms and direct Larch are evidence for those
   algorithms, not a completed desktop replay.

All 107 parity requirements, including alignment, file plugins and the other
Athena analysis workflows, remain in scope. Artemis is excluded.
