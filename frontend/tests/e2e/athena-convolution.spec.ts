import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { ConvolutionPreview } from '../../components/athena-convolution'

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
  await page.getByRole('button', {name: 'Convolve data', exact: true}).click()
  return page.getByRole('dialog', {name: 'Convolve data', exact: true})
}
async function curves(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(node => (node as HTMLElement & {data: {x: number[]; y: number[]}[]}).data.map(t => ({x: [...t.x], y: [...t.y]})))
}
async function configure(page: Page, dialog: Locator, options: ConvolutionPreview['options']) {
  await dialog.getByRole('combobox', {name: 'Line shape', exact: true}).selectOption(options.form)
  await dialog.getByLabel(options.form === 'gaussian' ? 'Gaussian σ · eV' : 'Lorentzian HWHM · eV', {exact: true}).fill(String(options.width))
  await dialog.getByLabel('Noise σ · fraction of edge step', {exact: true}).fill(String(options.noise))
  await expect(dialog.getByRole('button', {name: 'Make modified group', exact: true})).toBeEnabled()
  const waiting=page.waitForResponse(r=>r.url().endsWith('/convolve/preview'))
  await dialog.getByRole('button',{name:'Plot data and modified',exact:true}).click()
  const response=await waiting;expect(response.ok()).toBe(true);await expect(dialog.getByRole('button',{name:'Make modified group',exact:true})).toBeEnabled()
  return await response.json() as ConvolutionPreview
}

test('measured Cu live import, convolution/noise comparisons, exact save, undo and native PRJ',async({page},info)=>{
  test.setTimeout(120000);await page.setViewportSize({width:1500,height:1040})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const initial=await load(page);let latest=initial
  for(const options of [
    {form:'gaussian',width:0,noise:0}, {form:'gaussian',width:1,noise:0},
    {form:'gaussian',width:0,noise:.01}, {form:'lorentzian',width:1.5,noise:.02},
  ] as ConvolutionPreview['options'][]) {
    const dialog=await open(page);await dialog.getByLabel('Source group',{exact:true}).selectOption(initial.groups[0].id)
    const preview=await configure(page,dialog,options),row=preview.results[0]
    for(const space of ['E','k','R'] as const) {
      await dialog.getByRole('button',{name:space==='E'?'Plot in energy':`Plot in ${space}`,exact:true}).click()
      await expect.poll(()=>curves(dialog.getByLabel(`${space}-space convolution preview`,{exact:true}))).toEqual(row.traces[space].map(t=>({x:t.x,y:t.y})))
    }
    await dialog.getByRole('button',{name:'Plot in energy',exact:true}).click()
    await page.screenshot({path:info.outputPath(`convolution-${options.form}-${options.width}-${options.noise}.png`),animations:'disabled'})
    if(options.noise) {
      expect(preview.options.seed).toEqual(expect.any(Number))
      expect(row.details.noise_sigma).toBeGreaterThan(0)
    }
    const waiting=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='convolve')
    await dialog.getByRole('button',{name:'Make modified group',exact:true}).click()
    const response=await waiting;expect(response.ok()).toBe(true);latest=await response.json()
    expect(latest.groups[0]).toEqual(initial.groups[0]);expect(latest.groups[1].mu).toEqual(row.modified_mu)
    expect(latest.groups[1].energy).toEqual(row.modified_energy)
    expect((latest.groups[1].source.options as ConvolutionPreview['options']).seed).toEqual(preview.options.seed)
    await expect(dialog).toHaveCount(0)
  }
  expect(latest.groups).toHaveLength(5)
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 4',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(page.getByRole('heading',{name:'Data groups 5',exact:true})).toBeVisible()
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const path=info.outputPath('Cu-convolution-native.prj');await(await downloading).saveAs(path)
  writeFileSync(path,gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const response=await restoring;expect(response.ok()).toBe(true);const restored=(await response.json()).groups.slice(-5)
  for(const [i,g] of latest.groups.entries()) {
    expect(restored[i].energy).toEqual(g.energy);expect(restored[i].mu).toEqual(g.mu)
    expect(restored[i].source.xdi_metadata.attributes.scan?.process).toEqual((g.source.xdi_metadata as {attributes:{scan?:{process?:string}}}).attributes.scan?.process)
  }
  expect(errors).toEqual([])
})

test('mobile fresh-noise preview, retained controls and stale-save recovery',async({page,context},info)=>{
  test.setTimeout(120000);await page.setViewportSize({width:390,height:844})
  const initial=await load(page);let dialog=await open(page)
  const first=await configure(page,dialog,{form:'gaussian',width:1,noise:.01})
  const second=await configure(page,dialog,{form:'gaussian',width:1,noise:.01})
  expect(second.options.seed).not.toBe(first.options.seed);expect(second.results[0].modified_mu).not.toEqual(first.results[0].modified_mu)
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await dialog.getByRole('combobox',{name:'Line shape',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('convolution-mobile-controls.png'),animations:'disabled'})
  await dialog.getByLabel('E-space convolution preview',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('convolution-mobile-energy.png'),animations:'disabled'})
  const other=await context.newPage();await other.goto('/')
  const path=`/api/backend/api/athena/projects/${initial.id}`
  const changed=await other.request.post(path+'/command',{data:{version:initial.version,action:'metadata',group_ids:[initial.groups[0].id],options:{notes:'Concurrent edit'}}})
  expect(changed.ok()).toBe(true)
  const waiting=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='convolve')
  await dialog.getByRole('button',{name:'Make modified group',exact:true}).click();expect((await waiting).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByLabel('Gaussian σ · eV',{exact:true})).toHaveValue('1')
  expect((await(await other.request.get(path)).json()).groups).toHaveLength(1)
  await dialog.getByRole('button',{name:'Close convolution tool',exact:true}).click();dialog=await open(page)
  await expect(dialog.getByLabel('Noise σ · fraction of edge step',{exact:true})).toHaveValue('0.01')
  await dialog.getByRole('button',{name:'Close convolution tool',exact:true}).click();await page.reload()
  dialog=await open(page);const reviewed=await configure(page,dialog,{form:'lorentzian',width:1,noise:.01})
  await dialog.getByRole('button',{name:'Make modified group',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('convolution-mobile-actions.png'),animations:'disabled'})
  const saved=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='convolve')
  await dialog.getByRole('button',{name:'Make modified group',exact:true}).click();const response=await saved;expect(response.ok()).toBe(true)
  const p=await response.json();expect(p.groups[1].mu).toEqual(reviewed.results[0].modified_mu);expect(p.groups[0].mu).toEqual(initial.groups[0].mu)
  await other.close()
})
