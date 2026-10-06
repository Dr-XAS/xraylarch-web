import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaSelfAbsorption, type SelfAbsorptionPreview } from './athena-self-absorption'

type PlotProps = ComponentProps<typeof Plot>
const plot = vi.hoisted(() => vi.fn<(p: PlotProps) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: PlotProps) => { useLayoutEffect(() => { plot(props) }); return <div /> } }))
vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
const energy = [7100, 7120, 7140]
const project = { id:'p', version:4, groups:[{ id:'g', label:'sample', data_type:'mu', frozen:false, parameters:{kweight:2},
  result:{effective:{e0:7112}, arrays:{energy, norm:[0,1,1.1]}} }] } as unknown as AthenaProject
const props = () => ({project,activeId:'g',selectGroup:vi.fn(),setBusy:vi.fn(),saved:vi.fn(),close:vi.fn(),disabled:false})

function preview(overrides:Partial<SelfAbsorptionPreview['results'][0]>={}, options:Partial<SelfAbsorptionPreview['options']>={}):SelfAbsorptionPreview {
  return {project_id:'p',version:4,
    options:{algorithm:'fluo',formula:'Fe2O3',element:'Fe',edge:'K',angle_in:45,angle_out:45,...options},
    results:[{group_id:'g',label:'sample',energy,measured:[0,1,1.1],corrected:[0,1.2,1.35],
      information_depth_um:null,sampled_fraction:null,attenuation_length_um:null,
      reference_sampled_fraction:null,thickness_over_attenuation_length:null,
      details:{algorithm:'fluo',alpha:1.4,fluorescence_energy:6403,edge_energy:7112},...overrides}]}
}
const saveButton = () => screen.getByRole('button',{name:'Make group from corrected data'})
const handoff = () => plot.mock.calls.at(-1)![0]
async function ready(){await waitFor(()=>expect(saveButton()).toBeEnabled(),{timeout:2000})}
function compose(){for (const [label,value] of [['Sample formula','Fe2O3'],['Absorbing element','Fe']] as const)
  fireEvent.change(screen.getByLabelText(label),{target:{value}})}
function field(label:string|RegExp,value:string){fireEvent.change(screen.getByLabelText(label),{target:{value}})}
const THICKNESS=/^Thickness \(µm\)/, DENSITY=/^Density \(g\/cm³\)/
afterEach(()=>{cleanup();vi.clearAllMocks();api.mockReset()})

it('plots the measurement first, previews once the composition is known and saves what it previewed',async()=>{
  api.mockResolvedValue(preview());const p=props();render(<AthenaSelfAbsorption {...p}/>)
  expect(handoff().data[0].y).toEqual([0,1,1.1]);expect(api).not.toHaveBeenCalled()
  expect(saveButton()).toBeDisabled()
  compose();await ready()
  expect(api.mock.calls[0][1]).toEqual({version:4,action:'self_absorption',group_ids:['g'],
    options:{algorithm:'fluo',formula:'Fe2O3',element:'Fe',edge:'K',angle_in:45,angle_out:45}})
  expect(handoff().data.map(t=>t.name)).toEqual(['Measured','Corrected · thick sample (FLUO)'])
  api.mockResolvedValueOnce({...project,version:5});fireEvent.click(saveButton())
  await waitFor(()=>expect(p.saved).toHaveBeenCalledWith({...project,version:5}))
  expect(api.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({version:4,options:preview().options}))
})

it('will not ask for a slab correction until it has both the thickness and the density',async()=>{
  api.mockResolvedValue(preview({},{algorithm:'booth',thickness:3,density:5.2}))
  render(<AthenaSelfAbsorption {...props()}/>);compose()
  field('Correction','booth');field(THICKNESS,'3')
  expect(screen.getByRole('status')).toHaveTextContent('needs both the thickness and the density')
  await new Promise(r=>setTimeout(r,500));expect(api).not.toHaveBeenCalled()
  field(DENSITY,'5.2');await waitFor(()=>expect(api).toHaveBeenCalledTimes(1))
  expect(api.mock.calls[0][1]).toEqual(expect.objectContaining({options:expect.objectContaining({algorithm:'booth',thickness:3,density:5.2})}))
})

it('offers the depth plot only when a depth curve came back, and reads the geometry out for the operator',async()=>{
  api.mockResolvedValueOnce(preview())
  render(<AthenaSelfAbsorption {...props()}/>);compose();await ready()
  expect(screen.getByRole('button',{name:'Probing depth'})).toBeDisabled()
  expect(screen.getByText(/Enter the sample density/)).toBeInTheDocument()
  api.mockResolvedValueOnce(preview({information_depth_um:[40,12,11],sampled_fraction:[.2,.5,.52],
    attenuation_length_um:14,thickness_over_attenuation_length:3/14,reference_sampled_fraction:.193},
    {density:5.2,thickness:3}))
  field(DENSITY,'5.2');field(THICKNESS,'3');await ready()
  expect(screen.getByText(/runs from 40\.00 µm in the pre-edge to 11\.00 µm/)).toBeInTheDocument()
  expect(screen.getByText(/At the edge step it is 14\.00 µm/)).toBeInTheDocument()
  expect(screen.getByText(/thinner than one probing depth/)).toBeInTheDocument()
  expect(screen.getByText(/emits 19% of what an infinitely thick one would/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Probing depth'}))
  expect(handoff().data).toHaveLength(1);expect(handoff().data[0].y).toEqual([40,12,11])
  expect(handoff().layout?.yaxis).toMatchObject({title:{text:'Probing depth 1/(μ_in/sin θ_in + μ_f/sin θ_out) (µm)'},rangemode:'tozero'})
})

it('describes a finite slab by its own share of the signal and draws its thickness on the depth plot',async()=>{
  // "63% of the detected signal comes from above the attenuation length" holds
  // for a semi-infinite sample. A 3 µm slab with a 14 µm probing depth has no
  // signal from below 3 µm at all; 63% of ITS signal comes from the top
  // -L ln(1 - 0.63 (1 - e^(-d/L))) = 1.81 µm. The plot started near 5 µm and
  // never showed the thickness, so the one comparison that matters was unseen.
  api.mockResolvedValue(preview({information_depth_um:[40,12,11],sampled_fraction:[.2,.5,.52],
    attenuation_length_um:14,thickness_over_attenuation_length:3/14,reference_sampled_fraction:.193,
    normalization:{e0:7112.4,pre1:-150,pre2:-30,norm1:100,norm2:600,nnorm:2}},
    {algorithm:'booth',density:5.2,thickness:3}))
  render(<AthenaSelfAbsorption {...props()}/>);compose();field('Correction','booth')
  field(DENSITY,'5.2');field(THICKNESS,'3');await ready()
  expect(screen.getByText(/63% of this slab's own signal comes from its top 1\.81 µm/)).toBeInTheDocument()
  expect(screen.queryByText(/63% of the detected signal comes from shallower/)).not.toBeInTheDocument()
  expect(screen.getByText(/Normalization from the group: E₀ 7112\.4 eV, pre-edge -150 to -30 eV, post-edge 100 to 600 eV, polynomial degree 2/)).toBeInTheDocument()
  expect(handoff().data.map(t=>t.name)).toEqual(['Measured','Corrected · Booth slab 3 µm'])
  fireEvent.click(screen.getByRole('button',{name:'Probing depth'}))
  expect(handoff().layout?.shapes).toEqual([expect.objectContaining({type:'line',y0:3,y1:3})])
})

it('refuses an angle the server would refuse before asking it',async()=>{
  // The panel accepted 0-180 degrees and the server 0.1-90 from the surface, so
  // 100 degrees came back as a server error instead of guidance.
  api.mockResolvedValue(preview())
  render(<AthenaSelfAbsorption {...props()}/>);compose();field('Incident angle (degrees)','100')
  expect(screen.getByRole('status')).toHaveTextContent('between 0.1 and 90 degrees from the sample surface')
  await new Promise(r=>setTimeout(r,500));expect(api).not.toHaveBeenCalled()
})

it('judges the thick limit by the yield at the edge step, not by the shortest length in the scan',async()=>{
  // Ten times the shortest length in the scan, which is what the panel used to
  // call effectively infinite. At the edge step, which is the yield the
  // normalized measurement is divided by, the slab is still a sixth short of
  // an infinite one, and the two corrections disagree by hundreds of per cent.
  api.mockResolvedValue(preview({information_depth_um:[40,5.5,.96],sampled_fraction:[1,.84,1],
    attenuation_length_um:5.52,thickness_over_attenuation_length:10/5.52,reference_sampled_fraction:.8365},
    {density:5.2,thickness:10}))
  render(<AthenaSelfAbsorption {...props()}/>);compose();field(DENSITY,'5.2');field(THICKNESS,'10')
  await ready()
  expect(screen.getByText(/emits 84% of what an infinitely thick one would/)).toBeInTheDocument()
  expect(screen.getByText(/thicker than one probing depth but not saturated/)).toBeInTheDocument()
  cleanup();api.mockReset()
  api.mockResolvedValue(preview({information_depth_um:[40,5.5,.96],sampled_fraction:[1,1,1],
    attenuation_length_um:5.52,thickness_over_attenuation_length:200/5.52,reference_sampled_fraction:1},
    {density:5.2,thickness:200}))
  render(<AthenaSelfAbsorption {...props()}/>);compose();field(DENSITY,'5.2');field(THICKNESS,'200')
  await ready();expect(screen.getByText(/effectively thick at the edge step/)).toBeInTheDocument()
})

it('refuses a preview that does not answer the current settings, and invalidates late replies',async()=>{
  let first!:(value:SelfAbsorptionPreview)=>void
  api.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve})).mockResolvedValueOnce(preview({},{angle_in:30}))
  render(<AthenaSelfAbsorption {...props()}/>);compose();await waitFor(()=>expect(api).toHaveBeenCalledTimes(1))
  field('Incident angle (degrees)','30');expect(saveButton()).toBeDisabled();await ready()
  await act(async()=>first(preview()))
  // The late reply answers 45 degrees. Letting it land would plot one geometry
  // under the controls of another, so it must leave the current preview standing.
  expect(screen.getByLabelText('Incident angle (degrees)')).toHaveValue(30)
  expect(saveButton()).toBeEnabled();expect(screen.queryByRole('alert')).toBeNull()
  // A depth curve the options did not ask for means the server answered something else.
  api.mockResolvedValueOnce(preview({information_depth_um:[1,2,3]},{angle_in:25}));field('Incident angle (degrees)','25')
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');expect(saveButton()).toBeDisabled()
})

it('rejects a corrected curve that does not line up with the energy axis and keeps the controls',async()=>{
  api.mockResolvedValue(preview({corrected:[1,2]}))
  const p=props();render(<AthenaSelfAbsorption {...p}/>);compose()
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid numerical data')
  expect(saveButton()).toBeDisabled();expect(screen.getByLabelText('Sample formula')).toHaveValue('Fe2O3')
  expect(p.setBusy).not.toHaveBeenCalled()
})

it('keeps the operator’s entries when the save is rejected and releases the busy state',async()=>{
  api.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('Changed in another tab'))
  const p=props();render(<AthenaSelfAbsorption {...p}/>);compose();await ready();fireEvent.click(saveButton())
  expect(await screen.findByRole('alert')).toHaveTextContent('Changed in another tab')
  expect(p.saved).not.toHaveBeenCalled();expect(saveButton()).toBeDisabled()
  expect(p.setBusy).toHaveBeenLastCalledWith('');expect(screen.getByLabelText('Sample formula')).toHaveValue('Fe2O3')
})
