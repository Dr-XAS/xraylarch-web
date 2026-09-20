import { describe, expect, it } from "vitest"

import { spectrumColors } from "./athena-plot-colors"

describe("spectrum plot palettes", () => {
  it("uses the PR's categorical colors by default", () => {
    expect(spectrumColors(3, { palette: "classic", reversed: false })).toEqual(["#16736b", "#c37b38", "#7470b0"])
  })

  it("samples gradients across the selected groups and reverses them", () => {
    const forward = spectrumColors(3, { palette: "viridis", reversed: false })
    expect(forward).toEqual(["#440154", "#21918c", "#fde725"])
    expect(spectrumColors(3, { palette: "viridis", reversed: true })).toEqual([...forward].reverse())
  })
})
