# Design QA: clickable spectrum colorbar

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-b61364ce-18a4-471d-b890-90d1c855a4a1.png` (1370 x 94 px, treated as a 2x UI capture and normalized to 685 x 47 CSS px).
- Requested deltas from that source: remove the visible `Color legend` selector and palette name, make the color ramp itself the palette selector, and add a small dropdown arrow.
- Implementation route: `http://127.0.0.1:3004/` in the Codex in-app Browser.
- Browser-rendered implementation screenshot: inline Codex in-app Browser capture; the browser integration did not expose a filesystem path.
- Combined comparison: a temporary local QA route rendered the normalized source and the real `AthenaColorLegend` component together in one 1280 x 720 browser capture. The temporary route was removed after review.
- Focused implementation dimensions: 584 x 49 CSS px for the control row; the clickable ramp and arrow have a 172 x 28 CSS px target at the inspected desktop viewport.
- Responsive capture: 390 x 844 CSS px, device scale 1. `documentElement.clientWidth` and `scrollWidth` were both 390 px.
- State: light theme, Classic categorical palette, Reverse unchecked, spectrum workspace.

## Findings

- No remaining P0, P1, or P2 findings.
- The updated row removes the left selector and visible palette name exactly as requested.
- `First`, the categorical ramp, a compact downward chevron, `Last`, and `Reverse` remain on one clear row at desktop and at 390 px.
- The 28 px picker target is larger than the visible 9 px ramp, so the compact visual remains easy to click.
- Palette names remain available only inside the native select menu and to assistive technology; the collapsed control is visual-only.

## Required fidelity surfaces

- Fonts and typography: the existing Figtree label and caption tokens are unchanged. `First`, `Last`, and `Reverse` retain the source weight, size, color, and line height.
- Spacing and layout rhythm: removing the roughly 230 CSS px visible selector makes the row substantially more compact without changing its padding, divider, endpoint spacing, or checkbox alignment. The ramp and chevron share one 28 px interaction target.
- Colors and visual tokens: the Classic categorical ramp uses the same seven colors and hard segment boundaries as the source. Hover and focus use existing Athena canvas and primary tokens.
- Image quality and asset fidelity: the control contains no photographic or illustrative asset. The ramp remains a live CSS visualization synchronized with plot colors, and the affordance is the existing Lucide `ChevronDown` icon rather than a text glyph or handmade asset.
- Copy and content: visible `Color legend` and `Classic · categorical` text are removed. Visible endpoint and checkbox copy remains `First`, `Last`, and `Reverse`. Palette names remain in the opened native menu for identification and accessibility.

## Interaction and responsive evidence

- Clicking the ramp expanded the native palette selector in the in-app Browser; the same target received a visible 2 px focus ring.
- The native select keeps mouse, touch, keyboard, and screen-reader behavior and exposes all six named palettes.
- Focused component tests verified palette changes and local-storage persistence; the existing workbench integration test verified the plotted color update.
- The in-app Browser's synthetic native-option selection did not dispatch React's change event reliably, so the actual change path was verified with the focused component and integration tests rather than claimed from that browser action.
- The disabled state keeps both palette and Reverse controls unavailable.
- At 390 px the full row stayed on one line and introduced no horizontal overflow.
- Browser console warnings/errors during the desktop and 390 px checks: none.

## Full-view and focused comparison evidence

- Full-view evidence: the live spectrum workspace shows the compact colorbar row between the plot controls and energy-mode controls, with the surrounding hierarchy unchanged.
- Focused evidence: the normalized source and real component were rendered together in one comparison capture. The retained typography, ramp colors, endpoint labels, checkbox, background, and divider match; the missing left selector and new chevron are intentional requested changes.
- A focused comparison was required because the source is a narrow control-row crop rather than a full application screen.

## Comparison history

- Pass 1: no actionable P0, P1, or P2 visual difference was found. The reduced row width, hidden palette name, and chevron are the requested intentional deviations from the source.

## Regression checks

- Full frontend Vitest suite: 64 files and 1,168 tests passed.
- `components/athena-color-legend.test.tsx`: 2 tests passed.
- Focused workbench palette integration: 2 tests passed; 270 unrelated tests skipped by the name filter.
- TypeScript / Next route generation: passed.
- Next.js production build: passed.
- `git diff --check`: passed.

final result: passed
