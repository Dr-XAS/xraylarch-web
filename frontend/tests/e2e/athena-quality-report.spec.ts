import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'

async function example(page: Page) {
  const created = await page.request.post('/api/backend/api/athena/projects', { data: { name: 'Spectrum review browser check' } })
  expect(created.ok()).toBe(true)
  const initial = await created.json()
  const response = await page.request.post(`/api/backend/api/athena/projects/${initial.id}/command`, {
    data: { version: initial.version, action: 'example' },
  })
  expect(response.ok()).toBe(true)
  const loaded = await response.json() as AthenaProject
  // Finish setup without the example operation's request to autosave an EXAFS model.
  const named = await page.request.post(`/api/backend/api/athena/projects/${loaded.id}/command`, {
    data: { version: loaded.version, action: 'project', options: { name: 'Spectrum review browser check' } },
  })
  expect(named.ok()).toBe(true)
  const project = await named.json() as AthenaProject
  await page.addInitScript(id => localStorage.setItem('athena.project', id), project.id)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  return project
}

async function openReview(page: Page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const waiting = page.waitForResponse(response => response.url().endsWith('/quality-report'))
  await page.getByRole('button', { name: 'Review spectra…', exact: true }).click()
  const response = await waiting
  expect(response.ok()).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'Review spectra', exact: true })
  await expect(dialog.getByRole('button', { name: 'Download review JSON', exact: true })).toBeEnabled()
  return { dialog, report: await response.json() }
}

for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} review preserves copper data and exports the exact revision`, async ({ page }, info) => {
  test.setTimeout(120000)
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1500, height: 1040 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const project = await example(page)
  const { dialog, report } = await openReview(page)
  expect(report.version).toBe(project.version)
  expect(report.groups.map((group: { id: string }) => group.id)).toEqual(project.groups.map(group => group.id))
  expect(report.counts.with_duplicate_inputs).toBe(2)
  await expect(dialog.getByLabel('Spectrum review summary', { exact: true })).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath(`review-${mobile ? 'mobile' : 'desktop'}.png`) })
  const downloading = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download review JSON', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`craft-review-${project.id}-v${project.version}-all.json`)
  const output = info.outputPath('review.json')
  await download.saveAs(output)
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report)

  const switching = page.waitForResponse(response => response.url().endsWith('/quality-report'))
  await dialog.getByRole('combobox', { name: 'Review groups', exact: true }).selectOption('marked')
  const marked = await (await switching).json()
  expect(marked.groups.map((group: { id: string }) => group.id)).toEqual(project.groups.filter(group => group.marked).map(group => group.id))
  const unmarked = new Set(project.groups.filter(group => !group.marked).map(group => group.id))
  expect(marked.groups.some((group: { duplicate_inputs: { id: string }[] }) => group.duplicate_inputs.some(match => unmarked.has(match.id)))).toBe(true)
  const after = await page.request.get(`/api/backend/api/athena/projects/${project.id}`)
  expect(await after.json()).toEqual(project)
  expect(errors).toEqual([])
})

test('refresh refuses another-window revision and a reload recovers', async ({ page }) => {
  test.setTimeout(120000)
  const project = await example(page)
  const { dialog } = await openReview(page)
  const changed = await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`, {
    data: { version: project.version, action: 'project', options: { name: 'Updated in another window' } },
  })
  expect(changed.ok()).toBe(true)
  const waiting = page.waitForResponse(response => response.url().endsWith('/quality-report'))
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click()
  expect((await waiting).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download review JSON', exact: true })).toBeDisabled()
  const refreshing = page.waitForResponse(response => response.url().endsWith('/quality-report') && response.ok())
  await dialog.getByRole('button', { name: 'Reload project', exact: true }).click()
  const recovered = await (await refreshing).json()
  expect(recovered.version).toBe(project.version + 1)
  expect(recovered.project_name).toBe('Updated in another window')
  await expect(dialog.getByRole('button', { name: 'Download review JSON', exact: true })).toBeEnabled()
})

test('merge displays the repeated-input warning before saving', async ({ page }) => {
  test.setTimeout(120000)
  let project = await example(page)
  for (const group of project.groups) {
    const response = await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`, {
      data: { version: project.version, action: 'metadata', group_ids: [group.id],
        options: { marked: group.label.includes('300 K') || group.label.includes('shared reference') } },
    })
    expect(response.ok()).toBe(true)
    project = await response.json()
  }
  await page.reload()
  await page.getByRole('button', { name: 'Process', exact: true }).click()
  await page.getByRole('button', { name: 'Merge marked groups', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Merge marked groups', exact: true })
  await expect(dialog.getByText(/These contributing groups have identical input arrays/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Save merged groups', exact: true })).toBeEnabled()
  const state = await page.request.get(`/api/backend/api/athena/projects/${project.id}`)
  expect(await state.json()).toEqual(project)
})
