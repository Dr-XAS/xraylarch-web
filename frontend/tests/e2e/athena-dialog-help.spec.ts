import { expect, test } from "@playwright/test"

test.describe("tool dialogs on a narrow touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("XAS-QA-003: opening log-ratio leaves its help closed and the reference selector reachable", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto("/", { waitUntil: "domcontentloaded" })
    const loadExamples = page.getByRole("button", { name: "Load copper examples", exact: true })
    await expect(loadExamples).toBeEnabled()
    await loadExamples.click()
    // Help icons are hidden unless instructions are shown.
    await page.getByRole("checkbox", { name: "Show instruction", exact: true }).check()
    await expect(page.getByRole("button", { name: "Analysis", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Analysis", exact: true }).click()
    await page.getByRole("button", { name: "Log-ratio & phase difference", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Log-ratio & phase difference" })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole("tooltip")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "About Log-ratio & phase difference" })).not.toBeFocused()
    const reference = dialog.getByRole("combobox", { name: "Reference spectrum" })
    // tap() fails if another element, such as an open tooltip, intercepts it.
    await reference.tap({ timeout: 5_000 })
    // Help still opens when asked for.
    await dialog.getByRole("button", { name: "About Log-ratio & phase difference" }).tap()
    await expect(page.getByRole("tooltip")).toBeVisible()
    expect(errors).toEqual([])
  })
})
