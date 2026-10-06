# Extended beamline audit, October 2, 2026

The follow-up found two new confirmed bugs. Both were saved to shared project memory as soon as confirmed. Together with the six reports from the first audit, eight distinct issues are recorded; this pass did not retest all six earlier issues.

| Report | Priority | User-visible failure | Status |
| --- | --- | --- | --- |
| [XAS-QA-007](bugs/import-lost-response-duplicate.md) | P2 | After an import commits but its browser response is lost, following the app's retry instructions imports the same scan again. | Fixed, PR #10 |
| [XAS-QA-008](bugs/short-data-kmax-suggestion.md) | P3 | “Set kmax to Larch’s suggestion” submits an invalid range for a short processed spectrum and fails. | Fixed, PR #11 |

The deployed app changed from `881d526f62d72f05f6fdaa8bfb879baee89acd55` to `18c6a8dd03502e15c0bba88490c88f966ad70ffe` during testing. Both new defects reproduce on the latter release. The audit did not deploy that change. Principal scientific checks were repeated after the change, and final health and release checks passed.

## Coverage and results

- [Browser compatibility](cross-browser-coverage.md): 44 workflow checks plus three 3D visual checks passed across desktop Firefox, desktop WebKit and mobile WebKit emulation. Imports and fit values matched across engines; project archives reopened with fit history intact. Existing mobile issues XAS-QA-001 and XAS-QA-003 also reproduce in WebKit.
- [Scale and preferences](scale-and-preferences.md): 13 API and seven browser checks passed at up to 100 groups. Seventy preference lifecycle checks and 19 detector-ratio/recovery checks passed on the isolated backend. Sixteen measured file fixtures were inspected; 15 single-table fixtures were imported with appropriate measurement settings.
- [Difficult spectra and models](scientific-coverage.md): 98 HTTP requests and 38 numerical or behavioral assertions gave 135 passing checks and the kmax defect. Coverage includes Pt/Sn L edges, fluorescence, weak edge steps, synthetic count noise, short ranges, unequal grids, contaminated references, incomplete standards and inappropriate Artemis models. Poor models produced concerns or validation failures. Pt fit distance varied by 0.0056 Å across kmax 8–16.
- [Interruption recovery](recovery-coverage.md): browser-local network failures, lost responses, repeated clicks, refreshes and competing tabs were tested. Completed fits survive a lost response and reload; FEFF reconnects after a polling failure and reuses its completed job after refresh. Batch import resumes after a pre-request failure. The accepted-import/lost-response case exposes XAS-QA-007.

A successful HTTP response was checked against returned state, numeric arrays, saved history, diagnostics or rendered output as appropriate. Expected scientific refusals, test-driver mistakes, transient rendering warnings with successful final output, and repeated observations of known bugs were not filed as new issues.

## Scope and evidence

Live tests used new QA projects on `http://drxas.xray.aps.anl.gov:3004`. Preference and reader configuration writes used an isolated copy of the deployed backend at local port 18017, now stopped. No explicit public preference save, existing user-project change, source fix, commit, push or deployment was performed. Normal imports can update remembered column mappings.

Replay scripts, requests, responses, numerical results, browser traces and screenshots are retained under `/tmp/xas-qa-20261002` and in the durable evidence archive recorded below. Small reports and the two new bug screenshots also live in this directory. Shared-memory topic: `beamline-qa-extended-2026-10-02`.

Limits: Playwright WebKit is not the actual Safari application or a physical iPhone. Device keyboards, native file pickers and device GPUs remain untested. Materials Project requires the unavailable API key. This standalone-app campaign does not validate embedded Dr.XAS integration or every possible reader/file variant. Network failures were injected in the audit browser; the public server was not restarted or deliberately taken offline.
