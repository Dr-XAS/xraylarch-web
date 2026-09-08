import path from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test, type Page } from "@playwright/test"

const testDirectory = fileURLToPath(new URL(".", import.meta.url))
const fixturePath = path.resolve(testDirectory, "../fixtures/cu_rt01.xmu")
const duplicateFixturePath = path.resolve(testDirectory, "../fixtures/cu_rt01-duplicate-signals.csv")
const secondFixturePath = path.resolve(testDirectory, "../../../examples/xafsdata/cu_50k.xmu")
const xdiFixturePath = path.resolve(testDirectory, "../../../dylibs/XDI/cu_metal_rt.xdi")

async function mapUploadedSpectrum(page: Page) {
  const mapping = page.getByTestId("column-mapping")
  await expect(mapping).toBeVisible()
  await page.getByLabel("Energy column").selectOption("column_0001")
  await page.getByLabel("Signal column").selectOption("column_0002")
  await page.getByRole("button", { name: "Confirm mapping" }).click()
  await expect(page.getByTestId("preview-button")).toBeEnabled()
}

async function createMappedWorkspace(page: Page) {
  await page.goto("/classic", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const upload = page.getByLabel("Upload spectrum")
  await expect(upload).toBeEnabled()
  await upload.setInputFiles(fixturePath)
  await mapUploadedSpectrum(page)
}

test("restores source A across refresh and downloads both active revision attachments", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createMappedWorkspace(page)

  await page.getByTestId("preview-button").click()
  await expect(page.getByTestId("apply-button")).toBeEnabled()
  await page.getByTestId("apply-button").click()
  await expect(page.getByText("Revision 2 · active")).toBeVisible()

  await page.getByLabel("Upload spectrum").setInputFiles(secondFixturePath)
  await mapUploadedSpectrum(page)
  await page.getByTestId("preview-button").click()
  await expect(page.getByTestId("apply-button")).toBeEnabled()
  await page.getByTestId("apply-button").click()
  await expect(page.getByText("Revision 4 · active")).toBeVisible()

  await page.getByRole("listitem").filter({ hasText: "Revision 2" }).getByRole("button", { name: "Restore as new" }).click()
  await expect(page.getByText("Revision 5 · active")).toBeVisible()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()
  await expect(page.getByRole("heading", { name: "cu_rt01.xmu" })).toBeVisible()
  const previewRequestPromise = page.waitForRequest((request) => request.url().endsWith("/preview"))
  await page.getByTestId("preview-button").click()
  const previewRequest = await previewRequestPromise
  expect(previewRequest.postDataJSON().source_revision_id).toBe(1)

  const activeRevision = page.getByRole("listitem").filter({ hasText: "Revision 5 · active" })

  const csvDownloadPromise = page.waitForEvent("download")
  await activeRevision.getByRole("link", { name: "CSV" }).click()
  expect((await csvDownloadPromise).suggestedFilename()).toBe("data.csv")

  const recipeDownloadPromise = page.waitForEvent("download")
  await activeRevision.getByRole("link", { name: "Recipe JSON" }).click()
  expect((await recipeDownloadPromise).suggestedFilename()).toBe("recipe.json")
})

test("accepts a real path-selected XDI browser upload", async ({ page }) => {
  await page.goto("/classic", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const upload = page.getByLabel("Upload spectrum")
  await expect(upload).toBeEnabled()
  await upload.setInputFiles(xdiFixturePath)
  await expect(page.getByTestId("column-mapping")).toBeVisible()
  await page.getByLabel("Energy column").selectOption("column_0001")
  await page.getByLabel("Signal column").selectOption("column_0004")
  await page.getByRole("button", { name: "Confirm mapping" }).click()

  await expect(page.getByTestId("preview-button")).toBeEnabled()
})

test("maps the second duplicate-labeled signal through the real browser path", async ({ page }) => {
  await page.goto("/classic", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const upload = page.getByLabel("Upload spectrum")
  await expect(upload).toBeEnabled()
  await upload.setInputFiles(duplicateFixturePath)
  await expect(page.getByTestId("column-mapping")).toBeVisible()
  await page.getByLabel("Energy column").selectOption("column_0001")
  await page.getByLabel("Signal column").selectOption("column_0003")

  const mappingRequestPromise = page.waitForRequest((request) => request.url().endsWith("/mapping"))
  await page.getByRole("button", { name: "Confirm mapping" }).click()
  const mappingRequest = await mappingRequestPromise
  expect(mappingRequest.postDataJSON()).toMatchObject({
    energy_column: "column_0001",
    signal_column: "column_0003",
  })

  await expect(page.getByTestId("preview-button")).toBeEnabled()
  const previewResponsePromise = page.waitForResponse((response) => response.url().endsWith("/preview"))
  await page.getByTestId("preview-button").click()
  const previewResponse = await previewResponsePromise
  expect(previewResponse.status()).toBe(200)
  const preview = await previewResponse.json()
  const rawTrace = preview.plots.find((trace: { id: string }) => trace.id === "raw_mu")
  expect(rawTrace.y[0]).toBe(1.102)
  expect(rawTrace.y[0]).not.toBe(0.102)
  await expect(page.getByTestId("plot-raw_mu")).toBeVisible()
})

test("has no document overflow and keeps the processing inspector reachable at 390 by 844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/classic", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("workbench-ready")).toBeVisible()

  const processingInspector = page.getByTestId("processing-inspector")
  await processingInspector.scrollIntoViewIfNeeded()
  await expect(processingInspector).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
