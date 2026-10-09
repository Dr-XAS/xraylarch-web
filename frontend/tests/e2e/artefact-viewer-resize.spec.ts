import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"
import type { ArtemisFeffJob, ArtemisFeffRequest } from "../../lib/artemis-structures"
import type { SimulationRequest } from "../../lib/artemis-simulation"
import { simulationFixture, simulationJob } from "../fixtures/artemis-simulation"

const heights = {
  cif: "artemis.cif.height.v1",
  structure: "artemis.feff.structure.height.v1",
  contributions: "artemis.feff.contributions.height.v1",
  simulation: "artemis.simulation.height.v1",
  spectrum: "athena.plot.single.height.v1",
}

async function height(element: Locator) {
  return Math.round((await element.boundingBox())!.height)
}

async function storedHeights(page: Page) {
  return page.evaluate(keys => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, localStorage.getItem(key)])), heights)
}

async function drag(page: Page, grip: Locator, movement: number) {
  await grip.evaluate(element => element.scrollIntoView({ block: "center" }))
  const bounds = (await grip.boundingBox())!
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + movement, { steps: 8 })
  await page.mouse.up()
}

async function expectSceneHeight(image: Locator, expected: number) {
  await expect.poll(() => height(image)).toBe(expected)
  await expect.poll(() => height(image.locator("canvas"))).toBe(expected)
}

async function camera(image: Locator) {
  return image.locator("canvas").evaluate(element => {
    const viewer = (element as HTMLCanvasElement & { _3dmol_viewer?: { getView: () => number[] } })._3dmol_viewer
    return viewer?.getView() ?? []
  })
}

async function rotate(page: Page, image: Locator) {
  await image.evaluate(element => element.scrollIntoView({ block: "center" }))
  const previous = await camera(image)
  expect(previous.length).toBeGreaterThan(0)
  const bounds = (await image.locator("canvas").boundingBox())!
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 45, y + 25, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => camera(image)).not.toEqual(previous)
  return camera(image)
}

async function expectPlotHeight(plot: Locator, expected: number) {
  await expect.poll(() => height(plot)).toBe(expected)
  await expect.poll(() => plot.evaluate(element => {
    const instance = element as HTMLElement & { _fullLayout?: { height: number } }
    return instance._fullLayout?.height
  })).toBe(expected)
}

function scientificRequests(page: Page) {
  const requests: string[] = []
  let watching = false
  page.on("request", request => {
    if (watching && /\/api\/(?:athena|artemis)\/|\/command(?:\?|$)|\/wavelet(?:\?|$)|\/plot-transform(?:\?|$)/.test(request.url())) {
      requests.push(`${request.method()} ${request.url()}`)
    }
  })
  return { requests, watch: (enabled: boolean) => { watching = enabled } }
}

async function loadCopper(page: Page) {
  await page.goto("/")
  const loading = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const response = await loading
  expect(response.ok()).toBe(true)
  const project = await response.json() as AthenaProject
  await expect(page.locator(".ath-group.selected .ath-group-select")).toContainText("Cu₂O · room temperature")
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")
  return project
}

test("CIF and FEFF plots drag independently, preserve cameras, and restore their saved heights", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.addInitScript(keys => {
    if (sessionStorage.getItem("artefact-resize-initialized")) return
    Object.values(keys).forEach(key => localStorage.removeItem(key))
    localStorage.setItem(keys.spectrum, "620")
    sessionStorage.setItem("artefact-resize-initialized", "true")
  }, heights)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const science = scientificRequests(page)
  await loadCopper(page)
  const cif = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  const feff = page.getByRole("region", { name: "FEFF path viewer", exact: true })
  const cifImage = cif.getByRole("img", { name: /^Interactive 3D crystal structure/ })
  const feffImage = feff.getByRole("img", { name: /^Interactive 3D scattering path/ })
  const cifGrip = cif.getByRole("separator", { name: "Resize CIF structure height", exact: true })
  const feffGrip = feff.getByRole("separator", { name: "Resize FEFF structure height", exact: true })
  const contributions = feff.getByRole("region", { name: "Path contributions", exact: true })
  const contributionsToggle = contributions.getByRole("checkbox", { name: "Show χ(k) and χ(R) contributions", exact: true })
  await contributionsToggle.check()
  const contributionPlot = contributions.locator(".js-plotly-plot")
  const contributionGrip = contributions.getByRole("separator", { name: "Resize FEFF path contributions plot height", exact: true })
  await expectSceneHeight(cifImage, 310)
  await expectSceneHeight(feffImage, 310)
  await expectPlotHeight(contributionPlot, 330)
  await page.waitForLoadState("networkidle")

  science.watch(true)
  const cifCamera = await rotate(page, cifImage)
  await drag(page, cifGrip, 100)
  await expectSceneHeight(cifImage, 410)
  expect(await camera(cifImage)).toEqual(cifCamera)
  await expectSceneHeight(feffImage, 310)
  const feffCamera = await rotate(page, feffImage)
  await drag(page, feffGrip, 140)
  await expectSceneHeight(feffImage, 450)
  expect(await camera(feffImage)).toEqual(feffCamera)
  await drag(page, contributionGrip, 180)
  await expectPlotHeight(contributionPlot, 510)
  await expectSceneHeight(cifImage, 410)
  await expectSceneHeight(feffImage, 450)
  await expect.poll(() => storedHeights(page)).toEqual({ cif: "410", structure: "450", contributions: "510", simulation: null, spectrum: "620" })
  expect(science.requests).toEqual([])

  science.watch(false)
  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await contributionsToggle.check()
  await expectSceneHeight(cifImage, 410)
  await expectSceneHeight(feffImage, 450)
  await expectPlotHeight(contributionPlot, 510)
  await page.waitForLoadState("networkidle")
  science.watch(true)
  await cifGrip.dblclick()
  await expectSceneHeight(cifImage, 310)
  await expectSceneHeight(feffImage, 450)
  await expectPlotHeight(contributionPlot, 510)
  await contributionGrip.press("Enter")
  await expectPlotHeight(contributionPlot, 330)
  const reloadedCamera = await rotate(page, feffImage)
  await page.setViewportSize({ width: 390, height: 844 })
  // The path legend moves below the scene on narrow panels; the actual 3D
  // surface must retain its requested height rather than measuring both rows.
  await expectSceneHeight(feffImage, 450)
  expect(await camera(feffImage)).toEqual(reloadedCamera)
  const legend = feff.getByRole("group", { name: "FEFF path legend", exact: true })
  const imageBounds = (await feffImage.boundingBox())!, legendBounds = (await legend.boundingBox())!
  expect(legendBounds.y).toBeGreaterThanOrEqual(imageBounds.y + imageBounds.height)
  await drag(page, feffGrip, -60)
  await expectSceneHeight(feffImage, 390)
  expect(await camera(feffImage)).toEqual(reloadedCamera)
  await feffGrip.dblclick()
  await expectSceneHeight(feffImage, 250)
  expect(await camera(feffImage)).toEqual(reloadedCamera)
  await expectSceneHeight(cifImage, 250)
  expect(await storedHeights(page)).toEqual({ cif: null, structure: null, contributions: null, simulation: null, spectrum: "620" })
  expect(await feff.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  expect(science.requests).toEqual([])
  expect(errors).toEqual([])
})

test("standalone CIF and simulated EXAFS use the same drag control and retain separate preferences", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.addInitScript(keys => {
    if (sessionStorage.getItem("simulation-resize-initialized")) return
    localStorage.setItem(keys.cif, "410")
    localStorage.setItem(keys.structure, "450")
    localStorage.setItem(keys.contributions, "510")
    localStorage.setItem(keys.spectrum, "620")
    localStorage.removeItem(keys.simulation)
    sessionStorage.setItem("simulation-resize-initialized", "true")
  }, heights)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const science = scientificRequests(page)
  const project = await loadCopper(page)
  const attachment = project.artemis_structures![0]
  let job: ArtemisFeffJob | undefined
  // This is a viewer test. The existing synthetic fixture supplies curves;
  // the browser still configures the attached CIF through the real dialogs.
  await page.route("**/api/artemis/feff/jobs", async route => {
    job = { ...simulationJob, request: route.request().postDataJSON() as ArtemisFeffRequest,
      provenance: { ...simulationJob.provenance, cif: attachment.structure.cif, structure: attachment.structure } }
    await route.fulfill({ json: job })
  })
  await page.route("**/api/artemis/feff/jobs/*/simulate", async route => {
    expect(job).toBeDefined()
    const request = route.request().postDataJSON() as SimulationRequest
    const result = simulationFixture()
    result.transform = request.transform
    result.simulation.request = request
    result.simulation.feff_job_id = job!.id
    result.source.request = job!.request
    result.source.provenance = job!.provenance
    await route.fulfill({ json: result })
  })

  async function simulate() {
    await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
    await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
    await page.getByRole("button", { name: "Simulate EXAFS from CIF", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Simulate EXAFS", exact: true })
    await dialog.getByRole("button", { name: "Run EXAFS simulation", exact: true }).click()
    await expect(dialog.getByText(/Simulation complete · 1 path ·/)).toBeVisible()
    await expect(dialog.locator('[aria-label="Simulated EXAFS k plot"] .js-plotly-plot')).toBeVisible()
    await page.waitForLoadState("networkidle")
    return dialog
  }

  const dialog = await simulate()
  const standaloneCif = dialog.getByRole("region", { name: "CIF structure viewer", exact: true })
  const cifImage = standaloneCif.getByRole("img", { name: /^Interactive 3D crystal structure/ })
  const cifGrip = standaloneCif.getByRole("separator", { name: "Resize CIF structure height", exact: true })
  const simulation = dialog.getByRole("region", { name: "Simulated EXAFS", exact: true })
  const simulationPlot = simulation.locator(".js-plotly-plot")
  const simulationGrip = simulation.getByRole("separator", { name: "Resize simulated EXAFS plot height", exact: true })
  await expectSceneHeight(cifImage, 410)
  const defaultPlotHeight = await height(simulationPlot)
  const defaultOuterHeight = Number(await simulationGrip.getAttribute("aria-valuenow"))
  science.watch(true)
  const cifCamera = await rotate(page, cifImage)
  await drag(page, cifGrip, 80)
  await expectSceneHeight(cifImage, 490)
  expect(await camera(cifImage)).toEqual(cifCamera)
  await drag(page, simulationGrip, 100)
  await expectPlotHeight(simulationPlot, defaultPlotHeight + 100)
  await expect.poll(() => storedHeights(page)).toEqual({ cif: "490", structure: "450", contributions: "510", simulation: String(defaultOuterHeight + 100), spectrum: "620" })
  await simulation.getByRole("button", { name: "|χ(R)|", exact: true }).click()
  await expect(simulation.locator('[aria-label="Simulated EXAFS r plot"] .js-plotly-plot')).toBeVisible()
  await expectPlotHeight(simulationPlot, defaultPlotHeight + 100)
  expect(science.requests).toEqual([])
  science.watch(false)

  await page.reload()
  await simulate()
  await expectSceneHeight(cifImage, 490)
  await expectPlotHeight(simulationPlot, defaultPlotHeight + 100)
  science.watch(true)
  await simulationGrip.dblclick()
  await expectPlotHeight(simulationPlot, defaultPlotHeight)
  await expectSceneHeight(cifImage, 490)
  expect(await storedHeights(page)).toEqual({ cif: "490", structure: "450", contributions: "510", simulation: null, spectrum: "620" })
  await page.setViewportSize({ width: 390, height: 844 })
  await drag(page, simulationGrip, 80)
  const mobileHeight = Number(await simulationGrip.getAttribute("aria-valuenow"))
  expect(mobileHeight).toBe(420)
  await simulationGrip.press("Enter")
  await expect.poll(() => simulationGrip.getAttribute("aria-valuenow")).toBe("340")
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await storedHeights(page)).toEqual({ cif: "490", structure: "450", contributions: "510", simulation: null, spectrum: "620" })
  expect(science.requests).toEqual([])
  expect(errors).toEqual([])
})
