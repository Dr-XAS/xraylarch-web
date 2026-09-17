import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page, type Locator } from '@playwright/test'
import type { AthenaProject } from '../../lib/athena'
import type { SavedMergePlot } from '../../components/athena-merge-plot'

test.use({actionTimeout:15000})
async function curves(plot:Locator){
  await expect(plot.locator('.js-line').first()).toBeVisible()
  return plot.locator('.js-plotly-plot').evaluate(el=>(el as HTMLElement&{data:{x:number[];y:number[];name:string}[]}).data.map(t=>({x:[...t.x],y:[...t.y],name:t.name})))
}
async function open(page:Page){
  await page.getByRole('button',{name:'Plot',exact:true}).click();await page.getByRole('button',{name:'Saved merge spread…',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Saved merge spread',exact:true})
  await expect(dialog.getByText(/saved points · project revision/)).toBeVisible();return dialog
}
async function review(page:Page,dialog:Locator){
  const replot=dialog.getByRole('button',{name:'Replot saved merge',exact:true});await expect(replot).toBeEnabled()
  const wait=page.waitForResponse(r=>r.url().endsWith('/merge/plot'));await replot.click();const response=await wait
  expect(response.ok()).toBe(true);const v=await response.json() as SavedMergePlot
  await expect.poll(()=>curves(dialog.getByLabel('Saved merge plot figure',{exact:true}))).toEqual(v.result.curves)
  return v
}

for(const [file,how] of [['AsScorodite.prj','e'],['Fe.prj','n'],['bal3ybco.prj','k']])for(const mobile of [false,true])test(`${mobile?'mobile':'desktop'} ${file}: historical merge spread, refresh and native reimport`,async({page},info)=>{
  test.setTimeout(180000);await page.setViewportSize(mobile?{width:390,height:844}:{width:1500,height:1100})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/')
  const path=fileURLToPath(new URL(`../../../examples/xafsdata/AthenaProjectFiles/${file}`,import.meta.url))
  await page.getByRole('button',{name:'Import data',exact:true}).click();await page.getByLabel('Choose data files',{exact:true}).setInputFiles(path)
  const importing=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const response=await importing;expect(response.ok()).toBe(true);const initial=await response.json() as AthenaProject
  const g=initial.groups.find(g=>(g.source.native as {args:{is_merge:string}})?.args?.is_merge===how&&(g.source.raw_arrays as {stddev:number[]})?.stddev?.length===g.energy.length)!
  expect(g).toBeTruthy();await page.locator('.ath-group-select').filter({hasText:g.label}).first().click()
  let dialog=await open(page),v=await review(page,dialog)
  expect(v.result.merge_space).toBe(({e:'mu',n:'norm',k:'chi'} as Record<string,string>)[how]);expect(v.result.points).toBe(g.energy.length)
  if(how==='n'){
    await dialog.getByLabel('Flatten normalized merge',{exact:true}).uncheck();v=await review(page,dialog);expect(v.result.display).toBe('norm')
    await dialog.getByLabel('Flatten normalized merge',{exact:true}).check();v=await review(page,dialog);expect(v.result.display).toBe('flat')
  }
  if(how==='k'){
    await dialog.getByLabel('Saved merge k weight',{exact:true}).fill('1.5');v=await review(page,dialog);expect(v.result.kweight).toBe(1.5)
  }
  await dialog.getByLabel('Saved merge display',{exact:true}).selectOption('variance');v=await review(page,dialog);expect(v.result.curves).toHaveLength(2)
  if(how==='e'){
    await dialog.getByLabel('Saved merge energy display',{exact:true}).selectOption('norm');v=await review(page,dialog);expect(v.result.display).toBe('norm')
  }
  await dialog.getByLabel('Saved merge plot figure',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('saved-merge-spread.png'),animations:'disabled'})
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await dialog.getByRole('button',{name:'Close merge plot',exact:true}).click()
  expect(await(await page.request.get(`/api/backend/api/athena/projects/${initial.id}`)).json()).toEqual(initial)
  await page.reload();await page.locator('.ath-group-select').filter({hasText:g.label}).first().click();dialog=await open(page)
  const baseline=await review(page,dialog);await dialog.getByRole('button',{name:'Close merge plot',exact:true}).click()
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save project',exact:true}).click();const savedPath=info.outputPath('saved-native.prj');await(await download).saveAs(savedPath)
  writeFileSync(savedPath,gunzipSync(readFileSync(savedPath)).toString().split('\n').filter(l=>!l.startsWith('# Athena-Web ')).join('\n'))
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Open project…',exact:true}).click();await page.getByLabel('Open project file',{exact:true}).setInputFiles(savedPath)
  const restoring=page.waitForResponse(r=>r.url().endsWith('/restore-upload'));await page.getByRole('button',{name:'Import all groups',exact:true}).click();const restoredResponse=await restoring;expect(restoredResponse.ok()).toBe(true)
  const restored=await restoredResponse.json() as AthenaProject,newGroup=restored.groups[initial.groups.length+initial.groups.findIndex(x=>x.id===g.id)]
  await page.locator('.ath-group-select').filter({hasText:newGroup.label}).last().click();dialog=await open(page);const roundtrip=await review(page,dialog)
  for(const [i,curve] of roundtrip.result.curves.entries()){
    expect(curve.x).toEqual(baseline.result.curves[i].x)
    expect(Math.max(...curve.y.map((y,j)=>Math.abs(y-baseline.result.curves[i].y[j])))).toBeLessThan(1e-9)
  }
  expect((newGroup.source.raw_arrays as {stddev:number[]}).stddev).toEqual((g.source.raw_arrays as {stddev:number[]}).stddev)
  expect(errors).toEqual([])
})
