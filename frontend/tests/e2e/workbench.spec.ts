import { readFileSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

const fixturePath = path.resolve(__dirname, "../fixtures/cu_rt01.xmu")
const fixtureBytes = readFileSync(fixturePath)

async function createMappedWorkspace(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const upload = page.getByLabel("Upload spectrum")
  await expect(upload).toBeEnabled()
  await upload.setInputFiles({ name: "cu_rt01.xmu", mimeType: "text/plain", buffer: fixtureBytes })

  const mapping = page.getByTestId("column-mapping")
  await expect(mapping).toBeVisible()
  await page.getByLabel("Energy column").selectOption("energy")
  await page.getByLabel("Signal column").selectOption("mu")
  await page.getByRole("button", { name: "Confirm mapping" }).click()
  await expect(page.getByTestId("preview-button")).toBeEnabled()
}

test("creates a revision, restores its predecessor, and downloads the active CSV", async ({ page }) => {
  await createMappedWorkspace(page)

  await page.getByTestId("preview-button").click()
  await expect(page.getByTestId("apply-button")).toBeEnabled()
  await page.getByTestId("apply-button").click()
  await expect(page.getByText("Revision 2 · active")).toBeVisible()

  await page.getByLabel("Rbkg").fill("1.2")
  await page.getByTestId("preview-button").click()
  await expect(page.getByTestId("apply-button")).toBeEnabled()
  await page.getByTestId("apply-button").click()
  await expect(page.getByText("Revision 3 · active")).toBeVisible()

  await page.getByRole("listitem").filter({ hasText: "Revision 2" }).getByRole("button", { name: "Restore as new" }).click()
  await expect(page.getByText("Revision 4 · active")).toBeVisible()

  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("link", { name: "CSV" }).first().click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("data.csv")
})

test("has no document overflow and keeps the processing inspector reachable at 390 by 844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const processingInspector = page.getByTestId("processing-inspector")
  await processingInspector.scrollIntoViewIfNeeded()
  await expect(processingInspector).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
