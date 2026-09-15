import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator } from '@playwright/test'

test.use({ actionTimeout: 10000 })

async function firstCurve(region: Locator) {
  await expect(region.locator('.js-line').first()).toBeAttached()
  return region.locator('.js-plotly-plot').evaluate(node => {
    const curve = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...curve.x], y: [...curve.y] }
  })
}

for (const name of ['feff-copper-xmu.dat', 'feff-nio-xmu.dat']) {
  test(`FEFF ${name} previews photon energy and selected signal, processes, and roundtrips a native project`, async ({ page }, info) => {
    test.setTimeout(90000)
    const path = fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
    const buffer = readFileSync(path)
    const raw = buffer.toString().split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.trim().split(/\s+/).map(Number))
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles({ name: 'xmu.dat', mimeType: 'text/plain', buffer })
    const panel = page.getByRole('dialog')
    await expect(panel.getByRole('combobox', { name: 'Data type', exact: true })).toBeVisible()
    if (await panel.getByRole('button', { name: 'Use suggested columns' }).count()) {
      await panel.getByRole('button', { name: 'Use suggested columns' }).click()
    }
    await expect(panel.getByRole('combobox', { name: 'Data type', exact: true })).toHaveValue('xmudat')
    await expect(panel.getByRole('combobox', { name: 'Energy column', exact: true })).toHaveValue('column_0001')
    await expect(panel.getByRole('combobox', { name: 'Energy units', exact: true })).toHaveValue('eV')
    await expect(panel.getByLabel('Numerator mu', { exact: true })).toBeChecked()
    await expect(panel.getByLabel('Numerator chi', { exact: true })).not.toBeChecked()
    const preview = panel.getByLabel('Imported signal preview plot', { exact: true })
    const expected = { x: raw.map(r => r[0]), y: raw.map(r => r[3]) }
    await expect.poll(() => firstCurve(preview)).toEqual(expected)
    // Users can inspect the alternate FEFF mu0 column before accepting mu.
    await panel.getByRole('button', { name: 'Clear numerator', exact: true }).click()
    await panel.getByLabel('Numerator mu0', { exact: true }).check()
    await expect.poll(() => firstCurve(preview)).toEqual({ x: expected.x, y: raw.map(r => r[4]) })
    // The file's actual chi(k) remains explicitly selectable in the same UI.
    await panel.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('chi')
    await panel.getByRole('combobox', { name: 'k column', exact: true }).selectOption('column_0003')
    await panel.getByRole('button', { name: 'Clear numerator', exact: true }).click()
    await panel.getByLabel('Numerator chi', { exact: true }).check()
    await expect.poll(() => firstCurve(preview)).toEqual({ x: raw.map(r => r[2]), y: raw.map(r => r[5]) })
    await panel.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('xmudat')
    await panel.getByRole('combobox', { name: 'Energy column', exact: true }).selectOption('column_0001')
    await panel.getByRole('button', { name: 'Clear numerator', exact: true }).click()
    await panel.getByLabel('Numerator mu', { exact: true }).check()
    await expect.poll(() => firstCurve(preview)).toEqual(expected)
    await panel.screenshot({ path: info.outputPath('feff-column-preview.png') })
    const response = page.waitForResponse(r => r.url().endsWith('/import'), { timeout: 30000 })
    await panel.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const accepted = await response; expect(accepted.ok()).toBe(true)
    const project = await accepted.json(); const group = project.groups[0]
    expect(group.data_type).toBe('xmudat'); expect(group.processing_error).toBeNull()
    expect(group.energy).toEqual(expected.x); expect(group.mu).toEqual(expected.y)
    expect(group.result.arrays.norm).toEqual(expected.y)
    expect(group.result.effective.edge_step).toBe(1)
    await expect(panel).not.toBeVisible()
    await expect(page.getByText(`FEFF μ(E) · ${raw.length} points`, { exact: true })).toBeVisible()
    for (const [name, space, x, y] of [
      ['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
      ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag'],
    ]) {
      await page.getByRole('tab', { name, exact: true }).click()
      // Applying a zero display offset turns -0 into +0; both represent the
      // same plotted coordinate. All nonzero values must still match exactly.
      await expect.poll(() => firstCurve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[x], y: group.result.arrays[y].map((v: number) => v === 0 ? 0 : v) })
    }
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const saved = info.outputPath('feff-roundtrip.prj'); await (await download).saveAs(saved)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(saved)
    const dialog = page.getByRole('dialog', { name: 'Open a project' })
    const normalizedPreview = page.waitForResponse(r => r.url().includes('/preview-project/')
      && r.url().includes('/groups/') && r.url().endsWith('?mode=norm'), { timeout: 30000 })
    await dialog.getByLabel('Preview signal').selectOption('norm')
    // Wait for the scientific request, then compare the actual rendered
    // coordinates. A five-second SVG-only wait can expire during processing.
    const previewResponse = await normalizedPreview
    expect(previewResponse.ok()).toBe(true)
    const previewTrace = await previewResponse.json()
    expect({ x: previewTrace.x, y: previewTrace.y }).toEqual(expected)
    await expect.poll(() => firstCurve(dialog)).toEqual(expected)
    const restored = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 30000 })
    await dialog.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const reread = await (await restored).json()
    expect(reread.groups).toHaveLength(2)
    expect(reread.groups[1].data_type).toBe('xmudat')
    expect(reread.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
