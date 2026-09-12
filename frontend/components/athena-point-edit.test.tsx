import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaPointEdit, type PointEditPreview } from './athena-point-edit'

type PlotProps = ComponentProps<typeof Plot>
type Options = PointEditPreview['options']
const plot = vi.hoisted(() => vi.fn<(p: PlotProps) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: PlotProps) => { useLayoutEffect(() => { plot(props) }); return <div/> } }))
vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const x = Array.from({length: 41}, (_, i) => 7000 + i), y = x.map((_, i) => Math.sin(i) + 2)
const project = { id: 'p', version: 4, undo: ['edit'], redo: [], groups: [{ id: 'g', label: 'Measured Zn', data_type: 'mu', frozen: false,
  marked: true, energy: x, mu: y, source: {}, parameters: {energy_shift: 2, kweight: 2},
  result: {effective: {e0: 7022, edge_step: 2, norm1: 5, norm2: 18}, arrays: {}} }] } as unknown as AthenaProject
const props = () => ({project, activeId: 'g', selectGroup: vi.fn(), setBusy: vi.fn(), saved: vi.fn(), close: vi.fn(), disabled: false,
  initialMode: 'point' as const, rememberDraft: vi.fn()})
const chie = {x: x.slice(22).map(v => v+2), y: y.slice(22).map(v => v*.1)}
function preview(options: Options, p=project): PointEditPreview {
  return {project_id: p.id, version: p.version, options, skipped_reasons: {}, changed_group_ids: [], results: p.groups.map(g => {
    const removed = options.mode==='inspect'?[]:options.mode==='point'?[Math.round(options.point!-7002)]
      :options.mode==='margins'?[30]:Array.from({length: 41},(_,i)=>i).filter(i=>options.side==='before'?i<Math.floor(options.value!-7002):i>=Math.floor(options.value!-7002))
    const kept = x.map((_, i) => i).filter(i => !removed.includes(i)), energy=kept.map(i=>x[i]), mu=kept.map(i=>y[i])
    const selected = removed.filter(i=>i>=22)
    return {group_id: g.id, label: g.label, kept_indices: kept, removed_indices: removed, energy, mu,
      selected_energy: removed.map(i=>x[i]+2), selected_mu: removed.map(i=>y[i]), input_points: 41, output_points: kept.length,
      snapped: options.mode==='truncate'?Math.floor(options.value!):null, processing_error: null,
      margins: options.mode==='margins'?{x:[7027,7040],upper:[3,3],lower:[1,1],baseline:[2,2],indices:[25,38],e0:7022,region:'post-edge'}:null,
      original: {mu: {x:x.map(v=>v+2),y},chie}, modified: {mu:{x:energy.map(v=>v+2),y:mu},chie},
      selected_chie: {x:selected.map(i=>x[i]+2),y:selected.map(i=>y[i]*.1)}}
  })}
}
const handoff = () => plot.mock.calls.at(-1)![0]
const remove = () => screen.getByRole('button', {name:'Remove point'})
const change = (name:string,value:string) => fireEvent.change(screen.getByLabelText(name,{exact:true}),{target:{value}})
const choose = (value='7032') => change('Point energy · eV',value)
function serve() { api.mockImplementation(async(_path,body)=>preview((body as {options:Options}).options)) }
async function ready() { await waitFor(()=>expect(remove()).toBeEnabled(),{timeout:2000}) }
async function inspected() { await screen.findByText('0 points selected at project revision 4.') }
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('immediately plots calibrated measured rows; initial inspection supplies chi(E) without deleting',async()=>{
  serve();render(<AthenaPointEdit {...props()}/>);
  expect(handoff().data[0].x).toEqual(x.map(v=>v+2));expect(handoff().data[0].y).toEqual(y)
  expect(remove()).toBeDisabled();await inspected()
  expect(api.mock.calls[0][1]).toEqual({version:4,action:'deglitch',group_ids:['g'],options:{mode:'inspect',scope:'current'}})
  fireEvent.click(screen.getByRole('button',{name:'Plot χ(E)'}))
  expect(handoff().data[0].x).toEqual(chie.x);expect(handoff().data[0].y).toEqual(chie.y)
  expect(remove()).toBeDisabled()
})

it('picks in chi(E), highlights the raw row, and saves exactly the reviewed in-place arrays',async()=>{
  serve();const p=props();render(<AthenaPointEdit {...p}/>);await inspected()
  fireEvent.click(screen.getByRole('button',{name:'Plot χ(E)'}))
  fireEvent.click(screen.getByRole('button',{name:'Pick Point energy · eV'}))
  act(()=>handoff().onClick?.({points:[{x:7032.1}]} as never));await ready()
  expect(screen.getByLabelText('Point energy · eV',{exact:true})).toHaveValue(7032.1)
  expect(handoff().data[2].x).toEqual([7032]);expect(handoff().data[2].y).toEqual([y[30]*.1])
  const reviewed=preview({mode:'point',point:7032.1,scope:'current'}).results[0]
  const next={...project,version:5,groups:[{...project.groups[0],energy:reviewed.energy,mu:reviewed.mu}]}
  api.mockResolvedValueOnce(next);fireEvent.click(remove());await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(next))
  expect(p.close).not.toHaveBeenCalled();expect(p.setBusy).toHaveBeenLastCalledWith('')
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'deglitch',group_ids:['g'],options:{mode:'point',point:7032.1,scope:'current'}})
})

it('cancels picking with Escape and does not use an old click handler after the project changes',async()=>{
  serve();const p=props(),rendered=render(<AthenaPointEdit {...p}/>);await inspected()
  fireEvent.click(screen.getByRole('button',{name:'Pick Point energy · eV'}))
  fireEvent.keyDown(screen.getByLabelText('Point energy · eV',{exact:true}),{key:'Escape'})
  act(()=>handoff().onClick?.({points:[{x:7032}]} as never))
  expect(screen.getByLabelText('Point energy · eV',{exact:true})).toHaveValue(null)
  fireEvent.click(screen.getByRole('button',{name:'Pick Point energy · eV'}));const old=handoff().onClick
  rendered.rerender(<AthenaPointEdit {...p} project={{...project,version:5}}/>);
  act(()=>old?.({points:[{x:7032}]} as never));expect(screen.getByLabelText('Point energy · eV',{exact:true})).toHaveValue(null)
})

it('uses signal-unit margin defaults, plots limits, plucks relative E0 and rejects a straddled edge',async()=>{
  serve();render(<AthenaPointEdit {...props()}/>);await inspected();change('Operation','margins')
  expect(screen.getByLabelText('Margin tolerance · signal units',{exact:true})).toHaveValue(.2)
  const save=screen.getByRole('button',{name:'Remove selected glitches'})
  await waitFor(()=>expect(save).toBeEnabled());expect(handoff().data).toHaveLength(5)
  fireEvent.click(screen.getByRole('button',{name:'Pick Minimum relative to E0 · eV'}))
  act(()=>handoff().onClick?.({points:[{x:7028.124}]} as never))
  expect(screen.getByLabelText('Minimum relative to E0 · eV',{exact:true})).toHaveValue(6.12)
  change('Minimum relative to E0 · eV','-5');expect(save).toBeDisabled()
  expect(screen.getByText('Enter finite values; margin limits must increase on the same side of E0.')).toBeVisible()
})

it('submits marked truncation with a floor anchor and preserves controls in its draft',async()=>{
  const p=props(),second={...project.groups[0],id:'second',label:'Frozen',frozen:true};p.project={...project,groups:[...project.groups,second]}
  api.mockImplementation(async(_path,body)=>{const options=(body as {options:Options}).options;const r=preview(options);if(options.scope==='marked')r.skipped_reasons={second:'Unfreeze this group'};return r})
  render(<AthenaPointEdit {...p} initialMode="truncate"/>);
  change('Cutoff energy · eV','7033.6');change('Apply to','marked')
  const save=screen.getByRole('button',{name:'Truncate data'});await waitFor(()=>expect(save).toBeEnabled())
  expect(screen.getByText(/Cutoff anchor: 7033 eV/)).toBeVisible()
  expect(screen.getByText('Frozen: Unfreeze this group')).toBeVisible()
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'truncate',group_ids:['g','second'],options:{mode:'truncate',side:'after',value:7033.6,scope:'marked'}})
  expect(p.rememberDraft).toHaveBeenLastCalledWith(expect.objectContaining({value:'7033.6',scope:'marked'}))
})

it.each(['marker','plot','partition','version'])('rejects an inconsistent %s response',async what=>{
  serve();render(<AthenaPointEdit {...props()}/>);await inspected()
  const result=preview({mode:'point',point:7032,scope:'current'}),r=result.results[0]
  if(what==='marker')r.selected_energy[0]+=1
  if(what==='plot')r.modified.mu!.y[0]+=1
  if(what==='partition')r.kept_indices[0]=1
  if(what==='version')result.version--
  api.mockResolvedValueOnce(result);choose()
  expect(await screen.findByRole('alert')).toBeVisible();expect(remove()).toBeDisabled()
})

it('discards delayed responses when values change and then revert',async()=>{
  serve();render(<AthenaPointEdit {...props()}/>);await inspected()
  let finish!:(v:PointEditPreview)=>void
  api.mockImplementationOnce(()=>new Promise(r=>{finish=r}));choose()
  await waitFor(()=>expect(api).toHaveBeenCalledTimes(2));choose('7033');choose()
  await ready();const good=handoff().data
  await act(async()=>finish({...preview({mode:'point',point:7032,scope:'current'}),version:3}))
  expect(handoff().data).toEqual(good);expect(screen.queryByRole('alert')).toBeNull();expect(remove()).toBeEnabled()
})

it('retains point and settings after a stale save, releases busy state and requires replot',async()=>{
  serve();const p=props();render(<AthenaPointEdit {...p}/>);await inspected();choose();await ready()
  api.mockRejectedValueOnce(new Error('Project changed. Reload.'));fireEvent.click(remove())
  expect(await screen.findByRole('alert')).toHaveTextContent('Project changed')
  expect(screen.getByLabelText('Point energy · eV',{exact:true})).toHaveValue(7032)
  expect(remove()).toBeDisabled();expect(p.setBusy).toHaveBeenLastCalledWith('');expect(p.saved).not.toHaveBeenCalled()
})

it('uses revisioned undo and redo without closing the panel',async()=>{
  serve();const p=props(),rendered=render(<AthenaPointEdit {...p}/>);await inspected()
  const undone={...project,version:5,undo:[],redo:['edit']} as unknown as AthenaProject
  api.mockResolvedValueOnce(undone);fireEvent.click(screen.getByRole('button',{name:'Undo last edit'}))
  await waitFor(()=>expect(p.saved).toHaveBeenCalledWith(undone));expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'undo'})
  rendered.rerender(<AthenaPointEdit {...p} project={undone}/>);
  const redone={...project,version:6};api.mockResolvedValueOnce(redone);fireEvent.click(screen.getByRole('button',{name:'Redo last edit'}))
  await waitFor(()=>expect(p.saved).toHaveBeenLastCalledWith(redone));expect(api.mock.calls.at(-1)?.[1]).toEqual({version:5,action:'redo'})
  expect(p.close).not.toHaveBeenCalled()
})
