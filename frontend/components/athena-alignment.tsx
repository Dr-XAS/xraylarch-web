'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import controls from './athena-smoothing.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Display='mu'|'norm'|'derivative'|'smoothed'
export type AlignmentDraft={standard_id:string;display:Display;fit:'derivative'|'smoothed';use_reference:boolean}
type Options=AlignmentDraft&{method:'demeter-larch';operation:'inspect'|'manual'|'auto';energy_shift?:number;sg_window?:number;sg_order?:number}
type Curve={group_id:string;label:string;x:number[];y:number[];e0:number}
type FitSummary={energy_shift:number;fitted_shift:number;shift_stderr:number|null;native_shift_stderr?:number|null;derivative_scale:number;xmin:number;xmax:number;fit_points:number;smoothing_window:number|null;smoothing_order:number|null}
type Row={group_id:string;label:string;moving_id:string;standard_id:string;used_references:boolean;energy_shift:number;shift_delta:number;
  before:Curve;after:Curve;standard:Curve;fit:{summary:FitSummary;curve:{x:number[];standard:number[];fitted:number[];residual:number[]}}|null;saved_fit:Partial<FitSummary>|null}
export type AlignmentPreview={project_id:string;version:number;group_ids:string[];options:Options;requested_options:Options;rows:Row[];
  changes:{group_id:string;label:string;energy_shift:number;e0:number|null}[];processing_errors:Record<string,string>;skipped_reasons:Record<string,string>}
const finite=(a:unknown):a is number[]=>Array.isArray(a)&&a.every(x=>typeof x==='number'&&Number.isFinite(x))
function validate(v:AlignmentPreview,p:AthenaProject,ids:string[],options:Options){
  const invalid=()=>{throw new Error('The alignment preview does not match this project and these settings. Replot alignment.')}
  if(v.project_id!==p.id||v.version!==p.version||JSON.stringify(v.group_ids)!==JSON.stringify(ids)||!Array.isArray(v.rows)||!v.rows.length
    ||Object.entries(options).some(([k,x])=>v.requested_options?.[k as keyof Options]!==x||v.options?.[k as keyof Options]!==x))invalid()
  const seen=new Set<string>()
  const expected=new Map<string,number>()
  function family(id:string){
    const members=new Set([id]);let size=0
    while(size!==members.size){size=members.size;for(const g of p.groups)if(g.reference_id&&(members.has(g.id)||members.has(g.reference_id))){members.add(g.id);members.add(g.reference_id)}}
    return members
  }
  const fixed=family(options.standard_id)
  for(const row of v.rows){
    const parent=p.groups.find(g=>g.id===row.group_id),standard=p.groups.find(g=>g.id===options.standard_id)
    const refs=!!(options.use_reference&&parent?.reference_id&&standard?.reference_id)
    if(!parent||!standard||seen.has(row.group_id)||!ids.includes(row.group_id)||row.used_references!==refs
      ||row.moving_id!==(refs?parent.reference_id:parent.id)||row.standard_id!==(refs?standard.reference_id:standard.id)||!Number.isFinite(row.energy_shift)
      ||row.shift_delta!==row.energy_shift-parent.parameters.energy_shift)invalid()
    seen.add(row.group_id)
    if(options.operation!=='inspect')for(const id of family(row.group_id)){
      if(fixed.has(id)||(expected.has(id)&&expected.get(id)!==row.energy_shift))invalid()
      expected.set(id,row.energy_shift)
    }
    for(const [c,id,shift] of [[row.before,row.moving_id,null],[row.after,row.moving_id,row.energy_shift],[row.standard,row.standard_id,null]] as const){
      const g=p.groups.find(g=>g.id===id)
      if(!g||!c||c.group_id!==id||!finite(c.x)||!finite(c.y)||c.x.length!==g.energy.length||c.y.length!==c.x.length||!Number.isFinite(c.e0)
        ||c.x.some((x,i)=>x!==g.energy[i]+(shift??g.parameters.energy_shift)))invalid()
    }
    if(options.operation==='auto'){
      const f=row.fit,s=f?.summary,c=f?.curve
      if(!s||!c||s.energy_shift!==row.energy_shift||!Number.isFinite(s.fitted_shift)||!Number.isFinite(s.derivative_scale)||s.derivative_scale<=0
        ||(s.shift_stderr!==null&&(!Number.isFinite(s.shift_stderr)||s.shift_stderr<0))||!finite(c.x)||c.x.length!==s.fit_points
        ||[c.standard,c.fitted,c.residual].some(a=>!finite(a)||a.length!==c.x.length)
        ||c.residual.some((r,i)=>Math.abs(r-(c.standard[i]-c.fitted[i]))>1e-8*Math.max(1,Math.abs(r))))invalid()
    }
    if(options.operation==='manual'&&row.energy_shift!==options.energy_shift)invalid()
  }
  for(const id of ids)if(!seen.has(id)&&typeof v.skipped_reasons?.[id]!=='string')invalid()
  if(!Array.isArray(v.changes)||new Set(v.changes.map(c=>c.group_id)).size!==v.changes.length||v.changes.length!==expected.size)invalid()
  for(const c of v.changes){
    const g=p.groups.find(g=>g.id===c.group_id)
    if(!g||g.frozen||!Number.isFinite(c.energy_shift)||expected.get(c.group_id)!==c.energy_shift||c.e0!==(g.parameters.e0??g.result?.effective.e0??null))invalid()
  }
  if(options.operation==='inspect'&&v.changes.length)invalid()
}

export function AthenaAlignment({project,activeId,selectGroup,initialDraft,rememberDraft,disabled=false,setBusy,saved,close}:{project:AthenaProject;activeId:string;selectGroup:(id:string)=>void;initialDraft?:AlignmentDraft;rememberDraft:(d:AlignmentDraft)=>void;disabled?:boolean;setBusy:(s:string)=>void;saved:(p:AthenaProject)=>void;close:()=>void}){
  const group=project.groups.find(g=>g.id===activeId)
  const [draft,setDraft]=useState<AlignmentDraft>(()=>({...{standard_id:project.groups.find(g=>g.id!==activeId&&g.data_type!=='chi'&&g.data_type!=='detector')?.id??'',display:'smoothed',fit:'smoothed',use_reference:false},...initialDraft}))
  const [operation,setOperation]=useState<Options['operation']>('inspect'),[scope,setScope]=useState<'current'|'marked'>('current')
  const [shift,setShift]=useState(String(group?.parameters.energy_shift??0)),[selected,setSelected]=useState(activeId)
  const [preview,setPreview]=useState<{key:string;value:AlignmentPreview}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
  const generation=useRef(0),alive=useRef(true),saving=useRef(false)
  useEffect(()=>{rememberDraft(draft)},[draft,rememberDraft])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
  const ids=scope==='marked'?project.groups.filter(g=>g.marked).map(g=>g.id):[activeId]
  const options:Options={...draft,method:'demeter-larch',operation,...(operation==='manual'?{energy_shift:Number(shift)}:{})}
  const valid=!!group&&!!draft.standard_id&&!!ids.length&&(operation!=='manual'||(shift.trim()!==''&&Number.isFinite(Number(shift))&&Math.abs(Number(shift))<=1e6))
  const key=JSON.stringify([project.id,project.version,activeId,ids,options]),committed=useRef(key)
  const current=preview?.key===key&&valid?preview.value:null
  const row=current?.rows.find(r=>r.group_id===selected)??current?.rows[0]
  useLayoutEffect(()=>{committed.current=key;generation.current++;setPreview(null);setError('');setLoading(false)},[key])
  useEffect(()=>{
    if(!valid||disabled)return
    const abort=new AbortController(),token=++generation.current
    const timer=setTimeout(async()=>{
      setLoading(true);setError('')
      try{
        const value=await athenaApi<AlignmentPreview>(`/projects/${project.id}/alignment/preview`,{version:project.version,action:'align',group_ids:ids,options},'POST',abort.signal)
        if(token!==generation.current||committed.current!==key)return
        validate(value,project,ids,options);setPreview({key,value})
        if(options.operation!=='manual')setShift(String(value.rows.find(r=>r.group_id===activeId)?.energy_shift??group?.parameters.energy_shift??0))
      }catch(e){if(!abort.signal.aborted&&token===generation.current)setError(e instanceof Error?e.message:'Alignment preview failed.')}
      finally{if(token===generation.current)setLoading(false)}
    },300)
    return()=>{clearTimeout(timer);abort.abort();generation.current++}
  // key captures the entire request and project revision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,retry,valid,disabled])
  function manual(value:string){setShift(value);setScope('current');setOperation('manual')}
  function auto(marked:boolean){setOperation('auto');setScope(marked?'marked':'current');setPreview(null);setRetry(n=>n+1)}
  async function apply(){
    if(!current||current.options.operation==='inspect'||disabled||saving.current||committed.current!==key)return
    saving.current=true;setBusy('Saving energy alignment');setError('')
    try{
      const next=await athenaApi<AthenaProject>(`/projects/${project.id}/command`,{version:current.version,action:'align',group_ids:current.group_ids,options:current.options})
      if(!alive.current)return
      if(committed.current!==key||next.id!==project.id||next.version!==project.version+1||next.groups.length!==project.groups.length
        ||next.groups.some((g,i)=>g.id!==project.groups[i].id||JSON.stringify(g.energy)!==JSON.stringify(project.groups[i].energy)||JSON.stringify(g.mu)!==JSON.stringify(project.groups[i].mu)
          ||g.parameters.energy_shift!==(current.changes.find(c=>c.group_id===g.id)?.energy_shift??project.groups[i].parameters.energy_shift)
          ||g.parameters.e0!==(current.changes.find(c=>c.group_id===g.id)?.e0??project.groups[i].parameters.e0)))throw new Error('The saved alignment does not match the preview. Reload the workspace.')
      saved(next);close()
    }catch(e){if(alive.current){setPreview(null);setError(e instanceof Error?e.message:'Alignment failed.')}}
    finally{saving.current=false;setBusy('')}
  }
  const displayedShift=shift
  const summary=row?.fit?.summary??row?.saved_fit
  const traces=row?[{x:row.standard.x,y:row.standard.y,name:`Standard · ${row.standard.label}`,type:'scatter',mode:'lines',line:{color:'#16736b'}},
    {x:row.before.x,y:row.before.y,name:'Before alignment',type:'scatter',mode:'lines',line:{color:'#a5afa9',dash:'dot'}},
    {x:row.after.x,y:row.after.y,name:`Aligned · ${row.after.label}`,type:'scatter',mode:'lines',line:{color:'#bb6542'}}]:[]
  return <div className={`ath-modal-body ${controls.body}`}>
    <p>Compare the current spectrum with a fixed standard. Alignment changes the energy shift and preserves each group’s E₀.</p>
    <div className={styles.layout}><fieldset className={styles.controls} disabled={disabled}>
      <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e=>selectGroup(e.target.value)}>{project.groups.map(g=><option key={g.id} value={g.id}>{g.label}{g.frozen?' · frozen':''}</option>)}</select></label>
      <label className="ath-field"><span>Alignment standard</span><select aria-label="Alignment standard" value={draft.standard_id} onChange={e=>{setDraft(d=>({...d,standard_id:e.target.value}));setOperation('inspect');setScope('current')}}><option value="">Choose a standard</option>{project.groups.filter(g=>g.data_type!=='chi'&&g.data_type!=='detector'&&!g.is_difference).map(g=><option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
      <label className="ath-field"><span>Plot as</span><select aria-label="Alignment display" value={draft.display} onChange={e=>setDraft(d=>({...d,display:e.target.value as Display}))}><option value="mu">μ(E)</option><option value="norm">Normalized μ(E)</option><option value="derivative">Derivative</option><option value="smoothed">Smoothed derivative</option></select></label>
      <label className="ath-field"><span>Fit as</span><select aria-label="Alignment fit" value={draft.fit} onChange={e=>setDraft(d=>({...d,fit:e.target.value as AlignmentDraft['fit']}))}><option value="derivative">Derivative</option><option value="smoothed">Smoothed derivative</option></select></label>
      <label className="ath-check"><input type="checkbox" checked={draft.use_reference} onChange={e=>setDraft(d=>({...d,use_reference:e.target.checked}))}/>Use linked reference channels</label>
      <label className="ath-field"><span>Total energy shift · eV</span><input aria-label="Total energy shift · eV" type="number" step="any" value={displayedShift} onChange={e=>manual(e.target.value)}/></label>
      <div className={styles.views}>{[-5,-1,-.5,-.1,.1,.5,1,5].map(n=><button key={n} disabled={disabled||displayedShift.trim()===''||!Number.isFinite(Number(displayedShift))} onClick={()=>manual(String(Number((Number(displayedShift)+n).toFixed(10))))}>{n>0?'+':''}{n} eV</button>)}</div>
      <div className={styles.views}><button disabled={disabled||!valid||group?.frozen} onClick={()=>auto(false)}>Auto align</button><button disabled={disabled||!project.groups.some(g=>g.marked)} onClick={()=>auto(true)}>Align marked groups</button></div>
      <p className="ath-hint">Automatic alignment fits a shift and derivative scale. The measured signal is never rescaled. Review the preview, then save.</p>
      <a href="https://bruceravel.github.io/demeter/documents/Athena/process/align.html" target="_blank" rel="noreferrer">Document section: alignment</a>
    </fieldset><section className={styles.results} aria-label="Alignment preview">
      {current&&current.rows.length>1&&<label className="ath-field"><span>Preview group</span><select aria-label="Alignment preview group" value={row?.group_id} onChange={e=>setSelected(e.target.value)}>{current.rows.map(r=><option key={r.group_id} value={r.group_id}>{r.label} · {r.energy_shift} eV</option>)}</select></label>}
      <div className={styles.plot} aria-label="Alignment plot">{row?<Plot data={traces} layout={{autosize:true,margin:{l:65,r:16,t:65,b:55},legend:{orientation:'h',x:0,y:1.04,yanchor:'bottom'},font:{size:11},xaxis:{title:{text:'Energy (eV)'},range:[row.standard.e0-30,row.standard.e0+50]},yaxis:{title:{text:draft.display==='mu'?'μ(E)':draft.display==='norm'?'Normalized μ(E)':'dμ/dE'}},uirevision:`${project.id}:${row.group_id}:${draft.display}:${draft.standard_id}`}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/>:<p>{loading?'Calculating alignment…':'Choose a source and standard to preview their edges.'}</p>}</div>
      <p role="status">{loading?'Calculating alignment…':current?`Preview ready at project revision ${current.version}.`:!valid?'Choose valid groups and a finite energy shift.':'Preparing alignment preview…'}</p>
      {row&&<><p>Total shift: <strong>{row.energy_shift} eV</strong> · change {row.shift_delta.toFixed(3)} eV.</p>{draft.use_reference&&<p>{row.used_references?'Comparing the two linked reference channels.':'Both spectra need reference channels; comparing the selected spectra.'}</p>}</>}
      {summary&&<p>Shift uncertainty: <strong>{summary.shift_stderr===null||summary.shift_stderr===undefined?'unavailable':`${summary.shift_stderr.toPrecision(5)} eV`}</strong>{summary.derivative_scale!==undefined&&` · derivative scale ${summary.derivative_scale.toPrecision(6)}`}</p>}
      {row?.fit&&<><p>Fitted interval: {row.fit.summary.xmin} to {row.fit.summary.xmax} eV · {row.fit.summary.fit_points} points.{row.fit.summary.smoothing_window!==null&&` Fit smoothing: ${row.fit.summary.smoothing_window} points, order ${row.fit.summary.smoothing_order}.`}</p><details><summary>Fit and residual</summary><div className={styles.plot}><Plot data={[{x:row.fit.curve.x,y:row.fit.curve.standard,name:'Standard derivative',type:'scatter',mode:'lines'},{x:row.fit.curve.x,y:row.fit.curve.fitted,name:'Fitted derivative',type:'scatter',mode:'lines'},{x:row.fit.curve.x,y:row.fit.curve.residual,name:'Residual',type:'scatter',mode:'lines'}]} layout={{autosize:true,margin:{l:60,r:15,t:65,b:50},legend:{orientation:'h',y:1.1},xaxis:{title:{text:'Energy (eV)'}}}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/></div></details></>}
      {current?.changes.map(c=><p key={c.group_id}>{c.label}: shift {c.energy_shift} eV; E₀ remains {c.e0??'automatic'} eV.</p>)}
      {Object.entries(current?.skipped_reasons??{}).map(([id,reason])=><p key={id} className="ath-warning">Skipped {project.groups.find(g=>g.id===id)?.label}: {reason}</p>)}
      {Object.entries(current?.processing_errors??{}).map(([id,reason])=><p key={id} className="ath-warning">{project.groups.find(g=>g.id===id)?.label}: processing needs attention: {reason}</p>)}
      {error&&<div className="ath-error" role="alert">{error}</div>}
    </section></div>
    <div className={`ath-modal-actions ${controls.actions}`}><button disabled={disabled} onClick={close}>Cancel alignment</button><button disabled={disabled||!valid||loading} onClick={()=>{setPreview(null);setRetry(n=>n+1)}}>Replot alignment</button><button className="ath-primary" disabled={disabled||!current||loading||operation==='inspect'} onClick={()=>void apply()}>Save alignment</button></div>
  </div>
}
