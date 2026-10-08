import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"
import type { ArtemisProjectStructures } from "../../lib/artemis-structures"

async function renderedCrystal(panel: Locator) {
  return panel.getByRole("img", { name: "Interactive 3D crystal structure of Copper", exact: true }).locator("canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement & {
      _3dmol_viewer?: {
        getModel: () => { selectedAtoms: (selection: object) => { x: number; y: number; z: number }[] }
        renderer: { getContext: () => WebGLRenderingContext }
      }
    }
    const viewer = canvas._3dmol_viewer
    const context = viewer?.renderer.getContext()
    const atoms = viewer?.getModel().selectedAtoms({}) ?? []
    const snapshot = document.createElement("canvas")
    snapshot.width = canvas.width
    snapshot.height = canvas.height
    const drawing = snapshot.getContext("2d")!
    drawing.drawImage(canvas, 0, 0)
    const pixels = drawing.getImageData(0, 0, snapshot.width, snapshot.height).data
    let visiblePixels = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) visiblePixels++
    }
    return {
      atoms: atoms.length,
      nearest: Math.min(...atoms.map(atom => Math.hypot(atom.x, atom.y, atom.z)).filter(distance => distance > 0.01)),
      rendered: Boolean(context && !context.isContextLost() && visiblePixels > 100),
    }
  })
}

test("database CIF selection renders an interactive preview before attachment", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  const preparedModel = page.waitForResponse(response => response.url().endsWith("/model") && response.request().method() === "POST")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await exampleResponse).json() as AthenaProject
  expect((await preparedModel).ok()).toBe(true)
  const attachments = async () => {
    const response = await page.request.get(`/api/backend/api/artemis/projects/${initial.id}/structures`)
    expect(response.ok()).toBe(true)
    return await response.json() as ArtemisProjectStructures
  }
  const baseline = await attachments()
  expect(baseline.structures.some(item => item.amcsd_id === 11145 || item.amcsd_id === 13088)).toBe(false)
  const mutations: string[] = []
  page.on("request", request => {
    if (request.method() === "POST" && (/\/projects\/[^/]+\/structures(?:\/|$)/.test(request.url()) || request.url().endsWith("/feff/jobs"))) mutations.push(request.url())
  })

  await page.getByRole("region", { name: "Project CIF structures", exact: true }).getByRole("button", { name: "Search / attach CIF", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Crystal structures", exact: true })
  await dialog.getByRole("combobox", { name: "Structure source", exact: true }).selectOption("amcsd")
  await dialog.getByRole("textbox", { name: "AMCSD search query", exact: true }).fill("copper")
  await dialog.getByRole("button", { name: "Search AMCSD", exact: true }).click()
  const first = dialog.getByRole("button", { name: /Copper.*AMCSD 0011145/ })
  const second = dialog.getByRole("button", { name: /Copper.*AMCSD 0013088/ })
  await first.click()
  const panel = dialog.getByRole("region", { name: "CIF structure viewer", exact: true })
  const attach = dialog.getByRole("button", { name: "Attach to project", exact: true })
  await expect(attach).toBeEnabled()
  await expect(panel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect.poll(async () => (await renderedCrystal(panel)).rendered).toBe(true)
  expect((await renderedCrystal(panel)).nearest).toBeCloseTo(3.61496 / Math.sqrt(2), 5)
  await expect(first).toHaveAttribute("aria-pressed", "true")
  const radius = panel.getByRole("slider", { name: "CIF display radius", exact: true })
  await radius.press("ArrowRight")
  await expect(radius).toHaveValue("3.6")
  const mode = panel.getByRole("combobox", { name: "CIF view mode", exact: true })
  await mode.selectOption("cell")
  await panel.getByRole("spinbutton", { name: "CIF repeats along a", exact: true }).fill("2")
  await expect.poll(async () => (await renderedCrystal(panel)).atoms).toBe(8)
  await panel.getByRole("button", { name: "Show Cu atoms", exact: true }).click()
  await expect(panel.getByText("0 atoms shown", { exact: true })).toBeVisible()

  await second.click()
  await expect(second).toHaveAttribute("aria-pressed", "true")
  await expect(mode).toHaveValue("cluster")
  await expect(radius).toHaveValue("3.5")
  await expect(panel.getByRole("button", { name: "Show Cu atoms", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await renderedCrystal(panel)).rendered).toBe(true)
  expect((await renderedCrystal(panel)).nearest).toBeCloseTo(3.63 / Math.sqrt(2), 5)
  await expect(attach).toBeEnabled()
  expect(await attachments()).toEqual(baseline)
  expect(mutations).toEqual([])

  await page.setViewportSize({ width: 390, height: 844 })
  await panel.scrollIntoViewIfNeeded()
  for (const control of [mode, radius, panel.getByRole("button", { name: "Reset view", exact: true })]) {
    const bounds = (await control.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391)
  }
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await panel.screenshot({ path: info.outputPath("cif-candidate-preview-mobile.png") })

  await radius.press("ArrowRight")
  await expect(radius).toHaveValue("3.6")
  const saved = page.waitForResponse(response => response.url().endsWith(`/projects/${initial.id}/structures`) && response.request().method() === "POST")
  await attach.click()
  const savedResponse = await saved
  expect(savedResponse.ok()).toBe(true)
  const project = await savedResponse.json() as AthenaProject
  expect(project.artemis_structures).toHaveLength(baseline.structures.length + 1)
  expect(project.artemis_structures!.some(item => item.amcsd_id === 13088)).toBe(true)
  await expect(dialog.getByRole("button", { name: "Attached to project", exact: true })).toBeDisabled()
  await expect(radius).toHaveValue("3.6")
  await expect(panel.getByRole("alert")).toHaveCount(0)
  expect(errors).toEqual([])
})
