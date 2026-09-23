import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"

test.use({ actionTimeout: 15000 })

const filenames = ["feff0001.dat", "feff0003.dat", "feff0010.dat", "feff0012.dat"]
type Point = { x: number; y: number; z: number }
const absorber: Point = { x: 0, y: 0, z: 0 }
const copperNeighbor: Point = { x: 0, y: -1.8016, z: 1.8016 }
const copperTriangle: Point[] = [absorber, { x: 1.8016, y: -1.8016, z: 0 }, { x: 1.8016, y: 0, z: -1.8016 }, absorber]

// Measure the actual arrow geometry against the original chemical-bond axis.
// The arrow tips must stay between atom centers, with narrowly separated lanes.
function expectArrowCorridor(arrows: { start: Point; end: Point }[], a: Point, b: Point, offset: number) {
  const axis = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const lengthSquared = axis.x ** 2 + axis.y ** 2 + axis.z ** 2
  const lateral: Point[] = []
  for (const arrow of arrows) {
    for (const point of [arrow.start, arrow.end]) {
      const projection = ((point.x - a.x) * axis.x + (point.y - a.y) * axis.y + (point.z - a.z) * axis.z) / lengthSquared
      expect(projection).toBeGreaterThan(0)
      expect(projection).toBeLessThan(1)
      const displacement = { x: point.x - a.x - projection * axis.x, y: point.y - a.y - projection * axis.y, z: point.z - a.z - projection * axis.z }
      expect(Math.hypot(displacement.x, displacement.y, displacement.z)).toBeCloseTo(offset, 5)
      lateral.push(displacement)
    }
  }
  // Reversed legs are centered together on the bond, rather than shifted aside.
  for (const coordinate of ["x", "y", "z"] as const) {
    expect(lateral.reduce((sum, point) => sum + point[coordinate], 0)).toBeCloseTo(0, 5)
  }
}

async function loadPaths(page: Page, withMatchingCif = false) {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const example = await (await exampleResponse).json()
  if (withMatchingCif) {
    // Import through the real native-project API. This explicit test snapshot
    // matches the bundled FEFF cell (3.6032 Å), unlike measured AMCSD copper.
    const exported = await page.request.get(`/api/backend/api/athena/projects/${example.id}/export?format=json`)
    expect(exported.ok()).toBe(true)
    const project = await exported.json()
    const cif = `data_Cu_FEFF_fixture
_cell_length_a 3.6032
_cell_length_b 3.6032
_cell_length_c 3.6032
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_space_group_name_H-M_alt 'P 1'
loop_
_space_group_symop_operation_xyz
'x,y,z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Cu1 Cu 0 0 0 1
Cu2 Cu 0 0.5 0.5 1
Cu3 Cu 0.5 0 0.5 1
Cu4 Cu 0.5 0.5 0 1
`
    project.artemis_structures = [{
      id: "feff-copper-fixture", amcsd_id: 990001, attached_at: "2026-09-22T00:00:00Z",
      sha256: createHash("sha256").update(cif).digest("hex"),
      structure: {
        id: 990001, mineral: "Copper FEFF fixture", formula: "Cu", space_group: "P 1", authors: "", year: null,
        journal: "", title: "Synthetic FCC cell matching the checked-in FEFF Cu calculation", source: "Browser test fixture",
        cif, elements: ["Cu"], ordered: true, supported: true, warnings: [],
        cell: { a: 3.6032, b: 3.6032, c: 3.6032, alpha: 90, beta: 90, gamma: 90 },
        sites: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]].map(([x, y, z], index) => ({
          index: index + 1, element: "Cu", species: "Cu", multiplicity: 1, wyckoff: "a", x, y, z, occupancy: 1,
        })),
      },
    }]
    await page.getByRole("button", { name: "Open project", exact: true }).click()
    await page.getByLabel("Open project file", { exact: true }).setInputFiles({
      name: "copper-feff-cif-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)),
    })
    const dialog = page.getByRole("dialog", { name: "Open a project" })
    const restored = page.waitForResponse(response => response.url().endsWith("/restore-upload"))
    await dialog.getByRole("button", { name: "Import all groups", exact: true }).click()
    const restoredResponse = await restored
    expect(restoredResponse.ok()).toBe(true)
    expect((await restoredResponse.json()).artemis_structures).toHaveLength(1)
    await expect(dialog).toBeHidden()
    await page.locator(".ath-group-select").filter({ hasText: "Cu foil · 10 K" }).last().click()
  }
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByRole("button", { name: "Add feff*.dat", exact: true })).toBeEnabled()
  const inspected: { filename: string; nleg: number }[] = []
  page.on("response", async response => {
    if (!response.url().endsWith("/api/artemis/paths/inspect") || !response.ok()) return
    const path = await response.json()
    inspected.push({ filename: path.filename, nleg: path.metadata.nleg })
  })
  await page.getByLabel("Upload FEFF path files", { exact: true }).setInputFiles(filenames.map(filename =>
    fileURLToPath(new URL(`../../../examples/feffit/Feff_Cu/${filename}`, import.meta.url)),
  ))
  const panel = page.getByRole("region", { name: "FEFF path viewer", exact: true })
  await expect(panel.getByRole("group", { name: "FEFF path legend", exact: true }).getByRole("button")).toHaveCount(4)
  await expect.poll(() => inspected).toEqual(filenames.map((filename, i) => ({ filename, nleg: [2, 3, 3, 4][i] })))
  return panel
}

async function sceneState(panel: Locator) {
  return panel.getByRole("img", { name: /^Interactive 3D scattering path/ }).locator("canvas").evaluate(element => {
    type Point = { x: number; y: number; z: number }
    type Color = string | number | { r: number; g: number; b: number }
    type Shape = { stylespec: { center?: Point; start?: Point; end?: Point; radius?: number; radiusRatio?: number; opacity?: number; color?: Color } }
    const colorHex = (color?: Color) => typeof color === "string" ? color.toLowerCase() : typeof color === "number"
      ? `#${color.toString(16).padStart(6, "0")}` : color
        ? `#${[color.r, color.g, color.b].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}` : undefined
    // 3Dmol 2.5.3 attaches its live renderer to the canvas. Inspect the rendered
    // scene, rather than treating the accessible label as proof of 3D output.
    const canvas = element as HTMLCanvasElement & {
      _3dmol_viewer?: {
        shapes: Shape[]; labels: unknown[]; getView: () => number[]
        renderer: {
          getContext: () => WebGLRenderingContext | WebGL2RenderingContext
          info: { render: { calls: number; faces: number } }
        }
      }
    }
    const viewer = canvas._3dmol_viewer
    // Renderer.ts uses a shared OffscreenCanvas WebGL2 context and transfers
    // its output into this visible canvas's bitmaprenderer on Chromium.
    const context = viewer?.renderer.getContext()
    const snapshot = document.createElement("canvas")
    snapshot.width = canvas.width
    snapshot.height = canvas.height
    const snapshotContext = snapshot.getContext("2d")!
    snapshotContext.drawImage(canvas, 0, 0)
    const pixels = snapshotContext.getImageData(0, 0, snapshot.width, snapshot.height).data
    let visiblePixels = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) visiblePixels++
    }
    return {
      webgl: Boolean(context && !context.isContextLost() && context.drawingBufferWidth > 0 && context.drawingBufferHeight > 0),
      rendered: Boolean(viewer && viewer.renderer.info.render.calls > 0 && viewer.renderer.info.render.faces > 0 && visiblePixels > 100),
      atoms: viewer?.shapes.filter(shape => shape.stylespec.center && (shape.stylespec.opacity ?? 1) === 1).length ?? 0,
      arrows: viewer?.shapes.filter(shape => shape.stylespec.radiusRatio !== undefined).map(shape => ({
        start: shape.stylespec.start!, end: shape.stylespec.end!, opacity: shape.stylespec.opacity, radius: shape.stylespec.radius,
        color: colorHex(shape.stylespec.color),
      })) ?? [],
      labels: viewer?.labels.length ?? 0,
      view: viewer?.getView() ?? [],
    }
  })
}

async function expectScene(panel: Locator, atomCount: number, legCount: number) {
  await expect(panel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect(panel.getByRole("img", { name: /^Interactive 3D scattering path/ }).locator("canvas")).toBeVisible()
  await expect.poll(async () => {
    const scene = await sceneState(panel)
    return { webgl: scene.webgl, rendered: scene.rendered, atoms: scene.atoms, legs: scene.arrows.length }
  }).toEqual({ webgl: true, rendered: true, atoms: atomCount, legs: legCount })
  await expect(panel.getByRole("alert")).toHaveCount(0)
}

async function selectPath(panel: Locator, filename: string) {
  const legend = panel.getByRole("group", { name: "FEFF path legend", exact: true })
  const selectedNames = await legend.getByRole("button", { pressed: true }).evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")!))
  for (const name of selectedNames) {
    if (name !== `Show ${filename}`) await legend.getByRole("button", { name, exact: true }).click()
  }
  const button = legend.getByRole("button", { name: `Show ${filename}`, exact: true })
  if (await button.getAttribute("aria-pressed") !== "true") await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByRole("heading", { name: filename, exact: true })).toBeVisible()
}

async function expectLegendInsideCanvas(panel: Locator) {
  await expect(panel.getByRole("navigation", { name: "FEFF paths" })).toHaveCount(0)
  const legendLocator = panel.getByRole("group", { name: "FEFF path legend", exact: true })
  const sceneLocator = panel.getByRole("img", { name: /^Interactive 3D scattering path/ })
  const legend = (await legendLocator.boundingBox())!
  const scene = (await sceneLocator.boundingBox())!
  const canvas = (await sceneLocator.locator("..").boundingBox())!
  expect(legend.x).toBeGreaterThanOrEqual(canvas.x)
  expect(legend.y).toBeGreaterThanOrEqual(canvas.y)
  expect(legend.x + legend.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1)
  expect(legend.y + legend.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1)
  expect(scene.x + scene.width <= legend.x + 1 || scene.y + scene.height <= legend.y + 1).toBe(true)
  const buttons = await legendLocator.getByRole("button").all()
  for (let index = 1; index < buttons.length; index++) {
    const previous = (await buttons[index - 1].boundingBox())!
    const current = (await buttons[index].boundingBox())!
    expect(Math.abs(current.x - previous.x)).toBeLessThanOrEqual(1)
    expect(current.y).toBeGreaterThan(previous.y)
  }
}

async function openCoordinates(panel: Locator) {
  const details = panel.locator("details").filter({ hasText: "Coordinates and scattering angles" })
  if (await details.getAttribute("open") === null) await details.locator("summary").click()
}

async function modelState(panel: Locator) {
  return panel.getByRole("img", { name: /^Interactive 3D (?:scattering path|crystal structure)/ }).locator("canvas").evaluate(element => {
    type Point = { x: number; y: number; z: number }
    type Color = string | number | { r: number; g: number; b: number }
    type Style = { color?: Color; radius?: number; opacity?: number }
    type Shape = { stylespec: Style & { center?: Point; start?: Point; end?: Point; radiusRatio?: number } }
    type ModelAtom = {
      elem: string; x: number; y: number; z: number; bonds: number[]
      style?: { sphere?: Style; stick?: Style }
    }
    const viewer = (element as HTMLCanvasElement & {
      _3dmol_viewer?: { getModel: () => { selectedAtoms: (selection: object) => ModelAtom[] } | undefined; shapes: Shape[] }
    })._3dmol_viewer
    const atoms = viewer?.getModel()?.selectedAtoms({}) ?? []
    const key = (atom: ModelAtom) => `${atom.elem}:${[atom.x, atom.y, atom.z].map(value => (Math.abs(value) < 1e-6 ? 0 : value).toFixed(5)).join(",")}`
    const samePoint = (a: Point, b?: Point) => b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-5
    const colorHex = (color?: Color) => typeof color === "string" ? color.toLowerCase() : typeof color === "number"
      ? `#${color.toString(16).padStart(6, "0")}` : color
        ? `#${[color.r, color.g, color.b].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}` : undefined
    // CIF uses model materials. FEFF uses the same perceived bond graph but
    // individual sphere/half-bond shapes because 3Dmol opacity is model-wide.
    const styled = atoms.map(atom => ({
      atom,
      sphere: viewer?.shapes.find(shape => samePoint(atom, shape.stylespec.center))?.stylespec ?? atom.style?.sphere,
      stick: viewer?.shapes.find(shape => shape.stylespec.radiusRatio === undefined &&
        (samePoint(atom, shape.stylespec.start) || samePoint(atom, shape.stylespec.end)))?.stylespec ?? atom.style?.stick,
    }))
    // The installed 3Dmol shape shader applies material opacity twice, so
    // test the resulting alpha rather than equating the input with alpha.
    const isFaded = (style?: Style) => style?.opacity !== undefined && Math.abs(style.opacity ** 2 - 0.3) < 1e-6
    const bondSegments = viewer?.shapes.filter(shape => shape.stylespec.start && shape.stylespec.end &&
      shape.stylespec.radiusRatio === undefined).map(shape => shape.stylespec) ?? []
    return {
      atoms: atoms.map(key).sort(),
      bonds: [...new Set(atoms.flatMap(atom => atom.bonds.map(index => [key(atom), key(atoms[index])].sort().join("|"))))].sort(),
      sphereColors: [...new Set(styled.map(item => colorHex(item.sphere?.color)))],
      stickColors: [...new Set(styled.map(item => colorHex(item.stick?.color)))],
      sphereRadii: [...new Set(styled.map(item => item.sphere?.radius))],
      stickRadii: [...new Set(styled.map(item => item.stick?.radius))],
      highlightedAtoms: styled.filter(item => item.sphere && (item.sphere.opacity ?? 1) === 1).map(item => key(item.atom)).sort(),
      fadedAtoms: styled.filter(item => isFaded(item.sphere)).map(item => key(item.atom)).sort(),
      opaqueBondSegments: bondSegments.filter(style => (style.opacity ?? 1) === 1).length,
      fadedBondSegments: bondSegments.filter(isFaded).length,
      renderedBondSegments: bondSegments.map(style => ({ start: style.start!, end: style.end!, opacity: style.opacity ?? 1 })),
      drawnSticks: styled.filter(item => item.stick).length,
    }
  })
}

function renderedBondHalves(model: Awaited<ReturnType<typeof modelState>>, a: Point, b: Point) {
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
  const same = (left: Point, right: Point) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) < 1e-5
  return model.renderedBondSegments.filter(segment => [a, b].some(endpoint =>
    (same(segment.start, endpoint) && same(segment.end, middle)) ||
    (same(segment.end, endpoint) && same(segment.start, middle)),
  ))
}

test("renders real single, triangular, collinear, and repeated FEFF trajectories without rerunning science for presentation controls", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const panel = await loadPaths(page)
  await expectScene(panel, 2, 2)
  await expect(panel.getByText("Single scattering", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Scattering sequence", { exact: true })).toHaveText("Cu A → Cu 1 → Cu A")
  const single = await sceneState(panel)
  const directions = single.arrows.map(arrow => ({
    x: arrow.end.x - arrow.start.x, y: arrow.end.y - arrow.start.y, z: arrow.end.z - arrow.start.z,
  }))
  expect(directions[0].x * directions[1].x + directions[0].y * directions[1].y + directions[0].z * directions[1].z).toBeLessThan(0)
  expect(single.arrows[0].start).not.toEqual(single.arrows[1].end)
  expectArrowCorridor(single.arrows, absorber, copperNeighbor, 0.07)
  expect(single.arrows.map(arrow => arrow.radius)).toEqual([0.065, 0.065])
  await expectLegendInsideCanvas(panel)
  await panel.screenshot({ path: info.outputPath("feff-single-scattering-desktop.png") })

  // Observe all scientific commands after import has completed. Selection,
  // rotation, labels and individual-leg emphasis must stay in the browser.
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/artemis\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })
  await panel.getByRole("button", { name: "Leg 1", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Leg 1", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByText(/Leg 1: Cu A → Cu 1/)).toContainText("180.0° (backscattering)")
  await expect.poll(async () => (await sceneState(panel)).arrows.map(arrow => arrow.opacity)).toEqual([1, 0.3])
  expect((await sceneState(panel)).arrows.map(arrow => arrow.radius)).toEqual([0.065, 0.045])
  expect((await sceneState(panel)).view).toEqual(single.view)
  await panel.getByLabel("Labels", { exact: true }).uncheck()
  await expect.poll(async () => (await sceneState(panel)).labels).toBe(0)
  expect((await sceneState(panel)).view).toEqual(single.view)
  await panel.getByLabel("Labels", { exact: true }).check()
  await panel.getByRole("button", { name: "All legs", exact: true }).click()
  await expect.poll(async () => (await sceneState(panel)).labels).toBe(single.labels)

  const canvas = panel.getByRole("img", { name: /^Interactive 3D scattering path/ }).locator("canvas")
  await canvas.scrollIntoViewIfNeeded()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await sceneState(panel)).view).not.toEqual(single.view)
  const rotatedView = (await sceneState(panel)).view
  await panel.getByRole("button", { name: "Reset view", exact: true }).click()
  // Match the CIF viewer: reset refits the center and zoom while retaining
  // the orientation chosen by the user.
  await expect.poll(async () => (await sceneState(panel)).view.slice(0, 4)).toEqual(single.view.slice(0, 4))
  expect((await sceneState(panel)).view.slice(4)).toEqual(rotatedView.slice(4))

  await selectPath(panel, "feff0003.dat")
  await expectScene(panel, 3, 3)
  await expect(panel.getByText("Double scattering · triangle", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Scattering sequence", { exact: true })).toHaveText("Cu A → Cu 1 → Cu 2 → Cu A")
  await openCoordinates(panel)
  await expect(panel.getByRole("table").locator("tbody tr")).toHaveCount(4)
  await expect(panel.getByRole("table").getByRole("cell", { name: "120.0", exact: true })).toHaveCount(2)
  const triangular = await sceneState(panel)
  triangular.arrows.forEach((arrow, index) => expectArrowCorridor([arrow], copperTriangle[index], copperTriangle[index + 1], 0))
  await panel.screenshot({ path: info.outputPath("feff-triangle-desktop.png") })

  await selectPath(panel, "feff0010.dat")
  await expectScene(panel, 3, 3)
  await expect(panel.getByText("Double scattering · collinear", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Leg 2", exact: true }).click()
  await expect(panel.getByText(/Leg 2: Cu 1 → Cu 2/)).toContainText("0.0° (forward)")

  await selectPath(panel, "feff0012.dat")
  await expectScene(panel, 2, 4)
  await expect(panel.getByText("Triple scattering", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Scattering sequence", { exact: true })).toHaveText("Cu A → Cu 1 → Cu A → Cu 1 → Cu A")
  await expect(panel.getByRole("group", { name: "Highlight scattering leg" }).getByRole("button", { name: /^Leg \d$/ })).toHaveCount(4)
  const repeated = await sceneState(panel)
  expect(new Set(repeated.arrows.map(arrow => JSON.stringify([arrow.start, arrow.end]))).size).toBe(4)
  await panel.getByRole("button", { name: "Leg 4", exact: true }).click()
  await expect(panel.getByText(/Leg 4: Cu 1 → Cu A/)).toContainText("return to absorber")
  await openCoordinates(panel)
  await expect(panel.getByRole("table").locator("tbody tr")).toHaveCount(5)
  await expect(panel.getByRole("table").getByRole("cell", { name: "Cu A", exact: true })).toHaveCount(3)
  await panel.getByRole("button", { name: "All legs", exact: true }).click()
  await panel.screenshot({ path: info.outputPath("feff-repeated-path-desktop.png") })
  expect(scienceRequests).toEqual([])
  expect(errors).toEqual([])
})

test("keeps real FEFF paths selectable and the 3D scene usable on mobile without horizontal overflow", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await loadPaths(page)
  await selectPath(panel, "feff0003.dat")
  await expectScene(panel, 3, 3)
  await expectLegendInsideCanvas(panel)
  await panel.getByRole("button", { name: "Leg 3", exact: true }).click()
  await expect(panel.getByText(/Leg 3: Cu 2 → Cu A/)).toContainText("return to absorber")
  await openCoordinates(panel)
  await expect(panel.getByRole("table")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await panel.screenshot({ path: info.outputPath("feff-triangle-mobile.png") })
})

test("shows a matching project CIF with the same elemental atom and bond styles, controls, and bond graph as the CIF viewer", async ({ page }, info) => {
  test.setTimeout(150000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  const panel = await loadPaths(page, true)
  const cifPanel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expectScene(panel, 13, 2)
  await expect(panel.getByLabel("Local structure", { exact: true })).toBeChecked()
  await expect(panel.getByLabel("Bonds", { exact: true })).toBeChecked()
  await expect(cifPanel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect.poll(async () => (await modelState(panel)).atoms.length).toBe(13)
  const initial = await modelState(panel)
  const crystal = await modelState(cifPanel)
  expect(initial.atoms).toEqual(crystal.atoms)
  expect(initial.bonds).toEqual(crystal.bonds)
  expect(initial.bonds.length).toBeGreaterThan(12)
  expect(initial.drawnSticks).toBe(13)
  expect(initial.sphereColors).toEqual(crystal.sphereColors)
  expect(initial.stickColors).toEqual(crystal.stickColors)
  expect(initial.sphereRadii).toEqual(crystal.sphereRadii)
  expect(initial.stickRadii).toEqual(crystal.stickRadii)
  expect(initial.highlightedAtoms).toHaveLength(13)
  expect(initial.fadedAtoms).toHaveLength(0)
  expect(initial.opaqueBondSegments).toBe(22)
  expect(initial.fadedBondSegments).toBe(2 * initial.bonds.length - 24)
  expect(renderedBondHalves(initial, absorber, copperNeighbor)).toHaveLength(0)
  for (const arrow of (await sceneState(panel)).arrows) expect(arrow.radius).toBe(0.065)

  const radius = panel.getByRole("slider", { name: "FEFF display radius", exact: true })
  const cifRadius = cifPanel.getByRole("slider", { name: "CIF display radius", exact: true })
  await expect(radius).toHaveValue("3.5")
  expect(await radius.evaluate(node => node.parentElement?.className)).toEqual(await cifRadius.evaluate(node => node.parentElement?.className))
  expect(await panel.getByLabel("Bonds", { exact: true }).evaluate(node => node.parentElement?.parentElement?.className))
    .toEqual(await cifPanel.getByLabel("Bonds", { exact: true }).evaluate(node => node.parentElement?.parentElement?.className))
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/artemis\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })

  await panel.getByLabel("Bonds", { exact: true }).uncheck()
  await expect.poll(async () => (await modelState(panel)).drawnSticks).toBe(0)
  expect((await sceneState(panel)).arrows).toHaveLength(2)
  await panel.getByLabel("Bonds", { exact: true }).check()
  await expect.poll(async () => (await modelState(panel)).drawnSticks).toBe(13)
  for (let i = 0; i < 5; i++) await radius.press("ArrowRight")
  await expect(radius).toHaveValue("4")
  await expect.poll(async () => (await modelState(panel)).atoms.length).toBe(19)
  for (let i = 0; i < 5; i++) await cifRadius.press("ArrowRight")
  await expect(cifRadius).toHaveValue("4")
  await expect.poll(async () => (await modelState(cifPanel)).atoms.length).toBe(19)
  const expanded = await modelState(panel)
  const expandedCrystal = await modelState(cifPanel)
  expect(expanded.atoms).toEqual(expandedCrystal.atoms)
  expect(expanded.bonds).toEqual(expandedCrystal.bonds)
  expect((await sceneState(panel)).arrows).toHaveLength(2)

  await panel.getByLabel("Local structure", { exact: true }).uncheck()
  await expect.poll(async () => (await modelState(panel)).atoms.length).toBe(13)
  await expectScene(panel, 13, 2)
  await panel.getByLabel("Local structure", { exact: true }).check()
  await expect.poll(async () => (await modelState(panel)).atoms.length).toBe(19)
  await selectPath(panel, "feff0003.dat")
  await expectScene(panel, 13, 3)
  await expect(panel.getByLabel("Local structure", { exact: true })).toBeChecked()
  await expect.poll(async () => (await modelState(panel)).atoms.length).toBeGreaterThan(3)
  await panel.screenshot({ path: info.outputPath("feff-triangle-local-structure-desktop.png") })
  expect(scienceRequests).toEqual([])
})

test("the in-canvas legend combines independently colored paths and allows every path to be deselected", async ({ page }, info) => {
  test.setTimeout(150000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  const panel = await loadPaths(page, true)
  const legend = panel.getByRole("group", { name: "FEFF path legend", exact: true })
  const single = legend.getByRole("button", { name: "Show feff0001.dat", exact: true })
  const triangle = legend.getByRole("button", { name: "Show feff0003.dat", exact: true })
  await expect(single).toHaveAttribute("aria-pressed", "true")
  await expect(triangle).toHaveAttribute("aria-pressed", "false")
  await expectScene(panel, 13, 2)
  await expectLegendInsideCanvas(panel)
  const initialColor = (await sceneState(panel)).arrows[0].color
  const initialModel = await modelState(panel)
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/artemis\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })

  await triangle.click()
  await expect(single).toHaveAttribute("aria-pressed", "true")
  await expect(triangle).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByRole("heading", { name: "feff0003.dat", exact: true })).toBeVisible()
  await expectScene(panel, 13, 5)
  const combined = await sceneState(panel)
  const colors = [...new Set(combined.arrows.map(arrow => arrow.color))]
  expect(colors).toHaveLength(2)
  expect(combined.arrows.filter(arrow => arrow.color === initialColor)).toHaveLength(2)
  const triangleColor = colors.find(color => color !== initialColor)
  expect(combined.arrows.filter(arrow => arrow.color === triangleColor)).toHaveLength(3)
  const union = await modelState(panel)
  expect(union.atoms).toEqual(initialModel.atoms)
  expect(union.highlightedAtoms).toHaveLength(13)
  expect(union.fadedAtoms).toHaveLength(0)
  // The single route and the triangle have four distinct physical edges.
  // All equivalent bonds remain opaque except those replaced by arrows.
  expect(union.opaqueBondSegments).toBe(2 * union.bonds.length - 8)
  expect(union.fadedBondSegments).toBe(0)
  expect(renderedBondHalves(union, absorber, copperNeighbor)).toHaveLength(0)
  for (let index = 0; index < 3; index++) {
    expect(renderedBondHalves(union, copperTriangle[index], copperTriangle[index + 1])).toHaveLength(0)
  }
  expect(union.sphereColors).toEqual(initialModel.sphereColors)
  expect(union.sphereRadii).toEqual(initialModel.sphereRadii)
  await panel.screenshot({ path: info.outputPath("feff-multiple-paths-legend-desktop.png") })

  await single.click()
  await expect(single).toHaveAttribute("aria-pressed", "false")
  await expect(triangle).toHaveAttribute("aria-pressed", "true")
  await expectScene(panel, 13, 3)
  expect((await sceneState(panel)).arrows.every(arrow => arrow.color === triangleColor)).toBe(true)
  await expect.poll(async () => (await modelState(panel)).fadedAtoms.length).toBe(0)

  await triangle.click()
  await expect(legend.getByRole("button", { pressed: true })).toHaveCount(0)
  await expectScene(panel, 0, 0)
  const none = await modelState(panel)
  expect(none.atoms).toEqual(initialModel.atoms)
  expect(none.highlightedAtoms).toHaveLength(0)
  expect(none.fadedAtoms).toHaveLength(13)
  expect(none.opaqueBondSegments).toBe(0)
  expect(none.fadedBondSegments).toBe(2 * none.bonds.length)
  await legend.getByRole("button", { name: "Show feff0012.dat", exact: true }).click()
  await expectScene(panel, 13, 4)
  await expect(panel.getByRole("heading", { name: "feff0012.dat", exact: true })).toBeVisible()
  expect(scienceRequests).toEqual([])
})


test("the real Cu2O example highlights both degenerate first-shell oxygens but draws one representative route", async ({ page }, info) => {
  test.setTimeout(150000)
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await page.getByRole("button", { name: "Cu₂O example", exact: true }).click()
  const panel = page.getByRole("region", { name: "FEFF path viewer", exact: true })
  await expect(panel.getByRole("group", { name: "FEFF path legend" }).getByRole("button")).toHaveCount(4)
  await expectScene(panel, 3, 2)
  const first = await modelState(panel)
  expect(first.highlightedAtoms.filter(atom => atom.startsWith("O:"))).toEqual([
    "O:-1.06300,-1.06300,-1.06300", "O:1.06300,1.06300,1.06300",
  ])
  expect(first.opaqueBondSegments).toBe(2)
  const representativeOxygen: Point = { x: -1.063, y: -1.063, z: -1.063 }
  const equivalentOxygen: Point = { x: 1.063, y: 1.063, z: 1.063 }
  // Inspect live cylinder geometry: the representative Cu–O bond is replaced
  // by outgoing/return arrows, while the opposite equivalent Cu–O stays solid.
  expect(renderedBondHalves(first, absorber, representativeOxygen)).toHaveLength(0)
  const equivalentBond = renderedBondHalves(first, absorber, equivalentOxygen)
  expect(equivalentBond).toHaveLength(2)
  expect(equivalentBond.map(segment => segment.opacity)).toEqual([1, 1])
  expectArrowCorridor((await sceneState(panel)).arrows, absorber, representativeOxygen, 0.07)
  expect(first.fadedAtoms.length).toBeGreaterThan(0)
  expect((await sceneState(panel)).labels).toBe(4) // Only representative atom/leg labels.
  await expect(panel.getByText(/Equivalent paths were not expanded/)).toHaveCount(0)
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/artemis\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })
  await panel.screenshot({ path: info.outputPath("cuprite-arrows-replace-bonds.png") })
  const canvas = panel.getByRole("img", { name: /^Interactive 3D scattering path/ }).locator("canvas")
  await canvas.evaluate(element => {
    const viewer = (element as HTMLCanvasElement & { _3dmol_viewer: { zoom: (factor: number) => void; render: () => void } })._3dmol_viewer
    viewer.zoom(2)
    viewer.render()
  })
  await canvas.locator("../..").screenshot({ path: info.outputPath("cuprite-arrows-detail.png") })
  await panel.getByRole("button", { name: "Reset view", exact: true }).click()
  await panel.getByRole("button", { name: "Leg 2", exact: true }).click()
  await expectScene(panel, 3, 2)
  expect((await modelState(panel)).opaqueBondSegments).toBe(2)
  const radius = panel.getByRole("slider", { name: "FEFF display radius" })
  await radius.press("Home")
  await expect(radius).toHaveValue("1")
  await expectScene(panel, 3, 2)
  expect((await modelState(panel)).atoms).toHaveLength(3)
  await panel.getByLabel("Local structure", { exact: true }).uncheck()
  await expectScene(panel, 3, 2)
  await panel.getByLabel("Local structure", { exact: true }).check()
  await selectPath(panel, "feff0003.dat")
  await expectScene(panel, 9, 3) // Includes reversed equivalent Cu–O–Cu routes.
  await expect(panel.getByText(/Equivalent paths were not expanded/)).toHaveCount(0)
  await selectPath(panel, "feff0001.dat")
  await expectScene(panel, 3, 2)
  expect(scienceRequests).toEqual([])
})
