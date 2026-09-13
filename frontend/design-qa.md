# Design QA: resizable Athena workspace

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-3fa07639-4cfe-49bd-9992-ecd685b8779e.png`
- Implementation capture: `/private/tmp/athena-workspace-desktop-final.png`
- Side-by-side comparison: `/private/tmp/athena-workspace-comparison-final.png`
- Implementation route: `http://127.0.0.1:3004/`
- Desktop viewport: 1440 x 1000 CSS px
- Responsive viewports checked: 900 x 1000 and 390 x 844 CSS px
- State: copper-foil temperature series, normalized-energy tab, default pane widths
- Reference limitation: the supplied image is a 262 x 1586 partial crop of the previous layout, so it is used for typography, borders, palette, and component styling. The user's written request is the source of truth for the new three-pane order and resizing behavior.

## Required fidelity surfaces

- Pane order: Data Groups on the left, Processing Parameters in the middle, Spectrum Viewer on the right.
- Dividers: two visible, narrow vertical resize strips between the three panes.
- Existing visual system: Athena typography, muted green/gray palette, panel borders, spacing, controls, plot card, and copy remain unchanged.
- Assets: existing Athena wordmark, icons, and plot content remain unchanged.
- Responsive behavior: desktop panes resize without page overflow; compact layouts preserve the same semantic order and hide the desktop-only resize controls.

## Comparison findings

### Full view

- The implementation preserves the reference's low-contrast panel treatment and light structural rules.
- Processing Parameters now occupies the middle column, while the Spectrum Viewer receives the flexible right-hand column.
- Default widths keep Data Groups and Processing compact while leaving the plot as the primary workspace.
- No visible horizontal overflow at 1440, 900, or 390 px.

### Focused regions and interactions

- Both separators expose a `col-resize` interaction, a wider invisible hit target, hover/focus/active feedback, and accessible separator semantics.
- Pointer dragging was checked in both directions. The first divider redistributes Data Groups and Processing; the second redistributes Processing and Spectrum.
- Plotly reflow was checked after the Spectrum Viewer width changed.
- Keyboard resizing was checked with Left/Right, Shift+Left/Right, Home, and End. Escape restores the width from the beginning of an active drag; double-click restores defaults.
- Enter and Space provide a keyboard-equivalent reset action.
- Width preferences persist in local storage and are clamped again when the viewport changes.

## Iteration history

- Initial desktop comparison: passed for order, spacing, palette, and content preservation.
- Interaction pass: verified both pointer dividers, keyboard adjustment, reset, persistence, and plot reflow.
- Responsive pass: found 79 px of horizontal overflow at 390 px from the existing top navigation (P2). Updated the mobile navigation to wrap; the repeated check measured 0 px overflow.
- Audit pass: kept saved desktop preferences separate from temporary viewport clamping, moved the tablet row border to the Spectrum Viewer, deferred drag persistence until pointer-up, added a keyboard reset, and guarded non-primary/re-entrant pointers.
- Preference regression pass: a saved 387 px Processing pane clamped to 325 px at a 960 px viewport and returned to 387 px when restored to 1440 px.
- Console pass: no errors or warnings in the final browser state.

## Severity review

- P0: none
- P1: none
- P2: none remaining
- P3: none blocking handoff

final result: passed
