import { expect, test } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

test("custom CIF upload renders, survives reload and generates FEFF through the proxy", async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.goto("/")
  const exampleResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const initial = await (await exampleResponse).json() as AthenaProject
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const source = await page.request.get("/api/backend/api/artemis/structures/13088")
  expect(source.ok()).toBe(true)
  const { cif } = await source.json() as { cif: string }
  const filename = "my-copper.cif"
  const region = page.getByRole("region", { name: "Project CIF structures", exact: true })
  const attachResponse = page.waitForResponse(response => response.url().endsWith(`/projects/${initial.id}/structures`) && response.request().method() === "POST")
  // Use the actual picker button, then supply a bundled reference as a user file.
  const picker = page.waitForEvent("filechooser")
  await region.getByRole("button", { name: "Upload CIF", exact: true }).click()
  await (await picker).setFiles({ name: filename, mimeType: "chemical/x-cif", buffer: Buffer.from(cif) })
  const attachedResponse = await attachResponse
  expect(attachedResponse.ok()).toBe(true)
  const attached = await attachedResponse.json() as AthenaProject
  const record = attached.artemis_structures!.find(item => item.provider === "uploaded")!
  expect(record.structure.cif).toBe(cif)
  expect(record.structure.filename).toBe(filename)
  const dialog = page.getByRole("dialog", { name: "Crystal structures", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Attached to project", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Reset view", exact: true })).toBeEnabled()
  await expect(dialog.getByText(`Uploaded CIF · ${filename}`, { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const uploadButton = dialog.getByRole("button", { name: "Upload CIF", exact: true })
  await uploadButton.scrollIntoViewIfNeeded()
  const bounds = (await uploadButton.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await dialog.getByRole("button", { name: "Close CIF search", exact: true }).click()
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(region.getByText(`Uploaded CIF · ${filename}`, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Generate FEFF paths", exact: true }).click()
  const feff = page.getByRole("dialog", { name: "FEFF paths", exact: true })
  await feff.getByRole("combobox", { name: "FEFF crystal structure", exact: true }).selectOption(record.id)
  await expect(feff.getByRole("button", { name: "Run FEFF calculation", exact: true })).toBeEnabled()
  const calculation = page.waitForResponse(response => response.url().endsWith("/feff/jobs") && response.request().method() === "POST")
  await feff.getByRole("button", { name: "Run FEFF calculation", exact: true }).click()
  const result = await calculation
  expect(result.ok()).toBe(true)
  expect(result.request().postDataJSON().attachment_id).toBe(record.id)
  await expect(feff.getByRole("button", { name: /Add selected paths/ })).toBeVisible({ timeout: 60_000 })
  await expect(feff.getByRole("alert")).toHaveCount(0)
  expect(errors).toEqual([])
})
