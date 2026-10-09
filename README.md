## Larch:  Data Analysis Tools for X-ray Spectroscopy and More


[![A](https://github.com/xraypy/xraylarch/actions/workflows/test-ubuntu.yml/badge.svg)](https://github.com/xraypy/xraylarch/actions/workflows/test-ubuntu.yml)
[![B](https://github.com/xraypy/xraylarch/actions/workflows/test-windows.yml/badge.svg)](https://github.com/xraypy/xraylarch/actions/workflows/test-windows.yml)


Larch is an open-source library and set of applications for
visualizing, processing, and analyzing X-ray absorption and
fluorescence spectroscopy data from synchrotron beamlines.  While its
origins and emphasis are in X-ray absorption fine-structure
spectroscopy (XAS), including X-ray absorption near-edge spectroscopy
(XANES) and extended X-ray absorption fine-structure spectroscopy
(EXAFS), it also supports visualization and analysis tools for several
related X-ray measurement modes.  These include X-ray fluorescence
(XRF) spectra and XRF and X-ray diffraction (XRD) images as collected
at scanning X-ray microprobe beamlines.

Larch is written in Python, and makes heavy use of the excellent
scientific Python libraries.  It can be used as a Python library, or
through one of several Graphical User Interfaces, including Larix, and
others listed in the table below.

Larch is distributed under the MIT licence.  It has been under active
and open development for more than a decade, and is built on XAFS
analysis tools that go back to the 1990s.  Development is done
primarily at the University of Chicago, with support from the US
National Science Foundation, and the US Departmen of Energy.

The best citable reference for Larch is https://doi.org/10.1088/1742-6596/430/1/012007

## Athena Web branch

The web application is named **XAScraft**.

The `Athena` branch adds a browser implementation of Athena's XAS workflows.
**Save project** defaults to the complete web project (`.json`), with a file-name
confirmation before download. Native Athena (`.prj`) exports remain in **File**.
Enable **Show instruction** at the top right to display inline information icons;
they are hidden by default. Field-level instructions cover processing, imports,
analysis, EXAFS fitting, CIF/FEFF setup, simulation, and viewer controls. Hover,
focus, or tap an icon for its meaning, units, and relevant constraints; press
Escape to dismiss it. Help stays out of the form layout and does not change data.

The Xraylarch, Demeter, and Dr. XAS team credits stay visible below the XAScraft
title, independently of **Show instruction**.

For standalone development, open [http://localhost:3004](http://localhost:3004)
using the local commands below, then import spectra or load the measured copper
examples: three temperature-series foils, a room-temperature Cu₂O reference,
and a shared Cu foil reference. Data groups show each sample’s reference as
an indented link; **Ref** assigns one foil to several selected spectra.
See [shared reference foils](docs/athena-reference-links.md) for energy-shift
behavior and demo provenance.
The local copper loader also attaches the Cuprite CIF and opens the Cu₂O
EXAFS model with four FEFF paths, ready to fit.
The earlier single-spectrum interface is at `/classic`. The
Dr.XAS-integrated build is mounted at `/advanced-xas/app`; its deployment binds
both the frontend and backend to loopback and relies on Dr.XAS ingress rather
than exposing either service port directly.

When mounted, this application is half of a two-repository system, and three
things about the seam are contracts rather than details:

- **Dr.XAS pins this repository's exact revision**, in its role manifests
  (`xraylarchRevision`) and its backend settings (`sibling_revision`), together
  with `integration_contract_version` 2. Its topology verification fails closed
  on a mismatch, so a deploy or rollback here that changes the revision has to
  be matched on the Dr.XAS side before its next role activation.
- **`/api/integration/v2/**` is service-only.** Only the Dr.XAS backend calls
  it, over loopback, with an HMAC-SHA256 signature and a per-project capability
  header. No browser path reaches it, and the capability never travels to a
  browser.
- **The `return` launch parameter must be an app-relative Dr.XAS path.**
  `parseSafeInternalReturn` rejects anything else, and a rejected value silently
  removes the "Import into Dr.XAS" and "Return to Dr.XAS" affordances — the
  scientist is left in Athena with no way back. Dr.XAS sends
  `/chat/<conversation_id>`.

`frontend/tests/e2e/integration-mounted.spec.ts` covers this application's own
mounted lifecycle. The *cross-application* acceptance — both frontends, both
backends and the Dr.XAS public ingress hop as one system — lives in the Dr.XAS
repository at `frontend/tests/e2e/xraylarch-native-integration.spec.ts` and
starts its own five processes on ephemeral ports.

The [recipe fidelity contract](docs/integration-recipe-fidelity.md) explains
which processing can be replayed and when exports retain computed arrays.
It also records measured-spectrum regressions for fnorm, background standards,
and already-normalized inputs.

The `Artemis-web` branch adds **EXAFS fitting** alongside **Processing** in the
middle parameter panel. Search the bundled AMCSD database or Materials Project
in the CIF popup (MP requires `MP_API_KEY` in the backend environment), attach
the selected CIF directly to the project, or choose **Upload CIF** to attach your
own `.cif` file (up to 500 KB). Uploaded CIFs keep their original text and filename
in saved projects. Use the pencil icon beside an attached CIF's name to rename it;
the trash icon removes it from the project.
Names survive saving and reopening the project; source identifiers, original CIF
text, and uploaded filenames stay intact. Select an absorber
site, and calculate FEFF8L scattering paths using
Larch/Larixite. Review the generated paths and add the selected ones to the
model, or import existing FEFF path files. Define Guess/Set/Def parameters
and fit the current spectrum with Larch's `feffit` core in k or R space. A Cu
first-shell starter model is included. The right panel shows data/model/residual
curves, uncertainties, correlations, and the fit report. Save model drafts in
the project; each explicit fit also saves its model and result. Athena `.prj`
and web JSON downloads retain FEFF files and up to 10 fits per spectrum.
Changed scientific inputs and imported archives are clearly labeled.
Project Save actions open a confirmation dialog where you can edit the download
filename or cancel. The selected format's `.prj` or `.json` extension is added
automatically; the exported filename does not rename the saved project.
See the [Artemis Web guide](docs/artemis-web.md) for the workflow, scientific
conventions, supported expressions, and current limitations.

**Simulate EXAFS from CIF** is in **Crystal structures**. Each attached CIF also
has a **Simulate EXAFS** button that opens the calculation with that structure selected.
No measured spectrum is required. Choose an absorbing site, edge and maximum R,
enter S₀², disorder, ΔE₀ and ΔR, then run the simulation. Correlated Debye is the
default disorder model: sample temperature starts at 298 K, and the material's
Debye temperature ΘD must be supplied. It computes σ² separately for each path;
an optional shared static σ² starts at zero. Fixed σ² remains available.
FEFF runs automatically and
sums every generated path within the requested effective half-path length,
including single and multiple scattering through four legs. Simulation has no
path selection or returned-path count limit; fitting retains its separate path
selection. View χ(k) and |χ(R)|, download CSV curves, or export simulation
JSON containing the exact CIF, FEFF input, path files, parameters and results.
S₀² defaults to 0.85. After simulation, **Add to data list** saves χ(k) with a
**theory** tag, its Fourier parameters, and the exact CIF/FEFF sources in the
project. Simulated spectra use the CIF's custom name or uploaded filename before
falling back to its chemical formula, followed by the element, edge, and **theory**.
Disorder-model inputs are assumptions; inequivalent sites are not averaged automatically.

The **Single spectrum viewer** plots the highlighted group, independently of
its checkbox. The **Multiple spectra viewer** plots the checked data groups.
Both panels can stay open together and keep independent plot spaces, ranges,
colors, legends, and heights. In **R** and **q**, use the component checkboxes to
overlay **Magnitude**, **Real**, **Imaginary**, and **Phase**. Components share
each spectrum’s color and use distinct line styles; phase has its own radians
axis when overlaid with amplitude. R and q keep separate selections. In q,
**Real + χ(k)** also shows the original weighted χ(k) for comparison.
For an individual **μ(E)** plot, use
**Pre-edge line** and **Post-edge line** to show either fitted normalization line. **Background**
separately shows the fitted μ₀(E) background within the selected spline range.
**Spline clamps** uses Athena's None, Slight, Weak, Medium, Strong, and Rigid
choices; new spectra default to low None and high Strong. Saved custom weights
are preserved. Spline dk, window, and clamp points are under **Advanced spline
settings**. See [spline ranges and clamps](docs/athena-background-clamps.md)
for tuning guidance and the meaning of the background cutoff.
Each normalization-line toggle also marks its interval's start and end on
μ(E). Hover a marker to see its energy and offset from E₀.
Single-spectrum energy plots also mark the processed E₀ with a vertical dotted
line and its value in eV, including normalized and derivative views.
Use **⌖** beside a processing parameter, then click a point on the curve in
the **Single spectrum viewer** to update it and process automatically. Relative
energy limits use E − E₀. Press Escape or **Cancel pick** to leave picking mode.

Drag the handle below any artifact viewer to resize its plot or 3D structure;
double-click it to restore the default. Each viewer remembers its own height,
including CIF previews, FEFF structures, path contributions, and simulations.
The focused handle also supports Up/Down arrows and Enter to reset.
**Show legend** toggles the single-column legend on the
right. All plot legends use fully transparent backgrounds, including image exports
and CIF/FEFF structure legends. The **k-weight** selector above the viewer controls the k, R,
back-transform, and wavelet views together. **Auto** uses each spectrum’s
processed weight; choosing 0–3 updates the display without changing saved
processing parameters.

Numeric processing fields enforce their physical signs, integer counts, and
ordered intervals before processing. FT, spline, viewer, and export k-weights
are limited to 0–3. Invalid edits remain visible for correction without changing
the saved calculation. See [parameter ranges](docs/parameter-ranges.md) for
units, meaningful starting values, and spectrum-dependent limits.

The spectrum's **Color legend** selector offers classic categorical colors and
viridis, plasma, inferno, cividis, and coolwarm gradients, with a **Reverse**
option. These spectrum settings are independent of the wavelet's magma scale.

The **Results** chooser above the viewers shows Single spectrum, Multiple
spectra, Wavelet, CIF, FEFF path, and EXAFS fit in that default order. Drag a chip's
handle to reorder both the chips and their viewer panels, or focus the handle and
use arrow keys (Home/End moves to the first/last position). **Custom order** is
remembered in this browser across project loads and reloads; **Default order**
restores the original arrangement. Each chip can show or hide its viewer;
**All viewers** toggles them together. **Process
order (this session)** keeps both spectrum viewers first, then places derived
viewers with recorded events from oldest to newest (saved CIF
attachment time and the current spectrum's wavelet, FEFF path, or fit activity
in the workspace). Viewers without a recorded event retain their default order.
These display choices do not change project data or recalculate results.

The **Wavelet plotter** follows the highlighted group’s
processed χ(k). The default **2D + 3D** view places the heatmap on the left and the
surface on the right, stacking them only when the plot panel is 640 px wide or less.
The 2D plotting area stays square
when the browser or plot height is resized, preserving the k and R ranges.
The k-range slider sits directly above the heatmap and follows its x-axis bounds
as the plot resizes.
**2D heatmap** and **3D surface** remain available individually. Both views share
one result from Dr.XAS’s unwindowed Cauchy transform and one color scale,
displaying R up to 6 Å without phase correction. Draggable k-range handles and
heatmap boundary lines update the windowed χ(k) and Fourier |χ(R)| previews below
the main plots.
These previews use Larch with the spectrum’s applied window settings and the
selected viewer k-weight; changing the range does not modify saved processing
parameters or the wavelet matrix. **Export CSV** downloads the active wavelet
grid. Range dragging does not rebuild the 3D surface. All views retain the
resizable plot height, and the plots refresh after spectrum processing.

The Athena import dialog shows a live plot while selecting columns. It also
recognizes FEFF `xmu.dat` tables, selecting photon energy (`omega`) and `mu`
while preserving the supplied normalization. Detector choices and previewed
signals can be reviewed before import; successful import choices are remembered
for subsequent matching files.

EXAFS processing is automatic for new absorption imports. Short near-edge scans
retain their normalized spectrum and explain why EXAFS was not calculated;
longer scans calculate the background and Fourier transforms when supported.
**Input already normalized** still preserves supplied normalized values.
Use **Group → Processing settings…** after import to turn EXAFS on or off manually.

The current group's element and absorption edge are shown automatically, using
saved file metadata when available or inference from E₀. No manual identity
selection is required.

Use **Select E₀…** beside the E₀ field in **Processing → Normalization** to
choose an E₀ method for the current, marked, or all groups. In **Import data →
Advanced import settings**, **Enforce element and edge** sets the element,
absorption edge, and edge-step fraction for future raw-file batches. Turn the
same checkbox off to stop applying the policy to new batches. The import window
shows both the next-batch setting and the current batch's fixed policy; changing
the setting leaves the current batch, existing spectra, and restored projects
unchanged.

Use **Group → Change data type** to correct current, marked, or all energy
groups after import. The type button next to Freeze also supports Athena's
Ctrl+Alt-click μ(E)/XANES toggle, preserving the normalized-input flag. Legacy
project records explicitly typed as detector signals display their counts
without normalization or EXAFS processing.

Right-click the group list or processing labels, or use their **⋯** buttons,
for Athena's current-group actions, paired parameter copies and reports.
Plot tabs also offer native shortcuts; **Plot → Plot shortcuts…** exposes the same
comparisons without right-clicking. Plugin and XDI field menus provide reader
documentation/configuration and saved-field validation. See the
[context-menu reference](docs/athena-context-menu-reference.md) for the pinned
native inventory, tested scientific reports and remaining desktop differences.

Athena import also recognizes native NSLS X10C, Lytle encoder, SSRL ASCII,
SSRL binary, SSRL MicroEXAFS and SPEC zapline mono files. It converts them before column selection
and offers the reader's transmission/fluorescence channel suggestions. The
live preview shows the selected signal; original and converted files can both
be downloaded. For MicroEXAFS without a transmission detector, use the
fluorescence suggestion and select additional SCA columns to sum channels.

For multi-scan SPEC files, choose the scans and preview each before reviewing
the detector columns. Selected scans import in file order and can reuse a
mapping when their columns match. Check the energy axis and signal polarity
in the preview; the official SNBL sample needs **Invert signal** with its
Ion1/Ion2 suggestion. See the [SPEC contract](docs/athena-spec-reference.md)
for the source/sample differences and tested import flow.

**SRS**, **DUBBLE** and **PFBL12C** readers handle multi-line detector records
and monochromator angle conversion. Their converted columns are available in
the same live preview. Photon Factory files distinguish requested and attained
energy; SRS files explicitly labelled ENERGY retain their supplied axis.
See the [angle-reader contract](docs/athena-angle-readers-reference.md) for
native channel defaults, geometry fallbacks and measured verification.

**CMC**, **HXMA** and **LNLS** handle dark-current correction, named CLS detector
columns and date/time-prefixed measurements. Their converted values and native
channel suggestions appear in the same live preview. For the official CMC
sample, the transmission denominator is zero: choose **Use fluorescence
columns**; automatic import retains its short scan as XANES. See the
[scalar-reader contract](docs/athena-scalar-readers-reference.md) for examples,
native numerical comparisons and retained source metadata.

**X15B** binary files and **X23A2MED** Vortex detector files have working
**Configure** forms in the plugin registry. Apply changes the current server
session; Apply and Save also persists the reader settings. After editing
source columns, deadtimes or integration time, return to import and choose
**Reinspect selected file** to update the columns and live preview. The
[configured-reader contract](docs/athena-configured-readers-reference.md)
records native defaults, official examples and numerical comparisons.

**X23A2MultiChannel** and **10BMMultiChannel** convert four simultaneous
samples into a project with independent channel previews and group selection.
10BM also supports a reference channel, names, detector columns, temperature
labels and per-channel energy shifts. Open **Configure reader** in the preview,
then **Reinspect source file** to review updated curves before importing.
See the [multichannel contract](docs/athena-multichannel-reference.md) for
measured samples, native comparisons and remaining limitations.

**B18** retains all points with Larch and suggests the 36-channel fluorescence
sum. **BM23** converts keV to eV and offers independent scan previews for
multi-scan files. Both use the live column editor; see the
[header-reader contract](docs/athena-header-readers-reference.md) for native
comparisons and the current constructed-fixture validation boundary.

Enable these readers in **File → Plugin registry…** before importing; Athena's
initial registry leaves plugins unchecked. Switches persist across sessions.
The registry provides documentation and imports/exports native
`athena.plugin_registry` settings. **File plugins…** in the import panel lets
you enable a reader and retry the selected file.

**Process → Dispersive energy calibration** compares an uploaded pixel standard
with a conventional scan. Review the live pixel-column plot, estimate or refine
the energy calibration, then make a new processed group. Native `athena.dxas`
settings can be saved, loaded and exchanged; the **SLRIBL4** reader uses the
saved calibration for pixel/stripe files. See the [dispersive contract](docs/athena-dispersive-reference.md)
for the official Cu/Pd examples and remaining native-equivalence work.

**Process → Fluorescence XAS from XRF fit** builds a fluorescence spectrum by
fitting the whole multi-channel detector spectrum at every point of an energy
scan, instead of summing a fixed channel window. The elastic and Compton
scatter peaks move as the monochromator scans, so a fixed window records their
sweep as absorption structure; fitting separates them from the stationary
fluorescence lines. Upload the scan file, name the target element and the other
elements present, and the panel shows the detector spectrum with its fitted
components, the extraction against the plain window sum, a pre-edge null test
and the agreement between detector elements, then exports both curves as Athena
groups. See the [XRF-to-XAS contract](docs/athena-xrf-xas-reference.md) for the
model, the three solve stages and what the quality indicators do and do not
cover.

See [Athena research and tutorials](docs/athena-research.md),
[implementation and validation](docs/athena-verification.md), and the
[remaining full-parity work](docs/athena-parity.md). This branch is under active
development and does not yet implement every desktop Athena option.

**Process → Convolve data** adds Gaussian/Lorentzian broadening and artificial
normal noise with live original/modified E/k/R plots. Noise is scaled by the
processed edge step, and saving retains exactly the noise realization shown
in the preview. Controls survive closing the tool; zero width or zero noise
lets you use each operation independently. See the
[convolution contract](docs/athena-convolution-reference.md) for native Cu/Fe
comparisons, reproducible noise, project exchange and remaining limits.

**Process → Align scans** compares the current or marked groups with a fixed
standard using live μ(E), normalized, derivative and smoothed-derivative plots.
Use the native shift buttons, enter a total shift, or fit automatically; review
the shift uncertainty and residual before saving. Linked references share the
shift while each group's E₀ remains fixed. Native `.prj` files preserve the
rounded uncertainty. See the [alignment reference](docs/athena-alignment-reference.md)
for executed original-template comparisons and remaining parity limits.

**Process → Merge marked groups** previews μ(E), normalized μ(E) or χ(k),
with importance, edge-step or native noise weights and short-scan exclusion.
Review the contributing scans, standard deviation and linked-reference merge
before saving. The result stays open for comparison; Undo/Redo and native
`.prj` exchange retain its arrays and reference links. Ctrl/Command+Shift+M,
N and C open the three merge spaces. See the
[merge reference](docs/athena-merge-reference.md) for original Demeter/Larch
comparisons and the documented discrepancy in native noise weighting.

**Plot → Saved merge spread…** reopens standard-deviation plots for any
saved merge, including historical native `.prj` files. Compare ± standard
deviation or scaled scatter, choose normalized/flattened displays or a χ(k)
plot weight, and retain the group's scale and offset. Source data stay
unchanged. See the [saved-spread reference](docs/athena-merge-plot-reference.md)
for executed native plotting rules and original project examples.

**Plot → Diagnostic plots…** shows native Quad, two-group Bi-Quad and k/q
comparisons. Inspect raw/background energy curves, weighted EXAFS and Fourier
components; change the display weight or each panel's range without changing
the saved project. Quad entries in **Plot → Plot shortcuts…** use the same verified
curves. See the [diagnostic plot reference](docs/athena-diagnostic-plot-reference.md)
for original-template comparisons and the corrected Bi-Quad energy-axis rule.

**Plot → Plot shortcuts…** also provides normalized/derivative, detector, marked E₀/I₀/edge-step and k/R three-weight comparisons. Calculations follow the saved group settings in the backend. Curve labels wrap on narrow screens, and SVG downloads include complete legends. See the [shortcut reference](docs/athena-shortcut-plot-reference.md) for detector project-exchange rules and native comparisons.

**Process → Calibrate energy** previews μ(E), normalized μ(E), and raw first
and second derivatives. Pick a reference on the plot or enter it, compare
display smoothing, and find the unsmoothed second-derivative zero crossing.
The preview shows the cumulative shift and affected linked groups before
saving. Undo/Redo and native `.prj` exchange retain the calibration. See the
[calibration reference](docs/athena-calibration-reference.md) for executed
Cu/Fe comparisons, shift rounding and remaining processing boundaries.
Normalization outer limits now stop at the measured endpoints while retaining
the requested values. The parameter panel and calibration preview show the
effective limits; the calibrated normalized curve is refitted with the proposed
E₀ and rounded shift. See the [boundary reference](docs/athena-normalization-limits-reference.md).

**Process → Deglitch data / Truncate data** previews measurements selected for
removal from the current group. Pick points in μ(E) or weighted χ(E), use
pre/post-edge tolerance margins, or trim before/after a cutoff for current or
marked groups. Source detector columns remain aligned, and Undo/Redo restores
the edit. See the [point-edit contract](docs/athena-point-edit-reference.md)
for native boundary rules, measured CLS examples and verification limits.

## XAScraft classic interface (V1)

XAScraft's classic interface is a local browser workbench for one XAS spectrum at a time. It
keeps parsing, processing, revisions, and stored arrays in the FastAPI backend;
the frontend only sends validated choices and renders server-produced traces.

ZIP archives can be opened from Import data, drag and drop, or Open project after
enabling **Zip** in the plugin registry. Select archive members, then review
their normal column, scan or project previews. Original downloads, nested ZIPs
and mixed queues are supported; see the [ZIP reader contract](docs/athena-zip-reference.md).

BL8Ar and SpecFileLongLine are available in File → Plugin registry. BL8Ar can
show the I0 correction fits before import; the live column preview also lets
you compare all detector channels and the uncorrected reference. See the
[reader contract and verification limits](docs/athena-bl8ar-spec-long-reference.md).

BL8, MRCAT MX, X11A EDC and XDAC imports capture acquisition metadata. Review
it beside the live column plot or in **Group → Group information**. **File →
Beamline identification…** controls automatic recognition. The measured legacy
X11A copper foil now imports all 612 observations, including a notice that its
header declares 611. See the [metadata contract](docs/athena-beamline-metadata-reference.md)
for native comparisons. XDI imports also show acquisition fields beside the
live column plot; saved `.prj` files now include native Xray::XDI objects that
retain these fields without the web sidecar. See the
[XDI exchange contract](docs/athena-xdi-reference.md) for measured Cu/Fe examples,
identity precedence, independent native execution and remaining history/export work.

**Group → File metadata…** shows XDI versions, expandable field families and
required/recommended fields. Validate individual fields or all fields with
Larch, and save XDI comments independently of group notes. Comments support
frozen groups, Undo/Redo and native `.prj` exchange. See the
[metadata controls contract](docs/athena-xdi-controls-reference.md) for native
validation behavior and conflict recovery.

Derived groups retain acquisition metadata and saved XDI comments. File metadata
also shows scan times and accumulated processing history, which survives native
`.prj` export/reimport and appears in individual column-file headers. Rebinning
during column import records the operation for both sample and reference.
See the [history contract](docs/athena-xdi-history-reference.md) for exact native
copy, merge and difference rules and the remaining verification limits.

**File → Export column data…** previews and downloads current-group μ(E),
normalization, χ(k), χ(R) and χ(q) files. Combine marked groups in nineteen
data forms, or download separate files in a ZIP. Headers include acquisition
metadata, saved comments and applied processing settings. See the
[column-export contract](docs/athena-data-export-reference.md) for weighting,
grid handling, measured tests and remaining native comparisons.

**Edit → Excel report on all / marked groups…** previews the parameter report
by section and downloads a native `.xls` workbook with all 28 parameter
columns. Group order, frozen groups, numeric precision and background-standard
names are retained. Notes identify unused settings and missing values. See
the [parameter-report contract](docs/athena-parameter-report-reference.md)
for comparisons with the original Athena XLS writer.

**Process → Multi-electron excitation** compares reflection and arctangent
removal on normalized spectra. Adjust shift, amplitude and broadening with
live E/k/R previews, pick the shift from a curve, then save a corrected group.
The original remains available for comparison. See the
[MEE contract](docs/athena-mee-reference.md) for the official LaCoO3 example,
executed native comparisons and remaining verification boundaries.

**Process → Smooth data** compares boxcar, Gaussian, Larch Savitzky–Golay and
repeated three-point filters with the original spectrum. Review live E/k/R
curves and boundary point counts before making a new group. Source metadata,
Undo/Redo and native `.prj` exchange are retained. See the
[smoothing contract](docs/athena-smoothing-reference.md) for executed native
comparisons, parameter behavior and remaining preference/lifecycle work.
SG also has expandable **Session and saved SG preferences** with Apply and
Apply and Save, current/saved/default values, and conflict recovery. Tool
controls persist when closing and reopening the panel. The
[preference reference](docs/athena-smoothing-preferences-reference.md) records
why Athena's effective SG default is order 9 despite its literal default 4.

**Help → Report a bug or feedback…** (also the **Report bug** link in the
status bar) files a bug, feature request or feedback to this server's local bug
library. Each report is one folder under `XRAYLARCH_DATA_ROOT/bug_reports/` in
the same `report.json` layout Dr.XAS uses, with the description, pasted or
chosen screenshots, attached files, browser and build metadata, a summary of the
open project and its recent journal, and, when the checkbox is left on, a copy
of the current project. Nothing leaves the host unless the operator sets the
optional Slack variables described in the deploy manifest. There is no read
endpoint or admin page: reports are reviewed on disk.

### Run locally

The frontend uses Node.js 24 LTS (`frontend/.nvmrc`); Node.js 22 or newer is
required by Plotly 4. Select that runtime before installing dependencies with
`npm ci` inside `frontend/`, and use the same Node major in CI and deployment.

Plots and image exports share the lazy-loaded Plotly 4 bundle through
`frontend/lib/plotly-runtime.ts`. Keep `plotly.js` (the React adapter's peer
dependency) and `plotly.js-dist-min` pinned to the same version. Rendering uses
`react-plotly.js/factory`, so its default, separate Plotly bundle is not loaded.

Create the backend environment from `backend/requirements.txt` before starting
the services. From the repository root, start the backend in one terminal:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --reload-dir backend/xraylarch_web --port 8006
```

`PYTHONPATH=backend` is required for the current source-tree layout because the
web backend package lives beneath `backend/`. Reload watches application code
only, so editing tests does not restart the local service. Start the frontend in a second
terminal:

```bash
cd frontend && npm run dev -- --port 3004
```

Open [http://localhost:3004](http://localhost:3004). The frontend proxies API
requests to `http://127.0.0.1:8006` unless `BACKEND_URL` supplies another local
backend address.

Uploads accept up to 256 scalar source columns by default.
`XRAYLARCH_MAX_COLUMNS` overrides this limit for the backend.
HDF5 detector arrays have a separate 256 MB decoded budget and detector files
allow 2,048 datasets; the 50 MB file upload limit still applies. See
[HDF5 safety limits](docs/beamline-readers.md#hdf5-upload-safety-and-limits).
LabVIEW scans with a numbered column list retain those labels in source order.

### Check before sharing a local build

Run these commands from the repository root. The browser tests start their own
backend on `127.0.0.1:18006`, frontend on `127.0.0.1:13004`, and a fresh
temporary `XRAYLARCH_DATA_ROOT`; they do not use the normal development data
directory. The mounted lifecycle acceptance uses only a committed test-only
signing value and exercises the `/advanced-xas/app` build.

```bash
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests -q
cd frontend
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e -- --config=playwright.ci.config.ts
```

The `Web frontend` workflow uses the Node version in `frontend/.nvmrc` and runs
these checks on pull requests to `master` and pushes to `master`, using the release backend
dependency installer. Its focused browser checks cover:

- The checked-in, measured Cu foil: import, change AUTOBK Rbkg, save `.prj`,
  reopen in a new project, reload, and compare raw and processed arrays plus
  downloaded μ(E) and χ(k) columns. This runs against the production build.
- The measured Cu₂O reference: save a four-path EXAFS model and fit, refresh,
  exchange the project through `.prj`, then change Rbkg and verify that the saved
  fit is labeled outdated. This also checks imported archives and mobile layout.
- The mounted integration lifecycle at `/advanced-xas/app`, using the existing
  mounted development server. It validates this application's handoff flow;
  it does not run the external Dr.XAS consumer.

The full browser suite remains available with `npm run test:e2e`. Local CI-style
checks can use an installed Chrome with `XRAYLARCH_E2E_BROWSER_CHANNEL=chrome`.
To enforce a merge gate, select the `Web frontend / frontend` check in the
repository's branch protection settings.

### Operating boundary and deferred work

V1 is for a trusted network and one user. It has no Dr.XAS authentication, no
user accounts, and no access to Dr.XAS shared data, databases, secrets, or
provider credentials. Do not expose it to the public internet or treat it as a
multi-user service.

XRF and XRD tools, fitting and FEFF work, multi-file alignment or batch flows,
chat, public deployment, authentication, and sharing remain outside V1. The
integrated route is `/advanced-xas/app` behind Dr.XAS ingress; this README does
not imply that it has been deployed.

### Guarded Dr.XAS release package

The checked-in deployment contract is
[`deploy/xraylarch-web.manifest.md`](deploy/xraylarch-web.manifest.md). It
reserves an isolated `/local/apps/xraylarch-web` namespace, immutable
SHA-addressed releases, private mutable data only under
`/local/apps/xraylarch-web/data`, the namespaced frontend/backend screens, and
the planned `3004`/`8006` listeners. The host scripts are
[`scripts/deploy-xraylarch-web.sh`](scripts/deploy-xraylarch-web.sh) and
[`scripts/check-xraylarch-web.sh`](scripts/check-xraylarch-web.sh).

The production frontend and backend listeners are loopback-only at
`127.0.0.1:3004` and `127.0.0.1:8006`; the frontend is built and served beneath
`/advanced-xas/app`. The scripts are a release package, not permission to write
to Dr.XAS. A first
host install, any GitHub push, and every host deployment require an explicit
gate after a fresh host preflight. When that gate exists, the future operator
uses only a full SHA from `master`:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh deploy <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh health <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh rollback <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh recover <full-sha>
/local/apps/xraylarch-web/ops/check-xraylarch-web.sh check <full-sha>
```

When using the prepared alternate host profile on Goldendale, prefix deploy,
health, recover, and checker commands with
`XRAYLARCH_WEB_SIBLING_PROFILE=goldendale`. This keeps XrayLarch on frontend
`3004` and backend `8006` while validating Goldendale's existing Dr.XAS dev
services on `3001` and `8001`; the default `drxas` profile remains unchanged.

`recover <full-sha>` reactivates the existing immutable release when its
processes or screens are gone, without building a release or changing the
canonical SHA. It is safe to call after a reboot; ambiguous screens, listeners,
or process records fail closed. The watcher performs this recovery automatically
after a failed health check.

The reboot/liveness helper is installed as
`/local/apps/xraylarch-web/ops/ensure-watcher.sh`. It starts exactly one
`xraylarch-web-watch` screen, never kills a colliding screen, and can be called
from Goldendale's existing persistence paths:

```cron
@reboot /usr/bin/env PATH="$HOME/miniconda3/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/ensure-watcher.sh >> /tmp/xraylarch-web-watchdog.log 2>&1
```

The existing five-minute watcher-liveness job invokes the same helper so an
unexpected watcher exit is repaired without adding a second periodic cron job.

For an installation created by the pre-record deployer, bootstrap the exact
active process records first; this is an explicit, locked, fail-closed migration
that does not stop processes or change links, state, data, or sibling services:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh migrate <full-sha>
```

Migration discovers and validates both final screens/listeners, writes both
private records atomically, and removes only records created by the attempt if
verification fails. Matching records make the command idempotent. Deploy and
health refuse legacy processes without records; the read-only checker never
performs migration.

The active application remains on `3004`/`8006` while a release candidate is
started in `xraylarch-web-candidate-frontend` and
`xraylarch-web-candidate-backend` on app-private loopback `13004`/`18006`.
The deployer records and validates exact screen and listener PIDs, ancestry,
the observed command line, executable, owners, release marker, working
directory, and candidate health before it begins the brief final-port handoff.
Those private launch records live under `/local/apps/xraylarch-web/state/processes`.
It then waits for the old recorded listeners to release `3004` and `8006`,
starts the target under the final screen names, revalidates its identity, and
atomically activates it. Health checks also require a regular, non-symlink
`state/last-successful` whose SHA and canonical release path match `current`.
This is not zero downtime. A failure stops only recorded target/candidate
processes and restores the prior release's symlink, state, processes, and
health.

## Larch Applications

These applications installed with Larch, in addition to a basic Python
library. Here, GUI = Graphical User Interface, CLI = Command Line
Interface, and `beta` indicates a work in progress.


| Application Name  | GUI/CLI    | Description                                            |
| ----------------- |----------- | ------------------------------------------------------ |
| larch             | CLI        | simple shell command-line interface                    |
| Larch GUI         | GUI        | enhanced command-line interface with data browser      |
| Larix             | GUI        | XAFS Processing and Analysis: XANES pre-edge peak      |
|                   |            | fitting, linear analysis, PCA/LASSO, EXAFS processing  |
|                   |            | Running Feff, fitting EXAFS data to Feff paths.        |
| GSE Map Viewer    | GUI        | XRF Map Viewer for GSECARS X-ray microprobe data.      |
| larch_xrf         | GUI        | Display and analyze XRF Spectra.                       |
| larch_xrd1d       | GUI        | Display and work with 1-D XRD patterns, integrate XRD  |
|                   |            | images, search for XRD patterns of known structures    |
| feff6l            | CLI        | Feff 6 EXAFS calculations                              |
| feff8l            | CLI        | Feff 8 EXAFS calculations (no XANES)                   |
| qtrixs            | GUI `beta` | Display RIXS planes, take profiles                     |



In addition, the applications built with it also use a built-in
Python-like macro language for interactive and batch processing.  This
embedded "miniPython" language is intended to be very easy to use for
novices while also being complete enough to automate data processing
and analysis and to encourage and facilitate a gentle transition to
transition from GUI-only analyses to scripted and programmatic
analysis of larger data sets, and allows Larch to be run as a service,
interacting with other processes or languages via XML-RPC.
# Optional Dr.XAS integration configuration

The host deployer reads `/local/apps/xraylarch-web/config/integration.json` only
in the backend child. Create the parent directory privately and make the JSON
file owner-only (mode `0600`, owned by the service user); symlinks are refused.
The accepted fields are `integration_api_enabled`, `browser_consume_enabled`,
`import_enabled` (JSON booleans), `integration_issuer`, `integration_audience`,
`integration_hmac_secret` (strings), and optional `draft_ttl_seconds` (positive
integer, at most 604800). All three gates must be true for editor import. The
issuer, audience and host-generated secret must match Dr.XAS's private backend
configuration; the secret must contain at least 32 characters. Never commit or
print this file. Missing configuration keeps integration off; invalid settings
block startup. The API remains on `127.0.0.1:8006`. Frontend/build processes do
not receive the integration secret, and legacy rollback releases start with
integration off.
