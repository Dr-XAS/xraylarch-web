import { expect, test, type Locator } from "@playwright/test"
import type { AthenaProject } from "../../lib/athena"

type Trace = { name: string; x: number[]; y: number[]; line: { color: string; dash: string }; yaxis?: string; meta?: { legendLabel: string } }

async function traces(viewer: Locator, space: "R" | "q") {
  const plot = viewer.getByLabel(`${space}-space spectrum plot`, { exact: true })
  await expect(plot.locator(".js-line").first()).toBeAttached()
  return plot.locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { data: Trace[] }).data.map(trace => ({
      name: trace.meta?.legendLabel ?? trace.name, x: [...trace.x], y: [...trace.y],
      line: trace.line, yaxis: trace.yaxis ?? "y",
    })),
  )
}

test("component checkboxes overlay spectra independently and fit desktop and mobile in both themes", async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.goto("/")
  const loading = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "example")
  await page.getByRole("button", { name: "Load copper examples", exact: true }).click()
  const response = await loading
  expect(response.ok()).toBe(true)
  const project = await response.json() as AthenaProject
  const first = project.groups[0]
  await page.locator(`[data-group-id="${first.id}"] .ath-group-select`).click()
  const single = page.getByRole("region", { name: "Single spectrum viewer", exact: true })
  const multiple = page.getByRole("region", { name: "Multiple spectra viewer", exact: true })
  const components = (viewer: Locator) => viewer.getByRole("group", { name: "Complex components", exact: true })
  const choice = (viewer: Locator, name: string) => components(viewer).getByRole("checkbox", { name, exact: true })

  for (const viewer of [single, multiple]) {
    await viewer.getByRole("tab", { name: "R Fourier", exact: true }).click()
    await expect(choice(viewer, "Magnitude")).toBeChecked()
    await expect(choice(viewer, "Real")).not.toBeChecked()
    await expect(components(viewer).getByRole("checkbox")).toHaveCount(4)
  }
  await choice(single, "Real").check()
  await expect(choice(multiple, "Real")).not.toBeChecked()
  await expect.poll(async () => (await traces(single, "R")).length).toBe(2)
  await choice(multiple, "Real").check()
  const marked = project.groups.filter(group => group.marked)
  await expect.poll(async () => (await traces(multiple, "R")).length).toBe(marked.length * 2)
  for (const [viewer, groups] of [[single, [first]], [multiple, marked]] as const) {
    const plotted = await traces(viewer, "R")
    for (const group of groups) {
      const magnitude = plotted.find(trace => trace.name === `|χ(R)| · ${group.label}`)!
      const real = plotted.find(trace => trace.name === `Re[χ(R)] · ${group.label}`)!
      expect(magnitude).toBeDefined()
      expect(real).toBeDefined()
      expect(real.line.color).toBe(magnitude.line.color)
      expect(real.line.dash).not.toBe(magnitude.line.dash)
      expect(real.x).toEqual(magnitude.x)
      expect(real.y).not.toEqual(magnitude.y)
    }
  }

  // Phase has its own units; combining it with amplitude must expose the radians axis.
  await choice(single, "Phase").check()
  await expect.poll(async () => (await traces(single, "R")).find(trace => trace.name.startsWith("Phase"))?.yaxis).toBe("y2")
  await expect.poll(() => single.getByLabel("R-space spectrum plot", { exact: true }).locator(".js-plotly-plot").evaluate(element =>
    (element as HTMLElement & { layout: { yaxis2: { title: { text: string } } } }).layout.yaxis2.title.text,
  )).toContain("rad")
  await expect(choice(multiple, "Phase")).not.toBeChecked()
  await choice(single, "Phase").uncheck()

  // q retains a separate selection and includes the full measured k curve with Real.
  await single.getByRole("tab", { name: "q Back transform", exact: true }).click()
  await expect(choice(single, "Real + χ(k)")).toBeChecked()
  await expect(choice(single, "Magnitude")).not.toBeChecked()
  await choice(single, "Magnitude").check()
  await expect.poll(async () => (await traces(single, "q")).length).toBe(3)
  const qTraces = await traces(single, "q")
  const measured = qTraces.find(trace => trace.name === `χ(k) · ${first.label}`)!
  expect(measured.x).toEqual(first.result!.arrays.k)
  expect(measured.y).toEqual(first.result!.arrays.weighted_chi)
  expect(new Set(qTraces.map(trace => trace.line.color)).size).toBe(1)
  expect(new Set(qTraces.map(trace => trace.line.dash)).size).toBe(3)
  await expect(multiple.getByRole("tab", { name: "R Fourier", exact: true })).toHaveAttribute("aria-selected", "true")
  await single.getByRole("tab", { name: "R Fourier", exact: true }).click()
  await expect(choice(single, "Magnitude")).toBeChecked()
  await expect(choice(single, "Real")).toBeChecked()

  await choice(single, "Magnitude").uncheck()
  await choice(single, "Real").uncheck()
  await expect(single.getByRole("heading", { name: "No components selected", exact: true })).toBeVisible()
  await expect(multiple.getByLabel("R-space spectrum plot", { exact: true }).locator(".js-line").first()).toBeAttached()
  // Native checkbox keyboard behavior also toggles the plotted component.
  await choice(single, "Magnitude").focus()
  await page.keyboard.press("Space")
  await expect(choice(single, "Magnitude")).toBeChecked()
  await choice(single, "Real").check()

  for (const viewport of [{ name: "desktop", width: 1500, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("radio", { name: `${theme} theme`, exact: true }).click()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase())
      for (const [name, viewer] of [["single", single], ["multiple", multiple]] as const) {
        await viewer.scrollIntoViewIfNeeded()
        await expect.poll(async () => (await traces(viewer, "R")).length).toBe(name === "single" ? 2 : marked.length * 2)
        const bounds = await components(viewer).evaluate(element => {
          const container = element.getBoundingClientRect()
          return {
            fits: element.scrollWidth <= element.clientWidth + 1,
            labelsFit: [...element.querySelectorAll("label")].every(label => {
              const child = label.getBoundingClientRect()
              return child.left >= container.left && child.right <= container.right + 1
            }),
          }
        })
        expect(bounds).toEqual({ fits: true, labelsFit: true })
        const suffix = `${viewport.name}-${theme.toLowerCase()}`
        await viewer.screenshot({ path: info.outputPath(`${name}-viewer-${suffix}.png`) })
        await components(viewer).screenshot({ path: info.outputPath(`${name}-components-${suffix}.png`) })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }
  }
  expect(errors).toEqual([])
})
