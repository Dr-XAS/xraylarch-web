# Numeric parameter ranges

Scientific controls must agree with request validation. A typed value outside
the accepted range is an error to correct; it is not a request to silently clamp
the value or to replace a successful saved result. Automatic normalization and
range values can still be cleared to let Larch resolve them.

| Parameter | Meaning and constraint |
| --- | --- |
| FT, spline, display and export k-weight | 0–3. Common choices are 0, 1, 2 and 3. Athena retains fractional exponents within this interval for native recipes; Artemis uses integer weights. High weights emphasize high-k noise as well as signal. |
| E₀ and fixed edge step | Positive, finite numbers. E₀ is on the shifted energy axis; the edge step has the signal's scale, so there is no universal small upper bound. |
| Pre-edge interval | Offsets in eV relative to E₀: start < end ≤ 0. |
| Post-edge interval | Offsets in eV relative to E₀: 0 ≤ start < end. |
| Energy shift, ΔE₀ and ΔR | Signed corrections. Negative shifts and contractions are meaningful. |
| Rbkg | Positive cutoff in Å. Start near 1 Å, below the first-shell Fourier signal. Increasing it can remove genuine EXAFS. |
| Spline and FT k intervals | Nonnegative lower limit, positive upper limit, lower < upper, in Å⁻¹. Use the spectrum's reliable post-edge support. |
| Reverse-transform and fit R intervals | Nonnegative lower limit, positive upper limit, lower < upper, in Å. Limited by the FFT grid; uncorrected R is not a bond distance. |
| Window widths | Nonnegative; Gaussian windows require positive widths. The selected window determines the meaning of its shape/taper parameter. |
| Clamp strengths and point counts | Nonnegative strengths; whole-number counts. Zero disables clamping. Default low/high strengths are 0/1 and the point count is 5. |
| Athena FFT grid | Power-of-two point count 128–65536, default 2048; k step 0.001–1 Å⁻¹, default 0.05. Zero padding does not add information. The classic workspace retains its existing larger FFT limit of 262144 and its output-radius/Nyquist validation. |
| Explicit spline knots | Zero for automatic selection, or 5–128 whole knots, matching AUTOBK's effective range. |
| Peak and broadening widths | Positive, in the selected coordinate's units. The peak model requires positive areas, and peak widths cannot exceed the fit interval. General fit expressions can retain signed coefficients. |
| Simulation | Nonnegative amplitudes and mean-square disorder; signed energy and distance corrections. FEFF and simulation forms expose their existing calculation limits. |
| Detector and import controls | Whole indices within available detector channels/points, positive grid steps and gains, nonnegative thickness, and bounded physical angles. |

The allowed numerical envelope is not a recommendation to use its extremes.
Energy ranges depend on the absorption edge and measured scan; useful k limits
also depend on noise. Existing requested-versus-effective reporting remains
available when Larch resolves automatic values or clips a requested interval to
measured support. Generic fitting expressions and user-defined fit-parameter
bounds retain their meanings.

The review covers Athena processing and analysis dialogs, the classic processing
inspector, shared spectrum/wavelet viewers, data export, rebinning, calibration,
self-absorption and multi-electron corrections, XRF controls, and Artemis fitting,
simulation, FEFF, coordination and disorder controls. Existing dedicated validators
remain authoritative for operation-specific and data-dependent constraints.

Previously saved or imported recipes outside the new limits are not silently
rewritten. Correct their reported invalid parameters before recalculating or
exporting them through the integration API. The checked-in integration schema
uses the same limits; an integrated release must synchronize the Dr.XAS contract
copy when updating its pinned application revision.

Sources: [Larch AUTOBK](https://xraypy.github.io/xraylarch/xafs_autobk.html),
[Larch Fourier transforms](https://xraypy.github.io/xraylarch/xafs_fourier.html),
[Athena k weighting](https://bruceravel.github.io/demeter/aug/ui/kweight.html), and
the local scientific implementations and request models.
