import { expect, type Page } from "@playwright/test"

export async function confirmProjectSave(page: Page, filename?: string) {
  const dialog = page.getByRole("dialog", { name: "Save project", exact: true })
  await expect(dialog).toBeVisible()
  if (filename !== undefined) {
    const input = dialog.getByRole("textbox", { name: "File name", exact: true })
    await input.focus()
    await input.fill(filename)
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}
