import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../../../backend/tests/fixtures/${name}`, import.meta.url))
const source = fixture('demeter-data.zip')
const oracle = JSON.parse(readFileSync(fixture('athena-zip-native.json'),'utf8'))
// Independent standard ZIP reader exposes the pinned native fixture's bytes.
const members: { name: string; text: string }[] = JSON.parse(execFileSync('python3',['-c',
  'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([dict(name=i.filename,text=z.read(i).decode()) for i in z.infolist()]))',source],{encoding:'utf8'}))
const rows = (index: number) => members[index].text.split('\n').filter(l => /^\s*\d/.test(l)).map(l => l.trim().split(/\s+/).map(Number))
async function enable(page: Page, names: string[]) {
  await page.getByRole('button',{ name:'File',exact:true }).click()
  await page.getByRole('button',{ name:'Plugin registry…',exact:true }).click()
  const dialog=page.getByRole('dialog',{ name:'Plugin registry',exact:true })
  for(const name of names) {
    const toggle=dialog.getByRole('checkbox',{ name:`Enable ${name}`,exact:true });await expect(toggle).toBeEnabled()
    if(!await toggle.isChecked()) {
      const saved=page.waitForResponse(r=>r.url().endsWith('/preferences/plugins')&&r.request().method()==='PUT')
      await toggle.click();expect((await saved).ok()).toBe(true)
    }
  }
  await dialog.getByRole('button',{ name:'Close registry',exact:true }).click()
}
async function curve(plot: Locator) {
  await expect(plot.locator('.js-line').first()).toBeAttached()
  return plot.locator('.js-plotly-plot').evaluate(node=>{
    const t=(node as HTMLElement & {data:{x:number[];y:number[]}[]}).data[0]
    return {x:[...t.x],y:[...t.y]}
  })
}
async function signal(plot: Locator,index: number,invert=false) {
  const data=rows(index),x=data.map(r=>r[0]),y=data.map(r=>(invert?-1:1)*Math.log(Math.abs(r[1]/r[2])))
  await expect.poll(async()=>(await curve(plot)).x).toEqual(x)
  await expect.poll(async()=>{
    const actual=(await curve(plot)).y
    return actual.length===y.length ? Math.max(...actual.map((v,i)=>Math.abs(v-y[i]))) : Infinity
  }).toBeLessThan(1e-13)
}

test('official ZIP subset has native bytes, live column edits, E/k/R/q and saved PRJ roundtrip',async({page},info)=>{
  test.setTimeout(90000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('/');await enable(page,['Zip'])
  await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(source)
  const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
  const chooser=dialog.getByRole('region',{name:'ZIP file selection',exact:true})
  await expect(chooser).toContainText('3 files')
  await chooser.getByRole('checkbox',{name:'Include fe.061 · entry 2',exact:true}).uncheck()
  const original=page.waitForEvent('download');await chooser.getByRole('link',{name:'Download original ZIP',exact:true}).click()
  const downloaded=info.outputPath('original.zip');await (await original).saveAs(downloaded)
  expect(readFileSync(downloaded)).toEqual(readFileSync(source))
  const first=page.waitForEvent('download');await chooser.getByRole('link',{name:'Download fe.060',exact:true}).click()
  const firstPath=info.outputPath('fe.060');await (await first).saveAs(firstPath)
  expect(createHash('sha256').update(readFileSync(firstPath)).digest('hex')).toBe(oracle.members[0].sha256)
  await page.setViewportSize({width:390,height:844})
  await expect.poll(()=>dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true)
  await dialog.screenshot({path:info.outputPath('zip-mobile.png')})
  await chooser.getByRole('button',{name:'Review selected files',exact:true}).click()
  await page.setViewportSize({width:1280,height:900})
  const plot=dialog.getByLabel('Imported signal preview plot',{exact:true})
  await signal(plot,0)
  await dialog.getByRole('checkbox',{name:'Reuse this mapping for remaining files with matching column labels',exact:true}).uncheck()
  await dialog.getByRole('checkbox',{name:'Invert signal',exact:true}).check();await signal(plot,0,true)
  await dialog.getByRole('checkbox',{name:'Invert signal',exact:true}).uncheck();await signal(plot,0)
  await plot.scrollIntoViewIfNeeded();await dialog.screenshot({path:info.outputPath('zip-columns.png')})
  const importing=page.waitForResponse(r=>r.url().endsWith('/import'))
  await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click();expect((await importing).ok()).toBe(true)
  await signal(plot,2)
  const last=page.waitForResponse(r=>r.url().endsWith('/import'))
  await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const response=await last;expect(response.ok()).toBe(true)
  const project=await response.json();expect(project.groups.map((g:{label:string})=>g.label)).toEqual(['fe.060','fe.062'])
  expect(project.groups.every((g:{processing_error:unknown})=>g.processing_error===null)).toBe(true)
  const group=project.groups[1]
  for(const [tab,space,xkey,ykey] of [['E Energy','E','energy','norm'],['k EXAFS','k','k','weighted_chi'],['R Fourier','R','r','chir_mag'],['q Back transform','q','q','chiq_mag']]) {
    await page.getByRole('tab',{name:tab,exact:true}).click()
    await expect.poll(()=>curve(page.getByLabel(`${space}-space spectrum plot`,{exact:true})))
      .toEqual({x:group.result.arrays[xkey],y:group.result.arrays[ykey].map((v:number)=>v===0?0:v)})
  }
  const saving=page.waitForEvent('download');await page.getByRole('link',{name:'Save project',exact:true}).click()
  const prj=info.outputPath('zip-roundtrip.prj');await (await saving).saveAs(prj)
  await page.getByRole('button',{name:'Open project',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles(prj)
  const restored=page.waitForResponse(r=>r.url().endsWith('/restore-upload'))
  await page.getByRole('button',{name:'Import all groups',exact:true}).click()
  const result=await (await restored).json();expect(result.groups).toHaveLength(4)
  expect(result.groups[3].source).toEqual(group.source);expect(result.groups[3].result.arrays).toEqual(group.result.arrays)
  await page.reload();await expect(page.getByRole('heading',{name:'Data groups 4',exact:true})).toBeVisible()
  expect(errors).toEqual([])
})

test('ZIP from Open project preserves mixed project, scan and nested-archive order and can skip a non-data file',async({page},info)=>{
  test.setTimeout(90000)
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  const prj=fileURLToPath(new URL('../../../examples/xafsdata/AthenaProjectFiles/cu.prj',import.meta.url))
  const mixed=execFileSync('python3',['-c',
    'import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); z.writestr("readme.txt",b"Experiment notes"); z.write(sys.argv[1],"projects/cu.prj"); z.write(sys.argv[2],"scans/bm23.dat"); z.write(sys.argv[3],"nested.zip"); z.close(); sys.stdout.buffer.write(b.getvalue())',prj,fixture('constructed-bm23-multiscan.dat'),source])
  await page.goto('/');await enable(page,['Zip','BM23'])
  await page.getByRole('button',{name:'Open project',exact:true}).click()
  await page.getByLabel('Open project file',{exact:true}).setInputFiles({name:'mixed.zip',mimeType:'application/zip',buffer:mixed})
  const dialog=page.getByRole('dialog',{name:'Import spectra',exact:true})
  await dialog.getByRole('button',{name:'Review selected files',exact:true}).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button',{name:'Skip this file',exact:true}).click()
  const projectDialog=page.getByRole('dialog',{name:'Open a project',exact:true})
  await expect(projectDialog.locator('.js-line').first()).toBeVisible()
  await projectDialog.getByRole('button',{name:'Import all groups',exact:true}).click()
  await expect(dialog.getByRole('region',{name:'Scan selection',exact:true})).toBeVisible()
  await dialog.getByRole('checkbox',{name:'Include Scan 7 · entry 1',exact:true}).uncheck()
  await dialog.getByRole('button',{name:'Review selected scans',exact:true}).click()
  await expect(dialog.getByLabel('Imported signal preview plot').locator('.js-line').first()).toBeAttached()
  await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
  await expect(dialog.getByRole('region',{name:'ZIP file selection',exact:true})).toContainText('nested.zip')
  await dialog.getByRole('button',{name:'Select no files',exact:true}).click()
  await dialog.getByRole('checkbox',{name:'Include fe.061 · entry 2',exact:true}).check()
  await dialog.getByRole('button',{name:'Review selected files',exact:true}).click()
  await signal(dialog.getByLabel('Imported signal preview plot',{exact:true}),1)
  const imported=page.waitForResponse(r=>r.url().endsWith('/import'))
  await dialog.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const response=await imported;expect(response.ok()).toBe(true)
  const project=await response.json();expect(project.groups).toHaveLength(5)
  expect(project.groups.slice(0,3).map((g:{label:string})=>g.label)).toEqual(['cu010k.dat','cu050k.dat','cu150k.dat'])
  expect(project.groups[3].source.file_plugin.scan.number).toBe('9');expect(project.groups[4].label).toBe('fe.061')
  await page.screenshot({path:info.outputPath('mixed-import.png')})
  expect(errors).toEqual([])
})
