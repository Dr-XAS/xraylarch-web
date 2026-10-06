import { expect, test, type Locator } from "@playwright/test"

async function sceneColors(viewer: Locator) {
  return viewer.locator("canvas").evaluate(element => {
    const v = (element as HTMLCanvasElement & { _3dmol_viewer?: { getModel: () => { selectedAtoms: (selection: object) => { style: { sphere?: { color?: string } } }[] } } })._3dmol_viewer
    return v?.getModel().selectedAtoms({}).reduce((counts, atom) => {
      const color = atom.style.sphere?.color ?? "none"
      counts[color] = (counts[color] ?? 0) + 1
      return counts
    }, {} as Record<string, number>)
  })
}

test("radial shells share ranges across CIF, FEFF groups and the EXAFS model", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = [], fits: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (/\/fit(?:-saved)?$/.test(request.url())) fits.push(request.url()) })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const viewer = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  await expect(viewer.getByRole("option", { name: "Radial shells", exact: true })).toBeEnabled()
  await viewer.getByRole("combobox", { name: "CIF view mode" }).selectOption("radial")
  await expect(viewer.getByText("21 atoms shown", { exact: true })).toBeVisible()
  await expect.poll(() => sceneColors(viewer)).toEqual({ "#225ea8": 1, "#06b6d4": 2, "#a78bfa": 12, "#f472b6": 6 })
  await viewer.getByRole("checkbox", { name: "Show shell 3", exact: true }).uncheck()
  await expect(viewer.getByText("15 atoms shown", { exact: true })).toBeVisible()
  await viewer.getByRole("checkbox", { name: "Show shell 1", exact: true }).uncheck()
  await expect.poll(() => sceneColors(viewer)).toEqual({ "#225ea8": 1, "#a78bfa": 12 })
  await viewer.getByRole("checkbox", { name: "Show shell 1", exact: true }).check()
  await viewer.getByRole("spinbutton", { name: "Shell search radius" }).fill("5")
  await viewer.getByRole("button", { name: "Apply shell settings", exact: true }).click()
  await expect(viewer.getByRole("table", { name: "Radial shell distances" })).toBeVisible()
  await viewer.screenshot({ path: info.outputPath("radial-shells-cuprite-desktop.png") })

  const rmin = page.getByRole("textbox", { name: "R min (Å)", exact: true })
  const rmax = page.getByRole("textbox", { name: "R max (Å)", exact: true })
  const originalRange = [await rmin.inputValue(), await rmax.inputValue()]
  await page.getByRole("button", { name: "Generate FEFF paths", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "FEFF paths" })
  await dialog.getByRole("radio", { name: "Absorber site 1", exact: true }).click()
  await dialog.locator("summary").filter({ hasText: "FEFF shell distance ranges" }).click()
  await expect(dialog.getByRole("spinbutton", { name: "Shell search radius" }).first()).toHaveValue("5")
  await dialog.getByRole("textbox", { name: "FEFF cluster radius" }).fill("6")
  await dialog.getByRole("textbox", { name: "FEFF maximum path radius" }).fill("4.1")
  await dialog.getByRole("combobox", { name: "FEFF maximum legs" }).selectOption("2")
  await dialog.getByRole("button", { name: "Run FEFF calculation", exact: true }).click()
  await expect(dialog.getByText("FEFF calculation complete", { exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(dialog.getByRole("region", { name: /^Shell 1 · .* paths$/ })).toBeVisible()
  await expect(dialog.getByRole("region", { name: /^Shell 2 · .* paths$/ })).toBeVisible()
  // This generated run differs from the bundled example, so selection is available.
  const group1 = dialog.getByRole("button", { name: "Select shell 1 paths", exact: true })
  const group2 = dialog.getByRole("button", { name: "Select shell 2 paths", exact: true })
  if (await group1.isEnabled()) await group1.click()
  if (await group2.isEnabled()) await group2.click()
  const selectedCount = await dialog.getByRole("checkbox", { name: /^Select generated /, checked: true }).count()
  expect(selectedCount).toBeGreaterThan(0)
  await dialog.screenshot({ path: info.outputPath("feff-radial-path-groups.png") })
  await dialog.getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Use only shell 2 candidates", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Include path 1", exact: true })).not.toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Include path 2", exact: true })).toBeChecked()
  await page.getByRole("button", { name: "Include shell 1 paths", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Include path 1", exact: true })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Include path 2", exact: true })).toBeChecked()
  expect([await rmin.inputValue(), await rmax.inputValue()]).toEqual(originalRange)
  await page.getByRole("button", { name: "Save model to project", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save model to project", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Exclude shell 1 paths", exact: true }).click()
  await page.getByRole("button", { name: "Reload saved model", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Include path 1", exact: true })).toBeChecked()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await viewer.screenshot({ path: info.outputPath("radial-shells-cuprite-mobile.png") })
  expect(errors).toEqual([])
  expect(fits).toEqual([])
})
