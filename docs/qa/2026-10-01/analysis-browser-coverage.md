# Browser analysis checks

The deployed Athena analysis workflows completed through real Chromium interactions. Two additional P3 UI defects are confirmed and saved individually in the parent `bugs` directory.

Desktop checks passed for exact 30/70 linear combination fitting, JSON Report download, PCA rank-one reconstruction, adding/removing peaks, recovering a known Gaussian center of 8984 eV, and a measured-copper log-ratio fit with the expected damping sign. Manually supplying a valid k range also allowed chi(k) LCF to finish.

At 390 x 844, all four analysis dialogs fit the viewport without horizontal content overflow. They can be dismissed with Escape; an open help tooltip consumes the first Escape, so a second press may be needed. The initial test that expected one Escape was a test assumption, not a separate defect. No browser page errors were recorded.

Confirmed defects:

- `../bugs/analysis-002-chi-range-energy-units.md`: changing Fit signal to chi(k) retains eV labels and energy-scale limits, causing a predictable range error until the scientist corrects the values.
- `../bugs/analysis-003-dialog-help-blocks-reference.md`: mobile dialog autofocus opens title help over the reference selector and intercepts taps until the tooltip is dismissed.

Visually inspected screenshots include `lcf-dialog.png`, `lcf-result.png`, `chi-range-wrong-units.png`, `chi-range-default-error.png`, `log-ratio-plot.png`, `mobile-XANES-clean.png`, `mobile-Log-ratio-clean.png` and `mobile-log-ratio-full-page.png`. The log-ratio plot displayed both curves and separate amplitude/phase axes correctly.

`run.mjs`, `continue.mjs` and `tooltip.mjs` preserve the browser actions. `checks.json` retains the exploratory checks, including the initial script stop after the one-Escape assumption. Request/response pairs preserve analysis submissions. The corrected manual k maximum was 8 inverse angstrom because the constructed spectra only extended to approximately 9 inverse angstrom; an initial 10 inverse angstrom request was correctly rejected and is not a defect.

Only the two existing QA projects created by this agent were used. There were no application code edits, shared preference writes or deployment changes.
