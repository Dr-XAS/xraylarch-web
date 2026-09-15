import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaMEE, type MEEPreview } from './athena-mee'

type PlotProps = ComponentProps<typeof Plot>
const plot = vi.hoisted(() => vi.fn<(p: PlotProps) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: PlotProps) => { useLayoutEffect(() => { plot(props) }); return <div /> } }))
vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const project = { id:'p', version:4, groups:[{ id:'g', label:'LaCoO3', data_type:'mu', frozen:true, parameters:{kweight:2},
  result:{effective:{e0:5488}, arrays:{energy:[5400,5500,5650],norm:[0,1,1.1],k:[0,1,2],weighted_chi:[0,.1,-.1],r:[0,1,2],chir_mag:[0,1,.5]}} }] } as unknown as AthenaProject
const props = () => ({project,activeId:'g',selectGroup:vi.fn(),setBusy:vi.fn(),saved:vi.fn(),close:vi.fn(),disabled:false})
function preview(shift=122):MEEPreview {
  return {project_id:'p',version:4,options:{method:'reflection',shift,amplitude:.01,width:.5},results:[{
    group_id:'g',label:'LaCoO3 (MEE)', kweight:2,corrected_mu:[0,.99,1.09],details:{e0:5488,center:5488+shift,amplitude:.01,width:.5,warnings:[]},errors:{},
    traces:Object.fromEntries(['E','k','R'].map(space=>[space,[{role:'original',label:'LaCoO3',x:space==='E'?[5400,5500,5650]:[0,1,2],y:[0,1,1.1]},
      {role:'corrected',label:'LaCoO3 (MEE)',x:space==='E'?[5400,5500,5650]:[0,1,2],y:[0,.99,1.09]}]])) as MEEPreview['results'][0]['traces'],
  }]}
}
const saveButton = () => screen.getByRole('button',{name:'Make group from MEE-corrected data'})
const handoff = () => plot.mock.calls.at(-1)![0]
async function ready(){await waitFor(()=>expect(saveButton()).toBeEnabled(),{timeout:2000})}
function shift(value='122'){fireEvent.change(screen.getByLabelText('Energy shift (eV)'),{target:{value}})}
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('shows the original immediately, previews normalized corrections and switches E/k/R without recomputing',async()=>{
  api.mockResolvedValue(preview());const p=props();render(<AthenaMEE {...p}/>);
  expect(handoff().data[0].y).toEqual(project.groups[0].result!.arrays.norm)
  expect(api).not.toHaveBeenCalled();expect(saveButton()).toBeDisabled()
  shift();await ready()
  expect(api.mock.calls[0][1]).toEqual({version:4,action:'multi_electron',group_ids:['g'],options:{method:'reflection',shift:122,amplitude:.01,width:.5}})
  expect(handoff().data).toHaveLength(2)
  fireEvent.click(screen.getByRole('button',{name:'Plot in k'}))
  expect(handoff().layout?.yaxis).toEqual(expect.objectContaining({title:{text:'k^2 χ(k)'},automargin:true}))
  fireEvent.click(screen.getByRole('button',{name:'Plot in R'}))
  expect(screen.getByRole('button',{name:'Pick energy shift'})).toBeDisabled();expect(api).toHaveBeenCalledTimes(1)
  api.mockResolvedValueOnce({...project,version:5});fireEvent.click(saveButton())
  await waitFor(()=>expect(p.saved).toHaveBeenCalledWith({...project,version:5}))
  expect(api.mock.calls.at(-1)?.[1]).toEqual({version:4,action:'multi_electron',group_ids:['g'],options:preview().options})
})

it('invalidates late responses after parameter edits and rejects mismatched data before saving',async()=>{
  let first!:(value:MEEPreview)=>void
  api.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve})).mockResolvedValueOnce(preview(123))
  render(<AthenaMEE {...props()}/>);shift();await waitFor(()=>expect(api).toHaveBeenCalledTimes(1))
  shift('123');expect(saveButton()).toBeDisabled();await ready()
  await act(async()=>first(preview()))
  expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(123)
  api.mockResolvedValueOnce({...preview(124),version:3});shift('124')
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');expect(saveButton()).toBeDisabled()
})

it('invalidates the preview on project revision changes and preserves controls on errors',async()=>{
  api.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('Changed in another tab'))
  const p=props(),view=render(<AthenaMEE {...p}/>);shift();await ready()
  view.rerender(<AthenaMEE {...p} project={{...project,version:5}}/>);expect(saveButton()).toBeDisabled()
  expect(await screen.findByRole('alert')).toHaveTextContent('Changed in another tab')
  expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(122)
})

it('converts picked E and k coordinates to native relative energy and ignores stale pick callbacks',async()=>{
  render(<AthenaMEE {...props()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Pick energy shift'}));const old=handoff().onClick!
  act(()=>old({points:[{x:5610}]}));expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(122)
  fireEvent.click(screen.getByRole('button',{name:'Plot in k'}));fireEvent.click(screen.getByRole('button',{name:'Pick energy shift'}))
  act(()=>old({points:[{x:5630}]}));expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(122)
  act(()=>handoff().onClick!({points:[{x:5}]}));expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(Number((25/.2624682917).toFixed(3)))
})

it('keeps failed-save choices, clears approval of the old preview and releases busy state',async()=>{
  api.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('Changed in another tab'))
  const p=props();render(<AthenaMEE {...p}/>);shift();await ready();fireEvent.click(saveButton())
  expect(await screen.findByRole('alert')).toHaveTextContent('Changed in another tab')
  expect(p.saved).not.toHaveBeenCalled();expect(saveButton()).toBeDisabled()
  expect(p.setBusy).toHaveBeenLastCalledWith('');expect(screen.getByLabelText('Energy shift (eV)')).toHaveValue(122)
})

it('rejects incomplete curves and permits negative amplitude/width for native clamping',async()=>{
  const result=preview();result.results[0].traces.E[1].y=[NaN]
  api.mockResolvedValue(result);render(<AthenaMEE {...props()}/>);shift()
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid numerical data')
  fireEvent.change(screen.getByLabelText('Scale by (edge-step fraction)'),{target:{value:'-1'}})
  fireEvent.change(screen.getByLabelText('Broadening (eV)'),{target:{value:'0'}})
  await waitFor(()=>expect(api).toHaveBeenCalledTimes(2))
  expect(api.mock.calls[1][1]).toEqual(expect.objectContaining({options:expect.objectContaining({amplitude:-1,width:0})}))
})
