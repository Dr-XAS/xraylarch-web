import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaParameterReport } from './athena-parameter-report'

vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const project = { id:'p', version:4, groups:[{id:'a',label:'Cu',marked:true},{id:'b',label:'Fe',marked:false}] } as AthenaProject
const positions = Array.from({length:32},(_,i)=>i).filter(i=>![5,19,25,29].includes(i))
function report(scope='all') {
  return {project_id:'p',version:4,scope,filename:`athena-parameters-${scope}.xls`,
    columns:positions.map(index=>({index,key:`c${index}`,label:index===0?'Group':`Field ${index}`,unit:'',section:index<6?'identity':'background'})),
    sections:['identity','background','forward','reverse','plotting'].map(key=>({key,label:key})),
    rows:project.groups.filter(g=>scope==='all'||g.marked).map(g=>({group_id:g.id,label:g.label,values:Array.from({length:32},(_,i)=>i===0?g.label:i),notes:['Applied settings']}))}
}
const props=()=>({project,initialScope:'all' as const,close:vi.fn(),onBusyChange:vi.fn()})
afterEach(()=>{cleanup();api.mockReset();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function ready(){await waitFor(()=>expect(screen.getByRole('button',{name:'Download Excel report'})).toBeEnabled())}

it('previews saved revision, selects marked scope and changes preview section without changing export scope',async()=>{
  api.mockResolvedValueOnce(report()).mockResolvedValueOnce(report('marked'))
  render(<AthenaParameterReport {...props()}/>);await ready()
  expect(api).toHaveBeenCalledWith('/projects/p/parameter-report/preview',{version:4,scope:'all'},'POST',expect.any(AbortSignal))
  fireEvent.change(screen.getByLabelText('Preview section'),{target:{value:'background'}})
  expect(screen.getAllByRole('columnheader')).toHaveLength(24)
  expect(api).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('Report groups'),{target:{value:'marked'}});await ready()
  expect(screen.queryByRole('cell',{name:'Fe'})).not.toBeInTheDocument()
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,scope:'marked'})
})

it('handles empty marks without requesting or downloading an empty workbook',async()=>{
  render(<AthenaParameterReport {...props()} initialScope="marked" project={{...project,groups:project.groups.map(g=>({...g,marked:false}))}}/>)
  expect(screen.getByRole('status')).toHaveTextContent('Mark at least one group')
  expect(api).not.toHaveBeenCalled()
  expect(screen.getByRole('button',{name:'Download Excel report'})).toBeDisabled()
})

it('rejects the wrong group order and supports retry without losing scope',async()=>{
  api.mockResolvedValueOnce({...report(),rows:report().rows.reverse()}).mockResolvedValueOnce(report())
  render(<AthenaParameterReport {...props()}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
  fireEvent.click(screen.getByRole('button',{name:'Retry preview'}));await ready()
})

it('ignores a late all-groups preview after selecting marked groups',async()=>{
  let first!:(v:unknown)=>void
  api.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve})).mockResolvedValueOnce(report('marked'))
  render(<AthenaParameterReport {...props()}/>)
  fireEvent.change(screen.getByLabelText('Report groups'),{target:{value:'marked'}});await ready()
  await act(async()=>{first(report())})
  expect(screen.queryByRole('cell',{name:'Fe'})).not.toBeInTheDocument()
})

it('keeps choices on a revision conflict and does not save a stale report',async()=>{
  api.mockResolvedValue(report());vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'stale_revision',message:'Changed elsewhere'}}),{status:409})))
  render(<AthenaParameterReport {...props()}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Download Excel report'}))
  expect(await screen.findByRole('alert')).toHaveTextContent(/changed|elsewhere/i)
  expect(screen.getByLabelText('Report groups')).toHaveValue('all')
})

it('requires XLS attachment bytes and releases the busy guard on failure',async()=>{
  api.mockResolvedValue(report());const p=props()
  const blob={slice:()=>({arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})}
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers({'X-Athena-Project-Version':'4','Content-Disposition':'attachment; filename="athena-parameters-all.xls"'}),blob:async()=>blob}))
  render(<AthenaParameterReport {...p}/>);await ready()
  fireEvent.click(screen.getByRole('button',{name:'Download Excel report'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('valid XLS workbook')
  expect(p.onBusyChange).toHaveBeenCalledWith(true)
  await waitFor(()=>expect(p.onBusyChange).toHaveBeenLastCalledWith(false))
})
