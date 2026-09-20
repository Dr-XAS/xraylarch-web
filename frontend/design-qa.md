# Design QA: Current-spectrum defaults and identity

## Visual truth and capture conditions

- Primary source visual: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-4eb9029c-bec9-4c90-8fed-dd2db19aa0c8.png` (812 x 1280 px, 144 dpi; normalized to 406 x 640 CSS px).
- Supporting identity-row references: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-280aea39-ecc6-4e26-ada0-32610dc1031a.png` and `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-a58fe4d1-eb91-4748-9e68-51539e649e84.png`.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser.
- Browser-rendered implementation screenshot path: inline Codex in-app Browser capture; the browser integration did not expose a filesystem path.
- Normalized combined comparison: `/private/tmp/athena-current-default-qa/index.html`, rendered at `http://127.0.0.1:4180/`. It places the 406 x 640 normalized source beside a live 406 x 640 crop of the implementation in one browser capture.
- Desktop comparison viewport: the live implementation iframe is 1020 x 1280 CSS px at device scale 1, cropped and scaled to the source region.
- Responsive viewport: 390 x 844 CSS px at device scale 1; the temporary override was reset after verification.
- Matched state: light theme, saved `Copper foil · temperature series` project, `Current spectrum`, raw `μ(E)`, Background / Pre-edge line / Post-edge line checked, `Show legend` unchecked, and a visible current-spectrum identity row.

## Findings

- No remaining P0, P1, or P2 findings.
- Entering `Current spectrum` now reproduces the requested state: raw μ(E), all three fitted-line controls on, and the legend off.
- The plot shows the raw spectrum, fitted background, pre-edge and post-edge lines, and their available boundary markers.
- The in-card `Current spectrum` identity row remains directly above the plot and follows the highlighted group.
- Energy-mode controls remain above the identity row in the current product. The source crop shows them below the plot, but this pre-existing placement is outside the requested default-state change and remains internally consistent.

## Required fidelity surfaces

- Fonts and typography: existing Athena label, body, radio, and checkbox typography is retained. The identity label uses the muted label token and the spectrum name uses the established 500 weight and single-line treatment.
- Spacing and layout rhythm: control grouping, divider rhythm, checkbox spacing, color-legend row, identity row, and plot padding remain aligned with the current Athena card. The three processing-line choices wrap without overlap at narrow widths.
- Colors and visual tokens: selected radios and checkboxes use the existing violet accent; surfaces, borders, muted text, Plotly line colors, and boundary markers use existing tokens and plot styling.
- Image quality and asset fidelity: no image or icon asset was added or replaced. The implementation uses the real Plotly spectrum and fitted arrays rather than a recreated static image.
- Copy and content: `Current spectrum`, `μ(E) · raw`, `Background`, `Pre-edge line`, `Post-edge line`, and `Show legend` match the requested controls. Live sample names intentionally differ from the reference data.

## Interaction and responsive evidence

- A project with zero or one imported spectrum defaults to `Current spectrum`, raw μ(E), legend off, and eligible processing lines on.
- A project with multiple spectra defaults to `All selected`, normalized μ(E), legend on, and processing lines off.
- Switching from `All selected` to `Current spectrum` applies the single-spectrum defaults together.
- Manually unchecking Pre-edge line works and remains a user choice while staying in the same scope.
- Switching to `All selected` and back resets the scope-specific defaults, including restoring all three single-spectrum lines.
- Selecting `Cu foil · 50 K` updates the workspace heading and identity row while retaining raw μ(E) and all three checks.
- Detector, χ(k), difference, missing-result, and mismatched-array cases remain disabled and unchecked because the fitted arrays are unavailable, even though the current-scope preferences are stored as on.
- At 390 x 844, `documentScrollWidth`, `bodyScrollWidth`, and `innerWidth` were all 390 px. The controls wrapped cleanly with no horizontal overflow.
- Browser console warnings/errors during the verified interactions: none.

## Full-view and focused comparison evidence

- Full-view evidence: the 1020 x 1280 live browser capture shows the requested defaults in the surrounding Larch-Web workspace with the real copper data and plot.
- Focused evidence: the combined comparison board puts the normalized source and live implementation together in one capture. The selected scope, checked fitted-line controls, raw μ(E) radio, unchecked legend, fit traces, and plot markers all agree.
- A focused comparison was required because the source is a narrow viewer-card crop rather than a full application screen.

## Comparison history

- State-alignment pass: the first live iframe opened without project data because third-party iframe storage is isolated, so its processing-line controls were unavailable. This was a capture-state mismatch, not a product finding.
- Final pass: loaded the same copper example inside the comparison iframe, selected `Current spectrum`, and repeated the combined capture. No actionable P0, P1, or P2 difference remained for the requested behavior.

## Regression checks

- Focused plot-scope / energy-view tests: 18 passed, 250 skipped.
- Full AthenaWorkbench component suite: 268 passed.
- Next route generation and TypeScript: passed.
- Next.js production build: passed.
- `git diff --check`: passed before final report generation and was rerun after the report update.

final result: passed
