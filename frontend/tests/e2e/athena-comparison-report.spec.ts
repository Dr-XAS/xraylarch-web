import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { ComparisonReport } from '../../lib/athena-comparison-report'

async function example(page: Page) {
  const created = await page.request.post('/api/backend/api/athena/projects', { data: { name: 'Spectrum comparison browser check' } })
  expect(created.ok()).toBe(true)
  const initial = await created.json()
  const response = await page.request.post(`/api/backend/api/athena/projects/${initial.id}/command`, { data: { version: initial.version, action: 'example' } })
  expect(response.ok()).toBe(true)
  const loaded = await response.json() as AthenaProject
  // Finish setup without an example-operation request to autosave an EXAFS model.
  const named = await page.request.post(`/api/backend/api/athena/projects/${loaded.id}/command`, {
    data: { version: loaded.version, action: 'project', options: { name: 'Spectrum comparison browser check' } },
  })
  expect(named.ok()).toBe(true)
  const project = await named.json() as AthenaProject
  await page.addInitScript(id => localStorage.setItem('athena.project', id), project.id)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  return project
}

async function openComparison(page: Page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const waiting = page.waitForResponse(response => response.url().endsWith('/comparison-report'))
  await page.getByRole('button', { name: 'Compare spectra…', exact: true }).click()
  const response = await waiting
  expect(response.ok()).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'Compare spectra', exact: true })
  await expect(dialog.getByRole('button', { name: 'Download comparison JSON', exact: true })).toBeEnabled()
  return { dialog, report: await response.json() as ComparisonReport }
}

for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} comparison preserves copper data and exports its exact reference and revision`, async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1500, height: 1040 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const project = await example(page)
  const { dialog, report } = await openComparison(page)
  expect(report.version).toBe(project.version)
  expect(report.reference_id).toBe(project.groups[0].id)
  expect(report.scope).toBe('marked')
  expect(report.groups.map(group => group.id)).toEqual(project.groups.filter(group => group.marked && group.id !== report.reference_id).map(group => group.id))
  const first = report.groups[0]
  const card = dialog.locator('details').filter({ has: page.locator('summary strong', { hasText: first.label }) })
  await card.locator('summary').click()
  await expect(card.getByText('Additional fitted energy shift', { exact: true })).toBeVisible()
  await expect(card.getByText('Largest normalized XANES difference', { exact: true })).toBeVisible()
  if (first.chi_amplitude) await expect(card.getByLabel(`Chi amplitude ratios for ${first.label}`, { exact: true })).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath(`comparison-${mobile ? 'mobile' : 'desktop'}.png`) })
  const downloading = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download comparison JSON', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`craft-comparison-${project.id}-v${project.version}-marked-ref-${report.reference_id}.json`)
  const output = info.outputPath('comparison.json')
  await download.saveAs(output)
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report)

  const newReference = project.groups.find(group => group.label.includes('300 K'))!
  const switching = page.waitForResponse(response => response.url().endsWith('/comparison-report'))
  await dialog.getByRole('combobox', { name: 'Comparison reference', exact: true }).selectOption(newReference.id)
  const changed = await (await switching).json() as ComparisonReport
  expect(changed.reference_id).toBe(newReference.id)
  expect(changed.groups.every(group => group.id !== newReference.id)).toBe(true)
  const allResponse = page.waitForResponse(response => response.url().endsWith('/comparison-report'))
  await dialog.getByRole('combobox', { name: 'Comparison groups', exact: true }).selectOption('all')
  const all = await (await allResponse).json() as ComparisonReport
  expect(all.groups.map(group => group.id)).toEqual(project.groups.filter(group => group.id !== newReference.id).map(group => group.id))
  const duplicate = all.groups.find(group => group.duplicate_inputs.some(match => match.id === newReference.id))!
  expect(duplicate).toBeDefined()
  const duplicateCard = dialog.locator('details').filter({ has: page.locator('summary strong', { hasText: duplicate.label }) })
  await duplicateCard.locator('summary').click()
  await expect(duplicateCard.getByText('Identical input arrays', { exact: true })).toBeVisible()
  await expect(duplicateCard.getByText(newReference.label, { exact: true })).toBeVisible()
  await duplicateCard.getByRole('button', { name: 'View spectrum', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const after = await page.request.get(`/api/backend/api/athena/projects/${project.id}`)
  expect(await after.json()).toEqual(project)
  expect(errors).toEqual([])
})

test('comparison refresh rejects a stale revision and reload preserves reference and scope', async ({ page }) => {
  test.setTimeout(120000)
  const project = await example(page)
  const { dialog, report } = await openComparison(page)
  const changed = await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`, {
    data: { version: project.version, action: 'project', options: { name: 'Comparison updated elsewhere' } },
  })
  expect(changed.ok()).toBe(true)
  const waiting = page.waitForResponse(response => response.url().endsWith('/comparison-report'))
  await dialog.getByRole('button', { name: 'Refresh comparison', exact: true }).click()
  expect((await waiting).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download comparison JSON', exact: true })).toBeDisabled()
  const refreshing = page.waitForResponse(response => response.url().endsWith('/comparison-report') && response.ok())
  await dialog.getByRole('button', { name: 'Reload project', exact: true }).click()
  const recovered = await (await refreshing).json() as ComparisonReport
  expect(recovered.version).toBe(project.version + 1)
  expect(recovered.project_name).toBe('Comparison updated elsewhere')
  expect(recovered.reference_id).toBe(report.reference_id)
  expect(recovered.scope).toBe(report.scope)
  await expect(dialog.getByRole('button', { name: 'Download comparison JSON', exact: true })).toBeEnabled()
})
