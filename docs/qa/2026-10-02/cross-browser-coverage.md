# Cross-browser coverage, October 2, 2026

44 workflow checks passed across Firefox desktop, WebKit desktop, and WebKit mobile emulation. Three additional 3D wavelet inspections passed. No new distinct bug was confirmed; two existing mobile defects also reproduce in WebKit.

Target: `http://drxas.xray.aps.anl.gov:3004`. Tested release: `18c6a8dd03502e15c0bba88490c88f966ad70ffe`, displayed as `v0.2026.10.02.12517.18c6a`. This is newer than the October 1 audit release.

| Configuration | Workflow checks | Additional visual check |
| --- | ---: | --- |
| Playwright Firefox 146.0.1, 1600×1100 | 15 passed | 3D wavelet passed |
| Playwright WebKit 26.0, 1600×1100 | 14 passed | 3D wavelet passed |
| Playwright WebKit 26.0, iPhone 13 touch profile, 390 CSS px | 15 passed | 3D wavelet passed |

Each configuration imported a measured 612-point Cu file, switched E/k/R/q plots, opened and closed dialogs, rendered the Cuprite CIF and radial shells, ran and saved a four-path Cu2O EXAFS fit, changed display weight and path overlays, downloaded fit JSON and an Athena PRJ, reloaded the workspace, and reopened the downloaded archive in a new QA project. Firefox and mobile WebKit also edited Rbkg through the form and verified automatic processing, undo, and redo.

Imported energy and mu values matched the input file exactly in all three configurations. The browsers submitted equivalent fit settings and returned identical parameters and R-factor, `0.13896786874821015`. The bundled starter model fits poorly; its displayed scientific warning is correct. Reopened archives retained all five groups and the saved fit, which acquired the correct imported-archive label. The tested desktop and mobile documents had no horizontal overflow.

The two additional regression probes reproduced existing reports:

- [XAS-QA-001](../2026-10-01/bugs/import-mobile-fluorescence-scale.md): the combined-import fluorescence multiplier remains only 18 px wide at 390 px. The value is editable but unreadable.
- [XAS-QA-003](../2026-10-01/bugs/analysis-003-dialog-help-blocks-reference.md): the log-ratio title tooltip intercepts a touch tap on Reference spectrum. Tab dismisses it and restores access.

These are confirmations, not duplicate reports. The other four earlier issues were not rechecked here.

Final runs had no uncaught page errors. Firefox emitted WebGL warnings; WebKit emitted zero-size framebuffer errors during initial or hidden rendering. Separate screenshots verified complete CIF and 3D wavelet renders with nonzero canvas dimensions. Four stale plot/wavelet HTTP 409 responses occurred during saving or rapid undo/redo; current-version requests subsequently succeeded. No lasting user-visible failure was reproduced from those messages.

Main and follow-up logs recorded 158 browser-generated API responses, excluding setup requests and the final wavelet inspections. Early script failures came from an incorrect Save button label and desktop tab names used on mobile. Correct selectors passed; discovery-run failures are not app defects.

Evidence is under `/tmp/xas-qa-20261002/cross-browser/`: `summary.json`, `numerical-browser-parity.json`, replay scripts, per-browser results, response bodies, exports, traces, and 56 screenshots including exploratory runs. The two known-issue screenshots and tap/geometry measurements are in `webkit-mobile/`. Six final-run projects and three exploratory projects were isolated QA projects. No app code, shared preference save endpoint, deployment, commit, or push changed.

Playwright WebKit on macOS is not the actual Safari application. Its iPhone profile emulates viewport, touch, pixel ratio, and user agent; it does not test a physical iPhone, iOS software keyboard, device GPU, or operating-system file picker. Firefox was the Playwright build. These checks do not establish support for every browser version or file format.
