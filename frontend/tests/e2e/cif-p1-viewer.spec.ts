import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"
import fixture from "../../lib/fixtures/cif-p1-perturbed-cu-cr-p-s.json" with { type: "json" }

type Point = { element: string; x: number; y: number; z: number }

function positions(atoms: Point[]) {
  return atoms.map(atom => `${atom.element}:${[atom.x, atom.y, atom.z].map(value => Math.round(value * 1e6)).join(",")}`).sort()
}

async function renderedScene(panel: Locator) {
  return panel.getByRole("img", { name: /^Interactive 3D crystal structure of/ }).locator("canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement & { _3dmol_viewer?: {
      getModel: () => { selectedAtoms: (selection: object) => { elem: string; x: number; y: number; z: number }[] }
      renderer: { getContext: () => WebGLRenderingContext }
    } }
    const viewer = canvas._3dmol_viewer
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
      atoms: viewer?.getModel().selectedAtoms({}).map(atom => ({ element: atom.elem, x: atom.x, y: atom.y, z: atom.z })) ?? [],
      rendered: Boolean(context && !context.isContextLost() && visiblePixels > 100),
    }
  })
}

function cellAtoms(siteIndex: number, repeatA = 1): Point[] {
  const site = fixture.structure.sites.find(item => item.index === siteIndex)!
  const lattice = fixture.expected.latticeVectors
  const center = [0, 1, 2].map(axis => [site.x, site.y, site.z].reduce((sum, value, index) => sum + value * lattice[index][axis], 0))
  return Array.from({ length: repeatA }, (_, repeat) => fixture.expected.cellAtoms.map(atom => {
    const [x, y, z] = atom.cartesian.map((value, axis) => value + repeat * lattice[0][axis] - center[axis])
    return { element: atom.element, x, y, z }
  })).flat()
}

test("renders complete P1 snapshots at their exact saved coordinates after upload and reload", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.goto("/")
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await exampleResponse).json() as AthenaProject
  const region = page.getByRole("region", { name: "Project CIF structures", exact: true })
  await expect(region.getByRole("button", { name: "Upload CIF", exact: true })).toBeVisible()
  const filename = "synthetic-cu-cr-p-s.cif"
  const attachedResponse = page.waitForResponse(response => response.url().endsWith(`/projects/${initial.id}/structures`) && response.request().method() === "POST")
  const chooser = page.waitForEvent("filechooser")
  await region.getByRole("button", { name: "Upload CIF", exact: true }).click()
  await (await chooser).setFiles({ name: filename, mimeType: "chemical/x-cif", buffer: Buffer.from(fixture.structure.cif) })
  const response = await attachedResponse
  expect(response.ok()).toBe(true)
  const attached = await response.json() as AthenaProject
  const record = attached.artemis_structures!.find(item => item.structure.filename === filename)!
  expect(record.structure.cif).toBe(fixture.structure.cif)
  expect(record.structure.sites).toEqual(fixture.structure.sites)
  expect(record.structure.sites.every(site => site.multiplicity === 4)).toBe(true)
  const dialog = page.getByRole("dialog", { name: "Crystal structures", exact: true })
  const viewer = dialog.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(dialog).toBeVisible()
  const center = viewer.getByRole("combobox", { name: "CIF center site", exact: true })
  const mode = viewer.getByRole("combobox", { name: "CIF view mode", exact: true })

  // Each reference sphere was independently enumerated by pymatgen. The Cu
  // sphere contains the perturbed Cr atom, so reapplying ideal inferred
  // symmetry would fail the coordinate comparison even if the count matched.
  for (const reference of fixture.expected.clusters) {
    await center.selectOption(String(reference.siteIndex))
    await expect(viewer.getByText(`${reference.atoms.length} atoms shown`, { exact: true })).toBeVisible()
    const expected = positions(reference.atoms.map(atom => {
      const [x, y, z] = atom.cartesianOffset
      return { element: atom.element, x, y, z }
    }))
    await expect.poll(async () => positions((await renderedScene(viewer)).atoms)).toEqual(expected)
  }
  await expect.poll(async () => (await renderedScene(viewer)).rendered).toBe(true)
  await center.selectOption("2")
  await mode.selectOption("cell")
  await expect(viewer.getByText("40 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => positions((await renderedScene(viewer)).atoms)).toEqual(positions(cellAtoms(2)))
  await viewer.getByRole("spinbutton", { name: "CIF repeats along a", exact: true }).fill("2")
  await expect(viewer.getByText("80 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => positions((await renderedScene(viewer)).atoms)).toEqual(positions(cellAtoms(2, 2)))
  await viewer.screenshot({ path: info.outputPath("synthetic-p1-complete-cells.png") })
  await expect(viewer.getByText("A 3D preview is unavailable for this CIF.", { exact: true })).toHaveCount(0)
  await expect(viewer.getByRole("alert")).toHaveCount(0)

  await dialog.getByRole("button", { name: "Close CIF search", exact: true }).click()
  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await region.getByRole("button", { name: `Open attached ${filename} CIF`, exact: true }).click()
  await expect(dialog).toBeVisible()
  await center.selectOption("2")
  await mode.selectOption("cell")
  await expect(viewer.getByText("40 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => positions((await renderedScene(viewer)).atoms)).toEqual(positions(cellAtoms(2)))
  await expect.poll(async () => (await renderedScene(viewer)).rendered).toBe(true)
  await expect(dialog.getByRole("button", { name: "Attached to project", exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})
