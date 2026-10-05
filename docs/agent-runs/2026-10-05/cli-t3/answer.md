Set the 10 K scan’s Fourier-transform range to **k = 3–18 Å⁻¹**, and verified that the effective kmax is 18 Å⁻¹. The signal/noise ratios fall from 6.7 at 15–17 Å⁻¹ to 2.8 at 17–19, 1.1 at 19–21, and below 1 thereafter. This retains useful high-k signal while removing the noise-dominated tail; Larch’s more conservative recommendation is 14.6 Å⁻¹.

**The first Cu–Cu shell is about 2.547 Å.** The uncorrected Fourier peak is at 2.27 Å; that peak is not the bond length.

A phase-aware FEFF fit using fcc Cu (AMCSD 13087, measured at 293 K, the closest stated temperature among the available entries) gives R = 2.5467 Å, σ² = 0.00366 Å², S₀² = 0.908, and ΔE₀ = 6.05 eV. The fit uses k = 3–18 Å⁻¹, R = 1–3 Å, and k weights 0–3. Its R-factor is 0.0052, with four variables against 20.1 independent points and no parameter reported at a bound.

Changing kmax to 14 or 16 Å⁻¹ moves the distance by only 0.0001 Å. The formal distance error is about 0.0021 Å, but systematic uncertainty is larger: holding ΔE₀ at 3 or 9 eV shifts the distance to 2.5315–2.5615 Å and worsens the R-factor to about 0.028. Thus **about 2.55 Å** is the useful physical conclusion; the sensitivity range is not a confidence interval. The room-temperature structural reference and model errors also limit precision.

The transform change is saved. Fits and sensitivity checks are diagnostic and do not modify the project.
