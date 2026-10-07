import { expect, test } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

test("CIF names can be edited without changing their source or saved FEFF model", async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  const renameRequests: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    if (request.url().endsWith("/rename") && request.url().includes("/structures/")) {
      renameRequests.push(request.postDataJSON())
    }
  })
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.goto("/")
  const examples = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON()?.action === "example")
  const preparedModel = page.waitForResponse(response => response.url().endsWith("/model") && response.request().method() === "POST")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  expect((await examples).ok()).toBe(true)
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const prepared = await preparedModel
  expect(prepared.ok()).toBe(true)
  const initial = await prepared.json() as AthenaProject
  const record = initial.artemis_structures![0]
  const originalName = record.structure.mineral || record.structure.formula
  const cuprite = initial.groups.find(group => group.label === "Cu₂O · room temperature")!
  const model = cuprite.artemis!.model
  expect(model.paths).toHaveLength(4)
  expect(model.paths.every(path => path.content.length > 100)).toBe(true)
  const region = page.getByRole("region", { name: "Project CIF structures", exact: true })
  const renameButton = (name: string) => region.getByRole("button", { name: `Rename ${name} CIF`, exact: true })
  const nameInput = region.getByRole("textbox", { name: "CIF name", exact: true })
  const saveButton = region.getByRole("button", { name: "Save CIF name", exact: true })
  const cancelButton = region.getByRole("button", { name: "Cancel CIF rename", exact: true })

  const originalLabel = region.locator("strong").filter({ hasText: originalName })
  const labelBounds = (await originalLabel.boundingBox())!
  const renameBounds = (await renameButton(originalName).boundingBox())!
  expect(renameBounds.width).toBeLessThanOrEqual(32)
  expect(renameBounds.x).toBeGreaterThanOrEqual(labelBounds.x + labelBounds.width)
  expect(renameBounds.x - labelBounds.x - labelBounds.width).toBeLessThanOrEqual(12)
  expect(Math.abs(renameBounds.y + renameBounds.height / 2 - labelBounds.y - labelBounds.height / 2)).toBeLessThanOrEqual(1)

  await renameButton(originalName).click()
  await expect(nameInput).toBeFocused()
  await expect(nameInput).toHaveValue(originalName)
  await nameInput.fill("Discard this name")
  await cancelButton.click()
  await expect(nameInput).toBeHidden()
  await expect(renameButton(originalName)).toBeVisible()

  await renameButton(originalName).click()
  await nameInput.fill("Also discard this name")
  await nameInput.press("Escape")
  await expect(nameInput).toBeHidden()
  expect(renameRequests).toEqual([])

  const firstName = "Cu₂O reference at room temperature"
  await renameButton(originalName).click()
  await nameInput.fill("   ")
  await expect(saveButton).toBeDisabled()
  await nameInput.fill(firstName)
  const firstRename = page.waitForResponse(response => response.url().endsWith(`/structures/${record.id}/rename`))
  await nameInput.press("Enter")
  const firstResponse = await firstRename
  expect(firstResponse.ok()).toBe(true)
  const renamed = await firstResponse.json() as AthenaProject
  expect(renamed.artemis_structures!.find(item => item.id === record.id)).toEqual({ ...record, label: firstName })
  expect(renamed.groups.find(group => group.id === cuprite.id)!.artemis!.model).toEqual(model)
  await expect(renameButton(firstName)).toBeVisible()

  // A long name and all editing controls must remain usable in a narrow panel.
  const finalName = `Cu₂O reference — ${"room-temperature-reference-".repeat(3)}A`
  await page.setViewportSize({ width: 390, height: 844 })
  await renameButton(firstName).click()
  await nameInput.fill(finalName)
  for (const control of [nameInput, saveButton, cancelButton]) {
    await control.scrollIntoViewIfNeeded()
    const bounds = (await control.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391)
  }
  expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const secondRename = page.waitForResponse(response => response.url().endsWith(`/structures/${record.id}/rename`))
  await saveButton.click()
  const secondResponse = await secondRename
  expect(secondResponse.ok()).toBe(true)
  const saved = await secondResponse.json() as AthenaProject
  expect(saved.artemis_structures!.find(item => item.id === record.id)).toEqual({ ...record, label: finalName })
  expect(saved.groups.find(group => group.id === cuprite.id)!.artemis!.model).toEqual(model)
  await expect(renameButton(finalName)).toBeVisible()
  expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(renameRequests).toHaveLength(2)

  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.reload()
  await page.locator(".ath-group-select").filter({ hasText: "Cu₂O · room temperature" }).last().click()
  await page.getByRole("tab", { name: "EXAFS fitting", exact: true }).click()
  await expect(renameButton(finalName)).toBeVisible()
  await expect(page.getByRole("checkbox", { name: /^Include path \d+$/ })).toHaveCount(4)
  const viewer = page.getByRole("region", { name: "CIF structure viewer", exact: true })
  const viewedStructure = viewer.getByRole("combobox", { name: "Viewed CIF structure", exact: true })
  await expect(viewedStructure).toHaveValue(record.id)
  await expect(viewedStructure.locator("option:checked")).toContainText(finalName)

  await page.getByRole("button", { name: "Generate FEFF paths", exact: true }).click()
  const feff = page.getByRole("dialog", { name: "FEFF paths", exact: true })
  const feffStructure = feff.getByRole("combobox", { name: "FEFF crystal structure", exact: true })
  await feffStructure.selectOption(record.id)
  await expect(feffStructure.locator("option:checked")).toContainText(finalName)
  await expect(feff.getByRole("heading", { level: 4 }).filter({ hasText: finalName })).toBeVisible()
  await expect(feff.getByRole("button", { name: "Run FEFF calculation", exact: true })).toBeEnabled()
  await feff.getByRole("button", { name: "Close FEFF paths", exact: true }).click()
  expect(errors).toEqual([])
})
