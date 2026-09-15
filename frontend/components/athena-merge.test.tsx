import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaMerge, type MergePreview } from './athena-merge'
import { mergeDefaults, mergePreview, mergeSaved } from './athena-merge.fixtures'

const plot=vi.hoisted(()=>vi.fn<(p:ComponentProps<typeof Plot>)=>void>())
vi.mock('next/dynamic',()=>({default:()=>(props:ComponentProps<typeof Plot>)=>{useLayoutEffect(()=>plot(props));return <div/>}}))
vi.mock('@/lib/athena',()=>({athenaApi:vi.fn()}))
const api=vi.mocked(athenaApi),x=Array.from({length:8},(_,i)=>8970+i)
const project={id:'p',version:4,groups:['first','second','third'].map(id=>({id,label:id,data_type:'mu',energy:x,mu:x.map((_,i)=>i/8),marked:true,reference_id:null,
  parameters:{e0:8979,energy_shift:0},result:{arrays:{energy:x,norm:x,chi:x,k:x}},source:{}}))} as unknown as AthenaProject
const props=()=>({project,setBusy:vi.fn(),saved:vi.fn(),close:vi.fn(),rememberDraft:vi.fn()})
type Request={group_ids:string[];options:MergePreview['options']}
function serve(mutate?:(v:MergePreview)=>void){api.mockImplementation(async(path,body)=>{
  if(path==='/preferences/merge')return structuredClone(mergeDefaults)
  const r=body as Request,v=mergePreview(project,r.group_ids,r.options);mutate?.(v)
  return path.endsWith('/command')?mergeSaved(project,v):v
})}
const save=()=>screen.getByRole('button',{name:'Save merged groups'})
const change=(name:string,value:string)=>fireEvent.change(screen.getByLabelText(name,{exact:true}),{target:{value}})
async function ready(){await waitFor(()=>expect(save()).toBeEnabled(),{timeout:2500})}
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it.each(['revision','request','axis','scatter','coefficient','missing-source','duplicate-output'])('rejects a malformed %s preview before allowing save',async(kind)=>{
  serve(v=>{
    if(kind==='revision')v.version--
    if(kind==='request')v.requested_options={...v.requested_options,array:'chi'}
    if(kind==='axis')v.outputs[0].result.x[1]=v.outputs[0].result.x[0]
    if(kind==='scatter')v.outputs[0].result.stddev[0]=-1
    if(kind==='coefficient')v.outputs[0].result.members[0].coefficient=1
    if(kind==='missing-source'){v.outputs[0].result.members.pop();v.outputs[0].result.details.count=2;v.outputs[0].result.members.forEach(m=>m.coefficient=.5)}
    if(kind==='duplicate-output')v.outputs.push(structuredClone(v.outputs[0]))
  });render(<AthenaMerge {...props()}/>)
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('does not match'),{timeout:2500});expect(save()).toBeDisabled()
})

it('ignores a delayed preview after weights change and immediately disables stale save',async()=>{
  serve();let resolve!:(v:MergePreview)=>void;let stale:MergePreview|undefined
  const impl=api.getMockImplementation()!
  api.mockImplementation(async(path,body,...rest)=>{
    if(path.endsWith('/preview')&&!stale){const r=body as Request;stale=mergePreview(project,r.group_ids,r.options);return new Promise<MergePreview>(r=>{resolve=r})}
    return impl(path,body,...rest)
  })
  render(<AthenaMerge {...props()}/>);await waitFor(()=>expect(stale).toBeDefined(),{timeout:2500})
  change('Importance: first','3');expect(save()).toBeDisabled();await ready()
  await act(async()=>resolve(stale!));expect(save()).toBeEnabled()
  fireEvent.click(save());await waitFor(()=>expect(api.mock.calls.at(-1)![0]).toContain('/command'))
  expect((api.mock.calls.at(-1)![1] as Request).options.weights.first).toBe(3)
})

it('retains the saved inputs and all three spread views after the new marked group arrives',async()=>{
  serve();const p=props(),view=render(<AthenaMerge {...p}/>);await ready()
  const r=api.mock.calls.at(-1)![1] as Request,v=mergePreview(project,r.group_ids,r.options),next=mergeSaved(project,v)
  fireEvent.click(save());await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(next,'merged-0'))
  view.rerender(<AthenaMerge {...p} project={next}/>)
  expect(screen.getByText('3 source groups')).toBeVisible();expect(screen.queryByLabelText('Importance: merge')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Merge as')).toBeDisabled()
  for(const mode of ['variance','marked','stddev'] as const){change('Merge plot',mode);expect(plot.mock.calls.at(-1)![0].data.map(t=>({x:t.x,y:t.y,name:t.name}))).toEqual(v.outputs[0].plots[mode])}
  expect(p.close).not.toHaveBeenCalled()
})

it.each(['source','scatter'])('refuses a save response with changed %s arrays',async(kind)=>{
  serve();const p=props();render(<AthenaMerge {...p}/>);await ready()
  const r=api.mock.calls.at(-1)![1] as Request,next=structuredClone(mergeSaved(project,mergePreview(project,r.group_ids,r.options)))
  if(kind==='source')next.groups[0].mu[0]++
  else (next.groups.at(-1)!.source.raw_arrays as {stddev:number[]}).stddev[0]++
  api.mockResolvedValueOnce(next);fireEvent.click(save());await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('differs from the preview'))
  expect(p.saved).not.toHaveBeenCalled();expect(save()).toBeDisabled()
})

it('allows preference failure recovery and explicitly reloads saved settings over an edited draft',async()=>{
  serve();api.mockRejectedValueOnce(new Error('Cannot read saved preferences.'))
  render(<AthenaMerge {...props()}/>);await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Cannot read saved preferences'))
  expect(save()).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Reload saved defaults'}));await ready()
  change('Short-scan margin · points','20');await ready()
  fireEvent.click(screen.getByRole('button',{name:'Reload saved defaults'}));await waitFor(()=>expect(screen.getByLabelText('Short-scan margin · points')).toHaveValue(10));await ready()
})
