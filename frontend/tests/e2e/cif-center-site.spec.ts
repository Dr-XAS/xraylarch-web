import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

async function crystalScene(panel: Locator) {
  return panel.getByRole("img", { name: "Interactive 3D crystal structure of Covellite", exact: true }).locator("canvas").evaluate(element => {
    type Atom = { elem: string; x: number; y: number; z: number; style: { sphere?: { color?: string; radius?: number } } }
    const canvas = element as HTMLCanvasElement & { _3dmol_viewer?: {
      getModel: () => { selectedAtoms: (selection: object) => Atom[] } | undefined
      renderer: { getContext: () => WebGLRenderingContext }
    } }
    const viewer = canvas._3dmol_viewer
    const atoms = viewer?.getModel()?.selectedAtoms({}) ?? []
    const context = viewer?.renderer.getContext()
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
      atoms: atoms.map(atom => ({ element: atom.elem, x: atom.x, y: atom.y, z: atom.z,
        color: atom.style.sphere?.color, radius: atom.style.sphere?.radius,
        distance: Math.hypot(atom.x, atom.y, atom.z) })),
      rendered: Boolean(context && !context.isContextLost() && visiblePixels > 100),
    }
  })
}

async function expectEnvironment(panel: Locator, element: "Cu" | "S", highlighted: boolean) {
  await expect.poll(async () => {
    const scene = await crystalScene(panel)
    const center = scene.atoms.find(atom => atom.distance < 1e-6)
    const neighbors = scene.atoms.filter(atom => atom.distance >= 1e-6)
    return {
      center: center && { element: center.element, color: center.color, radius: center.radius },
      neighbors: neighbors.map(atom => ({ element: atom.element, color: atom.color, radius: atom.radius,
        distance: Number(atom.distance.toFixed(6)) })).sort((left, right) => left.distance - right.distance),
      rendered: scene.rendered,
    }
  }).toEqual({
    center: { element, color: element === "Cu" ? "#225ea8" : "#e5bf46", radius: 0.5 },
    neighbors: (element === "Cu" ? [2.191622, 2.191622, 2.191622] : [2.191622, 2.191622, 2.191622, 2.33948, 2.33948])
      .map(distance => ({ element: element === "Cu" ? "S" : "Cu", color: element === "Cu" ? "#e5bf46" : "#225ea8",
        radius: highlighted ? 0.42 : 0.36, distance })),
    rendered: true,
  })
}

test("Covellite keeps the selected Cu center and element colors when highlighting its first shell", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const example = await (await exampleResponse).json() as AthenaProject
  await expect(page.locator(".ath-group.selected .ath-group-select")).toContainText("Cu₂O · room temperature")
  await expect(page.locator(".ath-autosaved")).toHaveText("Saved locally")

  // Use the same bundled AMCSD record as the report, without replacing its
  // site identities, symmetry operations, or periodic neighbor analysis.
  const state = await page.request.get(`/api/backend/api/athena/projects/${example.id}?view=summary`)
  expect(state.ok()).toBe(true)
  const { version } = await state.json() as { version: number }
  const attaching = await page.request.post(`/api/backend/api/artemis/projects/${example.id}/structures`, {
    data: { version, amcsd_id: 65 },
  })
  expect(attaching.ok()).toBe(true)
  const attached = await attaching.json() as AthenaProject
  const covellite = attached.artemis_structures!.find(item => item.amcsd_id === 65)!
  expect(covellite.structure.sites.find(site => site.index === 1)?.element).toBe("Cu")
  expect(covellite.structure.sites.find(site => site.index === 3)?.element).toBe("S")
  await page.reload()

  const panel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await panel.getByRole("combobox", { name: "Viewed CIF structure", exact: true }).selectOption(covellite.id)
  const center = panel.getByRole("combobox", { name: "CIF center site", exact: true })
  await center.selectOption("1")
  await expect(center).toHaveValue("1")
  await expect(panel.getByText("Center: Cu · site 1", { exact: true })).toBeVisible()
  await expect(panel.getByText("CrystalNN first shell · CN 3", { exact: true })).toBeVisible()
  const radius = panel.getByRole("slider", { name: "CIF display radius", exact: true })
  await expect(radius).toHaveValue("3.5")
  for (let step = 0; step < 8; step++) await radius.press("ArrowLeft")
  await expect(radius).toHaveValue("2.7")
  await expect(panel.getByText("4 atoms shown", { exact: true })).toBeVisible()
  const highlight = panel.getByRole("checkbox", { name: "Highlight CrystalNN first shell", exact: true })
  await expect(highlight).toBeChecked()
  const legend = panel.getByRole("group", { name: "Visible CIF elements", exact: true })
  await expect(legend.getByRole("button", { name: "Show Cu atoms", exact: true }).locator('[aria-hidden="true"]')).toHaveCSS("background-color", "rgb(34, 94, 168)")
  await expect(legend.getByRole("button", { name: "Show S atoms", exact: true }).locator('[aria-hidden="true"]')).toHaveCSS("background-color", "rgb(229, 191, 70)")
  await expectEnvironment(panel, "Cu", true)
  await panel.screenshot({ path: info.outputPath("covellite-cu-center-first-shell.png") })

  await highlight.uncheck()
  await expectEnvironment(panel, "Cu", false)
  await expect(panel.getByText("Center: Cu · site 1", { exact: true })).toBeVisible()
  await highlight.check()
  await expectEnvironment(panel, "Cu", true)

  await center.selectOption("3")
  await expect(panel.getByText("Center: S · site 3", { exact: true })).toBeVisible()
  await expect(panel.getByText("CrystalNN first shell · CN 5", { exact: true })).toBeVisible()
  await expect(panel.getByText("6 atoms shown", { exact: true })).toBeVisible()
  await expectEnvironment(panel, "S", true)
  await highlight.uncheck()
  await expectEnvironment(panel, "S", false)
  await highlight.check()
  await expectEnvironment(panel, "S", true)
  await expect(panel.getByRole("alert")).toHaveCount(0)
  expect(errors).toEqual([])
})
