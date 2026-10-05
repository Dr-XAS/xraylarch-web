The nearest-neighbour Cu–Cu distance in the **10 K foil is about 2.55 Å**. I would report **2.55 ± 0.02 Å** as a conservative practical estimate, not a formal confidence interval.

I fitted the foil’s EXAFS with a phase-corrected FEFF Cu–Cu first-shell path, with 12 neighbours. The result was **2.5489 Å**, using k = 3–16 Å⁻¹, k² weighting, and R = 1.5–3 Å. The uncorrected Fourier-transform peak at 2.30 Å is not the bond distance.

The checks behind that estimate were:

- **Fit quality:** R-factor 0.0018; four fitted variables versus 13.4 independent points; no parameters at bounds. The fitted energy offset was 6.52 eV, S₀² = 0.899, and σ² = 0.00361 Å².
- **Fitting range:** upper k limits of 14, 16, and 18 Å⁻¹ gave 2.5492, 2.5489, and 2.5490 Å—a spread of only 0.0003 Å. The signal approaches the noise floor around 19–21 Å⁻¹, so extending the fit to the full measured range would not add reliable information.
- **Energy-offset sensitivity:** holding ΔE₀ at 3 and 9 eV gave 2.5353 and 2.5587 Å, respectively, with worse R-factors of 0.0180 and 0.0101. This 0.0234 Å span is a sensitivity test, not two equally good alternative distances. Energy offset and distance are correlated (+0.88).

The formal distance standard error is only 0.0017 Å, but it excludes systematic model errors; reduced χ² is 13.3. The shorter-range fit also flags an amplitude/disorder correlation of +0.90. These are reasons not to claim millångström accuracy.

FEFF used fcc copper structure AMCSD 13087, measured at 293 K, with reference distance 2.5548 Å; the fit allowed the distance to change for the 10 K data. Thus **a couple of hundredths of an ångström is a defensible precision for this model**, while the ±0.02 Å estimate does not exhaust every possible calibration or modeling systematic.
