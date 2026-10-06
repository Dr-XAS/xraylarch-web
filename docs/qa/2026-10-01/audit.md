# Deployed Larch-Web beamline QA, October 1, 2026

Six confirmed issues were found during a broad scientific and browser audit of http://drxas.xray.aps.anl.gov:3004, completed October 2 after starting October 1. All 36 advertised Athena commands completed successfully in at least one valid scenario. Main test scripts recorded 724 direct HTTP requests, plus capability discovery and browser-generated traffic. Desktop and mobile Chromium checks covered forms, plots, downloads and project reopening.

The tested scientific workflows preserved observations, recovered known synthetic results and produced plausible measured-spectrum fits. No data loss or incorrect numerical result from valid inputs was found in these tests. This does not establish correctness for every input or browser.

Tested deployment: `881d526f62d72f05f6fdaa8bfb879baee89acd55`. This is the standalone public deployment with backend port 8007, separate from the mounted application on ports 3006/8006. The local checkout initially had revision `6b91bd92778c37a135297d8f7276a4ec1341830f`; source from the actual release was copied read-only for schema and cause checks.

## Confirmed reports

| ID | Priority | Finding | Report | Status |
|---|---|---|---|---|
| XAS-QA-001 | P2 | Mobile combined import hides the fluorescence multiplier in an 18 px input; 360 px layout overflows. | [Reproduction](bugs/import-mobile-fluorescence-scale.md) · [Screenshot](screenshots/fluorescence-control-390.png) | Fixed, PR #10 |
| XAS-QA-002 | P3 | Switching analysis to chi(k) retains eV labels and energy-scale limits, causing a range error. | [Reproduction](bugs/analysis-002-chi-range-energy-units.md) · [Screenshot](screenshots/chi-range-wrong-units.png) | Fixed, PR #12 |
| XAS-QA-003 | P3 | Mobile Log-ratio dialog opens help over the reference selector and intercepts taps. | [Reproduction](bugs/analysis-003-dialog-help-blocks-reference.md) · [Screenshot](screenshots/mobile-log-ratio-full-page.png) | Fixed, PR #12 |
| XAS-QA-004 | P3 | LCF accepts malformed string boolean constraints and silently applies a different model; unknown option names are ignored. | [Reproduction](bugs/analysis-001-unvalidated-lcf-options.md) | Fixed, PR #12 |
| XAS-QA-005 | P3 | Artemis rejects valid decimal minimum-width k/R windows because of floating-point rounding. | [Reproduction](bugs/bug-artemis-decimal-minimum-ranges.md) | Fixed, PR #11 |
| XAS-QA-006 | P4 | FEFF control reads "Exclude unmatched paths paths". | [Reproduction](bugs/bug-artemis-unmatched-path-label.md) · [Screenshot](screenshots/ui-artemis-loaded.png) | Fixed, PR #12 |

P2 indicates a normal workflow impediment affecting a scientific input; P3 indicates a narrower correctness/usability defect; P4 is cosmetic. All six were fixed in PRs #10–#12, merged October 5, 2026, and live on port 3004 in release `dd47cdfd` (October 6). Reports include expected and observed behavior, reproduction steps and evidence. The user requested project-memory storage instead of external issue submissions. GitHub Issues is disabled.

Shared memory is installed and verified for this repository. All six reports are in its canonical `beamline-qa-2026-10-01` topic. Final checks confirmed that EXAFS display-weight changes preserve the saved fit and that 3D wavelet camera/resize controls work with WebGL enabled.

## Scientific and workflow coverage

| Area | Exercised behavior and observed results |
|---|---|
| Athena processing | All 36 commands; normalization/background parameters, E0 methods, calibration, linked references, alignment, weighted merging, sum/difference, four smoothing algorithms, convolution/noise, bounded deconvolution, rebinning, deglitching, truncation, self-absorption, multi-electron correction, dispersive mapping, metadata, copies, marks, freeze, delete/reorder and undo/redo. Numerical checks verify energy translation, exact duplicate arithmetic, zero merge scatter, exact point removal, preview/application equality and k-weight multiplication. |
| Import/export and classic | 186 requests and 150 passing assertions. Direct mu, transmission, fluorescence, combined modes, separate/reference channels, eV/keV, CSV/TSV/BOM, measured Cu/Fe XDI, X11A and Cu/NiO FEFF inputs. Raw numeric differences are at floating-point precision. JSON/PRJ round trips preserve 14 groups, arrays, recipes and reference links. All 34 tested data-export variants pass. Native archives, XLS reports, Cu/Pd dispersive calibration, classic preview/apply/conflict/restore/download and eight browser workflows pass. |
| Analyses and plots | 98 requests plus 40 assertions. Known 30/70 mixtures, signed/unconstrained LCF, rank-one/identical-spectrum PCA, Gaussian/Lorentzian/Voigt peaks, log-ratio identity and temperature damping, diagnostic/shortcut plots, wavelets, transform weights and uncertainty reports. Valid boolean constraints recover expected weights. Browser LCF/PCA/peak/log-ratio runs and report downloads pass, subject to the UI defects above. |
| Artemis | 113 requests plus browser work. AMCSD search/details, CIF attachments/sites/shells, FEFF jobs/cache reuse, file/job path inputs, k/R fits, multiple weights/windows, temperature models, invalid-input rejection, saved-model/fit history, stale input detection, removal/undo and JSON/PRJ/Larix exports. Cu 10 K nearest-neighbor fit gives 2.5484 A with R-factor 0.002255; sigma2 rises from 0.003829 to 0.008784 A² at 300 K. Browser structure-to-FEFF-to-saved-fit workflow succeeds. |
| Browser interaction | Chromium desktop and 360/390/768/1024 px views; light/dark plots, E/k/R/q switching, independent viewer weights, reference assignment and undo/redo, save filename/cancel, import/archive reopen, modal/touch/keyboard use, CIF rendering and FEFF controls. Workspace mouse/keyboard resizing and the empty FEFF viewer's fitting-tab shortcut work after initialization. |

The bundled Cu2O starter fit has R-factor about 0.139 and correctly warns about its poor fit. That is a model limitation, not a software failure. Scientific interpretation used the primary [Larch FEFF fitting documentation](https://xraypy.github.io/xraylarch/xafs_feffit.html) and [FEFF path documentation](https://xraypy.github.io/xraylarch/xafs_feffpaths.html). Fit convergence alone was not treated as scientific validation.

## Exploratory failures and limits

Initial scripts included incorrect assumptions about validation status codes, difference option names, deconvolution work limits and zero smoothing repetitions. Correct requests or explicit warnings explain those results. Several repository browser tests also assume older labels, demo-loader behavior or one statistics block. Temporary copies adapted those assumptions. Their raw failed-check counts must not be presented as confirmed app defects.

Materials Project is unavailable because this deployment has no API key. Plain headless Chromium initially lacked WebGL; SwiftShader allowed CIF/3D tests. Local arm64 execution of a native Debye export is blocked by the bundled x86_64 library, although live Linux fitting works.

Testing used isolated QA projects and browser contexts. Existing analysis projects were not edited. Optional file plugins were not globally enabled, shared preference endpoints were not changed, and no application code was changed or deployed. Normal imports can update remembered column mappings. QA projects remain available for reproductions.

This was not a load, security, cross-browser or exhaustive file-plugin audit. Measured reference spectra and controlled synthetic inputs do not establish validity for every sample chemistry, detection geometry or model.

Full requests/responses, scripts, downloaded data, screenshots and browser traces are preserved in `/Users/huang.jeffrey/.local/share/xraylarch-web-qa/2026-10-01/evidence.tar.gz`. Working files remain in `/tmp/xas-qa-20261001/`. Smaller scope reports are alongside this file. Audit reports are uncommitted; the pre-existing deployment-manifest edit was preserved.
