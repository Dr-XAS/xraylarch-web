// Shared wording for the identical import and processing rebin controls.
export const rebinInstructions = {
  "emin": "Start of the fine edge-region grid, in eV relative to E₀. Points before this boundary use the pre-edge spacing. Keep it inside the measured energy range.",
  "emax": "End of the fine edge-region grid, in eV above E₀. Beyond this boundary the grid uses uniform k spacing. Keep it above E₀ and inside the measured range.",
  "pre": "Energy spacing in eV before the edge region. A larger positive step reduces the number of pre-edge points.",
  "xanes": "Energy spacing in eV across the edge region. Choose a positive step fine enough to retain the edge and near-edge structure.",
  "exafs": "Wavenumber spacing in Å⁻¹ after the edge region. A positive uniform k step becomes a progressively wider energy step as energy increases.",
  "width": "Number of original samples averaged before interpolation, from 1 to 11. Use 1 for no smoothing; broad kernels can mix scan endpoints under Athena’s periodic boundary convention."
} as const
