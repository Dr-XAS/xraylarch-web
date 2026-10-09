# Artemis Web: EXAFS fitting

Artemis Web adds an **EXAFS fitting** tab to the middle parameter panel of the
Athena workspace. It fits the current spectrum using imported FEFF scattering
paths or paths calculated from an AMCSD or Materials Project structure, with the repository's Larch
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
   `feffNNNN.dat` scattering-path files, or find a crystal structure and calculate
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

Right-click **Fit range & transform**, or use its **⋯** button, and choose
**Apply fit range & transform to marked groups** to copy the current group's
fit space, k and R ranges, tapers, window, and fit k-weights. Right-click an
individual field to copy only that parameter. The same menus are available
with **Shift+F10** while a control or heading has focus.
The marked groups keep their own FEFF paths, fit parameters, and saved fit
history; groups without a model get an empty model with the copied settings.
Copies save automatically, and the current group and unmarked groups are
unchanged. An invalid resulting range prevents the entire copy. Copying model
settings does not run a fit; saved fits indicate when their model differs.

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

## Crystal structures and FEFF calculations

### Simulate EXAFS from a CIF

An empty project is sufficient. Open **EXAFS fitting → Crystal structures →
Upload CIF**, then **Simulate EXAFS from this CIF**. Each attached CIF has a
**Simulate EXAFS** action, and **Simulate EXAFS from CIF** opens the same form.
Choose the absorbing element, absorption edge, inequivalent site and **Maximum R**
(default 5 Å, supported range 2–6 Å), enter the simulation values and click
**Run EXAFS simulation** once. The scattering calculation and path sum run automatically.

Simulation includes every FEFF-generated path within the requested effective
half-path length, with single and multiple scattering through four legs. For
single scattering R is the absorbing atom–neighbor distance; for multiple
scattering it is half the total path length. The atomic cluster radius is set
automatically to cover this range, with a minimum of 3 Å. There is no path picker,
maximum returned-path count, or fit-model action in the simulation form. The
separate **Generate FEFF paths** workflow retains path selection and the 24-path
fit-model limit. Existing calculation time and byte limits still apply; exceeding
one reports an error rather than silently dropping paths.

The default shared parameters are S₀² = 0.85, σ² = 0.003 Å², ΔE₀ = 0 eV and ΔR = 0 Å.
σ² is an explicit disorder assumption, not calculated from CIF displacement
factors or temperature. Native FEFF degeneracies are retained. The result is for
one selected absorbing site; crystallographic multiplicity is not applied again,
and inequivalent sites are not population averaged. Shared parameters are a
simple forward model; use the fitting model for path-specific expressions.

χ(k) is calculated on a 0.05 Å⁻¹ grid through the common FEFF support (at most
20 Å⁻¹). The Fourier defaults are k = 3–12 Å⁻¹, k-weight 2, a Hanning window and
dk = 2 Å⁻¹. These are simulation controls, independent of any measured group's
processing. |χ(R)| is not phase corrected, so its peak positions are not bond
distances. Changing simulation inputs hides the old result until recalculation.

**Download χ(k) CSV** includes unweighted χ(k), including its k=0 value, and the
weighted display curve. **Download χ(R) CSV** includes magnitude, real and
imaginary components. **Download simulation JSON** retains all curves, the
original CIF, FEFF input, all included path files, assumptions and parameters.
After simulation, **Add to data list** saves its unweighted χ(k) as a project
group with a **theory** tag. It uses the simulation's Fourier parameters and
retains the exact CIF, FEFF input, path files, assumptions and parameters with
the group. Mark it to compare it with other groups in the multiple-spectra
viewer. Save project retains the spectrum and its sources; Undo removes the
addition. Simulation previews save nothing until this action is chosen.

Highlight a theory group to show it in the **EXAFS fit viewer**, which switches
to **EXAFS theory**. It displays the total theory and individual path contributions
in k space or R-space magnitude, real, and imaginary components. Display k-weight
(0–3), path visibility, and vertical offsets do not change the saved simulation.
The details show supplied simulation parameters and path lengths; no data,
residual, fitted uncertainty, correlation, or fit statistic is presented.
Contributions use the original simulation Fourier settings and are restored from
the saved FEFF files after project reload or FEFF job expiry. A warning identifies
spectra whose arrays have since changed. Individual path magnitudes do not add
to the total magnitude; the complex contributions add before taking magnitude.
If a real fit has also been saved for the theory group, **Fit result** and
**Theory** switch between that fit and the original simulation.

The read-only API is `POST /api/artemis/feff/jobs/{job_id}/simulate` with, for
example, `{"s02": 0.85, "sigma2": 0.003, "e0": 0, "deltar": 0}`. Omit `path_ids`
for all available paths or supply a nonempty list of IDs from the completed job.
The simulation UI creates jobs with `max_paths: null` and sends `path_ids: null`,
so the full generated set is retained and summed. Simulation and saved replay
support more than 100 paths, subject to the existing 4 MB total FEFF-file budget.
`transform` accepts the existing Fourier fields with one `kweight` value, such as
`[2]`. Full responses include raw `k.chi`, weighted `k.total`, complex R curves,
and source files. `?view=summary` elides arrays and omits source files. FEFF jobs
expire after 24 hours; export the full result to preserve its inputs.
`GET /api/artemis/capabilities/simulation` describes all fields and defaults.
`POST /api/artemis/projects/{project_id}/simulation` adds the completed result
with `{version, feff_job_id, simulation}`; `simulation` is the captured
`result.simulation.request`. It checks the project version and attached CIF,
supports `Idempotency-Key` for retries, and returns the updated project with
`last_operation.simulation.group_id`. The saved spectrum survives FEFF job expiry.
`POST /api/artemis/projects/{project_id}/groups/{group_id}/simulation-view`
with `{version, kweight}` reconstructs these saved contributions without saving
or fitting. Omit `kweight` or use null for the original simulation weight;
`?view=summary` elides arrays.

### Attach and calculate paths

The structure search defaults to Materials Project first, followed by the
American Mineralogist Crystal Structure Database (AMCSD) packaged with Larixite.
The local AMCSD database is a curated snapshot rather than a live search of the full online AMCSD:
the installed `amcsd_cif1.db` contains 9,275 structures and identifies itself as
the trimmed 2021-05-16 release. The application does not implicitly download or
replace this database. A missing entry in this snapshot does not establish that
the structure is absent from AMCSD.

Choose **Upload CIF** in **Crystal structures** or its search dialog to attach
your own `.cif` file (up to 500 KB, one data block per file). The upload is
validated and attached directly, then opens in the structure viewer. The
project retains the exact CIF text, original filename, and SHA-256 checksum
through reloads and JSON/PRJ exchange. Identical text is attached only once;
different files with the same filename remain separate snapshots. Invalid CIFs
leave the project unchanged. Readable disordered structures are retained with
warnings, but FEFF requires an ordered structure. The existing project limit
of 20 CIFs and 4 MB of structure attachments applies to uploads too.

Use **Rename** beside an attached CIF to set its project name (up to 200
characters), then **Save** or press Enter. **Cancel** or Escape discards the edit.
The name appears in the attached list and CIF selectors and survives reloads,
JSON/PRJ exchange, and Undo/Redo. The original CIF text, mineral name, source ID,
upload filename, and existing FEFF paths are preserved.

Open **Search / attach CIF** from **Crystal structures** in the fitting panel. Search by formula, mineral, chemical system, or source ID,
optionally adding a **Contains element** filter. Formula searches include the same
set of elements with different proportions: `LiMnNiO2` can find
`LiMn0.5Ni0.5O2`. Exact element counts rank first, equivalent scaled formulas
next (such as `Li2MnNiO4` for `LiMn0.5Ni0.5O2`), then other proportions.
Element order and whitespace do not affect this ranking. At each relevance
level, Materials Project results precede AMCSD. Text searches use literal
substrings of mineral names, formulas, and publication titles; a numeric query
selects an AMCSD ID. Results are limited to 25 in the UI; refine the query when
more matches exist. Inspect the formula and publication, and select the
structure appropriate for the sample. Different entries for one mineral may
represent different temperatures, pressures, compositions, or refinements.
Selecting an AMCSD or Materials Project result immediately opens its interactive
**CIF structure viewer** in the details panel. Rotate the structure, change its
center site, or inspect the unit cell before attaching it; selecting another
result replaces the preview. The candidate is added to the project only when you
choose **Attach to project**.
Choose **Attach to project** to save the full CIF and its AMCSD provenance in
the current project. The fitting panel lists attached structures; opening one
reuses the saved snapshot without repeating the database search. Close the
structure popup, then choose **Generate FEFF paths** in the **FEFF paths** section.
In that dialog, choose an attached CIF and an absorber site, adjust the FEFF
settings, and select **Run FEFF calculation**. Review the generated paths and
choose **Add selected paths** to include them in the model. Both dialogs can be
closed and reopened while retaining the selected structure and calculation state.

Select **Source → Materials Project** or **Source → AMCSD** to search only that
database. Materials Project accepts a formula such as `Cu2O`, an exact chemical system such as `Cu-O`,
or an MP identifier such as `mp-30`. The **Contains element** filter finds
compounds containing that element; a formula query of `Cu` finds elemental
copper. Mineral-name searches remain available under AMCSD. Both older numeric
and newer letter-based MP IDs are supported.

The backend reads `MP_API_KEY` from its environment. Configure it as a server
secret before starting/restarting the backend; never use a `NEXT_PUBLIC_`
variable or place it in a project export. On the Dr.XAS host the ingress-mounted
deployment supplies it as `mp_api_key` in the private
`/local/apps/xraylarch-web/config/integration.json` read by the backend-only
launcher (see the deployment manifest); the standalone public instance reads it
from its own private `config/backend.env`. Missing or rejected keys, rate limits,
and connection failures produce an actionable message in the popup. In the default
combined search, AMCSD results remain available if Materials Project fails;
Materials Project results likewise remain available if the local database fails.
The backend
uses the official REST summary endpoint through the existing `httpx` dependency,
requests compact result metadata, and fetches the selected structure on demand.
Requests have timeouts and response-size limits; successful responses are cached
in memory for ten minutes, with at most 128 cache entries. No bulk download runs.

Materials Project structures are labeled **DFT-relaxed**. Their calculated cell
and coordinates are retained during CIF conversion; experimental temperature
and pressure are not inferred. The saved attachment includes the material ID,
source URL, exact CIF and SHA-256, retrieval timestamp, database version (or null
when unavailable), and the structure calculation's task ID when returned.
AMCSD and MP attachments can coexist, round-trip through JSON/PRJ, and generate
FEFF from the saved snapshot without network access or an API key. Existing AMCSD
project records keep their original shape.

The CIF viewer also reads complete P1 atom lists, as used by Materials Project
exports, even when the backend recognizes higher symmetry. Local clusters and
repeated unit cells retain the explicit coordinates, including small distortions.
When the backend recognizes coordinates close to 1/3 or 2/3 as exact fractions,
the viewer matches those sites while preserving the original CIF coordinates and
anchoring the selected center on its explicit atom row.
Existing saved CIFs work without reattaching them. For equivalent atoms whose
site assignment is not encoded in the CIF, hover shows the original atom label.

References: [MP API](https://docs.materialsproject.org/downloading-data/using-the-api),
[calculated structures](https://docs.materialsproject.org/methodology/materials-methodology/calculation-details).

In the **CIF structure viewer**, **Local cluster** uses a display radius in Å
around the chosen center site. Switching **View** to **Unit cell** replaces the
radius slider with **Unit cell repeats** along the lattice **a**, **b**, and **c**
directions (1–6 each). For example, 2 × 2 × 2 displays eight cells with their
atoms and outlines, including non-orthogonal lattices. Each mode retains its
display settings when switching views. Expansions beyond the 1,500-atom preview
limit show a message to reduce the repeats. These controls do not modify the
saved CIF or FEFF parameters.

Enable **Measure** in the CIF viewer heading, then click two atoms to display
their distance in Å. A third atom adds the 2–3 distance and the 1–2–3 angle
(atom 2 is the vertex); the result bar also lists the 1–3 distance. Numbered
highlights identify the selected atoms without replacing their element colors.
Measurements use the actual displayed periodic images, even when they share a
crystallographic site, and do not imply a chemical bond or an EXAFS fitted distance.
Drag to rotate normally. Hovering or moving the pointer away keeps measurements
visible. Use **Undo atom**, **Clear**, or Escape while the viewer is focused to
change the selection; after three atoms, clear or undo before selecting more.
Changing CIF, center, view, or displayed geometry, or hiding a selected element,
clears the selection. Measurements are temporary display state and do not change
the saved structure or FEFF inputs.

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

FEFF defaults to the current spectrum's absorbing element and absorption edge.
When that element has exactly one supported inequivalent site in the CIF, that
site is selected automatically; when several sites match, select one explicitly.
Manual choices are retained while reopening the dialogs for the same spectrum
and structure. A missing element or unsupported edge is left unselected with a
message, rather than substituted with another element or edge. If the spectrum
has no edge identity, select its absorber and site manually before generating
FEFF input. Sites are the symmetry-distinct choices returned by
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

Choose **Run FEFF calculation** in the FEFF paths dialog to start a background calculation with progress
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
which identify the mineral/formula, source ID, and selected absorber site. It does not
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
bounded expression language, not a Python or Larch scripting console.
The σ² path field also accepts `sigma2_eins(T, theta)` and
`sigma2_debye(T, theta)`, with Artemis aliases `eins` and `debye`.
Both arguments are in K and the result is in Å². These functions use the
current FEFF path and must appear directly in its σ² expression, rather than
inside a global Def parameter or another path field.

### Insert a Debye–Waller factor

Open **Insert Debye–Waller factor** below a path's expressions. Choose
**Independent σ² · Guess**, **Fixed σ² · Set**, **Einstein**, or
**Correlated Debye**. Enter the measured sample temperature explicitly;
the initial characteristic temperature of 300 K is an editable fitting start,
not an inferred material property. **Refine characteristic temperature** chooses
Guess or Set. **Add static σ²** inserts a fixed additive variance; for example,
`sig2_static_1 + sigma2_eins(temperature_1, theta_e_1)`.

**Apply σ² model and sync** replaces the selected path's σ² and synchronizes the GDS
table for included paths. New names avoid collisions with existing parameters;
retained parameters keep their values and bounds. Use shared names explicitly
to couple paths, or edit the expression to impose a physically justified
constraint. The edit uses normal model autosave and project Undo/Redo.
Models, history and project exports preserve these expressions; Larix exports
translate the two Artemis aliases to native Larch function names. Native Larix
execution still depends on its installed Larch and compatible FEFF libraries.
The fit viewer's **Fit summary** reports each path's final σ² alongside its
expression, with **Path values & disorder expressions** for the full details.

σ² is the variance of relative displacement, with EXAFS damping
`exp(-2*k**2*sigma2)`; it is neither σ nor a crystallographic B factor.
Thermal models include zero-point motion, accept T = 0 and require theta > 0.
Einstein uses Larch's effective mass from the path atoms (the pair reduced mass
for single scattering). Correlated Debye uses the complete path geometry,
atomic masses and FEFF Norman radius. The web evaluates Larch's Python
translation of the FEFF6 correlated Debye routine, with FEFF6 constants, so a
compatible native library is not required. Numerical regression compares it
with an independent adaptive covariance integral, including multiple scattering.

At one temperature, an independently varied static term and characteristic
temperature generally cannot be distinguished; constrain one using physical
evidence. Debye is most appropriate for simple, nearly isotropic solids.
An Einstein effective mass for a multiple-scattering path follows Larch's
convention and is not a general model of correlated angular motion.
Sharing or multiplying σ² across paths requires a geometry-specific reason;
the number of legs alone does not determine the constraint.
See the [source-backed disorder inventory](artemis-disorder-research.md) for
Artemis examples and the distinctions among cumulants, dynamical-matrix and
molecular-dynamics methods. Simultaneous temperature-series fitting remains
outside the current single-spectrum fitter.

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

Each single-scattering path offers **Set / fit coordination number**, visible
even when its path details are collapsed. Enter CN (initially the FEFF degeneracy)
and a calibrated **Fixed S₀²**, choose **Fit CN** or uncheck it to hold CN fixed,
and optionally set a CN maximum. **Apply CN and sync** creates a `cn_*` Guess/Set
parameter, a fixed `s02_*` parameter, and the normalized amplitude expression
`s02_* * cn_* / degen`. A fitted CN has a lower bound of zero; its maximum is
unbounded unless specified. Review values and bounds in **Parameters**. Reapplying
after changing helper values creates fresh parameters and resets a fitted CN's
minimum to zero; edit existing constraints directly in **Parameters**.
The helper replaces this path's amplitude expression and previews unused
parameters that sync will remove. Other included paths keep their expressions
and shared parameters. It creates distinct names, so separate shells are not
silently coupled. Existing fixed or numeric S₀² is prefilled; a free amplitude
is not treated as calibrated. Multiple-scattering degeneracy is not a neighbor
count, so those paths retain the expression editor without this CN shortcut.

FEFF degeneracy is retained from the uploaded file and labeled **FEFF N**. Larch's amplitude contains
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

The supported k weights are 0, 1, 2, and 3. New models select all four by
default; imported models retain their saved selections. The Cu₂O example
uses weight 2 only and separate Cu-O distance and disorder parameters.
Its improvement over the older example changes both the model and the
k-weighting, not just the shell parameters.
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

The fit report uses the viewer palette for compact status badges and includes an
always-visible **Status color guide**, even when **Show instruction** is off.
Olive green means **In range**, gold **Borderline**, coral **Out of range**, slate
**S₀² at bound**, and gray **Not assessed**. Each badge includes text and an icon;
numeric values retain a neutral background. The gold report heading and R-factor
card identify the EXAFS report; their status is given by the badge.
**Reference ranges & thresholds** expands the criteria used for the displayed
statistics and parameters. These checks are heuristics, not a verdict on fit
validity. Parameter checks include ±1σ when available; without an uncertainty,
only the value is checked. Colors, reference criteria, and labels do not alter
the fitted values, scientific calculation, or downloaded report.

Noise is estimated by Larch from the high-R region, 15–30 Å. The existing Athena
processed arrays do not retain `delta_chi`, so this iteration does not propagate
that background uncertainty into the fit. There is no user-specified noise
input yet. Reported error bars do not include systematic model errors.

That estimate, ε(k), is reported with the fit as **Noise ε(k)**. It is the only
scale against which the fit's χ² means anything: the residual Larch minimizes is
the data-minus-model transform divided by ε, so χ² and reduced χ² scale with
1/ε(k)². AIC and BIC do not: they are built from `N_ind · log(χ²/N_ind)`, so
rescaling χ² by a constant shifts them by an additive constant rather than
scaling them. Two χ² values obtained with different ε(k) are therefore not on
one scale; and putting them on one scale is not the same as making them
comparable, since two fits on different data, grids or k weights also weight
their points differently. The fitted values, their uncertainties and the R-factor do not
depend on ε at all, because `propagate_uncertainties` rescales every standard
error by `sqrt(redchi · nfree / (N_ind - N_vary))` afterwards; that invariance
holds for a common rescaling of the whole objective, not for a change in the
relative weight of one point against another. When several k weights are fitted
together, the reported ε(k) is the one belonging to the weight the curves are
drawn at.

Supplying ε(k) by hand, as some published reference fits do, does **not** give
the same χ² as letting Larch estimate it. Larch converts between ε(k) and the
ε(R) its residual divides by with two different factors:
[`estimate_noise`](../larch/xafs/feffit.py) uses
`scale = sqrt(2·pi·w / (kstep·(kmax^w - kmin^w)))`, while
[`set_epsilon_k`](../larch/xafs/feffit.py) uses
`scale = 2·sqrt(pi·w / (kstep·(kmax^w - kmin^w)))`. Those differ by exactly √2,
so handing Larch back the very ε(k) it just estimated divides ε(R) by √2: the
R-space residual grows by √2 at fixed parameters, and χ² doubles.

Which branch is self-consistent can be settled for one case and not for the
general one. `xftf_fast` normalizes its transform by `kstep/sqrt(pi)`. For a
**rectangular** window, carrying white noise of variance σ² through that
transform gives a per-component variance that `estimate_noise`'s conversion
reproduces exactly, while `set_epsilon_k` predicts half of it — so there
`estimate_noise` is the consistent branch and `set_epsilon_k` is not. For a
**tapered** window this does not follow: the transformed noise depends on the
window's squared, k-weighted values, whereas `estimate_noise` divides the
high-R root-mean-square by the window's *mean* value (`kwin_ave`). That
correction is an approximation of unquantified accuracy, so no claim is made
here that the estimated ε(k) is the physical noise under a Hanning window. What
is claimed is only the round trip above, which is exact and in which the window
correction cancels.

Two further caveats. The √2 statement is for a single k weight: given an
iterable matching the weight count, `set_epsilon_k` keeps only its first
element, so several separately estimated noise values do not survive the round
trip channel by channel. And matching a scalar root-mean-square would not by
itself make χ² a χ²-distributed statistic, because neighbouring R bins of the
transformed residual are correlated.

The web app takes the `estimate_noise` branch, so a feffit χ² obtained with a
hand-supplied ε(k) is twice as large for the same fit. This is an upstream
inconsistency, not a choice made here; if Larch reconciles the two, the factor
in `test_artemis_benchmarks.py` goes away.

## Results and state

The Results area keeps its EXAFS fit viewer available alongside Spectrum,
Wavelet, CIF, and a separate FEFF path viewer, regardless of which processing
tab is open. The FEFF viewer shows the current model's path metadata and atom
geometry; add or edit paths in the EXAFS fitting tab. The fit plot compares
data, model, and residual in k or R space. **Show paths** is checked by default
when the saved fit includes individual path curves; uncheck it to hide them.
Long legend labels wrap to fit the plot width without overlapping neighboring entries.
R plots offer
magnitude, real, and imaginary components. The magnitude residual is
`abs(FT(data - model))`, not the difference between the data and model magnitudes.
Plots use the first selected fit k weight; the optimizer uses all selected
weights. Statistics, fitted parameter values, uncertainties, correlations,
and the complete Larch report appear below the plot. **Fit summary** combines
FEFF path thumbnails with fitted R, CN and σ², followed by the parameter values,
uncertainties, initial values and treatment in the same card. Thumbnails use the same 3D atoms, bonds and path arrows as the FEFF viewer,
rendered from the original saved geometry (before fitted ΔR), with verified FEFF
input context from that fit's archived model. **Explore 3D** opens one enlarged
preview: drag to rotate, scroll or pinch to zoom, or reset the view. Closing it
updates its thumbnail and remembers that path's camera while the result stays
open. The table keeps static images; a single temporary renderer generates them
in sequence and releases its resources, and only one interactive preview opens
at a time. Theme changes refresh the images. Previews do not use the current
edited model or trigger a fit. Missing geometry and unavailable WebGL show
explicit placeholders. Narrow panels stack each path above its three numeric
columns.

For the **Set / fit coordination number** model with fixed S₀², the CN column
shows the saved CN parameter and its uncertainty. Otherwise a single-scattering
path shows structural degeneracy labeled **FEFF N**, which is not a fitted CN;
multiple-scattering paths show no neighbor CN. The evaluated amplitude expression
is never multiplied by FEFF degeneracy and called CN. R and σ² show standard
errors only when a saved direct parameter reference supplies them; composite
expressions do not have inferred error bars. The full parameter table retains
status colors, bounds and expressions, and the original report/JSON downloads
remain unchanged.

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
| `GET /api/artemis/structures?q=...&element=...&limit=...` | API default remains AMCSD; `provider=materials_project` searches MP and `provider=auto` (the UI default) searches MP then AMCSD with formula relevance ranking and per-source warnings. `element` is one optional symbol and `limit` is 1–50. |
| `GET /api/artemis/structures/{id}` | Retrieve CIF text, citation, lattice parameters, native site indices, and supported/unsupported status. MP IDs require `provider=materials_project`. |
| `GET /api/artemis/projects/{id}/structures` | List the current project's saved CIF snapshots and project version. |
| `POST /api/artemis/projects/{id}/structures` | Attach using `{version, amcsd_id}`, `{version, provider: "materials_project", material_id}`, or `{version, provider: "uploaded", filename, cif}` with full CIF text; return the updated project. |
| `POST /api/artemis/feff/jobs` | Start an isolated FEFF8L job; returns HTTP 202 and its job ID. |
| `GET /api/artemis/feff/jobs/{id}` | Poll `running`, `complete`, or `failed` status, log, input provenance, and generated paths. |

The popup's job request specifies `project_id`, `attachment_id`, `version`,
`absorber`, `edge`, `site_index`,
`cluster_radius`, `path_radius`, `max_legs`, and `max_paths`. `max_paths` defaults
to 60 (range 1–100) for path review; null retains every generated path for
simulation. Supported edges
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

## Benchmarks against reference feffit fits on public spectra

`backend/tests/test_artemis_benchmarks.py` refits twelve reference EXAFS models
through the app's own request model and compares every number with the plain
Larch feffit result recorded for them. They are reference fits made with plain
Larch `feffit` on public spectra from the PFXAFS and XASDB databases, not
published fits, and they start from processed χ(k): they show the browser runs
Larch's fit, not that import, normalization or the models themselves are right. The models are two per spectrum — a
first-shell fit and a first-plus-second-shell fit with independent σ² — over six
measured spectra: CoO, α-Fe₂O₃, NiO and ZnO at their respective K edges, and a
Ge foil at 77 K in two separate scans. The measured χ(k), the FEFF85L path files
and the reference fits are vendored under
`backend/tests/fixtures/exafs-benchmarks/` (about 220 kB) so the suite needs no
external checkout; `backend/tests/reference/exafs_benchmark_native_reference.py`
rebuilds them from the unpublished checkout the reference fits came from, and the suite checks the
sha256 of every input it was recorded against.

Each case asserts the fitted values, the uncertainties, the R-factor, the
independent-point count, the data length and the exact optimizer step count.
Measured agreement is below 3 × 10⁻⁸ relative on every fitted value and
uncertainty and below 10⁻¹³ on the R-factor; the committed tolerances are looser
(10⁻⁶ relative, 10⁻⁹ absolute) so a different BLAS or CPU does not fail the
suite while a change moving a fitted number in the sixth digit still does. The
goodness-of-fit comparison first puts both fits on the same noise scale, undoing
the ε(k) difference and the factor-of-2 Larch convention described under *Fit
ranges, weights, and interpretation*. The whole suite runs in about 3.5 s.

## Scope beyond this iteration

Future work includes Atoms input, disordered structures
and automatic averaging over absorber sites, desktop Artemis project interchange,
simultaneous multi-dataset fits, q-space and wavelet fitting,
background co-refinement, additional cumulants, dynamical-matrix/trajectory disorder inputs,
restraints, and the remaining desktop GDS parameter types. Directly importing a
FEFF path uses an existing calculation; the AMCSD workflow separately creates
FEFF input and runs FEFF8L.

The implementation draws on the official
[Artemis manual](https://bruceravel.github.io/demeter/documents/Artemis/),
[legacy user guide](https://bruceravel.github.io/demeter/artug/index.html),
[data/transform controls](https://bruceravel.github.io/demeter/documents/Artemis/data.html),
and [model validation](https://bruceravel.github.io/demeter/documents/Artemis/fit/sanity.html).

## FEFF path viewer

The **FEFF path viewer** displays one **CIF source** and absorber site at a time.
Choose the source above the scene; its paths alone appear in the legend, geometry,
details, contribution curves, and table. Generated paths retain their CIF identity
when saved or exported. Older paths are grouped by their recorded FEFF input
cluster or a uniquely matching attached CIF; files with an unknown source remain
individually selectable. Switching sources does not change fit inclusion.

A clickable **FEFF0001**, **FEFF0002**, etc. legend inside the 3D canvas includes
paths excluded from fitting. Toggle any combination of paths from the selected
source to overlay their representative trajectories. Each path has a distinct
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

### Path contributions, sorting, and filtering

Below the 3D scene, **Show χ(k) and χ(R) contributions** draws what each path
contributes to the model *before any fit is run*. The curves come from the
current editor state — the FEFF files, the path expressions, the GDS parameter
values, and the Fourier-transform settings — evaluated by Larch's `feffpath`
and the same `feffit_transform` the fit uses. No measured spectrum enters, and
nothing is refined: a Guess parameter contributes its starting value. This is the
usual way to decide which paths are worth including before paying for a fit.

Each enabled path gets one trace in its legend color, plus a **Sum of shown
paths** trace. In k space the curves are weighted by the first selected fit
k weight, as elsewhere in the app; in R space you can switch between magnitude,
real, and imaginary parts. The shaded band marks the fit range (k range in k
space, R range in R space). Magnitudes do not add: the complex path
contributions are summed first and the magnitude is taken afterwards, so
destructive interference can make the sum smaller than a single path.
R is not phase corrected, so peaks fall roughly 0.2–0.5 Å below the true
interatomic distance.

The table lists every path in the selected source — included or not — with its FEFF header values
(legs, `Reff`, degeneracy) and, once the curves exist, three measures of size:

| Column | Meaning |
| --- | --- |
| Peak \|χ(R)\| | The tallest point of that path's own χ(R) magnitude |
| R at peak | Where that peak sits, in Å, not phase corrected |
| Area in R window | \|χ(R)\| integrated over the fit R range: the part the fit actually sees |

Click a column heading to sort by it; click again to reverse. **Path** restores
the model's own order. Paths whose curves have not been computed keep their
header values and sort to the end rather than being treated as zero.

The filters narrow the table, the plot, and the in-canvas legend together, so
the three never disagree. **Legs** separates single scattering (two legs) from
multiple scattering (three or more). **R_eff at most** drops distant paths.
**Peak |χ(R)| at least** drops paths below a fraction of the largest path in
the selected source and needs the contributions to have been computed first; a path whose
amplitude is unknown is never hidden. Filtering is a display choice: it does
not change which paths are included in the fit. Use the EXAFS fitting tab's
inclusion toggles for that.

### CrystalNN first coordination shell

The CIF viewer automatically analyzes its center site with pymatgen CrystalNN.
In **EXAFS fitting → FEFF paths → Generate FEFF paths**, the selected absorber
site is also analyzed for FEFF path selection. Results show predicted CN,
neighbor elements, distance ranges, alternative coordination weights, and any
radius/oxidation-state warnings. The shell is the most probable bonded-neighbor
set; it is not a fitted CN or an R-space Fourier-transform window.

The viewer keeps the element legend colors when highlighting the first shell.
The largest sphere marks the center; larger neighboring spheres mark CrystalNN
first-shell atoms. An on-canvas label identifies the center element and site.
**View → CrystalNN first shell** displays the entire shell, including
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
shell around the selected center. The center remains in its element color and
is shown as the largest sphere with an explicit center label. The table below the
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

In **EXAFS fitting → FEFF paths → Generate FEFF paths**, choose an attached CIF.
The spectrum's unique matching absorber site is selected automatically; select a
site explicitly when several match. The selected site determines the shell ranges. Generated FEFF and existing model paths are grouped
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

## Differentiable fast-fit backend

A second fit backend minimizes the same objective with an exact Jacobian
obtained by automatic differentiation, instead of the finite-difference
derivatives Larch's `feffit` passes to MINPACK. It is offered as an option
beside the reference backend, never in place of it.

### What it shares with the reference fit

Both backends enter through one function, `fit_inputs` in
`backend/xraylarch_web/artemis.py`, which validates the request and builds the
Larch objects. They therefore fit the same χ(k) over the same k range with the
same k-weights, the same Hanning windows, the same path files and the same
ε(k) noise scale, and they draw their curves through the same code. A
difference between the two is a difference in the optimizer, not in how the
request was read. The HTTP response has the same shape from either route, so a
client can switch backends without special-casing anything.

### How close the two forward models are

The differentiable path equation is a separate implementation of the EXAFS
sum, so the first thing to establish is that it computes the same function.
After the fast fit converges, the backend evaluates Larch's own residual at the
fitted parameters and reports the largest absolute difference from its own as
`metadata.engine_parity`. Across the twelve benchmark models this is 2 × 10⁻¹³
to 9 × 10⁻¹³ — agreement at the level of floating-point rounding. The suite
fails above 10⁻⁸. This check matters because a wrong physical constant or a wrong
window would otherwise hide inside a refit: the optimizer simply absorbs it
into the parameters, and the fit still looks converged.

The forward model is `diffexafs_core.pathsum.feff_path_chi`. The facade passes
Larch's own `KTOE` constant through its `ktoe` argument, so both models use the
same conversion between photoelectron wavenumber squared and energy even if
their default CODATA revisions differ. E₀ is passed unchanged: no rescaling
workaround or global constant override is needed.

### Why the fitted parameters are not bit-identical

The backends produce practically equivalent fits. Across all twelve
benchmark models the largest difference in any fitted value is **0.0014 of that
value's standard error**, and the largest difference in any uncertainty is
0.33 % relative. Nothing here changes a reported bond length or coordination
number at any digit a user reads.

The two final objectives are not identical. Scored with Larch's own residual —
taking the two converged parameter sets and evaluating both through
`FeffitDataSet._residual`, so that nothing but the proposed parameter values
comes from the new code — the differentiable backend's objective is the smaller
one, by 10⁻¹² to 10⁻⁷ relative, in all twelve cases. **These differences are
within the optimizer stopping tolerances, and their cause has not been
isolated.** The two solvers differ in algorithm, scaling and termination test as
well as in how they obtain derivatives, so a smaller final objective does not
by itself show that the finite-difference search terminated early, and neither
solution has been characterized as the more accurate stationary point. Settling
that would mean recording each solver's termination reason, restarting both
from tighter tolerances, and comparing a numerical against an automatic
Jacobian inside one solver — none of which is done here.

The fast backend also takes far fewer steps — 9 to 17 residual evaluations
against Larch's 32 to 109 — though that comparison flatters it, since each of its
steps also computes an exact Jacobian; the matched-phase timings below are the
honest measure.

`backend/tests/test_artemis_fast.py` therefore states its tolerances in
standard errors rather than in digits: values must agree within 0.01 σ and
uncertainties within 1 %. The χ² assertion is that the fast backend is no worse
than the reference's by more than 10⁻⁶ relative — equivalence within the
stopping tolerances, not strict improvement, which would be an assertion about
where each solver happens to stop. The Larch-rescoring check above runs over all
twelve benchmark cases and asserts the same slack. A tolerance in relative
digits would be measuring the optimizer's stopping rule rather than the physics,
and would have to be loosened every time either optimizer changed.

### Speed, stated plainly

Both engines report the same timing phases in `metadata.seconds`: `total` (the
whole fit on the server, from reading the request to the finished curves),
`fit` (the fit call: set-up, minimization, uncertainties and output arrays) and
`optimizer` (the minimization loop alone; for `feffit` it is bracketed by
lmfit's per-evaluation callback, which does not change the fit). The fast
engine adds `compile` and `covariance`.

Measured that way over the twelve benchmark models on the aarch64 development
machine (3 October 2026, each model warmed once): the optimizer loop has a
median of **23 ms for Larch against 33 ms for the fast engine**, and the
per-model ratio runs from 0.3 to 1.9 — the fast loop is quicker on some models
and slower on most. It makes far fewer residual evaluations (9 to 17 against
Larch's 32 to 109), but each of its evaluations also computes an exact Jacobian.
An earlier version of this section claimed the optimizer was "about 5× faster"
(12 ms against 63 ms); that compared feffit's whole call with the fast engine's
loop alone, and does not hold when the same phase is timed.

End to end the fast engine is much slower on fits this size: compiling the
residual and its Jacobian takes about 0.9 s (median), and because the facade
builds a fresh closure for each request the compilation cache never hits, so
the cost is paid on **every** fit — a median whole fit call of 0.91 s against
37 ms. Making compilation amortize would mean hoisting the data and path arrays
into traced arguments keyed by model structure; that is a real design change,
not a tuning knob, and has not been done. Today the engine's value is the
independent check it gives — the same answer from a different optimizer and a
differently written forward model — not speed.

### In the app

Below the fit controls, **Fast fit backend** repeats the fit on screen with the
differentiable engine and reports the difference. It is a comparison, not a
second way to fit: the result is displayed and discarded, and saved fit history
stays single-engine, so nothing in a project file depends on which engines a
deployment has.

The control is offered only while the model in the editor is still the model
that produced the result on screen — not after an edit, and not for a saved fit
whose processed data has since changed. Otherwise the button is disabled and
says which of those is the reason. Comparing a new model's fast fit against an
old reference would present a difference in models as a difference between
backends, which is exactly the error the panel exists to rule out.

What it shows: the two optimizer times, the fast backend's compilation time and
its full round trip; the largest change in any fitted value, expressed in that
value's own standard error; the direction and relative size of the χ² change;
the residual-evaluation counts; and `engine_parity`, so a reader can see that
the two forward models are the same function before reading anything into the
parameters.

### Availability

The differentiable engine is an optional dependency, imported lazily.
`GET /api/artemis/fast-fit/status` reports whether it is importable and why not
if it is not. The web client asks it once per page and leaves the comparison
panel out entirely when the engine is absent, as it is in a standard
deployment; if the status cannot be read, a fit request to a server without
the engine still comes back as `fast_engine_unavailable` with the same reason,
which the panel shows. When the engine is absent the
parity suite **skips** — which is not the same as passing, and a deployment
that intends to offer this backend must run the suite with the engine
installed.

Install the optional engines on top of `backend/requirements.txt`. From
`backend/`, with a folder containing the `diffexafs-core==0.1.0` wheel:

```
pip install -r requirements-engines.txt \
    -c ../deploy/python-release-constraints.txt --find-links <wheel-folder>
```

`diffexafs-core` is not on PyPI; `--find-links` supplies its wheel without a
checkout dependency. The file pins CPU JAX and CPU-only PyTorch (from the
PyTorch CPU index), and also installs MapsTorch 0.0.2 from PyPI for the optional
XRF engine. Normal dependency resolution is intentional; do not use `--no-deps`.
Neither engine is in `backend/requirements.txt`. Deployment scripts install
that file explicitly, not a requirements-file glob, so a standard deployment
still omits the engines and `tests/test_artemis_fast.py` skips. After installing
the engines, restart the server so availability is checked again.
