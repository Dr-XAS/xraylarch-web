import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"
import { plotlyColorscale } from "../../lib/athena-colormaps"
import type { PlotWeightResult } from "../../components/athena-plot-weight"
import type { ShortcutPlot } from "../../components/athena-special-plot"

test.use({ actionTimeout: 15000 })

async function importIron(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles(
    fileURLToPath(new URL("../../../examples/xafsdata/AthenaProjectFiles/Fe.prj", import.meta.url)),
  )
  const importing = page.waitForResponse(response => response.url().endsWith("/restore-upload"))
  await page.getByRole("button", { name: "Import all groups", exact: true }).click()
  const response = await importing
  expect(response.ok()).toBe(true)
  const project = await response.json() as AthenaProject
  const spectrum = project.groups.find(group => !group.processing_error && group.result?.effective.exafs && group.result.arrays.chi.length)
  expect(spectrum).toBeDefined()
  await page.locator(`.ath-group[data-group-id="${spectrum!.id}"] .ath-group-select`).click()
  return project
}

async function grid(figure: Locator) {
  return figure.locator(".js-plotly-plot").evaluate(element => {
    const trace = (element as HTMLElement & { data: { x: number[]; y: number[]; z: number[][] }[] }).data[0]
    return { k: trace.x, r: trace.y, magnitude: trace.z }
  })
}

async function trace(figure: Locator) {
  return figure.locator(".js-plotly-plot").evaluate(element => {
    const value = (element as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: value.x, y: value.y }
  })
}

async function expectCompanions(panel: Locator, response: PlotWeightResult, min: number, max: number) {
  const indices = response.arrays.k.flatMap((k, index) => k >= min && k <= max ? [index] : [])
  await expect.poll(() => trace(panel.getByLabel("Windowed χ(k)", { exact: true }))).toEqual({
    x: indices.map(index => response.arrays.k[index]),
    y: indices.map(index => response.arrays.weighted_chi[index] * response.arrays.kwin[index]),
  })
  await expect.poll(() => trace(panel.getByLabel("Fourier magnitude |χ(R)|", { exact: true }))).toEqual({
    x: response.arrays.r, y: response.arrays.chir_mag,
  })
}

test("real wavelet plots retain their grid through range drags, independent spectrum palettes, surface rendering, resize and PNG export", async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize({ width: 1500, height: 1100 })
  const errors: string[] = []
  const waveletRequests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (request.url().endsWith("/wavelet")) waveletRequests.push(request.url()) })
  const project = await importIron(page)
  const panel = page.getByRole("region", { name: "Wavelet plotter", exact: true })
  const heatmap = panel.getByLabel("2D wavelet heatmap", { exact: true })
  await expect(heatmap.locator(".heatmaplayer image")).toBeVisible()
  await expect(panel.getByLabel("Fourier magnitude |χ(R)|", { exact: true }).locator(".js-line")).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { Plotly?: { version: string } }).Plotly?.version)).toBe("4.1.1")
  await expect(page.locator('.modebar-btn[data-title="Share chart..."]')).toHaveCount(0)
  const retained = await grid(heatmap)
  expect(retained.k.length).toBeGreaterThan(10)
  expect(retained.r.length).toBeGreaterThan(10)
  expect(retained.magnitude).toHaveLength(retained.r.length)
  expect(retained.magnitude.every(row => row.length === retained.k.length)).toBe(true)
  const waveletRequestCount = waveletRequests.length

  const minimum = panel.getByRole("slider", { name: "k minimum", exact: true })
  const maximum = panel.getByRole("slider", { name: "k maximum", exact: true })
  const initialMin = Number(await minimum.inputValue())
  const sliding = page.waitForResponse(response => response.url().endsWith("/plot-transform") &&
    response.request().postDataJSON().kmin > initialMin)
  await minimum.press("ArrowRight")
  const slid = await sliding
  expect(slid.ok()).toBe(true)
  const slidMin = Number(await minimum.inputValue()), slidMax = Number(await maximum.inputValue())
  expect(slidMin).toBeGreaterThan(initialMin)
  await expectCompanions(panel, await slid.json(), slidMin, slidMax)
  expect(await grid(heatmap)).toEqual(retained)

  // Drag the actual Plotly shape hit target, exercising plotly_relayout through the React wrapper.
  await heatmap.scrollIntoViewIfNeeded()
  const boundary = heatmap.locator('.shapelayer [drag-helper="true"][data-index="0"] path').first()
  await expect(boundary).toBeAttached()
  const box = (await boundary.boundingBox())!
  const dragging = page.waitForResponse(response => response.url().endsWith("/plot-transform") &&
    response.request().postDataJSON().kmin > slidMin + 0.1)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  const dragged = await dragging
  expect(dragged.ok()).toBe(true)
  const draggedMin = Number(await minimum.inputValue()), draggedMax = Number(await maximum.inputValue())
  await expectCompanions(panel, await dragged.json(), draggedMin, draggedMax)
  expect(await grid(heatmap)).toEqual(retained)

  const spectrumPlot = page.getByLabel("E-space spectrum plot", { exact: true }).locator(".js-plotly-plot")
  const spectrumColors = () => spectrumPlot.evaluate(element =>
    (element as HTMLElement & { data: { line: { color: string } }[] }).data.map(trace => trace.line.color),
  )
  const originalSpectrumColors = await spectrumColors()
  await page.getByLabel("Color legend", { exact: true }).selectOption("viridis")
  await expect.poll(spectrumColors).not.toEqual(originalSpectrumColors)
  expect((await spectrumColors())[0]).toBe("#440154")
  await expect.poll(() => heatmap.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { colorscale: [number, string][] }[] }).data[0].colorscale,
  )).toEqual(plotlyColorscale("magma"))
  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click()
  await expect.poll(() => heatmap.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { layout: { paper_bgcolor: string } }).layout.paper_bgcolor,
  )).toBe("#17171c")
  expect(await grid(heatmap)).toEqual(retained)
  await page.getByRole("button", { name: "Switch to light mode", exact: true }).click()

  await panel.getByRole("button", { name: "3D surface", exact: true }).click()
  const surface = panel.getByLabel("3D wavelet surface", { exact: true })
  await expect(surface.locator(".gl-container canvas").first()).toBeVisible()
  await expect.poll(() => surface.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { _fullData: { type: string }[] })._fullData[0].type,
  )).toBe("surface")
  expect(await grid(surface)).toEqual(retained)
  await expect.poll(() => surface.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { colorscale: [number, string][] }[] }).data[0].colorscale,
  )).toEqual(plotlyColorscale("magma"))
  const grip = panel.getByRole("separator", { name: "Resize wavelet plot height", exact: true })
  const previousHeight = Number(await grip.getAttribute("aria-valuenow"))
  await grip.press("Shift+ArrowDown")
  await expect.poll(() => surface.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { _fullLayout: { height: number } })._fullLayout.height,
  )).toBe(previousHeight + 48)
  await surface.hover()
  const downloading = page.waitForEvent("download")
  await surface.locator('.modebar-btn[data-title="Download plot as a PNG"]').click()
  const downloaded = await downloading
  expect(downloaded.suggestedFilename()).toMatch(/^wavelet-k[\d.]+-3d\.png$/)
  const pngPath = info.outputPath("wavelet-surface-export.png")
  await downloaded.saveAs(pngPath)
  const png = readFileSync(pngPath)
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  expect(png.length).toBeGreaterThan(10000)
  expect(png.readUInt32BE(16)).toBeGreaterThan(500)
  expect(png.readUInt32BE(20)).toBe((previousHeight + 48) * 2)
  await surface.screenshot({ path: info.outputPath("wavelet-surface.png") })

  await panel.getByRole("button", { name: "2D heatmap", exact: true }).click()
  await expect(heatmap.locator(".heatmaplayer image")).toBeVisible()
  expect(Number(await minimum.inputValue())).toBeCloseTo(draggedMin, 8)
  expect(Number(await maximum.inputValue())).toBeCloseTo(draggedMax, 8)
  expect(waveletRequests).toHaveLength(waveletRequestCount)
  expect(await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).toEqual(project)
  expect(errors).toEqual([])
})

test("shortcut SVG export uses the live renderer's curves and omits hidden legend entries", async ({ page }, info) => {
  test.setTimeout(150000)
  await page.setViewportSize({ width: 1500, height: 1100 })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const project = await importIron(page)
  await page.getByRole("button", { name: "Plot shortcuts…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Athena plot shortcuts", exact: true })
  await dialog.getByLabel("Plot shortcut", { exact: true }).selectOption("normderiv")
  const replot = dialog.getByRole("button", { name: "Replot shortcut", exact: true })
  await expect(replot).toBeEnabled()
  const calculating = page.waitForResponse(response => response.url().endsWith("/plots/shortcut") &&
    response.request().postDataJSON().kind === "normderiv")
  await replot.click()
  const calculated = await calculating
  expect(calculated.ok()).toBe(true)
  const value = await calculated.json() as ShortcutPlot
  expect(value.result.curves).toHaveLength(2)
  const figure = dialog.getByLabel("Athena shortcut figure", { exact: true })
  await expect(figure.locator(".js-line")).toHaveCount(2)
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await expect(dialog.locator('.modebar-btn[data-title="Share chart..."]')).toHaveCount(0)

  async function exportSvg(filename: string, names: string[]) {
    const downloading = page.waitForEvent("download")
    await dialog.getByRole("button", { name: "Download shortcut SVG", exact: true }).click()
    const downloaded = await downloading
    expect(downloaded.suggestedFilename()).toBe("athena-normderiv.svg")
    const target = info.outputPath(filename)
    await downloaded.saveAs(target)
    const xml = readFileSync(target, "utf8")
    const parsed = await page.evaluate(content => {
      const svg = new DOMParser().parseFromString(content, "image/svg+xml")
      return {
        errors: svg.querySelectorAll("parsererror").length, root: svg.documentElement.tagName,
        width: svg.documentElement.getAttribute("width"), height: svg.documentElement.getAttribute("height"),
        curves: svg.querySelectorAll(".scatterlayer .js-line").length,
        legend: [...svg.querySelectorAll(".legendtext")].map(label => label.textContent),
      }
    }, xml)
    expect(parsed).toEqual({ errors: 0, root: "svg", width: "1400", height: "700", curves: names.length, legend: names })
    expect(await page.evaluate(() => (window as unknown as { Plotly?: { version: string } }).Plotly?.version)).toBe("4.1.1")
    await expect(dialog.getByRole("alert")).toHaveCount(0)
  }

  await exportSvg("shortcut-all-curves.svg", value.result.curves.map(curve => curve.name))
  const hiddenName = value.result.curves[1].name
  await dialog.getByRole("list", { name: "Shortcut curve legend" }).getByRole("button", { name: hiddenName, exact: true }).click()
  await expect(figure.locator(".js-line")).toHaveCount(1)
  await exportSvg("shortcut-visible-curve.svg", [value.result.curves[0].name])
  await dialog.screenshot({ path: info.outputPath("shortcut-visible-curve.png") })
  expect(await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json()).toEqual(project)
  expect(errors).toEqual([])
})
