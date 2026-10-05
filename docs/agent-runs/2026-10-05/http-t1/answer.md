**The 10 K and 50 K scans are closely comparable. The 300 K scan is useful, but it is not directly comparable as an otherwise identical temperature-series measurement.** It combines expected thermal damping with a different acquisition history, energy offset, absorption scale, and shorter usable range.

| Check | 50 K versus 10 K | 300 K versus 10 K |
|---|---:|---:|
| Fitted energy correction to match 10 K; not applied | −0.018 eV | −2.959 eV |
| Edge step | 2.290 versus 2.299; 0.4% lower | 2.729; 18.7% higher |
| Maximum normalized XANES difference on current axes | 0.0086 | 0.3842 |
| Available k extent | Both 25 Å⁻¹ | 17.45 Å⁻¹ |

**Why the 300 K scan stands apart:**

- **Different experiment:** the recorded provenance places 10/50 K at NSLS X11-A in 1992, and room temperature at APS 13ID in 2001. These are not three scans from one controlled acquisition. Instrument, calibration, and sample differences can accompany temperature differences.
- **Energy calibration:** its E0 is 2.92 eV higher. The fitted correction is about −2.96 eV. The large current-axis XANES mismatch therefore cannot establish a chemical difference; calibration must be addressed first.
- **Real amplitude damping is plausible:** its k²-weighted EXAFS amplitude relative to 10 K falls from 0.798 at k = 3–5 to 0.461 at 7–9 and 0.191 at 11–13 Å⁻¹. That trend is consistent with increased thermal disorder (Debye–Waller damping), but these measurements alone cannot attribute every difference to temperature.
- **Less useful high-k data:** its signal approaches its own noise floor in the 15–17.45 Å⁻¹ bin. The cold scans approach theirs around 19–21 Å⁻¹. Their recorded endpoints are not equivalent usable limits.

For a subsequent comparison, use normalized spectra, resolve the energy calibration, and use matching processing and a common k window around 3–15 Å⁻¹. Do not average the three as repeat measurements. The 10/50 K pair agrees very well, with only modest amplitude damping at 50 K.

The “shared reference” is an exact duplicate of the 300 K measurement (`cu_rt01.xmu`), not independent calibration evidence. All three foils are linked to it, so that linkage must be considered before independently adjusting their energies.

I left the project unchanged.
