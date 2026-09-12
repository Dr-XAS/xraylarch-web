import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const fixtures = fileURLToPath(new URL('../../../backend/tests/fixtures/', import.meta.url))
function rows(text: string) {
  return text.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.trim().split(/\s+/).map(Number))
}
function unzip(bytes: Buffer) {
  const files: { name: string; text: string }[] = []
  let offset=0
  while(bytes.readUInt32LE(offset) === 0x04034b50) {
    const method=bytes.readUInt16LE(offset+8), length=bytes.readUInt32LE(offset+18)
    const namesize=bytes.readUInt16LE(offset+26), extra=bytes.readUInt16LE(offset+28)
    const name=bytes.subarray(offset+30,offset+30+namesize).toString('utf8'), start=offset+30+namesize+extra
    const data=bytes.subarray(start,start+length)
    files.push({name,text:(method===8 ? inflateRawSync(data) : data).toString('utf8')});offset=start+length
  }
  return files
}
async function openExport(page: Page) {
  await page.getByRole('button',{name:'File',exact:true}).click()
  const ready=page.waitForResponse(r=>r.url().endsWith('/export-data/preview'))
  await page.getByRole('button',{name:'Export column data…',exact:true}).click()
  const response=await ready; expect(response.ok()).toBe(true)
  const dialog=page.getByRole('dialog',{name:'Export column data',exact:true})
  await expect(dialog.getByRole('button',{name:'Download column file',exact:true})).toBeEnabled()
  return {dialog,preview:await response.json()}
}
async function download(page: Page, info: TestInfo, button: string, filename: string) {
  const event=page.waitForEvent('download')
  await page.getByRole('button',{name:button,exact:true}).click()
  const file=await event, path=info.outputPath(filename);await file.saveAs(path)
  return {name:file.suggestedFilename(),path,raw:readFileSync(path)}
}
async function example(page: Page) {
  await page.goto('/')
  const waiting=page.waitForResponse(r=>r.url().endsWith('/command') && r.request().postDataJSON().action==='example')
  await page.getByRole('button',{name:'Load copper foil example',exact:true}).click()
  const response=await waiting;expect(response.ok()).toBe(true);return response.json()
}

test('measured XDI exports full native columns, comments and header and reimports absorption',async({page},info)=>{
  await page.setViewportSize({width:1500,height:1040});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('/');await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(fixtures+'xdi-official-cu_metal_rt.xdi')
  const waiting=page.waitForResponse(r=>r.url().endsWith('/import'));await page.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const imported=await waiting;expect(imported.ok()).toBe(true);const project=await imported.json(), group=project.groups[0]
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const {dialog,preview}=await openExport(page)
  expect(preview.files[0].rows).toBe(408);expect(preview.files[0].columns.map((c:{name:string})=>c.name)).toEqual(['energy','xmu','bkg','pre_edge','post_edge','der','sec','i0'])
  await dialog.getByText('File header and processing parameters',{exact:true}).click()
  await expect(dialog.locator('pre')).toContainText('GSE/1.0')
  await page.screenshot({path:info.outputPath('data-export-desktop.png')})
  const file=await download(page,info,'Download column file','exported.xmu'), text=file.raw.toString('utf8'), table=rows(text)
  expect(table).toHaveLength(408)
  table.forEach((row,i)=>{expect(row[0]).toBeCloseTo(group.energy[i],7);expect(row[1]).toBeCloseTo(group.mu[i],8);expect(row[7]).toBeCloseTo(group.source.raw_arrays.i0[i],5)})
  expect(text).toContain('Athena.post_edge_polynomial:');expect(text).toContain('Cu foil Room Temperature')
  await dialog.getByRole('button',{name:'Close export'}).click()
  await page.getByRole('button',{name:'Import data',exact:true}).click()
  await page.getByLabel('Choose data files',{exact:true}).setInputFiles(file.path)
  const reimporting=page.waitForResponse(r=>r.url().endsWith('/import'))
  await page.getByRole('button',{name:'Import spectrum',exact:true}).click()
  const restored=await reimporting;expect(restored.ok()).toBe(true)
  const added=(await restored.json()).groups.at(-1)
  expect(added.mu).toHaveLength(408);added.mu.forEach((v:number,i:number)=>expect(v).toBeCloseTo(group.mu[i],8))
  expect(added.source.xdi_metadata.attributes.beamline).toEqual(group.source.xdi_metadata.attributes.beamline)
  expect(added.source.xdi_metadata.attributes.element).toEqual({symbol:'Cu',edge:'K'})
  expect(added.source.xdi_metadata.comments_text).toContain('Cu foil Room Temperature')
  expect(errors).toEqual([])
})

test('mobile marked output and separate ZIP retain order, distinct names and arbitrary weights',async({page},info)=>{
  test.setTimeout(90000)
  await page.setViewportSize({width:390,height:844});let project=await example(page)
  for (const [index,g] of project.groups.entries()) {
    const response=await page.request.post('/api/backend/api/athena/projects/'+project.id+'/command',{data:{
      version:project.version,action:'metadata',group_ids:[g.id],options:{marked:true,label:index<2 ? ['Cu/foil','Cu:foil'][index] : g.label,multiplier:index+1},
    }})
    expect(response.ok()).toBe(true);project=await response.json()
  }
  await page.reload();const {dialog}=await openExport(page)
  await dialog.getByLabel('Export groups').selectOption('marked')
  await expect(dialog.getByRole('table')).toHaveCount(1)
  await expect(dialog.getByText('marked.xmu',{exact:true})).toBeVisible()
  await dialog.getByLabel("Apply each group's plot multiplier").check()
  await expect(dialog.locator('p').filter({hasText:'multiplier=3'})).toBeVisible()
  const combined=await download(page,info,'Download column file','marked.xmu'), table=rows(combined.raw.toString('utf8'))
  expect(table[0]).toHaveLength(4);expect(table).toHaveLength(project.groups[0].energy.length)
  table.forEach((row,i)=>expect(row[1]).toBeCloseTo(project.groups[0].mu[i],7))
  await dialog.getByLabel('Export groups').selectOption('each')
  await dialog.getByLabel('Data form').selectOption('chi')
  await dialog.getByLabel('Output k weight').selectOption('kw')
  await dialog.getByLabel('Use a shared output weight').check()
  await dialog.getByLabel('Arbitrary output k weight').fill('1.5')
  await expect(dialog.getByRole('button',{name:'Download ZIP'})).toBeEnabled()
  await dialog.getByLabel('Export groups').scrollIntoViewIfNeeded()
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true)
  await page.screenshot({path:info.outputPath('data-export-mobile.png')})
  const zipped=await download(page,info,'Download ZIP','marked.zip'), files=unzip(zipped.raw)
  expect(files).toHaveLength(3);expect(files.slice(0,2).map(f=>f.name)).toEqual(['Cu_foil.chik','Cu_foil-2.chik'])
  files.forEach((file,index)=>{
    const values=rows(file.text), a=project.groups[index].result.arrays
    expect(values).toHaveLength(a.k.length)
    values.forEach((row,i)=>{expect(row).toHaveLength(2);expect(row[1]).toBeCloseTo(a.chi[i]*a.k[i]**1.5,7)})
  })
  const state=await page.request.get('/api/backend/api/athena/projects/'+project.id)
  expect((await state.json()).version).toBe(project.version)
})

test('another-window revision conflict cannot download old data and reload recovers',async({page},info)=>{
  const project=await example(page);let {dialog}=await openExport(page)
  const changed=await page.request.post('/api/backend/api/athena/projects/'+project.id+'/command',{data:{version:project.version,action:'project',options:{name:'Updated elsewhere'}}})
  expect(changed.ok()).toBe(true);let downloads=0;page.on('download',()=>downloads++)
  await dialog.getByRole('button',{name:'Download column file',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('changed in another tab')
  expect(downloads).toBe(0)
  await page.reload();({dialog}=await openExport(page))
  const file=await download(page,info,'Download column file','new-revision.xmu')
  expect(rows(file.raw.toString('utf8')).length).toBeGreaterThan(300)
  expect(downloads).toBe(1)
})
