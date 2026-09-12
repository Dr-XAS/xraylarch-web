# Athena Web implementation and verification

This branch is an ongoing implementation of Athena workflows in the browser.
It is not yet a verified replacement for every desktop Athena feature. The
[full coverage matrix](athena-parity.md) retains the remaining work; the
[research notes](athena-research.md) identify the primary tutorials, manual,
screenshots, and YouTube references used to guide it.

## Running the branch

From the repository root:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --reload-dir backend/xraylarch_web --host 127.0.0.1 --port 8006
```

In a second terminal:

```bash
cd frontend
npm run dev -- --hostname 127.0.0.1 --port 3004
```

Open <http://localhost:3004>. The earlier single-spectrum workbench remains at
<http://localhost:3004/classic>. Both use the local backend. Athena projects
are stored under `backend/data/xraylarch-web/athena` by default, or beneath
`XRAYLARCH_DATA_ROOT/athena`. The browser remembers the active project ID;
the backend holds the data and processing state. Save a `.prj` or complete
web JSON project for a portable copy.

## Implemented workflows

- Multiple data groups with independent active/marked states, filter, ordering,
  labels, notes, freezing, duplication, deletion and versioned undo/redo.
  Bulk marking supports all/none/invert and JavaScript regular expressions;
  freezing targets the current, marked, all or matching groups.
- Copy or reset individual parameters, scientific sections or full recipes.
  Full-recipe copies preserve per-scan energy shifts; global operations skip
  frozen groups. Sample/reference energy shifts propagate in both directions.
- Energy → Select E₀ offers derivative, atomic, edge-fraction, second-derivative
  zero-crossing, white-line and manual methods for current/marked/all groups.
  Values use the shifted energy axis, retain calibration, and preserve other
  parameter drafts. Per-group reports show accepted values and skipped groups.
- ASCII/CSV/XDI inspection, explicit column mapping, detector-channel summation,
  transmission logarithm, fluorescence ratio, reference channels, eV/keV units,
  ascending-sort option and multi-file mapping reuse for matching layouts.
- μ(E), XANES, normalized μ(E), and χ(k) inputs; normalization, flattening,
  AUTOBK, independently configured forward/reverse Fourier transforms.
  Background taper/window/clamp-point controls and fractional k-weights are
  independent of forward-transform settings. Energy-dependent normalization
  is available for raw fluorescence EXAFS; live background-standard links
  recalculate downstream groups in dependency order.
- E/k/R/q plots, overlays, complex components, transform windows, zoom,
  group scale/offset and stacked comparison. CSV exports carry computed arrays.
  Plot clicks fill draft E0, relative normalization ranges, and k/R bounds;
  spline energy and k limits are reciprocal. Apply saves the new processing.
- Calibration, derivative alignment, sample/reference alignment, weighted
  merge/sum, signed differences, parameter-copy series, smoothing, deglitching,
  truncation, rebinning, convolution and bounded-interval deconvolution.
- Thick-sample fluorescence self-absorption via Larch FLUO; dispersive polynomial
  calibration; the arctangent approximation for multi-electron excitation.
- Constrained linear-combination fitting, SVD PCA, multiple Gaussian/Lorentzian/
  Voigt peak fitting, shell-filtered log-ratio/phase and effective cumulants.
- Journal, provenance, native project exchange, local reopen, and downloadable
  analysis reports. Legacy and JSON Athena projects, with or without gzip,
  retain detector arrays and unimplemented native state as metadata. Saved web
  analyses are remapped across project exchange and report obsolete source
  versions. Scientific errors leave existing source groups intact.
- Project-file previews show raw or computed curves, notes and journal before
  mutation. Select groups by checkbox/range, all/none/invert, periodic position
  or JavaScript regex. A whole-project choice imports remaining queued projects
  in full; a subset pauses for the next preview. Failed imports can be retried
  without replaying accepted files. Save marked groups exports a subset.

Weighted merges normalize finite nonnegative coefficients. Sums preserve signed
coefficients exactly. Inputs can be raw μ, processed normalized μ, or χ(k), and
are restricted to the common measured range. Population scatter and explicitly
supplied measurement uncertainty remain distinct; both export on their native
grid. A zero sum retains its raw data and can be exported even though it has no
edge to normalize.

Background standards use the source group's live, unweighted, dimensionless
χ(k). Cycles and insufficient k coverage reject the entire edit. Frozen
consumers block direct source edits and cause global operations to skip those
sources. Background/all parameter copy and reset include the standard link;
copying onto that standard itself skips the self-link destination. Deleting a
standard clears direct links and invalidates its consumers, including indirect
ones. Apply on the first affected consumer repairs its processing and downstream
groups; undo restores the full prior dependency state.

The standard has fixed amplitude in this Larch implementation. Ifeffit's
automatic standard-amplitude adjustment is not implemented, and the app does
not align E0 automatically when a standard is chosen. Standards must cover the complete AUTOBK grid, including endpoint
clamps; the app never extrapolates a short standard. Energy-dependent
normalization follows Demeter's correction sequence but retains Larch's
normalization and spline numerics. E-space curves show the original processing;
χ/R/q use the corrected signal. See the pinned source evidence in the research
notes before interpreting this as exact Demeter/Ifeffit equivalence.

## Numerical and integration evidence

The tests use measured copper examples as well as synthetic spectra with known
answers. Test count is a checkpoint, not a full-parity claim.

- `test_athena_science.py`: direct Larch comparisons, normalization versus
  flattening, grids, positive/negative alignment signs, overlap-only merge,
  known mixture coefficients, PCA reconstruction and invalid scientific inputs.
- `test_athena_operations.py`: filter/line-shape behavior, reference Larch
  correction outputs, known fitted peaks, log-ratio signs and cumulants,
  non-finite inputs, inappropriate ranges and resource limits.
- `test_athena_project.py`: detector arithmetic, calibrated/reference axes,
  atomic multi-group edits, stale-version conflicts, frozen groups, undo/redo,
  independent Larch reading of exported files, legacy project fixtures,
  parameter/reference/journal round trips, unsafe-expression rejection.
- `test_athena_api.py`: real FastAPI request/response serialization, all four
  exported plot spaces, project exchange, every exposed transformation, known
  mixture weights, PCA/peak reports, stale requests and malformed imports.
- `test_athena_constraints.py`: whole/section/single-parameter copies and
  defaults, frozen destinations, explicit reference ties, calibration/alignment
  propagation, preserved source arrays, weighted combinations and uncertainty;
  all/none/invert marking and freezing with undo.
- `test_athena_background.py`: live standard dependencies across two hops and
  reordered groups, direct scientific comparisons, atomic graph/grid failures,
  frozen consumers, link copy/reset, deletion repair, derived groups and fnorm.
- `test_athena_project_preview.py`: sampled read-only previews, full-data lazy
  processing, subset exchange, omitted dependency warnings, report freshness,
  bounded staging/retry, native fnorm and distinct standard/reference links.
- `athena-project-import.test.tsx`: ordered subsets, empty-selection semantics,
  periodic/regex/shift selection, asynchronous plot isolation, whole/subset batch
  transitions, current revisions and recovery without replaying accepted files.
- `athena-workbench.test.tsx`: browser state and request contracts, active versus
  marked groups, per-group drafts, parameter application, project recovery and
  dialog behavior. Plotly is mocked in these component tests.
- `athena-plot.test.tsx`: 44 trace-contract checks cover display transforms,
  overlay ownership, mixed k-weights, complex components without double weighting,
  q-window interpolation, raw χ fallback and malformed imported reports. Plotly
  rendering is mocked here and checked separately in the live browser.

The earlier 2026-09-07 checkpoint passed **565 backend tests** and
**119 frontend tests across eight files**. `npm run build` passed TypeScript,
production compilation and route generation for `/`, `/classic` and the backend
proxy. The backend project/constraint subset also passed **110 tests with
warnings treated as errors**. `git diff --check` passed. No CLI Playwright suite
was executed for this checkpoint; live browser checks are listed below.
The final integrated checkpoint passed **727 backend tests** and **185 frontend
tests across nine files**. Commands: `backend/.venv/bin/python -m pytest
backend/tests -q`, then from `frontend`, `npm test`, `npx tsc --noEmit
--incremental false`, and `npm run build`; all completed successfully. The
production build compiled `/`, `/classic` and the backend proxy. The 82 workbench,
49 plot, 17 proxy and 15 project-import component tests are included in the 185,
not additional counts. No CLI Playwright suite was run; real browser checks and
resolved integration regressions are recorded below. `git diff --check` passed,
all 107 parity requirement rows remain in order, documentation links resolve,
and all nine pinned source hashes match the fetched files.

The Python dependencies emit deprecation warnings for NumPy's matrix class
inside Larch deconvolution, without test failures.

Runtime recorded for this checkpoint: Python 3.12.14, NumPy 2.5.3, SciPy
1.18.1, lmfit 1.3.4, XrayLarch 2026.3.1.post61+gf5272011f, FastAPI 0.116.1,
Pydantic 2.11.7. These are observed local versions, not a cross-version
equivalence claim. SHA-256 identities of the measured fixtures:

| Fixture under `examples/xafsdata` | SHA-256 |
| --- | --- |
| `cu_10k.xmu` | `28ed126f691659997a6894e55e016cce0626ce1d6db58ef4604fe1bad1a2e10a` |
| `cu_50k.xmu` | `f8fc32296f8045ab39ac738416f8d0121672d17d291d61658fcd1531b193f882` |
| `cu_rt01.xmu` | `cb66455a09abf464d486989faf43ffbaffdf14f970e85bdbe75f47261cfa96e6` |

## Browser observations and integration regressions, 2026-09-07

Using the running app and real example data:

1. Loaded Cu foil spectra at 10, 50 and 300 K, with 612, 620 and 408 points.
2. Verified actual normalized E, weighted k, complex R magnitude and filtered q
   magnitude plots; the browser console contained no warnings/errors in these checks.
3. Created a smoothed derived group from the dialog, then undid the operation.
4. Ran LCF from the current 10 K spectrum against the other two marked spectra;
   the UI rendered weights, residual plot and report export. This is an interface
   check, not a scientific endorsement of temperature spectra as chemical standards.
5. Inspected desktop (1440 px) and narrow (499 px) layouts. Further responsive,
   keyboard and workflow checks remain in the coverage matrix.
6. Applied an energy shift of +2 eV and FT k-weight 1.5 to the 10 K spectrum.
   Copied all processing parameters to marked groups through the new dialog;
   the 50 K spectrum received weight 1.5 while retaining its zero energy shift.
7. Rendered the second derivative and unwrapped q phase from real computed
   arrays. At a 390 × 844 viewport, the page had no horizontal overflow;
   controls and plot remained reachable. Restored the normal viewport afterward.
   Browser diagnostics contained development/HMR messages and no warnings or
   errors during these checks.
8. Used the weighted-merge dialog on three marked copper scans with normalized
   μ(E) and weights 1, 3 and 0. A derived group was created and displayed.
   Enabled the q-space window and observed the correctly identified forward
   window in the plot legend. These are interface checks; the earlier deliberate
   calibration differences make this an unsuitable scientific merge example.
9. Used the native file chooser to select `cu_10k.xmu` and `cu_50k.xmu` together.
   The dialog showed energy/μ columns and 612 points in the first file. A single
   Import action reused the mapping and added both groups, advancing the project
   from four groups/revision 4 to six groups/revision 6, with `cu_50k.xmu` active.
   Returned the plot to normalized E space. Induced retry failures remain covered
   through frontend mocks, rather than a manually disrupted live import.
10. Marked none, matched `50 K`, and froze the marked result through the new
    group dialog. The stored revision contained only the 50 K group marked and
    frozen, while the 10 K group remained active. Undo restored the initial flags.
11. Exported the copper project and opened it with the native file chooser.
    The preview showed all three original point counts. A proxy query-forwarding
    bug initially returned raw data when normalized preview was selected; this
    was detected visually and in the backend request log, then fixed (step 15). Selecting every second group checked positions 1 and 3;
    Import added exactly the 612-point 10 K and 408-point 300 K groups, preserving
    the originals and selecting the last imported group. Undo removed the copies.
12. Armed E0 picking and clicked a real Plotly trace near the edge. The draft
    became 8990.698 eV; the stored E0 remained automatic. Entering a 100 eV
    relative spline minimum produced 5.123167223161844 Å⁻¹. Cleared both drafts
    back to their original values without processing that picked E0.
13. Selected 50 K as the 10 K group's background standard and clicked Apply
    standard. The saved link and effective standard flag were present, with no
    processing error; the real k-weighted plot rendered. This verifies interface
    integration, not the appropriateness of these standards for a research fit.
    Undid the assignment and cleared temporary drafts. The workspace again held
    three original marked/unfrozen scans, with normalized E space active.

14. Selected two native project files through the file chooser. The backend
    had stopped before preview; after restarting it, Retry preview retained both
    files. One Import all groups action added both three-group files, advanced
    revision 21 to 23 and closed the dialog at nine groups. Two Undo actions
    restored the three original scans at revision 25. This covers a real initial
    preview failure/recovery; a mid-batch failure remains covered by mocks.
15. Fixed the Next proxy to forward query parameters unchanged. Its previous
    omission returned raw preview values for `mode=norm`, default project format
    for `format=json`, and E arrays for other CSV spaces. Added route tests for
    repeated/encoded IDs, formats, mode, space, exact response bytes and retained
    path/header restrictions. A preview now rejects a mismatched returned mode.
    Through the live proxy, normalized preview values exactly matched the direct
    backend; the first y value was 0.006099431461699751 versus raw 1.013661.
    The corrected normalized Plotly curve was visually inspected. A selected
    marked JSON export contained exactly one requested group; k export began
    `k,chi,weighted_chi,kwin` with attachment name `athena-k.csv`.
16. Corrected false draft indicators caused by object-property ordering. Scalar
    equality now treats an omitted fnorm as false and preserves the distinction
    between automatic and explicit values. Three component regressions exercise
    reordered server recipes, real changes, and Undo with preserved drafts.
17. A full frontend run exposed an intermittent k/R picking failure (183 passed,
    one failed). A new regression schedules a native pick click between a child
    layout effect and the parent's older passive effect. Cancellation now checks
    the captured pick's identity, preserving the new arm while rejecting old
    callbacks and still invalidating changed contexts. This is a controlled
    component timing check, not an induced browser scheduling test.
18. Corrected a legacy `/classic` test setup that attempted Preview while the
    initial workspace was still loading. Preview actions now await the enabled
    control before clicking, without increasing timeouts or changing assertions.
    All eight classic workbench tests pass with this setup.

## E0 checkpoint, 2026-09-07

Verification was staged as the source review finished:

- Full backend suite: **752 passed** in 322.59 s, before the new numerical
  E0 test file was collected. After the final fraction=1 adjustment, the
  E0 science/command/API run passed **135 tests**: 96 numerical E0, 24 store
  operations and 15 HTTP cases. These counts overlap; the 96 numerical cases
  are the additions to the full-suite checkpoint.
- Full frontend suite: **204 passed across nine files**. The subsequent
  fraction=1 regression brings the workbench file to **102 passing tests**,
  including **20 E0 cases**. The final targeted run passed that whole file;
  these counts overlap the full-suite run.
- TypeScript and the production build passed, including `/`, `/classic` and
  the API proxy. No CLI browser suite was run; actual browser checks follow.

Commands were `backend/.venv/bin/python -m pytest backend/tests -q`, then
`backend/.venv/bin/python -m pytest backend/tests/test_athena_e0_science.py
backend/tests/test_athena_e0_commands.py backend/tests/test_athena_api.py -q`.
From `frontend`: `npm test`, `npx vitest run
components/athena-workbench.test.tsx`, `npx tsc --noEmit --incremental false`,
and `npm run build`. Existing NumPy matrix deprecation warnings in Larch's
deconvolution remain unrelated to E0 selection.

`athena_e0.py` implements the six selections as a pure scientific operation;
`AthenaStore.set_e0` stages all selected values before recalculating spectra
and downstream background consumers. Frozen targets/consumers, chi(k), and
signed differences are skipped with reasons. A calculation error rolls back
the entire selection. The accepted result is retained in source provenance,
undo/redo and web/native sidecar exchange. The operation does not alter import
defaults or propagate E0 alone through energy-shift reference ties.

The pinned Demeter algorithms supply the five-pass/0.001 eV fraction iteration,
sample-ordered second-derivative search, K/L identity search/remappings, and
white-line first-turnover refinement. The latter uses the flattened full scan,
a six-sample local margin, a 0.02 eV grid and a natural cubic spline, checked
against independently solved spline equations. Initial E0 and normalization
still use local Larch. Exact Demeter/Ifeffit runtime equivalence, configurable
atomic data resources, native default preferences and full L-edge coverage
remain open. The fraction range includes 1; invalid values are rejected instead
of silently clamped. Undefined crossings and inadequate measured margins also
produce explicit errors. Source identities are in
[athena-primary-sources.json](athena-primary-sources.json).

Live browser checks used the three original copper scans, in 10 K / 50 K /
300 K order:

| Method / scope | Accepted E0 (eV) | Observation |
| --- | --- | --- |
| Inferred atomic / marked | 8979 / 8979 / 8979 | All inferred Cu K; shifts remained zero. |
| Fraction 0.5 / marked | 8983.090244 / 8983.077584 / 8985.999636 | Each converged in three iterations. |
| Second-derivative zero / marked | 8977.533657 / 8977.524001 / 8980.558481 | All processed successfully. |
| White-line / marked | 8979.626 / 8979.686 / 8982.680 | Source-based local flattened-curve refinement. |
| Manual / current 10 K | 8981.25 | Other two scans retained their previous E0. |
| Derivative / all | 8977.58 / 8977.58 / 8980.5 | Fresh estimates, independent of saved explicit E0. |

The actual result dialog was inspected visually. Six Undo actions restored
the three original marked/unfrozen groups, automatic E0, zero energy shifts
and no processing errors at project revision 37. No reference/background link
was introduced during these checks. This demonstrates the interface workflow
on copper; it does not establish the chemical suitability of every method for
every absorption edge.

## Import enforcement and XDAC checkpoint, 2026-09-07

The raw import API now accepts a nullable `edge_policy` with absorber, edge and
fraction. The Energy menu controls a preference for this browser tab; file
selection snapshots it for the batch and its retries. Enable/Stop, project
restore and Undo do not rewrite that preference into existing spectra.
Forced initialization uses tabulated E0, source-based automatic ranges, then
fraction refinement. It records the seed, selected identity, final E0 and any
automatic endpoint adjustments. At this historical checkpoint the same
fractional policy was also applied to references. The 2026-09-10 column import
review supersedes that behavior: native Athena initializes reference E0
independently, optionally shares sample identity, and retains finite raw
references with explicit processing errors. Invalid detector arithmetic still
rejects the complete import with its staged upload retained for retry.

Executed validation:

- Full backend suite: **944 passed** in 361.52 s. This included all 61 new
  initializer science cases, 25 import-policy store cases and 10 additional
  HTTP policy cases, plus the previously separate numerical E0 suite. Five
  existing NumPy matrix deprecation warnings came from Larch deconvolution.
- Full frontend suite: **233 passed across ten files** in 276.11 s, using
  `npm test -- --fileParallelism=false`. `npm run typecheck` and `npm run build`
  both passed; the production routes include `/`, `/classic` and the API proxy.
- The XDAC parser change followed full-suite collection. Its focused run of
  `test_parsing.py` and `test_parsing_xdac.py` passed **84 tests**: 59 new XDAC
  cases and 25 existing parser regressions. The V1.2 iron fixture retains all
  511 points, and V1.4 retains all 422 points and 17 columns. Comparisons use
  original numeric rows and an independent local Larch read, with unchanged
  source bytes and header metadata. First/middle/final malformed rows,
  nonfinite values, broken boundaries and resource limits remain rejected.
- After that parser fix, the combined parsing, classic API, Athena API and
  import-policy store regression passed **146 tests** in 47.52 s. Command:
  `backend/.venv/bin/python -m pytest backend/tests/test_parsing.py
  backend/tests/test_parsing_xdac.py backend/tests/test_api.py
  backend/tests/test_athena_api.py backend/tests/test_athena_import_policy_store.py -q`.
  This overlaps the earlier suites and includes the 59 new XDAC cases; it is
  not another full-suite run. One existing deconvolution warning remained.
- All **52** files in the expanded primary-source manifest were checked
  against their SHA-256 values. New source files supply the FT default and
  energy/k conversion context. This remains static-source evidence, not a
  Demeter runtime comparison.

Live browser sequence on the local app, with real file chooser uploads:

1. Started with the three marked/unfrozen copper examples at project revision
   37. Enabled Cu K, fraction 0.5 through Energy → Enforce element and edge,
   using the real table lookup. The project remained at revision 37.
2. Imported `examples/xafsdata/cu_rt01.xmu` as direct mu. Revision 38 contained
   one new, successfully processed group. Table seed was 8979 eV; fractional
   E0 converged in three iterations to **8986.437276261428 eV**. Seed defaults
   were pre-edge −150/−30 eV, post-edge 150/1066.86 eV, degree 2, spline kmax
   17.5 Å⁻¹ and FT kmax 15.5 Å⁻¹. The final automatic spline endpoint tightened
   to 17.444536537513315 Å⁻¹ as E0 moved, with the adjustment recorded.
3. Stopped enforcement and selected the original `examples/xafsdata/fe.060`.
   Inspection initially failed: its XDAC metadata, including ring energy,
   was incorrectly treated as a malformed table row. Added content-based
   XDAC header/boundary recognition using the local Larch beamline reader as
   reference; retried the same file with the actual Retry file inspection
   control. Its energy/I0/It columns and all 511 points became available.
4. Selected transmission and I0/It; verified the displayed ln(I0/It) formula.
   Import produced revision 39 with automatic E0 **7105.50673 eV**, inferred
   Fe K, zero shift and no enforcement provenance. Stored energy and mu were
   exactly equal to the original energy column and NumPy ln(I0/It). The
   original three groups were unchanged, including arrays and recipes. The
   iron E0 remains its uncalibrated automatic estimate, not a tabulated value.
5. Two Undo actions removed the temporary imports. Revision 41 exactly
   restored the original three groups, their recipes, marks and frozen state.
   Enforcement remained Off.

The implementation uses Larch normalization and its scalar defaults where the
web recipe already supplies values. It does not read personal INI preferences,
support every native signed/implicit-keV default expression, or reproduce all
native reference-channel options. The import initializer correctly converts
Demeter configuration order 3 to Larch degree 2; the older native exchange
mapping of `bkg_nnorm` still needs a separate correction and round-trip oracle.
Absorber/edge editing and derived signal identity were still open at that
checkpoint; the follow-up below records the implemented subset. No requirement
row is Verified.

## Absorber identity and derived signals checkpoint, 2026-09-07

The current-group editor saves absorber/edge independently of numerical E0 and
future-import enforcement. The backend validates and canonicalizes the pair,
rejects frozen/invalid/stale edits atomically, and changes only saved identity
and effective-result labels. Cached numerical results, recipes, calibration,
references, fraction history and unrelated frontend drafts are preserved.
Unfrozen chi, difference and failed-processing groups also support identity
metadata. Missing legacy absorption identity is inferred from cached E0 without
recalculating arrays or inventing an edge for chi/difference data.

Difference processing now uses a persistent boolean rather than the latest
operation name. Copy series, numeric transforms and combinations of differences
retain the current signed energy mode and primary identity/fraction. Parent
detector arrays are not copied onto changed grids. Web/native exchange and
subset preview preserve the flag even without the parent group. Native
`is_diff` and an explicit web-sidecar flag must agree. Chi differences still
produce Fourier products; numeric corrections enforce their own requirements
instead of a blanket difference-group restriction.

Executed validation:

- Earlier full backend collection: **1098 passed**, five existing Larch
  deconvolution/NumPy matrix warnings, 105.52 s. This preceded the final nine
  derived-correction cases, removal of blanket correction guards and one HTTP
  identity case; it is not a full-suite claim for those final edits.
- Final backend command: `backend/.venv/bin/python -m pytest
  backend/tests/test_athena_derived_identity.py
  backend/tests/test_athena_edge_identity.py
  backend/tests/test_athena_api.py -q` → **130 passed**, one existing
  deconvolution warning, 30.10 s. Includes 49 real-store derived cases, 55
  identity cases and 26 HTTP cases. Checks cover exact metadata-only updates,
  invalid/frozen/failed edits, undo/redo, native-only restore, real Larch Fourier
  comparisons, negative/zero differences and valid/invalid numeric corrections.
- Final frontend command: `npm test -- --fileParallelism=false && npm run
  typecheck && npm run build` → **259 passed across 11 files**, 42.91 s for
  tests, TypeScript and production build passed. The 131 workbench cases, six
  identity-dialog cases and ten policy cases cover save/retry, catalog races,
  busy/frozen controls, legacy flag precedence and separate drafts/policy.
  Nine additional plot cases verify signed values with difference-only/mixed
  labels, derivative labels, legacy flags and chi Fourier labels. Plotly is
  mocked in these tests; actual rendering was checked below.
- Re-fetched `Main.pm` matches its committed SHA-256 and Git blob SHA-1.
  Pinned `Difference.pm` and `diff.rst` were downloaded and hashed, expanding
  the source manifest to **54 files**. The other cached source files were
  unavailable during this follow-up, so the earlier 52-file check was not
  repeated. Source reading does not establish desktop runtime equivalence.

Live checks used the original three copper scans in project
`XOmEzrdc6QQOciQUZhJq8-VH`:

1. At revision 41, entered an unapplied Rbkg draft of 1.25 on 10 K. Selected
   Fe L3 (706.8 eV) through the real identity catalog and saved revision 42.
   E0 remained **8977.58 eV**, saved Rbkg remained **1**, and the draft remained
   **1.25**. Comparing every group against the baseline showed only the selected
   `source.edge_identity` and result element/edge labels changed. This choice
   deliberately lies outside the measured Cu scan and tests metadata separation.
2. Undid the identity edit and discarded the draft. Unmarked 300 K and created
   the difference of 10 K and interpolated 50 K, then made two Rbkg copies at
   0.8 and 1.2. At revision 46 all three derived groups retained their difference
   flags and Cu K identity; each copy's latest operation remained `copy_series`.
3. Applied parameters to the 1.2 copy, producing revision 47. Every group field
   was exactly equal to revision 46; each copy's arrays and result were exactly
   equal to the original difference. No normalization or EXAFS result appeared.
   This measured difference is positive throughout (0.06185866–0.124534); the
   negative/zero cases come from backend fixtures, not this live example.
4. Four Undo actions restored revision 51 with all original group fields exactly
   equal to revision 41. A later Redo display check reached revision 54 to verify
   the corrected copy caption `Difference (E)` and plot axis `Difference signal`
   in the actual Plotly view. Mixed absorption/difference plots identify forms
   in their legends rather than claiming every trace is normalized.
5. Three more Undo actions removed the display fixtures and restored the marks.
   Revision **57** again matched every original group field exactly. The app
   was left on the 10 K scan with marked plotting enabled and enforcement Off;
   backend and same-origin proxy health endpoints both reported `status: ok`.

This implements identity editing and persistence of the existing difference
mode. At this checkpoint Athena's full difference representation, standard
scaling, inversion, integration, marked-series, naming and renormalization
controls remained open; the next checkpoint implements those controls.
Other gaps include full metadata parameter copying, general provenance
remapping and invalidation, and complete native processing/type semantics.
All **107** requirement rows are retained and none is Verified.

## Difference tool checkpoint, 2026-09-07

The dedicated difference panel implements six energy forms, explicit DATA and
STANDARD selection, current/marked targets, signed standard scaling, inversion,
input overlays, E0-relative integration bounds, naming tokens, area sequences,
optional renormalization and E/k previews. Energy CSV and full preview JSON are
available. Numerical behavior and intentional boundaries are described in
[athena-difference-reference.md](athena-difference-reference.md), with source
identity in [athena-primary-sources.json](athena-primary-sources.json).

Preview reads saved spectra and recipes without writing project groups,
histories or analyses. A version check after calculation rejects concurrent
edits. Save recomputes the accepted options under the project lock and either
creates every requested group or leaves the project unchanged. It preserves
original groups, including frozen inputs and frontend parameter drafts. Signed
outputs keep their difference mode and form-specific labels; renormalized
outputs run the copied processing recipe. Native export/restore distinguishes
the absorption type, `is_nor` and the explicit web difference-mode flag.

Executed validation (focused counts overlap full collections):

- Difference science: `backend/.venv/bin/python -m pytest
  backend/tests/test_athena_difference_science.py -q -W error` → **103 passed**,
  1.65 s. Covers all forms, independent flatten preferences, nonuniform and
  shifted grids, full-STANDARD interpolation/extrapolation, raw processing
  failures with known E0, signs/zero, naming, interval boundaries, natural
  cubic splines and six-step Romberg convergence/nonconvergence. Six cases use
  the original measured Pt recipe records 6, 9, 12, 15, 18 and 21 against
  standard record 1. Their oracle explicitly runs Larch pre-edge normalization
  with saved E0 and fit ranges, polynomial degree 2, refitted edge step and
  each record's flatten preference. This is not untouched native preprocessing
  or an executed Demeter/Ifeffit comparison.
- Store/HTTP tests initially passed **62 cases** in 12.25 s. The final run,
  `backend/.venv/bin/python -m pytest
  backend/tests/test_athena_difference_store.py -q`, passed **67 cases** in
  12.87 s after adding original-input k overlays. Coverage includes read-only
  previews, immutable inputs, atomic batch failure, stale versions, recovery,
  undo/redo, persistent labels/identity/mode, native/web exchange, temporary k
  processing, separate failed-input warnings, and exact cached input k grids
  and weights independent of difference scaling and display offsets.
- Existing project/derived-identity/edge-identity regressions passed **189
  cases**, 42.39 s. The full backend command `backend/.venv/bin/python -m
  pytest backend/tests -q` passed **1273 tests**, 112.24 s, with five existing
  Larch deconvolution/NumPy matrix warnings. That full run preceded the final
  input-k response fields and five new store cases; the final 67-case store
  run covers those changes. No later backend numerical algorithm changed.
- Final frontend command from `frontend`: `npm test --
  --fileParallelism=false && npm run typecheck && npm run build` → **322 passed
  across 13 files**, 42.09 s for tests; TypeScript and production build passed.
  The final focused difference run passed **58 cases**. These cover panel
  defaults/options, selection/scopes, pending/stale responses, save/retry,
  busy controls, both bound pickers, draft preservation, export contracts,
  input-k validation, independent grids/weights and shared-standard rendering.
  Unit plots mock Plotly; actual rendering and mouse picking were checked below.
- The source manifest has **61 entries**. All **38 recorded Demeter Git blob
  IDs** were checked against the complete pinned GitHub tree. Available cached
  difference sources and `Main.pm` match their recorded content hashes; the
  whole older source collection was not re-downloaded. The committed original
  `demeter-diff.prj` is byte-identical to the pinned 35,186-byte fixture, SHA-256
  `c7152007277746e19cbe6a8ea5805fd06d58477535e4265c4853ae109e83a9a7`.

Live checks used the measured copper project `XOmEzrdc6QQOciQUZhJq8-VH`:

1. At revision **57**, entered an unapplied Rbkg draft of 1.25 on 50 K.
   Previewed normalized 50 K DATA against 10 K STANDARD, multiplier 0.9,
   inversion on, bounds −20/+30 eV, renormalization off and template
   `%d - %s (%f) %a`. The 612-point STANDARD grid yielded
   `Cu foil · 10 K - Cu foil · 50 K (flat) -2.55079`, area
   **−2.5507860715371367 eV**. E0 was **8977.58 eV** and physical integration
   limits were 8957.58–9007.58 eV. The finite area did not converge within six
   refinements; the warning appeared visibly. The k preview also rendered.
2. Switched to marked DATA, excluding the 10 K STANDARD. Area sequence plotted
   50 K then 300 K in list order. The latter area was
   **0.06199615593376477 eV**, with **151/612 extrapolated points** explicitly
   reported because its measured energy coverage is shorter. Both integrals
   retained visible nonconvergence warnings.
3. Saving created two signed xanes groups at revision **58**. Every original
   group field remained exactly equal to revision 57. Both saved arrays exactly
   matched `-(interp(DATA.flat, STANDARD.energy) - 0.9 * STANDARD.flat)` on the
   complete STANDARD grid. They had no live reference/background links, no
   processing error and no cached EXAFS products. The 50 K draft remained 1.25.
   Discarded that draft and undid the save, returning to three groups at
   revision **59**.
4. With 10 K DATA and 50 K STANDARD, selected raw mu, which enabled
   renormalization. Used multiplier 0.5 and disabled integration. Saving at
   revision **60** created one processed mu group with `is_difference=false`,
   no area, E0 **8977.58 eV** and edge step **1.1586588008229857**. Its source
   signal exactly matched the scaled subtraction on the 620-point STANDARD
   grid, and its processed arrays exactly matched direct `process_spectrum`
   with the saved recipe. Original groups again remained exactly unchanged.
5. Undo restored revision **61**, with all three original group dictionaries
   exactly equal to revision 57. The final k preview used 10 K DATA against
   50 K STANDARD with default normalized/scaling options. Actual Plotly showed
   the derived difference and both original input curves, labeled with their
   saved k-weight 2. Each had 501 points; API input arrays were exactly equal to
   the original cached k and weighted-chi arrays. The default interval's area
   was **−0.008773743731109028 eV**, with two reported extrapolated energy
   points and the source-algorithm nonconvergence warning.
6. Switched to E preview and used real mouse clicks on the plotted curve for
   both integration bounds. Minimum became **−64.964 eV** and maximum
   **47.927 eV**, corresponding exactly to STANDARD samples **8912.616** and
   **9025.507 eV** after adding DATA E0. Each click cleared the old preview and
   disabled Save until recalculation. The fresh preview returned area
   **0.005873718792736849 eV** with six-refinement nonconvergence reported.
   Read-only API checks confirmed those coordinates and left the complete
   project unchanged at revision 61.
7. Cancelled the panel. The app remains on the 10 K scan, with three marked
   original spectra, normalized E plotting, no parameter drafts and import
   enforcement Off. No preview groups were left in the project.

The native Pt fixture still exposes separate unfinished preprocessing work:
its zero-width Kaiser background window is rejected. Native polynomial order
still needed correction at that checkpoint; the follow-up below records it.
Other open requirements include
actual Demeter/Ifeffit runtime comparison, historical native type conventions,
general provenance remapping and the wider desktop surface. All **107** original
requirement IDs and their order remain intact; none is marked Verified.

## Native normalization checkpoint, 2026-09-09

Native `bkg_nnorm` now converts term count to Larch degree on import and back
on export. Missing native order uses the stock three-term default. Web JSON
and current/historical sidecars retain explicit degrees and automatic `None`.
Malformed native orders preserve raw spectra and editable processing errors.

This checkpoint also corrects the earlier native functional-normalization
mapping: the active Demeter field is `bkg_funnorm`, while both pinned native
loaders ignore `bkg_fnorm`. Obsolete values remain source metadata and cannot
enable processing. Existing web recipes retain their saved `fnorm` value.

The [source reference](athena-native-normalization-reference.md) records the
executable templates, Data defaults, native loaders and Ifeffit differences.
The source manifest now has 64 entries. Newly added NumTypes content matches
the pinned Demeter Git blob; the two added Ifeffit files match the previously
hashed 1.2.11d archive. Existing loader and XANES-configuration entries were
also checked against the pinned tree.

- `test_athena_native_normalization.py`: **76 passed in 7.38s** outside the
  sandbox. Tests cover native JSON/Perl lazy preview and restore, native-only
  round trips, automatic/effective order, historical web recipes, malformed
  input repair and undo, and canonical/obsolete flag combinations. Direct
  Larch comparisons check arrays and edge steps with relative/absolute
  tolerance `1e-12`.
- Final `MPLCONFIGDIR=/tmp/athena-native-mpl backend/.venv/bin/python -m pytest
  backend/tests -q`: **1,354 passed in 116.99s**, including the new 76 cases.
  Five NumPy matrix `PendingDeprecationWarning` messages came from existing
  deconvolution tests; there were no failures.
- Four measured Pt records compare degree-two normalization to direct Larch,
  after explicitly changing only their EXAFS taper/range settings. The old
  cubic result differs by more than `1e-4` for every selected record. The
  untouched native project still has zero-width Kaiser and saved endpoint
  compatibility problems; these tests do not establish untouched processing
  or Ifeffit parity.
- The existing local backend and frontend returned healthy responses; the
  frontend returned HTTP 200. The staged Fe2O3 normalized preview rendered in
  the actual workbench. Closing that temporary dialog returned to the three
  original copper spectra. A read-only API comparison confirmed the complete
  project matched the saved pre-check snapshot.

The initial sandbox regression process stalled in its HTTP tests and was
terminated before the final host run. Frontend code was unchanged. All 107
requirement IDs and their order remain intact, with no row marked Verified.

## Real-project import checkpoint, 2026-09-09

The [compatibility report](athena-prj-compatibility.md) supersedes the earlier
zero-width background Kaiser/native-endpoint limitation. Eight newly downloaded
official projects (57 spectra) pass staging, normalized previews, full processing
and both web JSON/PRJ round trips. Their bytes match pinned Git blobs; the
retained [fixture manifest](../backend/tests/fixtures/athena-official-manifest.json)
records the source and hashes. Direct Larch normalization/FFT comparisons and
real singular-covariance/zero-beta cases are now regression tests.

The [complete corpus](athena-project-corpus-results.json) contains 83 files.
All 82 normal projects import with 1,067 raw spectra preserved. Of those,
1,015 process and 52 retain explicit errors, listed individually. The executable
upstream danger.prj is correctly rejected. A repeatable audit script uses an
isolated temporary store and never edits source files.

- Project compatibility, project service and preview checks: **253 passed**
  after malformed-value recovery and legacy-window log-ratio consistency fixes.
- Final complete backend suite: **1,464 passed in 142.52s**. Five existing
  NumPy matrix deprecation warnings come from deconvolution tests; no failures.
- Frontend unit/integration suite: **326 passed in 36.89s**, 13 files.
- Full Chromium suite: **8 passed in 36.2s**. Four new cases cover three official
  project formats through ordinary upload, normalized preview, E/k/R/q plot
  rendering, real browser download, reupload, exact arrays/recipes and refresh;
  the fourth checks raw → project → raw batch order. Four existing classic
  workbench cases also pass.
- Type checking and production build: **passed**, using `.next-verify` so the
  development server stays available. Browser servers use `.next-e2e` and a
  temporary data directory.
- Native browser control independently imported the downloaded cu.prj and
  displayed its normalized and Fourier curves. The original copper project was
  restored in the UI afterward; a read-only API check confirmed revision 63,
  the same three copper group labels, and no processing errors. Both local
  services returned HTTP 200.

Initial test failures exposed stale assumptions that any native out-of-range
outer fit bound must fail, and that every yb_iron spectrum should calculate.
The tests now distinguish Larch's supported outer-bound clipping from wholly
unusable ranges, and retain yb_iron .003's actual nonpositive fitted-step error.
Additional malformed-limit tests found and fixed an early float-conversion
failure that otherwise prevented recovery of raw spectra.

Playwright's browser was initially absent. Its bundled version has no Ubuntu
26-specific package, so the supported Ubuntu 24 Chromium package was downloaded
to `/tmp/athena-playwright`, selected with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`.
Tests then ran successfully. No desktop Demeter execution is claimed.

All 107 parity IDs and their order are retained; no full row is marked Verified.
The primary-source manifest has 66 entries, including the pinned clamp
configuration and hashed Ifeffit window implementation.

## Limitations retained for continued work

Full desktop behavior remains broader than the current application. Outstanding
areas include complete default preferences, plot picking in processing and
analysis dialogs, import preprocessing, automatic noise/edge-step weighting,
batch model fitting, PCA target transforms, additional self-absorption methods,
phase-correction standards, some peak/step functions, all native analysis-state
formats, and the full collection of diagnostic plots and report formats.

The reflected-spectrum MEE algorithm is not implemented. FLUO uses a thick,
homogeneous sample assumption and is intended for XANES. Cumulants are effective
target-minus-reference quantities; their nominal fit covariance does not model
correlated errors from Fourier filtering. Deconvolution needs an appropriate
energy interval and can amplify noise. These are surfaced as scientific limits,
not silently replaced with different algorithms.

Videos were located and linked from the IXAS index. Video playback and
transcripts have not been independently reviewed. Manual reading and Larch
equivalence tests do not establish exact numerical equivalence to every
Demeter/Ifeffit version.

## Live column preview and reference checkpoint, 2026-09-10

The [source contract](athena-column-import-reference.md) records the implemented
import subset and remaining full-Athena requirements. Source hashes cover the
pinned column-selection and reference UI, import path, configuration threshold,
and data-unit/column-guessing implementation. All 107 parity IDs remain in their
original order; no full row is promoted to Verified.

The import dialog now has an automatically refreshed spectrum beside its
column controls, or above them on a narrow screen. It offers pause/replot,
reference visibility and log choice, MED range/clear controls, separate detector
groups and source-file text. One shared backend mapping computes both previews
and imported signals over all source points. Preview sampling retains extrema;
invalid arithmetic at omitted display points still fails visibly. Requests do
not change project state, and stale responses cannot display the wrong mapping.

Reference import was corrected after reviewing `IO.pm`: sample first, reference
below it; reference type follows the sample; Same element copies identity and
uses the default 25 eV atomic-E0 safeguard. Different-element references find
their own derivative edge. The earlier policy tests assumed fractional E0
initialization for both sample and reference and the old exchange fixture
assumed reference-first ordering. Those expectations were corrected against
the source. The exchange fixture still explicitly exercises automatic reference
parameters in addition to a configured sample. Detector-count, raw-array,
reference-link and saved-recipe roundtrip assertions were retained.

Executed checks:

- Full backend: `MPLCONFIGDIR=/tmp/athena-column-mpl backend/.venv/bin/python -m pytest backend/tests -q` — **1,497 passed** in **158.28 s**. Five existing NumPy matrix deprecation warnings in deconvolution tests. The focused columns/policy/project group also passed all **144** cases.
- Full frontend: `npm test` — **351 passed**, **15 files**, **42.42 s**. Final import-layout changes were additionally checked by both dedicated component files — **25 passed**.
- `NEXT_BUILD_DIR=.next-verify npm run typecheck` — passed. `NEXT_BUILD_DIR=.next-verify npm run build` — passed with TypeScript and four static pages; subsequent changes only relocated existing dialog actions and were covered by the targeted component/browser checks.
- Real Chromium: `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm run test:e2e` — **10 passed**, **50.9 s**. After the final sticky-layout adjustment, both column-import flows passed again in **15.1 s**. The browser runs use isolated backend data and ports 18006/13004.
- `athena-columns.spec.ts` tests actual upload, transmission, invalid-zero-denominator recovery, reference log/ratio plots, sample/reference persistence, MED range selection, pause/replot and separate-channel imports. It compares all preview/Plotly arrays to persisted spectra; selected points are checked against independently inverted detector formulas from measured Cu data. The 390×844 test confirms the plot fits the viewport. Desktop scrolling keeps preview controls below the dialog header.
- Reviewed generated desktop/mobile PNGs. Moved legends above the traces to avoid the mobile x-axis title, and placed import actions inside the controls column so they do not push sticky preview controls under the header at the bottom. Artifacts are regenerated in `frontend/test-results/athena-columns-*/column-preview-{desktop,mobile}.png`.
- Manually opened `examples/xafsdata/cu_10k.xmu` in the running in-app browser. Its 612-point preview and original-file controls rendered. Closed that dialog without importing into the user's project. Final local frontend and proxied backend health both returned HTTP 200 at port 3004.

Initial browser-test failures were test-harness issues: the measured file uses
leading-decimal numeric notation, and implicit select labels needed accessible
combobox-role selectors. The fixture now asserts its expected 612 rows before
running, and all final browser checks pass. This is Larch-backed web evidence,
not execution of every operation in the native wx Athena application.

## Column arithmetic and suggestions checkpoint, 2026-09-10

This checkpoint closes the prior arithmetic extension's verification record.
See [the source contract](athena-column-import-reference.md) for sums, constant
operands, log absolute ratios, sign/scale, chi reset and eV/keV suggestions.
The full backend run passed **1,542 tests** in **158.30 s**, with five existing
NumPy matrix warnings. A subsequent single-column suggestion case and its
small fix were included in the **46 passing** dedicated arithmetic tests.
The full frontend run passed **359 tests in 16 files** in **40.06 s**; a later
manual-unit-override case was covered by **34 passing** focused component/helper
tests. The matching-batch mapping case passed separately (1 passed, 133 skipped).
Typecheck and production build passed. Real Chromium passed all **12 tests**
in **52.4 s**, including denominator sums/scaling and chi control reset.
These counts overlap; they are not additive coverage totals.

## Import marking, standard copying and alignment checkpoint, 2026-09-10

The [preprocessing source contract](athena-import-preprocessing-reference.md)
records exact native/Larch behavior, manual/source inconsistencies, web choices
and remaining requirements. IM-07 moved from Pending to Partial. All **107**
original requirement IDs and their order were compared with HEAD and retained;
no full row is Verified.

Executed checks:

- `MPLCONFIGDIR=/tmp/athena-preproc-mpl backend/.venv/bin/python -m pytest backend/tests -q` — **1,582 passed**, **163.22 s**. The 246 warnings come from NumPy matrix use in Larch's Savitzky-Golay/deconvolution paths and zero-uncertainty analytical fits. These warnings are not failed numerical checks.
- The **39** dedicated preprocessing tests passed in **7.16 s**. After a final correction that disables standalone preprocessing in a reference's saved column mapping, the same **39 passed** again in **7.08 s**. They cover native arithmetic-independent measured Cu translations, sample chemistry offsets, standard immutability, parameter/identity/display copying, background dependencies, MED shift reuse, final-channel rollback, HTTP conflicts and JSON/PRJ round trips.
- `npm --prefix frontend test` — **366 passed**, **17 files**, **42.44 s**. The preceding batch/edge-policy/preprocessing workbench subset passed **26** cases; the dedicated preprocessing/helper/preview subset passed **21**. Counts overlap the full run.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` — passed. Production build with the same output directory passed with TypeScript and four generated static pages. The sandbox build first failed to parse its TypeScript subprocess's captured output; the identical command outside the sandbox passed.
- Full Chromium regression — **13 passed**, about **60 s**, including native .prj workflows and classic upload/processing. The dedicated five column-import flows also passed in **28.2 s**. Tests use isolated backend data and ports 18006/13004.
- After strengthening the new browser flow to wait for Plotly and compare its actual sample/reference arrays before import, that flow passed again in **12.1 s**. The earlier screenshot caught the asynchronous plot before it finished drawing; the recaptured screenshot shows both traces. The test checks original preview energies, known sample/reference signals, two accepted calibrated scans, copying/marking, unchanged standards and reload.
- Reviewed the regenerated preprocessing screenshot at `frontend/test-results/athena-columns-imports-a-b-f54b1-ent-and-sample-only-marking-chromium/import-preprocessing.png` and the mobile column preview from the full run. These test artifacts are regenerated by Playwright. The preview remains beside the controls on desktop and fits the mobile viewport.
- Final local proxy health at `http://127.0.0.1:3004/api/backend/health` returned **HTTP 200**, `status=ok`. Normal development data were not used by browser or backend tests. The local application remains available at port 3004.

Initial test failures were corrected against actual APIs/contracts: store
fixtures must save against an existing revision; preview/batch mocks must
include the new explicit preprocessing object; and the measured-data test must
read the complete 612-point Cu scan, not the parser's 16-point illustrative
fixture. Final checks use independent known shifts and stored data comparisons,
not relaxed tolerances to conceal a calculation failure.

Full Athena duplication is still incomplete. Native import-time rebinning,
FEFF types, plugin/preference coverage and the other open matrix obligations
remain active. The new import alignment matches the pinned Larch algorithm;
this does not certify numerical equality with every Ifeffit release or complete
native wx workflow replay.

## Import rebinning and measured MRCAT checkpoint, 2026-09-10

The [rebin source contract](athena-import-rebin-reference.md) documents the
pinned native scalar grid, PDL smoothing, Larch interpolation/end trimming,
original-data retention, and the remaining differences. IM-07 and IM-10 stay
Partial; PR-06 remains a separate post-import obligation. All **107** original
requirement IDs and their order were compared with HEAD and retained.

The downloaded, hash-checked Demeter `examples/data/uhup.101` exposed both a
previously unsupported MRCAT metadata header and 24 duplicate energies. The
parser now retains every one of its **2,006 rows and five columns**. Native
default rebin settings produce **396 points at grid E0 17168.101 eV**. No
observations are discarded to make the fixture pass. The live preview,
accepted groups and web JSON/PRJ round trips retain the original data.

Executed checks:

- `MPLCONFIGDIR=/tmp/athena-rebin-mpl backend/.venv/bin/python -m pytest backend/tests -q --tb=short` — **1,691 passed**, **170.75 s**. Warnings (328) were NumPy matrix use in Larch alignment/deconvolution, zero-error analytical fits, and five ill-conditioned polynomial warnings in the deliberately duplicated-endpoint interpolation oracle. Numerical covariance assertions passed; warnings were not suppressed or treated as numerical proof.
- The dedicated rebin/policy/E0 subset passed **268 tests** in **10.06 s**, including forced fractions before/after rebin on the measured U scan and a 100,001-reading Cu grid. A later exact-duplicate grid-point assertion strengthened coverage; the complete rebin file then passed **87 tests** in **7.27 s**. It checks last-smoothed-reading selection and independently assembled covariance. That additional assertion was added after the full suite had collected its tests. Counts overlap and are not additive.
- MRCAT/XDAC/rebin focused run passed **160 tests** in **4.66 s** before the later standard/policy additions. Malformed first, middle and last observations, corrupted headers, column/point limits, all PDL widths, reversed bounds, numerical limits and original-array preservation were covered.
- `npm --prefix frontend test` — **379 passed in 18 files**, **43.11 s**. Covers grid controls/defaults, chi disabling, invalid values/recovery, original visibility without refetching, grid refresh, batch failure/retry and reset on new selections.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` — passed. `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run build` — passed, including TypeScript and all four static pages.
- Full isolated Chromium regression — **14 passed**, **1.1 minutes**. Includes existing `.prj` imports/round trips and classic flows plus real MRCAT file selection, rendered Plotly original/rebinned comparisons, two-file batch, original-column retention and reload. Dedicated MRCAT flow passed in **10.1 s** after adding a check that the Plotly SVG finishes resizing to its mobile container.
- Reviewed regenerated desktop/mobile images at `frontend/test-results/athena-columns-official-MR-64de1-nd-imports-a-matching-batch-chromium/quick-scan-rebin-{desktop,mobile}.png`. Both curves render. The final mobile capture contains the complete energy axis and a wrapped legend; the earlier immediate-after-resize capture had clipped the old-width plot and was superseded.
- Final live frontend, backend health and frontend-proxied health returned **HTTP 200**. The existing Copper foil temperature-series workspace remained at **revision 67 with three groups**. Automated tests used temporary data and separate ports. `git diff --check` passed.

The implementation also removes an initial atomic-only fallback for dense
enforced scans. Rebin planning now uses all original readings for scalar Larch
normalization/fraction refinement, followed by normal final-grid initialization.
The normal public E0/processing paths retain strict grid validation. A temporary
misplaced preview guard was caught by the first real-file smoke check and fixed
before the numerical, browser and full regression runs above.

No full Athena parity claim is made. Native persistent preferences, unmodeled
parameters, post-import rebin/alignment differences, file plugins, and all other
open matrix requirements still require implementation and verification.

## Post-import rebinning and saved grid defaults checkpoint, 2026-09-10

The [post-rebin source contract](athena-post-rebin-reference.md) records the
native UI, shared numerical plan, real Larch k preview, group creation,
reference/dependency/original-array preservation and saved grid defaults.
PR-06 and UI-11 are now **Partial** with implementation and test evidence.
All **107 original requirement IDs and their order** were compared with HEAD
and retained. The source manifest contains **82 unique records**; newly added
Rebin.pm and rebin.rst records and the existing Athena.pm/IO.pm/Prefs.pm records
were checked against pinned Git blob hashes before use.

Executed checks:

- `MPLCONFIGDIR=/tmp/athena-preferences-mpl backend/.venv/bin/python -m pytest backend/tests -q --tb=short` — **1,733 passed**, **179.04 s**, 328 warnings from existing NumPy matrix usage, analytical zero-error fits and the duplicated-endpoint polynomial interpolation oracles. This full run includes all 23 post-import rebin cases and all 18 preference cases.
- The focused real-store/API run of `test_athena_preferences.py` and `test_athena_post_rebin.py` passed **41 tests** in **9.91 s**. It includes two-window locking/conflict behavior, failed disk replacement, corrupt settings, API restart/reset, project isolation, bare PRJ rebinned flags and background-standard preservation. Counts overlap the full suite.
- `npm --prefix frontend test` — **391 passed in 20 files**, **44.23 s**. Four earlier exact payload assertions needed the now-explicit `rebin: null` when rebin is disabled; the scientific requests remain disabled rather than acquiring defaults implicitly. Preferences have their own mocked service boundary in workbench tests and direct hook/API/browser checks.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run build` — passed, including TypeScript and all four static pages. After the final plot spacing/control order adjustment, the build passed again and the two rebin/defaults component files passed **12 tests** in **0.841 s**. A test-only possibly-undefined assertion found by typechecking was fixed before these final checks.
- `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm --prefix frontend run test:e2e` — **16 passed**, **1.4 minutes**. The preceding full browser run passed 15 and failed one strict status locator: the new preferences message and the existing paused-plot message both have `role=status`. The assertion now selects the paused-plot message explicitly; the final complete run above passed.
- Measured Cu original/rebinned E and k arrays match their real backend preview/store results. Current and marked creation, list placement, entire-batch undo/redo/reload, shared grid edits in import/processing, persisted defaults in a fresh browser context, another-window conflict, and explicit system reset all pass. Existing native PRJ import/round-trip, MED, MRCAT and classic flows remain covered.
- Reviewed desktop energy, mobile k and import-with-saved-grid images under `frontend/test-results/athena-rebin-*`. The first mobile capture had the k-axis title crowded against the legend; the final capture reserves more lower margin and shows the six entries below the title. Core rebin actions precede preference controls. Dialog contents remain scrollable at small heights.
- Live frontend-proxied backend health, preferences and project reads returned **HTTP 200**. The user's **Copper foil · temperature series** project remains at **revision 67 with three groups**, and its live saved rebin defaults remain at version 0. Automated writes used temporary data roots and isolated ports. `git diff --check` passed.

The deeper source check corrected an overstatement about native marking:
`AddData` copies the cloned marked flag, while `InsertData` starts unchecked.
The current web behavior uses unmarked adjacent children consistently; this
native distinction, the native marked-handler edge cases, unusual child recipe
resolution, full preference/last-column-selection precedence and complete wx
replay remain explicit open obligations. The import-time and post-import
features do not close every other Athena workflow. No Artemis work was added.

## Remembered column choices and restored previews checkpoint, 2026-09-10

The [remembered-choice source contract](athena-column-memory-reference.md)
records restoration, persistence and grid precedence against pinned `IO.pm`.
It explicitly identifies the manual/source disagreement over fresh-file marking
and rebin activation. Matching imports now restore supported choices after
restart, while changed layouts prompt with appropriate detector suggestions.
Accepted-only persistence preserves failed/cancelled attempts as unaccepted
drafts. The standard lookup follows native first-matching-name list order,
including duplicate names and the loss of a match after renaming.

Executed checks:

- `MPLCONFIGDIR=/tmp/athena-column-memory-mpl backend/.venv/bin/python -m pytest backend/tests -q --tb=short` — **1,748 passed**, **181.75 s**, **328 warnings**. The warnings were the previously described NumPy matrix, zero-uncertainty and duplicated-endpoint polynomial warnings. This full run began before the final width-precedence and standard-name-lookup corrections.
- After the width correction, all **15** dedicated column-memory cases passed in **3.69 s**. After replacing the initial ID/unique-name fallback with native first-name lookup and strengthening its rename/duplicate/order/unusable assertions, the memory, preprocessing and saved-default files passed **72 tests** in **8.84 s**. Those final tests cover the changed backend paths. Their 242 warnings include Starlette's AnyIO alias deprecation and the existing scientific-library warnings. Counts overlap the full suite.
- `npm --prefix frontend test` — **396 passed**, **20 files**, **40.94 s**. The helper, workbench, column-selection and defaults focused run had **181 passing** tests. These runs cover restored controls/payloads, suggestion recovery, warning delivery after accepted imports, and a late defaults response that must not overwrite restored values. Subsequent frontend changes were browser-test selectors/setup/assertions only.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` and production build with the same output directory passed for this frontend implementation.
- The corrected dedicated Chromium memory flow passed in **16.1 s** overall (**12.1 s** for the test). The final full command, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm --prefix frontend run test:e2e`, passed **all 17 tests** in **1.6 minutes**. This final full browser run used the corrected native-name backend and MRCAT default-choice setup.
- The memory flow checks two individual channels with duplicate source labels, a summed denominator, scale, keV, XANES, a reference, rebinning and sample marking. Actual plotted original arrays match independent detector arithmetic; seven original/rebinned traces are present. Reload and a fresh browser context restore choices. A real HTTP 400 zero-denominator import and a cancelled grid edit leave both the accepted project and preference version unchanged. A changed layout retains the native multiplier choice but resets reference/MED/rebin activation.
- Reviewed `frontend/test-results/athena-column-memory-remem-03455-failed-or-cancelled-choices-chromium/remembered-column-preview.png`: seven labeled original/rebinned sample/reference traces are visible beside the restored rebin controls. Reviewed the regenerated MRCAT mobile preview: axes, original/rebinned legend and plot controls fit the narrow dialog. These are Playwright outputs, regenerated on subsequent runs.
- Final read-only development checks returned HTTP 200 for proxied health, grid defaults and the existing project. **Copper foil · temperature series** remains **revision 67, three groups**; saved grid defaults remain **version 0**. Test writes used temporary roots and isolated ports 13004/18006.
- `git diff --check` passed. All **107** original matrix IDs/order are retained; IM-04, IM-05, IM-07 and UI-11 remain **Partial**. The manifest retains **82 unique primary sources**, and the cached IO/ColumnSelection hashes match their existing records. Local reference links resolve.

Initial browser failures were test assumptions, investigated with actual
trace/DOM evidence: repeated raw labels are disambiguated by the parser, and
reference menus are selected by their combobox role/name. A subsequent full
run passed 16 tests but failed the MRCAT arithmetic oracle because the previous
successful test's multiplier of 2 was correctly restored across a changed
layout. The MRCAT fixture test now explicitly chooses fresh suggestions and
the Athena default grid before asserting its known arithmetic. The memory
test separately asserts that changed-layout multiplier retention, so the
reset does not conceal a persistence regression. The final 17-test run passed.

This checkpoint adds persistent column choices to the live-preview workflow;
it does not prove complete Athena parity. Full native preferences/YAML/INI,
per-dataset defaults, native-only parameters, FEFF input types, wavelength and
file-plugin coverage, the remaining analysis workflows and complete native
desktop replay remain active requirements. Artemis remains excluded.

## FEFF xmu.dat import and four-space preview checkpoint, 2026-09-10

The [FEFF source contract](athena-feff-import-reference.md) records the native
type/normalization flags, fixture semantics, implemented behavior and remaining
type-conversion/native-reader differences. The two downloaded official FEFF
8.50L files contain **401 Copper readings** and **400 NiO readings**, with all
six `omega e k mu mu0 chi` columns preserved. Their original bytes, SHA-256 and
Git blob hashes are retained under `backend/tests/fixtures`.

The real samples exposed a wrong initial suggestion: generic k/chi detection
selected columns 3/6 instead of photon energy/mu in columns 1/4. The FEFF
signature now takes priority and uses a distinct normalized `xmudat` type.
Users still explicitly choose any desired columns and can preview mu0 or chi(k)
before acceptance. FEFF identity survives native flags and native JSON's
explicit datatype even when its generic normalized flag is also set.

Executed checks:

- `MPLCONFIGDIR=/tmp/athena-feff-mpl backend/.venv/bin/python -m pytest backend/tests -q --tb=short` — **1,772 passed**, **204.63 s**, **328 warnings**. Warnings are the existing NumPy matrix, zero-uncertainty and duplicated-endpoint interpolation warnings. This full run included 24 FEFF cases and began before the final native-JSON explicit-datatype precedence correction and its six added cases.
- The final FEFF and column-memory files passed **47 tests** in **5.27 s**, including all **32 FEFF cases**, the final native JSON precedence, and two added real-data background-standard/difference/functional-normalization eligibility cases. A preceding run of the same files, before those two last assertions, passed 45 cases. Counts overlap the full suite and are not additive.
- `npm --prefix frontend test` — **397 passed**, **20 files**, **45.74 s**. The focused column-selection/helper run passed 37 cases in 1.02 s. `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` passed; the production build passed with TypeScript and four generated static pages.
- The dedicated FEFF Chromium file passed both fixtures in **19.7 s** overall. The final full browser command, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm --prefix frontend run test:e2e`, passed **all 19 tests** in **1.8 minutes**. The full run includes the original native PRJ corpus, classic upload/processing, MRCAT, MED, preprocessing, remembered choices and saved rebin defaults.
- Chromium compares complete rendered omega/mu, omega/mu0 and k/chi preview arrays to the downloaded input, switches back to FEFF, imports, and checks all four rendered E/k/R/q arrays against the actual backend group. It downloads and reopens a PRJ, retains the FEFF type and processing arrays, and reloads with both groups present. No page errors were observed.
- Reviewed the NiO `feff-column-preview.png` under `frontend/test-results/athena-feff-*`: the selected mu column, alternative relative-energy/k/mu0/chi columns, normalized-input hint and actual full-data preview are visible together. Images are generated test artifacts and can be replaced by the next Playwright run.
- The live development frontend/backend proxy remains healthy. Read-only checks returned HTTP 200; **Copper foil · temperature series** remains **revision 67 with three groups**, and saved grid defaults remain **version 0**. All automated writes used temporary roots and isolated ports.
- `git diff --check` passed. All **107** matrix IDs/order remain intact; IM-02 and IM-11 remain **Partial**. The primary manifest has **85 unique sources**, and cached FEFF-related Athena sources match their recorded hashes. Source-contract and fixture links resolve.

Initial scientific test failures were resolved against actual domains and
explicit reference settings: inverse FT must use the same output-q limit;
these uncalibrated FEFF files start above the tabulated atomic seed and lack
the default 30 eV pre-edge interval. Tests now assert the out-of-support
enforcement error, verify a known calibration, and explicitly choose a valid
rebin boundary rather than changing guards or inventing observations. Browser
comparisons canonicalize only signed zero after the zero display offset; every
nonzero value is still compared exactly. One run ended with a pending import
at the test's 10-second response limit. Scientific import/reopen waits now allow
30 seconds; the final dedicated and full runs above passed.

FEFF output reading adds Athena functionality, not Artemis or FEFF execution.
The complete group-type conversion workflow, detector-only types, other FEFF
layouts, full native preferences, remaining analysis/process features and
complete native desktop replay remain active obligations in the full matrix.

## Group data-type correction checkpoint, 2026-09-10

The [source contract](athena-datatype-reference.md) records the dialog scopes,
energy destinations, independent normalized-XANES flag, frozen-group behavior,
shortcut, and source/manual discrepancies. The workbench now exposes Group →
Change data type and a type button next to Freeze. Ctrl+Alt-click toggles
μ(E)/XANES while retaining normalization. The dialog preserves raw data,
calibration, recipes and drafts; dependent scientific results refresh, and
undo/redo restores snapshots. Type-inappropriate parameter sections are disabled.

Scientific/exchange verification includes every μ(E)/XANES/norm source and
destination using measured copper, direct Larch pre_edge comparisons, a trap
against refitting normalized XANES, frozen and marked/all scopes, chi/FEFF
exclusions, normalized E0, signed differences, reference links and multi-hop
background standards. XANES preserves dormant EXAFS recipes; a standard with no
chi explicitly invalidates consumers instead of leaving an old cached result.
Failed science remains repairable without losing the saved recipe.

The initial full backend run found one regression in the existing difference
identity test: a normalized difference could reopen as mu because both native
representations use xmu/is_nor/is_diff flags. Exported sidecars now preserve the
web distinction and validate type/normalization agreement before import. The
focused exchange rerun passed **247 tests in 47.05 s**. Four additional conflict
cases cover contradictory sidecar type/normalization metadata.

Final backend command, `MPLCONFIGDIR=/tmp/athena-datatype-mpl backend/.venv/bin/python -m pytest backend/tests -q`, passed **all 1,823 tests in 179.65 s**, with **328 existing warnings**. This includes all **43 data-type cases**, sidecar conflict checks and the previously failing difference identity round-trip. The warnings cover the existing NumPy matrix/interpolation/conditioning and Starlette deprecation notices; no backend test remains failing at this checkpoint.

Frontend and browser checks:

- Full frontend suite: **405 tests passed**, **20 files**, **43.97 s**. The final data-type-only workbench run passed **10 tests in 3.05 s**, including two added parameter-availability cases after the full run. These counts overlap; they are not additive. The workbench file now contains 148 tests; only ten were selected for that focused run.
- Final `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` passed. Production build passed with TypeScript and four routes, including the backend proxy.
- Full Chromium suite: **21 tests passed in 2.0 minutes**. It includes the two new actual-copper type flows alongside native PRJ examples, column previews, FEFF, MED, rebin and classic workflows. After the final backend sidecar correction, the data-type and project-import files were rerun: **all 6 tests passed in 40.0 s**.
- Chromium checks complete rendered energy arrays for ordinary and normalized XANES; current/frozen/marked/all changes; saved recipes and retained drafts; undo/redo; and downloaded/reopened PRJ data. The new data-type flows recorded no page errors. The reviewed `datatype-marked.png` shows both selected copper groups, destination XANES, eligibility and completion status with readable controls. Screenshots live under `frontend/test-results/athena-datatype-*` and are regenerated by test runs.
- An initial browser assertion tried to verify a server-backed mark checkbox before its request completed. The test now clicks once, awaits the command response and saved revision, then verifies the mark. It does not force a UI state or suppress a failure.
- Development backend and frontend proxy health returned HTTP 200. The live **Copper foil · temperature series** project remains **revision 67 with three groups**; rebin defaults remain **version 0**. Test writes used temporary roots and isolated ports.

UI-04 moves from Pending to **Partial**, with its remaining context-menu,
selection/replot, list expansion and inspection requirements preserved. IM-02
remains **Partial**. All **107** matrix IDs and **85 unique primary sources**
remain intact; the five inspected type-related source files match their
registered SHA-256 values. Detector-only records, historical native variants,
remaining Athena functionality and native desktop replay remain obligations.
Artemis is excluded and the full goal remains active.


## Legacy detector record checkpoint, 2026-09-10

The [detector source contract](athena-detector-reference.md) records the explicit
legacy datatype, raw counts processing, dormant recipes, eligibility and native
source inconsistencies. The constructed compatibility probe contains 327 exact
measured I0 values from record mslu in the official Athena JSON fixture; it is
not claimed to be a native-produced detector export. It is explicitly allowed
in .gitignore so a fresh checkout will include this regression fixture.

Executed checks:

- Full backend: **1,848 passed in 190.43 s**, with 328 existing warnings. This run preceded the final remembered-standard exclusion and four additional raw-transform cases.
- Final detector/column-memory run: **44 passed in 4.26 s**, including all 29 detector cases and the final eligibility filter. Its initial truncation assertion used unshifted input bounds despite the sample's native −0.25 eV shift. The corrected test uses the plotted energy bounds, verifies both inclusive endpoints and counts, and checks that the child absorbs the shift exactly once. No processing guard was weakened.
- Full frontend: **418 passed**, 20 files, **44.50 s**. Final preprocessing eligibility fixture checks also passed three cases. Type checking and production build passed.
- Dedicated detector Chromium flow: **1 passed in 13.7 s** overall; full browser suite: **22 passed in 2.2 minutes**. Browser checks compare all rendered count values, inactive E0/normalization/FT controls, explicit shift availability, type correction/undo and PRJ roundtrip/reload. An initial run selected a file while workspace creation still disabled the picker; the final test waits for the picker to become enabled.
- Reviewed `detector-counts.png` in the generated detector browser output: all 327 measured points appear with Energy (eV) / Detector signal labels and the original count range. Images are replaced by later browser runs.

These counts overlap and are not additive. The 107 requirements remain intact
and none is marked Verified. Historical detector variants, all diagnostic
plots, exhaustive operation combinations and native desktop replay remain
open. The full Athena objective remains active.


## Native X10C/Lytle file converters checkpoint, 2026-09-10

The [file-plugin contract](athena-file-plugin-reference.md) pins the native
recognition, conversion, suggested columns, constants, precision and known
source defects. This checkpoint adds actual X10C/Lytle imports through Larch,
converter metadata and complete original/converted downloads in the column
panel. Original files and imported projects stay separate: PRJ sidecars retain
converted columns and provenance, but do not embed the original file bytes.

The downloaded public examples previously failed before column selection:
X10C was rejected for binary NUL bytes, Lytle for mixed header/numeric rows.
Both now complete live previews and Larch processing. The measured X10C file
contains 547 rows × eight columns and 446 joined negative fields. Lytle has
480 rows × five columns, with encoder energy derived from its header.

Executed checks:

- Native converter comparison: executed each **pinned Perl `fix()` body** on the original fixture, with lightweight path/default stubs replacing desktop object construction. Loaded both native output and web output with `larch.io.read_ascii`; NumPy exact-array equality passed for **all 547×8 X10C values and all 480×5 Lytle values**. This exercises conversion, not the broken native X10C recognizer or the whole Athena desktop. The untouched official Lytle fixture does not exercise the native joined-minus defect; a separate edited-input regression verifies the web retains that sign.
- Focused backend file: **50 passed in 2.72 s**, including full measured row oracles, direct Larch, filename-independent recognition, preview/import arithmetic, preserved columns, strict damaged-row rejection, invalid geometry/limits, local restart/memory, undo, JSON/PRJ and HTTP source bytes.
- Final full backend command: `MPLCONFIGDIR=/tmp/athena-plugins-mpl backend/.venv/bin/python -m pytest backend/tests -q --tb=short` — **1,902 passed in 190.25 s**, **328 existing warnings**. This includes the final detector tests and standard exclusion, all file-plugin cases and the final positive-energy conversion guard.
- Full frontend: `npm --prefix frontend test` — **420 passed**, **20 files**, **45.38 s**. The column-panel file separately passed **21 cases in 1.04 s**, including converter descriptions, separate downloads, original NUL display and unchanged mappings. Counts overlap.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run typecheck` passed. The production build passed with TypeScript and four routes.
- Dedicated Chromium converters: **2 passed in 18.3 s** overall (X10C 7.3 s, Lytle 5.9 s). Full `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm --prefix frontend run test:e2e` — **24 passed in 2.2 minutes**.
- Browser flows compare every rendered preview coordinate (energy exact, independent log arithmetic within 1e-12), byte-identical original downloads, every converted detector count, E/k/R/q curves against actual backend arrays, PRJ provenance/results and reload. No page errors were observed. A missing closing brace in the new test initially prevented collection; it was fixed before the passing type check, dedicated browser run and full suite.
- Reviewed the generated Lytle `file-plugin-preview.png`: the selected ln(I0/It) expression, signal controls and all 480 plotted points are readable with Energy (eV)/μ(E) axes; original/converted sections are available below. This captured the scrolled panel, so the converter banner above is verified by browser assertions, not inferred from that screenshot.
- Read-only live checks returned HTTP 200 from the page, backend and API proxy. **Copper foil · temperature series** remains **version 67, three groups**; saved rebin defaults remain **version 0**. Test writes used isolated ports and temporary roots.
- `git diff --check` passed. All **107** requirement IDs/order remain unchanged and no requirement is marked Verified. The manifest contains **94 unique primary sources**; relevant downloaded source hashes, fixture hashes and local contract links were verified. The detector probe is now explicitly visible to git rather than hidden by the generic PRJ ignore rule.

IM-01 and IM-10 remain **Partial**. Full source browsing in the panel, the
complete native plugin registry and user/system extension loading, plugin
enablement/configuration, other beamline/binary/archive formats, generic
wavelength conversion, export attachment handling, remaining Athena
processing/analysis/UI features and native desktop replay remain required.
These adapters advance the full Athena objective without reducing it. No
Artemis implementation is included.

## File-plugin registry checkpoint — 2026-09-10

The [registry contract](athena-plugin-registry-reference.md) records the native
unchecked default, immediately saved switches, documentation, disabled-file
recovery without losing import state, independent preferences, concurrent
window conflicts and native `athena.plugin_registry` YAML exchange. Unknown
valid plugin names survive import/export without being presented as installed.
At this checkpoint the installed catalog contained Lytle and X10C; the SSRL
checkpoint below expands it to five readers.

The prior registry turn completed these checks; their terminal logs were
re-read before continuing the SSRL work:

- Full backend: **1,933 passed**, 328 existing warnings, 201.03 seconds (`/tmp/athena-registry-backend-full.log`). The final 31-case focused registry run additionally includes the retained YAML::Tiny fixture assertions: **31 passed**, one Starlette deprecation warning, 2.18 seconds.
- Full frontend: **433 passed**, 21 files, 46.21 seconds. Registry component cases: **13 passed**. TypeScript and the production build passed with four routes.
- Dedicated browser: **3 passed**, 29.5 seconds. Full browser: **25 passed**, 2.5 minutes. These include a second browser window, stale-version rejection, reload, file-inspection recovery and native YAML exchange. Controlled checkboxes are checked after their server-confirmed PUT response; they do not change optimistically.
- Actual YAML::Tiny 1.76 read the web export. Native checkbox truth conversion followed by numeric 0/1 dump produced identical bytes and flags. Direct Tiny Load/Dump instead quoted scalar strings; the retained fixture proves the web accepts this native representation too. The library archive and exact member hashes are in the primary source manifest. This was a native YAML-library check, not desktop UI execution.
- The initial independence test tried exporting a deliberately empty project after undo; it was corrected to export the populated project before undo and restore it while the reader remained disabled. Existing empty-project parser validation was preserved. The initial frontend unconfirmed-save fixture needed an explicit `PluginRegistry[]` type; the final type check passed.
- Live page, backend and proxy returned 200. The measured copper project remained version 67 with three groups, and saved plugin preferences stayed version 0 with an empty mapping. Tests used separate ports and temporary data roots. No requirement was promoted to Verified.

The complete native reader collection, user/system discovery, per-plugin
configuration and the broader preference tree remain required. The registry
checkpoint recorded 98 primary sources. It is progress toward the full goal,
not completion of UI-11 or IM-10.

## SSRL ASCII, binary and MicroEXAFS checkpoint — 2026-09-10

The [SSRL source contract](athena-ssrl-reference.md) adds three real readers to
the registry and documents their source signatures, label ordering, binary
word conversion, native precision, suggestions, offsets and validation
differences. Original source files remain downloadable byte-for-byte; binary
sources have a 512-byte hex preview and separate converted-text preview.
Conversion provenance and all retained source columns survive project exchange.

Three pinned official acquisitions provide 455 ASCII, 635 binary and 296
MicroEXAFS observations. The actual native Perl converter routines were run
in a small accessor harness, yielding retained NPZ and compressed JSON
references. After real Larch reading, **all 17,492 converted column values
match exactly**. The reproducible native check also verifies a constructed
collector-2.0 encoding of the measured 1.1 binary values. This is a real
converter execution comparison, not a full Demeter desktop run or an
independent public collector-2.0 acquisition.

The MicroEXAFS sample has 69 source columns: energy, clock, three detectors,
32 SCA and 32 ICR. The native output retains 37 columns. Its transmission
detectors are zero; the default mapping produces a recoverable error and the
fluorescence suggestion uses a recorded SCA channel. Range selection sums all
32 SCA channels over I0, with separate-channel previews verified independently.
The other two fixtures use TRANS.DET; their optional I2/I0 ratio yields a
negative fitted step. Tests verify the exact raw ratio and processing error,
then use the physically appropriate transmission mapping for successful
normalization/EXAFS checks. No input sign is silently changed to make a test pass.

The initial browser oracle used JavaScript `toFixed`, whose half-unit tie rule
differs from native Perl printf. Backend output already matched native Perl;
browser expected arrays now come directly from the independently executed
native reference, retaining exact equality requirements. A component hex-text
assertion was adjusted for the test library's whitespace normalization.
Complete ASCII offset tables are displayed in converted column order.
Incomplete source diagnostics remain intact; the measured micro header has
only 67 offsets for 69 labels. Legacy binary offset/weight bytes can display
nonfinite values when interpreted in the native diagnostic order; they do
not alter or invalidate finite observation data. Dedicated regressions cover
both behaviors.

Final checks all reached terminal success:

- Full backend, including the final metadata regressions: **1,990 passed**, 328 existing warnings, **200.23 seconds** (`/tmp/athena-ssrl-backend-final-full.log`). This includes **57 new SSRL cases**. The earlier run before three offset-diagnostic cases passed 1,987; counts overlap and are not additive. A constructed complete-offset test initially reused the public micro file's incomplete 67-entry header; it now explicitly constructs all 69 entries, and the final full run passes.
- Full frontend: **438 passed**, 21 files, **46.46 seconds** (`/tmp/athena-ssrl-frontend-full.log`). Five new component cases cover explicit reader suggestions, retained choices, unavailable suggestions, chi/busy guards and binary hex presentation.
- Final TypeScript check passed (`/tmp/athena-ssrl-final-typecheck.log`); production build passed with TypeScript and four routes (`/tmp/athena-ssrl-build.log`).
- Dedicated Chromium: **4 passed**, **35.6 seconds**, covering three SSRL flows plus registry recovery/conflict/exchange. Complete Chromium suite: **28 passed**, **2.9 minutes** (`/tmp/athena-ssrl-browser-full.log`). This includes actual changes between transmission and fluorescence columns, the 32-SCA sum, full original/converted downloads, E/k/R/q plots, PRJ save/restore and reload. All test writes used isolated ports 13004/18006 and temporary data roots.
- The final native reference reproducer passed for all three original acquisitions and the constructed 2.0 encoding probe (`/tmp/athena-ssrl-native-reference.log`). Both NPZ and compressed JSON reference hashes/values were verified. These arrays come from the unchanged native converter routines, not the web implementation.
- Reviewed the three actual `ssrl-preview.png` screenshots under `frontend/test-results/athena-ssrl-*-chromium/`. The ASCII/binary views show readable ln(I0/I1), 455/635-point energy plots, and source/converted sections; the binary source is clearly labelled hex. The micro view shows the wrapped 32-channel sum over I0, an unchecked log option and the full 296-point curve. Screenshots were scrolled to the previews; upper suggestion controls and lower import actions are verified by browser interactions, not inferred from the cropped view.
- Live page `http://localhost:3004/`, proxy health and backend health returned **200**. The registry reports Lytle, SSRLA, SSRLB, SSRLmicro and X10C with untouched **version 0 / empty enabled mapping**. **Copper foil · temperature series** remains **version 67, three groups**. Enable the needed reader before inspection; test preferences were not written to this live workspace.
- `git diff --check` passed. All **107 matrix IDs and their order** match the baseline, with no row marked Verified. The source manifest has **104 unique entries**; six newly downloaded SSRL source/example hashes match the manifest. Local contract links resolve, and every retained sample/oracle/reproducer is visible to git rather than excluded by ignore rules.

The full 107-row goal remains active. Remaining readers, extension
loading/configuration, remaining Athena import, processing, analysis and UI
workflows and full desktop replay remain required.

## SPEC multi-scan import checkpoint — 2026-09-10

The [SPEC source contract](athena-spec-reference.md) records scan splitting,
independent scan selection/preview, shared original bytes, retained scalar
columns, staged inspection refresh, ordinary column controls and mixed
SPEC/PRJ/raw queues. Staging validates every supported scan before writing;
a failed later write removes only files belonging to that inspection.
Accepted imports are sequential, with failed-scan retry preserving previously
accepted groups and their project versions.

The pinned official SNBL acquisition contains **456×18 and 906×18 values**.
The actual native Perl `SPEC::fix` was executed through a small accessor
harness. All **24,516 converted values** match after direct Larch reading;
the reference reproducer checks the source, fixture, harness, output and
stored reference hashes. Its successful output is retained in
`/tmp/athena-spec-native-reference.log`. The harness retains `suggest` and
`clean` verbatim but does not invoke them. Native converter execution is not
complete desktop execution.

The official fixture exposes a native fixed-column mismatch: column 13 is
constant, while ZapEnergy is column 16. The web suggests the labelled energy
axis and records the native index. Native code and POD also disagree about
the transmission ratio; the code's Ion1/Ion2 ratio gives a negative absorption
step in this measurement. Explicit inversion is previewed and imported for
successful Larch normalization/EXAFS. Raw default polarity remains unchanged
and produces an explicit processing error if accepted. Empty and unrelated
scan commands are reported; damaged supported scans fail instead of silently
dropping rows or merging another motor scan.

Completed validation:

- Full backend: **2,021 passed**, **328 existing warnings**, **185.40 seconds** (`/tmp/athena-spec-backend-full.log`, process polled to terminal exit 0). The final focused set passed **169 cases** in **5.85 seconds**, including **31 SPEC cases**. Counts overlap. An initial stored-inspection comparison treated Pydantic tuples and JSON lists as different; the final check compares their actual HTTP representation and preserves exact values.
- Full frontend: **450 passed**, **22 files**, **46.11 seconds** (`/tmp/athena-spec-frontend-full.log`). The focused workbench/scan-panel run passed **162 cases**, including seven new scan-panel cases and five workbench flows. TypeScript exposed an unsupported Testing Library `exact` option in one new test; removing that option preserves exact accessible-name matching. Final typecheck passed (`/tmp/athena-spec-typecheck-corrected.log`).
- Production build passed with TypeScript and four routes (`/tmp/athena-spec-build.log`).
- Dedicated Chromium: **2 passed**, **24.0 seconds** (`/tmp/athena-spec-browser-corrected.log`). The first flow verifies both actual scan previews, all/none/invert selection, byte-identical original download, changing to a constant x column and back, explicit inversion, accepted values, E/k/R/q plots, PRJ source/result round trip and reload. The second injects one 503 on the second staged inspection, retries without duplicating the first scan, then restores three native Cu PRJ groups and imports a final Cu raw file for six groups with no processing errors.
- Complete Chromium suite: **30 passed**, **3.1 minutes**, terminal exit 0 (`/tmp/athena-spec-browser-full.log`). This includes both SPEC flows, native project imports, other readers, column memory, rebinning, the classic workbench and its mobile layout check.
- Initial browser failures were incorrect assumptions, not parser errors: the constant column is plotted rather than rejected by arithmetic preview, and native memory retains inversion on a changed column layout. The corrected tests verify the exact constant-axis curve and both the remembered negative Cu preview and positive curve after **Use suggested columns**. Scientific assertions were retained: native SPEC and raw Cu coordinates are compared against their references, and all six accepted groups must process successfully.
- Reviewed actual `scan-selection.png` and `spec-columns.png` from the passing dedicated run. The selection view shows separate 456/906-point scan entries, independent preview actions, the 906-point default signal and original download. The column view shows the checked inversion, explicit formula, and all 456 points with a rising absorption edge. These are scrolled dialog screenshots; upper controls and lower actions are covered by browser interactions, not inferred from cropped images.
- Read-only live checks returned HTTP **200** for the frontend, backend health and proxy. The catalog now contains **Lytle, SPEC, SSRLA, SSRLB, SSRLmicro and X10C**. Live plugin preferences remain **version 0 / empty enabled mapping**; the existing copper temperature-series project remains **version 67, three groups**. Test imports used isolated ports **13004/18006** and temporary data roots.
- Source audit: **113 unique primary-source entries**. All nine newly downloaded source/sample byte counts, SHA-256 and Git blob hashes match. Eight reader modules were inspected, but only SPEC among those eight is implemented at this checkpoint. All **107 matrix IDs/order** match the baseline and no row is Verified. Contract links resolve, new fixtures/references are visible to git, and `git diff --check` passes.

The full goal remains active. Other SPEC commands/layouts, remaining native
readers, extension discovery/configuration, original attachment exchange,
remaining Athena import/processing/analysis/UI requirements and full native
desktop replay remain open. Artemis is not included.

## SRS, DUBBLE and Photon Factory checkpoint — 2026-09-10

The [angle-reader contract](athena-angle-readers-reference.md) adds three
registered readers, native angle constants/precision, SRS nine/32-channel
record assembly, native detector subsets, DUBBLE/SRS overlap handling, and
requested/attained Photon Factory energy columns. Original bytes remain
downloadable and all converted columns/metadata survive project exchange.
The default registry remains unchecked.

Five pinned official acquisitions were downloaded and verified. Executing the
unchanged native Perl conversion routines established exact agreement for
**29,114 values** across SRS9 (397×15), SRS32 (353×38), DUBBLE (377×15) and
PFBL12C (818×5). Native SRS also converted the DUBBLE sample and confirmed its
different seven-channel suggestion. The official SRSC file fails in native
SRS on an indented C comment; the web follows its explicit ENERGY declaration
and preserves all **205×7 source values**. Its successful browser processing
uses the user's explicit SIGNAL1/REFER choice rather than changing the
default log ratio silently.

Visual inspection caught a real PF label problem after the first passing
browser run: the converted numbers were correct, but Larch re-recognized the
raw KEK-PF header and assigned angle labels/degree units. The converted-table
identifier now makes Larch use the emitted energy_requested/energy_attained
labels and eV. Direct Larch tests, inspection tests and browser assertions
cover the correction. The revised screenshot shows both energy labels,
I0/I1 and all 818 points.

Final source review also restored native PF missing-D behavior and last-header
precedence instead of rejecting those inputs. The missing-D case explicitly
reports native **2d = 1 Å** in the preview summary. A constructed header probe
was executed by the actual Perl routine; its 818 requested/attained energy
pairs are retained and compared exactly. This is distinct from the original
five acquired samples. Invalid/nonpositive geometry and numerical overflow
or underflow still produce explicit errors.

Executed checks and their scope:

- Final focused backend: **95 passed**, one Starlette deprecation warning, **3.50 seconds** (`/tmp/athena-angle-final-focused.log`). This includes **64 angle-reader cases** and 31 registry cases. Coverage includes every measured column, native suggestions, changed detector arithmetic, full Larch processing, native fallback, resource boundaries, first/middle/last corruptions, incomplete MED records, abort/non-MED forms, original/converted bytes, restart, undo/redo, JSON/PRJ and HTTP recovery.
- Full backend after the PF label correction and before the final missing-D addition: **2,084 passed**, 328 existing warnings, **214.09 seconds** (`/tmp/athena-angle-backend-final.log`, terminal exit 0). The earlier pre-label run also passed 2,084 in 188.86 seconds. Counts overlap. The final fallback branch and added test are covered by the 95-case focused run; 2,085 is not claimed as a full-suite run.
- Complete Chromium after the label correction, before the final fallback/cancel assertion: **35 passed**, **4.1 minutes** (`/tmp/athena-angle-browser-full.log`, terminal exit 0). The initial dedicated five-acquisition run passed **5** in **46.4 seconds**. The workflows edit native channel sums, invert and restore the signal, switch requested/attained energy, compare actual Plotly coordinates, download exact source/converted data, compare E/k/R/q, save/restore PRJ and reload. Counts overlap.
- The final five-acquisition run passed SRS9, SRS32, DUBBLE and SRSC. Only the PF cancellation locator timed out: the running worker had loaded `Close` before it was corrected to the real accessible name `Close dialog`. All PF native-default curve assertions had already passed. This was a test locator error, not a data or application failure.
- Targeted final PF rerun: **1 passed**, **15.4 seconds**, terminal exit 0 (`/tmp/athena-angle-pf-final.log`). It covers the corrected energy labels, real acquired file import/exchange, native missing-spacing preview coordinates, explicit default-spacing message and cancellation with the existing two groups retained. Together with the four final acquisition passes above, all five final workflows are verified.
- Final TypeScript check passed (`/tmp/athena-angle-typecheck-complete.log`). No frontend production source changed in this checkpoint; the previous 450-case frontend suite and production-build results remain the preceding checkpoint's evidence, not newly executed checks here.
- The final native reproducer passed all four native reference tables/suggestions, the generic SRS/DUBBLE fallback, PF missing-D behavior and the expected native SRSC failure (`/tmp/athena-angle-native-complete.log`). It checks source/fixture/harness/output hashes. It does not instantiate Moose, execute DUBBLE's XDI metadata hook or replay the full desktop.
- Reviewed actual screenshots for all five acquisitions: native SRS9 G1–G3, the wrapped SRS32 18-channel expression, DUBBLE MED2–MED9, corrected PF energy labels and SRSC SIGNAL1/REFER. Each shows its complete plotted point count. Screenshots are scrolled dialog views; upper/lower controls outside the crop are evidenced by browser interactions.
- Read-only local checks returned **HTTP 200** for frontend, backend health and proxy. The live catalog reports **nine readers**, with unchanged **version 0 / empty enabled mapping**. The existing copper temperature-series project remains **version 67, three groups**. All tests used isolated ports 13004/18006 and temporary data roots.
- Source audit: **118 unique entries**, five new acquisitions checked against byte counts/SHA-256/Git blob hashes, all **107 matrix IDs/order** preserved, no row Verified, contract links resolved and `git diff --check` passed. New samples, native references and the reproducer are visible to git.

Remaining native readers/layouts, complete XDI metadata handling, extension
discovery/configuration, original attachment exchange, other Athena workflows
and full native replay remain required. The complete goal stays active and
Artemis remains excluded.

## CMC, HXMA and LNLS scalar-reader checkpoint — 2026-09-10

The [scalar-reader contract](athena-scalar-readers-reference.md) records native
dark-current math, case-sensitive CMC correction, CLS named/fallback columns,
LNLS timestamp retention and exact written precision. Three official files
provide **258×13, 414×5 and 999×8** converted tables. All **13,416 values**
match executed native Perl and direct Larch reading. The sources, original
bytes, native numerical oracles and exact accessor harness identities are
retained in the [manifest](../backend/tests/fixtures/athena-scalar-fixtures.json).

The independent native reproducer also passes **12 constructed variants**:
variable integration time, upper-case ions, differently cased/missing offset
names, missing offsets with zero first time, later and first-point NaNs,
SXRMB identification, absent CLS PV headers, LNLS transmission/headerless
input and signed/scientific decimal precision. These are conformance probes,
not additional measured acquisitions. The harness executes unchanged
`is`, `fix`, `suggest` and helper methods, but not Moose construction, XDI
hooks or the Athena desktop. HXMA writes an absolute path into its header;
its numeric output is compared independently of that path.

CMC's actual transmission denominator is zero. The initial plot reports this,
an attempted import returns 400 without creating a group, and explicitly
choosing native fluorescence plus short-range XANES recovers successfully.
All eight MCA columns remain selectable; native fluorescence omits MCA1 and
MCA7. HXMA default transmission and alternate fluorescence are compared
against real converted columns. LNLS defaults to Ge15/Curta; selecting the
source's already-written Fluorescencia column changes the live curve to that
column's recorded precision. Its full 999 date/time pairs survive exchange.

Executed checks and their scope:

- Full backend: **2,163 passed**, 328 existing warnings, **212.87 seconds**
  (`/tmp/athena-scalar-backend-full.log`, terminal exit 0), including the final
  bounded-diagnostic changes and the prior PF missing-spacing fallback.
- Complete Chromium: **37 passed, 1 failed**, **4.4 minutes**
  (`/tmp/athena-scalar-browser-full.log`, terminal exit 1). All three scalar
  flows and all five final angle-reader flows passed. The existing FEFF NiO
  project-preview check timed out after five seconds while its normalized
  preview request was still outstanding; the captured page said Calculating
  preview and the network trace had no completed response. This does not
  establish a converter failure or prove why the request was delayed.
  The test now waits up to 30 seconds for that scientific request, asserts a
  successful response and exact x/y values, then compares the actual rendered
  coordinates. This strengthens the original SVG-visibility-only check.
- Targeted final FEFF rerun: **2 passed**, **19.7 seconds**
  (`/tmp/athena-scalar-feff-rerun.log`, terminal exit 0), including both exact
  normalized preview responses and plotted coordinates, PRJ restore and reload.
  Combined with the other passing full-suite flows, every final browser flow
  has passed; a second complete 38-test run is not claimed. The isolated rerun
  does not prove the cause of the earlier request delay.

- Final focused backend: **109 passed**, one Starlette deprecation warning,
  **3.23 seconds** (`/tmp/athena-scalar-focused-final.log`, terminal exit 0).
  This includes **78 scalar cases** and 31 registry cases. Coverage includes
  all measured/probe values and native suggestions, first/middle/last damaged
  records, resource/encoding limits, bounded NaN diagnostics, missing PVs,
  atomic HTTP recovery, actual Larch processing, previews, original/converted
  downloads, restart, undo/redo and JSON/PRJ source/array preservation.
- Dedicated Chromium: **3 passed**, **30.7 seconds**
  (`/tmp/athena-scalar-browser-final.log`, terminal exit 0). Each flow compares
  actual Plotly coordinates before/after detector edits and inversion, imports,
  downloads original/converted bytes, saves and restores PRJ, and reloads.
  CMC checks XANES normalization and empty EXAFS arrays; HXMA/LNLS also compare
  E/k/R/q plots to the actual processing response. No browser page errors.
- The initial browser run failed on test selectors: exact `getByLabel` did
  not match select elements whose label text includes their options. Using
  the actual combobox accessible names fixes both selectors. The final full
  three-flow rerun above passes; no converter change was needed for that issue.
- Final TypeScript check passed after the FEFF test update
  (`/tmp/athena-scalar-typecheck-complete.log`).
  Frontend production source did not change in this checkpoint; preceding
  frontend unit/build results are not represented as newly executed here.
- Reviewed all three actual `scalar-preview.png` screenshots and the CMC
  zero-denominator screenshot. They show correct eV axes, the native six-MCA
  sum, HXMA ln(I0/It), LNLS Ge15/Curta and complete 258/414/999-point curves.
  Dialog screenshots are scrolled to the graph; controls outside the crop
  are evidenced by actual browser actions.
- Read-only frontend, backend and proxy health checks returned **200**. The
  live registry lists twelve readers and retains **version 0 / empty enabled
  mapping**. The copper temperature-series project remains **version 67,
  three groups**. Tests use isolated ports 13004/18006 and temporary projects.
- The primary-source catalog has **121 unique entries**. All new fixture,
  source and oracle hashes match; Git blob identities and byte counts match
  the pinned tree. All **107 matrix IDs and order** match HEAD, none is
  Verified, local contract links resolve, fixtures are visible to git and
  `git diff --check` passes.

The pinned tree still contains fourteen other plugin modules outside this
registered-reader set, including two with retained upstream `t/filetypes`
examples (X15B and X23A2MED). Existing generic XDAC parsing covers part of that
format but is not a substitute for the whole native plugin contract. Full
XDI metadata, extension/configuration support, remaining Athena import,
processing, analysis and UI work, attachment packaging and native desktop
replay remain required. The 107-row objective stays active; Artemis is excluded.


## Configurable X15B and X23A2MED checkpoint — 2026-09-10

The [configured-reader contract](athena-configured-readers-reference.md)
adds X15B binary scalar records, X23A2MED iterative Vortex correction and
functioning per-reader configuration. Registry Configure forms distinguish
session Apply from Apply and Save, expose current/saved/factory values and
handle concurrent windows or server restarts. Saving includes other applied
reader settings, as native write_ini does. General native INI exchange is
still open; the web's internal preference file is JSON.

The import dialog now explicitly reinspects the same original file after
configuration changes. Returning from the registry preserves staged arrays
and the old preview until this action is chosen. Reinspection refreshes
column suggestions and curves while retaining queued files and batch policy.
A failed retry removes the old import action. Imported groups retain their
configuration snapshots across subsequent preference changes and PRJ exchange.

The two official default conversions match **4,981 native scalar values**:
**321 × 5 X15B** and **422 × 8 X23A2MED**. Executed native reproducers pass
three X15B configurations and eleven MED cases, including one through four
channels, dual ROI edges, zero-slow omissions, zero deadtime, low fast counts,
constant integration time and the twenty-iteration cap. Native doubles are
transferred losslessly before the actual Larch writer formats MED output.
No additional acquisitions are inferred from those reconfigurations/probes.
Full desktop, RPC, template and general XDI hook replay are not claimed.

Executed frontend checks:

- Final dedicated Chromium: **3 passed**, **27.1 seconds**, terminal exit 0
  (`/tmp/athena-config-browser-complete.log`). Actual Plotly coordinates match
  the native fixtures both before and after changing source columns or time;
  the old staged preview stays unchanged until reinspection. Both formats
  import, compare E/k/R/q processing plots, download byte-identical originals
  and native converted numbers, save/reopen PRJ and retain source/arrays after
  page reload. A second-window conflict returns 409, reload recovers and
  factory values apply only when explicitly submitted. No page errors in
  either scientific workflow.
- Full frontend unit suite: **467 passed** in **23 files**, **49.70 seconds**,
  terminal exit 0 (`/tmp/athena-config-frontend-full.log`). The focused editor,
  registry and workbench run previously passed **185** tests in **40.77
  seconds**. Final coverage includes session/save/defaults, errors, pending
  controls, StrictMode, stale responses and retained reinspection batch policy.
- Production build passes, terminal exit 0 (`/tmp/athena-config-build.log`).
  Final type generation and TypeScript pass, terminal exit 0
  (`/tmp/athena-config-typecheck-complete.log`). Verification output is separate
  from the live development build.
- Actual screenshots of both native fixture curves, both Configure forms and
  the final 390-pixel mobile registry were inspected. The mobile screenshot
  exposed fieldset/button minimum-width overflow; scoped fieldset minimums and
  wrapping registry actions fix it. Final browser assertions check the dialog's
  scroll width and configuration bounds, and the final screenshot shows a
  readable single-column form.
- Earlier browser failures were test-selector errors: server-confirmed
  checkbox changes need a click and response wait, and binary source download
  has a different summary label from text sources. Both were corrected;
  all three final flows passed with real numeric assertions unchanged.

The new source/sample cache has eleven verified records (one already in the
catalog); the catalog now has **131 unique entries**. Their sizes, SHA-256 and
Git blob identities match the pinned tree. Both acquisition manifests and all
fourteen compressed native oracles match their hashes. Local documentation
links resolve. All **107 matrix IDs and their order** still match HEAD, with
no Verified rows. Fourteen converters are registered. Eight top-level native
reader modules and four nested Beamlines helpers remain outside this set;
these twelve modules, broader preferences, XDI/extension work and the other
Athena workflows remain in scope.

Final complete regression results for this checkpoint:

- Full backend: **2,237 passed**, **328 warnings**, **212.24 seconds**, terminal
  exit 0 (`/tmp/athena-config-backend-full.log`). This includes all 105 focused
  configuration/reader/registry cases and the preceding scalar-reader suite.
- Full Chromium: **41 passed**, **4.7 minutes**, terminal exit 0
  (`/tmp/athena-config-browser-full.log`). Both new reader workflows and the
  conflict/mobile flow pass together with all prior angle, scalar, SPEC, SSRL,
  column, project, FEFF and classic workbench flows. The previous FEFF NiO
  response-wait check passes in this complete run.
- An initial sandboxed focused backend invocation stopped progressing after
  28 successful non-HTTP cases. An independent minimal FastAPI TestClient
  reproduced a wait in Starlette/AnyIO portal startup inside the sandbox and
  returned immediately outside it. Only the identified test process was
  intentionally terminated (exit 143); the complete run above used local
  socket support. The interrupted focused run is not reported as a pass.
- Live frontend, backend and proxy health checks returned **200**. The live
  registry contains **14 readers**, still **version 0 / empty enabled map**.
  The existing Copper foil temperature-series project remains **version 67,
  three groups**. Browser tests used ports 13004/18006 and temporary data.
- Final source/fixture identities, local links, matrix invariants and
  `git diff --check` pass. No commit, push or deployment was performed in this
  checkpoint. The complete Athena objective remains active.

## Multichannel project readers, 2026-09-10

The [multichannel contract](athena-multichannel-reference.md) adds native
X23A2MultiChannel and 10BMMultiChannel project output. Three official X23
acquisitions are retained with source identities; six 10BM constructed
configurations/layout probes are explicitly distinguished from measured data.
Nine independent native runs reproduce every column and energy/μ/I0/signal
expression, group label, datatype and journal. Native `sort_data` is executed
for the row-preserving Ifeffit branch; the old Larch template's independent
column sorting is documented as unsuitable for detector correspondence.
Moose/RPC/default-resolution/XDI/project-writer/full-desktop execution is not
claimed.

Executed results (all process handles confirmed terminal):

- Full backend: **2,272 passed**, **328 warnings**, **206.76 seconds**, exit 0
  (`/tmp/athena-mc-backend-full.log`). The new 35 cases include real HTTP,
  processing, source/converted downloads, staged configuration independence,
  limits, failed writes, cache eviction, namespace isolation, restart,
  undo/redo and JSON/PRJ exchange. Focused shared preview/configuration/registry
  checks: **151 passed**, **15.04 seconds**.
- Full frontend: **472 passed**, **23 files**, **47.66 seconds**, exit 0
  (`/tmp/athena-mc-frontend-full.log`). Staged project handoff, raw/project batch
  boundaries, no duplicate conversion/import, failed reinspection and boolean/
  empty-string configuration are covered. Focused: **194 passed**.
- Full Chromium: **43 passed**, **4.7 minutes**, exit 0
  (`/tmp/athena-mc-browser-full.log`). Dedicated final multichannel flows:
  **2 passed**, **22.2 seconds**, exit 0
  (`/tmp/athena-mc-browser-final.log`). Real Plotly coordinates are checked for
  every native channel, normalized previews, changed columns and energy
  shifts; X23 E/k/R/q, both download variants, subset import, saved PRJ
  reimport and page reload pass. Isolated ports 13004/18006 and temporary
  data are used.
- Long 10BM labels initially collided with checkboxes because global button
  styles enforced nowrap. Scoped wrapping fixes this; desktop and 390-pixel
  configuration screenshots were inspected after the change. Browser width
  assertions pass. Mobile configuration actions wrap and remain reachable.
- Type generation and TypeScript pass (`/tmp/athena-mc-typecheck.log`).
  Production build compiled but failed when Next.js captured empty output
  from TypeScript `--showConfig` in the sandbox (`/tmp/athena-mc-build.log`).
  A separate read-only probe produced valid JSON when redirected directly,
  while Next's `runTypeScriptCli` capture returned exit 0 with zero stdout.
  The attempted normal-local build was rejected by automatic approval review
  due to the account usage limit; it did not run. **Production build is not
  verified at this checkpoint.** No type-check bypass or repo workaround was
  introduced.
- All nine native reproducers pass (`/tmp/athena-mc-native-reproduced.log`).
  The primary catalog contains **150 unique entries**; added source byte,
  SHA-256 and Git blob identities match. Fixtures/harness hashes and local
  links pass. All **107 matrix IDs/order** match HEAD and no row is Verified.

Sixteen converters are registered. Six top-level readers and four nested
Beamlines helpers, measured 10BM acquisition validation, complete native
metadata/preferences/extensions and the other Athena workflow rows remain.
No commit, push or deployment was performed. The full Athena goal is active.

Follow-up: after the permission context changed, the normal-local production
build was approved and completed with **exit 0**
(`/tmp/athena-mc-build-local.log`). Compilation, TypeScript, page generation and
route output all passed. The prior sandbox failure and rejected attempt above
remain recorded as failed/not-run attempts; the build limitation is resolved.
Live frontend/proxy health is OK and the existing Copper foil temperature
series remains version 67 with three groups.


## B18/BM23 header readers, 2026-09-10

The [header-reader contract](athena-header-readers-reference.md) adds B18's
native Larch retention of all 36-channel observations and BM23's native
first-column keV-to-eV conversion. BM23 multi-scan selection is a documented
web integration extension. Retained inputs are explicitly constructed probes,
not measured B18/BM23 acquisitions. Native `is/fix/suggest` bodies execute for
both B18 backend branches and BM23; all native columns/labels/suggestions
match (`/tmp/athena-header-reproduced.log`).

- Full backend: **2,306 passed**, **328 warnings**, **221.89 seconds**, exit 0
  (`/tmp/athena-header-backend-full.log`). After collection, four additional
  scan-whitespace/count tests were added. The final header suite passed all
  **38 tests**, **2.84 seconds**, exit 0 (`/tmp/athena-header-extra.log`).
- Dedicated Chromium: **3 passed**, **24.4 seconds**, exit 0
  (`/tmp/athena-header-browser.log`). Both native detector previews, edits,
  E/k/R/q, source/converted downloads, PRJ exchange, reload and BM23 scan
  selection pass. All three screenshots were inspected.
- Full Chromium initially finished **45 passed / 1 failed**, **6.7 minutes**,
  exit 1 (`/tmp/athena-header-browser-full.log`). The failing registry test
  still classified B18 as unavailable after this checkpoint implemented it.
  It now checks that B18 is available and uses the synthetic
  `UserReaderFixture` entry to test unknown-reader preservation. The revised
  complete registry flow passes alongside ZIP tests below. This initial full
  run is not reported as a pass.
- TypeScript passed (`/tmp/athena-header-typecheck.log`). Explicit converted eV
  metadata prevents a second factor of 1,000 even with a retained `e_kev`
  source label and fewer columns than the native transmission suggestion.
  Original files, malformed-row atomicity and total scan point limits remain
  covered. The independent primary-data search found no suitable committed
  B18/BM23 acquisition in the inspected Demeter, openGDA or ixdat trees.

Eighteen readers were available at this checkpoint. Four top-level readers
and four nested Beamlines helpers remained, together with the wider Athena
matrix. These counts are historical; the following ZIP checkpoint adds one.

## ZIP list-output import, 2026-09-10

The [ZIP contract](athena-zip-reference.md) adds member selection and forwards
selected files into the existing live column, scan and project previews. The
queue handles nested archives and mixed inputs; a failed raw-file inspection
can be skipped without losing its unimported tail. Downloads preserve native
member bytes and archive bytes. Archive parsing never writes a member path.

Executed native `Zip.pm` methods with real Archive::Zip 1.68 reproduce all
three official iron-foil member sizes/hashes/order, empty suggestions and
cleanup (`/tmp/athena-zip-reproduced.log`). The retained 19,766-byte ZIP has
67,095 expanded bytes and three 511-point measured scans. The CPAN archive,
native source, fixture Git blob, harness and oracle identities are recorded
and checked. This is native plugin execution, not full Athena desktop replay.

- Initial focused backend + registry: **52 passed**, **2.58 seconds**, exit 0
  (`/tmp/athena-zip-focused.log`). A subsequent compression audit found that
  Python's `LZMAError` is not an `OSError`; it is now explicitly translated to
  a recoverable upload error. After checking the native project-type gate, the final ZIP suite passed
  **28 tests**, **2.64 seconds**, exit 0 (`/tmp/athena-zip-final-focused.log`), including four corrupted or
  unsupported compression methods, the native fitting-project exclusions and
  the real HTTP import boundary.
- Dedicated Chromium: **3 passed**, **29.6 seconds**, exit 0
  (`/tmp/athena-zip-browser.log`): official ZIP subset, actual changed preview
  coordinates, E/k/R/q, source downloads, PRJ save/reopen and reload; mixed
  project/scans/nested ZIP with non-data skip; and the corrected complete
  registry/two-window/YAML flow. Screenshots of mobile selection, column
  preview and the imported mixed workspace were inspected.
- Initial focused frontend: **181 passed / 1 failed**. An overly broad Open
  project handoff intercepted multichannel-source reinspection. The new
  handoff is now limited to `.zip`, preserving the native project-reader retry.
  Final full frontend: **475 passed**, **23 files**, **54.17 seconds**, exit 0
  (`/tmp/athena-zip-frontend-full.log`). This includes the original failing test
  and selected-member queue, failed-download retry and non-data skip tests.
- Production build passed compilation, TypeScript, page generation and route
  output, exit 0 (`/tmp/athena-zip-build.log`); separate type generation and
  TypeScript also passed (`/tmp/athena-zip-typecheck.log`). Build and browser
  output directories are separate from the running development app.

Final complete regression results:

- Full backend: **2,331 passed**, **328 warnings**, **232.15 seconds**, terminal
  exit 0 (`/tmp/athena-zip-backend-full.log`). Seven subsequently added cases
  (compression damage and native fitting-project markers) are included in the
  final 28-case ZIP run above; these overlapping totals are not additive.
  The final native-source/oracle identity and project-boundary check also
  passed (`/tmp/athena-zip-final-identities.log`).
- Full Chromium: **48 passed**, **5.7 minutes**, terminal exit 0
  (`/tmp/athena-zip-browser-full.log`). All prior header, multichannel, configured,
  scalar, angle, SPEC, SSRL, column and project flows pass with the two new ZIP
  flows and the corrected registry test. The final mobile test activates
  Review selected files at 390 pixels before returning to desktop width.
- The native reproducer also executes `Files::is_zipproj('guess')`, confirming
  the three exact root markers rejected by Athena IO.pm; ordinary and nested
  names are accepted. All method and classification outputs match the retained
  oracle (`/tmp/athena-zip-reproduced.log`).
- The primary catalog now contains **152 unique entries**. New source and ZIP
  identities, retained fixtures, native harness/oracles, documentation links,
  all **107 matrix IDs/order** and no-Verified invariant pass. Nineteen readers
  are available. Remaining top-level readers are **BL8Ar, SLRIBL4 and
  SpecFileLongLine**, plus four nested Beamlines helpers and the broader
  preferences, extension, analysis, processing and UI requirements.
- Live proxy health is OK. The existing Copper foil temperature-series project
  remains **version 67 / three groups**. The live registry is still **version 0
  / empty enabled map**, with 19 available readers. Browser tests used separate
  ports 13004/18006 and temporary project storage; local development stays on
  3004/8006. No commit, push or deployment was performed by this checkpoint.
  The shared checkout moved to master externally during the work; existing
  commits were retained. The full Athena goal remains unfinished and active.


## Dispersive calibration and saved pixel imports checkpoint (2026-09-10)

The [source contract](athena-dispersive-reference.md) resolves PR-14's upstream
TODO page against Pixel.pm, Dispersive.pm, the Ifeffit pixel templates and
SLRIBL4.pm at revision `06afc8da08a5a7d5a26ee14992170fcf5dc67406`. The five
[retained official files](../backend/tests/fixtures/athena-dispersive-fixtures.json)
match SHA-256 and upstream Git blob identities. The primary-source catalog now
contains 171 unique entries. All 107 original requirement IDs/order remain
unchanged; PR-14 advances to Partial and no row is Verified.

This implements live pixel column arithmetic and plots, native beamline
presets, conventional-standard selection, 10%/90% guesses, raw-derivative
refinement, reset/replot/make, native calibration settings exchange and
SLRIBL4 conversion using saved coefficients. Explicit native plot actions
persist coefficients while live editing remains read-only. The standard
preview respects saved normalization, automatic polynomial degree, supplied
normalization and energy shifts. Desktop plots remain alongside the controls
while scrolling. Stale preview responses and stale initial preference loads
cannot replace newer selections/settings.

A real make-group failure was fixed: pixel coordinates were being placed in
`source.raw_arrays`, whose schema only permits native detector arrays. All
source columns now use counted, validated `column_arrays`, aligned to group
row order with a reversible `row_order` permutation, plus the original source
SHA-256 and calibration/mapping provenance. JSON and compressed PRJ restore
retain these values; an independent Larch reader confirms exported energy and
mu. The 12-line ESRF colon header and numeric Photon Factory CSV header are
recognized without dropping any observations. Dates no longer become detector
column names. Damaged rows after the numeric boundary remain errors.

Measured results from isolated temporary projects (Python 3.12.14, NumPy 2.5.3,
SciPy 1.18.1, lmfit 1.3.4, local Larch 2026.3.1.post61+gf5272011f):

| Measurement | Fitted offset | Linear | Quadratic | Derivative SSR before → after | Fitted points |
| --- | ---: | ---: | ---: | ---: | ---: |
| ESRF Cu | 8952.152566 | 0.2865228384 | 5.513845724e−6 | 0.13265622 → 0.01449968 | 339 |
| Photon Factory Pd | 23925.203720 | 1.0680161248 | −1.185585751e−4 | 0.05504062 → 0.00405631 | 352 |

Neither fit extrapolates. Against the separately published `cu_08.calib` energy
axis, the Cu RMS difference is 0.145996 eV, maximum 0.348975 eV. That rounded
published axis is independent evidence, not a native-optimizer golden result.
The Pd check reverses mu alone and uses the recipe's pixel windows; it does
not apply the recipe's extra 1 eV conventional-standard Gaussian convolution.
Exact native normalization/optimizer replay, a measured SLRI acquisition,
large gzip time-series matrices and the remaining Athena requirements stay
open. No Artemis workflow is included.

The focused browser run passed both measured-file flows in 23.8 s, including
live detector/log/invert edits, paired conventional/calibrated curves, native
settings download/upload, make, E/k/R/q arrays, undo/redo, original byte
download and PRJ save/reopen. The Pd run checks a 390 px layout and then imports
the Cu pixel/stripe file through SLRIBL4 using a loaded native calibration.
Initial browser failures were test mistakes: an exact label lookup included
nested select-option text, and a download link was inside a collapsed source
disclosure. Correct semantic selection/disclosure interaction resolved both.
Visual inspection caught scrolling-hidden plots and a legend/axis-title
overlap; the final layout pins desktop previews and puts legends above plots.

Final commands and terminal results for this checkpoint:

- `PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests -q`:
  **2,380 passed, 332 warnings, 229.51 s**. The dedicated dispersive module has
  **42 passing cases** (including supplied/automatic standard normalization).
- `npm --prefix frontend test`: **484 passed in 24 files, 53.76 s**, including
  nine dispersive interaction cases.
- `NEXT_BUILD_DIR=.next-verify npm --prefix frontend run build`: **passed**,
  including TypeScript, page-data collection and all four static pages.
- `npm --prefix frontend run test:e2e`: **50 passed, 5.7 min** in the final
  clean Chromium run. An earlier full run had 49 passes and one asynchronous
  checkbox-test failure; waiting for the plugin settings PUT and confirmed
  checked state resolved it without changing the application's save behavior.
- Requirement identity/order, the 171 unique primary-source identities,
  fixture hashes, document links and `git diff --check`: **passed**.

Backend/HTTP tests use temporary data and writable Larch/Matplotlib caches.
Browser checks use `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`,
`PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright`, a fresh temporary data root
and ports 13004/18006. Logs for the terminal full runs are
`/tmp/athena-dispersive-backend-full.log`,
`/tmp/athena-dispersive-frontend-full.log`,
`/tmp/athena-dispersive-build.log` and
`/tmp/athena-dispersive-browser-final.log`. Final desktop/mobile captures are
in the dispersive cases under `frontend/test-results/` (test outputs, not
upstream reference images). The 3004/8006 local services remain healthy; a
read-only check confirmed the existing copper project still has three groups
at revision 67. Testing did not edit that project. Full Athena parity remains
an active objective.

## BL8Ar I0 review and SPEC long-label checkpoint — 2026-09-11

The [reader contract](athena-bl8ar-spec-long-reference.md) adds BL8Ar and
SpecFileLongLine, bringing the registry to 22 converters. BL8Ar uses the
actual native Elam energy (3205.9 eV), Larch's two-term normalization call,
strict above-edge subtraction, native output precision, measurement-specific
column suggestions and a configurable I0 fit review. The plot shows original
and corrected I0 plus pre/post-edge fits and their intervals. Confirmation is
scoped to one staged file and cannot be reused automatically in a batch.
Native Ge13's first-four-detector default is explicit and all 13 columns
remain editable. Column 6 supports the uncorrected reference comparison.
SpecFileLongLine removes only native `#L` lines while preserving other bytes,
and offers columns 56/57 when available. The native 254-byte boundary includes
the newline; shorter tables require manual detector selection.

Four reproducible, explicitly constructed files and five executed native Perl
references cover 21,311 converted values. Full converted-byte hashes and
native suggestions agree. The BL8Ar normalization bridge executes Larch with
the pinned native template arguments; Moose/Wx and Ifeffit are not replayed.
The official BL8 page has no aluminium download link, and no independent
measured BL8 or long-SPEC acquisition was obtained. Their absence remains an
explicit verification gap, together with the four XDI metadata helpers.
No requirement has been promoted to Verified or removed from the 107-row
inventory. The broader Athena goal remains active; Artemis is excluded.

Terminal results:

- Backend reader/configuration/registry tests: **91 passed**, including
  31 new reader cases; isolated HTTP tests enforce per-file review even after
  configuration changes and verify unmodified project revisions on refusal.
- Complete backend regression: **2,411 passed, 332 warnings, 205.27 s**.
- Complete frontend regression: **488 passed in 25 files, 49.52 s**.
- Production build: **passed**, including TypeScript and static generation.
- Focused Chromium: **2 passed, 20.3 s**, covering I0 plot arrays, Ge13/reference
  edits, two identical queued files needing separate review, normalized
  imports, original downloads, PRJ save/reopen and mobile SPEC detector edits.
- Unchanged native reader replay: **five cases passed**; generator/oracle
  hashes and exact regeneration of all four probes also pass.
- Requirement identity/order, no Verified rows, **174 unique primary-source
  identities**, local documentation links and `git diff --check`: **passed**.
- Full Chromium regression: **52 passed, 6.0 min**. Existing measured readers,
  live columns, batch memory, dispersive calibration, project and ZIP flows
  also pass. Final standalone type checking passes.

The first frontend run identified an unnecessary `reader_reviewed: false`
addition to ordinary import requests. The client now sends the field only
for explicit reader confirmation; all existing batch-request checks pass
unchanged. The first browser run passed BL8Ar but the SPEC test incorrectly
looked for a denominator select. It now uses the actual denominator
checkboxes and passes. These were resolved before the terminal results above.

Logs: `/tmp/athena-bl8-backend-full.log`,
`/tmp/athena-bl8-frontend-final.log`, `/tmp/athena-bl8-build.log`,
`/tmp/athena-bl8-browser-focused-final.log` and
`/tmp/athena-bl8-browser-full.log`. Tests use temporary workspaces, local
Larch/Matplotlib caches and browser servers on 13004/18006. The user-facing
3004/8006 services respond successfully; a read-only check confirms the
existing copper project is still revision 67 with three groups.

The final desktop `bl8ar-i0-review.png` and 390 px `spec-long-mobile.png` in
their cases under `frontend/test-results/` were visually inspected. Curves,
fit regions, legends and energy labels are readable. The desktop preview
column scrolls independently when the diagnostic is open; confirming review
collapses it to expose the selected detector plot. All test/build processes
have reached successful terminal states; the normal local services remain up.


## 2026-09-11 — acquisition metadata and measured X11A EDC

The [beamline metadata contract](athena-beamline-metadata-reference.md) adds
BL8/MX/X11A/XDAC acquisition recognition, all 11 native beamline INIs,
readable import/group panels and the persisted, default-on identification
switch. These are metadata helpers, separate from the 22 file converters.

The author-published X11A Cu foil now imports using actual Larch ASCII
reading. All 612 measured rows (2,448 values) are retained; the discrepant
611-point header is reported. Explicit detector/OFFSETS boundaries prevent
mixed headers from blocking import and prevent damaged observations from
being discarded. Live transmission and fluorescence previews are checked
against every measured point. Native offsets/gains remain inert metadata.

Terminal checks for this checkpoint:

- Backend focused metadata/parser checks: **81 passed**.
- Backend full regression: **2,467 passed, 332 warnings, 208.51 s**.
- Frontend focused metadata/reader components: **8 passed**.
- Frontend full regression: **493 passed across 26 files, 49.02 s**.
- Production build and standalone type checking: **passed**.
- Focused Chromium: **2 passed, 21.5 s**, covering all-point live edits,
  processing, refresh, actual PRJ download/reupload, persisted switch changes
  and mobile layout.
- Unchanged native Perl helper replay: **31 cases passed**. All four helpers,
  all 11 INIs, date corrections, focusing booleans and BL8 crystal precedence
  are covered. The harness records XDI setter calls; it does not execute the
  actual Xray::XDI validator/serializer or a desktop GUI.
- Exact bundled INI comparison, **191 unique source identities**, unchanged
  order of all **107 requirements**, no Verified rows, local documentation
  links and `git diff --check`: **passed**.

The first focused backend run exposed test setup assumptions: the measured
four-channel fixture requires its separate converter workflow, and BL8Ar is
initially disabled. Ordinary XDAC workflow coverage uses the existing measured
fe.060 file; the BL8 test enables its reader. Column 6 of converted BL8 is
correctly labelled mu, matching its uncorrected absorption. The first browser
run used an ambiguous warning locator (the warning appears both in the form
and the preview); scoping that assertion resolved it. No failing checks are
being represented as passes.

The desktop `x11a-columns-metadata.png` and 390 px
`x11a-mobile-metadata.png` were visually inspected under their cases in
`frontend/test-results/`. The native acquisition fields are readable and the
live copper curve is present. Tests use temporary workspaces and separate
13004/18006 services. The live frontend/backend and proxied health check
respond successfully; the existing copper project remains revision 67 with
three groups. The live preference remains its initial version 0, enabled.

Logs: `/tmp/athena-metadata-focused.log`,
`/tmp/athena-metadata-backend-full.log`,
`/tmp/athena-metadata-frontend-full.log`, `/tmp/athena-metadata-build.log`,
`/tmp/athena-metadata-typecheck.log`,
`/tmp/athena-metadata-browser-focused.log`, and
`/tmp/athena-metadata-native-replay.log`.

Web JSON and PRJ-sidecar retention pass, including restart and browser restore.
Native XDI serialization, full XDI families/comments/history editing, XDI data
exports, generated-project metadata cloning and actual desktop exchange
remain required. The eight existing downloaded project fixtures contain no
Perl `$xdi` object records; their passing exchange tests alone cannot prove
that serializer path. `Data/Athena.pm` calls Xray::XDI.serialize for this path,
and `Data/Prj.pm` restores the object/comments. Those boundaries need an
independent fixture and validation in subsequent work.


The complete **54-case Chromium run** finished with **53 passed and one
asynchronous test assertion failure (6.2 min)**. The X23A2MultiChannel test used
Playwright `check()` on a controlled switch that updates only after its saved
PUT. The trace showed **PUT 200** and the final snapshot showed the switch
checked, so the immediate assertion raced a successful save. The test now
clicks, waits for the save response and explicitly waits for the checked state,
as other registry browser tests already do. Both complete multichannel
workflows then passed (**2 passed, 21.9 s**), including native channel previews,
configuration and PRJ exchange. This is an affected-case rerun, not a claim
that the initial full run was green. The application code was unchanged by
this test correction.

Additional logs: `/tmp/athena-metadata-browser-full.log` and
`/tmp/athena-metadata-multichannel.log`. All test/build handles have terminated;
no background verification job remains. Browser output directories are
transient and are replaced by subsequent runs; the metadata screenshots were
reviewed before the multichannel rerun. The ordinary local app remains on
3004/8006. Native comparisons covered 693 captured metadata fields across
the 31 cases, with the documented date conversions checked separately.

## Native XDI acquisition-object exchange checkpoint — 2026-09-12

Implemented [XDI metadata display and native PRJ objects](athena-xdi-reference.md).
Official measured Cu/Fe XDI inputs retain all 756 observations and 2,676
original table values. The selected signal previews, original detector
columns, explicit absorber identity, versions, acquisition fields and comments
survive the relevant import/export paths. Native-object PRJ tests remove the
web sidecar before restoring; exact web metadata is separately verified.

Completed checks:

- Actual native Perl/C reader plus unchanged Demeter record writer: **3
  recorded cases passed** (Cu, Fe2O3, constructed escaped/Unicode metadata).
  Default replay reproduced every recorded object, array and PRJ record.
- Actual Perl Xray::XDI methods and clone/serializer accepted **5 web-emitted
  objects**, including newly constructed Larch and X11A metadata objects.
  The loaded Perl modules are checked against pinned source hashes. The Data
  bridge supplies already-read arrays; no desktop normalization/GUI is claimed.
- Backend full suite: **2,486 passed, 332 warnings, 210.04 s**. After this run
  started, two additional export-boundary tests and conversion of malformed
  export metadata to a recoverable input error were added. The final affected
  XDI suite passed **21 tests, 2.74 s**; this is not a claim of a single
  2,488-test full-suite execution. Valid exchange paths remained unchanged.
- Frontend full suite: **494 passed in 26 files, 48.16 s**. The focused XDI/
  beamline component suite passed **6 tests**.
- Production build and standalone type checking: **passed**.
- Focused real Chromium XDI and beamline flows: **4 passed, 34.2 s**, including
  full plotted arrays, changed columns, processing, refresh, actual download
  and independent native-object restore, plus 390 px mobile layout.

The initial XDI browser run passed Cu but timed out on a desktop-only **Open
project** toolbar locator at 390 px. The native File-menu item is **Open
project…**; the test now checks the menu's expanded state and selects that
actual item. The four-flow rerun above passed. This was a test-navigation
correction, not a repaired application import failure. Initial evidence and
the passing focused screenshots were preserved under
`/tmp/athena-xdi-browser-evidence/` before the full browser run.

The Cu desktop and Fe mobile metadata screenshots were visually inspected:
the desktop shows the live curve beside column selection and acquisition
fields; the mobile table remains within the dialog and readable while
scrolling. No live user project was used for test imports.

The source catalog now contains **211 unique source identities**, including
the actual XDI Perl/C sources, two measured inputs and three newly audited
Athena metadata UI/documentation files. The 107 requirement IDs/order and
their statuses remain unchanged. Native UI source shows field add/edit/delete
actions commented out: active controls to implement next are Save comments,
individual/all validation, required/recommended-field status and family
expansion controls. File/module presence is not evidence of an enabled feature.

An exploratory comparison at `/tmp/athena-xdi-validation-probe/report.json`
found **30/30 identical status codes and diagnostic strings** between real
Perl Xray::XDI and Larch's bundled native library. Cases cover valid/invalid
absorber symbols/edges, d-spacing, current/energy units, dates, first-column
labels and versioned/unversioned extension fields. This confirms a feasible
Larch backend path for the next controls; those controls are not implemented
by this checkpoint. It does not establish exhaustive dictionary compliance.

Logs: `/tmp/athena-xdi-replay.log`, `/tmp/athena-xdi-focused.log`,
`/tmp/athena-xdi-backend-full.log`, `/tmp/athena-xdi-frontend-full.log`,
`/tmp/athena-xdi-build.log`, `/tmp/athena-xdi-typecheck.log`,
`/tmp/athena-xdi-browser.log` (initial failure) and
`/tmp/athena-xdi-browser-rerun.log` (passing focused rerun).

The complete current Chromium suite subsequently finished with **56 passed,
6.6 min**, logged in `/tmp/athena-xdi-browser-full.log`. This includes the
previously corrected multichannel switch test, all three native PRJ browser
fixtures, both XDI workflows, all beamline workflows and the classic interface.
The final application export error handling was present in this browser run.
Passing artifacts are preserved under
`/tmp/athena-xdi-browser-evidence/passing-full/` as well as the transient
`frontend/test-results/` directory.

All verification handles are terminal. Source/fixture/oracle/harness checksum
checks, 211-source uniqueness, local links, 107 unchanged requirement IDs/order,
absence of Verified rows and `git diff --check` passed. Read-only live checks
returned HTTP 200 for the page on 3004, backend health on 8006 and proxied
health. The existing copper project was observed at version 76 with three
groups; tests used separate temporary workspaces and did not import into it.
No service restart, commit, push or branch change was performed in this chunk.

### File metadata controls: native validation and saved XDI comments

The active controls in pinned `UI/Athena/XDI.pm` are now implemented through
**Group → File metadata…**: versions, family expansion, required/recommended
presence, individual/all-field validation and saved XDI comments. The
[controls contract](athena-xdi-controls-reference.md) records the native
behavior, API, runtime ownership and remaining scope. The native commented-out
field editing handlers remain distinguished from enabled controls.

- Actual Perl/C validation and unchanged native Save-comments replay:
  **70 validation cases and 4 saved-comment cases passed**. Default replay
  reproduced the recorded codes, diagnostics, text and presence lists.
- The existing native exchange harness also passed after the extension-family
  export correction: **3 native reader/writer cases and 5 web-literal round
  trips** through actual Xray::XDI methods.
- Final backend full suite: **2,574 passed, 332 warnings, 230.32 s**. This run
  includes the missing-library error path and the `GSE` family-case PRJ
  restore/revalidation regression. An earlier 2,573-test run passed before
  those final changes; the final run supersedes it.
- Frontend full suite: **501 passed in 27 files, 49.99 s**. The seven focused
  controls tests also passed after the explicit textarea accessible label and
  test TypeScript correction. Final CSS/table accessibility changes are
  covered by the browser checks below.
- Complete Chromium suite: **59 passed, 6.9 min**. The final extension-family
  correction and independent PRJ revalidation assertion were included. UI
  polish was applied during this run, so its final layout was separately
  rerun: **3 passed, 24.3 s**.
- Final production build and standalone type checking: **passed**, using
  `.next-verify` independently of the live dev server.

The backend oracle comparisons preserve the native difference between
all-field and individual value casing and the native date validator's
calendar leniency. The comment flows verify frozen-group edits, independent
group notes, unchanged arrays/recipes/results, Undo/Redo, restart, explicit
stale-revision recovery and native PRJ exchange without the web sidecar.

During verification, one backend expectation was corrected from 422 to the
existing command route's 400 error contract. A build exposed unsupported
Testing Library `exact` options, which were removed. Initial browser runs
found an ambiguous Freeze-group test locator and an unreliable textarea
label for populated comments. The locator now selects the actual menu item;
the component now explicitly labels the textarea. Subsequent focused and
full browser runs passed. These initial failures were retained in the logs.

Final desktop field and mobile comment screenshots were visually inspected.
The duplicate visible table captions were removed while retaining accessible
table names. Disclosure buttons align left, action buttons have visible
borders, and the 390 px comment form fits within the dialog. Artifacts are
preserved under `/tmp/athena-xdi-controls-evidence/full-59/` and
`/tmp/athena-xdi-controls-evidence/final-layout/` before future browser runs.
All browser imports used isolated servers on 13004/18006 and temporary data
roots; the live local workspace was not used for test mutations.

Logs: `/tmp/athena-xdi-controls-replay.log`,
`/tmp/athena-xdi-exchange-final-replay.log`,
`/tmp/athena-xdi-controls-backend-final.log`,
`/tmp/athena-xdi-controls-frontend-full.log`,
`/tmp/athena-xdi-controls-frontend-focused-final.log`,
`/tmp/athena-xdi-controls-build-polish.log`,
`/tmp/athena-xdi-controls-typecheck-polish.log`,
`/tmp/athena-xdi-controls-browser-full.log`, and
`/tmp/athena-xdi-controls-browser-polish.log`. Earlier browser failures are
in `/tmp/athena-xdi-controls-browser.log` and
`/tmp/athena-xdi-controls-browser-rerun.log`.

This checkpoint implements the active metadata controls; it does not verify
all of IO-01 or full Athena parity. Processing history, XDI export options,
derived-group metadata cloning, legacy argument semantics and desktop GUI
replay remain open. No Artemis implementation is included.

The subsequent [native export audit](athena-data-export-reference.md) covers
the full current/marked/separate-file menu and pins the missing header and
numeric requirements. Actual Perl Text::Template and Larch execution recorded
**36 constructed observations**: 28 error-free tables and eight error cases,
two of which nevertheless wrote files. Default replay in a fresh directory
reproduced all numerical values, headers, labels and error classes. This is
reference discovery, not a claim that the web exporter or desktop workflow
has passed. Native selected-weight syntax, XANES label/background failures
and unequal-grid failure are explicitly retained as evidence for repairs.

All verification handles for this checkpoint are terminal. Final audit passed
for 227 unique source identities, downloaded export Git blobs, XDI/export
oracle and harness hashes, the reference Text::Template and local Larch writer
hashes, local documentation links, 107 unchanged IDs/order/statuses and
`git diff --check`. The source audit added 16 previously uncatalogued identities
from 20 inspected export-related source files. The full Athena goal remains
active, with all original requirement rows retained.

## Column-data export and metadata-preserving reopen checkpoint (2026-09-12)

**File → Export column data…** now provides current-group files, nineteen
marked-table data forms and individual marked files in a ZIP. The
[export contract](athena-data-export-reference.md) records the exact schemas,
native numerical comparisons, applied-value headers, grid handling and
remaining desktop checks. Larch `write_ascii` writes the numeric tables.
The preview and download use the same project revision; frozen groups can be
exported without modifying arrays, recipes, metadata or project versions.

The native reference now has **41 observations**: the previous 36 output
template cases plus five actual Larch derivative, phase, background,
flattening and interpolation products rendered by Perl Text::Template.
The default expanded replay passed. The original eight native error cases
remain recorded, including selected-weight syntax and XANES label/background
failures; the web implementation supplies valid files with correct labels.

Measured Cu/Fe XDI and X11A Cu acquisitions exercise all five current formats.
Focused cases cover all marked forms, fractional and per-group arbitrary
weights, normalization with flatten off, absolute energy with retained native
E0, unknown-E0 chi, detector-only data, optional I0, XANES zeros, q padding,
mixed-grid rejection, export preflight, comments, header equations and
case-insensitive ZIP-name collisions. The browser extracts actual ZIP files
and compares every weighted value; a separate flow downloads and reimports
all 408 measured Cu absorption values.

That reopen flow exposed an additional importer gap: XDI acquisition fields
were read only for `.xdi` filenames, so metadata in exported `.xmu`, `.nor`
and `.chik` files was silently omitted. The parser now recognizes the
first-line XDI signature independently of the extension. Tests cover six
renamed/BOM cases, a later comment that must not trigger detection, complete
metadata/array retention, real column previews and import of raw, normalized
and chi output. Explicitly selecting normalized input preserves the exported
norm values. The browser now also checks acquisition fields and comments
after reopening the downloaded `.xmu` file.

Terminal results:

- Final complete backend suite: **2,640 passed, 332 warnings, 207.04 s**.
  This includes the format-signature correction and all final numerical
  changes. The earlier 2,630-test run passed before the reopen extension;
  final focused parser/XDI/export checks also passed **112 cases, 5.92 s**.
- Complete frontend suite: **508 passed, 28 files, 46.25 s**. Six export
  component cases cover request choices, stale previews, invalid responses,
  retry, conflict handling and confirmed attachment bytes. A proxy regression
  checks the revision header and exact download bytes.
- Complete Chromium suite before the final parser correction:
  **62 passed, 7.4 min**. After the mobile single-column form adjustment,
  the three export cases passed again in **20.1 s**. After the parser change,
  export, XDI and beamline metadata flows passed **7 cases, 48.5 s**,
  including the stronger browser assertions on reopened metadata.
- Final production build and standalone TypeScript check: **passed**, in
  `.next-verify` independently of the live development server. These cover
  the final component/layout/proxy changes; subsequent product changes were
  confined to the Python importer.

Initial browser tests found that the Next API proxy discarded
`X-Athena-Project-Version`, preventing the browser from confirming a valid
download. The header is now forwarded and verified by both route and real
browser tests. An ambiguous test locator matched both a visible notice and
its copy in the header; it now selects the visible paragraph. The first
component run needed the existing jest-dom matchers imported. All corrected
checks passed. An initial provenance audit assumed every older catalog row
contained a Git-blob field; final verification instead checked each actual
template blob against the pinned Git tree and any recorded blob field.

Desktop and 390 px mobile screenshots were visually reviewed. The mobile
scope and format controls now occupy full-width rows, while wide numerical
tables scroll inside the dialog. Evidence was preserved before each browser
rerun under `/tmp/athena-data-export-evidence/`, including `full-62`,
`final-layout` and `reopen-final`. All browser data mutations used isolated
13004/18006 servers and temporary data roots. The live 3004/8006 workspace
was not used for test imports or commands.

Final logs are `/tmp/athena-data-export-backend-complete.log`,
`/tmp/athena-export-signature-focused.log`,
`/tmp/athena-data-export-frontend-full.log`,
`/tmp/athena-data-export-browser-full.log`,
`/tmp/athena-data-export-browser-final-layout.log`,
`/tmp/athena-export-reopen-browser.log`,
`/tmp/athena-data-export-build-final-layout.log`,
`/tmp/athena-data-export-typecheck-final.log` and
`/tmp/athena-export-products-replay.log`. The export fixture manifest now
records the expanded 41-case oracle and current harness hashes.

The final audit verified 234 unique source identities, SHA-256 and pinned Git
blobs for all 18 executed templates, oracle/harness/Text::Template/Larch-writer
hashes, local documentation links, `git diff --check` and all 107 original
requirement IDs, order and statuses. No row is promoted to Verified.
The [parameter-report source contract](athena-parameter-report-reference.md)
also identifies the separate all/marked Excel workflow and its 28 populated
columns. Spreadsheet implementation, complete desktop GUI comparisons,
processing-history/cloning coverage and the rest of the parity matrix remain
open. The full Athena goal remains active; no Artemis implementation was added.

## Parameter Excel report checkpoint (2026-09-12)

**Edit → Excel report on all groups… / Excel report on marked groups…** now
provides a section-based preview and an actual BIFF8 `.xls` download. The
[report contract](athena-parameter-report-reference.md) describes all 28
parameter columns, native positions/formats, effective-versus-saved values,
applicability notes and the remaining full-platform comparisons.

The native reference executes unchanged pinned `Report`, `header`, `row`
and `number2clamp` code using actual Spreadsheet::WriteExcel 2.40 and
Chemistry::Elements 1.081. GUI/data/clock accessors are constructed bridges;
the GUI file-picker and full processing pipeline are not executed. Both
scope files are independently read with xlrd, recording 140 populated data
cells, their types and display formats, column labels and merged ranges.
Thirteen clamp cases and all 118 element names are also recorded. Final
default replay passed, including SHA-256 hashes of the five actual loaded
native modules. This exposed the native `Aluminium` spelling, which the web
report now preserves while using the Larch backend's element database.

Final focused backend checks: **25 passed, 2.86 s**. They compare every
parameter cell against the native XLS files, then cover measured Cu,
normalized/XANES input, native JSON/difference/detector PRJ reports, frozen
groups, zero importance, arbitrary fractional weights, unavailable values,
saved fixed steps after processing failure, full numeric precision, literal
formula-like/Unicode labels, frozen panes and revision checks both before and
after generation. The project is unchanged by successful or rejected reports.

The complete backend suite passed **2,661 tests, 332 warnings, 210.84 s**.
This run included the initial 21 report tests. The final clamp explanatory
note, Aluminium mapping, three PRJ report regressions and all-element-name
assertion were completed afterward and covered by the final 25 focused
checks. These overlapping counts must not be added together.

The complete frontend suite passed **514 tests in 29 files, 49.55 s**. Six
report component cases cover exact scope/revision requests, preview-section
changes, empty marks, group-order validation, retry, late responses, revision
conflicts and invalid XLS bytes with busy-state recovery. Production build
and standalone TypeScript checks passed using `.next-verify`, independently
of the live development server.

The initial desktop/mobile Chromium run passed **2 tests, 14.6 s**. It
downloads real all/marked workbooks and uses an independent Python xlrd
process to compare every exported parameter value and each numeric cell
type with the confirmed preview. It includes frozen-group output, duplicate
labels, a Unicode label, mark ordering and a real cross-window version change
that prevents downloading until reload. The final refinement replay also passed
**2 tests, 14.6 s**, recorded in `/tmp/athena-report-browser-final.log`;
its downloads and screenshots are preserved in `/tmp/athena-report-evidence/final/`.

Both browser layouts were visually inspected. The 390 px dialog fits its
viewport; its numerical table scrolls horizontally inside the dialog, and
download/close controls remain usable. The actual downloaded all-group XLS
was opened by LibreOffice and converted to a temporary XLSX verification
copy. Artifact Tool imported that copy, inspected all parameter cells and
rendered the identity, full background, transform/plotting and note sections.
The headers, numeric/scientific formats and group labels were legible. A
formula-error scan matched zero cells; the report contains static scientific
parameters and does not claim spreadsheet recalculation behavior. The
delivered product remains XLS, with one worksheet and all native parameter
columns.

Initial reference-harness attempts exposed missing Cwd import, array-reference
construction and JSON serialization of xlrd cell-type arrays. Those bridge
issues were corrected without changing the pinned native source bodies.
An initial component conflict mock lacked the API envelope's required error
code; the corrected mock passed in the full suite. No unresolved product
failure from these checks remains.

Logs: `/tmp/athena-report-backend-full.log`,
`/tmp/athena-report-backend-focused-final.log`,
`/tmp/athena-report-frontend-full.log`,
`/tmp/athena-report-browser-focused.log`,
`/tmp/athena-report-browser-final.log`,
`/tmp/athena-report-build.log`,
`/tmp/athena-report-typecheck-final.log`,
`/tmp/athena-report-native-replay-final.log`,
`/tmp/athena-report-office.log` and `/tmp/athena-report-render-final.log`.
Initial browser evidence is preserved under `/tmp/athena-report-evidence/focused/`;
workbook visual evidence is under `/tmp/athena-report-render/`.

The fixture manifest verifies the native source, oracle, harness, loaded
modules and four downloaded Perl packages. The catalog remains at 234 unique
source identities. All 107 requirement IDs/order/statuses are retained and
no row is promoted to Verified. Full Athena parity, including the remaining
processing/UI/preferences/history work, is still open. The empirical-standard
workflow remains deferred with Artemis.

## MEE reflection, normalized removal and live plots (2026-09-12)

The preceding local-run request was verified against the actual checkout:
frontend 3004, backend 8006 and the frontend health proxy all returned HTTP
200. Those services and saved projects were left running. This continuation
adds a concrete Athena processing workflow; the full goal remains active.

**Process → Multi-electron excitation** now provides the native Reflection and
Arctangent algorithms, live normalized-data previews, E/k/R comparisons,
energy-shift picking and a corrected group inserted after its source. The
[MEE contract](athena-mee-reference.md) records units, accepted recipes,
parameter coercion, source preservation, revision checks and remaining native
comparison boundaries. The original raw-μ project subtraction is replaced by
the native normalized-input/clone/reprocess sequence. Standalone low-level
raw-unit arctangent calls remain a separate utility.

The official LaCoO3 PRJ was downloaded from pinned Demeter and verified by both
SHA-256 and Git blob identity. Its 405- and 333-point groups import through the
normal browser project-selection dialog, show normalized preview curves and
process successfully. The original MEE Perl method and actual Text::Template
rendering plus Larch template execution provide **12 reference cases** across
both measured scans, both algorithms, manual/recipe settings, negative/zero
amplitude and minimum broadening. Default replay passed exactly. These execute
native parameter handling, interpolation, broadening, padding and subtraction;
GUI, source background updates, cloning and XDI methods are explicit bridges.

The reference exposes native `amp ||= 1` replacing explicit zero with one.
The web keeps the documented zero-removal behavior instead. Negative amplitude
still becomes zero and broadening below 0.01 becomes 0.01 in both. Larch's
extrapolation before the shifted edge is explicitly zero-padded, as required by
the original Perl loop. The manifest records source, fixture, harness, Larch
reader/math and actual Text::Template module hashes.

Focused backend verification passed **123 tests, 2 warnings, 29.49 s**,
including all 19 new MEE cases plus existing API, detector and derived-identity
regressions. The complete backend suite passed **2,684 tests, 332 warnings,
216.67 s**. It covers the final backend code: normalized scale, exact numerical
models, preview/save arrays in all three spaces, frozen sources, scientific
identity, source order, one-time calibration, XANES, work limits, atomic batch
failure, Undo/Redo, native PRJ restore and stale HTTP requests. Counts overlap.

The full frontend suite passed **520 tests in 30 files, 51.38 s**. Six MEE
component cases cover original plots, matched scope/settings/revision, late
responses, save conflicts, invalid arrays, native clamp inputs and E/k picking
with stale-callback rejection. Production build and TypeScript checks passed.
After the responsive-style refinements, the final production build passed and
the six focused component cases passed again in **4.47 s**.

Desktop/mobile Chromium passed **2 tests, 18.5 s** after adding explicit
source/algorithm accessible labels. Screenshots then exposed clipping of the
mobile action row despite the earlier dialog-width check. The action buttons
were changed to a vertical layout, and their individual bounding boxes are now
checked against the dialog. That replay passed **2 tests, 18.7 s**. A final
rendered-axis/selected-tab verification also passed **2 tests, 18.5 s**.
All three exported plot arrays are compared with server arrays, a real mouse
click updates the energy shift, and saved μ values match the confirmed preview.
The mobile test checks negative-amplitude feedback, a cross-window conflict
that saves no group, reload, and successful recovery. Desktop Undo/Redo and
the actual corrected PRJ download are also exercised.

Visual inspection covers the desktop R comparison and the mobile energy plot
and complete action row. Both curves, legends, warnings and all three mobile
buttons remain inside the dialog; real DOM assertions confirm axis titles and
the selected plot space. Evidence is preserved in
`/tmp/athena-mee-evidence/{initial,replay,final,labels}/`.

Initial checks found seven project-command regression cases using the former
raw-unit edge-step contract; the tests now exercise normalized
project operations while retaining independent raw-unit utility checks.
The first native-reader inspection used an incorrect private attribute and was
corrected to the documented `AthenaGroup.groups` interface. The first browser
run timed out resolving exact source/algorithm labels; explicit accessible
labels fixed both failures. These failures and the mobile clipping are resolved.

Logs: `/tmp/athena-mee-native.log`, `/tmp/athena-mee-native-replay.log`,
`/tmp/athena-mee-compat.log`, `/tmp/athena-mee-focused.log`,
`/tmp/athena-mee-backend-full.log`, `/tmp/athena-mee-frontend-full.log`,
`/tmp/athena-mee-component-final.log`, `/tmp/athena-mee-build-final.log`,
`/tmp/athena-mee-typecheck-final.log`, `/tmp/athena-mee-browser.log`,
`/tmp/athena-mee-browser-replay.log`, `/tmp/athena-mee-browser-final.log` and
`/tmp/athena-mee-browser-labels.log`.

The primary catalog now contains **244 unique identities**; all 11 MEE source
and data files match their recorded hashes. All **107 original requirement
IDs, order and statuses** are unchanged; PR-15 gains subset evidence and is
not promoted to Verified. Complete native GUI/normalization comparison, XDI
clone history and the remaining Athena matrix stay open. No Artemis features
were added and the full Athena goal is not complete.

Final read-only live checks again returned HTTP 200 for the page, direct
backend health and frontend health proxy. The running backend's OpenAPI
document includes the new MEE preview route. No live scientific project was
created or changed by this verification.

### Acquisition metadata and processing history checkpoint — 2026-09-12

The [history contract](athena-xdi-history-reference.md) connects XDI acquisition
metadata and exact saved comments to copies/series, rebin, MEE, differences,
merge/sum and the other existing derived operations. Import-time rebin now
records history for both independently processed sample/reference channels.
Dispersive calibration inherits the pixel upload's metadata, not the standard's
acquisition. File metadata displays scan times and exact accumulated
Scan.process, with a readable explanation of inherited acquisition columns.

Source inspection corrected the first implementation's assumptions about
difference timestamps and Copy-series text. Native Diff keeps both times and
uses its own description; Series calls the ordinary copy routine. The contract
separately identifies the web's descriptions for operations without matching
native history calls and its one-rebin-entry-per-imported-channel policy.

The native harness recorded **30 real Xray::XDI clone objects** using the
unchanged Data::XDI routine and official measured Cu/Fe files. Every web clone
matches every field in these objects, including native NoClone defaults.
Another **30 web-emitted literals** were read and serialized by the actual Perl
module. A fresh default replay matched exactly. Modules actually loaded, source
routines, harness, fixtures and oracle are pinned by hashes. The initial
unseeded replay was unstable because Moose traversal can trigger source-file
rereads and Data::Dumper order varies. The reproducible reference fixes the
Perl hash seed without changing the native code; full desktop lifecycle and
other native hash orders remain outside this claim.

The final focused backend suite passed **52 tests in 5.41 s**. It includes all
30 native object comparisons, source/hash audits, the connected transforms,
current identity, comments, frozen-source reads, atomic failure, Undo/Redo,
restart, import rebin, bare PRJ restore, independent Larch Athena reading and
column-file headers. Full backend regression produced **2,735 passes and one
failure, 332 warnings, 220.74 s**: the new manifest test had been collected
before its incorrect repository-root path was corrected. The final 52-test
run includes the corrected manifest case and passes it. This is recorded as
a full run plus a successful focused correction, not a second all-green full
run. Initial focused tests also corrected assumptions about rebin's retained
detector arrays, three-scan example insertion and the preview method name;
these were test errors, resolved in the final focused suite.

The full frontend suite passed **522 tests in 30 files, 53.95 s**. The nine
metadata component cases include literal/multiline history rendering,
read-only acquisition fields, revision refresh and the existing comment and
validation controls. Production build and the explicit TypeScript check pass.

The first Chromium run passed **5 tests in 42.2 s**: desktop/mobile derived
history and existing XDI/beamline comment controls, including conflicts and
native-only PRJ restore. Screenshots prompted a contrast improvement to the
new history hints. The final Chromium run passed **4 tests in 37.0 s**:
desktop/mobile history plus the existing official Cu/Fe live-column workflows.
The latter compares rendered Plotly values after changing the column mapping,
and both native-only project round trips preserve metadata and measurements.
These runs overlap; their counts must not be summed as distinct cases.

Desktop and 390 px screenshots were inspected. The final mobile history card
shows complete scan times and process text without horizontal clipping, and
its explanatory text is legible. Evidence is preserved under
`/tmp/athena-xdi-history-evidence/{initial,final}/`; the prior MEE browser output
was preserved under `before-history/` before the first new run.

Key logs: `/tmp/athena-xdi-history-native-stable.log`,
`/tmp/athena-xdi-history-native-confirm.log`,
`/tmp/athena-xdi-history-final-52.log`,
`/tmp/athena-xdi-history-backend-full.log`,
`/tmp/athena-xdi-history-frontend-full.log`,
`/tmp/athena-xdi-history-build.log`, `/tmp/athena-xdi-history-typecheck.log`,
`/tmp/athena-xdi-history-browser.log` and
`/tmp/athena-xdi-history-browser-final.log`.

The primary catalog now contains **250 unique identities**. The 107 original
requirement IDs, order and statuses are unchanged. IO-01 and PR-15 gain linked
subset evidence without being promoted to Verified. Complete Athena parity,
exhaustive derived/multichannel metadata behavior and native desktop GUI
exchange remain unproven. No Artemis work was introduced.

Final read-only checks returned HTTP 200 from the running frontend on 3004,
backend health on 8006 and the frontend health proxy. Browser tests used only
isolated 13004/18006 services and temporary projects; live scientific projects
were not edited. Final whitespace, fixture hashes, local reference links,
primary-source uniqueness and original requirement identities/statuses pass.

## Smoothing checkpoint — 2026-09-12

The [smoothing contract](athena-smoothing-reference.md) implements the four
named algorithms in PR-09 with raw original/filtered comparison, E/k/R views,
explicit boundary counts, native parameter adjustments and creation of a new
group after the source. The old generic two-field form is replaced. Frozen
groups are readable, and saving requires the preview's exact source, settings
and revision. The saved response is checked against both preview arrays.
Acquisition metadata/history, input meaning, scientific identity and accepted
calibration survive derived-group creation, Undo/Redo, restart and native-only
PRJ exchange. The previous local-runtime turn confirmed the requested services
were live; this continuation makes implementation and verification progress
toward the unchanged Athena objective.

Native execution recorded **36 cases** and a fresh default replay matched the
whole oracle exactly. Unmodified Demeter Perl routines use actual PDL and
PDL::Filter::Linear; unchanged templates are rendered by Text::Template and
executed by Larch. Three-point reference data come from the original compiled
IFEFFIT `f1mth` routine, including original support code and includes. Official
Cu/Fe measurements and constructed endpoint impulses cover all algorithms,
native clamps, odd/even windows and edge handling. All coordinates match
exactly; all numerical values match at `atol=rtol=2e-14`.

Actual PDL execution corrected an initial precision assumption: `xvals`
promotes the Gaussian constructor to double precision. The production kernel
was corrected before recording the oracle. Native boxcar/Gaussian also remove
one extra right-hand observation; the web reproduces and reports that crop.
Original SG/three-point group names do not contain the comma used by the
boxcar/Gaussian names; source review corrected this distinction too. All
reference dependencies were downloaded/extracted under `/tmp`, with package
SHA-256 checks. No Perl/Fortran dependency was added to the production server.

The initial focused backend run had **54 passes and six failures** from test
setup/assertions: a kernel leaving exactly ten points was valid; a newly
constructed chi input had incorrectly inherited a detector table on another
grid; and the direct store's ValueError was expected as the narrower HTTP
exception. The corrected run passed **60 tests in 4.58 s**. Extended tests then
had **74 passes and four failures** because they incorrectly expected a
normalized array for detector counts. Detector inputs deliberately have none;
the corrected assertions verify raw counts and unavailable normalization.

The final **full backend suite passed 2,814 tests, 356 warnings, in 228.09 s**.
It includes all **78 smoothing tests**, provenance checks, μ(E)/normalized/χ(k)
round trips, XANES/counts/difference eligibility, frozen source preservation,
calibration materialized once, batch insertion order/marking, atomic rollback
and HTTP conflicts. This all-green run also includes the prior XDI-history
manifest correction that previously had only a focused passing rerun.

The new component suite passed **12 tests in 10.28 s**. The **full frontend
suite passed 534 tests in 31 files, 52.84 s**. Source/revision changes and late
responses invalidate the old result; malformed curves/counts and mismatched
save results cannot be accepted. Algorithm controls retain independent drafts,
and failed saves release busy state while preserving the current choices.
The production build and final explicit TypeScript check both passed.

The first browser run failed both cases because the new test selected a
Measurement dropdown that is absent in the Athena column form. The corrected
test uses the actual numerator/denominator/Natural log checkboxes and compares
the rendered import curve with the measured file. The corrected smoothing run
passed **2 tests in 33.7 s**. After improving text contrast, smoothing plus the
existing measured Cu/Fe XDI workflows passed **4 tests in 45.8 s**. A final
smoothing run passed **2 tests in 32.5 s**, explicitly checking active E/k/R
button state and capturing screenshots after CSS transitions finish. These
runs overlap and are not eight distinct browser cases.

The desktop flow imports all 408 Cu observations through the live column plot,
runs all four methods, compares every displayed Plotly coordinate/value with
each backend preview in E/k/R, saves each derived group, inspects XDI history,
uses Undo/Redo, downloads a PRJ and reimports it after removing every web
sidecar line. All five groups retain their raw arrays and processing history.
The 390 px flow checks Gaussian width/size adjustments, action bounds,
cross-window revision failure, preserved draft/source and successful recovery
after reload. The additional Cu/Fe XDI regressions verify live column changes
and independent native-project exchange.

Desktop and mobile control/plot/action screenshots were visually inspected.
Early screenshots caught the previous active-button color during the shared
120 ms CSS transition; the final snapshots fast-forward animations and show
the selected E button with the energy plot. No production state discrepancy
was observed. Labels/hints now have 6.35:1 contrast on white and adjustment
messages 6.00:1 on their background. Mobile controls and actions fit within the
dialog without horizontal overflow; the plot and action area remain reachable
by vertical scrolling. Evidence is preserved under
`/tmp/athena-smoothing-evidence/`, including the preceding browser results,
the failed first run, passing runs and final settled screenshots.

Key logs: `/tmp/athena-smoothing-replay.log`,
`/tmp/athena-smoothing-fixed.log`, `/tmp/athena-smoothing-extended.log`,
`/tmp/athena-smoothing-full-backend.log`,
`/tmp/athena-smoothing-full-frontend.log`,
`/tmp/athena-smoothing-build.log`,
`/tmp/athena-smoothing-typecheck-final.log`,
`/tmp/athena-smoothing-browser-fixed.log`,
`/tmp/athena-smoothing-browser-final.log` and
`/tmp/athena-smoothing-browser-settled.log`.

The primary catalog now has **261 unique identities**; source/fixture hashes,
reference links and whitespace checks pass. All **107 original requirement
IDs, ordering and statuses remain unchanged**. PR-09 has linked evidence but
retains Pending. Native SG preference persistence and panel-session retention,
full preference exchange, and a complete desktop normalization/GUI replay
remain open. The reference uses explicit group-access/update bridges and
does not prove whole-desktop equivalence. The method-less legacy API is still
separate. Complete Athena parity remains unproven; no Artemis work was added.

Final read-only checks returned HTTP 200 for the live frontend (3004), backend
health (8006) and frontend health proxy. Process working directories match
this checkout. Browser tests used isolated ports 13004/18006 and temporary
projects; no live scientific project was changed, and no service restart was
required.

## Effective SG preferences and retained smoothing controls — 2026-09-12

The [preference contract](athena-smoothing-preferences-reference.md) corrects
an earlier assumption: unchanged native Config parsing and bound resolution
return SG **31/9**, although the file's literal defaults say 31/4. The earlier
36-case kernel oracle only supplied explicit configuration values. It did not
establish the effective default. Its explicit-setting evidence remains valid.

Thirteen new native observations execute Config parsing/defaults, the actual
INI reader/writer, shared UI Apply control flow and original Larch template.
Twelve complete measured Cu arrays match at `atol=rtol=2e-14`; window/order
39/39 records the real Larch/NumPy `UFuncTypeError`. The web reports a
recoverable lower-order error. Fresh replay of all thirteen passed. Bridges
for wx values, callbacks and Moose accessors remain explicit; this does not
constitute a rendered whole-desktop or full normalization replay.

Apply, Apply and Save, current/saved/factory values, independent-process
restart, external writers, failed persistence and stale server/window guards
are covered. The reviewed preview captures its settings before a later
preference change. Shared kernel/repetition controls and explicit SG drafts
survive closing and reopening the tool. Late preference loads, even after
reverted edits, cannot overwrite committed drafts; hidden SG changes do not
invalidate an accepted boxcar preview. These preferences remain a separate
store; general INI exchange and global all-group saving are still open.

All previously launched processes were polled to terminal success. The full
backend baseline passed **2,842 tests, 371 warnings, in 234.82 s**. It began
before the last full-pair request validator and its three tests were added;
the final focused smoothing/preference run passed **109 tests, 40 warnings,
in 8.38 s**, including that final change. Do not report 2,845 as an executed
full-suite result. The first focused run had 105 passes/one failure because
its assertion expected TypeError instead of the actual UFuncTypeError name;
that expectation was corrected. The final full frontend run passed **544
tests in 32 files, 56.55 s**. The production build, including TypeScript,
passed after removing an unsupported Testing Library query option from a test.

The final browser run passed **four cases in 1.1 minutes**: measured Cu with
all filters/E/k/R/Undo/PRJ, mobile Gaussian/conflict recovery, and desktop/mobile
SG Apply/Save with two windows, stale-write recovery, retained fields and
preview-matched group creation. This rerun includes the collapsible preference
section and final preview key; the earlier four-case run overlaps and is not
four additional cases. Final desktop compact/expanded SG and mobile expanded
screenshots were inspected: the compact plot and save actions fit together,
and expanded preferences remain readable/reachable by vertical scrolling
without horizontal overflow. Copies are retained at
`/tmp/athena-smoothing-preferences-evidence/final-browser/`.

Logs: `/tmp/athena-smoothing-preferences-full-backend.log`,
`/tmp/athena-smoothing-preferences-tests-final.log`,
`/tmp/athena-smoothing-preferences-full-frontend-final.log`,
`/tmp/athena-smoothing-preferences-build-final.log` and
`/tmp/athena-smoothing-preferences-browser-final.log`. The preference checkpoint
has 263 unique primary identities; subsequent convolution research adds more.
All 107 original IDs, ordering and statuses are unchanged. PR-09/UI-11/IO-03
have updated subset evidence only. Full Athena parity remains unproven and
Artemis is excluded. Read-only frontend/backend/proxy checks on 3004/8006
returned HTTP 200, with process working directories matching this checkout.

## Native Larch convolution and artificial noise — 2026-09-12

The [convolution contract](athena-convolution-reference.md) replaces the
workbench's generic convolution path with actual `larch.math.smooth`, following
the original Larch template. The complete panel now has Gaussian/Lorentzian
width, edge-step-relative normal noise, zero defaults, original/modified E/k/R
plots, retained controls, fresh-noise replot and preview-matched group save.
Normalization is recalculated after broadening before obtaining the noise
scale; the modified raw signal is then processed again. A private seeded
NumPy RandomState preserves the displayed realization on save without changing
global RNG state. Consecutive batch seeds follow project order. Native-style
source insertion, frozen-source copying, original retention and Undo/Redo are
implemented. Acquisition metadata and explicit web noise provenance survive
bare native PRJ exchange; this history text is not claimed to be emitted by
the original ConvoluteNoise panel.

Twenty-five executed native cases use original `ConvoluteNoise::get_values/plot`,
`Data::Process::convolve/noise`, actual Text::Template and unchanged Larch
convolution/noise templates. Measured Cu/Fe, endpoint impulses, zero copies,
Gaussian/Lorentzian broadening, combined/independent noise, negative-control
coercion and lower-level chi-noise are covered. All output arrays match at
`atol=rtol=2e-14`, and fresh native replay reproduced the oracle exactly.
The first reference attempt selected the fourth column of a three-column Fe
file; it failed before recording. The corrected measured mu column is used.
Wx/clone/plot and normalization-update bridges remain explicit. In particular,
the reference supplies an edge step; it does not establish whole-native
normalization equivalence. The web deliberately rejects negative values and
repairs the native panel's chi-noise argument error; these differences are
recorded in the contract.

The first integration run passed 155/156 tests and exposed a work budget that
excluded the bundled 612-point copper foil. The budget now matches existing
MEE's 100-million estimate and admits the measured Cu 10/50 K grids while
rejecting pathological allocations before Larch is called. No interpolation
or kernel was substituted. The next expanded run had 184 passes/19 failures:
18 new cases used an incorrect test-fixture save signature, and an old test
still expected the derived group at the end instead of directly after its
source. After fixing those test assumptions, two negative-path tests still
used a pre-save revision; updating their tokens completed the checks. The
final focused run passed **203 tests, two warnings, in 39.56 s**, including
**47 new convolution tests**. These cover exact reference arrays, distribution,
private/concurrent RNG use, same-seed/fresh-seed behavior, atomic failures,
raw/type/calibration preservation, effective edge-step capture, bare native
PRJ history/data round trips and HTTP stale preview/save behavior.

The new component suite passed **13 tests in 9.26 s**. The full frontend suite
passed **557 tests in 33 files, 52.24 s**, and the production build including
TypeScript passed. An initial typecheck had found an obsolete comparison in
the generic dialog after convolution moved into its own panel; that unreachable
UI fragment was corrected before the successful build.

Both first browser cases stopped at the test's label-text lookup for the
nested line-shape select. Inspection confirmed the accessible combobox and
visible panel were present. Using the actual combobox role fixed the locator;
the second run passed **two browser cases in 34.3 s**. The desktop case imports
all 408 Cu points through the live detector-column plot, exercises zero-copy,
broadening-only, noise-only and combined modes, compares every Plotly x/y
value in E/k/R, verifies saved arrays and captured seeds, uses Undo/Redo and
reimports the downloaded five-group PRJ after removing every web sidecar.
The 390 px case verifies fresh noise on replot, retained controls,
cross-window stale-save rejection, source preservation,
reload recovery and an exact saved noisy curve. Original and modified raw
arrays survive the independent project exchange.

Final desktop and mobile controls/plot/action screenshots were inspected.
The desktop plot, parameters and save actions fit together; the mobile layout
has no horizontal overflow and all controls/axes/actions are reachable by
vertical scrolling. Evidence is retained at
`/tmp/athena-convolution-evidence/first-browser/` and
`/tmp/athena-convolution-evidence/final-browser/`.

Key logs are `/tmp/athena-convolution-native.log`,
`/tmp/athena-convolution-replay.log`,
`/tmp/athena-convolution-regressions.log`,
`/tmp/athena-convolution-focused.log`,
`/tmp/athena-convolution-focused-fixed.log`,
`/tmp/athena-convolution-focused-final.log`,
`/tmp/athena-convolution-component.log`,
`/tmp/athena-convolution-full-frontend.log`,
`/tmp/athena-convolution-build.log`,
`/tmp/athena-convolution-browser.log` and
`/tmp/athena-convolution-browser-fixed.log`.

The primary catalog contains **271 unique identities**. Both new reference
manifests, local documentation links and whitespace checks pass. All **107
original requirement IDs, ordering and statuses remain unchanged**; PR-10 has
linked subset evidence. Native whole-application/normalization/background/FFT
replay and long-job behavior remain open. Full Athena parity is unproven and
Artemis remains excluded. Browser tests used 13004/18006 and isolated temporary
projects; no live scientific project was mutated.

The final **full backend suite passed 2,892 tests, 371 warnings, in 221.32 s**
(`/tmp/athena-convolution-full-backend.log`). This run includes all 47 new
convolution cases, the three final complete-SG-request checks and the changed
project insertion/history semantics. The entire launched suite finished
successfully; the count is an executed result, not a sum of partial runs.

The final explicit TypeScript check also passed
(`/tmp/athena-convolution-typecheck-final.log`). Final read-only checks returned
HTTP 200 for frontend 3004, backend health 8006 and the frontend health proxy.
No manual service restart was required. Final reference hashes, 271 unique
source identities, whitespace and the unchanged 107-row matrix were rechecked.

## 2026-09-12 — In-place deglitching and snapped truncation

Continued PR-07/PR-08 against the original Demeter methods and templates.
The [point-edit reference](athena-point-edit-reference.md) records native
rules, exact source identities, measured files, web behavior and fidelity
limits. No original requirement status was promoted. The active full-Athena
goal remains incomplete; Artemis remains excluded.

The native reference records **30 cases** across measured ORP5.000 and
ZT20.000 (586 rows each) and a constructed boundary/spike probe. Both initial
recording and fresh independent replay passed. Tests compare retained raw
energy/signal values, exact indices and margins. The oracle also preserves
the native Larch detector-template corruption; web behavior deliberately
keeps all detector/source arrays aligned to the retained observations.
Separate native HXMA execution on both measured inputs confirmed all values
in the 586 × 11 fallback tables and the generic energy-channel suggestion.
Its source hash was checked against the primary catalog; outputs and drivers
remain at `/tmp/athena-point-edit-hxma-native/`.

The command now edits the same group rather than appending an interpolated
or trimmed derivative. Preview covers single points, margins and before/after
truncation, plus read-only initial μ(E)/χ(E) inspection. Changes preserve
data identity/calibration/provenance, synchronously slice detector and source
columns, append XDI history and recompute transitive background consumers.
Frozen protection, atomic errors, revision checks, Undo/Redo and both sidecar
and bare native PRJ exchange are exercised. Invalid post-removal recipes clear
processed curves and report their errors while retaining inspectable raw data.

The first existing-regression run exposed **11 obsolete derived-group /
interpolation assumptions**. Those expectations were changed to native
in-place deletion, while preserving the existing independent helper tests.
The affected 156 tests then passed. The first dedicated suite passed 66/68;
two measured-margin tests selected no observations at tolerance 0.02. Direct
residual checks showed that 0.002 selects 122 ORP and 118 ZT observations under
the explicit test normalization recipe, so those tests now exercise real
removal without modifying the measured fixtures. A dependency test initially
used a nonexistent `freeze` command; replacing it with the actual metadata
command produced two passing point-removal dependency tests. The initial
component type check also caught a Testing Library `exact` option copied
from Playwright; the unsupported test option was removed.

Final **full backend: 2,962 passed, 371 warnings, 239.30 s**, including all
68 dedicated point-edit cases and two added transitive-dependency cases.
Final **full frontend: 569 passed in 34 files, 55.58 s**, including 12
point-edit component cases. Production build and explicit TypeScript checks
passed. These are complete executed suite results, not sums of partial runs.

Browser tests use real imported files and isolated projects on 13004/18006.
The first run exposed an asynchronous registry-checkbox assertion and the
old CLS headers' generic HXMA mapping. Waiting for the saved checkbox state,
explicitly selecting feedback energy/I0/I1 and comparing every live plotted
coordinate resolved those checks. The desktop workflow then passed; the
mobile marked-truncation test had not marked any groups. After marking the
groups through the UI, both cases passed in 31.3 s. Visual inspection of the
tight margin case showed a real AUTOBK processing warning, so the final
browser assertions also require the saved error to match the preview and
the saved processed result to be null. Both final cases passed in **30.9 s**.

Desktop coverage includes actual Plotly point clicks in μ(E) and χ(E), the
selected marker coordinates, pink margin arrays, in-place saved raw/source
arrays, both snapped boundary rules, Undo/Redo and downloading/reimporting a
PRJ after stripping the web sidecar. Mobile coverage includes a 390 px
layout without horizontal overflow, retained raw data after a two-window
stale-save rejection, reload recovery, marked truncation and an unchanged
frozen group. Screenshots of desktop χ(E), margins, mobile plots and controls
were inspected: axes, selected measurements and actions are readable, with
vertical scrolling on mobile. The deliberately tight tolerance is a test
of selection/error handling, not a recommended scientific cleanup setting.

Evidence directories are `/tmp/athena-point-edit-evidence/first-browser/`,
`second-browser/`, `final-browser/` and `verified-browser/`. Earlier browser
evidence was copied before Playwright cleared its output directory.
Key logs are `/tmp/athena-point-edit-replay.log`,
`/tmp/athena-point-edit-regressions-current.log`,
`/tmp/athena-point-edit-focused.log`,
`/tmp/athena-point-edit-focused-final.log`,
`/tmp/athena-point-edit-graph.log`,
`/tmp/athena-point-edit-component.log`,
`/tmp/athena-point-edit-full-backend.log`,
`/tmp/athena-point-edit-full-frontend.log`,
`/tmp/athena-point-edit-build.log`,
`/tmp/athena-point-edit-typecheck-verified.log` and
`/tmp/athena-point-edit-browser-verified.log`.

The catalog contains **286 unique identities**. The new manifest hashes,
local documentation links and whitespace checks pass. All **107 original
requirement IDs, ordering and statuses remain unchanged**. Live frontend
3004, backend health 8006 and frontend health proxy return HTTP 200; no live
scientific project was mutated or service manually restarted.

## 2026-09-12 — Calibration display, reference selection and cumulative shifts

Continued PR-01 against the original Calibrate panel, E0 method and display
templates. The [calibration reference](athena-calibration-reference.md)
records the complete source/coordinate contract, native comparison scope,
application behavior and remaining differences. The preceding local-run turn
verified the correct checkout and live frontend/backend/proxy; reinspection of
the pending calibration browser log showed both workflows had completed, so
that process was not restarted. No original requirement status was promoted.

The native recording and a fresh replay both passed **68 cases** on official
Cu metal and Fe2O3 measurements. Original Perl UI methods and suffix/zero
selection run unchanged through explicit widget/data bridges. Original Larch
templates execute raw first/second derivatives and SG; the original compiled
Ifeffit smoothing opcode supplies repeated three-point results. Independent
Larch normalization supplies recorded normalized/flat inputs, so this does
not claim complete native normalization or wx dispatch. Source/fixture/kernel
hashes and all native displayed values are checked by backend tests.

The new panel opens in the first derivative, offers all four native displays,
supports typed or plotted references and target energies, and reports the
rounded total shift and actual reference landing energy before saving. Display
smoothing leaves source arrays unchanged; zero search uses the unsmoothed raw
second derivative. The backend captures shared SG values, stages calibration
on a copy, updates linked groups once and recalculates background dependents.
Save retains the existing group and raw/source arrays. Frozen dependencies,
version conflicts, Undo/Redo and bare native project exchange are exercised.

Additional review found that an explicitly misspelled coordinate mode could
fall through to the old raw-coordinate command. Explicit coordinate fields
now always enter strict calibration validation; four invalid modes are tested
against both preview and save without mutation. Background integration tests
independently recalculate a two-hop chain in both group orders and verify
protection of a frozen transitive consumer. Component tests also ensure picks
from the shifted overlay are ignored and a zero-search error remains visible
after the workbench exits its busy state and resumes previewing.

The first native harness execution lacked the App `modified` bridge; adding
the explicit bridge allowed the unchanged original method to run. An early
TypeScript check caught the obsolete generic calibration branch after the new
modal narrowed its type. A later check found an unsafe test-only Plotly layout
property access; that assertion now uses a structured partial matcher. Both
were corrected before the final build/typecheck. The first measured normalized
reference test also exposed the existing strict fit-window boundary: moving
E0 by +3 eV put saved norm2 beyond the measured endpoint. The valid refit test
now moves E0 by −3 eV, and a separate test retains the +3 eV failure, confirms
its visible preview error and verifies that saved invalid processing clears
the result. Native clipping at that boundary remains explicitly open.

Final **full backend: 3,061 passed, 391 warnings, 231.70 s**, including all
96 dedicated calibration cases and three added dependency cases. The earlier
expanded calibration/background run passed **157 tests**. Final **full
frontend: 584 passed in 35 files, 53.00 s**, including 15 calibration component
cases. Production build and the separate final TypeScript check both passed.
These totals come from complete executed suites, not sums of partial runs.

Both isolated Chromium cases passed in **28.9 s**. Desktop testing compares
all live Cu import-preview coordinates during column selection, exercises four
calibration displays, three-point/SG smoothing, zero search and exact save,
then checks Undo/Redo and downloads/reimports a PRJ with its web sidecar removed.
Mobile testing uses a real Plotly point click at 390 × 844, retained smoothing
controls, read-only cancel, two-window stale-save rejection and reload recovery.
The desktop SG/zero plot and mobile plot/actions screenshots were inspected:
curves, axes, reference marker and controls are readable, with vertical scroll
and no horizontal dialog overflow. The browser tests preceded the final strict
invalid-coordinate dispatch fix; their valid `displayed` path is unchanged and
covered again by the final backend tests. No frontend runtime code changed
after the browser run.

Browser evidence was preserved at `/tmp/athena-calibration-evidence/initial-browser/`
before any future Playwright output cleanup. Earlier point-edit evidence is
also preserved at `/tmp/athena-calibration-evidence/before-calibration/`.
Key logs: `/tmp/athena-calibration-replay.log`,
`/tmp/athena-calibration-expanded.log`,
`/tmp/athena-calibration-component-final.log`,
`/tmp/athena-calibration-full-backend.log`,
`/tmp/athena-calibration-full-frontend.log`,
`/tmp/athena-calibration-build.log`,
`/tmp/athena-calibration-typecheck-verified.log` and
`/tmp/athena-calibration-browser.log`.

The [deconvolution source inspection](athena-deconvolution-reference.md) also
confirms that pinned Athena's panel contains a placeholder and documentation
button, with no algorithm, matching both TODO manuals. The current web Larch
deconvolution extension remains available; it is not promoted as native parity.

The catalog now contains **292 unique source identities**. All 14 local
calibration/deconvolution source files matched their catalog SHA-256 and,
where recorded, Git blob identities. The calibration manifest's harness,
oracle, input, Larch kernel and compiled smoothing-library hashes matched;
new documentation links and `git diff --check` passed. All **107 original
requirement IDs, ordering and statuses remain unchanged**. The full goal is
still incomplete, including normalization boundary behavior and other entries
in the matrix; Artemis remains excluded. Final read-only checks returned
HTTP 200 for the live frontend, backend health and frontend health proxy, and
OpenAPI contains both calibration preview/zero routes. No live scientific
project was mutated and no development service was manually restarted.

## 2026-09-12 — Requested normalization limits and measured fit support

The preceding goal turn made verified calibration progress and left a concrete
outer-fit-boundary failure. This follow-up closes that failure across shared
normalization, fractional E0/enforced import, native PRJ restore and calibration.
The [boundary reference](athena-normalization-limits-reference.md) states the
verified behavior and remaining native differences. SC-01/PR-01 evidence was
updated without changing the original requirement scope or statuses.

Original Demeter `process/larch/normalize.tmpl` passes requested pre/post-edge
limits to Larch. `Calibrate.pm::OnCalibrate` changes E0 and total shift but
leaves those request fields intact. The new native driver executes that
unchanged method through explicit field/widget bridges, renders the unchanged
template with Perl Text::Template, and executes its commands in Larch. It
imports no web processing or limit resolver. **54 measured cases / 108 native
normalization dispatches** cover Cu/Fe, three existing shifts, three reference
offsets and pre/post/both endpoint requests. Recording and fresh replay passed;
all normalized, flattened, pre-edge and post-edge values plus effective limits
and step are compared by the dedicated suite. This is original template/method
execution with Larch, not a complete Demeter Data/wx or Ifeffit pipeline.

Requested pre1/norm2 now remain in the recipe; actual fits intersect their
outer endpoints with measured support on every calculation. Effective limits
appear in processing results/warnings, saved-result parameter readouts and
calibration preview. Native-only PRJ restore no longer permanently replaces
those two requests with their effective values. Automatic endpoint behavior
and separate spline/FT compatibility resolutions remain unchanged. Intervals
without usable measured overlap still fail. Moving E0 back restores the
usable requested range rather than retaining a previous shortened interval.

The normalized calibration overlay is now independently refitted with the
proposed E0 and rounded total shift. This includes the small E−E0 difference
caused by 0.001 eV rounding instead of merely translating old normalized y
values. Backend tests and actual browser saves compare the resulting complete
normalized array with the reviewed overlay. Raw energy/signal and source
detector arrays remain unchanged; Undo/Redo and web/bare-native project exchange
retain both requests and applied calibration.

The first affected-science run passed **628 tests** and exposed **8 obsolete
explicit-outer-endpoint rejection expectations**. These were changed to native
resolution/retained-request assertions or to genuinely unsupported inner
intervals. Import tests additionally compare the resolved fit to direct Larch.
The initial new dedicated suite passed **112 tests**. A later review added
linked-reference limit reporting and its regression, bringing that dedicated
file to **113 cases**; limits now include the whole tied family and its
background dependents.

The complete backend run passed **3,173 tests, 391 warnings, 245.98 s** before
that final linked-reference reporting adjustment. After the adjustment,
the complete affected normalization/calibration/background suites passed
**270 tests, 20 warnings, 28.96 s**, including the new reference case. The
backend full suite was not rerun for this response-field-only refinement;
3,174 is not reported as an executed full-suite result. The final frontend
suite passed **586 tests in 35 files, 61.46 s**. Production build and a separate
final TypeScript check both passed.

The first browser run passed the two existing desktop/mobile calibration
workflows, but the two new endpoint cases failed on test code: Playwright
requires string values in `toHaveValue`, unlike Testing Library's numeric
assertion. TypeScript independently caught the same two assertions. After
correcting them, the two new measured-boundary workflows passed in **20.7 s**
at 1500 × 1150 and 390 × 844. They import real Cu through the live column
preview, edit limits through the parameter UI, verify retained requests and
visible effective values, calibrate using a fractional observed reference,
compare every saved normalized value with its separately refitted preview,
then download and reimport a PRJ with the web sidecar removed. No application
failure was suppressed or mocked. Desktop plots and mobile boundary readouts
were visually inspected; the dialog scrolls vertically without horizontal
overflow. The deliberately large outer requests exercise clipping; they are
not a suggested scientific fitting recipe.

Evidence is preserved at `/tmp/athena-normalization-limits-evidence/first-browser/`
and `final-browser/`. Logs include
`/tmp/athena-normalization-limits-native.log`,
`/tmp/athena-normalization-limits-replay.log`,
`/tmp/athena-normalization-limits-regressions.log`,
`/tmp/athena-normalization-limits-focused.log`,
`/tmp/athena-normalization-limits-full-backend.log`,
`/tmp/athena-normalization-limits-final-regressions.log`,
`/tmp/athena-normalization-limits-full-frontend.log`,
`/tmp/athena-normalization-limits-browser.log`,
`/tmp/athena-normalization-limits-browser-final.log`,
`/tmp/athena-normalization-limits-build.log` and
`/tmp/athena-normalization-limits-typecheck-final.log`.

The manifest's source, input, driver, oracle and Larch kernel hashes match.
The primary catalog remains **292 unique identities**; it already contained
the required template and calibration sources. All **107 original requirement
IDs, order and statuses remain unchanged**. New documentation links and
whitespace checks pass. Inner-endpoint repairs, sparse polynomial reduction,
complete normalization/flattening dispatch and the other open Athena features
remain within the active goal; Artemis is excluded. Read-only live checks of
frontend 3004, backend health 8006 and the frontend health proxy all returned
HTTP 200. No live scientific project was mutated or dev service manually
restarted.
