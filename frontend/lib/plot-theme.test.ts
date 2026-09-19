import { describe, expect, it } from "vitest"
import { plotColorForTheme, plotDataForTheme, plotLayoutForTheme } from "./plot-theme"

describe("scientific plot themes", () => {
  it("retains the existing light presentation and data", () => {
    const layout = { paper_bgcolor: "white", xaxis: { range: [3, 12] } }
    const data = [{ x: [1, 2], y: [3, 4], line: { color: "#16736b" } }]
    expect(plotLayoutForTheme(layout, "light")).toBe(layout)
    expect(plotDataForTheme(data, "light")).toBe(data)
  })

  it("themes primary and secondary axes without changing ranges or interaction state", () => {
    const layout = { uirevision: "E-current", xaxis: { range: [null, 12], autorange: "min", showgrid: false },
      yaxis2: { title: { text: "Phase difference (rad)" }, overlaying: "y", side: "right" },
      hoverlabel: { namelength: -1 }, legend: { x: 1.02 }, font: { size: 12 } }
    const result = plotLayoutForTheme(layout, "dark")
    expect(result).toMatchObject({ paper_bgcolor: "#17171c", plot_bgcolor: "#17171c", uirevision: "E-current",
      font: { color: "#fafafa", size: 12 }, xaxis: { ...layout.xaxis, gridcolor: "#313032" },
      yaxis2: { ...layout.yaxis2, tickfont: { color: "#a1a1aa" } },
      hoverlabel: { namelength: -1, bgcolor: "#27272a", font: { color: "#fafafa" } }, legend: { x: 1.02 } })
    expect(layout.xaxis).toEqual({ range: [null, 12], autorange: "min", showgrid: false })
  })

  it("themes 3D axes and colorbar labels while retaining the full scientific colorscale", () => {
    const scale = [[0, "#000004"], [1, "#fcfdbf"]], z = [[0, 1], [2, 3]]
    const data = [{ type: "surface", z, colorscale: scale, cmin: 0, cmax: 3,
      colorbar: { title: { text: "|WT|", font: { size: 12, color: "#52665b" } }, thickness: 12 } }]
    const result = plotDataForTheme(data, "dark")
    expect(result[0]).toMatchObject({ cmin: 0, cmax: 3, colorbar: { title: { text: "|WT|", font: { color: "#fafafa" } }, thickness: 12 } })
    expect(result[0].z).toBe(z)
    expect(result[0].colorscale).toBe(scale)
    const camera = { eye: { x: -1.7, y: -1.4, z: 1.2 } }
    expect(plotLayoutForTheme({ scene: { camera, yaxis: { range: [0, 6] } } }, "dark")).toMatchObject({
      scene: { bgcolor: "#17171c", camera, xaxis: { backgroundcolor: "#17171c" },
        yaxis: { range: [0, 6], gridcolor: "#313032" }, zaxis: { tickfont: { color: "#a1a1aa" } } },
    })
  })

  it("brightens dark marks consistently without changing data, dash patterns, or bright colors", () => {
    const line = { color: "#1d1147", dash: "dot", width: 1.8 }, x = [1, 2], y = [3, 4]
    const data = [{ x, y, line, marker: { color: line.color, size: 4 } }]
    const [result] = plotDataForTheme(data, "dark")
    const color = plotColorForTheme(line.color, "dark")
    expect(color).not.toBe(line.color)
    expect(result).toMatchObject({ line: { ...line, color }, marker: { color, size: 4 } })
    expect(result.x).toBe(x)
    expect(result.y).toBe(y)
    expect(data[0].line).toEqual(line)
    expect(plotColorForTheme(color, "dark")).toBe(color)
    expect(plotColorForTheme("#fb923c", "dark")).toBe("#fb923c")
    expect(plotColorForTheme("hsl(240, 58%, 40%)", "dark")).toMatch(/^#[\da-f]{6}$/)
    expect(plotColorForTheme("rgb(20, 20, 20)", "dark")).not.toBe("rgb(20, 20, 20)")
  })
})
