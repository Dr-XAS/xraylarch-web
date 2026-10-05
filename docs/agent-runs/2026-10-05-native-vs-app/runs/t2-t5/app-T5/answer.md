For the **Cu foil at 10 K**, the fitted nearest-neighbour Cu–Cu distance is:

**\(R_{\mathrm{Cu-Cu}} = 2.549\ \text{Å}\)**  
with a fit-only standard error of about **0.0015 Å**.

I fitted the first-shell Cu–Cu FEFF path (\(R_\mathrm{eff}=2.5562\) Å) over \(k=3\)–18 Å⁻¹ and \(R=1.5\)–3 Å. The fit was statistically strong (**R-factor 0.0018**, no flagged concerns), but the distance is correlated with the fitted energy shift (\(r=0.87\)); therefore the tiny formal error should not be treated as the full uncertainty.

### How far to trust it

Varying the \(k\)-range gave:

- \(k_{\max}=14\): **2.5492 Å**
- \(k_{\max}=16\): **2.5489 Å**
- \(k_{\max}=18\): **2.5490 Å**
- \(k_{\max}=20\): **2.5490 Å**, with a warning that the window extends beyond the FEFF path grid

So the result is stable to roughly **0.0003 Å** against \(k_{\max}\). However, testing fixed energy shifts showed the dominant systematic sensitivity:

- \(\Delta E_0=3\) eV: **2.5356 Å**, with a poor fit
- fitted \(\Delta E_0\approx6.53\) eV: **2.549 Å**
- \(\Delta E_0=9\) eV: **2.5586 Å**, also poorer than the optimum

**Recommendation:** report **2.55 Å**, and trust it to **a few hundredths of an angstrom**, approximately **±0.01–0.02 Å** in a realistic EXAFS sense. The formal fit precision is much better than that, but the result depends materially on the energy-zero/model correlation. This is a phase-corrected fitted distance—not the lower, uncorrected peak position in \(|\chi(R)|\).
