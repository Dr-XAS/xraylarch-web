import { expect, test } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

const cuprite = (project: AthenaProject) => project.groups.find(group => group.label === "Cu₂O · room temperature")!

test("real Cu2O model and fit survive reload, PRJ exchange and input changes", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const fits: string[] = []
  const exports: string[] = []
  page.on("request", request => {
    if (request.url().endsWith("/fit-saved")) fits.push(request.url())
    if (request.url().includes("/export?format=")) exports.push(request.url())
  })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  const examples = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await examples).json() as AthenaProject
  await page.getByRole("button", { name: "Open Cu₂O EXAFS", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  await page.getByLabel("Parameter 1 value", { exact: true }).fill("0.85")
  await page.getByLabel("Path 1 label", { exact: true }).fill("Cu–O saved model")

  // Every project-download entry point must require saving the edited model first.
  for (const label of ["Save Athena project (.prj)", "Save complete web project", "Save marked project (.prj)"]) {
    await page.getByRole("button", { name: "File", exact: true }).click()
    await page.getByRole("button", { name: label, exact: true }).click()
    await expect(page.locator(".ath-error")).toContainText("Save your edited EXAFS models in the EXAFS fitting tab before downloading the project.")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click()
  }
  expect(exports).toEqual([])
  const saving = page.waitForResponse(response => response.url().endsWith("/model") && response.request().method() === "POST")
  await page.getByRole("button", { name: "Save model to project", exact: true }).click()
  const savedResponse = await saving
  expect(savedResponse.ok()).toBe(true)
  const saved = await savedResponse.json() as AthenaProject
  const model = cuprite(saved).artemis!.model
  expect(model.paths).toHaveLength(4)
  expect(model.parameters[0].value).toBe("0.85")
  expect(model.paths[0].metadata.viewerCluster?.atoms.length).toBeGreaterThan(5)
  expect(cuprite(saved).artemis!.history).toEqual([])
  expect(fits).toEqual([])

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByLabel("Parameter 1 value", { exact: true })).toHaveValue("0.85")
  await expect(page.getByLabel("Path 1 label", { exact: true })).toHaveValue("Cu–O saved model")
  const fitting = page.waitForResponse(response => response.url().endsWith("/fit-saved"))
  await page.getByRole("button", { name: "Run EXAFS fit", exact: true }).click()
  const fitResponse = await fitting
  expect(fitResponse.ok()).toBe(true)
  const fitted = (await fitResponse.json()).project as AthenaProject
  const record = cuprite(fitted).artemis!.history[0]
  expect(record.result.success).toBe(true)
  expect(record.result.paths).toHaveLength(4)
  expect(record.result.k.x.length).toBeGreaterThan(100)
  expect(record.model).toEqual(model)
  await expect(page.getByLabel("Saved fit history", { exact: true })).toHaveValue(record.id)
  const viewer = page.getByRole("region", { name: "EXAFS fit results", exact: true })
  await expect(viewer.getByText("Fitted parameters", { exact: true })).toBeVisible()
  await viewer.screenshot({ path: info.outputPath("saved-cuprite-fit.png") })
  const editor = page.getByRole("region", { name: "Artemis EXAFS fitting setup", exact: true })
  await editor.evaluate(element => { element.scrollTop = 0 })
  await editor.screenshot({ path: info.outputPath("saved-cuprite-model-desktop.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await page.getByLabel("Saved fit history", { exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath("saved-cuprite-model-mobile.png") })
  await page.setViewportSize({ width: 1600, height: 1100 })

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByLabel("Saved fit history", { exact: true })).toHaveValue(record.id)
  const stored = await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json() as AthenaProject
  expect(cuprite(stored).artemis!.history[0]).toEqual(record)
  expect(fits).toHaveLength(1)

  const downloading = page.waitForEvent("download")
  await page.getByRole("button", { name: "Save project", exact: true }).click()
  const path = info.outputPath("cuprite-with-fit.prj")
  await (await downloading).saveAs(path)
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "New project", exact: true }).click()
  await expect(page.getByRole("heading", { name: /^Data groups 0\b/ })).toBeVisible()
  await page.getByRole("button", { name: "Open project", exact: true }).click()
  await page.getByLabel("Open project file", { exact: true }).setInputFiles(path)
  const restoring = page.waitForResponse(response => response.url().endsWith("/restore-upload"))
  await page.getByRole("dialog", { name: "Open a project" }).getByRole("button", { name: "Import all groups", exact: true }).click()
  const restoredResponse = await restoring
  expect(restoredResponse.ok()).toBe(true)
  const restored = await restoredResponse.json() as AthenaProject
  expect(cuprite(restored).id).not.toBe(cuprite(fitted).id)
  expect(cuprite(restored).artemis!.model).toEqual(model)
  expect(cuprite(restored).artemis!.history[0]).toEqual({ ...record, imported: true })
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(viewer.getByText(/Imported fit archive/)).toBeVisible()
  expect(fits).toHaveLength(1)

  await page.getByRole("tab", { name: "Processing", exact: true }).click()
  const processing = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "parameters")
  const rbkg = page.getByRole("spinbutton", { name: "Rbkg Å", exact: true })
  await rbkg.fill("1.2")
  await rbkg.press("Tab")
  const changedResponse = await processing
  expect(changedResponse.ok()).toBe(true)
  const changed = await changedResponse.json() as AthenaProject
  expect(cuprite(changed).artemis!.current_input_sha256).not.toBe(record.input_sha256)
  expect(cuprite(changed).artemis!.history[0]).toEqual({ ...record, imported: true })
  await expect(viewer.getByText(/Outdated input: this spectrum has changed/)).toBeVisible()
  expect(fits).toHaveLength(1)
  expect(errors).toEqual([])
})
