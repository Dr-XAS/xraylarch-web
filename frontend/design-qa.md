# Design QA: numeric plot range defaults

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-b542b139-bf35-48c9-9d24-6f7083552fbe.png` (484 x 89 px at 2x density).
- Normalized source size: 242 x 44.5 CSS px.
- Implementation route: `http://127.0.0.1:3004/`.
- Implementation screenshot: inline Codex in-app Browser capture; the browser integration did not expose a filesystem path.
- Desktop viewport: 1280 x 720 CSS px at device scale 1.
- Responsive viewport: 390 x 844 CSS px at device scale 1.
- Focused comparison: inline 700 x 360 capture containing the normalized source and a live 1x implementation crop. The temporary comparison route was removed after capture.
- State: saved `Copper foil · temperature series` project, three marked groups, normalized E-space plot.
- Intended difference: replace both `Auto` placeholders with the current finite plotted x-domain values while preserving the existing control styling and automatic range behavior.

## Findings

- No remaining P0, P1, or P2 findings.
- The minimum and maximum controls expose `8779` and `11362.54` in the verified project state; neither control retains an `Auto` placeholder.
- Both values remain fully visible at desktop and mobile widths, and the document has zero horizontal overflow.

## Required fidelity surfaces

- Fonts and typography: existing Athena footer font, size, weight, and numeric-input typography are unchanged.
- Spacing and layout rhythm: the Range label, `to` separator, CSV action, border, and footer alignment remain intact. Inputs widened from 59 px to 76 px only to prevent long scientific coordinates from clipping.
- Colors and visual tokens: existing background, border, text, focus, and disabled tokens are unchanged.
- Image quality and assets: the target contains no image asset; the existing CSV icon remains unchanged.
- Copy and content: only the requested `Auto` content changed, to live numeric defaults derived from the plotted traces.

## Interaction and responsive evidence

- Automatic values are derived from the union of finite x-values for the visible traces, including the Plot marked selection and the active plot space.
- Typing `8800` into only the minimum control produced a valid one-sided override while the maximum remained automatic.
- Clearing the minimum kept it blank during editing and restored the numeric automatic value `8779` on blur.
- Fractional values are supported with `step="any"`.
- At 390 x 844, the controls show `8779` and `11362.54` in one row with 76 px input widths and zero horizontal overflow.
- Analysis-result ranges remain automatic and read-only, matching the existing analysis behavior.

## Comparison history

- Pass 1: numeric values replaced `Auto`, but the original 59 px maximum field visibly clipped `11362.54` to `11362.5` (P2 legibility issue).
- Fix: widened both range inputs to 76 px without changing the footer layout or neighboring controls.
- Pass 2: the normalized source/live comparison showed both full numeric values, retained styling, and no desktop or mobile overflow.

## Regression checks

- Focused AthenaWorkbench numeric-default test: 1 passed, 206 skipped.
- AthenaPlot component suite: 74 passed, including four automatic/two-sided/one-sided range cases.
- TypeScript and Next route generation: passed.
- `git diff --check`: passed.
- Browser console warnings/errors after a clean reload: none.

final result: passed
