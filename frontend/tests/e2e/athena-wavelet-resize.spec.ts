import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const waveletHeightKey = "athena.wavelet.height.v1"
const spectrumHeightKey = "athena.plot.single.height.v1"

async function height(locator: Locator) {
  return Math.round((await locator.boundingBox())!.height)
}

async function renderedHeight(viewer: Locator) {
  return viewer.locator(".js-plotly-plot").evaluate(element => {
    const plot = element as HTMLElement & { _fullLayout?: { height: number } }
    const svg = element.querySelector<SVGSVGElement>(".main-svg")
    return {
      layout: plot._fullLayout?.height,
      svg: svg ? Math.round(svg.getBoundingClientRect().height) : null,
    }
  })
}

async function expectPlotHeight(viewer: Locator, expected: number) {
  await expect.poll(() => height(viewer)).toBe(expected)
  await expect.poll(() => renderedHeight(viewer)).toEqual({ layout: expected, svg: expected })
}

type HeatmapRanges = { k: number[]; r: number[] }

async function heatmapGeometry(viewer: Locator) {
  return viewer.locator(".js-plotly-plot").evaluate(element => {
    type Axis = { _length: number; _offset: number; range: number[] }
    const plot = element as HTMLElement & {
      data: { x: number[] }[]
      _fullLayout: { xaxis: Axis; yaxis: Axis }
    }
    const { xaxis, yaxis } = plot._fullLayout
    const k = plot.data[0].x
    const box = plot.getBoundingClientRect()
    return {
      width: xaxis._length,
      height: yaxis._length,
      ranges: { k: xaxis.range, r: yaxis.range },
      kDomain: [k[0], k[k.length - 1]],
      xLeft: box.left + xaxis._offset,
      xRight: box.left + xaxis._offset + xaxis._length,
      frame: { left: box.left, right: box.right, top: box.top },
    }
  })
}

async function sliderGeometry(viewer: Locator) {
  return viewer.page().getByRole("slider", { name: "k minimum", exact: true }).evaluate(element => {
    const minimum = element as HTMLInputElement
    const fieldset = minimum.closest("fieldset")!
    const maximum = fieldset.querySelector<HTMLInputElement>('input[aria-label="k maximum"]')!
    const track = minimum.parentElement!.parentElement!
    const rail = track.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]')!.getBoundingClientRect()
    const range = fieldset.getBoundingClientRect()
    return {
      rail: { left: rail.left, right: rail.right },
      fieldset: { left: range.left, right: range.right, bottom: range.bottom },
      handles: [minimum, maximum].map(input => {
        const marker = input.nextElementSibling!.getBoundingClientRect()
        return { value: input.valueAsNumber, center: marker.left + marker.width / 2 }
      }),
    }
  })
}

async function expectSliderAligned(viewer: Locator) {
  await expect.poll(async () => {
    const plot = await heatmapGeometry(viewer)
    const slider = await sliderGeometry(viewer)
    const projectK = (k: number) => plot.xLeft + (k - plot.ranges.k[0]) / (plot.ranges.k[1] - plot.ranges.k[0]) * plot.width
    return Math.max(
      Math.abs(slider.rail.left - plot.xLeft),
      Math.abs(slider.rail.right - plot.xRight),
      ...slider.handles.map(handle => Math.abs(handle.center - projectK(handle.value))),
    )
  }, { message: "Slider rail and both handles must align with the heatmap k axis within one pixel" }).toBeLessThanOrEqual(1)
  const plot = await heatmapGeometry(viewer)
  const slider = await sliderGeometry(viewer)
  expect(slider.fieldset.left).toBeGreaterThanOrEqual(plot.frame.left - 1)
  expect(slider.fieldset.right).toBeLessThanOrEqual(plot.frame.right + 1)
  expect(slider.fieldset.bottom).toBeLessThanOrEqual(plot.frame.top)
}

async function expectSquareHeatmapHeight(viewer: Locator, expected: number, ranges: HeatmapRanges) {
  await expectPlotHeight(viewer, expected)
  await expect.poll(async () => {
    const geometry = await heatmapGeometry(viewer)
    return {
      square: geometry.width > 0 && geometry.height > 0 && Math.abs(geometry.width - geometry.height) <= 1,
      ranges: geometry.ranges,
    }
  }).toEqual({ square: true, ranges })
  await expectSliderAligned(viewer)
}

async function camera(viewer: Locator) {
  return viewer.locator(".js-plotly-plot").evaluate(element => {
    const plot = element as HTMLElement & { _fullLayout?: { scene?: { camera?: unknown } } }
    return JSON.stringify(plot._fullLayout?.scene?.camera)
  })
}

async function expectNoOverflow(page: Page, panel: Locator) {
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
}

async function drag(page: Page, grip: Locator, movement: number) {
  await grip.evaluate(element => element.scrollIntoView({ block: "center" }))
  const box = (await grip.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + movement, { steps: 6 })
  await page.mouse.up()
}

test("combined wavelet views share data, preserve camera and keep the heatmap square when resizing", async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.addInitScript(() => {
    if (sessionStorage.getItem("athena-wavelet-resize-initialized")) return
    localStorage.removeItem("athena.wavelet.height.v1")
    localStorage.setItem("athena.plot.single.height.v1", "640")
    sessionStorage.setItem("athena-wavelet-resize-initialized", "true")
  })
  const errors: string[] = []
  const waveletRequests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    if (request.url().endsWith("/wavelet")) waveletRequests.push(request.url())
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles(fileURLToPath(new URL("../../../examples/xafsdata/AthenaProjectFiles/Fe.prj", import.meta.url)))
  const importing = page.waitForResponse(response => response.url().endsWith("/restore-upload"))
  await page.getByRole("button", { name: "Import all groups", exact: true }).click()
  const imported = await importing
  expect(imported.ok()).toBe(true)
  const project = await imported.json() as AthenaProject
  const spectrum = project.groups.find(group => !group.processing_error && group.result?.arrays.k.length && group.result.arrays.chi.length)
  expect(spectrum).toBeDefined()
  await page.locator(".ath-group-select").filter({ has: page.locator("strong", { hasText: spectrum!.label }) }).first().click()

  const panel = page.getByRole("region", { name: "Wavelet plotter", exact: true })
  const heatmap = panel.getByLabel("2D wavelet heatmap", { exact: true })
  const surface = panel.getByLabel("3D wavelet surface", { exact: true })
  const combined = panel.getByRole("button", { name: "2D + 3D", exact: true })
  const grip = panel.getByRole("separator", { name: "Resize wavelet plot height", exact: true })
  const spectrumGrip = page.getByRole("separator", { name: "Resize single spectrum plot height", exact: true })
  const spectrumPlot = page.locator(".ath-plot-card").filter({ has: spectrumGrip }).locator(".ath-plot")
  await expect(combined).toHaveAttribute("aria-pressed", "true")
  await expectPlotHeight(heatmap, 430)
  const ranges = { k: (await heatmapGeometry(heatmap)).kDomain, r: [0, 6] }
  await expectSquareHeatmapHeight(heatmap, 430, ranges)
  await expectPlotHeight(surface, 430)
  const heatmapBox = (await heatmap.boundingBox())!
  const surfaceBox = (await surface.boundingBox())!
  expect(surfaceBox.x).toBeGreaterThanOrEqual(heatmapBox.x + heatmapBox.width)
  expect(Math.abs(surfaceBox.y - heatmapBox.y)).toBeLessThanOrEqual(1)
  await expectNoOverflow(page, panel)
  const initialWaveletRequests = waveletRequests.length
  expect(initialWaveletRequests).toBeGreaterThan(0)
  await expect(grip).toHaveAttribute("aria-controls", "athena-wavelet-viewer")
  await expect(grip).toHaveAttribute("aria-orientation", "horizontal")
  expect(await height(spectrumPlot)).toBe(640)

  await drag(page, grip, 110)
  await expectSquareHeatmapHeight(heatmap, 540, ranges)
  await expectPlotHeight(surface, 540)
  await expect(grip).toHaveAttribute("aria-valuenow", "540")
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBe("540")
  expect(await height(spectrumPlot)).toBe(640)
  expect(await page.evaluate(key => localStorage.getItem(key), spectrumHeightKey)).toBe("640")
  await panel.screenshot({ path: info.outputPath("wavelet-desktop-combined.png") })

  const canvas = surface.locator(".gl-container canvas").first()
  await expect(canvas).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  const beforeRotation = await camera(surface)
  const surfaceCanvasBox = (await canvas.boundingBox())!
  const orbitX = surfaceCanvasBox.x + surfaceCanvasBox.width / 2
  const orbitY = surfaceCanvasBox.y + surfaceCanvasBox.height / 2
  await page.mouse.move(orbitX, orbitY)
  await page.mouse.down()
  await page.mouse.move(orbitX + 75, orbitY + 25, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => camera(surface)).not.toBe(beforeRotation)
  const rotatedCamera = await camera(surface)

  const preview = page.waitForResponse(response => response.url().endsWith("/plot-transform") && response.request().method() === "POST")
  await panel.getByRole("slider", { name: "k minimum", exact: true }).press("ArrowRight")
  expect((await preview).ok()).toBe(true)
  await expect(panel.getByLabel("Selected k-range Fourier preview", { exact: true })).toHaveAttribute("aria-busy", "false")
  expect(await camera(surface)).toBe(rotatedCamera)
  await expectSliderAligned(heatmap)
  const maximumPreview = page.waitForResponse(response => response.url().endsWith("/plot-transform") && response.request().method() === "POST")
  await panel.getByRole("slider", { name: "k maximum", exact: true }).press("ArrowLeft")
  expect((await maximumPreview).ok()).toBe(true)
  await expect(panel.getByLabel("Selected k-range Fourier preview", { exact: true })).toHaveAttribute("aria-busy", "false")
  await expectSliderAligned(heatmap)
  expect(await camera(surface)).toBe(rotatedCamera)
  await panel.getByRole("combobox", { name: "Wavelet color legend", exact: true }).click()
  await page.getByRole("option", { name: "Viridis · purple–green–yellow", exact: true }).click()
  await panel.getByRole("checkbox", { name: "Reverse", exact: true }).check()
  await expect(panel.getByRole("checkbox", { name: "Reverse", exact: true })).toBeChecked()
  expect(waveletRequests).toHaveLength(initialWaveletRequests)

  await panel.getByRole("button", { name: "3D surface", exact: true }).click()
  await expect(heatmap).toHaveCount(0)
  await expectPlotHeight(surface, 540)
  await expect(canvas).toBeVisible()
  const canvasBefore = await height(canvas)
  await drag(page, grip, -80)
  await expectPlotHeight(surface, 460)
  await expect.poll(() => height(canvas)).toBe(canvasBefore - 80)
  await surface.screenshot({ path: info.outputPath("wavelet-resized-3d.png") })
  await panel.getByRole("button", { name: "2D heatmap", exact: true }).click()
  await expect(surface).toHaveCount(0)
  await expectSquareHeatmapHeight(heatmap, 460, ranges)
  await panel.screenshot({ path: info.outputPath("wavelet-desktop-2d-square.png") })
  await combined.click()
  await expectSquareHeatmapHeight(heatmap, 460, ranges)
  await expectPlotHeight(surface, 460)
  expect(waveletRequests).toHaveLength(initialWaveletRequests)

  await page.reload()
  await expectSquareHeatmapHeight(heatmap, 460, ranges)
  await expectPlotHeight(surface, 460)
  expect(await height(spectrumPlot)).toBe(640)
  await grip.dblclick()
  await expectSquareHeatmapHeight(heatmap, 430, ranges)
  await expectPlotHeight(surface, 430)
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBeNull()
  expect(await height(spectrumPlot)).toBe(640)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectSquareHeatmapHeight(heatmap, 350, ranges)
  await expectPlotHeight(surface, 350)
  const mobileHeatmapBox = (await heatmap.boundingBox())!
  const mobileSurfaceBox = (await surface.boundingBox())!
  expect(mobileSurfaceBox.y).toBeGreaterThanOrEqual(mobileHeatmapBox.y + mobileHeatmapBox.height)
  expect(Math.abs(mobileSurfaceBox.x - mobileHeatmapBox.x)).toBeLessThanOrEqual(1)
  await grip.press("ArrowDown")
  await expectSquareHeatmapHeight(heatmap, 366, ranges)
  await expectPlotHeight(surface, 366)
  await page.setViewportSize({ width: 1500, height: 1100 })
  await expectSquareHeatmapHeight(heatmap, 366, ranges)
  await expectPlotHeight(surface, 366)
  await page.setViewportSize({ width: 390, height: 844 })
  await grip.press("Enter")
  await expectSquareHeatmapHeight(heatmap, 350, ranges)
  await expectPlotHeight(surface, 350)
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBeNull()
  expect(await height(spectrumPlot)).toBe(640)
  await expectNoOverflow(page, panel)
  await panel.screenshot({ path: info.outputPath("wavelet-mobile-combined.png") })
  const mobileWaveletRequests = waveletRequests.length
  await panel.getByRole("button", { name: "2D heatmap", exact: true }).click()
  await expectSquareHeatmapHeight(heatmap, 350, ranges)
  await drag(page, grip, -40)
  await expectSquareHeatmapHeight(heatmap, 310, ranges)
  await page.setViewportSize({ width: 1024, height: 900 })
  await expectSquareHeatmapHeight(heatmap, 310, ranges)
  await expectNoOverflow(page, panel)
  await combined.click()
  await expectSquareHeatmapHeight(heatmap, 310, ranges)
  await expectPlotHeight(surface, 310)
  expect(waveletRequests).toHaveLength(mobileWaveletRequests)
  expect(errors).toEqual([])
})
