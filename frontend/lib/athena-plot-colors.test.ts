import { describe, expect, it } from "vitest"

import { ATHENA_COLORMAPS, colormapOptions } from "./athena-colormaps"
import { defaultPlotColors, isPlotPalette, normalizePlotColorRange, plotPaletteOptions, spectrumColors } from "./athena-plot-colors"

describe("spectrum plot palettes", () => {
  it("uses the PR's categorical colors by default", () => {
    expect(defaultPlotColors).toEqual({ palette: "classic", reversed: false })
    expect(spectrumColors(3, { palette: "classic", reversed: false })).toEqual(["#16736b", "#c37b38", "#7470b0"])
    const forward = spectrumColors(9, defaultPlotColors)
    expect(forward.slice(7)).toEqual(["#16736b", "#c37b38"])
    expect(spectrumColors(9, { palette: "classic", reversed: true })).toEqual([...forward].reverse())
  })

  it("offers every wavelet map with matching labels and previews, plus Classic", () => {
    for (const reversed of [false, true]) {
      const [classic, ...continuous] = plotPaletteOptions(reversed)
      expect(classic).toMatchObject({ value: "classic", label: "Classic · categorical" })
      expect(continuous).toEqual(colormapOptions(reversed))
      expect(continuous.map(option => option.value)).toEqual(ATHENA_COLORMAPS.map(option => option.value))
    }
    expect(isPlotPalette("classic")).toBe(true)
    expect(ATHENA_COLORMAPS.every(({ value }) => isPlotPalette(value))).toBe(true)
    expect(isPlotPalette("not-a-palette")).toBe(false)
    expect(isPlotPalette(null)).toBe(false)
  })

  it("samples gradients across the selected groups and reverses them", () => {
    const forward = spectrumColors(3, { palette: "viridis", reversed: false })
    expect(forward).toEqual(["#440154", "#21918c", "#fde725"])
    expect(spectrumColors(3, { palette: "viridis", reversed: true })).toEqual([...forward].reverse())
  })

  it("uses visible ramp bounds to choose continuous colors, including after reversal", () => {
    expect(spectrumColors(3, { palette: "coolwarm", reversed: false, vmin: 0.25, vmax: 0.75 }))
      .toEqual(["#8db0fe", "#dddcdc", "#f4987a"])
    expect(spectrumColors(2, { palette: "coolwarm", reversed: true, vmin: 0.25, vmax: 0.5 }))
      .toEqual(["#f4987a", "#dddcdc"])
    expect(spectrumColors(1, { palette: "coolwarm", reversed: false, vmin: 0.25, vmax: 0.5 }))
      .toEqual(["#b9d0f9"])
  })

  it("keeps Classic categorical colors when bounds change", () => {
    expect(spectrumColors(3, { palette: "classic", reversed: false, vmin: 0.25, vmax: 0.75 }))
      .toEqual(spectrumColors(3, defaultPlotColors))
  })

  it("normalizes missing, nonfinite, out-of-range, and overlapping ramp bounds", () => {
    expect(normalizePlotColorRange({})).toEqual({ vmin: 0, vmax: 1 })
    expect(normalizePlotColorRange({ vmin: Number.NaN, vmax: Number.POSITIVE_INFINITY }))
      .toEqual({ vmin: 0, vmax: 1 })
    expect(normalizePlotColorRange({ vmin: -0.2, vmax: 1.3 })).toEqual({ vmin: 0, vmax: 1 })
    expect(normalizePlotColorRange({ vmin: 0.99, vmax: 0.99 })).toEqual({ vmin: 0.98, vmax: 1 })
    const crossing = normalizePlotColorRange({ vmin: 0.45, vmax: 0.44 })
    expect(crossing.vmin).toBe(0.45)
    expect(crossing.vmax).toBeCloseTo(0.47)
  })

  it("uses canonical stop positions across the full range without cropping line palettes", () => {
    // 256 groups hit the exact LUT positions used by the canonical map.
    const colors = spectrumColors(256, { palette: "viridis", reversed: false })
    expect(colors[0]).toBe("#440154")
    expect(colors[112]).toBe("#26828e")
    expect(colors[240]).toBe("#d8e219")
    expect(colors[255]).toBe("#fde725")
    expect(spectrumColors(1, { palette: "viridis", reversed: false })).toEqual(["#21918c"])
    expect(spectrumColors(0, defaultPlotColors)).toEqual([])
  })

  it.each(ATHENA_COLORMAPS)("samples and reverses the complete $value map", ({ value }) => {
    const forward = spectrumColors(17, { palette: value, reversed: false })
    expect(forward.every(color => /^#[0-9a-f]{6}$/.test(color))).toBe(true)
    expect(spectrumColors(17, { palette: value, reversed: true })).toEqual([...forward].reverse())
  })
})
