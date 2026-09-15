import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'

async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const c = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...c.x], y: [...c.y] }
  })
}

function measured(name: string): number[][] {
  // Actual pinned Perl output. JavaScript toFixed uses a different tie rule
  // from native printf at exact half units (e.g. 20019.5625 -> 20019.562).
  const path = fileURLToPath(new URL(`../../../backend/tests/fixtures/${name.toLowerCase()}-native-columns.json.gz`, import.meta.url))
  return JSON.parse(gunzipSync(readFileSync(path)).toString())
}

for (const name of ['SSRLA', 'SSRLB', 'SSRLmicro']) {
  test(`${name} measured file previews chosen columns, imports, and restores PRJ`, async ({ page }, info) => {
    test.setTimeout(90000)
    const path = fileURLToPath(new URL(`../../../backend/tests/fixtures/demeter-${name.toLowerCase()}.dat`, import.meta.url))
    const data = readFileSync(path), rows = measured(name), x = rows.map(row => row[0])
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
    const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
    const enable = registry.getByRole('checkbox', { name: `Enable ${name}`, exact: true })
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
    await expect(dialog.getByLabel('File conversion')).toContainText('SSRL')
    if (await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).count()) {
      await dialog.getByRole('button', { name: 'Use suggested columns', exact: true }).click()
    }
    const preview = dialog.getByLabel('Imported signal preview plot', { exact: true })
    if (name === 'SSRLmicro') {
      await expect(dialog.getByRole('alert')).toContainText(/zero/i)
      await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    }
    let y = rows.map(row => name === 'SSRLmicro' ? row[5] / row[2] : Math.log(Math.abs(row[3] / row[4])))
    await expect.poll(async () => (await curve(preview)).x).toEqual(x)
    await expect.poll(async () => Math.max(...(await curve(preview)).y.map((v, i) => Math.abs(v - y[i])))).toBeLessThan(1e-12)
    // Change the chosen detector expression and check the real Plotly trace.
    await dialog.getByRole('button', { name: 'Use fluorescence columns', exact: true }).click()
    if (name === 'SSRLmicro') {
      await dialog.getByLabel('Numerator column numbers').fill('6-37')
      await dialog.getByRole('button', { name: 'Select range', exact: true }).click()
      y = rows.map(row => row.slice(5).reduce((sum, value) => sum + value, 0) / row[2])
    } else {
      const fluorescence = rows.map(row => row[5] / row[3])
      await expect.poll(async () => Math.max(...(await curve(preview)).y.map((v, i) => Math.abs(v - fluorescence[i])))).toBeLessThan(1e-12)
      await dialog.getByRole('button', { name: 'Use transmission columns', exact: true }).click()
    }
    await expect.poll(async () => Math.max(...(await curve(preview)).y.map((v, i) => Math.abs(v - y[i])))).toBeLessThan(1e-12)
    const source = name === 'SSRLB' ? 'Binary source bytes (hex) (first section)' : 'Source file contents (first section)'
    await dialog.getByText(source, { exact: true }).click()
    const downloaded = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download original file', exact: true }).click()
    const original = info.outputPath('original.dat'); await (await downloaded).saveAs(original)
    expect(readFileSync(original)).toEqual(data)
    if (name === 'SSRLB') await expect(dialog.getByText(/00000000\s+53 53 52 4c/)).toBeVisible()
    await dialog.getByText(source, { exact: true }).click()
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    const convertedDownload = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download converted file', exact: true }).click()
    const converted = info.outputPath('converted.dat'); await (await convertedDownload).saveAs(converted)
    const output = readFileSync(converted, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.trim().split(/\s+/).map(Number))
    expect(output).toEqual(rows)
    await dialog.getByText('Converted columns (first section)', { exact: true }).click()
    await preview.scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: info.outputPath('ssrl-preview.png') })
    const accepted = page.waitForResponse(r => r.url().endsWith('/import'), { timeout: 30000 })
    await dialog.getByRole('button', { name: 'Import spectrum', exact: true }).click()
    const response = await accepted; expect(response.ok()).toBe(true)
    const project = await response.json(), group = project.groups[0]
    expect(group.processing_error).toBeNull(); expect(group.energy).toEqual(x)
    group.mu.forEach((value: number, i: number) => expect(Math.abs(value - y[i])).toBeLessThan(1e-12))
    expect(group.source.file_plugin.id).toBe(name)
    await expect(dialog).not.toBeVisible()
    for (const [tab, space, xkey, ykey] of [['E Energy', 'E', 'energy', 'norm'], ['k EXAFS', 'k', 'k', 'weighted_chi'],
      ['R Fourier', 'R', 'r', 'chir_mag'], ['q Back transform', 'q', 'q', 'chiq_mag']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
        .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
    }
    const save = page.waitForEvent('download'); await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('roundtrip.prj'); await (await save).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restore = page.waitForResponse(r => r.url().endsWith('/restore-upload'), { timeout: 30000 })
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restored = await (await restore).json()
    expect(restored.groups[1].source).toEqual(group.source)
    expect(restored.groups[1].result.arrays).toEqual(group.result.arrays)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Data groups 2', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
