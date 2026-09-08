# Athena Web implementation and verification

This branch is an ongoing implementation of Athena workflows in the browser.
It is not yet a verified replacement for every desktop Athena feature. The
[full coverage matrix](athena-parity.md) retains the remaining work; the
[research notes](athena-research.md) identify the primary tutorials, manual,
screenshots, and YouTube references used to guide it.

## Running the branch

From the repository root:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --host 127.0.0.1 --port 8006
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
- Copy or reset individual parameters, scientific sections or full recipes.
  Full-recipe copies preserve per-scan energy shifts; global operations skip
  frozen groups. Sample/reference energy shifts propagate in both directions.
- ASCII/CSV/XDI inspection, explicit column mapping, detector-channel summation,
  transmission logarithm, fluorescence ratio, reference channels, eV/keV units,
  ascending-sort option and multi-file mapping reuse for matching layouts.
- μ(E), XANES, normalized μ(E), and χ(k) inputs; normalization, flattening,
  AUTOBK, independently configured forward/reverse Fourier transforms.
  Background taper/window/clamp-point controls and fractional k-weights are
  independent of forward-transform settings.
- E/k/R/q plots, overlays, complex components, transform windows, zoom,
  group scale/offset and stacked comparison. CSV exports carry computed arrays.
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

Weighted merges normalize finite nonnegative coefficients. Sums preserve signed
coefficients exactly. Inputs can be raw μ, processed normalized μ, or χ(k), and
are restricted to the common measured range. Population scatter and explicitly
supplied measurement uncertainty remain distinct; both export on their native
grid. A zero sum retains its raw data and can be exported even though it has no
edge to normalize.

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
  propagation, preserved source arrays, weighted combinations and uncertainty.
- `athena-workbench.test.tsx`: browser state and request contracts, active versus
  marked groups, per-group drafts, parameter application, project recovery and
  dialog behavior. Plotly is mocked in these component tests.
- `athena-plot.test.tsx`: 44 trace-contract checks cover display transforms,
  overlay ownership, mixed k-weights, complex components without double weighting,
  q-window interpolation, raw χ fallback and malformed imported reports. Plotly
  rendering is mocked here and checked separately in the live browser.

On 2026-09-07, the final checkpoint passed **565 backend tests** and
**119 frontend tests across eight files**. `npm run build` passed TypeScript,
production compilation and route generation for `/`, `/classic` and the backend
proxy. The backend project/constraint subset also passed **110 tests with
warnings treated as errors**. `git diff --check` passed. No CLI Playwright suite
was executed for this checkpoint; live browser checks are listed below.
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

## Browser observations, 2026-09-07

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

## Limitations retained for continued work

Full desktop behavior remains broader than the current application. Outstanding
areas include complete default preferences, interactive plot
plucking, advanced import/project selection, automatic noise/edge-step weighting,
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
