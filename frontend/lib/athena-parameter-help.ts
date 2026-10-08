import type { Parameters } from "./athena"

// Definitions follow larch/xafs/{pre_edge,autobk,xafsft}.py and the Athena
// processing path in backend/xraylarch_web/athena_science.py.
export const parameterHelp = {
  e0: "Absorption-edge reference energy, in eV. It sets k = 0 when energy is converted to photoelectron wavenumber. When left blank, it is estimated from the spectrum.",
  step: "Absorption jump at E₀ used to scale μ(E) and χ(k). When left blank, it is estimated from the fitted pre-edge and post-edge curves.",
  pre1: "Start of the energy interval used to fit the pre-edge baseline, measured in eV relative to E₀.",
  pre2: "End of the energy interval used to fit the pre-edge baseline, measured in eV relative to E₀.",
  norm1: "Start of the energy interval used to fit the post-edge normalization curve, measured in eV relative to E₀.",
  norm2: "End of the energy interval used to fit the post-edge normalization curve, measured in eV relative to E₀.",
  nnorm: "Polynomial degree of the post-edge normalization fit. Higher degrees allow more curvature.",
  flatten: "Remove the fitted post-edge trend from normalized μ(E), making its baseline near 1 above the edge.",
  rbkg: "R-space cutoff, in Å, below which AUTOBK minimizes background contributions. Larger values allow a more flexible spline but may remove real EXAFS signal.",
  bkg_kmin: "Lower photoelectron wavenumber (k) limit used to fit the background spline, in Å⁻¹.",
  bkg_kmax: "Upper photoelectron wavenumber (k) limit used to fit the background spline, in Å⁻¹. When left blank, it uses the available post-edge range. The background overlay stops here; extracted χ(k) does not extend beyond this range.",
  bkg_kweight: "Power of k used to weight χ(k) during background fitting. Higher values emphasize high-k oscillations.",
  bkg_dk: "Controls the taper or shape of the Fourier window used during background fitting. Its meaning depends on the selected window.",
  bkg_window: "Fourier-window shape used by AUTOBK to reduce artifacts from the ends of its k range.",
  nclamp: "Number of points at each end of the uniform χ(k) grid used to restrain the background spline. The web default is 5; 1–5 points is a useful starting range. Zero disables both clamps.",
  clamp_lo: "Dimensionless endpoint penalty weight near k = 0, even when spline k min is higher. Zero (the default) disables this clamp. If needed, try 1, 2, 5, 10, then 20. Larger values pull χ(k) toward zero or the selected standard and can suppress real signal; the needed strength depends on the spectrum and its scale.",
  clamp_hi: "Dimensionless endpoint penalty weight near spline k max. Start at 1 (the default); zero disables this clamp. Try 2, 5, 10, then 20 if the background tail diverges. Larger values pull the background toward μ(E), or χ(k) toward the selected standard, and can suppress real signal. This does not extend the spline range; the needed strength depends on the spectrum and its scale.",
  fnorm: "Correct energy-dependent normalization when extracting EXAFS from raw μ(E), intended for low-energy fluorescence data. Affects χ(k) and its transforms; energy plots stay unchanged.",
  kmin: "Lower k limit of the Fourier window used to transform χ(k) into χ(R), in Å⁻¹.",
  kmax: "Upper k limit of the Fourier window used to transform χ(k) into χ(R), in Å⁻¹.",
  kweight: "Power of k applied to χ(k) before the forward Fourier transform. Higher values emphasize high-k oscillations.",
  dk: "Controls the taper or shape of the forward Fourier window to reduce ringing from the ends of the k range. Its meaning depends on the selected window.",
  window: "Window shape applied to the selected k range before Fourier transformation to R space.",
  rmin: "Lower R limit selected for the reverse transform into filtered χ(q), in Å. R is not phase corrected, so it is not an exact bond distance.",
  rmax: "Upper R limit selected for the reverse transform into filtered χ(q), in Å. R is not phase corrected, so it is not an exact bond distance.",
  dr: "Controls the taper or shape of the R-space window used for the reverse transform. Its meaning depends on the selected window.",
  rwindow: "Window shape applied to the selected R range before transforming back to filtered χ(q).",
  nfft: "Number of FFT grid points, including zero padding. More points make the R grid finer without adding experimental information.",
  kstep: "Spacing of the uniform k grid used for EXAFS and Fourier transforms, in Å⁻¹.",
  energy_shift: "Constant offset added to every measured energy, in eV. Positive values move the spectrum to higher energy.",
} satisfies Record<keyof Parameters, string>

export const additionalParameterHelp = {
  fix_step: "Keep the current edge-step value fixed instead of estimating it again from the normalization fits.",
  background_standard_id: "A comparable χ(k) spectrum used to guide AUTOBK’s low-R background fit. The sample’s EXAFS remains the output.",
  spline_energy_min: "Lower background-fitting limit expressed as energy above E₀, in eV. This is the spline k min limit converted using E − E₀ ≈ 3.81 k².",
  spline_energy_max: "Upper background-fitting limit expressed as energy above E₀, in eV. This is the spline k max limit converted using E − E₀ ≈ 3.81 k². The background overlay stops here. A limit of 100 eV supports χ(k) only up to about 5.12 Å⁻¹; choose a range covering the EXAFS you intend to fit.",
}
