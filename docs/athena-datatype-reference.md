# Athena group data-type correction

Source contract and executable evidence, 2026-09-10. This contributes to UI-04
and IM-02 in the full [107-row parity matrix](athena-parity.md). Neither row is
verified, and Artemis remains outside the requested scope.

## Native behavior

The [column-selection manual](https://bruceravel.github.io/demeter/documents/Athena/import/columns.html)
describes changing energy record types after import and excludes conversion
between energy data, χ(k), and FEFF types. It also documents Ctrl+Alt+left-click
on the main-page type label to toggle μ(E)/XANES.

The following sources are pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`; their original bytes match the hashes
already registered in [the primary manifest](athena-primary-sources.json):

- [ChangeDatatype.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/ChangeDatatype.pm), SHA-256 `190538fc163fa5d95b1a7d52fd21ece8f93b7c85d3e5a0a1f730344915bbf8ce`: current, marked, and all-group scopes; μ(E), XANES, and norm(E) destinations. The chi/FEFF destination entries are commented out.
- [Group.pm::change_datatype](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Group.pm), SHA-256 `3cc70f81c3130d2c069a4c38f483db005cbb091edb90e424c7cce1d36c98f13d`: explicit dialog destinations set datatype/is_nor, request normalization update, and mark the project modified. There is no frozen-group exclusion in these loops, nor any reset of raw arrays, energy shift, or processing recipes.
- [Main.pm::quick_change_type and mode](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Main.pm), SHA-256 `829a5ee82cd5c6c4447c7274f00fb8c6a0c6aa3f19fac74d8a911ae6fd7ea393`: Ctrl+Alt is required; the shortcut changes xmu/xanes without changing is_nor. The mode disables background/transform controls for XANES and normalization controls for χ(k). The type label remains outside the frozen parameter controls.
- [Data.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm) and [Data/Mu.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm): datatype and is_nor are separate state; normalized energy data avoid refitting pre_edge. XANES omits AUTOBK/FT while retaining its recipe.

There is a source/manual discrepancy: Group.pm's type-change loop does not
explicitly guard a source chi/FEFF record, although the manual prohibits those
conversions. The web dialog follows the documented restriction, reports those
source groups as skipped, and rejects a wholly ineligible selection. This is
not claimed as an exact replay of that handler's unguarded behavior. The pinned
dialog also has no detector-only destination, despite the manual mentioning
detector records. [Legacy detector project handling](athena-detector-reference.md) now preserves counts and supports energy-type correction; historical variants and diagnostic plots remain obligations.

## Implemented behavior

Group → Change data type offers all three native scopes/destinations and allows
choosing a different current group. It identifies each selected source type,
shows eligibility, preserves unapplied parameter drafts, and reports processing
errors. Cancel makes no request. Frozen energy groups are included, matching
the inspected type handler; frozen parameter controls remain protected.

The main parameter panel shows the data type next to Freeze. Clicking opens
the same dialog. Ctrl+Alt-click toggles only μ(E)/XANES. A norm(E) group becomes
normalized XANES and toggles back to norm(E); an explicit XANES dialog choice
clears the normalized flag, as the native dialog does. `is_normalized` records
this independent state, including in project exchange and normalized E0 searches.
XANES disables AUTOBK/FT controls and χ(k) disables normalization/AUTOBK controls.

`change_datatype` checks the project version, stages all selected type changes,
then recomputes using Larch. Raw energy/mu and detector arrays, group identity,
calibration, references, marks, freeze state, notes, plotting controls and saved
recipes remain intact. Functional normalization and background standard links
stay saved but inactive for modes that do not use them. Returning to raw μ(E)
reactivates the recipe. A background standard converted to XANES has no cached
χ(k); its consumers explicitly report unavailable processing and recover when
the standard returns to μ(E). Difference identity stays independent of type.

The web implementation recomputes dependent results eagerly and records one
undoable revision. This differs from native lazy processing and the native
shortcut's absence of an explicit modified/update_norm call. Invalid recipes
remain inspectable with an error and no stale result, so correcting a type does
not silently erase the recipe or raw signal. Undo/redo restore the recorded
scientific state. The UI waits for saved server state before reflecting changes.

Native PRJ export writes datatype and all related flags consistently, replacing
stale native args while retaining the original source metadata. Native XANES
plus is_nor imports as normalized XANES. Complete web JSON, PRJ with a sidecar,
and PRJ with the sidecar removed retain the ordinary energy type semantics.
The sidecar also preserves the web mu/norm distinction for difference records,
which share native xmu/is_nor/is_diff flags. Conflicting sidecar type or
normalization metadata is rejected before project mutation.

## Verification and remaining work

- [Backend regression tests](../backend/tests/test_athena_datatype.py) exercise measured copper through every energy source/destination pair, compare normalization directly with Larch pre_edge, trap unwanted normalization of normalized XANES, check all E/k/R/q result availability, preserve data/recipes/state, cover frozen/bulk/unsupported records, multi-hop background dependencies, failed science/recovery, difference/reference identity, normalized E0, undo/redo, stale versions, invalid options, native/web exchange and real HTTP.
- [Workbench tests](../frontend/components/athena-workbench.test.tsx) exercise all scopes, current selection, cancellation, unsupported/empty selection, frozen groups, dirty drafts, error reporting, duplicate submission prevention and the modifier-key shortcut.
- [Chromium flows](../frontend/tests/e2e/athena-datatype.spec.ts) load actual copper examples, compare complete rendered plot arrays, exercise current/marked/all/frozen changes and undo/redo, and download/reopen normalized-XANES PRJ files. Tests use isolated ports and temporary data roots.
- Actual run counts and image review are recorded in [verification](athena-verification.md).

Full UI-04 also requires the remaining group context-menu, selection/replot,
list expansion and inspection behavior. Remaining detector diagnostics, historical
format variants, exhaustive parameter/type interactions, and executable native
desktop replay remain open. This checkpoint does not establish full Athena
feature parity.
