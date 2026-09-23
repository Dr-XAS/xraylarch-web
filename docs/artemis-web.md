# Artemis Web: EXAFS fitting

Artemis Web adds an **EXAFS fitting** tab to the middle parameter panel of the
Athena workspace. It fits the current spectrum using imported FEFF scattering
paths or paths calculated from an AMCSD structure, with the repository's Larch
core. It is an initial web
workflow, not a claim of full desktop Artemis compatibility.

## Model and workflow

Desktop Artemis organizes a fit around experimental data, FEFF paths, and a GDS
parameter table. The web workflow follows that organization within the existing
Athena workspace. See the official [Artemis fitting guide](https://bruceravel.github.io/demeter/artug/fit/index.html)
and [GDS reference](https://bruceravel.github.io/demeter/documents/Artemis/gds.html).

1. Select the spectrum to analyze and complete its Athena background subtraction.
   Fitting requires the current processed `k` and `chi` arrays.
2. Open **EXAFS fitting** in the middle panel and import one or more
   `feffNNNN.dat` scattering-path files, or find an AMCSD structure and calculate
   its FEFF paths as described below.
3. Inspect each path's absorber/edge, nominal half-path length `Reff`, degeneracy,
   and number of legs. Include the paths appropriate for the selected fit range.
4. Define named fit parameters and use their names or mathematical expressions
   in each path's parameter fields.
5. Choose the fit space, usable k range, k weights, Fourier window, and R range.
   Run the fit and inspect data/model plots, parameter uncertainties,
   correlations, and the Larch fit report.

An included path contributes its calculated chi(k) to the model sum. Excluding
a path removes it from that sum. The fit concerns the current spectrum;
selecting several spectra for Athena plotting does not create a simultaneous
multi-dataset fit.

For a Cu₂O model, use **Load copper examples** in Athena and select the
**Cu₂O · room temperature** spectrum, or select another processed Cu K-edge
spectrum. Then choose **Cu₂O example**. One click attaches the Cuprite CIF
(AMCSD 0015851, 1930) to the current project and loads the first four
precomputed Cu K-edge FEFF paths from its Cu site 1. The paths include Cu–O
and Cu–Cu scattering; the example does
not supply or change the experimental spectrum. Review the path parameters and
fit ranges for the selected data before fitting. The button is available when
the path list is empty and a local project and spectrum are selected.

The bundled calculation used FEFF8L with a 5 Å atomic cluster, 4 Å path radius,
and up to four legs. The first four files in FEFF order are:

| File | Legs | Reff (Å) | Degeneracy |
| --- | ---: | ---: | ---: |
| `feff0001.dat` | 2 | 1.8412 | 2 |
| `feff0002.dat` | 2 | 3.0066 | 12 |
| `feff0003.dat` | 3 | 3.3445 | 12 |
| `feff0004.dat` | 2 | 3.5256 | 6 |

## Fitted path plots

In the **EXAFS fit** viewer, enable **Show paths** to overlay each included FEFF
path evaluated with the fitted parameters. Path curves use the same k grid,
Fourier transform, and plot k-weight as the total model. They are available in
k space and in the magnitude, real, and imaginary R-space views. The legend
identifies individual paths and can hide or isolate their curves.

Enable **Offset plot** to separate the curves vertically. Data and Model stay
aligned; the residual and individual paths are shifted downward in successive
steps. **Offset spacing** controls that separation, and **Auto** restores a
spacing based on the displayed curves. Hover values retain the original signal
and identify the display offset. Offsets do not change fitted parameters,
statistics, or exported numerical results.

Path contributions add to the model in k space and in complex R space. Their
R-space magnitudes do not add because the paths interfere. For fits with more
than one k-weight, plots use the first listed weight, consistent with Larch's
saved fit outputs. Results obtained before path arrays were added need a new fit
before **Show paths** is available.

## AMCSD structures and FEFF calculations

The structure workflow uses the local AMCSD database packaged with Larixite.
This is a curated snapshot rather than a live search of the full online AMCSD:
the installed `amcsd_cif1.db` contains 9,275 structures and identifies itself as
the trimmed 2021-05-16 release. The application does not implicitly download or
replace this database. A missing entry in this snapshot does not establish that
the structure is absent from AMCSD.

Open the **Search / attach CIF** popup from the fitting panel. Search by mineral, formula, or AMCSD ID,
optionally adding a **Contains element** filter. Text searches use literal
substrings of mineral names, formulas, and publication titles; a numeric query
selects an AMCSD ID. Results are limited to 25 in the UI; refine the query when
more matches exist. Inspect the formula and publication, and select the
structure appropriate for the sample. Different entries for one mineral may
represent different temperatures, pressures, compositions, or refinements.
Choose **Attach to project** to save the full CIF and its AMCSD provenance in
the current project. The fitting panel lists attached structures; opening one
reuses the saved snapshot without repeating the database search. The search,
structure inspection, and FEFF controls stay inside the popup, which can be
closed and reopened without discarding its calculation state.

Select the absorber, absorption edge, and crystallographic absorber site before
generating FEFF input. Sites are the symmetry-distinct choices returned by
Larixite; their native indices are one-based across all unique sites in the
structure. A site index is not an element-specific row number.
One calculation uses one selected absorber site. Inequivalent absorber sites
are not automatically averaged; when combining their paths, include the
appropriate site-population weights in the amplitude expressions.

The conversion uses Larixite's `cif_cluster` and `cif2feffinp`, the same APIs used
by Larch's desktop CIF browser. FEFF8L then calculates the scattering paths.
These stages match the structure-to-path workflow described in the official
[Larix overview](https://xraypy.github.io/xraylarch/larix/overview.html#exafs-modeling-with-feff)
and [Larixite documentation](https://xraypy.github.io/larixite/). The local desktop
reference is [`cif_browser.py`](../larch/wxlib/cif_browser.py).

The atomic cluster radius and path cutoff have different roles: the cluster
radius limits atoms available to the calculation; the path cutoff limits the
effective half-path length considered by the pathfinder. The web allows a
3–6 Å atomic cluster, a 2–6 Å path cutoff no larger than the cluster radius,
and paths with at most 2–4 legs. A two-leg calculation contains single scattering;
higher limits permit multiple scattering. These bounds keep the initial web
calculation manageable and are not universal choices for EXAFS modeling.

The first structure workflow accepts ordered, fully occupied structures.
Partially occupied or mixed-species sites are rejected. Native Larixite can
sample mixed species, but that is a particular disordered cluster, not an
ensemble average; its handling of a single species with fractional occupancy
does not model vacancies. Silently applying that conversion would change the
structural model. Such systems require an explicit disorder model in a future
iteration.

Neighboring hydrogen atoms are omitted from FEFF clusters by the converter's current
default. This matters for hydroxides and hydrated structures; review the
generated atom list.

Choose **Generate FEFF paths** to start a background calculation with progress
and log output. Each job has a 180-second limit, and up to two calculations can
run concurrently. A successful calculation provides generated paths for
selection; **Add selected paths** appends those paths to the current model and
does not start a fit. Review each path's length, degeneracy, and
number of legs, then assign the needed GDS expressions. Generated paths are
subject to the existing 24-path fitting limit. The calculation can return a
bounded path list, with its total count and truncation reported, so inspect that
status before treating the displayed list as complete. **Maximum paths** controls
the returned list, up to 100 files; it does not limit how many paths FEFF's
pathfinder discovers. FEFF input uses `S02=1`;
the fitting model applies its separate amplitude expression as described below.
CIF atomic displacement parameters are not automatically converted into the
path's fitted σ². Define the disorder model explicitly in the GDS expressions.

Attached CIFs persist across page reloads and local project reopening, and are
included in both web JSON exports and the web metadata comment inside Athena
`.prj` exports. Reimporting either format into this web app restores the
attachments. Desktop Athena ignores that web metadata comment. Attaching a
CIF is a version-checked project edit and can be undone or redone.

FEFF generation from an attachment uses its saved CIF snapshot. **Download
feff.inp** remains available for calculation-input review. Model JSON saves the
added FEFF path files and their labels,
which identify the mineral, AMCSD ID, and selected absorber site. It does not
archive the complete FEFF calculation directory. Job outputs are temporary,
retained for up to 24 hours and subject to bounded storage; save useful files
before leaving the workflow.

## Fit parameters and path expressions

The GDS table defines fit variables independently from the physical parameters
of individual paths. A shared name can constrain several paths to one fitted
value; a mathematical expression can relate their values. The initial web
subset is:

| Type | Meaning |
| --- | --- |
| Guess | A numerical starting value that the optimizer varies; optional bounds constrain it. |
| Set | A fixed numerical value. |
| Def | An expression evaluated from other GDS parameters as the fit changes. |

Guess and Set take numbers in this implementation. Desktop Artemis also permits
expressions for their initial values; that behavior is not implemented here.
Each Guess must contribute to an included path, directly or through Def
parameters. Undefined names, duplicate names, and circular definitions are
invalid.

Parameter names start with a letter and contain at most 32 letters, numbers,
or underscores. Mathematical names and path metadata names are reserved.

After editing the path expressions, choose **Sync parameters** below the
Parameters heading. It adds missing names from included paths and their Def
dependencies, removes parameters unused by that model, and keeps the values,
types, and bounds of retained parameters. Excluded paths do not keep parameters
in the table. Invalid or incomplete expressions leave the table unchanged.
New parameters use Guess: a bare path symbol starts with that field's defaults;
symbols within composite expressions start at 1 without bounds. Review these
starting values and bounds before fitting.

Expressions support `+`, `-`, `*`, `/`, parentheses, and integer powers `**`
with exponents from -8 to 8. Supported one-argument functions are `sqrt`, `exp`,
`log`, `sin`, `cos`, `tan`, and `abs`; constants are `pi` and `e`. Path expressions
can additionally use the current path's `reff`, `degen`, and `nleg`. This is a
bounded expression language, not a Python or Larch scripting console. Larch's
Debye/Einstein disorder functions are outside this first iteration.

The exposed physical path parameters follow the
[Artemis path reference](https://bruceravel.github.io/demeter/documents/Artemis/path/pathparams.html):

| Field | Units and interpretation |
| --- | --- |
| S0² (`s02`) | Dimensionless amplitude factor, multiplied by the FEFF degeneracy. |
| ΔE0 (`e0`) | eV; an energy correction aligning the theory with the processed data. |
| ΔR (`deltar`) | Å; a change to the path's effective half-length. |
| σ² (`sigma2`) | Å²; mean-square relative displacement/disorder term. |

The fitted ΔE0 is distinct from Athena's edge energy E0. It does not recalibrate
the measured energy axis. For a single-scattering path, `reff + deltar` is the
fitted interatomic distance. For multiple scattering it is the effective
half-path length; it must not be labeled as an individual bond distance.

FEFF degeneracy is retained from the uploaded file. Larch's amplitude contains
the product `degen * s02`; the web does not replace degeneracy with an independently
varied coordination number. To fit a coordination number `coord` with a known
amplitude reduction factor `amp`, an appropriate path expression is
`amp * coord / degen`. Do not also multiply by the full coordination number
without that normalization. This expression is a model choice, not a guarantee
that coordination and amplitude can be independently identified.

A starting one-shell model can use Guess parameters `amp`, `del_e0`, `del_r`,
and `sig2`, with the corresponding path expressions `amp`, `del_e0`, `del_r`,
and `sig2`. Shared values across different shells require a physical reason;
the convenient four-parameter example is not a general multi-shell model.

## Fit ranges, weights, and interpretation

R-space fitting is the default. Larch transforms the data-minus-model residual
and fits its real and imaginary components within the selected R range. A plot
of the Fourier magnitude is a visualization; fitting does not minimize a
magnitude-only difference. Plotted R is not phase corrected and should not be
read directly as a bond length. The local implementation is
[`FeffitDataSet._residual`](../larch/xafs/feffit.py).

The k range chooses the measured EXAFS interval and its Fourier window.
`dk` controls the window taper. The R range selects the region of the transformed
signal for an R-space fit. In k space, the residual uses the selected k interval;
the R bounds do not filter that residual, although Larch still uses them in its
independent-point estimate. R space is the usual choice for isolating a shell.
Select ranges justified by the measured signal and the structural model.

The supported k weights are 0, 1, 2, and 3. New models and the Cu₂O example
select all four by default; imported models retain their saved selections.
They emphasize different parts of the same data and do not multiply
the number of independent observations. Fit weights belong to the fit model;
Athena's display weight remains a plotting choice. Fourier windows offered are
Hanning, Kaiser, Parzen, and Welch.

Larch's independent-point estimate is
`N_ind = 1 + 2 * (kmax - kmin) * (rmax - rmin) / pi`.
The web rejects fits with at least as many varied parameters as independent
points. Array length is not an independent-point count. The selected k range
must lie within the available measured data, and a fit extending below Athena's
background radius `rbkg` is flagged because background co-refinement is not
included.

The backend checks the requested k bounds against each FEFF table and flags
window tapers extending past the measured or theoretical range. A fitted ΔE0
can also reach beyond those nominal bounds, so leave adequate coverage in the
theoretical calculation. The first iteration accepts at most
24 paths and 32 GDS parameters, with at least one varying parameter. It requires
at least 20 measured samples inside a k interval of at least 1 Å⁻¹, an R interval
of at least 0.1 Å, and finite, increasing input k values.

The report is generated with `larch.xafs.feffit_report`. Its chi-square, reduced
chi-square, R-factor, and independent-point count come from Larch. Reduced
chi-square uses `N_ind - N_vary` for its effective degrees of freedom. Missing
parameter uncertainties are reported as unavailable rather than as zero.
Convergence alone does not establish that the structural model is adequate;
check the residuals, correlations, bounds, and parameter meaning.

Noise is estimated by Larch from the high-R region, 15–30 Å. The existing Athena
processed arrays do not retain `delta_chi`, so this iteration does not propagate
that background uncertainty into the fit. There is no user-specified noise
input yet. Reported error bars do not include systematic model errors.

## Results and state

The Results area keeps its EXAFS fit viewer available alongside Spectrum,
Wavelet, CIF, and a separate FEFF path viewer, regardless of which processing
tab is open. The FEFF viewer shows the current model's path metadata and atom
geometry; add or edit paths in the EXAFS fitting tab. The fit plot compares
data, model, and residual in k or R space. R plots offer
magnitude, real, and imaginary components. The magnitude residual is
`abs(FT(data - model))`, not the difference between the data and model magnitudes.
Plots use the first selected fit k weight; the optimizer uses all selected
weights. Statistics, fitted parameter values, uncertainties, correlations,
and the complete Larch report appear below the plot.

Fitting runs when **Run EXAFS fit** is clicked. Changing a model field invalidates
its previous result. Failed requests retain the model for correction and retry.
Each spectrum's draft and most recent result remain available while switching
spectra and the Processing/EXAFS fitting tabs within the open workspace. Results
are associated with the spectrum, model revision, and Athena project version;
processing changes or project updates invalidate them.

Use **Export model JSON** to keep a model beyond the current browser session.
The `artemis-web/v1` bundle contains the GDS definitions, transform settings,
complete FEFF-file contents and path expressions, source identifiers, and any
current fit result. **Download fit + model JSON** also saves the fitted curves,
statistics, and parameter results; **Download report** saves the plain-text
Larch report. Plotly's image download exports the displayed plot.

To resume, load the experimental spectrum in Athena and choose **Import model
JSON**. The imported FEFF files are inspected again and the model is applied to
the current spectrum. Archived results are not treated as a new fit: run the
model again to obtain results for that spectrum and its current processing.
This JSON format is specific to Artemis Web and is not a desktop `.fpj` file.

Without a downloaded model JSON, reloading or closing the workspace loses the
browser-memory fit state. Saving an Athena `.prj` does not include the fitting
model. Automatic persistence, fit history, and CSV curve export are follow-up
work.

## Larch integration

The implementation uses `feffpath` to read scattering calculations,
`feffit_transform` for fit settings, `feffit_dataset` for the current processed
spectrum plus included paths, `feffit` for optimization, and `feffit_report`
for the report. It does not implement a second EXAFS equation or optimizer.
The fit operates on a snapshot and does not modify the saved Athena processing
parameters or spectrum. The snapshot is resampled onto Larch's 0.05 Å⁻¹ k grid,
with `nfft = 2048`. Output R arrays extend to 10 Å.
The numerical references are the checked-out
[`feffit.py`](../larch/xafs/feffit.py),
[`feffdat.py`](../larch/xafs/feffdat.py), and
[`xafs_feffit.rst`](../doc/xafs_feffit.rst), alongside the published
[Larch fitting](https://xraypy.github.io/xraylarch/xafs_feffit.html) and
[FEFF-path documentation](https://xraypy.github.io/xraylarch/xafs_feffpaths.html).

The API exposes `POST /api/artemis/paths/inspect`,
`GET /api/artemis/examples/cuprite`, and
`POST /api/artemis/projects/{project_id}/groups/{group_id}/fit`. The fit request
contains the project version, GDS parameters, FEFF-file contents and path
expressions, and transform settings. It checks the project version both before
and after computation to avoid returning an apparently current fit for an
outdated spectrum. Integration drafts must first be imported into a local
Athena project.

Structure search and calculation use:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/artemis/structures?q=...&element=...&limit=...` | Search the local AMCSD snapshot; `element` is one optional symbol and `limit` is 1–50. |
| `GET /api/artemis/structures/{id}` | Retrieve CIF text, citation, lattice parameters, native site indices, and supported/unsupported status. |
| `GET /api/artemis/projects/{id}/structures` | List the current project's saved CIF snapshots and project version. |
| `POST /api/artemis/projects/{id}/structures` | Attach an AMCSD CIF using `{version, amcsd_id}`; return the updated project. |
| `POST /api/artemis/feff/jobs` | Start an isolated FEFF8L job; returns HTTP 202 and its job ID. |
| `GET /api/artemis/feff/jobs/{id}` | Poll `running`, `complete`, or `failed` status, log, input provenance, and generated paths. |

The popup's job request specifies `project_id`, `attachment_id`, `version`,
`absorber`, `edge`, `site_index`,
`cluster_radius`, `path_radius`, `max_legs`, and `max_paths`. Supported edges
are K, L1, L2, and L3, subject to availability for the chosen element. Conversion
and FEFF execution are separate from fitting a spectrum. Native FEFF8L modules
run with their own working directory; the application does not change the
server process's working directory or construct a shell command from user input.
The original direct-database API also accepts `amcsd_id` instead of the three
project-attachment fields. Project attachments are limited to 20 snapshots and
4 MB total; imports validate checksums and merge with existing attachments.

## Validation of this iteration

- The CIF popup and project-attachment follow-up passes 16 attachment tests and
  16 structure UI tests. Coverage includes revision conflicts, stale responses,
  retry, undo/redo, duplicate handling, CIF-only JSON/PRJ round trips, and FEFF
  generation from the saved snapshot. The full frontend regression suite passes
  864 tests in 48 files. TypeScript and the production build also pass.
- Live browser validation attached AMCSD 13088 directly to the project, opened
  that saved structure in a fresh page, and generated its first-shell FEFF path
  from the attachment. Closing and reopening the popup preserves calculation
  progress; Escape restores focus to its launcher. The popup fits 390px and
  1280px layouts without horizontal overflow.
- AMCSD follow-up: 72 backend tests pass across fitting, structure search/job
  validation, and a real AMCSD-to-FEFF-to-fit recovery test. This includes compact
  formula searches, native site indices, occupancy rejection, concurrency,
  output/time limits, expiry, and disk-write failure cleanup.
- The follow-up frontend regression run passes 856 tests in 48 files. The final
  fitting/structure component run passes 24 tests after the last path-selection
  refinements. TypeScript and the production Next.js build pass.
- Live browser validation searched `copper` and `CuO`, inspected the unsupported
  mixed-occupancy Rutile record 1735, and generated the Cu K-edge first-shell
  path from AMCSD 13088 (site 1; cluster/path radii 3 Å; 2 legs). That path has
  `Reff = 2.5668 Å` and degeneracy 12. Adding it to the model and fitting the
  measured 10 K Cu foil produced R-factor 0.0022651. This is a workflow check;
  the selected CIF describes a 577 K crystal, so its starting distance differs
  from the low-temperature sample. Spectrum-context switching and layouts at
  390px and 1280px were checked with no horizontal overflow.

The original fitting implementation was also checked separately:

- 49 backend fitting tests pass, including noisy synthetic parameter recovery,
  k/R and multiple-weight fits, expression validation, revision guards, and
  agreement with a separately constructed native Larch fit on irregular k data.
- 14 fitting UI tests and the 833-test frontend regression suite pass.
  TypeScript and the production Next.js build pass.
- Live browser validation used the measured Cu foil at 10 K and the bundled
  first-shell path with k = 3–12 Å⁻¹, R = 1.4–3 Å, and k weight 2. The fit
  converged with R-factor 0.0020382 and 10.167 independent points for four
  variables. Spectrum changes, model invalidation, and desktop/390px layouts
  were checked; the browser console had no errors or warnings.
- The full backend suite reports 3,825 passes and 79 failures. All failures
  were reproduced using the original `HEAD` application without Artemis:
  three archived alignment comparisons differ by roughly 1e-10, and 76 XDI
  validation tests cannot load the bundled x86_64 library on this arm64 host.
  The full suite therefore remains non-green for these existing issues.

## Scope beyond this iteration

Future work includes arbitrary external CIF/Atoms input, disordered structures
and automatic averaging over absorber sites, full Artemis project import/export and fit
history, simultaneous multi-dataset fits, q-space and wavelet fitting,
background co-refinement, additional cumulants, physical disorder functions,
restraints, and the remaining desktop GDS parameter types. Directly importing a
FEFF path uses an existing calculation; the AMCSD workflow separately creates
FEFF input and runs FEFF8L.

The implementation draws on the official
[Artemis manual](https://bruceravel.github.io/demeter/documents/Artemis/),
[legacy user guide](https://bruceravel.github.io/demeter/artug/index.html),
[data/transform controls](https://bruceravel.github.io/demeter/documents/Artemis/data.html),
and [model validation](https://bruceravel.github.io/demeter/documents/Artemis/fit/sanity.html).

## FEFF path viewer

The **FEFF path viewer** shows a clickable **FEFF0001**, **FEFF0002**, etc. legend
inside its 3D canvas, including paths excluded from fitting. Toggle any combination
of paths to overlay their representative trajectories. Each path has a distinct
arrow color that matches its legend; numbered arrows follow the FEFF geometry
order back to the absorber. Shared atoms are drawn once. Select **Path details**
to inspect one visible path, then **Leg 1**, **Leg 2**, etc. to emphasize a
direction, or **All legs** to show its complete route. Drag to rotate, scroll to
zoom, and use **Reset view** to refit the structure while retaining its rotation,
as in the CIF viewer. These controls do not
run FEFF or refit the spectrum.

Two legs describe single scattering (absorber → neighbor → absorber). Three legs
describe double scattering and form a triangle unless the three sites are
collinear. Four or more legs can revisit the absorber or another atom, so they
need not form a polygon with distinct vertices. Repeated visits are retained;
arrows on overlapping lines use separate display lanes without moving the atoms.
The coordinate table includes the final return and scattering angle β, measured
between incoming and outgoing travel directions: 0° forward, 180° backward.
`Reff` is half the total trajectory length; degeneracy counts equivalent paths,
not additional atoms to reconstruct. See the official
[FEFF path examples](https://feff.phys.washington.edu/feff/wiki/static/p/a/t/Paths.dat_%28FEFF_6.01%29_1d89.html)
and [Larch path metadata](https://xraypy.github.io/xraylarch/xafs_feffpaths.html).

The local structure uses the same **3Dmol.js** engine, XYZ bond perception,
element colors, atom and bond radii, default camera fitting, theme styles, radius
slider, and **Bonds** controls as the CIF viewer. Atoms participating in any visible
path remain opaque; other atoms retain their colors at 70% transparency
(effective opacity 0.3). Inferred bonds are opaque only when they follow a visible
path leg; all other bonds use the same transparency. Thin colored arrows distinguish the paths. Bond
visibility is independent of scattering arrows: a scattering leg is not necessarily
a chemical bond. Hover an atom for its element and distance from the absorber.
Path atoms remain visible when the display radius excludes their surrounding shell.

Paths added from a calculation in this browser retain its actual FEFF input
cluster as optional display metadata. Otherwise, the viewer looks for an attached
project CIF whose absorber-centered Cartesian coordinates match every path atom
(element and position, within 0.005 Å rounding tolerance). Multiple distinct
matches require a source selection. Matching does not rotate or distort a path
to force agreement with a different structure. Background atoms can be hidden
with **Local structure**; their bonds are inferred from the same distance rules
as the CIF viewer.

When several paths are visible, all of them must match the same chosen cluster
before it is used as their shared structure. If that match cannot be verified,
the viewer shows their absorber-centered path coordinates with an explicit note
and omits the unverified surrounding cluster.

A standalone `feffNNNN.dat` contains only its representative path. If there is
no matching CIF or retained FEFF cluster, the viewer requests a matching structure
and displays the available path atoms. It never reconstructs neighbors from
degeneracy. Model reimport reinspects `.dat` files, losing optional FEFF input
context but still allowing context from a matching attached CIF. Invalid geometry
or unavailable WebGL is reported; header values remain accessible.
