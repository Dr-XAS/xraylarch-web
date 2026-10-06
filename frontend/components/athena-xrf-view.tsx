"use client"

import { ThemedPlot as Plot } from "./themed-plot"
import { useEffect, useRef, useState } from 'react'
import type { AthenaProject } from '@/lib/athena'
import { useAthenaApi } from '@/lib/athena-context'
import { AthenaDownloadButton } from './athena-download-button'
import styles from './athena-xrf-view.module.css'

type Detector={name:string;elements:number;channels:number}
type Axis={name:string;min:number;max:number}
type Raster={fast:string;slow:string;columns:number;rows:number;serpentine:boolean}
type Inspection={kind:string;upload_id:string;display_name:string;filename:string;points:number;
  detectors:Detector[];axes:Axis[];raster:Raster|null}
// x and y are the stage positions of the columns and the rows, so the image
// is placed where it was measured rather than on a pixel grid.
type MapImage={rows:number;columns:number;fast:string;slow:string;x:number[];y:number[];values:number[][]}
// Everything here is counts as recorded: no deadtime factor, no division by
// the incident flux, no fit. element_counts is the window of interest at the
// chosen point, element by element.
type Frame={version:number;cube_id:string;display_name:string;points:number;point:number;averaged:number[];
  elements:number[];channel_lo:number;rebin:number;energy_kev:number[];spectra:number[][];total:number[];
  element_counts:number[];axis_name:string|null;trace_stride:number;axis:number[];roi:number[];
  roi_range:number[];map:MapImage|null}
type Trace={x:number[];y:number[];name:string;dash?:'dot'|'dash'}

const INTEGERS=['point','average','channel_lo','channel_hi','rebin','roi_lo','roi_hi'] as const
const REQUIRED=[...INTEGERS,'cal_offset','cal_slope'] as const
const palette=['#16736b','#b76d37','#6a4fa3','#2c7fb8','#c0392b','#7f8c2a','#a0338e','#4d6b8a']
const blank={point:'0',average:'1',channel_lo:'0',channel_hi:'0',rebin:'1',roi_lo:'0',roi_hi:'0',
  cal_offset:'0',cal_slope:'0.01'}
const labels:Record<string,string>={point:'Scan point',average:'Average over points',
  channel_lo:'First channel read',channel_hi:'Last channel read',rebin:'Channels per bin',
  roi_lo:'Window of interest, first channel',roi_hi:'Window of interest, last channel',
  cal_offset:'Energy offset (keV)',cal_slope:'Energy per channel (keV)'}

function Figure({label,traces,xlabel,ylabel,revision,log,empty}: {
  label:string;traces:Trace[];xlabel:string;ylabel:string;revision:string;log?:boolean;empty:string
}) {
  return <div className={styles.plot} aria-label={label}>{traces.length ? <Plot
    data={traces.map((t,i)=>({x:t.x,y:t.y,name:t.name,type:'scatter',mode:'lines',
      line:{color:palette[i%palette.length],width:1.6,dash:t.dash??'solid'}}))}
    layout={{autosize:true,margin:{l:62,r:15,t:48,b:45},xaxis:{title:{text:xlabel}},
      yaxis:{title:{text:ylabel},type:log?'log':'linear'},
      legend:{orientation:'h',y:1.05,yanchor:'bottom'},uirevision:revision}}
    config={{responsive:true,displaylogo:false,toImageButtonOptions:{format:'svg',filename:'athena-xrf-view'}}}
    style={{width:'100%',height:'100%'}} useResizeHandler /> : <p>{empty}</p>}</div>
}

function MapFigure({image,revision,log}:{image:MapImage;revision:string;log:boolean}) {
  // Plotly has no logarithmic colour axis. Taking the logarithm here leaves
  // empty pixels as gaps rather than as the floor of the scale, so a pixel
  // with no counts cannot be read as a low but measured one.
  const z=log?image.values.map(row=>row.map(v=>v>0?Math.log10(v):null)):image.values
  return <div className={styles.map} aria-label="Map display"><Plot
    data={[{type:'heatmap',x:image.x,y:image.y,z,zsmooth:false,hoverongaps:false,
      colorscale:'Viridis',colorbar:{title:{text:log?'log₁₀ counts':'Counts'}}}]}
    layout={{autosize:true,margin:{l:62,r:15,t:20,b:45},xaxis:{title:{text:image.fast}},
      // The two stage axes are the same quantity in the same units, so the
      // image is drawn with square pixels and a feature keeps its shape.
      yaxis:{title:{text:image.slow},scaleanchor:'x'},uirevision:revision}}
    config={{responsive:true,displaylogo:false,toImageButtonOptions:{format:'svg',filename:'athena-xrf-map'}}}
    style={{width:'100%',height:'100%'}} useResizeHandler /></div>
}

export function AthenaXrfView({project,setBusy}: {
  project:AthenaProject;setBusy:(label:string)=>void
}) {
  const athenaApi=useAthenaApi()
  const [inspection,setInspection]=useState<Inspection|null>(null)
  const [form,setForm]=useState(blank)
  const [detector,setDetector]=useState('')
  const [chosen,setChosen]=useState<number[]>([])
  const [axis,setAxis]=useState('')
  // Presentation only: neither asks the server for a new frame.
  const [logCounts,setLogCounts]=useState(true)
  const [logMap,setLogMap]=useState(false)
  const [view,setView]=useState<{key:string;value?:Frame;error?:string}|null>(null)
  const [pending,setPending]=useState(false),lock=useRef(false)
  const [error,setError]=useState('')

  const value=(name:keyof typeof blank)=>Number(form[name])
  const chosenDetector=inspection?.detectors.find(d=>d.name===detector)
  const elements=chosenDetector?Array.from({length:chosenDetector.elements},(_,i)=>i):[]
  const selected=chosen.filter(index=>index<elements.length).sort((a,b)=>a-b)
  const numbers=REQUIRED.every(f=>form[f].trim()!==''&&Number.isFinite(value(f)))
    &&INTEGERS.every(f=>Number.isInteger(value(f)))
  const windows=value('channel_lo')>=0&&value('channel_hi')>value('channel_lo')
    &&value('roi_lo')>=value('channel_lo')&&value('roi_hi')>value('roi_lo')
    &&value('roi_hi')<=value('channel_hi')
  const sizes=value('rebin')>=1&&value('rebin')<=64&&value('average')>=1&&value('average')<=1024
    &&value('point')>=0&&value('point')<(inspection?.points??0)&&value('cal_slope')>0
  const valid=!!inspection&&!!chosenDetector&&selected.length>0&&numbers&&windows&&sizes
  const problem=!inspection?''
    : !chosenDetector?'Choose the detector to look at.'
    : selected.length===0?'Choose at least one detector element. With none selected there is nothing to add up.'
    : !numbers?'Every setting must be a finite number, and the channel, point and bin fields whole numbers.'
    : !windows?'The window of interest must increase and lie inside the channels read.'
    : !sizes?'The scan point must lie inside the file, and the energy per channel must be positive.'
    : ''

  // Sending every element explicitly and sending none mean the same thing to
  // the server; the empty list keeps the request, and so the request key,
  // the same whether or not the reader has touched the checkboxes.
  const body={version:project.version,cube_id:inspection?.upload_id??'',detector,
    point:value('point'),average:value('average'),
    elements:selected.length===elements.length?[]:selected,
    channel_range:[value('channel_lo'),value('channel_hi')],rebin:value('rebin'),
    roi_range:[value('roi_lo'),value('roi_hi')],
    cal_offset:value('cal_offset'),cal_slope:value('cal_slope'),axis:axis===''?null:axis}
  // As in the fitting panel, the project version is left out of the key: a
  // group added in another panel must not blank the image on screen.
  const key=JSON.stringify([project.id,{...body,version:0}])
  const current=view?.key===key&&valid?view.value:undefined
  const shown=view?.value
  const failure=view?.key===key?view.error:''

  // The request is read from a ref at the moment it is sent. The transport
  // hook returns a new function on every render, so neither it nor the body
  // can sit in the dependency list without re-firing the effect endlessly.
  const latest=useRef({api:athenaApi,body,id:project.id})
  latest.current={api:athenaApi,body,id:project.id}
  useEffect(()=>{
    if(!valid)return
    let cancelled=false
    // A frame is asked for as the controls move, so dragging the point slider
    // supersedes the frame in flight instead of queueing a read of the file
    // for every pixel the slider passed through.
    const timer=setTimeout(()=>{
      const {api,body:request,id}=latest.current
      setPending(true)
      api<Frame>(`/projects/${id}/xrf-view/frame`,request)
        .then(value=>{if(!cancelled)setView({key,value})})
        .catch(e=>{if(!cancelled)setView({key,error:e instanceof Error?e.message:'The frame could not be read.'})})
        .finally(()=>{if(!cancelled)setPending(false)})
    },180)
    return ()=>{cancelled=true;clearTimeout(timer)}
  },[key,valid])

  function edit(name:keyof typeof blank,next:string){setForm(f=>{
    // Until it is set by hand, the window of interest is the channels read,
    // and it follows them: narrowing the read range must not leave the
    // default window hanging past it, which invalidates the form and
    // freezes both plots until the window is edited too.
    const following=f.roi_lo===f.channel_lo&&f.roi_hi===f.channel_hi
    if(following&&name==='channel_lo')return {...f,channel_lo:next,roi_lo:next}
    if(following&&name==='channel_hi')return {...f,channel_hi:next,roi_hi:next}
    return {...f,[name]:next}
  })}
  function field(name:keyof typeof blank,step:'any'|1,extra?:{min?:number;max?:number}) {
    return <label className="ath-field" key={name}><span>{labels[name]}</span>
      <input type="number" step={step} {...extra} value={form[name]}
        onChange={e=>edit(name,e.target.value)} /></label>
  }
  function pickDetector(found:Inspection,name:string) {
    const picked=found.detectors.find(d=>d.name===name)
    setDetector(name)
    setChosen(Array.from({length:picked?.elements??0},(_,i)=>i))
    setForm(f=>({...f,channel_lo:'0',channel_hi:String(picked?.channels??0),
      roi_lo:'0',roi_hi:String(picked?.channels??0)}))
    setView(null)
  }
  async function inspect(file:File) {
    if(lock.current)return
    lock.current=true;setPending(true);setBusy('Reading the detector file');setError('')
    setInspection(null);setView(null)
    try{
      const data=new FormData();data.append('file',file)
      const found=await athenaApi<Inspection>(`/projects/${project.id}/xrf-view/inspect`,data)
      setInspection(found)
      setAxis('')
      setForm(f=>({...f,point:'0',average:'1',rebin:'1'}))
      pickDetector(found,found.detectors[0]?.name??'')
    }catch(e){setError(e instanceof Error?e.message:'The file could not be read.')}
    finally{lock.current=false;setPending(false);setBusy('')}
  }

  const spectrum:Trace[]=current?[
    ...(current.elements.length>1
      ? [{x:current.energy_kev,y:current.total,name:'All chosen elements'}]
      : []),
    ...current.spectra.map((y,i)=>({x:current.energy_kev,y,name:`Element ${current.elements[i]+1}`,
      dash:'dot' as const})),
  ]:[]
  const trace:Trace[]=current?[{x:current.axis,y:current.roi,
    name:`Channels ${current.roi_range[0]}–${current.roi_range[1]}`}]:[]
  const revision=`xrf-view:${inspection?.upload_id??''}:${detector}`
  const kev=(channel:number)=>(value('cal_offset')+value('cal_slope')*channel).toFixed(3)
  // What an empty plot says. Once a file is chosen, "choose a file" is false:
  // the frame is either on its way, or was refused and the message says why.
  const waiting=!!inspection&&valid&&!current&&!failure
  const empty=(what:string)=>!inspection?`Choose a detector file to see ${what}.`
    : waiting?'Reading the spectrum…'
    : 'Nothing to draw for these settings; see the message below.'

  return <div className="ath-modal-body"><div className={styles.layout}>
    <fieldset disabled={pending&&!inspection} className={styles.controls}>
      <label className="ath-field"><span>Detector file</span><input type="file" aria-label="Choose detector file" onChange={e=>{const f=e.target.files?.[0];if(f)void inspect(f)}} /></label>
      <p className="ath-hint">An HDF5 file holding a multi-channel detector array — a NeXus-style scan or map with the array in its data group, or an APS 20-BM detector file with one MCA array per element. Nothing is fitted here and nothing is divided by the incident flux — these are the counts as the detector recorded them.</p>
      {inspection&&<>
        <h3>{inspection.display_name} · {inspection.points} point{inspection.points===1?'':'s'}{inspection.raster?` · ${inspection.raster.rows} × ${inspection.raster.columns} map`:''}</h3>
        <div className="ath-fields">
          <label className="ath-field"><span>Detector</span><select value={detector} onChange={e=>pickDetector(inspection,e.target.value)}>{inspection.detectors.map(d=><option key={d.name} value={d.name}>{d.name} · {d.elements} elements · {d.channels} channels</option>)}</select></label>
          <label className="ath-field"><span>Trace abscissa</span><select value={axis} onChange={e=>setAxis(e.target.value)}>
            <option value="">Point number</option>
            {inspection.axes.map(a=><option key={a.name} value={a.name}>{a.name} · {a.min.toPrecision(4)} to {a.max.toPrecision(4)}</option>)}</select></label>
        </div>
        {elements.length>1&&<div className={styles.elements} aria-label="Detector elements">
          {elements.map(index=><label className="ath-check" key={index}>
            <input type="checkbox" checked={selected.includes(index)}
              onChange={e=>setChosen(c=>e.target.checked?[...c,index]:c.filter(v=>v!==index))} />
            Element {index+1}</label>)}
          <button type="button" onClick={()=>setChosen(elements)}>All elements</button>
        </div>}
        <div className="ath-fields">
          {field('point',1,{min:0,max:Math.max(0,inspection.points-1)})}
          {field('average',1,{min:1,max:1024})}
        </div>
        <label className={styles.slider}><span>Move through the scan</span>
          <input type="range" min={0} max={Math.max(0,inspection.points-1)} step={1}
            value={form.point} onChange={e=>edit('point',e.target.value)} /></label>
        <div className="ath-fields">{field('channel_lo',1)}{field('channel_hi',1)}{field('rebin',1,{min:1,max:64})}</div>
        <p className="ath-hint">Reading fewer channels makes the file quicker to open; binning sums neighbouring channels, so a bin holds the counts of all of them and a weak line stays visible.</p>
        <div className="ath-fields">{field('roi_lo',1)}{field('roi_hi',1)}</div>
        <p className="ath-hint">The window of interest is summed at every point to make the trace, and the image when the file holds a raster. At the calibration below it covers {kev(value('roi_lo'))}–{kev(value('roi_hi'))} keV.</p>
        <details><summary>Energy calibration</summary><div className="ath-fields">{field('cal_offset','any')}{field('cal_slope','any')}</div>
          <p className="ath-hint">Channel to energy, as a straight line. This is a label for the abscissa only: it is not fitted here, and changing it moves no counts. The fitting panel solves for it against the measured lines.</p></details>
        <details><summary>Detector file</summary><AthenaDownloadButton path={`/projects/${project.id}/uploads/${inspection.upload_id}/file`}>Download original detector file</AthenaDownloadButton></details>
      </>}
    </fieldset>
    <section className={styles.previews}>
      <h3>Detector spectrum{shown?` at point ${shown.point}`:''}{shown&&shown.averaged[1]-shown.averaged[0]>1?`, averaged over points ${shown.averaged[0]}–${shown.averaged[1]-1}`:''}</h3>
      <div className={styles.display} aria-label="Spectrum display">
        <label className="ath-check"><input type="checkbox" checked={logCounts} onChange={e=>setLogCounts(e.target.checked)} />Logarithmic counts</label>
      </div>
      <Figure label="XRF spectrum" traces={spectrum} xlabel="Detected energy (keV)" ylabel="Counts"
        revision={`${revision}:spectrum`} log={logCounts}
        empty={empty('its spectra')} />
      {current&&<p className="ath-hint">Counts in the window of interest at this point, element by element: {current.element_counts.map((counts,i)=>`element ${current.elements[i]+1} ${counts.toPrecision(4)}`).join(' · ')}. An element reading zero against its neighbours is dead or shadowed, and is worth leaving out above.</p>}
      <h3>Window of interest across the scan</h3>
      <Figure label="Window trace" traces={trace} xlabel={current?.axis_name??'Point number'} ylabel="Counts in the window"
        revision={`${revision}:trace`} empty={empty('the window across the scan')} />
      {current&&current.trace_stride>1&&<p className="ath-hint">Every {current.trace_stride}th point is drawn. The image below keeps every pixel.</p>}
      {current?.map
        ? <><h3>Map of the window of interest</h3>
          <div className={styles.display} aria-label="Map display options">
            <label className="ath-check"><input type="checkbox" checked={logMap} onChange={e=>setLogMap(e.target.checked)} />Logarithmic colour scale</label>
          </div>
          <MapFigure image={current.map} revision={`${revision}:map`} log={logMap} /></>
        : inspection&&<p className="ath-hint">This file holds a one-dimensional scan: its positions do not form a raster, so there is no image to draw. A map written one row to a file is one row here.</p>}
      {pending&&<p role="status">Reading the detector file…</p>}
      {(failure||problem)&&<p role="alert" className="ath-error">{failure||problem}</p>}
    </section>
  </div>{error&&<p role="alert" className="ath-error">{error}</p>}</div>
}
