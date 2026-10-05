The nearest-neighbour Cu–Cu distance in the **10 K foil is about 2.55 Å**. I would report **2.55 ± 0.02 Å** as a practical estimate; the ±0.02 Å is a sensitivity allowance, not a calibrated statistical confidence interval.

I fitted the foil’s EXAFS with a phase-corrected FEFF Cu–Cu first-shell path, retaining its 12-fold coordination. The best fit gave **2.5489 Å**, using k = 3–16 Å⁻¹, k² weighting, a Hanning window with dk = 2 Å⁻¹, and R = 1.5–3 Å. The uncorrected Fourier peak at 2.301 Å is not the bond distance.

The fit had R-factor **0.00175**, four fitted variables versus 13.4 independent points, and no parameters at bounds. It gave S₀² = 0.899, σ² = 0.00361 Å², and ΔE₀ = 6.52 eV. Its formal distance standard error was 0.0017 Å, but that excludes systematic model errors; the reduced χ² was 13.3, so that error alone would overstate the absolute accuracy.

| Sensitivity check | Cu–Cu distance |
|---|---:|
| kmax = 14, 16, 18 Å⁻¹, with ΔE₀ fitted | 2.5492, 2.5489, 2.5490 Å |
| k weights 1, 2, 3 | 2.5483, 2.5489, 2.5481 Å |
| Hold ΔE₀ at 3 eV | 2.5353 Å |
| Hold ΔE₀ at 9 eV | 2.5587 Å |

The energy-offset tests dominate the spread: 0.0234 Å overall, consistent with the fitted ΔE₀–distance correlation of +0.878. Those constrained fits were worse than the best fit, with R-factors 0.0180 and 0.0101, so they are stress tests rather than equally likely alternatives. Moving the lower R limit from 1 to 1.7 Å left the distance at 2.5489 Å.

Signal approaches the noise floor around k = 19–21 Å⁻¹, which is why I did not use the entire available range. FEFF used fcc copper structure AMCSD 13087, measured at 293 K, as the scattering model; its reference distance was allowed to shift when fitting the 10 K measurement. These checks support the requested hundredths-of-an-angstrom precision, but not an absolute accuracy of a few thousandths.
