For the **Cu foil at 10 K**, the fitted nearest-neighbour Cu–Cu distance is:

**2.55 Å** — more precisely **2.549 Å** in the main fit.

### Basis
I fitted the first-shell Cu–Cu FEFF path using the fcc copper structure:

- FEFF reference distance: **2.5562 Å**
- Fitted correction: **ΔR = −0.0072 Å**
- Result: **R = 2.549 Å**
- Fit range: **k = 3–18 Å⁻¹**, Fourier-space fit over **R = 1.5–3.0 Å**
- R-factor: **0.0018**, with no reported fit concerns

### How far to trust it
The nominal statistical uncertainty is about **±0.0015 Å**, but that is not the full uncertainty. The result is strongly correlated with the fitted energy shift:

- correlation between ΔE₀ and ΔR: **0.87**
- changing the k-range from 3–14 to 3–20 Å⁻¹ gave **2.5489–2.5492 Å**
- fixing ΔE₀ artificially at 3 or 9 eV moved the distance to **2.5356–2.5586 Å**

So I would report it as:

> **Cu–Cu nearest-neighbour distance = 2.55 Å; trust approximately to ±0.01 Å**, rather than claiming millångström precision.

The crystallographic reference used here has a room/unspecified-temperature lattice parameter corresponding to **2.556 Å** for the nearest-neighbour distance, so the EXAFS result is consistent with bulk copper within that practical precision.
