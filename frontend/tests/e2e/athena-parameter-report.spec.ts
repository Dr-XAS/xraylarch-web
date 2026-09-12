import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const python=fileURLToPath(new URL('../../../backend/.venv/bin/python',import.meta.url))
async function example(page:Page){
  await page.goto('/')
  const response=page.waitForResponse(r=>r.url().endsWith('/command') && r.request().postDataJSON().action==='example')
  await page.getByRole('button',{name:'Load copper foil example',exact:true}).click()
  const loaded=await response;expect(loaded.ok()).toBe(true);return loaded.json()
}
async function openReport(page:Page,scope='all'){
  await page.getByRole('button',{name:'Edit',exact:true}).click()
  const preview=page.waitForResponse(r=>r.url().endsWith('/parameter-report/preview'))
  await page.getByRole('button',{name:`Excel report on ${scope} groups…`,exact:true}).click()
  const response=await preview;expect(response.ok()).toBe(true)
  const dialog=page.getByRole('dialog',{name:'Excel parameter report',exact:true})
  await expect(dialog.getByRole('button',{name:'Download Excel report'})).toBeEnabled()
  return {dialog,report:await response.json()}
}
async function download(page:Page,info:TestInfo,filename:string){
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download Excel report'}).click()
  const file=await pending,path=info.outputPath(filename);await file.saveAs(path)
  expect(readFileSync(path).subarray(0,8).toString('hex')).toBe('d0cf11e0a1b11ae1')
  const data=JSON.parse(execFileSync(python,['-c','import sys,json,xlrd; s=xlrd.open_workbook(sys.argv[1],formatting_info=True).sheet_by_index(0); print(json.dumps(dict(rows=[s.row_values(i) for i in range(s.nrows)],types=[list(s.row_types(i)) for i in range(s.nrows)])))',path],{encoding:'utf8'}))
  return {name:file.suggestedFilename(),...data}
}

test('all and marked Excel downloads retain every previewed parameter, frozen group and numeric type',async({page},info)=>{
  await page.setViewportSize({width:1500,height:1040});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  let project=await example(page)
  const changed=await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`,{data:{version:project.version,action:'metadata',group_ids:[project.groups[1].id],options:{frozen:true,label:'铜 foil = 1'}}})
  expect(changed.ok()).toBe(true);project=await changed.json();await page.reload()
  let {dialog,report}=await openReport(page)
  expect(report.rows).toHaveLength(3)
  await dialog.getByLabel('Preview section').selectOption('background')
  await page.screenshot({path:info.outputPath('parameter-report-desktop.png')})
  const file=await download(page,info,'all.xls')
  report.rows.forEach((r:{values:(string|number|null)[]},i:number)=>report.columns.forEach((c:{index:number,label:string})=>{
    expect(file.rows[6][c.index]).toBe(c.label)
    expect(file.rows[7+i][c.index]).toBe(r.values[c.index] ?? 'n.a.')
    if(typeof r.values[c.index]==='number') expect(file.types[7+i][c.index]).toBe(2)
  }))
  expect(file.rows[8][0]).toBe('铜 foil = 1')
  expect(report.rows[0].values[6]).toBe(project.groups[0].result.effective.e0)
  await dialog.getByRole('button',{name:'Close report'}).click()
  const state=await page.request.get(`/api/backend/api/athena/projects/${project.id}`);expect((await state.json()).version).toBe(project.version)
  expect(errors).toEqual([])
})

test('mobile marked report uses list order and recovers from another-window revision conflict',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});let project=await example(page)
  for(const [i,g] of project.groups.entries()){
    const changed=await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`,{data:{version:project.version,action:'metadata',group_ids:[g.id],options:{marked:i!==1}}})
    expect(changed.ok()).toBe(true);project=await changed.json()
  }
  await page.reload();let {dialog,report}=await openReport(page,'marked')
  expect(report.rows.map((r:{group_id:string})=>r.group_id)).toEqual([project.groups[0].id,project.groups[2].id])
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  await page.screenshot({path:info.outputPath('parameter-report-mobile.png')})
  const changed=await page.request.post(`/api/backend/api/athena/projects/${project.id}/command`,{data:{version:project.version,action:'project',options:{name:'Updated in other window'}}})
  expect(changed.ok()).toBe(true);let downloads=0;page.on('download',()=>downloads++)
  await dialog.getByRole('button',{name:'Download Excel report'}).click()
  await expect(dialog.getByRole('alert')).toContainText('changed in another tab');expect(downloads).toBe(0)
  await page.reload();({dialog,report}=await openReport(page,'marked'))
  const file=await download(page,info,'marked.xls')
  expect(file.name).toBe('athena-parameters-marked.xls')
  report.rows.forEach((r:{values:(string|number|null)[]},i:number)=>report.columns.forEach((c:{index:number})=>expect(file.rows[7+i][c.index]).toBe(r.values[c.index] ?? 'n.a.')))
  expect(downloads).toBe(1)
})
