# Athena analysis and plotting QA

The live deployment passed the tested scientific calculations. One API option-validation defect is confirmed and has a separate report in `bugs/analysis-001-unvalidated-lcf-options.md`.

Target was `http://drxas.xray.aps.anl.gov:3004`, deployed revision `881d526f62d72f05f6fdaa8bfb879baee89acd55`. Testing used HTTP API calls only. No browser rendering or interaction claims are made. Only two newly created QA projects were changed, and no application source or shared preferences were edited.

- Controlled inputs project: `1b6vtAzlPvUJK02WCxzoBmpI`, `QA 2026-10-01 Analyses controlled mixtures`.
- Measured copper project: `xXNlXmwP9Q95K3rex90IiH3X`, `QA 2026-10-01 Analyses measured copper`.

`coverage.json` records 98 HTTP requests and 40 assertions. It has 137 passing checks and one confirmed defect. Five initial expectation/setup mismatches are explicitly annotated. The bundled 10 K and 50 K spectra already had matching windows, so accepting their log ratio was correct. Marked-group plot endpoints also correctly rejected a requested group set that did not match the marks. Repeating with the required marks passed.

## Scientific results

Linear combination fits recovered the exact 30/70 mixture. Nonnegative least squares recovered 0.6/1.4 when the sum constraint was disabled; signed fitting recovered 1.2/-0.2. All four supported boolean constraint combinations passed. Duplicate standards, too few standards and out-of-range fits were rejected.

PCA reconstructed the controlled spectra to a maximum error of 3.11e-15. The controlled linear mixture had one nonzero component, and identical spectra had zero variance. Single-spectrum and reversed-range requests were rejected.

Gaussian, Lorentzian and independently varying Voigt fits recovered known peak shapes and their linear backgrounds. Maximum point residuals were 1.49e-14, 7.04e-14 and 5.14e-14, respectively. A two-peak fit to the synthetic mixture's derivative also returned finite results. These checks validate shape and integrated-area conventions; successful convergence on arbitrary measured data does not establish a unique physical model.

Measured copper log-ratio analyses passed with a shared E0 and explicit FT/shell windows. Self-comparison returned zero log amplitude and phase. Swapping target/reference reversed both curves and every fitted cumulant. Orders 2, 3 and 4 returned finite parameters. The higher-temperature foil's positive effective second-cumulant change had the expected amplitude damping sign. A deliberately mismatched E0 was rejected. These are shell-filter consistency tests, not an independent structural calibration or absolute distance measurement.

Wavelet maps at weights 0, 2, 3 and 4 were finite and had matching axis/matrix dimensions. Cropping R at 3 angstrom preserved the corresponding rows of the 6 angstrom map. Viewer transforms applied the requested powers of k. A transform using the saved parameters reproduced all saved transform arrays within 1e-12. The wavelet, plot transform and read-only reports did not advance the scientific project version.

Quad, Bi-Quad, all three k/q components and all seven shortcut kinds completed after the required marks were set. k/q real, imaginary and magnitude curves matched the saved q arrays. Measurement uncertainty and seeded edge-step uncertainty reports completed; repeating the latter with the same seed returned the same result. Stale versions, reversed viewer ranges and an out-of-range wavelet weight were rejected.

## Reproduction files

`run_analyses.py` creates new projects and runs the main matrix. `extend_analyses.py` uses the resulting project IDs to validate mark-dependent plots, compare arrays, check reciprocal log ratios and demonstrate the malformed-constraint issue. Request/response JSON files preserve exact inputs and numerical output; large arrays stay in those files. `run.log` and `extend.log` contain compact execution records.

The report is limited to the tested bounded examples. UI rendering, every beamline plugin, all chemical edges and every possible scientific parameter combination are outside this analysis subtask.

## Authorized browser follow-up

The user subsequently authorized visual/browser testing. `browser/REPORT.md` records completed Chromium checks for the four analysis workflows and mobile dialogs. That follow-up confirmed two additional UI issues, saved as `bugs/analysis-002-chi-range-energy-units.md` and `bugs/analysis-003-dialog-help-blocks-reference.md`. Together with the API validation defect, this analysis subtask has three confirmed reports.
