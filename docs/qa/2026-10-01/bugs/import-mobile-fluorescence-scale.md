# Mobile combined import collapses the fluorescence multiplier to an unreadable 18-pixel input

Severity: P2. Status: fixed by PR #10 (`e71720b60`), merged October 5, 2026; not yet deployed. The multiplier now gets its own row when the Flip button leaves too little room.

A scientist importing fluorescence together with transmission cannot read or reliably change the fluorescence multiplicative constant on a phone. At 360 px the control also extends beyond the viewport. The value affects imported scientific data, so the user needs to see it before confirming import.

Target: http://drxas.xray.aps.anl.gov:3004

Deployed revision: `881d526f62d72f05f6fdaa8bfb879baee89acd55`.

## Reproduction

1. Open the deployed app in Chromium at 390 x 844.
2. Choose Import data and upload synthetic-detectors.dat from this evidence folder, or any table with energy, I0, transmission and fluorescence columns.
3. Set Measurement to both transmission and fluorescence.
4. Scroll to the fluorescence controls below the detector table. Observe the row containing Flip fluorescence numerator and denominator and Fluorescence multiplicative constant.

Expected: The fluorescence multiplier label and full numeric value remain visible and editable. The controls should wrap or stack at narrow widths.

Observed: At 390 px, the field label has a measured width of 0 px and the input is only 18 px wide, with 8 px padding on each side. Its value 0.5 is unreadable. At 360 px the same input ends at x=364.3125, beyond the viewport. At desktop 1400 px it is 196.625 px wide, and at 768 px it is 332 px wide.

Independently reproduced with one upload after discovery in the live real-Cu batch test. Measured at 1400, 768, 390 and 360 px. No source changes made.

Source clue: frontend/components/athena-column-selection.tsx FluorescenceColumns row near line 194; layout lets the long Flip button consume the row and collapses the adjacent .ath-field.

Evidence is under `import-export/` in the durable evidence archive.

- `browser/fluorescence-mobile-metrics.json`
- `browser/fluorescence-control-390.png`
- `browser/fluorescence-control-360.png`
- `browser/fluorescence-control-1400.png`
- `browser/mobile-fluorescence.mjs`
- `browser/results/columns-imports-transmissi-21a88-ross-a-shared-real-Cu-batch/dual-mode-mobile.png`
