import { describe, expect, it } from "vitest"
import { ATHENA_COLORMAPS, isAthenaColormap, plotlyColorscale } from "./athena-colormaps"

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
})
