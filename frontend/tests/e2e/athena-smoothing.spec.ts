import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { SmoothingPreview } from '../../components/athena-smoothing'

const fixture = fileURLToPath(new URL('../../../backend/tests/fixtures/xdi-official-cu_metal_rt.xdi', import.meta.url))
test.use({actionTimeout: 15000})
async function load(page: Page) {
  await page.goto('/'); await page.getByRole('button', {name: 'Import data', exact: true}).click()
  await page.getByLabel('Choose data files', {exact: true}).setInputFiles(fixture)
  const dialog = page.getByRole('dialog', {name: 'Import spectra', exact: true})
  await expect(dialog.locator('.js-line').first()).toBeVisible()
  await dialog.getByRole('checkbox', {name: 'Numerator i0', exact: true}).uncheck()
  await dialog.getByRole('checkbox', {name: 'Numerator mutrans', exact: true}).check()
  await dialog.getByRole('checkbox', {name: 'Denominator itrans', exact: true}).uncheck()
  await dialog.getByRole('checkbox', {name: 'Natural log', exact: true}).uncheck()
  const rows = readFileSync(fixture, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number))
  await expect.poll(() => curves(dialog.getByLabel('Imported signal preview plot', {exact: true}))).toEqual([{x: rows.map(r => r[0]), y: rows.map(r => r[3])}])
  const waiting = page.waitForResponse(r => r.url().endsWith('/import'))
  await dialog.getByRole('button', {name: 'Import spectrum', exact: true}).click()
  const response = await waiting; expect(response.ok()).toBe(true)
  return await response.json() as AthenaProject
}
async function open(page: Page) {
  await page.getByRole('button', {name: 'Process', exact: true}).click()
  await page.getByRole('button', {name: 'Smooth data', exact: true}).click()
  return page.getByRole('dialog', {name: 'Smooth data', exact: true})
}
async function curves(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(node => (node as HTMLElement & {data: {x: number[]; y: number[]}[]}).data.map(t => ({x: [...t.x], y: [...t.y]})))
}
async function configure(page: Page, dialog: Locator, options: SmoothingPreview['options']) {
  await dialog.getByLabel('Algorithm', {exact: true}).selectOption(options.method)
  if (options.window !== undefined) await dialog.getByLabel(options.method === 'savitzky_golay' ? 'Savitzky–Golay window · points' : 'Kernel size · points', {exact: true}).fill(String(options.window))
  if (options.sigma !== undefined) await dialog.getByLabel('Gaussian σ · samples', {exact: true}).fill(String(options.sigma))
  if (options.order !== undefined) await dialog.getByLabel('Polynomial order', {exact: true}).fill(String(options.order))
  if (options.repetitions !== undefined) await dialog.getByLabel('Repetitions', {exact: true}).fill(String(options.repetitions))
  await expect(dialog.getByRole('button', {name: 'Make smoothed group', exact: true})).toBeEnabled()
  const waiting = page.waitForResponse(r => r.url().endsWith('/smooth/preview'))
  await dialog.getByRole('button', {name: 'Plot data and smoothed', exact: true}).click()
  const response = await waiting; expect(response.ok()).toBe(true)
  await expect(dialog.getByRole('button', {name: 'Make smoothed group', exact: true})).toBeEnabled()
  return await response.json() as SmoothingPreview
}

test('measured Cu live columns, four smoothing algorithms, E/k/R, history, undo and native PRJ', async ({page}, info) => {
  test.setTimeout(120000)
  await page.setViewportSize({width: 1500, height: 1040}); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const initial = await load(page); expect(initial.groups).toHaveLength(1)
  let latest = initial
  const settings: SmoothingPreview['options'][] = [{method: 'boxcar', window: 8}, {method: 'gaussian', window: 11, sigma: 2},
    {method: 'savitzky_golay', window: 31, order: 9}, {method: 'three_point', repetitions: 11}]
  for (const options of settings) {
    const dialog = await open(page)
    await dialog.getByLabel('Source group', {exact: true}).selectOption(initial.groups[0].id)
    const preview = await configure(page, dialog, options), row = preview.results[0]
    expect(row.smoothed_mu.length).toBe(options.method === 'boxcar' ? 399 : options.method === 'gaussian' ? 397 : 408)
    if (options.method === 'boxcar') await expect(dialog.getByText('Kernel size was adjusted to 9 points, as in Athena.', {exact: true})).toBeVisible()
    for (const space of ['E','k','R'] as const) {
      await dialog.getByRole('button', {name: space === 'E' ? 'Plot in energy' : `Plot in ${space}`, exact: true}).click()
      await expect(dialog.getByRole('button', {name: space === 'E' ? 'Plot in energy' : `Plot in ${space}`, exact: true})).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => curves(dialog.getByLabel(`${space}-space smoothing preview`, {exact: true}))).toEqual(row.traces[space].map(t => ({x: t.x, y: t.y})))
      await expect(dialog.getByLabel(`${space}-space smoothing preview`, {exact: true}).getByText(space === 'E' ? 'Energy (eV)' : space === 'k' ? 'k (Å⁻¹)' : 'R (Å)', {exact: true})).toBeVisible()
    }
    await dialog.getByRole('button', {name: 'Plot in energy', exact: true}).click()
    await expect(dialog.getByRole('button', {name: 'Plot in energy', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('button', {name: 'Plot in R', exact: true})).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => curves(dialog.getByLabel('E-space smoothing preview', {exact: true}))).toEqual(row.traces.E.map(t => ({x: t.x, y: t.y})))
    await page.screenshot({path: info.outputPath(`smoothing-desktop-${options.method}.png`), animations: 'disabled'})
    const waiting = page.waitForResponse(r => r.url().endsWith('/command') && r.request().postDataJSON().action === 'smooth')
    await dialog.getByRole('button', {name: 'Make smoothed group', exact: true}).click()
    const response = await waiting; expect(response.ok()).toBe(true); latest = await response.json()
    expect(latest.groups[0]).toEqual(initial.groups[0]); expect(latest.groups[1].energy).toEqual(row.smoothed_energy); expect(latest.groups[1].mu).toEqual(row.smoothed_mu)
    await expect(dialog).toHaveCount(0)
  }
  expect(latest.groups).toHaveLength(5)
  await page.getByRole('button', {name: 'Group', exact: true}).click()
  await page.getByRole('button', {name: 'File metadata…', exact: true}).click()
  const metadata = page.getByRole('dialog', {name: 'File metadata', exact: true})
  await expect(metadata.getByRole('region', {name: 'Acquisition and processing history'})).toContainText('Smoothed data by three-point filter (11 repetitions)')
  await metadata.getByRole('button', {name: 'Close metadata', exact: true}).click()
  await page.getByRole('button', {name: 'Undo', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Data groups 4', exact: true})).toBeVisible()
  await page.getByRole('button', {name: 'Redo', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Data groups 5', exact: true})).toBeVisible()
  const downloading = page.waitForEvent('download'); await page.getByRole('link', {name: 'Save project', exact: true}).click()
  const path = info.outputPath('Cu-smoothed-native.prj'); await (await downloading).saveAs(path)
  writeFileSync(path, gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(line => !line.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button', {name: 'File', exact: true}).click(); await page.getByRole('button', {name: 'Open project…', exact: true}).click()
  await page.getByLabel('Open project file', {exact: true}).setInputFiles(path)
  const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
  await page.getByRole('button', {name: 'Import all groups', exact: true}).click()
  const response = await restoring; expect(response.ok()).toBe(true); const restored = (await response.json()).groups.slice(-5)
  for (const [i, group] of latest.groups.entries()) {
    expect(restored[i].mu).toEqual(group.mu); expect(restored[i].energy).toEqual(group.energy)
    const metadata = group.source.xdi_metadata as {attributes: {scan: {process?: string}}}
    expect(restored[i].source.xdi_metadata.attributes.scan.process).toEqual(metadata.attributes.scan.process)
  }
  expect(errors).toEqual([])
})

test('mobile Gaussian preview, native width reset and stale-save recovery preserve the source', async ({page}, info) => {
  test.setTimeout(90000); await page.setViewportSize({width: 390, height: 844})
  const initial = await load(page), dialog = await open(page)
  await configure(page, dialog, {method: 'gaussian', window: 8, sigma: 0})
  await expect(dialog.getByText('Gaussian width was reset to 4 samples, as in Athena.', {exact: true})).toBeVisible()
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const bounds = await dialog.boundingBox()
  for (const name of ['Close smoothing tool', 'Plot data and smoothed', 'Make smoothed group']) {
    const button = await dialog.getByRole('button', {name, exact: true}).boundingBox()
    expect(button!.x).toBeGreaterThanOrEqual(bounds!.x); expect(button!.x + button!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
  }
  await dialog.getByLabel('Source group', {exact: true}).scrollIntoViewIfNeeded()
  await page.screenshot({path: info.outputPath('smoothing-mobile-controls.png'), animations: 'disabled'})
  await dialog.getByLabel('E-space smoothing preview', {exact: true}).scrollIntoViewIfNeeded()
  await page.screenshot({path: info.outputPath('smoothing-mobile-energy.png'), animations: 'disabled'})
  await dialog.getByRole('button', {name: 'Make smoothed group', exact: true}).scrollIntoViewIfNeeded()
  await page.screenshot({path: info.outputPath('smoothing-mobile-actions.png'), animations: 'disabled'})
  const changed = await page.request.post(`/api/backend/api/athena/projects/${initial.id}/command`, {data: {version: initial.version, action: 'project', options: {name: 'Changed elsewhere'}}})
  expect(changed.ok()).toBe(true)
  await dialog.getByRole('button', {name: 'Make smoothed group', exact: true}).click()
  await expect(dialog.getByRole('alert')).toContainText('changed in another tab')
  await expect(dialog.getByRole('button', {name: 'Make smoothed group', exact: true})).toBeDisabled()
  await expect(dialog.getByLabel('Kernel size · points', {exact: true})).toHaveValue('8')
  await expect(dialog.getByLabel('Gaussian σ · samples', {exact: true})).toHaveValue('0')
  expect((await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json()).groups).toEqual(initial.groups)
  await page.reload(); const reopened = await open(page)
  await configure(page, reopened, {method: 'gaussian', window: 8, sigma: 0})
  await reopened.getByRole('button', {name: 'Make smoothed group', exact: true}).click()
  await expect(reopened).toHaveCount(0); await expect(page.getByRole('heading', {name: 'Data groups 2', exact: true})).toBeVisible()
})

for (const width of [1500, 390]) {
  test(`SG preferences Apply/Save, cross-window conflict and panel retention at ${width}px`, async ({page, context}, info) => {
    test.setTimeout(90000); await page.setViewportSize({width, height: width === 390 ? 844 : 1040})
    const initial = await load(page), dialog = await open(page)
    await dialog.getByLabel('Algorithm', {exact: true}).selectOption('savitzky_golay')
    await dialog.getByText('Session and saved SG preferences', {exact: true}).click()
    const preferences = dialog.getByRole('region', {name: 'Savitzky–Golay preferences', exact: true})
    await expect(preferences.getByRole('button', {name: 'Apply', exact: true})).toBeEnabled()
    await preferences.getByRole('button', {name: 'Use Athena defaults', exact: true}).click()
    await expect(dialog.getByLabel('Polynomial order', {exact: true})).toHaveValue('9')
    const resetting = page.waitForResponse(r => r.url().endsWith('/preferences/smoothing') && r.request().method() === 'PUT')
    await preferences.getByRole('button', {name: 'Apply and Save', exact: true}).click(); expect((await resetting).ok()).toBe(true)
    await configure(page, dialog, {method: 'savitzky_golay', window: 21, order: 11})
    const path = '/api/backend/api/athena/preferences/smoothing'
    expect((await (await page.request.get(path)).json()).values).toEqual({window: 31, order: 9})
    const applying = page.waitForResponse(r => r.url().endsWith('/preferences/smoothing') && r.request().method() === 'PUT')
    await preferences.getByRole('button', {name: 'Apply', exact: true}).click()
    const applied = await applying; expect(applied.ok()).toBe(true); expect((await applied.json()).unsaved).toBe(true)
    const second = await context.newPage(); await second.goto('/')
    const otherDialog = await open(second); await otherDialog.getByLabel('Algorithm', {exact: true}).selectOption('savitzky_golay')
    await otherDialog.getByText('Session and saved SG preferences', {exact: true}).click()
    await expect(otherDialog.getByLabel('Savitzky–Golay window · points', {exact: true})).toHaveValue('21')
    await expect(otherDialog.getByLabel('Polynomial order', {exact: true})).toHaveValue('11')
    const otherPreferences = otherDialog.getByRole('region', {name: 'Savitzky–Golay preferences', exact: true})
    await otherDialog.getByLabel('Savitzky–Golay window · points', {exact: true}).fill('17')
    await otherDialog.getByLabel('Polynomial order', {exact: true}).fill('9')
    const saving = second.waitForResponse(r => r.url().endsWith('/preferences/smoothing') && r.request().method() === 'PUT')
    await otherPreferences.getByRole('button', {name: 'Apply and Save', exact: true}).click()
    const saved = await saving; expect(saved.ok()).toBe(true); expect((await saved.json()).saved).toEqual({window: 17, order: 9})
    await second.close(); await page.bringToFront()
    await dialog.getByLabel('Savitzky–Golay window · points', {exact: true}).fill('23')
    await preferences.getByRole('button', {name: 'Apply and Save', exact: true}).click()
    await expect(preferences.getByRole('alert')).toContainText('preferences changed')
    await expect(dialog.getByLabel('Savitzky–Golay window · points', {exact: true})).toHaveValue('23')
    expect((await (await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json()).groups).toEqual(initial.groups)
    await preferences.getByRole('button', {name: 'Reload preferences', exact: true}).click()
    await expect(dialog.getByLabel('Savitzky–Golay window · points', {exact: true})).toHaveValue('17')
    await expect(dialog.getByRole('button', {name: 'Make smoothed group', exact: true})).toBeEnabled()
    await preferences.scrollIntoViewIfNeeded(); await page.screenshot({path: info.outputPath(`sg-preferences-${width}.png`), animations: 'disabled'})
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await dialog.getByRole('button', {name: 'Close smoothing tool', exact: true}).click()
    const reopened = await open(page)
    await expect(reopened.getByLabel('Algorithm', {exact: true})).toHaveValue('savitzky_golay')
    await expect(reopened.getByLabel('Savitzky–Golay window · points', {exact: true})).toHaveValue('17')
    const result = await configure(page, reopened, {method: 'savitzky_golay', window: 17, order: 9})
    const making = page.waitForResponse(r => r.url().endsWith('/command') && r.request().postDataJSON().action === 'smooth')
    await reopened.getByRole('button', {name: 'Make smoothed group', exact: true}).click()
    const made = await making; expect(made.ok()).toBe(true)
    expect((await made.json()).groups[1].mu).toEqual(result.results[0].smoothed_mu)
    const retained = await open(page); await expect(retained.getByLabel('Algorithm', {exact: true})).toHaveValue('savitzky_golay')
    await expect(retained.getByLabel('Savitzky–Golay window · points', {exact: true})).toHaveValue('17')
    await retained.getByLabel('Algorithm', {exact: true}).selectOption('boxcar')
    await retained.getByLabel('Kernel size · points', {exact: true}).fill('8')
    await retained.getByRole('button', {name: 'Close smoothing tool', exact: true}).click()
    const shared = await open(page); await shared.getByLabel('Algorithm', {exact: true}).selectOption('three_point')
    await expect(shared.getByLabel('Repetitions', {exact: true})).toHaveValue('8')
  })
}
