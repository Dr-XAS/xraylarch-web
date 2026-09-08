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
