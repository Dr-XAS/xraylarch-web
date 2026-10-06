# Artemis beamline QA checkpoint

Target: `http://drxas.xray.aps.anl.gov:3004`, deployed revision `881d526f62d72f05f6fdaa8bfb879baee89acd55`. API calls went through the frontend proxy at `/api/backend/api`. The audit used three dedicated QA projects and did not modify existing user projects or shared preferences. Application source was not changed.

Two confirmed defects have individual reports ready for project-memory filing:

- `bug-artemis-decimal-minimum-ranges.md`: valid decimal endpoints at the documented minimum k/R width return HTTP 422. Reproduced with three intervals and successful comparison requests. Low severity.
- `bug-artemis-unmatched-path-label.md`: the visible exclusion button reads `Exclude unmatched paths paths`. Screenshot confirms it. Cosmetic.

`requests.jsonl` records 113 API requests. Status counts are 74 HTTP 200, three HTTP 202, 21 HTTP 400, 12 HTTP 422, two HTTP 409, and one HTTP 503. These totals include deliberate invalid-input tests; they are not failure counts. Browser traffic is additional and is captured in `ui-artemis-trace.zip` for the final fit/display sequence.

| Workflow | Result and evidence |
| --- | --- |
| Measured Cu 10 K, 50 K, 300 K first-shell fits | All converge. R-factors 0.00225509, 0.00224473, 0.00260462. Fitted sigma² rises from 0.00382881 Å² at 10 K to 0.00878363 Å² at 300 K. Strong amplitude/disorder and E0/distance correlations are reported. |
| Cu₂O bundled four-path fit | Executes with R-factor 0.138968 and an explicit poor-fit concern. This is inadequate model agreement, not a demonstrated software defect. Shared sigma² and ΔR across distinct paths need scientific review. |
| Transform choices | k and R spaces, kmax 12/16, single/multiple k weights, Hanning/Kaiser/Parzen/Welch all execute. The k-space first-shell model correctly fits poorly because it omits higher-shell contributions. |
| Scientific/parameter guards | Rejects k ranges outside measured data or FEFF support, too few independent points, stale versions, duplicate names/IDs, missing job paths, disabled entire models, invalid weights/ranges/expressions, and global Def expressions using path-dependent functions. Some physical-invalidity cases first hit the expected unused-Guess guard, so they do not independently prove the later physical guard. |
| Thermal disorder | Einstein and correlated Debye sigma² fits succeed and match the constant-sigma² optimum at fixed T=10 K. Single-temperature identifiability warning appears. Both saved model variants and their native exports succeed. |
| AMCSD structures | Copper and compact CuO searches work. Copper, Cuprite, and nonorthogonal Tenorite detail records load. Mixed-occupancy Rutile explicitly reports unsupported structure. |
| FEFF | Generates Copper first shell and three-path Copper sets. Job polling and reuse work. Correct degeneracies and distances agree with structural shell analysis. Attachment-backed jobs succeed; stale attachment versions fail. Invalid site and radius combinations have structured errors. Oxygen L3 job completes, so the exploratory name `feff_invalid_edge_for_element` is not classified as a failed validation case. |
| CrystalNN and radial shells | Copper CN 12, Cuprite Cu CN 2, Cuprite O CN 4, Tenorite Cu CN 4. Radial-shell distances/counts agree with the corresponding FEFF geometry. Small-radius empty results, boundary warning, coarse width, wrong sites, partial occupancy, and invalid CIF/radius are handled explicitly. |
| Path inspection | Valid FEFF file succeeds. Empty, truncated, non-FEFF, and unsafe-filename inputs return structured errors. |
| Model/history persistence | Save, identical-save no-op, saved fits, removal/undo, and input-change fingerprints behave correctly. |
| JSON and Athena PRJ round trips | Models, FEFF files, both attached CIFs, and fit history survive. Imported records are labeled imported. Refit R-factor is identical to the original, 0.002255093455076989. |
| Native Larix | All three export downloads succeed. Local reload/evaluation of the standard and Einstein exports works, preserves processed chi(k), and includes the original degeneracy in native amplitude correctly. Debye local evaluation is blocked by a pre-existing architecture mismatch described below. |
| Fit display transforms | Weights 0–4 work, and 5 is rejected. Model/path curves agree exactly for the one-path model; residual arithmetic is exact. Returning to weight 2 reproduces the original R transform exactly. |

Browser checks used Playwright Chromium against the real deployment, with a fresh browser context targeting the QA project. Desktop viewport was 1600×1100 and mobile viewport was 390×844. Ten screenshots are saved. Final screenshots were opened and visually inspected.

The browser workflow opened the saved Copper CIF, selected the explicit Cu absorber site, generated three FEFF paths, reviewed first-shell/second-shell/multiple-scattering classifications, selected first-shell paths, and added one to the Cu 50 K model. Running the fit through the UI saved its history and returned R-factor 0.0063422 using the UI's default multiple weights. The API and UI model settings differ, which explains the different R-factor.

CIF 3D rendering, radial-shell coloring, Escape focus restoration to the launch button, fitting/report display, k/R/real toggles, k-weight 3, per-path plot overlays, and fit-plus-model JSON download worked. The mobile document and CIF dialog have no horizontal overflow. `ui-50k-mobile-k3-final.png` contains the completed graph; `ui-50k-mobile-k3-paths.png` caught its temporary loading state and is not a bug. No page or console errors occurred in the final SwiftShader browser session, as recorded in `ui-browser-events.json`.

Known environment and coverage limits:

- Materials Project returns HTTP 503 with `materials_project_not_configured` because the deployed backend lacks MP_API_KEY. This is an explicit deployment limitation, not a code bug. No credentials were changed.
- Plain headless Chromium initially lacked WebGL. Relaunching with `--enable-webgl --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` fixed the test environment. Initial 3D errors are retained separately in `ui-first-session-events.json`; they should not be filed as deployment failures.
- The local arm64 installation cannot evaluate native Debye exports because its bundled `libfeff6.dylib` is x86_64. Server-side Debye fitting and export succeed. The local native evaluation limitation is recorded in `native_export_validation.json`, not classified as a deployed app defect.
- The final attempt to select radial-shell mode initially used an incorrect Playwright option value `shells`, timed out, and then succeeded using the visible label `Radial shells`. This was a test selector error.
- No simultaneous multi-dataset fits, arbitrary external CIF import, long-duration job expiry, maximum-size projects, every elemental/edge combination, or desktop Larix GUI round trip were exercised. This audit does not establish universal scientific correctness or every possible UI interaction.

Dedicated project IDs: `2ft4lY2wBWhn0dhEYWCnbta2`, `IiAjg7BxQz199ltylF-aO0Cg`, and `h_3SDPMq31X0_ouysf6lrZd-`. Requests, bodies, full numerical responses, exports, screenshots, browser trace, and scripts remain under `/tmp/xas-qa-20261001/artemis/`. Parent agent is responsible for canonical project-memory transactions and final bug filing.
