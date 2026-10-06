# Opening the log-ratio dialog automatically opens help over the reference selector

Severity: P3, mobile usability. Confirmed in Chromium with a 390 x 844 touch viewport.

Status: fixed by PR #12 (`00baebacc`), merged October 5, 2026; not yet deployed. Opening a dialog no longer focuses, and so no longer opens, its title help. Since October 2 help icons are hidden unless Show instruction is on, and the bug only reproduced with it on.

Target: http://drxas.xray.aps.anl.gov:3004
Deployed revision: 881d526f62d72f05f6fdaa8bfb879baee89acd55
Test date: 2026-10-01
Project: `xXNlXmwP9Q95K3rex90IiH3X`, `QA 2026-10-01 Analyses measured copper`.

## Reproduction

1. Open the app with processed spectra on a narrow viewport.
2. Tap Analysis > Log-ratio & phase difference.
3. Try to tap the Reference spectrum selector.

Expected: opening the dialog leaves its inputs visible and available. Help opens when requested, without taking the first dialog focus in a way that blocks a required input.

Observed: the dialog automatically focuses its title's `About Log-ratio & phase difference` help trigger. The help tooltip opens immediately over the current-group summary and Reference spectrum selector. A tap on the selector cannot reach it because the tooltip intercepts pointer events. Moving focus with Tab dismisses help, after which the same tap succeeds. Tapping elsewhere or dismissing help also provides a workaround.

The tooltip remains within the viewport; this report concerns input obstruction, not horizontal overflow. Similar automatic title help appeared in the peak-fitting dialog, but the reference-selector obstruction was directly reproduced in the log-ratio dialog.

## Evidence

- `browser/mobile-log-ratio-full-page.png`, visually inspected, shows the tooltip covering the first controls.
- `browser/mobile-tooltip-state.json` records the focused About help trigger and tooltip bounds: x=42, y=276.0625, width=340, height=141.5.
- `browser/mobile-tooltip-interaction.json` records the failed tap with `tooltip ... intercepts pointer events`, followed by a successful tap after Tab.
- Replay: `browser/tooltip.mjs`. It uses `isMobile: true`, `hasTouch: true` and a 390 x 844 viewport.

Consider focusing the first useful form control or a non-tooltip dialog heading when the dialog opens. Help should remain explicitly accessible by keyboard and touch.
