import { describe, expect, it } from "vitest"
import { ATHENA_COLORMAPS, colormapOptions, colorscaleGradient, isAthenaColormap, plotlyColorscale, sampleColormap } from "./athena-colormaps"

describe("Athena wavelet colormaps", () => {
  it("offers the expanded continuous palette catalog", () => {
    expect(ATHENA_COLORMAPS.map(option => option.value)).toEqual([
      "magma", "viridis", "plasma", "inferno", "cividis", "coolwarm",
      "ylgnbu", "turbo", "hot", "greys", "rainbow",
    ])
    expect(ATHENA_COLORMAPS.every(option => option.label.includes(" · "))).toBe(true)
    expect(isAthenaColormap("turbo")).toBe(true)
    expect(isAthenaColormap("classic")).toBe(false)
  })

  it.each(ATHENA_COLORMAPS)("builds a complete fresh $value scale and reverses its mapping exactly", ({ value }) => {
    const forward = plotlyColorscale(value)
    const reversed = plotlyColorscale(value, true)
    expect(forward[0][0]).toBe(0)
    expect(forward.at(-1)?.[0]).toBe(1)
    expect(forward.every(([position, color], index) => position >= 0 && position <= 1 &&
      /^#[0-9a-f]{6}$/i.test(color) && (index === 0 || position > forward[index - 1][0]))).toBe(true)
    expect(reversed.map(([position]) => position)).toEqual(forward.map(([position]) => 1 - position).reverse())
    expect(reversed.map(([, color]) => color)).toEqual(forward.map(([, color]) => color).reverse())
    expect(plotlyColorscale(value)).not.toBe(forward)
  })

  it("keeps explicit stop positions in CSS previews, including the reversed nonuniform end", () => {
    expect(colorscaleGradient([[0, "#000000"], [0.25, "#808080"], [1, "#ffffff"]]))
      .toBe("linear-gradient(to right, #000000 0%, #808080 25%, #ffffff 100%)")
    expect(colormapOptions().map(({ value, label }) => ({ value, label }))).toEqual(ATHENA_COLORMAPS)
    const viridis = colormapOptions().find(option => option.value === "viridis")!
    const reversed = colormapOptions(true).find(option => option.value === "viridis")!
    expect(viridis.background).toContain(`#d8e219 ${240 / 255 * 100}%`)
    expect(reversed.background).toContain(`#d8e219 ${(1 - 240 / 255) * 100}%`)
    expect(reversed.background).toMatch(/^linear-gradient\(to right, #fde725 0%,/)
  })

  it("interpolates within the shorter final LUT interval rather than treating all stops as uniform", () => {
    // The final interval is LUT indices 240–255, with endpoint colors #d8e219 and #fde725.
    expect(sampleColormap("viridis", 247.5 / 255)).toBe("#ebe51f")
    expect(sampleColormap("viridis", 0)).toBe("#440154")
    expect(sampleColormap("viridis", 1)).toBe("#fde725")
  })
})
