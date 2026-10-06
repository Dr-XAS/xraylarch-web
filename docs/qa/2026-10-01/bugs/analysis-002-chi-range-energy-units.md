# Analysis dialogs retain energy ranges and eV labels after selecting chi(k)

Severity: P3, scientific UI correctness. Confirmed through the deployed browser interface.

Status: fixed by PR #12 (`e4b25efc6`), merged October 5, 2026; not yet deployed. Range labels and default limits now follow the chosen fit signal.

Target: http://drxas.xray.aps.anl.gov:3004
Deployed revision: 881d526f62d72f05f6fdaa8bfb879baee89acd55
Test date: 2026-10-01
Project: `1b6vtAzlPvUJK02WCxzoBmpI`, `QA 2026-10-01 Analyses controlled mixtures`.

## Reproduction

1. Highlight `mixture-30-70.dat` and open Analysis > Linear combination fitting.
2. Select `standard-A.dat` and `standard-B.dat` as the two standards.
3. Change Fit signal from Normalized mu(E) to `chi(k) - range in inverse angstrom`.
4. Inspect the range controls and click Run analysis.

Expected: the minimum and maximum labels use inverse angstrom for chi(k), with a valid k range supplied or an explicit prompt to replace the incompatible energy range. Labels should change back for energy-space signals.

Observed: both visual unit labels and accessible names remain `eV`. The old values, 8969.5 and 9069.5, stay in place. Run analysis submits these numbers as k limits and returns HTTP 400: `The fit range must lie inside every spectrum's measured overlap; reduce xmin/xmax.` The signal selector itself correctly says inverse angstrom, so the dialog presents contradictory units.

This is a frontend coordinate/unit handling defect. The backend correctly refuses the out-of-range request. The shared range controls also serve PCA and peak fitting, which should be checked when fixing it.

## Evidence

- `browser/chi-range-wrong-units.png`, visually inspected. The selected chi(k) signal appears directly below range fields labeled eV.
- `browser/chi-range-default-error.png`, visually inspected. It shows the unchanged energy limits and the resulting error.
- `browser/analysis-2.request.json` and `.response.json` contain the exact failed browser request.
- Browser replay script: `browser/run.mjs`.

Source clue: `frontend/components/athena-workbench.tsx` renders the shared range controls with a literal `"eV"` unit and the Fit signal change handler only changes `options.array`.
