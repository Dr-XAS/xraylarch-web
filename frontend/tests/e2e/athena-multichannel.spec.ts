import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Locator } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
interface NativeGroup { label: string; energy: number[]; mu: number[] }
interface Reference { name: string; input: string; file: string; values?: Record<string, number | string | boolean> }
const manifest = JSON.parse(readFileSync(fixture('athena-multichannel-fixtures.json'), 'utf8')) as { references: Reference[] }
const oracle = (ref: Reference): { groups: NativeGroup[] } => JSON.parse(gunzipSync(readFileSync(fixture(ref.file))).toString())
async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node => {
    const data = (node as HTMLElement & { data: { x: number[]; y: number[] }[] }).data[0]
    return { x: [...data.x], y: [...data.y] }
  })
}
async function matches(plot: Locator, g: NativeGroup) {
  await expect.poll(async () => {
    const actual = await curve(plot)
    if (actual.x.length !== g.energy.length || actual.y.length !== g.mu.length) return Infinity
    return Math.max(...actual.x.map((v,i) => Math.abs(v-g.energy[i])), ...actual.y.map((v,i) => Math.abs(v-g.mu[i])))
  }).toBeLessThan(1e-10)
}

for (const reader of ['X23A2MultiChannel','10BMMultiChannel']) {
  test(`${reader} imports native channels with independent preview, configuration and PRJ exchange`, async ({ page }, info) => {
    test.setTimeout(100000)
    const ref = manifest.references.find(r => r.name === (reader === 'X23A2MultiChannel' ? 'x23-000' : '10bm-defaults'))!
    let expected = oracle(ref).groups
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByRole('button', { name: 'Plugin registry…', exact: true }).click()
    const registry = page.getByRole('dialog', { name: 'Plugin registry', exact: true })
    const toggle = registry.getByRole('checkbox', { name: `Enable ${reader}`, exact: true })
    await expect(toggle).toBeEnabled()
    const enabling = page.waitForResponse(r => r.url().endsWith('/preferences/plugins') && r.request().method() === 'PUT')
    // The controlled switch changes after its persisted PUT is confirmed.
    // check() asserts immediately after the click and can race that response.
    await toggle.click(); expect((await enabling).ok()).toBe(true)
    await expect(toggle).toBeChecked()
    await registry.getByRole('button', { name: 'Close registry', exact: true }).click()
    await page.getByRole('button', { name: 'Import data', exact: true }).click()
    const inspection = page.waitForResponse(r => r.url().endsWith('/inspect'))
    await page.getByLabel('Choose data files', { exact: true }).setInputFiles(fixture(ref.input))
    const initial = await (await inspection).json(); expect(initial.kind).toBe('project')
    const dialog = page.getByRole('dialog', { name: 'Open a project', exact: true })
    const panel = dialog.getByRole('region', { name: 'Project file import', exact: true })
    await expect(panel.getByRole('button', { name: 'Import all groups', exact: true })).toBeEnabled()
    for (const [i,g] of expected.entries()) {
      await panel.getByRole('button', { name: `Preview ${g.label}, group ${i+1}`, exact: true }).click()
      await matches(panel.getByLabel(`Preview of ${g.label}`, { exact: true }), g)
    }
    if (reader === '10BMMultiChannel') {
      const next = manifest.references.find(r => r.name === '10bm-configured')!
      await panel.getByRole('button', { name: 'Configure reader', exact: true }).click()
      const editor = panel.getByRole('region', { name: `${reader} configuration`, exact: true })
      const configResponse = await page.request.get(`/api/backend/api/athena/preferences/plugins/${reader}/configuration`)
      const config = await configResponse.json()
      await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
      for (const field of config.fields as { name: string; title: string; type: string; enum?: string[] }[]) {
        const value = next.values![field.name]
        if (field.type === 'boolean') await editor.getByRole('checkbox', { name: field.title, exact: true }).setChecked(Boolean(value))
        else if (field.enum) await editor.getByRole('combobox', { name: field.title, exact: true }).selectOption(String(value))
        else await editor.getByRole(field.type === 'string' ? 'textbox' : 'spinbutton', { name: field.title, exact: true }).fill(String(value))
      }
      const applying = page.waitForResponse(r => r.url().endsWith('/configuration') && r.request().method() === 'PUT')
      await editor.getByRole('button', { name: 'Apply and Save', exact: true }).click()
      const applied = await applying; expect(applied.ok()).toBe(true)
      expect((await applied.json()).values).toEqual(next.values)
      await expect(editor.getByText(/Applied and saved reader settings/)).toBeVisible()
      // Apply preserves the currently reviewed fifth reference until an explicit reinspection.
      await matches(panel.getByLabel(`Preview of ${expected[4].label}`, { exact: true }), expected[4])
      await page.setViewportSize({ width: 390, height: 844 })
      await editor.getByRole('heading').scrollIntoViewIfNeeded()
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await dialog.screenshot({ path: info.outputPath('configuration-mobile.png') })
      await editor.getByRole('button', { name: 'Apply and Save', exact: true }).scrollIntoViewIfNeeded()
      await dialog.screenshot({ path: info.outputPath('configuration-actions-mobile.png') })
      await page.setViewportSize({ width: 1280, height: 900 })
      const reinspecting = page.waitForResponse(r => r.url().endsWith('/preview-project'))
      await panel.getByRole('button', { name: 'Reinspect source file', exact: true }).click()
      const updated = await (await reinspecting).json(); expect(updated.groups).toHaveLength(4)
      expect(updated.upload_id).not.toBe(initial.preview.upload_id)
      expected = oracle(next).groups
      for (const [i,g] of expected.entries()) {
        await panel.getByRole('button', { name: `Preview ${g.label}, group ${i+1}`, exact: true }).click()
        await matches(panel.getByLabel(`Preview of ${g.label}`, { exact: true }), g)
      }
    }
    await panel.getByRole('button', { name: `Preview ${expected[0].label}, group 1`, exact: true }).click()
    const normalized = page.waitForResponse(r => r.url().includes('/groups/channel-1?mode=norm'))
    await panel.getByRole('combobox', { name: 'Preview signal' }).selectOption('norm')
    const norm = await (await normalized).json(); expect(norm.processing_error).toBeFalsy()
    await expect.poll(() => curve(panel.getByLabel(`Preview of ${expected[0].label}`, { exact: true }))).toEqual({ x: norm.x, y: norm.y })
    await panel.getByRole('combobox', { name: 'Preview signal' }).selectOption('mu')
    await matches(panel.getByLabel(`Preview of ${expected[0].label}`, { exact: true }), expected[0])
    for (const variant of ['original file','converted project']) {
      const downloading = page.waitForEvent('download')
      await panel.getByRole('link', { name: `Download ${variant}`, exact: true }).click()
      const file = info.outputPath(variant === 'original file' ? 'original.dat' : 'converted.json')
      await (await downloading).saveAs(file)
      if (variant === 'original file') expect(readFileSync(file)).toEqual(readFileSync(fixture(ref.input)))
      else expect(JSON.parse(readFileSync(file,'utf8')).groups).toHaveLength(expected.length)
    }
    await panel.getByLabel(`Preview of ${expected[0].label}`, { exact: true }).scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: info.outputPath('channel-preview.png') })
    for (const button of await panel.getByRole('button', { name: /^Preview .*group/ }).all()) {
      expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    }
    await panel.getByRole('checkbox', { name: `Import ${expected[1].label}, group 2`, exact: true }).uncheck()
    const importing = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await panel.getByRole('button', { name: 'Import 3 selected groups', exact: true }).click()
    const imported = await importing; expect(imported.ok()).toBe(true)
    const project = await imported.json(); expect(project.groups).toHaveLength(3)
    for (const [i,g] of project.groups.entries()) {
      const e = expected[[0,2,3][i]]
      expect(g.processing_error).toBeNull(); expect(g.parameters.energy_shift).toBe(0)
      expect(g.energy).toEqual(e.energy)
      g.mu.forEach((v: number,j: number) => expect(Math.abs(v-e.mu[j])).toBeLessThan(1e-12))
    }
    await expect(dialog).not.toBeVisible()
    if (reader === 'X23A2MultiChannel') {
      const group = project.groups[2]
      for (const [tab,space,xkey,ykey] of [['E Energy','E','energy','norm'],['k EXAFS','k','k','weighted_chi'],['R Fourier','R','r','chir_mag'],['q Back transform','q','q','chiq_mag']]) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await expect.poll(() => curve(page.getByLabel(`${space}-space spectrum plot`, { exact: true })))
          .toEqual({ x: group.result.arrays[xkey], y: group.result.arrays[ykey].map((v: number) => v === 0 ? 0 : v) })
      }
    }
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Save project', exact: true }).click()
    const prj = info.outputPath('multichannel.prj'); await (await downloading).saveAs(prj)
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await page.getByLabel('Open project file', { exact: true }).setInputFiles(prj)
    const restoring = page.waitForResponse(r => r.url().endsWith('/restore-upload'))
    await page.getByRole('button', { name: 'Import all groups', exact: true }).click()
    const restored = await (await restoring).json(); expect(restored.groups).toHaveLength(6)
    for (let i=0; i<3; i++) {
      expect(restored.groups[i+3].source).toEqual(project.groups[i].source)
      expect(restored.groups[i+3].result.arrays).toEqual(project.groups[i].result.arrays)
    }
    await page.reload(); await expect(page.getByRole('heading', { name: 'Data groups 6', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
