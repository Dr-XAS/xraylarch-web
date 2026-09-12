'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import controls from './athena-smoothing.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Display='mu'|'norm'|'derivative'|'second'
type Options={coordinate:'displayed';observed?:number;target?:number;display:Display;smoothing:number;smoothing_method:'three_point'|'savitzky_golay';sg_window?:number;sg_order?:number}
type NormalizationLimit={parameter:'pre1'|'norm2';requested:number;used:number}
export type CalibrationPreview={project_id:string;version:number;group_id:string;options:Options;requested_options:Options;
  curve:{x:number[];y:number[];unsmoothed:number[];marker:{x:number;y:number};range:number[];smoothing:Record<string,unknown>;normalization?:NormalizationLimit[]};
  calibrated_curve?:{x:number[];y:number[]}|null;
  normalization_limits?:{group_id:string;label:string;adjustments:NormalizationLimit[]}[];
  energy_shift:number;shift_delta:number;actual_reference:number;zero_crossing:number|null;
  atomic_target:{element:string;edge:string;energy:number}|null;
  changes:{group_id:string;label:string;e0:number|null;energy_shift:number}[];processing_errors:Record<string,string>}
export type CalibrationDraft={display:Display;smoothing:string;smoothing_method:Options['smoothing_method']}
const finite=(a:unknown):a is number[]=>Array.isArray(a)&&a.every(v=>typeof v==='number'&&Number.isFinite(v))
function validate(v:CalibrationPreview,p:AthenaProject,id:string,options:Options,zero=false){
  const g=p.groups.find(g=>g.id===id),c=v.curve
  if(!g||v.project_id!==p.id||v.version!==p.version||v.group_id!==id||Object.entries(options).some(([k,a])=>v.requested_options?.[k as keyof Options]!==a))throw new Error('The calibration preview no longer matches this project and these settings.')
  if(!c||!finite(c.x)||!finite(c.y)||!finite(c.unsmoothed)||c.x.length!==g.energy.length||c.y.length!==c.x.length||c.unsmoothed.length!==c.x.length||c.x.some((x,i)=>x!==g.energy[i]+g.parameters.energy_shift)
    ||!finite([c.marker?.x,c.marker?.y,v.energy_shift,v.shift_delta,v.actual_reference,v.options.observed,v.options.target])||!finite(c.range)||c.range.length!==2||c.range[0]>=c.range[1]
    ||c.marker.x!==v.options.observed||Math.abs(v.shift_delta-(v.energy_shift-g.parameters.energy_shift))>1e-10||Math.abs(v.actual_reference-(v.options.observed!+v.shift_delta))>1e-10||Math.abs(v.actual_reference-v.options.target!)>.000501
    ||!Array.isArray(v.changes)||v.changes.some(change=>!p.groups.some(g=>g.id===change.group_id)||!Number.isFinite(change.energy_shift)))throw new Error('The calibration preview has inconsistent coordinates or parameters.')
  if(zero&&(typeof v.zero_crossing!=='number'||!Number.isFinite(v.zero_crossing)||v.zero_crossing!==v.options.observed))throw new Error('No valid zero crossing was returned.')
  if(v.calibrated_curve&&(!finite(v.calibrated_curve.x)||!finite(v.calibrated_curve.y)||v.calibrated_curve.x.length!==c.x.length||v.calibrated_curve.y.length!==c.y.length
    ||v.calibrated_curve.x.some((x,i)=>Math.abs(x-c.x[i]-v.shift_delta)>1e-8)))throw new Error('The calibrated curve does not match the proposed energy shift.')
}

export function AthenaCalibration({project,activeId,selectGroup,initialDraft,rememberDraft,setBusy,disabled,saved,close}:{
  project:AthenaProject;activeId:string;selectGroup:(id:string)=>void;initialDraft?:CalibrationDraft;rememberDraft:(v:CalibrationDraft)=>void;
  setBusy:(v:string)=>void;disabled:boolean;saved:(p:AthenaProject)=>void;close:()=>void;
}){
  const group=project.groups.find(g=>g.id===activeId)
  const initialObserved=group?.parameters.e0??group?.result?.effective.e0
  const [observed,setObserved]=useState(typeof initialObserved==='number'?String(initialObserved):''),[target,setTarget]=useState('')
  const [draft,setDraft]=useState<CalibrationDraft>(initialDraft??{display:'derivative',smoothing:'0',smoothing_method:'three_point'})
  const [preview,setPreview]=useState<{key:string;value:CalibrationPreview}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0),[picking,setPicking]=useState(false)
  const [actionError,setActionError]=useState('')
  const generation=useRef(0),saving=useRef(false),alive=useRef(true),defaultsApplied=useRef(false),manual=useRef(false)
  useEffect(()=>{rememberDraft(draft)},[draft,rememberDraft])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
  useEffect(()=>{const g=project.groups.find(g=>g.id===activeId),e=g?.parameters.e0??g?.result?.effective.e0;setObserved(typeof e==='number'?String(e):'');setTarget('');defaultsApplied.current=false;manual.current=false},[activeId,project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const eligible=!!group&&group.data_type!=='chi'&&!group.frozen
  const valid=draft.smoothing.trim()!==''&&Number.isInteger(Number(draft.smoothing))&&Number(draft.smoothing)>=0&&Number(draft.smoothing)<=10
    &&(!observed.trim()? !manual.current:Number.isFinite(Number(observed))&&Number(observed)>0)&&(!target.trim()? !manual.current:Number.isFinite(Number(target))&&Number(target)>0)
  const options:Options={coordinate:'displayed',display:draft.display,smoothing:Number(draft.smoothing),smoothing_method:draft.smoothing_method,
    ...(observed.trim()?{observed:Number(observed)}:{}),...(target.trim()?{target:Number(target)}:{})}
  const key=JSON.stringify([project.id,project.version,activeId,options]),committed=useRef(key),pickContext=useRef({key,picking})
  const current=preview?.key===key&&valid?preview.value:null
  useLayoutEffect(()=>{committed.current=key;generation.current++;setPreview(null);setError('');setActionError('');setLoading(false);setPicking(false)},[key])
  useLayoutEffect(()=>{pickContext.current={key,picking}},[key,picking])
  useEffect(()=>{
    if(!eligible||!valid||disabled)return
    const abort=new AbortController(),token=++generation.current
    const timer=setTimeout(async()=>{
      setLoading(true);setError('')
      try{
        const value=await athenaApi<CalibrationPreview>(`/projects/${project.id}/calibration/preview`,{version:project.version,action:'calibrate',group_ids:[activeId],options},'POST',abort.signal)
        if(token!==generation.current||committed.current!==key)return
        validate(value,project,activeId,options)
        if(!defaultsApplied.current&&!manual.current){defaultsApplied.current=true;setObserved(String(value.options.observed));setTarget(String(value.options.target))}
        setPreview({key,value})
      }catch(e){if(!abort.signal.aborted&&token===generation.current)setError(e instanceof Error?e.message:'Calibration preview failed.')}
      finally{if(token===generation.current)setLoading(false)}
    },350)
    return()=>{clearTimeout(timer);abort.abort();generation.current++}
  // The complete request is represented in key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,retry,eligible,valid,disabled])
  function pick(event:{points?:{x?:unknown;curveNumber?:number}[]}){
    const x=event.points?.[0]?.x,context=pickContext.current
    if(disabled||!context.picking||context.key!==key||committed.current!==key||typeof x!=='number'||!Number.isFinite(x))return
    if(event.points?.[0]?.curveNumber!==undefined&&event.points[0].curveNumber!==(Number(draft.smoothing)?1:0))return
    manual.current=true;setObserved(String(x));setPicking(false)
  }
  async function findZero(){
    if(!current||disabled||saving.current||draft.display!=='second')return
    saving.current=true;setBusy('Finding second-derivative zero crossing');setError('');setActionError('')
    try{
      const value=await athenaApi<CalibrationPreview>(`/projects/${project.id}/calibration/zero`,{version:project.version,action:'calibrate',group_ids:[activeId],options:current.options})
      if(!alive.current)return
      if(committed.current!==key)throw new Error('The workspace changed. Preview the current group again.')
      validate(value,project,activeId,current.options,true);manual.current=true;setObserved(String(value.zero_crossing));setPreview(null)
    }catch(e){if(alive.current)setActionError(e instanceof Error?e.message:'No zero crossing found.')}
    finally{saving.current=false;setBusy('')}
  }
  async function apply(){
    if(!current||disabled||saving.current||committed.current!==key)return
    saving.current=true;setBusy('Calibrating energy');setError('');setActionError('')
    try{
      const next=await athenaApi<AthenaProject>(`/projects/${project.id}/command`,{version:current.version,action:'calibrate',group_ids:[activeId],options:current.options})
      if(!alive.current)return
      if(committed.current!==key||next.id!==project.id||next.version!==project.version+1||next.groups.length!==project.groups.length
        ||next.groups.some((g,i)=>g.id!==project.groups[i].id||g.energy.length!==project.groups[i].energy.length||g.mu.length!==project.groups[i].mu.length||g.energy.some((x,j)=>x!==project.groups[i].energy[j])||g.mu.some((y,j)=>y!==project.groups[i].mu[j]))
        ||current.changes.some(change=>{const g=next.groups.find(g=>g.id===change.group_id);return !g||g.parameters.energy_shift!==change.energy_shift||g.parameters.e0!==change.e0}))throw new Error('The saved calibration does not match the preview. Reload the workspace.')
      saved(next);close()
    }catch(e){if(alive.current){setPreview(null);setActionError(e instanceof Error?e.message:'Calibration failed.')}}
    finally{saving.current=false;setBusy('')}
  }
  const curve=current?.curve, traces:Array<Record<string,unknown>>=[]
  if(curve){
    if(Number(draft.smoothing))traces.push({x:curve.x,y:curve.unsmoothed,name:'Without display smoothing',type:'scatter',mode:'lines',line:{color:'#a5afa9',width:1}})
    traces.push({x:curve.x,y:curve.y,name:'Current energy axis',type:'scatter',mode:'lines+markers',marker:{size:4},line:{color:'#16736b',width:1.5}},
      {x:current?.calibrated_curve?.x??curve.x.map(x=>x+current!.shift_delta),y:current?.calibrated_curve?.y??curve.y,name:'Calibrated energy axis',type:'scatter',mode:'lines',line:{color:'#6680a1',dash:'dot',width:1.5}},
      {x:[curve.marker.x],y:[curve.marker.y],name:'Reference point',type:'scatter',mode:'markers',marker:{color:'#bb6542',size:11,symbol:'circle-open',line:{width:2}}})
  }
  const axis=draft.display==='mu'?'μ(E)':draft.display==='norm'?'Normalized μ(E)':draft.display==='derivative'?'dμ/dE':'d²μ/dE²'
  return <div className={`ath-modal-body ${controls.body}`} onKeyDown={e=>{if(e.key==='Escape'&&picking){e.stopPropagation();setPicking(false)}}}>
    <p>Select a measured reference point and assign its calibrated energy. Previewing and display smoothing leave the stored data unchanged.</p>
    <div className={styles.layout}><fieldset className={styles.controls} disabled={disabled}>
      <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e=>selectGroup(e.target.value)}>{project.groups.map(g=><option key={g.id} value={g.id}>{g.label}{g.frozen?' · frozen':''}</option>)}</select></label>
      <label className="ath-field"><span>Display</span><select aria-label="Calibration display" value={draft.display} onChange={e=>setDraft(d=>({...d,display:e.target.value as Display}))}><option value="mu">μ(E)</option><option value="norm">Normalized μ(E)</option><option value="derivative">First derivative</option><option value="second">Second derivative</option></select></label>
      <label className="ath-field"><span>Smoothing method</span><select aria-label="Calibration smoothing method" value={draft.smoothing_method} onChange={e=>setDraft(d=>({...d,smoothing_method:e.target.value as Options['smoothing_method']}))}><option value="three_point">Athena three-point</option><option value="savitzky_golay">Larch Savitzky–Golay</option></select></label>
      <label className="ath-field"><span>Smoothing · 0–10</span><input aria-label="Calibration smoothing" type="number" min="0" max="10" step="1" value={draft.smoothing} onChange={e=>setDraft(d=>({...d,smoothing:e.target.value}))}/></label>
      <p className="ath-hint">{draft.smoothing_method==='three_point'?'Number of three-point passes applied to the displayed curve.':'Zero disables smoothing; a positive value enables one Savitzky–Golay pass using the shared preferences, as in native Larch.'}{current?.options.sg_window!==undefined&&` Requested SG window ${current.options.sg_window}, order ${current.options.sg_order}.`}</p>
      <label className="ath-field"><span>Observed reference · eV</span><input aria-label="Observed reference · eV" type="number" step="any" value={observed} onChange={e=>{manual.current=true;setObserved(e.target.value)}}/></label>
      <label className="ath-field"><span>Calibrate to · eV</span><input aria-label="Calibrate to · eV" type="number" step="any" value={target} onChange={e=>{manual.current=true;setTarget(e.target.value)}}/></label>
      {current?.atomic_target&&<p className="ath-hint">Tabulated {current.atomic_target.element} {current.atomic_target.edge} edge: {current.atomic_target.energy} eV (XrayDB/Elam).</p>}
      <div className={styles.views}><button disabled={!current} aria-pressed={picking} onClick={()=>setPicking(v=>!v)}>{picking?'Cancel point selection':'Select a point'}</button><button disabled={!current||draft.display!=='second'||group?.data_type==='detector'||group?.is_difference} onClick={()=>void findZero()}>Find zero crossing</button></div>
      <p className="ath-hint">Zero crossing searches the unsmoothed second derivative around the reference, as in native Athena. Smoothing affects the display only.</p>
      <a href="https://bruceravel.github.io/demeter/documents/Athena/process/cal.html" target="_blank" rel="noreferrer">Document section: calibration</a>
    </fieldset><section className={styles.results} aria-label="Calibration preview">
      <div className={styles.plot} aria-label="Calibration plot">{curve?<Plot data={traces} onClick={pick} layout={{autosize:true,margin:{l:66,r:18,t:65,b:55},hovermode:'closest',font:{size:11},legend:{orientation:'h',x:0,y:1.04,yanchor:'bottom'},xaxis:{title:{text:'Energy (eV)'},range:curve.range},yaxis:{title:{text:axis},zeroline:true},uirevision:`${project.id}:${activeId}:${draft.display}:${curve.marker.x}`}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/>:<p>{loading?'Calculating the calibration preview…':'Choose valid reference values to preview the edge.'}</p>}</div>
      {picking&&<p role="status">Click a point on the current curve. Escape cancels point selection.</p>}
      <p role="status">{!eligible?'Choose an unfrozen energy group.':!valid?'Enter positive finite energies and an integer smoothing value from 0 to 10.':loading?'Calculating calibration…':current?`Preview ready at project revision ${current.version}.`:'Preparing the edge preview…'}</p>
      {current&&<><p>Total energy shift: <strong>{current.energy_shift.toFixed(3)} eV</strong> · change {current.shift_delta.toFixed(3)} eV.</p><p>The reference lands at {current.actual_reference.toFixed(5)} eV after Athena’s 0.001 eV shift rounding.</p>{current.changes.map(c=><p key={c.group_id}>{c.label}: E₀ {c.e0??'automatic'} eV; energy shift {c.energy_shift} eV.</p>)}{Object.entries(current.processing_errors).map(([id,e])=><p className="ath-warning" key={id}>{project.groups.find(g=>g.id===id)?.label}: processing needs attention after calibration: {e}</p>)}</>}
      {!!(curve?.normalization?.length||current?.normalization_limits?.length)&&<section aria-label="Normalization fit limits"><p>Normalization fits stop at measured endpoints. Requested limits remain saved for later processing.</p>
        {curve?.normalization?.map(a=><p key={a.parameter}>Current preview · {a.parameter==='pre1'?'Pre-edge start':'Post-edge end'}: requested {Number(a.requested.toPrecision(10))}, using {Number(a.used.toPrecision(10))} eV relative to E₀.</p>)}
        {current?.normalization_limits?.flatMap(g=>g.adjustments.map(a=><p key={`${g.group_id}:${a.parameter}`}>After calibration · {g.label} · {a.parameter==='pre1'?'Pre-edge start':'Post-edge end'}: requested {Number(a.requested.toPrecision(10))}, using {Number(a.used.toPrecision(10))} eV relative to E₀.</p>))}
      </section>}
      {(actionError||error)&&<div className="ath-error" role="alert">{actionError||error}</div>}
    </section></div>
    <div className={`ath-modal-actions ${controls.actions}`}><button disabled={disabled} onClick={close}>Cancel calibration</button><button disabled={disabled||!eligible||!valid||loading} onClick={()=>{setPreview(null);setActionError('');setRetry(n=>n+1)}}>Replot calibration</button><button className="ath-primary" disabled={disabled||!current||loading} onClick={()=>void apply()}>Calibrate</button></div>
  </div>
}
