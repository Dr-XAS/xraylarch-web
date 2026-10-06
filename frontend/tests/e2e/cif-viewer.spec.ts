import { expect, test, type Locator } from "@playwright/test"

async function crystalScene(panel: Locator) {
  return panel.getByRole("img", { name: "Interactive 3D crystal structure of Cuprite" }).locator("canvas").evaluate(element => {
    type Point = { x: number; y: number; z: number }
    const viewer = (element as HTMLCanvasElement & {
      _3dmol_viewer?: {
        getModel: () => { selectedAtoms: (selection: object) => Point[] }
        shapes: { stylespec: { start?: Point; end?: Point; radius?: number } }[]
        renderer: { getContext: () => WebGLRenderingContext }
      }
    })._3dmol_viewer
    const context = viewer?.renderer.getContext()
    const lines = viewer?.shapes.filter(shape => shape.stylespec.start && shape.stylespec.end && shape.stylespec.radius === undefined) ?? []
    const vertices = lines.flatMap(line => [line.stylespec.start!, line.stylespec.end!])
    // 3Dmol shares an OffscreenCanvas context; inspect the visible canvas's
    // pixels rather than renderer counters that another viewer can reset.
    const canvas = element as HTMLCanvasElement
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
      atoms: viewer?.getModel().selectedAtoms({}).length ?? 0,
      lines: lines.length,
      spans: (["x", "y", "z"] as const).map(axis => Math.max(...vertices.map(point => point[axis])) - Math.min(...vertices.map(point => point[axis]))),
      rendered: Boolean(context && !context.isContextLost() && visiblePixels > 100),
    }
  })
}

test("expands complete unit cells along each lattice axis without recalculating science", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loaded = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  const transformed = page.waitForResponse(response => response.url().endsWith("/plot-transform"))
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  expect((await loaded).ok()).toBe(true)
  expect((await transformed).ok()).toBe(true)
  const panel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(panel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/(?:athena|artemis)\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })

  const radius = panel.getByRole("slider", { name: "CIF display radius", exact: true })
  await expect(radius).toHaveValue("3.5")
  await radius.press("ArrowRight")
  await expect(radius).toHaveValue("3.6")
  const mode = panel.getByRole("combobox", { name: "CIF view mode", exact: true })
  await mode.selectOption("cell")
  await expect(radius).toHaveCount(0)
  const repeats = ["a", "b", "c"].map(axis => panel.getByRole("spinbutton", { name: `CIF repeats along ${axis}`, exact: true }))
  for (const input of repeats) {
    await expect(input).toHaveValue("1")
    await expect(input).toHaveAttribute("max", "6")
  }
  await expect.poll(async () => {
    const scene = await crystalScene(panel)
    return { atoms: scene.atoms, lines: scene.lines, rendered: scene.rendered }
  }).toEqual({ atoms: 6, lines: 12, rendered: true })
  const unit = await crystalScene(panel)

  await repeats[0].fill("")
  await expect(repeats[0]).toHaveValue("")
  await repeats[0].press("2")
  await expect(repeats[0]).toHaveValue("2")
  await repeats[1].fill("3")
  await expect(panel.getByText("36 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(async () => {
    const scene = await crystalScene(panel)
    return { atoms: scene.atoms, lines: scene.lines, rendered: scene.rendered }
  }).toEqual({ atoms: 36, lines: 46, rendered: true })
  const expanded = await crystalScene(panel)
  for (const [axis, repeat] of [2, 3, 1].entries()) expect(expanded.spans[axis]).toBeCloseTo(unit.spans[axis] * repeat, 5)
  await panel.screenshot({ path: info.outputPath("cif-unit-cells-2x3x1.png") })

  await repeats[1].fill("2")
  await repeats[2].fill("2")
  await expect.poll(async () => (await crystalScene(panel)).atoms).toBe(48)
  await mode.selectOption("cluster")
  await expect(radius).toHaveValue("3.6")
  await expect(panel.getByRole("group", { name: "Unit cell repetitions" })).toHaveCount(0)
  await mode.selectOption("cell")
  await panel.getByRole("button", { name: "Collapse CIF structure viewer", exact: true }).click()
  await expect(repeats[0]).toBeHidden()
  await panel.getByRole("button", { name: "Expand CIF structure viewer", exact: true }).click()
  for (const input of repeats) await expect(input).toHaveValue("2")
  await expect.poll(async () => {
    const scene = await crystalScene(panel)
    return { atoms: scene.atoms, lines: scene.lines, rendered: scene.rendered }
  }).toEqual({ atoms: 48, lines: 54, rendered: true })
  for (const [name, size] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    await page.setViewportSize(size)
    await expect(panel.getByText("48 atoms shown", { exact: true })).toBeVisible()
    const bounds = (await panel.boundingBox())!
    for (const input of repeats) {
      const box = (await input.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await panel.screenshot({ path: info.outputPath(`cif-unit-cells-${name}.png`) })
  }
  await expect(panel.getByRole("alert")).toHaveCount(0)
  expect(scienceRequests).toEqual([])
})

test("calculates finite-cluster coordination numbers and invalidates changed inputs", async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const loaded = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  const transformed = page.waitForResponse(response => response.url().endsWith("/plot-transform"))
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  expect((await loaded).ok()).toBe(true)
  expect((await transformed).ok()).toBe(true)
  const panel = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(panel.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect(panel.getByText("15 atoms shown", { exact: true })).toBeVisible()
  const scienceRequests: string[] = []
  page.on("request", request => {
    if (/\/api\/(?:athena|artemis)\/|\/command$|\/wavelet(?:\?|$)/.test(request.url())) scienceRequests.push(request.url())
  })

  const toggle = panel.getByRole("button", { name: "Coordination numbers", exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  const calculation = panel.getByRole("region", { name: "Coordination number calculation", exact: true })
  const table = calculation.getByRole("table", { name: "Cluster coordination numbers", exact: true })
  const cutoff = calculation.getByRole("spinbutton", { name: "CN distance cutoff", exact: true })
  const tolerance = calculation.getByRole("spinbutton", { name: "CN shell tolerance", exact: true })
  const calculate = calculation.getByRole("button", { name: "Calculate", exact: true })
  const stale = calculation.getByText("Cluster or settings changed. Calculate to update coordination numbers.", { exact: true })
  await expect(cutoff).toHaveValue("5")
  await expect(tolerance).toHaveValue("0.01")
  const copperOxygen = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Cu → O", exact: true }) }).first()
  const copperCopper = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Cu → Cu", exact: true }) }).first()
  // Cuprite's 3.5 Å cluster has 13 Cu and 2 O atoms: 8 Cu–O contacts and
  // 72 directed first-shell Cu–Cu contacts. Include surface atoms and zero CN.
  await expect(copperOxygen.getByRole("cell")).toHaveText(["1", "1.841", "0.615", "2", "ViewCN 0: 6 atomsCN 1: 6 atomsCN 2: 1 atom"])
  await expect(copperCopper.getByRole("cell").nth(1)).toHaveText("3.007")
  await expect(copperCopper.getByRole("cell").nth(2)).toHaveText("5.538")
  await expect(copperCopper.getByRole("cell").nth(3)).toHaveText("12")
  await copperOxygen.getByLabel("Cu to O shell 1 CN distribution", { exact: true }).click()
  await expect(copperOxygen.getByText("CN 0: 6 atoms", { exact: true })).toBeVisible()
  await expect(copperOxygen.getByText("CN 1: 6 atoms", { exact: true })).toBeVisible()
  await expect(copperOxygen.getByText("CN 2: 1 atom", { exact: true })).toBeVisible()

  for (const [name, size] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    await page.setViewportSize(size)
    await expect(table).toBeVisible()
    const bounds = (await panel.boundingBox())!
    for (const control of [toggle, cutoff, tolerance, calculate, calculation.getByRole("region", { name: "Coordination results", exact: true })]) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await panel.screenshot({ path: info.outputPath(`cif-coordination-${name}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  const originalResults = await table.innerText()
  await panel.getByRole("button", { name: "Show O atoms", exact: true }).click()
  await expect(panel.getByText("13 atoms shown", { exact: true })).toBeVisible()
  await expect(table).toHaveText(originalResults, { useInnerText: true })
  await expect(stale).toHaveCount(0)
  await toggle.click()
  await expect(calculation).toBeHidden()
  await toggle.click()
  await expect(table).toHaveText(originalResults, { useInnerText: true })

  await cutoff.fill("2")
  await expect(stale).toBeVisible()
  await expect(table).toHaveCount(0)
  await calculate.click()
  await expect(copperCopper).toContainText("No neighbors within cutoff (CN 0)")
  await expect(copperOxygen.getByRole("cell").nth(2)).toHaveText("0.615")
  await tolerance.fill("0.02")
  await expect(stale).toBeVisible()
  await expect(table).toHaveCount(0)
  await calculate.click()
  await expect(table).toBeVisible()

  const radius = panel.getByRole("slider", { name: "CIF display radius", exact: true })
  await radius.press("Home")
  await expect(radius).toHaveValue("1")
  await expect(stale).toBeVisible()
  await expect(table).toHaveCount(0)
  await calculate.click()
  await page.getByRole("checkbox", { name: "Show instruction", exact: true }).check()
  await calculation.getByRole("button", { name: "About Cluster coordination calculation", exact: true }).hover()
  await expect(page.getByRole("tooltip").getByText("Uses all 1 cluster atom, including hidden elements. Neighbors outside this finite cluster are excluded.", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("checkbox", { name: "Show instruction", exact: true }).uncheck()
  await expect(copperCopper).toContainText("No neighbors within cutoff (CN 0)")
  const mode = panel.getByRole("combobox", { name: "CIF view mode", exact: true })
  await mode.selectOption("cell")
  await expect(calculation.getByText("Switch to Local cluster to calculate coordination numbers.", { exact: true })).toBeVisible()
  await expect(calculate).toBeDisabled()
  await expect(table).toHaveCount(0)
  await mode.selectOption("cluster")
  await expect(calculate).toBeEnabled()
  await expect(stale).toBeVisible()
  await calculate.click()
  await expect(table).toBeVisible()
  await expect(panel.getByRole("alert")).toHaveCount(0)
  expect(scienceRequests).toEqual([])
})
