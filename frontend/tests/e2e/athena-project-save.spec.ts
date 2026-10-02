import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

import type { AthenaProject } from "../../lib/athena"
import { confirmProjectSave } from "./project-save"

const fixture = fileURLToPath(new URL("../../../examples/xafsdata/cu_10k.xmu", import.meta.url))

test("project saves confirm the filename and cancel without exporting", async ({ page }, info) => {
  test.setTimeout(90_000)
  const exports: string[] = []
  const downloads: string[] = []
  page.on("request", request => {
    if (request.url().includes("/export?format=")) exports.push(request.url())
  })
  page.on("download", download => downloads.push(download.suggestedFilename()))
  await page.goto("/")
  const instructions = page.getByRole("checkbox", { name: "Show instruction" })
  await expect(instructions).not.toBeChecked()
  await expect(page.getByRole("button", { name: "About Larch-Web" })).toHaveCount(0)
  await instructions.check()
  await expect(page.getByRole("button", { name: "About Larch-Web" })).toBeVisible()
  await instructions.uncheck()
  await expect(page.getByRole("button", { name: "About Larch-Web" })).toHaveCount(0)
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles(fixture)
  const importing = page.waitForResponse(response => response.url().endsWith("/import"))
  await page.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const imported = await (await importing).json() as AthenaProject
  const dialog = page.getByRole("dialog", { name: "Save project", exact: true })
  const filename = dialog.getByRole("textbox", { name: "File name", exact: true })

  await page.getByRole("button", { name: "Save project", exact: true }).click()
  await expect(filename).toHaveValue(`${imported.name}.json`)
  await dialog.screenshot({ path: "/tmp/xraylarch-project-save-desktop.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toBeVisible()
  const mobileDialog = await dialog.boundingBox()
  expect(mobileDialog!.x).toBeGreaterThanOrEqual(0)
  expect(mobileDialog!.x + mobileDialog!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: "/tmp/xraylarch-project-save-mobile.png" })
  await page.setViewportSize({ width: 1280, height: 720 })
  await filename.focus()
  await filename.fill("cancelled.prj")
  await expect(filename).toHaveValue("cancelled.prj")
  await filename.press("ArrowLeft")
  await filename.press("x")
  await expect(filename).toHaveValue("cancelled.prxj")
  await filename.press("ControlOrMeta+z")
  await expect(filename).toHaveValue("cancelled.prj")
  await filename.press("ControlOrMeta+Shift+z")
  await expect(filename).toHaveValue("cancelled.prxj")
  await filename.fill("cancelled.prj")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.waitForEvent("download", { timeout: 500 }).then(() => true, () => false)).toBe(false)
  expect(exports).toEqual([])
  expect(downloads).toEqual([])

  await page.getByRole("button", { name: "Save project", exact: true }).click()
  await expect(filename).toHaveValue(`${imported.name}.json`)
  const completeDownloading = page.waitForEvent("download")
  await confirmProjectSave(page, "copper beamtime.json")
  const completeDownload = await completeDownloading
  expect(completeDownload.suggestedFilename()).toBe("copper beamtime.json")
  await completeDownload.saveAs(info.outputPath("copper beamtime.json"))

  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Save Athena project (.prj)", exact: true }).click()
  await expect(filename).toHaveValue(`${imported.name}.prj`)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(exports).toHaveLength(1)

  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Save complete web project", exact: true }).click()
  await expect(filename).toHaveValue(`${imported.name}.json`)
  const jsonDownloading = page.waitForEvent("download")
  await confirmProjectSave(page, "copper complete.json")
  const jsonDownload = await jsonDownloading
  expect(jsonDownload.suggestedFilename()).toBe("copper complete.json")
  const jsonPath = info.outputPath("copper complete.json")
  await jsonDownload.saveAs(jsonPath)
  const saved = JSON.parse(await readFile(jsonPath, "utf8")) as AthenaProject
  expect(saved.name).toBe(imported.name)
  expect(saved.groups).toEqual(imported.groups)

  await page.getByRole("checkbox", { name: "Mark all groups", exact: true }).check()
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Save marked project (.prj)", exact: true }).click()
  await expect(filename).toHaveValue(`${imported.name}-marked.prj`)
  const markedDownloading = page.waitForEvent("download")
  await confirmProjectSave(page)
  expect((await markedDownloading).suggestedFilename()).toBe(`${imported.name}-marked.prj`)
  expect(exports.map(url => new URL(url).search)).toEqual([
    "?format=json", "?format=json", "?format=prj&marked_only=true",
  ])
})
