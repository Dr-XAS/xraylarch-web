import { confirmProjectSave } from "./project-save"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import type { AthenaProject } from "../../lib/athena"

// Measured Cu foil at NSLS X-11A (September 1992); provenance is in the file header.
const fixture = fileURLToPath(new URL("../../../examples/xafsdata/cu_10k.xmu", import.meta.url))

function numericRows(text: string) {
  return text.split("\n").filter(line => line.trim() && !line.startsWith("#"))
    .map(line => line.trim().split(/\s+/).map(Number))
}

test("measured spectrum survives processing, project reopen, and raw/EXAFS export", async ({ page }, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles(fixture)
  const importing = page.waitForResponse(response => response.url().endsWith("/import"))
  await page.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const importResponse = await importing
  expect(importResponse.ok()).toBe(true)
  const imported = await importResponse.json() as AthenaProject
  expect(imported.groups).toHaveLength(1)
  const original = imported.groups[0]
  expect(original.processing_error).toBeNull()
  const source = numericRows(readFileSync(fixture, "utf8"))
  expect(original.energy).toEqual(source.map(row => row[0]))
  expect(original.mu).toEqual(source.map(row => row[1]))

  const processing = page.waitForResponse(response => response.url().endsWith("/command")
    && response.request().postDataJSON().action === "parameters")
  const rbkg = page.getByRole("spinbutton", { name: "Rbkg Å", exact: true })
  await rbkg.fill("1.2")
  await rbkg.press("Tab")
  const processedResponse = await processing
  expect(processedResponse.ok()).toBe(true)
  const processed = await processedResponse.json() as AthenaProject
  const before = processed.groups[0]
  expect(processed.version).toBeGreaterThan(imported.version)
  expect(before.parameters.rbkg).toBe(1.2)
  expect(before.processing_error).toBeNull()
  expect(before.energy).toEqual(original.energy)
  expect(before.mu).toEqual(original.mu)
  expect(before.result?.arrays.chi.length).toBeGreaterThan(100)
  expect(before.result?.arrays.chi).not.toEqual(original.result?.arrays.chi)

  const saving = page.waitForEvent("download")
  await page.getByRole("button", { name: "File", exact: true }).click(); await page.getByRole("button", { name: "Save Athena project (.prj)", exact: true }).click(); await confirmProjectSave(page)
  const savedPath = info.outputPath("processed-copper.prj")
  await (await saving).saveAs(savedPath)

  // A fresh project avoids passing by redisplaying the original in-memory group.
  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "New project", exact: true }).click()
  await expect(page.getByRole("heading", { name: /^Data groups 0\b/ })).toBeVisible()
  await page.getByRole("button", { name: "Open project", exact: true }).click()
  await page.getByLabel("Open project file", { exact: true }).setInputFiles(savedPath)
  const restoring = page.waitForResponse(response => response.url().endsWith("/restore-upload"))
  await page.getByRole("dialog", { name: "Open a project" })
    .getByRole("button", { name: "Import all groups", exact: true }).click()
  const restoreResponse = await restoring
  expect(restoreResponse.ok()).toBe(true)
  const reopened = await restoreResponse.json() as AthenaProject
  expect(reopened.id).not.toBe(processed.id)
  expect(reopened.groups).toHaveLength(1)
  const after = reopened.groups[0]
  expect(after.processing_error).toBeNull()
  expect(after.energy).toEqual(before.energy)
  expect(after.mu).toEqual(before.mu)
  expect(after.parameters).toEqual(before.parameters)
  expect(after.result?.arrays).toEqual(before.result?.arrays)

  await page.reload()
  await expect(page.getByRole("heading", { name: /^Data groups 1\b/ })).toBeVisible()
  await expect(page.getByRole("spinbutton", { name: "Rbkg Å", exact: true })).toHaveValue("1.2")
  const persistedResponse = await page.request.get(`/api/backend/api/athena/projects/${reopened.id}`)
  expect(persistedResponse.ok()).toBe(true)
  expect((await persistedResponse.json()).groups[0]).toEqual(after)

  const viewer = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  await viewer.getByRole("tab", { name: "k EXAFS", exact: true }).click()
  await expect(viewer.getByLabel("k-space spectrum plot", { exact: true }).locator(".js-line").first()).toBeVisible()

  await page.getByRole("button", { name: "File", exact: true }).click()
  await page.getByRole("button", { name: "Export column data…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Export column data", exact: true })
  for (const form of ["xmu", "chi"] as const) {
    await dialog.getByLabel("Data form").selectOption(form)
    if (form === "chi") await dialog.getByLabel("Output k weight").selectOption("0")
    const download = page.waitForEvent("download")
    await dialog.getByRole("button", { name: "Download column file", exact: true }).click()
    const outputPath = info.outputPath(`reopened-${form}.dat`)
    await (await download).saveAs(outputPath)
    const rows = numericRows(readFileSync(outputPath, "utf8"))
    const x = form === "xmu" ? after.energy : after.result!.arrays.k
    const y = form === "xmu" ? after.mu : after.result!.arrays.chi
    expect(rows).toHaveLength(x.length)
    rows.forEach((row, index) => {
      // Column exports have decimal formatting; project arrays above are exact.
      expect(row[0]).toBeCloseTo(x[index], 7)
      expect(row[1]).toBeCloseTo(y[index], 8)
    })
  }
  expect(errors).toEqual([])
})
