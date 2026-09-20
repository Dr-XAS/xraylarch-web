import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const waveletHeightKey = "athena.wavelet.height.v1"
const spectrumHeightKey = "athena.plot.height.v1"

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

test("wavelet plots follow drag resizing, retain their size across modes and restore responsive defaults", async ({ page }, info) => {
  test.setTimeout(150000)
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.addInitScript(() => {
    if (sessionStorage.getItem("athena-wavelet-resize-initialized")) return
    localStorage.removeItem("athena.wavelet.height.v1")
    localStorage.setItem("athena.plot.height.v1", "640")
    sessionStorage.setItem("athena-wavelet-resize-initialized", "true")
  })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
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
  const viewer = page.locator("#athena-wavelet-viewer [data-wavelet-main-plot]")
  const grip = panel.getByRole("separator", { name: "Resize wavelet plot height", exact: true })
  const spectrumGrip = page.getByRole("separator", { name: "Resize spectrum plot height", exact: true })
  const spectrumPlot = page.locator(".ath-plot-card").filter({ has: spectrumGrip }).locator(".ath-plot")
  await expectPlotHeight(viewer, 430)
  await expect(grip).toHaveAttribute("aria-controls", "athena-wavelet-viewer")
  await expect(grip).toHaveAttribute("aria-orientation", "horizontal")
  expect(await height(spectrumPlot)).toBe(640)

  await drag(page, grip, 110)
  await expectPlotHeight(viewer, 540)
  await expect(grip).toHaveAttribute("aria-valuenow", "540")
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBe("540")
  expect(await height(spectrumPlot)).toBe(640)
  expect(await page.evaluate(key => localStorage.getItem(key), spectrumHeightKey)).toBe("640")
  await viewer.screenshot({ path: info.outputPath("wavelet-resized-2d.png") })

  await panel.getByRole("button", { name: "3D surface", exact: true }).click()
  await expect(panel.getByLabel("3D wavelet surface", { exact: true })).toBeVisible()
  await expectPlotHeight(viewer, 540)
  const canvas = viewer.locator(".gl-container canvas").first()
  await expect(canvas).toBeVisible()
  const canvasBefore = await height(canvas)
  await drag(page, grip, -80)
  await expectPlotHeight(viewer, 460)
  await expect.poll(() => height(canvas)).toBe(canvasBefore - 80)
  await viewer.screenshot({ path: info.outputPath("wavelet-resized-3d.png") })
  await panel.getByRole("button", { name: "2D heatmap", exact: true }).click()
  await expectPlotHeight(viewer, 460)

  await page.reload()
  await expectPlotHeight(viewer, 460)
  expect(await height(spectrumPlot)).toBe(640)
  await grip.dblclick()
  await expectPlotHeight(viewer, 430)
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBeNull()
  expect(await height(spectrumPlot)).toBe(640)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectPlotHeight(viewer, 350)
  await grip.press("ArrowDown")
  await expectPlotHeight(viewer, 366)
  await page.setViewportSize({ width: 1500, height: 1100 })
  await expectPlotHeight(viewer, 366)
  await page.setViewportSize({ width: 390, height: 844 })
  await grip.press("Enter")
  await expectPlotHeight(viewer, 350)
  expect(await page.evaluate(key => localStorage.getItem(key), waveletHeightKey)).toBeNull()
  expect(await height(spectrumPlot)).toBe(640)
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  await viewer.scrollIntoViewIfNeeded()
  await viewer.screenshot({ path: info.outputPath("wavelet-mobile-default.png") })
  expect(errors).toEqual([])
})
