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

In the local workspace, **Load copper examples** loads the three foil spectra
and the **Cu₂O · room temperature** reference, attaches the Cuprite CIF
(AMCSD 0015851, 1930), and prepares the reference's EXAFS model with the first
four precomputed Cu K-edge FEFF paths from Cu site 1. Loading the demo selects
Cu₂O, opens its EXAFS fitting panel, and displays the matching CIF and FEFF paths
directly. Existing spectra and fitting drafts are preserved; Undo removes the
added spectra and any newly attached CIF together.
Linked Dr.XAS sessions retain their spectra-only example import.

The paths include Cu–O and Cu–Cu scattering. Review the path parameters and fit
ranges, then choose **Run EXAFS fit**; loading an example never runs a fit automatically.
Fitting drafts automatically save with their spectrum in the local project.
Wait for **Saved** before reloading; a failed save offers **Retry saving model**.

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

In the **CIF structure viewer**, **Local cluster** uses a display radius in Å
around the chosen center site. Switching **View** to **Unit cell** replaces the
radius slider with **Unit cell repeats** along the lattice **a**, **b**, and **c**
directions (1–6 each). For example, 2 × 2 × 2 displays eight cells with their
atoms and outlines, including non-orthogonal lattices. Each mode retains its
display settings when switching views. Expansions beyond the 1,500-atom preview
limit show a message to reduce the repeats. These controls do not modify the
saved CIF or FEFF parameters.

Click **Coordination numbers** in the viewer heading to calculate coordination
shells for the current **Local cluster**. Set **Distance cutoff** (default 5 Å)
and **Shell tolerance** (default 0.01 Å), then **Calculate** to update results.
The table lists each ordered element pair, shell mean distance, average CN,
CN of the selected center atom, and an expandable CN distribution. A dash in
Center CN means that the pair's first element differs from the selected center.
Hover over a mean distance to see the shell's minimum and maximum distances.

The calculation uses every atom in the finite cluster, including hidden
elements, and excludes neighbors outside its boundary. Average CN includes
all atoms of the pair's first element, including those with no neighbors in
that shell. Surface atoms therefore contribute lower CNs than bulk atoms.
Distances must be strictly below the cutoff; consecutive sorted distances are
grouped in the same shell when their gap is no larger than the tolerance.
Changing the radius, center, CIF, or calculation settings clears the displayed
results until **Calculate** is clicked again. Unit-cell views, truncated
previews, and disordered or partially occupied structures cannot be calculated.

The shell algorithm is adapted from Juanjuan Huang and Shelly D. Kelly's
[`neighbor`](https://github.com/Cathyhjj/neighbor) `get_CN` / `get_CN_all` methods
(Copyright © 2024, UChicago Argonne, LLC). It runs locally in the browser.
Distributions use the same shell membership as the average CN, matching
`neighbor`'s default gap-based shell calculation at commit `2771716f9b901f2246d55bb7fa67e4c3194a0e04`.
The viewer exposes finite clusters with gap-based shells; `neighbor`'s periodic
boundary modes and explicit shell-edge settings are not exposed here.
The calculation does not modify the saved CIF or FEFF parameters.

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

Model edits automatically save in the selected local Athena group, including
incomplete numeric fields and expressions. The editor shows pending, saving,
saved, and failed states. Failed saves retain the draft and offer a retry.
Fitting runs only when **Run EXAFS fit** is clicked; a completed request saves
the model and its result together.
The saved model includes every FEFF file, path expression, parameter, transform
setting, and FEFF input atom cluster used by the preview. Reloading the browser
restores the saved model. Switching spectra retains drafts and their pending saves.
Project downloads first flush all pending models in that project; a failed save
stops the download. A browser exit warning protects edits still waiting to save.

**Saved fit history** keeps up to 10 results per group, each with its own model,
curves, statistics, report, timestamp, original project/group identity, and Larch
version. Selecting history shows that result without changing the editable model.
**Use this fit’s model** copies its model into the editor. **Remove saved fit** is
undoable; export the project first if you want to keep that archive elsewhere.
At 10 fits, the next fit is rejected until one is removed. History is never pruned
silently. Models and history share a 20 MB project budget; each model can contain
up to 24 FEFF files, 500 KB per file and 4 MB total UTF-8 text.

Input staleness is determined from the actual processed k/chi arrays, data type,
Larch processing version and effective Rbkg. Changing labels, selection or display
settings does not invalidate a fit. Changed scientific input or a processing
error labels the result **Outdated input**; the plot continues to show the saved
data/model pair. A separate notice identifies edits to the current model. Neither
condition automatically runs another fit.

Athena `.prj` downloads and complete web-project JSON include the saved models and
fit history, including partial group exports. Import creates new group identities
while preserving each fit's original provenance. Imported numerical results are
explicitly labeled **Imported fit archive**, even when their input matches. They
are never treated as a new local fit. The Artemis data lives in the web metadata
sidecar of `.prj` files; desktop Athena does not offer this fitting editor, and
resaving through software that drops that sidecar can discard the web fit history.

**File → Export model JSON** remains available for standalone `artemis-web/v1` model
exchange. It includes the current model and only includes a result when that model
matches. **Download fit + model JSON** exports the selected history entry's own
model and result together; **Download report** exports its Larch report.
**File → Import model JSON** inspects the supplied FEFF files and loads an editable
draft, which also saves automatically. This format is not a desktop `.fpj` file.

**File → Export Larix session (.larix)** exports the current spectrum and its
saved model using Larch's native session format. It first saves pending edits,
then includes the measured data, processed arrays, FEFF path data, fit parameters,
and transform. Saved fit history remains in the web project. Export does not run a fit. Incomplete drafts can be kept in the web
project, but must be completed before native model export. Desktop Artemis `.fpj`
export is not yet available.

Native session storage and Larix GUI controls have different capabilities. The
export preserves the Larch model and reports any settings that the desktop GUI
may change when rebuilding it. For example, the current Larix GUI does not offer
k⁰ fitting. Review export notices before refitting in Larix; exporting a session
does not establish that every GUI control supports the web model.

This persistence applies to local Athena projects. Dr.XAS integration projects
retain their existing fitting boundary; import into a local project to fit.

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

Project persistence adds three POST endpoints under
`/api/artemis/projects/{project_id}/groups/{group_id}`:

- `/model`: `{version, model}` saves an editable model and returns the updated project.
- `/fit-saved`: `{version, model}` computes a fit, then saves model and result atomically;
  returns `{project, fit_id}`. Computation runs outside the project lock, and the
  version is checked again before saving. A concurrent update returns 409 without
  overwriting history; the editor refreshes project state and keeps unfinished edits.
- `/remove-fit`: `{version, fit_id}` removes one archive and returns the updated project.

The model uses `parameters` with stable row IDs and numeric values as strings,
full inspected `paths`, string-valued numeric `transform` settings, and an editor
`revision`. It is stored as `group.artemis.model` in schema version 1, alongside
`history` and a derived `current_input_sha256`. Import validates bounded finite
archives without evaluating expressions or executing FEFF. Saving a model inspects
its FEFF contents again; only an explicit fit evaluates the model.

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
and automatic averaging over absorber sites, desktop Artemis project interchange,
simultaneous multi-dataset fits, q-space and wavelet fitting,
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
arrows on overlapping lines use tightly spaced lanes centered on the bond axis
without moving the atoms. Unshared arrows sit directly on the axis, with their
tips outside the atom surfaces.
The coordinate table includes the final return and scattering angle β, measured
between incoming and outgoing travel directions: 0° forward, 180° backward.
`Reff` is half the total trajectory length; degeneracy counts equivalent paths.
See the official
[FEFF path examples](https://feff.phys.washington.edu/feff/wiki/static/p/a/t/Paths.dat_%28FEFF_6.01%29_1d89.html)
and [Larch path metadata](https://xraypy.github.io/xraylarch/xafs_feffpaths.html).

The local structure uses the same **3Dmol.js** engine, XYZ bond perception,
element colors, atom and bond radii, default camera fitting, theme styles, radius
slider, and **Bonds** controls as the CIF viewer. Atoms participating in any visible
path remain opaque; other atoms retain their colors at 70% transparency
(effective opacity 0.3). Bold colored arrows replace the inferred bonds along
representative paths. Equivalent path bonds without arrows remain opaque;
all other bonds use the same transparency. The **Bonds** control changes only
the remaining chemical bonds; scattering arrows stay visible because a scattering
leg is not necessarily a chemical bond. Hover an atom for its element and distance from the absorber.
Path atoms remain visible when the display radius excludes their surrounding shell.

Verified equivalent paths also contribute opaque atoms and bonds, while arrows
and numbered labels still describe just one representative route per FEFF file.
For example, the Cuprite first-shell path has degeneracy 2: both neighboring O
atoms are opaque, one Cu–O connection uses an outgoing/return arrow pair, and
the other retains its opaque chemical bond.
Equivalents are found among actual source-cluster atoms by element, available
FEFF potential indices, full path geometry, and repeated-site topology, including
reversed routes. This follows FEFF's grouping of geometry and path reversal;
see [FEFF path enumeration](https://feff.phys.washington.edu/feff/Docs/feff8/feff8web/node9.html).
Expansion is used only when an exhaustive match agrees with the recorded
degeneracy. If a cluster is incomplete, differs between selected paths, the
match is ambiguous, or a search limit is reached, a note explains why only the
representative path is highlighted.
Changing the display radius does not remove verified equivalent path atoms.

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

### CrystalNN first coordination shell

The CIF viewer automatically analyzes its center site with pymatgen CrystalNN.
In **EXAFS fitting → Open attached CIF**, choosing an inequivalent absorber site
also analyzes that site for FEFF path selection. Results show predicted CN,
neighbor elements, distance ranges, alternative coordination weights, and any
radius/oxidation-state warnings. The shell is the most probable bonded-neighbor
set; it is not a fitted CN or an R-space Fourier-transform window.

The viewer highlights the absorber in amber and exact periodic neighbors in
cyan. **View → CrystalNN first shell** displays the entire shell, including
neighbors across cell boundaries, independently of the display radius. Changing
the viewer center only changes the display; use the explicit FEFF absorber-site
controls to change a calculation.

Generated FEFF paths receive a **First shell** label only for two-leg paths whose
scatterer element and centered atomic position match the predicted shell.
**Select first-shell paths** prepares the selection for the existing Add button.
For already loaded fit paths, matching paths are labeled **first-shell candidates**
relative to the selected CIF/site: confirm the source, then optionally choose
**Use only first-shell candidates**. This changes the model's inclusion toggles;
it does not run a fit, change degeneracy, multiply by crystallographic
multiplicity, or replace fitted parameters. Save the model normally to retain
those toggles. Shell analysis itself is recomputed from the saved CIF.

`POST /api/artemis/structures/first-shell` accepts full bounded CIF text,
`absorber`, and the same 1-based global inequivalent `site_index` used by FEFF.
It returns the exact CIF and its SHA-256, library version, fixed algorithm settings,
CN alternatives, warnings, and neighbors with signed periodic images. Fractional
offsets drive the viewer; native pymatgen Cartesian offsets match larixite/FEFF,
including nonorthogonal cells. The endpoint reads no client-specified files and
uses the submitted snapshot rather than looking up a potentially different CIF.
Partial occupancies and unsupported structures fail explicitly; an algorithm
failure is not represented as CN 0. Periodic candidate counts bound the adaptive
Voronoi search. Successful results are cached by exact CIF/element/site.

The fixed settings are the [pymatgen CrystalNN defaults](https://pymatgen.org/pymatgen.core.html):
`weighted_cn=False`, `cation_anion=False`, `distance_cutoffs=(0.5, 1.0)`,
`x_diff_weight=3.0`, `porous_adjustment=True`, `search_cutoff=7.0` Å. Oxidation
states are not guessed. Review predictions especially for molecular/porous
crystals. Hydrogen neighbors remain in CrystalNN results and are explicitly
flagged because FEFF generation currently excludes H.

### Periodic radial shells

**CIF structure viewer → View → Radial shells** colors neighbors by their radial
shell around the selected center. The absorber is amber. The table below the
viewer shows each shell's actual minimum/maximum distance, neighbor count,
element composition and symmetry pair groups. Select shell checkboxes to show
any combination; initially shells 1–3 are visible. These complete periodic
neighbor lists are independent of the Local cluster display radius. Element
visibility does not change shell counts. The existing finite-cluster coordination
calculator remains a separate calculation of the displayed local cluster.

Shell analysis enumerates periodic neighbors, then uses one-dimensional
[complete-linkage clustering](https://docs.scipy.org/doc/scipy/reference/generated/scipy.cluster.hierarchy.linkage.html)
on their distances. **Shell width** bounds the entire group's distance spread,
not just gaps between consecutive distances. The default width is 0.05 Å and
is a reviewable grouping choice, not an experimental resolution or universal
chemical cutoff. **Search radius** defaults to 6 Å; controls accept 0.5–12 Å
and widths of 0.001–0.5 Å. Apply settings explicitly. Viewer, FEFF dialog and
EXAFS model share applied settings for the exact CIF/center during the browser
session; settings reset on page reload, while saved model path inclusions persist.

Symmetry groups use operations fixing the chosen absorber modulo a lattice
translation, with a separate 1e-5 Å symmetry tolerance. Element and pair-group
membership remain available even when a broad display shell combines split
distances, such as four short and two long bonds. Shell numbers are ordered by
distance across all elements; they can change when the width changes. CrystalNN
continues to describe bonded coordination and does not determine radial shell
numbers. Structures with unresolved disorder/partial occupancy remain unsupported.

In **EXAFS fitting**, open an attached CIF and explicitly choose its absorber site
to display the shell ranges. Generated FEFF and existing model paths are grouped
by matching single-scattering geometry to these periodic neighbors. Group buttons
select/include/exclude paths together; **Use only shell N candidates** explicitly
excludes other model paths. Generated selection unions groups, skips paths already
added and rejects selections exceeding available model slots. **Add selected
paths** still performs the addition. Multiple scattering has its own group:
its effective half-path length is not a radial neighbor distance. Unmatched paths
remain available, including paths beyond the selected shell search radius.

Existing model matches are candidates relative to the chosen CIF/site, not proof
of imported-file provenance. A representative FEFF path can cover several symmetry
pair groups (for example the 12 Cu neighbors in Cuprite); it is never split or
counted twice. Original degeneracies, expressions and fit bounds are preserved.
Model inclusion edits can be saved normally. Changing shell settings or visibility
does not run FEFF or a fit and preserves editable path input identity/undo history.

`POST /api/artemis/structures/radial-shells` accepts full CIF text, `absorber`,
global inequivalent `site_index`, `radius`, and `tolerance`. It returns exact CIF
identity, applied settings, numbered shells, symmetry subgroups, signed periodic
images, fractional offsets for rendering and native Cartesian offsets for FEFF
matching. Results are cached by all inputs. Searches are bounded to 100,000
candidate periodic sites and 2,000 actual neighbors; oversized searches fail
instead of silently truncating results. A shell near the search boundary is
flagged as potentially incomplete. Hydrogen is included with a warning because
FEFF generation currently omits it. Distances are structural ranges, not automatic
Fourier-transform fit windows or evidence that split shells are experimentally
resolvable.
