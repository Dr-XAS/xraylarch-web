# Design QA: Wavelet color legend controls

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-1ce7b796-8ccb-48ac-b9b6-8af1ead10b41.png` (1518 x 122 px, treated as a 2x UI capture and normalized to 759 x 61 CSS px).
- Implementation route: `http://127.0.0.1:3004/` in the Codex in-app Browser.
- Browser-rendered implementation screenshot: inline Codex in-app Browser capture; the browser integration did not expose a filesystem path (610 x 773 px at a 610 x 773 CSS viewport, device scale 1).
- Responsive capture: inline Codex in-app Browser capture at 390 x 844 CSS px, device scale 1; the viewport override was reset after verification.
- State for the matched comparison: light theme, `Coolwarm · blue–red`, Reverse unchecked, 2D heatmap, and the saved copper foil example.
- Combined comparison: the source image and live implementation capture were emitted together in one comparison input. The source was interpreted at 2x density before comparing typography and control dimensions.

## Findings

- No remaining P0, P1, or P2 findings.
- The implementation reproduces the reference hierarchy: `Color legend`, descriptive select, endpoint labels, continuous ramp, and `Reverse`, on one desktop row.
- `Low` / `High` intentionally replaces `First` / `Last` because the Wavelet ramp maps scalar `|WT|` magnitude rather than an ordered list of spectra.
- The control remains independent from the spectrum-line color legend, which preserves the existing product behavior while giving Wavelet its own persistent display preference.

## Required fidelity surfaces

- Fonts and typography: the implementation uses the existing Athena label/body tokens, muted label color, regular control weight, and line-height. After normalizing the 2x reference, text size and hierarchy match the surrounding application UI.
- Spacing and layout rhythm: desktop order, select width, ramp proportions, checkbox alignment, padding, and border treatment match the reference pattern. At 390 px the select occupies the first line and the ramp plus Reverse wrap cleanly to a second line.
- Colors and visual tokens: the matched Coolwarm preview runs blue to neutral to red and uses the existing Athena surface, divider, muted-text, and checkbox tokens. Reverse mirrors both color values and stop positions exactly.
- Image quality and asset fidelity: the target contains no photographic, illustrative, logo, or icon asset. The color ramp is a functional live visualization generated from the exact Plotly scale, so its preview remains synchronized with palette and Reverse state.
- Copy and content: palette labels include both the canonical map name and a short color-direction description. The Wavelet-specific endpoint copy is `Low` / `High` and the checkbox copy remains `Reverse`.

## Interaction and responsive evidence

- Eleven continuous maps are available: Magma, Viridis, Plasma, Inferno, Cividis, Coolwarm, YlGnBu, Turbo, Hot, Greys, and Rainbow.
- Switching Magma to Turbo and toggling Reverse updated the existing 2D heatmap without another Wavelet calculation; unit coverage also asserts that the scientific grid is unchanged.
- Switching to 3D retained the selected and reversed scale and rendered the matching Plotly colorbar.
- The setting persists under `athena.wavelet-colors.v1` and restores after remount; the earlier shared preference key is accepted as a migration fallback.
- At 390 x 844, `documentElement.clientWidth` and `scrollWidth` were both 390 px, so the control introduced no horizontal overflow.
- Browser console warnings/errors during the verified interactions: none.

## Full-view and focused comparison evidence

- Full-view evidence: the live Wavelet card shows the new row between current-spectrum/export controls and the existing range/plot area, without changing the surrounding viewer hierarchy.
- Focused evidence: the source crop and the live Coolwarm/unreversed implementation were opened together. Label order, dropdown treatment, color direction, checkbox state, background, and divider placement visibly agree after density normalization.
- A focused comparison was required because the reference is a narrow control-row crop rather than a full application screen.

## Comparison history

- Pass 1: no actionable P0, P1, or P2 visual difference was found. The Low/High wording and responsive wrap are intentional semantic adaptations, not fidelity defects.

## Regression checks

- Full frontend Vitest suite: 62 files and 1,144 tests passed. Existing React `act(...)` warnings remain in unrelated suites.
- Next.js route generation and TypeScript: passed.
- Next.js production build: passed.
- Focused Playwright source was updated, but its local runner could not launch because the managed Chromium executable is not installed. The same interactions were completed in the Codex in-app Browser instead.
- `git diff --check`: passed.

final result: passed
