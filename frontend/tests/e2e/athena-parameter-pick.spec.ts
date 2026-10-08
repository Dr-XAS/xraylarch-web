import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const fixture = fileURLToPath(new URL("../../../backend/tests/fixtures/xdi-official-cu_metal_rt.xdi", import.meta.url))

test.use({ actionTimeout: 15_000 })

async function loadCopper(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles(fixture)
  const dialog = page.getByRole("dialog", { name: "Import spectra", exact: true })
  await dialog.getByRole("checkbox", { name: "Numerator i0", exact: true }).uncheck()
  await dialog.getByRole("checkbox", { name: "Numerator mutrans", exact: true }).check()
  await dialog.getByRole("checkbox", { name: "Denominator itrans", exact: true }).uncheck()
  await dialog.getByRole("checkbox", { name: "Natural log", exact: true }).uncheck()
  const imported = page.waitForResponse(response => response.url().endsWith("/import"))
  await dialog.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const response = await imported
  expect(response.ok()).toBe(true)
  await expect(dialog).toHaveCount(0)
  return await response.json() as AthenaProject
}

// Use the rendered axes only to locate a measured sample, then send a real mouse
// click through Plotly's drag layer. Calling plotly.emit would miss this regression.
async function clickSample(page: Page, plot: Locator, target: number) {
  await plot.scrollIntoViewIfNeeded()
  const graph = plot.locator(".js-plotly-plot")
  const point = await graph.evaluate((element, target) => {
    type Axis = { _offset: number; l2p: (value: number) => number }
    const graph = element as HTMLElement & {
      data: { x: number[]; y: number[] }[]
      _fullLayout: { xaxis: Axis; yaxis: Axis }
    }
    const trace = graph.data[0]
    const index = trace.x.reduce((best, value, index) => Math.abs(value - target) < Math.abs(trace.x[best] - target) ? index : best, 0)
    const bounds = graph.getBoundingClientRect()
    const { xaxis, yaxis } = graph._fullLayout
    return {
      value: trace.x[index],
      x: bounds.left + xaxis._offset + xaxis.l2p(trace.x[index]),
      y: bounds.top + yaxis._offset + yaxis.l2p(trace.y[index]),
    }
  }, target)
  await page.mouse.move(point.x, point.y)
  await expect.poll(() => graph.evaluate(element =>
    (element as HTMLElement & { _hoverdata?: { x: number }[] })._hoverdata?.[0]?.x,
  )).toBe(point.value)
  await page.mouse.click(point.x, point.y)
  return point.value
}

function parameterResponse(page: Page) {
  return page.waitForResponse(response => response.url().endsWith("/command") &&
    response.request().postDataJSON().action === "parameters")
}

test("plot picks update E₀ and relative limits after arming, switching targets and cancelling", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1500, height: 1040 })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const initial = await loadCopper(page)
  const group = initial.groups[0]
  const viewer = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  const plot = viewer.getByLabel("E-space spectrum plot", { exact: true })
  await expect(plot.locator(".js-line").first()).toBeVisible()
  const graph = plot.locator(".js-plotly-plot")
  const e0 = page.getByRole("spinbutton", { name: /^E₀/ })
  const oldE0 = Number(await e0.inputValue())
  const originalFigure = await graph.evaluateHandle(element => {
    const graph = element as HTMLElement & { data: unknown; layout: unknown }
    return { data: graph.data, layout: graph.layout }
  })

  const pickE0 = page.getByRole("button", { name: "Pick E₀ from plot", exact: true })
  await pickE0.click()
  await expect(pickE0).toHaveAttribute("aria-pressed", "true")
  expect(await graph.evaluate((element, original) => {
    const graph = element as HTMLElement & { data: unknown; layout: unknown }
    return graph.data === original.data && graph.layout === original.layout
  }, originalFigure)).toBe(true)
  const firstUpdate = parameterResponse(page)
  const pickedE0 = await clickSample(page, plot, oldE0 + 1)
  await expect(e0).toHaveValue(String(pickedE0))
  await expect(pickE0).toHaveAttribute("aria-pressed", "false")
  const firstResponse = await firstUpdate
  expect(firstResponse.ok()).toBe(true)
  const first = await firstResponse.json() as AthenaProject
  expect(first.groups[0].parameters.e0).toBe(pickedE0)
  expect(first.groups[0].processing_error).toBeNull()
  expect(pickedE0).not.toBe(oldE0)

  // Changing only the pick target must update the attached callback even though
  // the plotted spectrum and layout have not changed.
  const preStart = page.getByRole("button", { name: "Pick Pre-edge start from plot", exact: true })
  const postStart = page.getByRole("button", { name: "Pick Post-edge start from plot", exact: true })
  await preStart.click()
  await expect(preStart).toHaveAttribute("aria-pressed", "true")
  await postStart.click()
  await expect(preStart).toHaveAttribute("aria-pressed", "false")
  await expect(postStart).toHaveAttribute("aria-pressed", "true")
  const secondUpdate = parameterResponse(page)
  const pickedPost = await clickSample(page, plot, pickedE0 + 70)
  const relativePost = pickedPost - pickedE0
  await expect(page.getByRole("spinbutton", { name: /^Post-edge start/ })).toHaveValue(String(relativePost))
  const secondResponse = await secondUpdate
  expect(secondResponse.ok()).toBe(true)
  const second = await secondResponse.json() as AthenaProject
  expect(second.groups[0].parameters).toMatchObject({ e0: pickedE0, pre1: group.parameters.pre1, norm1: relativePost })
  expect(second.groups[0].processing_error).toBeNull()

  const preField = page.getByRole("spinbutton", { name: /^Pre-edge start/ })
  const preBeforeCancel = await preField.inputValue()
  await preStart.click()
  await page.keyboard.press("Escape")
  await expect(preStart).toHaveAttribute("aria-pressed", "false")
  await clickSample(page, plot, pickedE0 - 100)
  await expect(preField).toHaveValue(preBeforeCancel)
  await expect(page.getByRole("button", { name: "Discard parameter changes", exact: true })).toHaveCount(0)
  const savedResponse = await page.request.get(`/api/backend/api/athena/projects/${initial.id}?view=parameters`)
  expect(savedResponse.ok()).toBe(true)
  expect((await savedResponse.json()).version).toBe(second.version)
  expect(errors).toEqual([])
  await originalFigure.dispose()
})
