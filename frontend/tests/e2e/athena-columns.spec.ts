import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test, type Page, type Locator } from "@playwright/test"

// Measured Cu foil, transformed into deterministic detector counts. This is
// not a fabricated beamline measurement: its inverse formula is the oracle.
const measured = readFileSync(fileURLToPath(new URL("../../../examples/xafsdata/cu_10k.xmu", import.meta.url)), "utf8")
  .split(/\r?\n/).filter(line => /^\s*[+\-.]?\d/.test(line)).map(line => line.trim().split(/\s+/).slice(0, 2).map(Number))
if (measured.length !== 612 || measured.some(row => row.some(v => !Number.isFinite(v)))) throw new Error("Invalid Cu fixture")
const content = Buffer.from("# Cu foil 10K detector arithmetic fixture\n# energy i0 it detA detB ref zero\n" + measured.map(([e, mu]) =>
  [e / 1000, 10000, 10000 * Math.exp(-mu), 10000 * mu, 5000 * mu, 10000 * Math.exp(-mu), 0].join(" ")).join("\n"))

async function openColumns(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Import data", exact: true }).click()
  await page.getByLabel("Choose data files", { exact: true }).setInputFiles({ name: "cu-detectors.dat", mimeType: "text/plain", buffer: content })
  const panel = page.getByRole("dialog")
  await expect(panel.getByRole("combobox", { name: "Energy units", exact: true })).toBeVisible()
  // Each independent arithmetic case starts from file suggestions. Persistence
  // across real imports is exercised separately, without clearing shared state.
  if (await panel.getByRole('button', { name: 'Use suggested columns' }).count()) {
    await panel.getByRole('button', { name: 'Use suggested columns' }).click()
  }
  await expect(panel.getByRole("combobox", { name: "Energy units", exact: true })).toHaveValue("keV")
  await expect(panel.getByRole("combobox", { name: "Measurement", exact: true })).toHaveValue("transmission")
  await panel.getByLabel("Denominator it", { exact: true }).check()
  return panel
}
async function curves(panel: Locator) {
  await expect(panel.getByLabel("Imported signal preview plot")).toHaveAttribute("aria-busy", "false")
  const plot = panel.getByLabel("Imported signal preview plot").locator(".js-plotly-plot")
  await expect(plot).toBeVisible()
  // A constant signal has an SVG path with zero geometric height even
  // though its stroke is visible. It must still be a valid preview.
  await expect(plot.locator(".js-line").first()).toBeAttached()
  return plot.evaluate(node => (node as HTMLElement & { data: { x: number[]; y: number[]; name: string }[] }).data.map(t => ({ x: [...t.x], y: [...t.y], name: t.name })))
}

test('official MRCAT quick scan compares original and rebinned data and imports a matching batch', async ({ page }, info) => {
  test.setTimeout(90000)
  const data = readFileSync(fileURLToPath(new URL('../../../backend/tests/fixtures/demeter-uhup.101', import.meta.url)))
  const raw = data.toString().split(/\r?\n/).filter(line => /^\s*16999|^\s*17\d{3}\./.test(line)).map(line => line.trim().split(/\s+/).map(Number))
  expect(raw).toHaveLength(2006)
  await page.goto('/')
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles([
    { name: 'uhup.101', mimeType: 'text/plain', buffer: data },
    { name: 'uhup-copy.101', mimeType: 'text/plain', buffer: data },
  ])
  const panel = page.getByRole('dialog')
  await expect(panel.getByRole('combobox', { name: 'Measurement', exact: true })).toBeVisible()
  // This oracle uses native default sign/scale, not another test's accepted
  // import choices. Changed layouts intentionally retain the last multiplier.
  if (await panel.getByRole('button', { name: 'Use suggested columns' }).count()) {
    await panel.getByRole('button', { name: 'Use suggested columns' }).click()
  }
  await panel.getByRole('combobox', { name: 'Measurement', exact: true }).selectOption('transmission')
  await panel.getByRole('button', { name: 'Clear numerator', exact: true }).click()
  await panel.getByLabel('Numerator mcs3', { exact: true }).check()
  await panel.getByRole('button', { name: 'Clear denominator', exact: true }).click()
  await panel.getByLabel('Denominator mcs4', { exact: true }).check()
  await panel.getByText('Rebin quick scans', { exact: true }).click()
  await panel.getByRole('button', { name: 'Use Athena default grid' }).click()
  await panel.getByLabel('Perform rebinning', { exact: true }).check()
  await expect.poll(async () => (await curves(panel)).length).toBe(2)
  const plotted = await curves(panel)
  expect(plotted[0].x).toHaveLength(2006)
  expect(plotted[1].x).toHaveLength(396)
  for (const i of [0, 24, 200, 1000, 2005]) {
    expect(plotted[0].x[i]).toBe(raw[i][0])
    expect(plotted[0].y[i]).toBeCloseTo(Math.log(raw[i][1] / raw[i][2]), 12)
  }
  await panel.getByLabel('Plot original data', { exact: true }).uncheck()
  expect((await curves(panel))[0]).toEqual(plotted[1])
  await panel.getByLabel('Plot original data', { exact: true }).check()
  await panel.screenshot({ path: info.outputPath('quick-scan-rebin-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByText('Preview selected columns', { exact: true }).scrollIntoViewIfNeeded()
  await expect.poll(async () => panel.getByLabel('Imported signal preview plot').evaluate(node => {
    const svg = node.querySelector('.main-svg')
    return svg ? Math.abs(svg.getBoundingClientRect().width - node.getBoundingClientRect().width) : 1000
  })).toBeLessThan(4)
  await expect(panel.locator('.js-line').first()).toBeAttached()
  await panel.screenshot({ path: info.outputPath('quick-scan-rebin-mobile.png') })
  await page.setViewportSize({ width: 1400, height: 1000 })
  const accepted: Promise<any>[] = []
  page.on('response', r => { if (r.url().endsWith('/import')) accepted.push(r.json()) })
  await panel.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  await expect(panel).not.toBeVisible()
  const projects = await Promise.all(accepted)
  expect(projects).toHaveLength(2)
  expect(projects[1].groups).toHaveLength(2)
  for (const group of projects[1].groups) {
    expect(group.energy).toEqual(plotted[1].x)
    expect(group.mu).toEqual(plotted[1].y)
    expect(group.processing_error).toBeNull()
    expect(group.source.rebin_original.energy).toEqual(raw.map(row => row[0]))
    expect(group.source.rebin_original.column_arrays.column_0002).toEqual(raw.map(row => row[1]))
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
})

test("column preview, reference, invalid mapping recovery and imported values", async ({ page }, info) => {
  test.setTimeout(90000)
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  const panel = await openColumns(page)
  const signal = await curves(panel)
  expect(signal[0].x).toHaveLength(measured.length)
  for (const i of [0, 200, 400, measured.length - 1]) {
    expect(signal[0].x[i]).toBeCloseTo(measured[i][0], 9)
    expect(signal[0].y[i]).toBeCloseTo(measured[i][1], 12)
  }
  await panel.getByText(/^Source file contents/).click()
  await expect(panel.locator("pre")).toContainText("energy i0 it detA detB ref zero")
  await panel.getByText(/^Source file contents/).click()
  await panel.getByRole("button", { name: "Clear denominator", exact: true }).click()
  await panel.getByLabel("Denominator zero", { exact: true }).check()
  await expect(panel.getByRole("alert")).toContainText("zero detector counts")
  await expect(panel.getByLabel("Imported signal preview plot").locator(".js-line")).toHaveCount(0)
  await panel.getByRole("button", { name: "Clear denominator", exact: true }).click()
  await panel.getByLabel("Denominator it", { exact: true }).check()
  await panel.getByText("Reference channel & ordering", { exact: true }).click()
  await panel.getByRole("combobox", { name: "reference numerator", exact: true }).selectOption({ label: "i0 · column 2" })
  await panel.getByRole("combobox", { name: "reference denominator", exact: true }).selectOption({ label: "ref · column 6" })
  await expect.poll(async () => (await curves(panel)).length).toBe(2)
  await panel.getByLabel("Reference natural log", { exact: true }).uncheck()
  const referenceRatio = await curves(panel)
  expect(referenceRatio[1].y[200]).toBeCloseTo(Math.exp(measured[200][1]), 10)
  await panel.getByLabel("Reference natural log", { exact: true }).check()
  const beforeImport = await curves(panel)
  await panel.getByRole("button", { name: "Import spectrum", exact: true }).scrollIntoViewIfNeeded()
  const title = await panel.getByRole("heading", { name: "Import spectra", exact: true }).boundingBox()
  const previewTitle = await panel.getByText("Preview selected columns", { exact: true }).boundingBox()
  expect(previewTitle!.y).toBeGreaterThan(title!.y + title!.height)
  await panel.screenshot({ path: info.outputPath("column-preview-desktop.png") })
  const accepted = page.waitForResponse(r => r.url().endsWith("/import"))
  await panel.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const result = await accepted
  expect(result.ok()).toBe(true)
  const project = await result.json()
  expect(project.groups).toHaveLength(2)
  for (let i = 0; i < 2; i++) {
    expect(project.groups[i].energy).toEqual(beforeImport[i].x)
    expect(project.groups[i].mu).toEqual(beforeImport[i].y)
    expect(project.groups[i].processing_error).toBeNull()
  }
  expect(project.groups[0].reference_id).toBe(project.groups[1].id)
  expect(project.groups[1].marked).toBe(false)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Data groups 2", exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test("MED range selection, pause/replot, separate channel import and mobile preview", async ({ page }, info) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openColumns(page)
  await curves(panel)
  await panel.getByLabel("Pause plotting", { exact: true }).check()
  await panel.getByRole("combobox", { name: "Measurement", exact: true }).selectOption("fluorescence")
  await panel.getByRole("button", { name: "Clear denominator", exact: true }).click()
  await panel.getByLabel("Denominator i0", { exact: true }).check()
  await panel.getByRole("button", { name: "Clear numerator", exact: true }).click()
  await panel.getByLabel("Numerator column numbers", { exact: true }).fill("4-5")
  await panel.getByRole("button", { name: "Select range", exact: true }).click()
  await panel.getByLabel("Save each channel as its own group", { exact: true }).check()
  await expect(panel.getByRole("status").filter({ hasText: 'previous column selection' })).toBeVisible()
  await panel.getByRole("button", { name: "Replot", exact: true }).click()
  await expect.poll(async () => (await curves(panel)).length).toBe(2)
  const selected = await curves(panel)
  expect(selected[0].y[200]).toBeCloseTo(measured[200][1], 12)
  expect(selected[1].y[200]).toBeCloseTo(measured[200][1] / 2, 12)
  await panel.getByLabel("Imported signal preview plot").scrollIntoViewIfNeeded()
  const box = await panel.getByLabel("Imported signal preview plot").boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await panel.screenshot({ path: info.outputPath("column-preview-mobile.png") })
  const accepted = page.waitForResponse(r => r.url().endsWith("/import"))
  await panel.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const result = await accepted
  expect(result.ok()).toBe(true)
  const project = await result.json()
  expect(project.groups).toHaveLength(2)
  expect(project.groups[0].label).toContain("deta")
  expect(project.groups[1].label).toContain("detb")
  expect(project.groups[0].mu).toEqual(selected[0].y)
  expect(project.groups[1].mu).toEqual(selected[1].y)
})

test("native denominator sums and sign/scale controls affect preview and imported data", async ({ page }) => {
  const panel = await openColumns(page)
  await panel.getByRole("button", { name: "Clear numerator", exact: true }).click()
  await panel.getByLabel("Numerator it", { exact: true }).check()
  await panel.getByRole("button", { name: "Clear denominator", exact: true }).click()
  await panel.getByLabel("Denominator i0", { exact: true }).check()
  await panel.getByLabel("Denominator ref", { exact: true }).check()
  await panel.getByLabel("Invert signal", { exact: true }).check()
  await panel.getByRole("spinbutton", { name: "Multiplicative constant", exact: true }).fill("2")
  const scaled = await curves(panel)
  for (const i of [0, 200, 400, measured.length - 1]) {
    expect(scaled[0].y[i]).toBeCloseTo(2 * (measured[i][1] + Math.log1p(Math.exp(-measured[i][1]))), 10)
  }
  const accepted = page.waitForResponse(r => r.url().endsWith("/import"))
  await panel.getByRole("button", { name: "Import spectrum", exact: true }).click()
  const result = await accepted; expect(result.ok()).toBe(true)
  const g = (await result.json()).groups[0]
  expect(g.mu).toEqual(scaled[0].y)
  expect(g.source.mapping.denominator).toHaveLength(2)
  expect(g.source.mapping.signal_multiplier).toBe(2)
  expect(g.source.mapping.invert).toBe(true)
  expect(g.multiplier).toBe(1)
  expect(g.processing_error).toBeNull()
})

test("switching to chi clears absorption transforms and keeps raw k values", async ({ page }) => {
  const panel = await openColumns(page)
  await panel.getByLabel("Invert signal", { exact: true }).check()
  await panel.getByRole("spinbutton", { name: "Multiplicative constant", exact: true }).fill("3")
  await panel.getByRole("combobox", { name: "Data type", exact: true }).selectOption("chi")
  await expect(panel.getByRole("combobox", { name: "Measurement", exact: true })).toHaveValue("mu")
  await expect(panel.getByRole("combobox", { name: "Measurement", exact: true })).toBeDisabled()
  await expect(panel.getByLabel("Invert signal", { exact: true })).not.toBeChecked()
  await expect(panel.getByRole("spinbutton", { name: "Multiplicative constant", exact: true })).toHaveValue("1")
  await expect(panel.getByRole("spinbutton", { name: "Multiplicative constant", exact: true })).toBeDisabled()
  const raw = await curves(panel)
  expect(raw[0].x[0]).toBeCloseTo(measured[0][0] / 1000, 12)
  expect(raw[0].y.every(y => y === 10000)).toBe(true)
})

test("imports a batch with standard parameters, reference alignment and sample-only marking", async ({ page }, info) => {
  test.setTimeout(90000)
  const panel = await openColumns(page)
  await panel.getByText('Reference channel & ordering', { exact: true }).click()
  await panel.getByRole('combobox', { name: 'reference numerator', exact: true }).selectOption({ label: 'i0 · column 2' })
  await panel.getByRole('combobox', { name: 'reference denominator', exact: true }).selectOption({ label: 'ref · column 6' })
  let accepted = page.waitForResponse(r => r.url().endsWith('/import'))
  await panel.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  const initialResponse = await accepted; expect(initialResponse.ok()).toBe(true)
  const initial = await initialResponse.json()
  expect(initial.groups.map((g: { marked: boolean }) => g.marked)).toEqual([false, false])
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles([3.5, 4.5].map(shift => ({
    name: `shifted-${shift}.dat`, mimeType: 'text/plain', buffer: Buffer.from('# energy sample ref\n' +
      measured.map(([e, mu]) => [(e + shift) / 1000, 2 * mu, mu].join(' ')).join('\n')),
  })))
  const batch = page.getByRole('dialog')
  await expect(batch.getByRole('combobox', { name: 'Energy units', exact: true })).toHaveValue('keV')
  await batch.getByText('Reference channel & ordering', { exact: true }).click()
  await batch.getByRole('combobox', { name: 'reference numerator', exact: true }).selectOption({ label: 'ref · column 3' })
  await batch.getByLabel('Reference natural log', { exact: true }).uncheck()
  await batch.getByText('Preprocess imported groups', { exact: true }).click()
  await batch.getByRole('combobox', { name: 'Preprocessing standard', exact: true }).selectOption(initial.groups[0].id)
  await batch.getByLabel('Set parameters to the standard', { exact: true }).check()
  await batch.getByLabel('Align to the standard', { exact: true }).check()
  await batch.getByLabel('Mark each imported sample', { exact: true }).check()
  await expect(batch.getByText(/original energy axis/)).toBeVisible()
  const beforePreprocessing = await curves(batch)
  expect(beforePreprocessing).toHaveLength(2)
  expect(beforePreprocessing[0].x[200]).toBeCloseTo(measured[200][0] + 3.5, 9)
  expect(beforePreprocessing[0].y[200]).toBeCloseTo(2 * measured[200][1], 12)
  expect(beforePreprocessing[1].y[200]).toBeCloseTo(measured[200][1], 12)
  await batch.screenshot({ path: info.outputPath('import-preprocessing.png') })
  const imports: Promise<Record<string, any>>[] = []
  page.on('response', response => { if (response.url().endsWith('/import')) imports.push(response.json()) })
  await batch.getByRole('button', { name: 'Import spectrum', exact: true }).click()
  await expect(batch).not.toBeVisible()
  expect(imports).toHaveLength(2)
  const finished = await imports[1]
  expect(finished.groups).toHaveLength(6)
  expect(finished.groups.slice(0, 2)).toEqual(initial.groups)
  for (const [index, shift] of [[2, -3.5], [4, -4.5]]) {
    const sample = finished.groups[index], ref = finished.groups[index + 1]
    expect(sample.marked).toBe(true); expect(ref.marked).toBe(false)
    expect(sample.parameters.energy_shift).toBe(shift)
    expect(ref.parameters.energy_shift).toBe(shift)
    expect(sample.source.import_preprocessing.alignment.used_references).toBe(true)
    expect(sample.source.import_preprocessing.copy_parameters).toBe(true)
    expect(sample.processing_error).toBeNull(); expect(ref.processing_error).toBeNull()
    expect(sample.mu[200]).toBeCloseTo(2 * measured[200][1], 12)
    expect(sample.reference_id).toBe(ref.id)
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Data groups 6', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles({ name: 'new-choice.dat', mimeType: 'text/plain', buffer: content })
  await page.getByText('Preprocess imported groups', { exact: true }).click()
  await expect(page.getByLabel('Mark each imported sample', { exact: true })).toBeChecked()
})
