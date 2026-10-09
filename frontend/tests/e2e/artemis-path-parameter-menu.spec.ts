import { expect, test } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

test("copies path expressions by shell or inclusion and saves them across reload", async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = [], fits: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (/\/fit(?:-saved)?$/.test(request.url())) fits.push(request.url()) })
  await page.goto("/")
  const initialSave = page.waitForResponse(response => response.url().endsWith("/model"))
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const project = await (await initialSave).json() as AthenaProject
  const group = project.groups.find(item => item.label === "Cu₂O · room temperature")!
  const model = structuredClone(group.artemis!.model)
  // A second copy of a bundled path provides a deterministic same-shell target.
  // It is excluded from fitting; the test only exercises editing and persistence.
  model.paths.push({ ...structuredClone(model.paths[0]), id: "same-shell-copy", label: "Same-shell copy", enabled: false })
  model.paths[1].enabled = false
  model.revision += 1
  const saved = await page.request.post(`/api/backend/api/artemis/projects/${project.id}/groups/${group.id}/model`, {
    data: { version: project.version, model },
  })
  expect(saved.ok(), await saved.text()).toBe(true)

  async function reopen() {
    await page.reload()
    await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
    await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
    await page.getByRole("button", { name: "Expand all path details", exact: true }).click()
  }
  await reopen()
  const field = (index: number, label: string) => page.getByLabel(`Path ${index} ${label}`, { exact: true })
  await field(1, "ΔR (Å)").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Apply to the same-shell FEFF paths", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")

  // Selecting the calculation's CIF/site resolves the same radial shell labels
  // used by the fitting editor, without running another FEFF calculation.
  await page.getByRole("button", { name: "Generate FEFF paths", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "FEFF paths", exact: true })
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  const sourceCard = page.locator("[data-path-id]").filter({ has: field(1, "ΔR (Å)") })
  await expect(sourceCard.getByText("Shell 1", { exact: true })).toBeVisible()

  const copies = [
    { key: "s02", label: "S₀²", expression: "amp * 2 / degen" },
    { key: "e0", label: "ΔE₀ (eV)", expression: "del_e0 + 1" },
    { key: "deltar", label: "ΔR (Å)", expression: "del_r * reff" },
    { key: "sigma2", label: "σ² (Å²)", expression: "sig2 + 0.001" },
  ] as const
  for (const { key, label, expression } of copies) {
    await field(1, label).fill(expression)
    await field(1, label).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Apply to the same-shell FEFF paths", exact: true }).click()
    await expect(field(5, label)).toHaveValue(expression)
    await expect(field(2, label)).toHaveValue(model.paths[1][key])
    await expect(field(3, label)).toHaveValue(model.paths[2][key])

    await field(1, label).focus()
    await page.keyboard.press("Shift+F10")
    const saving = page.waitForResponse(response => response.url().endsWith("/model") &&
      response.request().postDataJSON()?.model.paths[2][key] === expression)
    await page.getByRole("menuitem", { name: "Apply to all selected FEFF paths", exact: true }).click()
    expect((await saving).ok()).toBe(true)
    for (const index of [1, 3, 4, 5]) await expect(field(index, label)).toHaveValue(expression)
    await expect(field(2, label)).toHaveValue(model.paths[1][key])
  }
  for (const index of [2, 5]) await expect(page.getByRole("checkbox", { name: `Include path ${index}`, exact: true })).not.toBeChecked()

  await reopen()
  for (const { key, label, expression } of copies) {
    for (const index of [1, 3, 4, 5]) await expect(field(index, label)).toHaveValue(expression)
    await expect(field(2, label)).toHaveValue(model.paths[1][key])
  }
  expect(errors).toEqual([])
  expect(fits).toEqual([])
})
