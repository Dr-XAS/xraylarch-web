import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Response } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'

const copper = readFileSync(fileURLToPath(new URL('../../../examples/xafsdata/cu_10k.xmu', import.meta.url)), 'utf8')
  .split(/\r?\n/).filter(line => /^\s*[+\-.]?\d/.test(line)).map(line => line.trim().split(/\s+/).slice(0, 2).map(Number))
const nearEdge = Array.from({ length: 521 }, (_, i) => {
  const energy = 8779 + i * .5
  return [energy, .2 + 1.8 / (1 + Math.exp(-(energy - 8982) / 2.5))]
})
const file = (name: string, rows: number[][]) => ({ name, mimeType: 'text/plain',
  buffer: Buffer.from('# energy mu\n' + rows.map(row => row.join(' ')).join('\n')) })

test('a mixed batch selects EXAFS per spectrum and leaves manual processing available', async ({ page }) => {
  test.setTimeout(120000)
  await page.goto('/')
  await expect(page.locator('.ath-project-name')).toHaveText('Untitled project')
  await page.getByRole('button', { name: 'Import data', exact: true }).click()
  const inspected = page.waitForResponse(response => response.url().endsWith('/inspect'))
  await page.getByLabel('Choose data files', { exact: true }).setInputFiles([
    file('long-copper.dat', copper), file('short-near-edge.dat', nearEdge),
  ])
  expect((await inspected).ok()).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'Import spectra', exact: true })
  await expect(dialog.getByRole('combobox', { name: 'Energy column', exact: true })).toBeVisible({ timeout: 30000 })
  const suggested = dialog.getByRole('button', { name: 'Use suggested columns', exact: true })
  if (await suggested.count()) await suggested.click()
  await dialog.getByRole('combobox', { name: 'Measurement', exact: true }).selectOption('mu')
  await expect(dialog.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Input already normalized', exact: true }).uncheck()
  await dialog.getByRole('radio', { name: 'Yes, use the same parameters', exact: true }).check()
  const imports: Response[] = []
  page.on('response', response => {
    if (response.url().endsWith('/import') && response.request().method() === 'POST') imports.push(response)
  })
  await dialog.getByRole('button', { name: 'Import 2 files', exact: true }).click()
  await expect(dialog).not.toBeVisible({ timeout: 60000 })
  expect(imports).toHaveLength(2)
  for (const response of imports) {
    expect(response.ok()).toBe(true)
    expect(response.request().postDataJSON()).toMatchObject({ data_type: 'mu', exafs: null })
  }
  const project = await imports[1].json() as AthenaProject
  const [long, short] = project.groups
  expect(long.processing_error).toBeNull()
  expect(long.data_type).toBe('mu')
  expect(long.result?.effective.exafs).toBe(true)
  expect(long.result?.arrays.chi.length).toBeGreaterThan(0)
  expect(short.processing_error).toBeNull()
  expect(short.data_type).toBe('xanes')
  expect(short.is_normalized).toBe(false)
  expect(short.result?.effective.exafs).toBe(false)
  expect(short.result?.arrays.norm).toHaveLength(nearEdge.length)
  expect(short.result?.arrays.chi).toEqual([])
  expect(short.energy).toEqual(nearEdge.map(row => row[0]))
  expect(short.mu).toEqual(nearEdge.map(row => row[1]))
  const reason = short.result?.warnings.find(message => /EXAFS/.test(message))
  expect(reason).toBeTruthy()
  await page.locator(`[data-group-id="${short.id}"] .ath-group-select`).click()
  await expect(page.getByText(reason!, { exact: true })).toBeVisible()

  await page.locator(`[data-group-id="${long.id}"] .ath-group-select`).click()
  await page.getByRole('button', { name: 'Spectrum processing settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Processing settings', exact: true })
  await expect(settings.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true })).toBeChecked()
  await settings.getByRole('checkbox', { name: 'Enable EXAFS processing', exact: true }).uncheck()
  const changing = page.waitForResponse(response => response.url().endsWith('/command')
    && response.request().postDataJSON().action === 'change_datatype')
  await settings.getByRole('button', { name: 'Apply settings', exact: true }).click()
  const changed = await changing
  expect(changed.ok()).toBe(true)
  const updated = (await changed.json() as AthenaProject).groups.find(group => group.id === long.id)!
  expect(updated.data_type).toBe('xanes')
  expect(updated.result?.arrays.chi).toEqual([])
  expect(updated.energy).toEqual(long.energy)
  expect(updated.mu).toEqual(long.mu)
})
