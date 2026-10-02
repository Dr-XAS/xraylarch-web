import { confirmProjectSave } from "./project-save"
import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
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
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  await page.getByLabel("Parameter 1 value", { exact: true }).fill("0.85")
  await page.getByLabel("Path 1 label", { exact: true }).fill("Cu–O saved model")

  // An immediate project download flushes the latest model edits automatically.
  expect(await page.getByRole("button", { name: "Save model to project", exact: true }).count()).toBe(0)
  const projectDownload = page.waitForEvent("download")
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Save complete web project", exact: true }).click(); await confirmProjectSave(page)
  const jsonPath = info.outputPath("cuprite-autosaved.json")
  await (await projectDownload).saveAs(jsonPath)
  const saved = JSON.parse(await readFile(jsonPath, "utf8")) as AthenaProject
  const model = cuprite(saved).artemis!.model
  expect(model.paths).toHaveLength(4)
  expect(model.parameters[0].value).toBe("0.85")
  expect(model.paths[0].metadata.viewerCluster?.atoms.length).toBeGreaterThan(5)
  expect(cuprite(saved).artemis!.history).toEqual([])
  expect(fits).toEqual([])

  const larixDownload = page.waitForEvent("download")
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Export Larix session (.larix)", exact: true }).click()
  const larixPath = info.outputPath("cuprite.larix")
  await (await larixDownload).saveAs(larixPath)
  const sessionBytes = await readFile(larixPath)
  expect(sessionBytes.subarray(0, 2).toString("hex")).toBe("1f8b")
  expect(sessionBytes.length).toBeGreaterThan(1000)
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
  await expect(page.getByRole("combobox", { name: "Saved fit history", exact: true })).toHaveValue(record.id)
  const viewer = page.getByRole("region", { name: "EXAFS fit results", exact: true })
  await expect(viewer.getByText("Fitted parameters", { exact: true })).toBeVisible()
  await viewer.screenshot({ path: info.outputPath("saved-cuprite-fit.png") })
  const editor = page.getByRole("region", { name: "Artemis EXAFS fitting setup", exact: true })
  await editor.evaluate(element => { element.scrollTop = 0 })
  await editor.screenshot({ path: info.outputPath("saved-cuprite-model-desktop.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await page.getByRole("combobox", { name: "Saved fit history", exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath("saved-cuprite-model-mobile.png") })
  await page.setViewportSize({ width: 1600, height: 1100 })

  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Saved fit history", exact: true })).toHaveValue(record.id)
  const stored = await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json() as AthenaProject
  expect(cuprite(stored).artemis!.history[0]).toEqual(record)
  expect(fits).toHaveLength(1)

  const downloading = page.waitForEvent("download")
  await page.getByRole("button", { name: "Save project", exact: true }).click(); await confirmProjectSave(page)
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

test("unfinished model edits autosave across spectrum and tab switches", async ({ page }) => {
  const fits: string[] = []
  page.on("request", request => { if (/\/fit(?:-saved)?$/.test(request.url())) fits.push(request.url()) })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto("/")
  const examples = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const project = await (await examples).json() as AthenaProject
  await expect(page.getByLabel("Parameter 1 value", { exact: true })).toBeVisible()
  const saving = page.waitForResponse(response => response.url().endsWith("/model") && response.request().postDataJSON().model.parameters[0].value === "-")
  await page.getByLabel("Parameter 1 value", { exact: true }).fill("-")
  await page.getByRole("tab", { name: "Processing", exact: true }).click()
  await page.locator(".ath-group-select").first().click()
  expect((await saving).ok()).toBe(true)
  const stored = await (await page.request.get(`/api/backend/api/athena/projects/${project.id}`)).json() as AthenaProject
  expect(cuprite(stored).artemis!.model.parameters[0].value).toBe("-")
  expect(cuprite(stored).artemis!.history).toEqual([])
  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(page.getByLabel("Parameter 1 value", { exact: true })).toHaveValue("-")
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Export Larix session (.larix)", exact: true }).click()
  await expect(page.locator(".ath-error")).toContainText("Complete the model")
  expect(fits).toEqual([])
})
