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
automatic endpoint adjustments. Samples and references are initialized
independently before one atomic project save. Invalid coverage or a bad
reference fails the import with the upload retained for retry.

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
mode. Athena's full difference representation, standard scaling, inversion,
integration, marked-series, naming and renormalization controls remain open.
Other gaps include full metadata parameter copying, general provenance
remapping and invalidation, and complete native processing/type semantics.
All **107** requirement rows are retained and none is Verified.

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
