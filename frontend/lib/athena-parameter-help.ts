import type { Parameters } from "./athena"

// Definitions follow larch/xafs/{pre_edge,autobk,xafsft}.py and the Athena
// processing path in backend/xraylarch_web/athena_science.py.
export const parameterHelp = {
  e0: "Absorption-edge reference energy, in eV. It sets k = 0 when energy is converted to photoelectron wavenumber. When left blank, it is estimated from the spectrum.",
  step: "Absorption jump at E₀ used to scale μ(E) and χ(k). When left blank, it is estimated from the fitted pre-edge and post-edge curves.",
  pre1: "Start of the energy interval used to fit the pre-edge baseline, measured in eV relative to E₀. Must be negative and below the pre-edge end; choose a baseline interval supported by the data.",
  pre2: "End of the energy interval used to fit the pre-edge baseline, measured in eV relative to E₀. Must be at most zero and above the pre-edge start.",
  norm1: "Start of the energy interval used to fit the post-edge normalization curve, measured in eV relative to E₀. Must be nonnegative and below the post-edge end.",
  norm2: "End of the energy interval used to fit the post-edge normalization curve, measured in eV relative to E₀. Must be positive and above the post-edge start; choose the usable measured range.",
  nnorm: "Polynomial degree of the post-edge normalization fit. Higher degrees allow more curvature.",
  flatten: "Remove the fitted post-edge trend from normalized μ(E), making its baseline near 1 above the edge.",
  rbkg: "Positive R-space cutoff, in Å, below which AUTOBK minimizes background contributions. Start near 1 Å and keep it below the first-shell signal. Larger values allow a more flexible spline but may remove real EXAFS signal.",
  bkg_kmin: "Lower photoelectron wavenumber (k) limit used to fit the background spline, in Å⁻¹.",
  bkg_kmax: "Upper photoelectron wavenumber (k) limit used to fit the background spline, in Å⁻¹. When left blank, it uses the available post-edge range. The background overlay stops here; extracted χ(k) does not extend beyond this range.",
  bkg_kweight: "Power of k used to weight χ(k) during background fitting, from 0 to 3. Usually 0 or 1 emphasizes the low-k background; higher weights require reliable high-k data and amplify noise.",
  bkg_dk: "Controls the taper or shape of the Fourier window used during background fitting. Its meaning depends on the selected window.",
  bkg_window: "Fourier-window shape used by AUTOBK to reduce artifacts from the ends of its k range.",
  nclamp: "Number of points at each end of the uniform χ(k) grid used to restrain the background spline. The web default is 5; 1–5 points is a useful starting range. Zero disables both clamps.",
  clamp_lo: "Restrain the spline at its low-k endpoint. Athena choices, from least to most restraint: None, Slight, Weak, Medium, Strong, Rigid. None is the default and disables this clamp. Clamping acts near k = 0, even when spline k min is higher. A saved non-preset weight is shown as Custom and kept until you choose a preset.",
  clamp_hi: "Restrain the spline near spline k max. Athena choices, from least to most restraint: None, Slight, Weak, Medium, Strong, Rigid. Strong is the default; None disables this clamp. Stronger restraint pulls χ(k) toward zero or the selected standard and may suppress real signal. It does not extend the spline range. A saved non-preset weight is shown as Custom and kept until you choose a preset.",
  fnorm: "Correct energy-dependent normalization when extracting EXAFS from raw μ(E), intended for low-energy fluorescence data. Affects χ(k) and its transforms; energy plots stay unchanged.",
  kmin: "Lower k limit of the Fourier window used to transform χ(k) into χ(R), in Å⁻¹.",
  kmax: "Upper k limit of the Fourier window used to transform χ(k) into χ(R), in Å⁻¹.",
  kweight: "Power of k applied to χ(k) before the forward Fourier transform, from 0 to 3. Common choices are 0, 1, 2 and 3. Higher values emphasize high-k oscillations and noise; they do not add information.",
  dk: "Controls the taper or shape of the forward Fourier window to reduce ringing from the ends of the k range. Its meaning depends on the selected window.",
  window: "Window shape applied to the selected k range before Fourier transformation to R space.",
  rmin: "Lower R limit selected for the reverse transform into filtered χ(q), in Å. R is not phase corrected, so it is not an exact bond distance.",
  rmax: "Upper R limit selected for the reverse transform into filtered χ(q), in Å. R is not phase corrected, so it is not an exact bond distance.",
  dr: "Controls the taper or shape of the R-space window used for the reverse transform. Its meaning depends on the selected window.",
  rwindow: "Window shape applied to the selected R range before transforming back to filtered χ(q).",
  nfft: "Number of FFT grid points, including zero padding. Use a power of two from 128 to 65536; 2048 is the default. More points make the R grid finer without adding experimental information.",
  kstep: "Spacing of the uniform k grid used for EXAFS and Fourier transforms, in Å⁻¹, from 0.001 to 1. The default is 0.05; coarser spacing reduces the available R range.",
  energy_shift: "Constant offset added to every measured energy, in eV. Positive values move the spectrum to higher energy.",
} satisfies Record<keyof Parameters, string>

export const additionalParameterHelp = {
  fix_step: "Keep the current edge-step value fixed instead of estimating it again from the normalization fits.",
  background_standard_id: "A comparable χ(k) spectrum used to guide AUTOBK’s low-R background fit. The sample’s EXAFS remains the output.",
  spline_energy_min: "Lower background-fitting limit expressed as energy above E₀, in eV. This is the spline k min limit converted using E − E₀ ≈ 3.81 k².",
  spline_energy_max: "Upper background-fitting limit expressed as energy above E₀, in eV. This is the spline k max limit converted using E − E₀ ≈ 3.81 k². The background overlay stops here. A limit of 100 eV supports χ(k) only up to about 5.12 Å⁻¹; choose a range covering the EXAFS you intend to fit.",
}
