import { expect, test } from "@playwright/test"

test("CrystalNN shell, FEFF candidates, and periodic viewer use the selected absorber", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const fitRequests: string[] = []
  page.on("request", request => { if (/\/fit(?:-saved)?$/.test(request.url())) fitRequests.push(request.url()) })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const viewer = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(viewer.getByText("CrystalNN first shell · CN 2", { exact: true })).toBeVisible()
  await viewer.getByRole("combobox", { name: "CIF view mode" }).selectOption("shell")
  await expect(viewer.getByText("3 atoms shown", { exact: true })).toBeVisible()
  await expect(viewer.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  // Inspect actual 3Dmol atom styles and pixel output, not just a loaded canvas.
  await expect.poll(() => viewer.locator("canvas").evaluate(element => {
    const v = (element as HTMLCanvasElement & { _3dmol_viewer?: { getModel: () => { selectedAtoms: (selection: object) => { style: { sphere?: { color?: string } } }[] } } })._3dmol_viewer
    return v?.getModel().selectedAtoms({}).map(atom => atom.style.sphere?.color).sort()
  })).toEqual(["#225ea8", "#e5bf46", "#e5bf46"])
  await viewer.screenshot({ path: info.outputPath("crystalnn-cuprite-first-shell.png") })

  await page.getByRole("button", { name: "Generate FEFF paths", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "FEFF paths" })
  await dialog.getByRole("radio", { name: "Absorber site 1", exact: true }).click()
  await expect(dialog.getByText("CrystalNN first shell · CN 2", { exact: true })).toBeVisible()
  // Display-only site changes must not change FEFF site or discard work.
  await dialog.getByRole("combobox", { name: "CIF center site" }).selectOption("2")
  await expect(dialog.getByText("CrystalNN first shell · CN 4", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("radio", { name: "Absorber site 1", exact: true })).toBeChecked()
  await dialog.getByRole("textbox", { name: "FEFF cluster radius" }).fill("3")
  await dialog.getByRole("textbox", { name: "FEFF maximum path radius" }).fill("2")
  await dialog.getByRole("combobox", { name: "FEFF maximum legs" }).selectOption("2")
  await dialog.getByRole("button", { name: "Run FEFF calculation", exact: true }).click()
  await expect(dialog.getByText("FEFF calculation complete", { exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(dialog.getByText(/feff0001.dat · First shell/)).toBeVisible()
  await dialog.getByRole("button", { name: "Select first-shell paths", exact: true }).click()
  await expect(dialog.getByRole("checkbox", { name: "Select generated feff0001.dat" })).toBeChecked()
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(viewer.getByRole("combobox", { name: "CIF center site" })).toHaveValue("1")
  await expect(page.getByText("CrystalNN first-shell candidate", { exact: true })).toHaveCount(1)
  await page.getByRole("button", { name: "Use only first-shell candidates", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Include path 1", exact: true })).toBeChecked()
  for (const index of [2, 3, 4]) await expect(page.getByRole("checkbox", { name: `Include path ${index}`, exact: true })).not.toBeChecked()
  await page.getByRole("button", { name: "Save model to project", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save model to project", exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(fitRequests).toEqual([])
  expect(errors).toEqual([])
})
