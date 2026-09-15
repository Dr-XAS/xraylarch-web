import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { MergePreview } from '../../components/athena-merge'

test.use({actionTimeout:15000})
async function curves(plot:Locator){
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(el=>(el as HTMLElement&{data:{x:number[];y:number[];name:string}[]}).data.map(t=>({x:[...t.x],y:[...t.y],name:t.name})))
}
async function load(page:Page){
  await page.goto('/');let project:AthenaProject|undefined
  for(const suffix of ['060','061','062']){
    const file=fileURLToPath(new URL(`../../../backend/tests/fixtures/demeter-merge-fe.${suffix}`,import.meta.url))
    const rows=readFileSync(file,'utf8').split('\n').filter(l=>/^\s+\d+\.\d+\s+\d/.test(l)).map(l=>l.trim().split(/\s+/).map(Number))
    await page.getByRole('button',{name:'Import data',exact:true}).click()
    await page.getByLabel('Choose data files',{exact:true}).setInputFiles(file)
    const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
    await dialog.getByRole('button',{name:'Clear numerator',exact:true}).click()
    await dialog.getByRole('checkbox',{name:'Numerator i0',exact:true}).check()
    await dialog.getByRole('button',{name:'Clear denominator',exact:true}).click()
    await dialog.getByRole('checkbox',{name:'Denominator it',exact:true}).check()
    await dialog.getByRole('checkbox',{name:'Natural log',exact:true}).check()
    await dialog.getByText('Reference channel & ordering',{exact:true}).click()
    // Reuse the measured transmission as a constructed linked reference;
    // these are three real scans, not six independent measurements.
    await dialog.getByRole('combobox',{name:'reference numerator',exact:true}).selectOption({label:'i0 · column 2'})
    await dialog.getByRole('combobox',{name:'reference denominator',exact:true}).selectOption({label:'it · column 3'})
    await dialog.getByLabel('Reference natural log',{exact:true}).check()
    await dialog.getByText('Preprocess imported groups',{exact:true}).click()
    await dialog.getByLabel('Mark each imported sample',{exact:true}).check()
    await expect.poll(async()=>{
      const ts=await curves(dialog.getByLabel('Imported signal preview plot',{exact:true}))
      return ts.length===2&&ts.every(t=>t.x.length===rows.length&&t.x.every((x,i)=>x===rows[i][0])&&t.y.every((y,i)=>Math.abs(y-Math.log(rows[i][1]/rows[i][2]))<1e-12))
    }).toBe(true)
    const wait=page.waitForResponse(r=>r.url().endsWith('/import'));await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
    const response=await wait;expect(response.ok()).toBe(true);project=await response.json();await expect(dialog).toHaveCount(0)
  }
  return project!
}
async function review(page:Page,dialog:Locator){
  const replot=dialog.getByRole('button',{name:'Replot merge',exact:true});await expect(replot).toBeEnabled()
  const wait=page.waitForResponse(r=>r.url().endsWith('/merge/preview'));await replot.click();const response=await wait
  expect(response.ok()).toBe(true);const v=await response.json() as MergePreview
  await expect(dialog.getByRole('button',{name:'Save merged groups',exact:true})).toBeEnabled()
  await expect.poll(()=>curves(dialog.getByLabel('Merge plot figure',{exact:true}))).toEqual(v.outputs[0].plots[v.options.plot])
  return v
}

for(const mobile of [false,true])test(`${mobile?'mobile':'desktop'} measured Fe merge, linked references, saved spread plots and bare PRJ`,async({page},info)=>{
  test.setTimeout(180000);await page.setViewportSize(mobile?{width:390,height:844}:{width:1500,height:1100})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const initial=await load(page);expect(initial.groups).toHaveLength(6)
  expect(initial.groups.map(g=>g.marked)).toEqual([true,false,true,false,true,false])
  // The native shortcuts choose the requested space, including on reopening.
  await page.locator('body').click({position:{x:2,y:2}});await page.keyboard.press('Control+Shift+N')
  const dialog=page.getByRole('dialog',{name:'Merge marked groups',exact:true})
  await expect(dialog.getByLabel('Merge as',{exact:true})).toHaveValue('norm')
  let v=await review(page,dialog);expect(v.outputs).toHaveLength(2)
  for(const weighting of mobile?['step']:['step','noise']){
    await dialog.getByLabel('Merge weighting',{exact:true}).selectOption(weighting);v=await review(page,dialog)
    expect(v.options.weightby).toBe(weighting)
    if(weighting==='noise')await expect(dialog.getByText(/larger noise receives more weight/)).toBeVisible()
  }
  await dialog.getByLabel('Merge weighting',{exact:true}).selectOption('importance')
  for(const [i,g] of initial.groups.filter(g=>g.marked).entries())await dialog.getByLabel(`Importance: ${g.label}`,{exact:true}).fill(String(i+1))
  await dialog.getByLabel('Merge as',{exact:true}).selectOption('chi');v=await review(page,dialog);expect(v.outputs).toHaveLength(1)
  await dialog.getByLabel('Merge as',{exact:true}).selectOption('mu');v=await review(page,dialog);expect(v.outputs).toHaveLength(2)
  expect(v.outputs[0].result.members.map(m=>m.coefficient)).toEqual([1/6,2/6,3/6])
  await dialog.getByLabel('Merge output',{exact:true}).selectOption('reference')
  await expect.poll(()=>curves(dialog.getByLabel('Merge plot figure',{exact:true}))).toEqual(v.outputs[1].plots.stddev)
  await dialog.getByLabel('Merge output',{exact:true}).selectOption('sample')
  await dialog.getByLabel('Merge plot figure',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('merge-preview.png'),animations:'disabled'})
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  const wait=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='merge')
  await dialog.getByRole('button',{name:'Save merged groups',exact:true}).click();const response=await wait
  expect(response.ok()).toBe(true);const saved=await response.json() as AthenaProject
  await expect(dialog.getByText('Merge saved. The source spectra are unchanged.',{exact:true})).toBeVisible()
  await expect(dialog.getByText('3 source groups',{exact:true})).toBeAttached()
  expect(saved.groups.slice(0,6)).toEqual(initial.groups)
  for(const [i,g] of saved.groups.slice(6).entries()){
    expect(g.energy).toEqual(v.outputs[i].result.x);expect(g.mu).toEqual(v.outputs[i].result.y)
    expect((g.source.raw_arrays as {stddev:number[]}).stddev).toEqual(v.outputs[i].result.stddev)
  }
  expect(saved.groups[6].reference_id).toBe(saved.groups[7].id);expect(saved.groups[7].reference_id).toBe(saved.groups[6].id)
  for(const view of ['variance','marked','stddev'] as const){
    await dialog.getByLabel('Merge plot',{exact:true}).selectOption(view)
    await expect.poll(()=>curves(dialog.getByLabel('Merge plot figure',{exact:true}))).toEqual(v.outputs[0].plots[view])
  }
  await dialog.getByRole('button',{name:'Close merge result',exact:true}).click()
  const undo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='undo');await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await(await undo).json()).groups).toEqual(initial.groups)
  const redo=page.waitForResponse(r=>r.url().endsWith('/command')&&r.request().postDataJSON().action==='redo');await page.getByRole('button',{name:'Redo',exact:true}).click();expect((await(await redo).json()).groups).toEqual(saved.groups)
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click();const path=info.outputPath('merged-native.prj');await(await download).saveAs(path)
  const native=gunzipSync(readFileSync(path)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n');expect(native).toContain('is_merge');writeFileSync(path,native)
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click();await page.getByLabel('Open project file',{exact:true}).setInputFiles(path)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click();const restoredResponse=await restoring;expect(restoredResponse.ok()).toBe(true)
  const restored=(await restoredResponse.json() as AthenaProject).groups.slice(-2)
  for(const [i,g] of restored.entries()){
    expect(g.energy).toEqual(saved.groups[i+6].energy);expect(g.mu).toEqual(saved.groups[i+6].mu)
    expect((g.source.raw_arrays as {stddev:number[]}).stddev).toEqual(v.outputs[i].result.stddev)
  }
  expect(restored[0].reference_id).toBe(restored[1].id);expect(restored[1].reference_id).toBe(restored[0].id)
  expect(errors).toEqual([])
})
