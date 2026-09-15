import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { PointEditPreview } from '../../components/athena-point-edit'

const fixture = (name:string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/demeter-deglitch-${name}`,import.meta.url))
test.use({actionTimeout:15000})
async function curves(plot:Locator) {
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(node=>(node as HTMLElement&{data:{x:number[];y:number[];name:string}[]}).data.map(t=>({x:[...t.x],y:[...t.y],name:t.name})))
}
async function load(page:Page,name:string) {
  await page.goto('/');await page.getByRole('button',{name:'File',exact:true}).click()
  await page.getByRole('button',{name:'Plugin registry…',exact:true}).click()
  const registry=page.getByRole('dialog',{name:'Plugin registry',exact:true}),enable=registry.getByRole('checkbox',{name:'Enable HXMA',exact:true})
  if(!await enable.isChecked()) {
    const waiting=page.waitForResponse(r=>r.url().endsWith('/preferences/plugins')&&r.request().method()==='PUT')
    await enable.click();expect((await waiting).ok()).toBe(true);await expect(enable).toBeChecked()
  }
  await registry.getByRole('button',{name:'Close registry',exact:true}).click()
  await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(fixture(name))
  const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
  await expect(dialog.getByLabel('File conversion')).toContainText('HXMA')
  await dialog.getByRole('button',{name:'Use transmission columns',exact:true}).click()
  // These older CLS headers leave Event-ID unquoted. Native HXMA retains
  // eleven generic columns: choose feedback energy and the actual I0/I1
  // channels explicitly, and verify the live figure before importing.
  await dialog.getByRole('combobox',{name:'Energy column',exact:true}).selectOption({label:'column_2 · column 2'})
  await dialog.getByRole('button',{name:'Clear numerator',exact:true}).click()
  await dialog.getByRole('button',{name:'Clear denominator',exact:true}).click()
  await dialog.getByRole('checkbox',{name:'Numerator column_5',exact:true}).check()
  await dialog.getByRole('checkbox',{name:'Denominator column_6',exact:true}).check()
  const rows=readFileSync(fixture(name),'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).map(l=>l.split(',').map(Number))
  const plot=dialog.getByLabel('Imported signal preview plot',{exact:true})
  await expect.poll(async()=>(await curves(plot))[0].x).toEqual(rows.map(r=>r[2]))
  await expect.poll(async()=>Math.max(...(await curves(plot))[0].y.map((y,i)=>Math.abs(y-Math.log(Math.abs(rows[i][5]/rows[i][6])))))).toBeLessThan(1e-12)
  const waiting=page.waitForResponse(r=>r.url().endsWith('/import'))
  await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click();const response=await waiting
  expect(response.ok()).toBe(true);return await response.json() as AthenaProject
}
async function open(page:Page) {
  await page.getByRole('button',{name:'Process',exact:true}).click()
  await page.getByRole('button',{name:'Deglitch data',exact:true}).click()
  return page.getByRole('dialog',{name:'Deglitch and truncate',exact:true})
}
async function review(page:Page,dialog:Locator) {
  const replot=dialog.getByRole('button',{name:'Replot selection',exact:true});await expect(replot).toBeEnabled()
  const waiting=page.waitForResponse(r=>r.url().endsWith('/point-edit/preview'))
  await replot.click();const response=await waiting;expect(response.ok()).toBe(true)
  const value=await response.json() as PointEditPreview
  await expect(dialog.getByText(`${value.results.reduce((n,r)=>n+r.removed_indices.length,0)} points selected at project revision ${value.version}.`,{exact:true})).toBeVisible()
  return value
}
async function apply(page:Page,dialog:Locator,name:string,action:string) {
  const waiting=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action===action)
  await dialog.getByRole('button',{name,exact:true}).click();const response=await waiting;expect(response.ok()).toBe(true)
  return await response.json() as AthenaProject
}
function retained(before:AthenaProject,after:AthenaProject,preview:PointEditPreview) {
  expect(after.groups.map(g=>g.id)).toEqual(before.groups.map(g=>g.id))
  for(const r of preview.results) {
    const parent=before.groups.find(g=>g.id===r.group_id)!,g=after.groups.find(g=>g.id===r.group_id)!
    expect(g.energy).toEqual(r.energy);expect(g.mu).toEqual(r.mu);expect(g.parameters).toEqual(parent.parameters)
    expect(g.processing_error).toBe(r.processing_error)
    if(r.processing_error)expect(g.result).toBeNull()
    for(const key of ['raw_arrays','column_arrays'] as const) {
      const arrays=parent.source[key] as Record<string,number[]>
      expect(g.source[key]).toEqual(Object.fromEntries(Object.entries(arrays).map(([k,a])=>[k,r.kept_indices.map(i=>a[i])])))
    }
  }
}

test('measured ORP import preview, mu/chi point picking, margins, truncate, undo and bare PRJ',async({page},info)=>{
  test.setTimeout(150000);await page.setViewportSize({width:1500,height:1040})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const initial=await load(page,'ORP5.000'),dialog=await open(page),plot=dialog.getByLabel('Point removal plot',{exact:true})
  expect(initial.groups[0].mu).toHaveLength(586)
  let latest=initial
  for(const view of ['μ','χ']) {
    await review(page,dialog)
    await dialog.getByRole('button',{name:`Plot ${view}(E)`,exact:true}).click()
    await dialog.getByRole('button',{name:'Pick Point energy · eV',exact:true}).click()
    const index=view==='μ'?300:100
    const point=plot.locator('.scatterlayer .trace').first().locator('.point').nth(index)
    await point.click({force:true})
    await expect(dialog.getByRole('button',{name:'Remove point',exact:true})).toBeEnabled()
    const preview=await review(page,dialog),r=preview.results[0]
    expect(r.removed_indices).toHaveLength(1)
    const marker=view==='μ'?{x:r.selected_energy,y:r.selected_mu}:r.selected_chie!
    await expect.poll(async()=>(await curves(plot)).find(t=>t.name==='Selected for removal')).toEqual({...marker,name:'Selected for removal'})
    await page.screenshot({path:info.outputPath(`point-${view==='μ'?'mu':'chie'}.png`),animations:'disabled'})
    const next=await apply(page,dialog,'Remove point','deglitch');retained(latest,next,preview);latest=next
    await expect(dialog).toBeVisible()
  }
  await dialog.getByLabel('Operation',{exact:true}).selectOption('margins')
  await dialog.getByLabel('Minimum relative to E0 · eV',{exact:true}).fill('100')
  await dialog.getByLabel('Maximum relative to E0 · eV',{exact:true}).fill('900')
  await dialog.getByLabel('Margin tolerance · signal units',{exact:true}).fill('0.002')
  let preview=await review(page,dialog);expect(preview.results[0].removed_indices.length).toBeGreaterThan(1)
  const margins=preview.results[0].margins!
  await expect.poll(async()=>(await curves(plot)).filter(t=>t.name.endsWith('margin'))).toEqual([
    {x:margins.x,y:margins.upper,name:'Upper margin'},{x:margins.x,y:margins.lower,name:'Lower margin'}])
  await page.screenshot({path:info.outputPath('point-margins.png'),animations:'disabled'})
  let next=await apply(page,dialog,'Remove selected glitches','deglitch');retained(latest,next,preview);latest=next
  for(const side of ['before','after']) {
    await dialog.getByLabel('Operation',{exact:true}).selectOption('truncate')
    await dialog.getByLabel('Drop points',{exact:true}).selectOption(side)
    const index=side==='before'?20:latest.groups[0].energy.length-20
    const g=latest.groups[0],cut=(g.energy[index]+g.energy[index+1])/2+g.parameters.energy_shift
    await dialog.getByLabel('Cutoff energy · eV',{exact:true}).fill(String(cut))
    preview=await review(page,dialog)
    expect(preview.results[0].snapped).toBe(g.energy[index]+g.parameters.energy_shift)
    expect(preview.results[0].kept_indices.includes(index)).toBe(side==='before')
    next=await apply(page,dialog,'Truncate data','truncate');retained(latest,next,preview);latest=next
  }
  const undone=await apply(page,dialog,'Undo last edit','undo');expect(undone.groups[0].mu.length).toBeGreaterThan(latest.groups[0].mu.length)
  const redone=await apply(page,dialog,'Redo last edit','redo');expect(redone.groups).toEqual(latest.groups)
  await dialog.getByRole('button',{name:'Close point editing',exact:true}).click()
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const path=info.outputPath('ORP-edited-native.prj');await(await downloading).saveAs(path)
  writeFileSync(path,gunzipSync(readFileSync(path)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const response=await restoring;expect(response.ok()).toBe(true);const restored=(await response.json()).groups.at(-1)
  expect(restored.energy).toEqual(latest.groups[0].energy);expect(restored.mu).toEqual(latest.groups[0].mu)
  expect(restored.source.raw_arrays).toEqual(latest.groups[0].source.raw_arrays)
  expect(errors).toEqual([])
})

test('mobile ZT20 preview, conflict recovery and frozen marked truncation',async({page,context},info)=>{
  test.setTimeout(120000);await page.setViewportSize({width:390,height:844})
  const initial=await load(page,'ZT20.000');let dialog=await open(page)
  await dialog.getByLabel('Point energy · eV',{exact:true}).fill(String(initial.groups[0].energy[300]))
  await review(page,dialog)
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await dialog.getByLabel('Point removal plot',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('point-mobile-plot.png'),animations:'disabled'})
  const other=await context.newPage();await other.goto('/')
  const path=`/api/backend/api/athena/projects/${initial.id}`
  const changed=await other.request.post(path+'/command',{data:{version:initial.version,action:'metadata',group_ids:[initial.groups[0].id],options:{notes:'Concurrent review'}}})
  expect(changed.ok()).toBe(true)
  const failed=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='deglitch')
  await dialog.getByRole('button',{name:'Remove point',exact:true}).click();expect((await failed).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toBeVisible()
  expect((await(await other.request.get(path)).json()).groups[0].mu).toHaveLength(586)
  await dialog.getByRole('button',{name:'Close point editing',exact:true}).click();await page.reload()
  await page.getByRole('button',{name:'Group',exact:true}).click();await page.getByRole('button',{name:'Duplicate current group',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Data groups 2',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Freeze group',exact:true}).click()
  await expect(page.getByRole('button',{name:'Unfreeze group',exact:true})).toBeVisible()
  const marking=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().options?.marked===true)
  await page.getByRole('checkbox',{name:'Mark all groups',exact:true}).click()
  expect((await marking).ok()).toBe(true)
  await expect(page.getByRole('checkbox',{name:'Mark all groups',exact:true})).toBeChecked()
  const before=await(await other.request.get(path)).json() as AthenaProject
  dialog=await open(page)
  await dialog.getByLabel('Source group',{exact:true}).selectOption(initial.groups[0].id)
  await dialog.getByLabel('Operation',{exact:true}).selectOption('truncate')
  await dialog.getByLabel('Cutoff energy · eV',{exact:true}).fill(String(initial.groups[0].energy[530]))
  await dialog.getByLabel('Apply to',{exact:true}).selectOption('marked')
  const preview=await review(page,dialog)
  expect(Object.keys(preview.skipped_reasons)).toHaveLength(1)
  await dialog.getByLabel('Apply to',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('point-mobile-marked.png'),animations:'disabled'})
  const next=await apply(page,dialog,'Truncate data','truncate');retained(before,next,preview)
  expect(next.groups.find(g=>g.frozen)).toEqual(before.groups.find(g=>g.frozen))
  await other.close()
})
