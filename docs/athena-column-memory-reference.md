# Athena remembered import choices

Baseline: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`, reviewed
2026-09-10. This extends IM-04, IM-05, IM-07 and UI-11. All 107 Athena
requirements remain in scope; no Artemis functionality is introduced.

## Primary-source behavior

Pinned [Athena IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L326)
reads `athena.column_selection` before opening the column dialog. Its
restoration block and persistence write at lines 561–610 provide the contract:

- Identical ordered column labels and count restore energy and signal
  operands, logarithm, inversion, multiplier, energy units, data type, individual
  MED selection, and reference operands/log/same-element choices.
- A changed layout gets fresh detector suggestions and disables references,
  individual MED import and rebin activation. Sign, multiplier and preprocessing
  controls are still populated from the previous choices.
- The five rebin region fields (`emin`, `emax`, `pre`, `xanes`, `exafs`) come
  from the remembered selection, falling back to runtime/user and system
  defaults. The smoothing width is a separate global preference, absent from
  the native column-selection persistence file. Rebin activation is restored
  for matching columns and disabled for a changed layout.
- Marking, parameter copying, alignment and the standard's name are restored.
  Native code looks for the first group with that name; missing standards
  disable copying and alignment. References are not marked.
- The choices are written after the accepted import. Cancelling the dialog
  returns before that write. Compatible files in a batch bypass a second
  dialog, as described in the [multiple-import manual](https://bruceravel.github.io/demeter/documents/Athena/import/multiple.html).

There is a source/manual discrepancy: the
[preprocessing manual](https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html)
says marking and rebin activation start off for each new selection. The pinned
implementation explicitly restores marking and matching-layout rebin
activation. This implementation follows the source for that lifecycle;
earlier web reset-on-every-file behavior has been replaced.

`IO.pm`, `ColumnSelection.pm`, `ColumnSelection/Rebin.pm`, and the configuration
sources are already recorded in [the primary-source manifest](athena-primary-sources.json).
This is source inspection, not a claim of complete native wx execution.

## Implemented persistence and precedence

`AthenaPreferences` stores validated choices in
`preferences/athena_preferences/columns.json` under `XRAYLARCH_DATA_ROOT`.
This record is separate from projects, undo history and the explicitly saved
grid defaults in `rebin.json`. It includes the ordered parsed labels/IDs, a
versioned mapping, a grid snapshot and the preprocessing standard's identity.
It stores no detector arrays, staged upload ID, project revision, batch edge
policy or file-specific manual grid E0.

Inspection compares labels and count, then maps selected IDs by position.
Different IDs do not lose the selection, and repeated source labels do not
collapse detector channels. The parser's stable disambiguated names remain
visible in the column controls. Restored choices drive the same read-only
preview endpoint and scientific import request as manual choices.

The five accepted region values take precedence over saved personal defaults,
even when rebinning was disabled at acceptance. Width is taken from the current
saved global default, not the historical grid snapshot. A valid disabled grid
is sent as `rebin_grid`; active numerical rebinning still requires `rebin`.
Invalid inactive drafts are not saved. File-specific E0 is always cleared for
the next file and remains available only in the imported group's provenance.
Explicit **Load saved grid** or **Use Athena default grid** replaces the current
controls. A late startup preference response cannot overwrite restored choices,
including when their values happen to equal the initial defaults.

Successful imports update memory after the atomic scientific project save.
Preview, cancellation, stale revisions and failed imports do not update it.
Concurrent imports serialize preference writes with the existing filesystem
lock; the last completed preference write wins and increments the version.
Undoing project data does not undo a successful import's remembered choices.
An unavailable or malformed preference record produces an inspection warning
and leaves suggestions usable. A preference write failure after scientific
acceptance returns the accepted project with a warning, so the interface does
not invite a duplicate import retry. That warning is not saved in project JSON.

The dialog explains whether the current file started from matching choices or
new suggestions. **Use suggested columns** lets the user replace restored
choices and clear preprocessing without importing. It does not rewrite memory
until another import succeeds. Matching automatic batch imports retain their
captured mapping; another window's preferences cannot silently change that
batch's detector formula.

## Explicit differences and remaining work

The web resolves a standard by the first matching name in project list order,
following native `IO.pm`, including when several groups share that name. Renaming
the old standard removes that match; its saved ID does not override the native
name lookup. Missing or unusable standards disable copying/alignment with an
explanation. An unusable first match is not silently replaced by a later match.
Extracted chi retains marking but disables absorption transforms, reference
import, rebinning and standard operations.

Explicit zero multipliers and zero-valued region boundaries are retained.
Native Perl `||` fallbacks can replace zero with another default; the web
preserves those valid numerical choices. Sorting is also remembered as a web
control. JSON settings are not native YAML/INI import/export, and the complete
runtime/user/system preference tree, editable detector-match expressions,
per-dataset defaults and native-only parameters remain open. So do wavelength
handling, the complete plugin registry and full desktop replay.
FEFF xmu.dat import and persistence now have a [separate implementation and
verification contract](athena-feff-import-reference.md); other FEFF layouts and
full type conversion remain open. The request is still complete Athena
functionality with an xraylarch backend.

## Verification

`backend/tests/test_athena_column_memory.py` covers actual store and HTTP
restoration, reference/MED/type/unit choices, changed layouts, positional
remapping, disabled grids, zero values, default-width precedence, manual E0
exclusion, standard recovery, concurrency, failure/cancel/undo and restart.
Frontend helper, workbench and preference-hook tests check real controls and
payloads, suggestion recovery, late default responses and accepted-import
warning handling.

`frontend/tests/e2e/athena-column-memory.spec.ts` uses the measured 612-point Cu
scan to construct known detector counts. Chromium selects two individual
channels, a summed denominator, keV, XANES, a reference, marking and rebinning.
It checks the rendered original arithmetic, all seven original/rebinned
sample/reference traces, four accepted groups and sample-only marking. Reload
and a fresh browser context restore the controls and original preview arrays.
A zero-denominator import fails; that failure and a later cancelled edit leave
both accepted project data and the remembered version unchanged. Changed
labels disable layout-dependent choices and allow suggestion recovery.
Actual run counts and the screenshot review are in
[the verification log](athena-verification.md).
