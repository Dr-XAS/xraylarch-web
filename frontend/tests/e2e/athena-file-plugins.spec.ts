import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator } from '@playwright/test'

async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const c = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...c.x], y: [...c.y] }
  })
}
for (const name of ['x10c', 'lytle']) {
  test(`${name} official input converts, previews, downloads originals, and exchanges PRJ`, async ({ page }, info) => {
    test.setTimeout(90000)
    const path = fileURLToPath(new URL(`../../../backend/tests/fixtures/demeter-${name}.dat`, import.meta.url))
    const input = readFileSync(path)
    const lines = input.toString().replaceAll('\0', '').split(/\r?\n/)
    const start = name === 'x10c' ? lines.findIndex(l => l.includes('DATA START')) + 1 : 7
    const rows = lines.slice(start).filter(l => l.trim()).map(l => l.replace(/([eE][-+]\d{1,2})-/g, '$1 -').trim().split(/\s+/).map(Number))
    const x = rows.map(r => name === 'x10c' ? r[0] : Number((12398.61 / (3.84034 * Math.sin(r[0] / (4000 * 57.29577951)))).toPrecision(6)))
    const y = rows.map(r => Math.log(r[name === 'x10c' ? 3 : 1] / r[name === 'x10c' ? 5 : 2]))
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
    const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
    const enable = registry.getByRole('checkbox', { name: `Enable ${name === 'x10c' ? 'X10C' : 'Lytle'}` })
    await expect(enable).toBeEnabled()
    if (!await enable.isChecked()) {
      const saved = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
      await enable.click(); expect((await saved).ok()).toBe(true)
      await expect(enable).toBeChecked()
    }
    await registry.getByRole('button', { name: 'Close registry', exact: true }).click()
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    const picker = page.getByLabel('Choose data files', { exact: true }); await expect(picker).toBeEnabled()
    await picker.setInputFiles(path)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('File conversion')).toContainText(name === 'x10c' ? 'NSLS beamline X10C' : 'Lytle database')
    if (await dialog.getByRole('button', { name: 'Use suggested columns' }).count()) {
      await dialog.getByRole('button', { name: 'Use suggested columns' }).click()
    }
    await expect(dialog.getByLabel('Natural log', { exact: true })).toBeChecked()
    const preview = dialog.getByLabel('Imported signal preview plot', { exact: true })
    await expect.poll(async () => (await curve(preview)).x).toEqual(x)
    const displayed = await curve(preview)
    expect(displayed.y).toHaveLength(y.length)
    displayed.y.forEach((value, i) => expect(Math.abs(value - y[i])).toBeLessThan(1e-12))
    // Inspect the actual files, including all bytes beyond the visible excerpt.
    await dialog.getByText('Source file contents (first section)', { exact: true }).click()
    const originalDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
    const originalPath = info.outputPath('original.dat'); await (await originalDownload).saveAs(originalPath)
    expect(readFileSync(originalPath)).toEqual(input)
    await dialog.getByText('Source file contents (first section)', { exact: true }).click()
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    const convertedDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
    const convertedPath = info.outputPath('converted.dat'); await (await convertedDownload).saveAs(convertedPath)
    const converted = readFileSync(convertedPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number))
    expect(converted.map(r => r[0])).toEqual(x)
    expect(converted.map(r => r.slice(1))).toEqual(rows.map(r => r.slice(1)))
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    await dialog.screenshot({ path: info.outputPath('file-plugin-preview.png') })
    const importResponse = page.waitForResponse(r => r.url().endsWith('/import'), { timeout: 30000 })
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const response = await importResponse; expect(response.ok()).toBe(true)
    const project = await response.json(); const group = project.groups[0]
    expect(group.processing_error).toBeNull(); expect(group.energy).toEqual(x)
    expect(group.mu).toEqual(displayed.y); expect(group.source.file_plugin.id.toLowerCase()).toBe(name)
    await expect(dialog).not.toBeVisible()
    for (const [tab, space, xkey, ykey] of [['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
      ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const save = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('roundtrip.prj'); await (await save).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restore = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 30000 })
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restored = await (await restore).json()
    expect(restored.groups).toHaveLength(2)
    expect(restored.groups[1].source).toEqual(group.source)
    expect(restored.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
