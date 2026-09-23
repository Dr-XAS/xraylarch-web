import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

async function width(locator: Locator) {
  return (await locator.boundingBox())!.width
}

test("orders and resizes the desktop Athena workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => localStorage.removeItem("athena.workspace.sizes.v1"))
  await page.goto("/", { waitUntil: "domcontentloaded" })

  const workspace = page.getByTestId("athena-workspace")
  const groups = page.locator("#athena-data-groups")
  const processing = page.locator("#athena-processing-parameters")
  const spectrum = page.locator("#athena-spectrum-viewer")
  const first = page.getByRole("separator", { name: "Resize data groups and processing parameters" })
  const second = page.getByRole("separator", { name: "Resize processing parameters and spectrum viewer" })
  await expect(workspace).toBeVisible()
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  const children = await workspace.locator(":scope > *").evaluateAll(elements => elements.map(element => element.id || element.getAttribute("aria-label")))
  expect(children).toEqual([
    "athena-data-groups",
    "Resize data groups and processing parameters",
    "athena-processing-parameters",
    "Resize processing parameters and spectrum viewer",
    "athena-spectrum-viewer",
  ])

  const groupsBefore = await width(groups)
  const processingBefore = await width(processing)
  const spectrumBefore = await width(spectrum)
  const firstBox = (await first.boundingBox())!
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 220)
  await page.mouse.down()
  await page.mouse.move(firstBox.x + firstBox.width / 2 + 32, firstBox.y + 220)
  await page.mouse.up()
  expect(await width(groups)).toBeGreaterThan(groupsBefore + 30)
  expect(await width(processing)).toBeLessThan(processingBefore - 30)
  expect(Math.abs(await width(spectrum) - spectrumBefore)).toBeLessThan(2)

  const processingAfterFirst = await width(processing)
  const spectrumAfterFirst = await width(spectrum)
  const secondBox = (await second.boundingBox())!
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + 220)
  await page.mouse.down()
  await page.mouse.move(secondBox.x + secondBox.width / 2 + 40, secondBox.y + 220)
  await page.mouse.up()
  expect(await width(processing)).toBeGreaterThan(processingAfterFirst + 38)
  expect(await width(spectrum)).toBeLessThan(spectrumAfterFirst - 38)

  await second.press("ArrowLeft")
  await expect(second).toHaveAttribute("aria-valuenow", String(Math.round(await width(processing))))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test("stacks panes in reading order without splitters or overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const workspace = page.getByTestId("athena-workspace")
  await expect(workspace).toBeVisible()
  const splitters = page.locator(".ath-workspace-resizer")
  await expect(splitters).toHaveCount(2)
  await expect(splitters.first()).toBeHidden()
  expect(await workspace.locator(":scope > *:visible").evaluateAll(elements => elements.map(element => element.id))).toEqual([
    "athena-data-groups",
    "athena-processing-parameters",
    "athena-spectrum-viewer",
  ])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.getByRole("region", { name: "FEFF path viewer" }).getByRole("button", { name: "Open EXAFS fitting" }).click()
  const fittingTab = page.getByRole("tab", { name: "EXAFS fitting" })
  await expect(fittingTab).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => fittingTab.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return document.activeElement === element && bounds.top >= 0 && bounds.bottom <= window.innerHeight
  })).toBe(true)
})

test("selects and orders result viewers after loading copper examples", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const controls = page.getByRole("group", { name: "Choose viewers" })
  const stack = page.locator(".ath-viewer-stack")
  const defaultOrder = ["single", "multiple", "wavelet", "cif", "feff", "fit"]
  const viewerOrder = () => stack.locator(":scope > [data-viewer-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-viewer-id")))

  await expect(controls.getByRole("button", { name: "All viewers" })).toHaveAttribute("aria-pressed", "true")
  expect(await viewerOrder()).toEqual(defaultOrder)
  await controls.getByRole("button", { name: "Wavelet plotter" }).click()
  await expect(stack.locator('[data-viewer-id="wavelet"]')).toBeHidden()
  await controls.getByRole("button", { name: "All viewers" }).click()
  await expect(stack.locator('[data-viewer-id="wavelet"]')).toBeVisible()
  await page.getByRole("combobox", { name: "Sort viewers" }).selectOption("process")
  await expect(page.getByText(/Single and multiple spectra stay first; saved CIF attachment/)).toBeVisible()

  await page.getByRole("button", { name: "Load copper examples" }).click()
  await expect(page.getByRole("combobox", { name: "Sort viewers" })).toHaveValue("default")
  expect(await viewerOrder()).toEqual(defaultOrder)
  await expect(stack.locator('[data-viewer-id="single"]')).toBeVisible()
  await expect(stack.locator('[data-viewer-id="multiple"]')).toBeVisible()
  await expect(stack.locator('[data-viewer-id="fit"]')).toBeVisible()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting" }).click()
  await expect(page.getByRole("region", { name: "Artemis EXAFS fitting setup" })).toContainText("Cu₂O · room temperature")
  await page.getByRole("button", { name: "Cu₂O example" }).click()
  const feff = page.getByRole("region", { name: "FEFF path viewer" })
  await expect(feff.getByRole("group", { name: "FEFF path legend" }).getByRole("button", { name: /^Show feff/ })).toHaveCount(4)
  await expect(page.getByRole("region", { name: "CIF structure viewer" }).getByRole("img", { name: "Interactive 3D crystal structure of Cuprite" })).toBeVisible()
  await feff.getByText("Coordinates and scattering angles", { exact: true }).click()
  await expect(feff.getByRole("table")).toContainText("Cu")
  await page.locator("#athena-spectrum-viewer").screenshot({ path: info.outputPath("result-viewers.png") })
})

test("keeps current and marked spectra in independent viewer panels", async ({ page }, info) => {
  test.setTimeout(60000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loading = page.waitForResponse(response => response.url().endsWith("/command") &&
    response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const response = await loading
  expect(response.ok()).toBe(true)
  const project = await response.json() as AthenaProject
  const [first, second] = project.groups
  const single = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  const multiple = page.getByRole("region", { name: "Multiple spectra viewer", exact: true })
  const singlePlot = single.getByLabel("E-space spectrum plot", { exact: true })
  const multiplePlot = multiple.getByLabel("E-space spectrum plot", { exact: true })
  const names = (panel: Locator) => panel.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: { name: string }[] }).data.map(trace => trace.name))

  await expect(singlePlot.locator(".js-line").first()).toBeAttached()
  await expect(multiplePlot.locator(".js-line").first()).toBeAttached()
  await expect.poll(() => names(single)).toContain(first.label)
  await expect.poll(() => names(multiple)).toEqual(project.groups.map(group => group.label))
  await expect(page.getByRole("radio", { name: "Current spectrum", exact: true })).toHaveCount(0)
  await expect(single.getByRole("checkbox", { name: "Offset plot", exact: true })).toBeDisabled()
  await expect(multiple.getByRole("checkbox", { name: "Offset plot", exact: true })).toBeEnabled()

  const marking = page.waitForResponse(result => result.url().endsWith("/command") &&
    result.request().postDataJSON().action === "metadata")
  await page.getByLabel(`Mark ${first.label}`, { exact: true }).uncheck()
  expect((await marking).ok()).toBe(true)
  await expect.poll(() => names(multiple)).toEqual(project.groups.slice(1).map(group => group.label))
  await expect.poll(() => names(single)).toContain(first.label)
  await page.locator(".ath-group-select").filter({ hasText: second.label }).click()
  await expect.poll(() => names(single)).toContain(second.label)
  await expect.poll(() => names(multiple)).toEqual(project.groups.slice(1).map(group => group.label))

  const singleLegend = single.getByRole("checkbox", { name: "Show legend", exact: true })
  const multipleLegend = multiple.getByRole("checkbox", { name: "Show legend", exact: true })
  await expect(singleLegend).not.toBeChecked()
  await expect(multipleLegend).toBeChecked()
  await singleLegend.check()
  await multipleLegend.uncheck()
  await expect(singleLegend).toBeChecked()
  await expect.poll(() => single.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { layout: { showlegend: boolean } }).layout.showlegend)).toBe(true)
  await expect.poll(() => multiple.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { layout: { showlegend: boolean } }).layout.showlegend)).toBe(false)

  await single.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await expect(single.getByLabel("k-space spectrum plot", { exact: true })).toBeVisible()
  await expect(multiple.getByRole("tab", { name: "E Energy", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(multiplePlot).toBeVisible()
  await single.getByRole("button", { name: "Collapse Single spectrum viewer", exact: true }).click()
  await expect(single.getByLabel("k-space spectrum plot", { exact: true })).toBeHidden()
  await expect(multiplePlot).toBeVisible()
  await single.getByRole("button", { name: "Expand Single spectrum viewer", exact: true }).click()

  const chooser = page.getByRole("group", { name: "Choose viewers", exact: true })
  await chooser.getByRole("button", { name: "Single spectrum viewer", exact: true }).click()
  await expect(single).toBeHidden()
  await expect(multiplePlot).toBeVisible()
  await chooser.getByRole("button", { name: "Single spectrum viewer", exact: true }).click()
  await expect(single.getByRole("tab", { name: "k EXAFS", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(singleLegend).toBeChecked()
  await expect(multipleLegend).not.toBeChecked()
  const capturePanels = async (viewport: string) => {
    for (const [name, panel] of [["single", single], ["multiple", multiple]] as const) {
      await panel.scrollIntoViewIfNeeded()
      await panel.screenshot({ path: info.outputPath(`${name}-spectrum-viewer-${viewport}.png`) })
    }
    await page.getByRole("region", { name: "Results viewers", exact: true }).screenshot({
      path: info.outputPath(`spectrum-viewer-chooser-${viewport}.png`),
    })
  }
  await capturePanels("desktop")
  await page.setViewportSize({ width: 390, height: 844 })
  await single.scrollIntoViewIfNeeded()
  await expect(single.getByLabel("k-space spectrum plot", { exact: true })).toBeVisible()
  await expect(multiplePlot).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capturePanels("narrow")
})
