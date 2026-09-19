import { describe, expect, it } from "vitest"

import { ATHENA_COLORMAPS, plotlyColorscale, spectrumColor } from "./athena-colormaps"

describe("Athena colormaps", () => {
  it("offers Coolwarm for shared spectrum and wavelet rendering", () => {
    expect(ATHENA_COLORMAPS).toContainEqual({ value: "coolwarm", label: "Coolwarm" })
    expect(spectrumColor("coolwarm", 0, 2)).toBe("#3b4cc0")
    expect(spectrumColor("coolwarm", 1, 2)).toBe("#b40426")
  })

  it("reverses colors without changing Plotly stop positions", () => {
    const forward = plotlyColorscale("viridis")
    const reversed = plotlyColorscale("viridis", true)

    expect(reversed.map(([position]) => position)).toEqual(forward.map(([position]) => position))
    expect(reversed.map(([, color]) => color)).toEqual(forward.map(([, color]) => color).reverse())
  })
})
