'use client'

import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import styles from './athena-difference.module.css'
import controls from './athena-smoothing.module.css'

const Plot=dynamic(()=>import('react-plotly.js').then(m=>m.default),{ssr:false})
type Mode='point'|'margins'|'truncate'
type View='mu'|'chie'
type Options={mode:Mode|'inspect';point?:number;emin?:number;emax?:number;tolerance?:number;side?:'before'|'after';value?:number;scope:'current'|'marked'}
export type PointEditDraft={mode:Mode;point:string;emin:string;emax:string;tolerance:string;side:'before'|'after';value:string;scope:'current'|'marked'}
type Curve={x:number[];y:number[]}
export type PointEditPreview={project_id:string;version:number;options:Options;skipped_reasons:Record<string,string>;changed_group_ids:string[];results:{
  group_id:string;label:string;kept_indices:number[];removed_indices:number[];energy:number[];mu:number[];selected_energy:number[];selected_mu:number[];
  input_points:number;output_points:number;snapped:number|null;processing_error:string|null;
  margins:{x:number[];upper:number[];lower:number[];baseline:number[];region:string;e0:number;indices:number[]}|null;
  original:Record<View,Curve|null>;modified:Record<View,Curve|null>;
  selected_chie:Curve|null;
}[]}
const finite=(a:unknown):a is number[]=>Array.isArray(a)&&a.every(v=>typeof v==='number'&&Number.isFinite(v))
function validate(v:PointEditPreview,p:AthenaProject,ids:string[],options:Options){
  if(v.project_id!==p.id||v.version!==p.version||Object.entries(options).some(([k,a])=>v.options?.[k as keyof Options]!==a)||!Array.isArray(v.results)||!v.results.length)
    throw new Error('The point-removal preview does not match this project and these settings. Preview again.')
  const seen=new Set<string>()
  for(const r of v.results){
    const g=p.groups.find(g=>g.id===r.group_id)
    if(!g||!ids.includes(r.group_id)||seen.has(r.group_id)||!finite(r.kept_indices)||!finite(r.removed_indices)||!finite(r.energy)||!finite(r.mu))throw new Error('The point-removal preview is incomplete.')
    seen.add(r.group_id)
    const all=[...r.kept_indices,...r.removed_indices].sort((a,b)=>a-b)
    if(r.input_points!==g.mu.length||r.output_points!==r.kept_indices.length||r.energy.length!==r.output_points||r.mu.length!==r.output_points||all.length!==g.mu.length||all.some((v,i)=>v!==i)
      ||r.kept_indices.some((v,i)=>g.energy[v]!==r.energy[i]||g.mu[v]!==r.mu[i])||!finite(r.selected_energy)||!finite(r.selected_mu)||r.selected_energy.length!==r.removed_indices.length||r.selected_mu.length!==r.removed_indices.length)
      throw new Error('The point-removal preview has inconsistent source rows.')
    const shift=g.data_type==='chi'?0:g.parameters.energy_shift
    if(r.removed_indices.some((v,i)=>r.selected_energy[i]!==g.energy[v]+shift||r.selected_mu[i]!==g.mu[v])
      ||r.kept_indices.some((v,i)=>i>0&&v<=r.kept_indices[i-1])||r.removed_indices.some((v,i)=>i>0&&v<=r.removed_indices[i-1]))throw new Error('The selected markers do not match the measured rows.')
    for(const views of [r.original,r.modified])for(const view of ['mu','chie'] as const){const c=views?.[view];if((view==='mu'&&!c)||(c&&(!finite(c.x)||!finite(c.y)||c.x.length!==c.y.length)))throw new Error('The point-removal plot is incomplete.')}
    if(r.original.mu!.x.length!==g.energy.length||r.original.mu!.x.some((x,i)=>x!==g.energy[i]+shift)||r.original.mu!.y.some((y,i)=>y!==g.mu[i])
      ||r.modified.mu!.x.length!==r.energy.length||r.modified.mu!.x.some((x,i)=>x!==r.energy[i]+shift)||r.modified.mu!.y.some((y,i)=>y!==r.mu[i]))throw new Error('The plot does not match the retained measurements.')
    if(r.selected_chie&&(!finite(r.selected_chie.x)||!finite(r.selected_chie.y)||r.selected_chie.x.length!==r.selected_chie.y.length||r.selected_chie.x.some(x=>!r.selected_energy.includes(x))))throw new Error('The selected χ(E) markers are incomplete.')
    if(r.margins&&(!finite(r.margins.x)||!finite(r.margins.upper)||!finite(r.margins.lower)||r.margins.x.length!==r.margins.upper.length||r.margins.x.length!==r.margins.lower.length))throw new Error('The margin preview is incomplete.')
  }
  if(ids.some(id=>!seen.has(id)&&!v.skipped_reasons?.[id]))throw new Error('The preview is missing a selected group.')
}

export function AthenaPointEdit({project,activeId,selectGroup,initialMode,initialDraft,rememberDraft,setBusy,disabled,saved,close}:{
  project:AthenaProject;activeId:string;selectGroup:(id:string)=>void;initialMode:'point'|'truncate';initialDraft?:PointEditDraft;rememberDraft:(d:PointEditDraft)=>void;
  setBusy:(v:string)=>void;disabled:boolean;saved:(p:AthenaProject)=>void;close:()=>void;
}){
  const group=project.groups.find(g=>g.id===activeId),effective=group?.result?.effective??{},e0=typeof effective.e0==='number'?effective.e0:null
  const [draft,setDraft]=useState<PointEditDraft>(()=>({...initialDraft,mode:initialMode,point:'',
    emin:initialDraft?.emin??String(effective.norm1??30),emax:initialDraft?.emax??String(effective.norm2??(e0&&group?group.energy.at(-1)!+group.parameters.energy_shift-e0:200)),
    tolerance:initialDraft?.tolerance??String(typeof effective.edge_step==='number'?effective.edge_step*.1:.1),
    side:initialDraft?.side??'after',value:initialDraft?.value??String(group?group.energy.at(-1)!+group.parameters.energy_shift:''),scope:'current'}))
  useEffect(()=>{rememberDraft(draft)},[draft,rememberDraft])
  const [view,setView]=useState<View>('mu'),[picking,setPicking]=useState<null|'point'|'emin'|'emax'|'value'>(null)
  const [preview,setPreview]=useState<{key:string;value:PointEditPreview}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
  const generation=useRef(0),saving=useRef(false),alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
  const scope=draft.mode==='truncate'?draft.scope:'current'
  const ids=scope==='marked'?project.groups.filter(g=>g.marked).map(g=>g.id):[activeId]
  const inspecting=draft.mode==='point'&&!draft.point.trim()
  const options:Options={mode:inspecting?'inspect':draft.mode,scope,...(inspecting?{}:draft.mode==='point'?{point:Number(draft.point)}:draft.mode==='margins'?{emin:Number(draft.emin),emax:Number(draft.emax),tolerance:Number(draft.tolerance)}:{side:draft.side,value:Number(draft.value)})}
  const numeric=inspecting||(draft.mode==='point'?['point'] as const:draft.mode==='margins'?['emin','emax','tolerance'] as const:['value'] as const).every(k=>draft[k].trim()&&Number.isFinite(Number(draft[k])))
  const eligible=!!group&&group.data_type!=='chi'&&ids.length>0&&(scope==='marked'||!group.frozen)
  const valid=numeric&&(draft.mode!=='margins'||(e0!==null&&Number(draft.tolerance)>=0&&Number(draft.emin)<Number(draft.emax)&&(Number(draft.emax)<=0||Number(draft.emin)>=0)))
  const key=JSON.stringify([project.id,project.version,activeId,ids,options]),committed=useRef(key),pickContext=useRef({key,picking})
  const current=preview?.key===key&&valid?preview.value:null
  useLayoutEffect(()=>{committed.current=key;generation.current++;setPreview(null);setError('');setLoading(false);setPicking(null)},[key])
  useLayoutEffect(()=>{pickContext.current={key,picking}},[key,picking])
  useEffect(()=>{setDraft(d=>({...d,point:''}));setView('mu')},[activeId])
  useEffect(()=>{
    if(!eligible||!valid||disabled)return
    const abort=new AbortController(),token=++generation.current
    const timer=setTimeout(async()=>{
      setLoading(true);setError('')
      try{
        const value=await athenaApi<PointEditPreview>(`/projects/${project.id}/point-edit/preview`,{version:project.version,action:draft.mode==='truncate'?'truncate':'deglitch',group_ids:ids,options},'POST',abort.signal)
        if(token!==generation.current||committed.current!==key)return
        validate(value,project,ids,options);setPreview({key,value})
      }catch(e){if(!abort.signal.aborted&&token===generation.current)setError(e instanceof Error?e.message:'Preview failed.')}
      finally{if(token===generation.current)setLoading(false)}
    },350)
    return()=>{clearTimeout(timer);abort.abort();generation.current++}
  // The complete request is captured in key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,retry,eligible,valid,disabled])
  const row=current?.results.find(r=>r.group_id===activeId)??current?.results[0]
  const total=current?.results.reduce((n,r)=>n+r.removed_indices.length,0)??0
  const base=group&&group.data_type!=='chi'?{x:group.energy.map(x=>x+(group.data_type==='chi'?0:group.parameters.energy_shift)),y:group.mu}:null
  const original=row?.original[view]??(view==='mu'?base:null),modified=row?.modified[view]
  const traces:Array<Record<string,unknown>>=[]
  if(original)traces.push({x:original.x,y:original.y,name:'Current data',type:'scatter',mode:'lines+markers',marker:{size:4},line:{color:'#16736b',width:1.4}})
  if(modified&&row?.removed_indices.length)traces.push({x:modified.x,y:modified.y,name:'After removal',type:'scatter',mode:'lines',line:{color:'#747f90',width:1.4,dash:'dot'}})
  const selected=row?(view==='mu'?{x:row.selected_energy,y:row.selected_mu}:row.selected_chie):null
  if(selected?.x.length)traces.push({x:selected.x,y:selected.y,name:'Selected for removal',type:'scatter',mode:'markers',marker:{color:'#bb6542',size:10,symbol:'circle-open',line:{width:2}}})
  if(row?.margins&&view==='mu')for(const side of ['upper','lower'] as const)traces.push({x:row.margins.x,y:row.margins[side],name:`${side==='upper'?'Upper':'Lower'} margin`,type:'scatter',mode:'lines',line:{color:'#a85087',dash:'dash',width:1.5}})
  function pick(event:{points?:{x?:unknown}[]}){
    const context=pickContext.current,x=event.points?.[0]?.x
    if(!context.picking||context.key!==key||committed.current!==key||disabled||typeof x!=='number'||!Number.isFinite(x))return
    const field=context.picking
    if((field==='emin'||field==='emax')&&e0===null)return
    setDraft(d=>({...d,[field]:field==='emin'||field==='emax'?(x-e0!).toFixed(2):String(x)}));setPicking(null)
  }
  async function apply(action:'remove'|'undo'|'redo'){
    if(disabled||saving.current||(action==='remove'&&(!current||!total||committed.current!==key)))return
    saving.current=true;setBusy(action==='remove'?'Removing selected points':action==='undo'?'Undoing edit':'Redoing edit');setError('')
    try{
      const next=await athenaApi<AthenaProject>(`/projects/${project.id}/command`,action==='remove'?{version:current!.version,action:draft.mode==='truncate'?'truncate':'deglitch',group_ids:ids,options:current!.options}:{version:project.version,action})
      if(!alive.current)return
      if(committed.current!==key||next.id!==project.id||next.version!==project.version+1)throw new Error('The workspace changed while applying this edit. Reload the project.')
      if(action==='remove'&&(next.groups.length!==project.groups.length||current!.results.some(r=>{const g=next.groups.find(g=>g.id===r.group_id);return !g||g.energy.length!==r.energy.length||g.energy.some((x,i)=>x!==r.energy[i])||g.mu.length!==r.mu.length||g.mu.some((y,i)=>y!==r.mu[i])})))throw new Error('The saved point removal does not match the preview. Reload the project.')
      setPreview(null);setDraft(d=>({...d,point:''}));saved(next)
    }catch(e){if(alive.current){setPreview(null);setError(e instanceof Error?e.message:'Could not apply this edit.')}}
    finally{saving.current=false;setBusy('')}
  }
  const field=(key:'point'|'emin'|'emax'|'tolerance'|'value',label:string,pluck=false)=><label className="ath-field"><span>{label}</span><input aria-label={label} type="number" step="any" value={draft[key]} onChange={e=>setDraft(d=>({...d,[key]:e.target.value}))}/>{pluck&&key!=='tolerance'&&<button type="button" aria-pressed={picking===key} onClick={()=>setPicking(picking===key?null:key)}>{picking===key?'Cancel pick':`Pick ${label}`}</button>}</label>
  return <div className={`ath-modal-body ${controls.body}`} onKeyDown={e=>{if(e.key==='Escape'&&picking){e.stopPropagation();setPicking(null)}}}>
    <p>Review the highlighted measurements before removing them from the current group. The source file stays unchanged. Undo restores the previous data and processing settings.</p>
    <div className={styles.layout}><fieldset className={styles.controls} disabled={disabled}>
      <label className="ath-field"><span>Source group</span><select aria-label="Source group" value={activeId} onChange={e=>selectGroup(e.target.value)}>{project.groups.map(g=><option key={g.id} value={g.id}>{g.label}{g.frozen?' · frozen':''}</option>)}</select></label>
      <label className="ath-field"><span>Operation</span><select aria-label="Operation" value={draft.mode} onChange={e=>{setDraft(d=>({...d,mode:e.target.value as Mode}));setView('mu')}}><option value="point">Remove a point</option><option value="margins">Remove outside margins</option><option value="truncate">Truncate before or after</option></select></label>
      {draft.mode==='point'&&<>{field('point','Point energy · eV',true)}<p className="ath-hint">Pick a plotted point or type an energy. The closest measured point is highlighted; exact ties select the higher energy.</p></>}
      {draft.mode==='margins'&&<>{field('tolerance','Margin tolerance · signal units')}{field('emin','Minimum relative to E0 · eV',true)}{field('emax','Maximum relative to E0 · eV',true)}<p className="ath-hint">Use negative bounds for the pre-edge or positive bounds for the post-edge. The margins follow the saved normalization line; points strictly outside are selected. Inspect the curves so real spectral structure is retained.</p></>}
      {draft.mode==='truncate'&&<><label className="ath-field"><span>Drop points</span><select aria-label="Drop points" value={draft.side} onChange={e=>setDraft(d=>({...d,side:e.target.value as 'before'|'after'}))}><option value="before">Before cutoff</option><option value="after">After cutoff</option></select></label>{field('value','Cutoff energy · eV',true)}<label className="ath-field"><span>Apply to</span><select aria-label="Apply to" value={draft.scope} onChange={e=>setDraft(d=>({...d,scope:e.target.value as 'current'|'marked'}))}><option value="current">Current group</option><option value="marked">Marked groups</option></select></label><p className="ath-hint">The cutoff snaps to the measured point at or below the typed value. Before keeps that point; after removes it. Marked groups use the same absolute cutoff.</p></>}
      <a href="https://bruceravel.github.io/demeter/documents/Athena/process/deg.html" target="_blank" rel="noreferrer">Document section: deglitching and truncation</a>
    </fieldset><section className={styles.results} aria-label="Point removal preview">
      <div className={styles.views}><button disabled={disabled} aria-pressed={view==='mu'} onClick={()=>setView('mu')}>Plot μ(E)</button><button disabled={disabled||draft.mode!=='point'} aria-pressed={view==='chie'} onClick={()=>setView('chie')}>Plot χ(E)</button></div>
      <div className={styles.plot} aria-label="Point removal plot">{original?<Plot data={traces} onClick={pick} layout={{autosize:true,margin:{l:62,r:18,t:55,b:55},hovermode:'closest',font:{size:11},legend:{orientation:'h',x:0,y:1.04,yanchor:'bottom'},xaxis:{title:{text:'Energy (eV)'}},yaxis:{title:{text:view==='mu'?'μ(E)':`k^${group?.parameters.kweight} χ(E)`}},uirevision:`${project.id}:${activeId}:${view}`,shapes:draft.mode==='truncate'&&numeric?[{type:'line',x0:Number(draft.value),x1:Number(draft.value),y0:0,y1:1,yref:'paper',line:{color:'#bb6542',dash:'dash'}}]:[]}} config={{responsive:true,displaylogo:false}} style={{width:'100%',height:'100%'}} useResizeHandler/>:<p>χ(E) requires a successfully processed EXAFS spectrum. Use μ(E) or repair the processing settings.</p>}</div>
      {picking&&<p role="status">Click a point in the plot to fill the selected field. Escape cancels picking.</p>}
      <p role="status">{!eligible?'Choose an editable group or mark groups to truncate.':!valid?'Enter finite values; margin limits must increase on the same side of E0.':loading?'Calculating point-removal preview…':current?`${total} points selected at project revision ${current.version}.`:'Select a point or review the removal limits.'}</p>
      {row&&<p>Preview: {row.label} · {row.output_points} of {row.input_points} measurements remain.{row.snapped!==null&&` Cutoff anchor: ${row.snapped} eV.`}</p>}
      {current?.results.map(r=><p key={r.group_id}>{r.label}: remove {r.removed_indices.length} points.{r.processing_error&&` Processing needs attention after this edit: ${r.processing_error}`}</p>)}
      {current&&Object.entries(current.skipped_reasons).map(([id,reason])=><p key={id} className="ath-warning">{project.groups.find(g=>g.id===id)?.label}: {reason}</p>)}
      {error&&<div className="ath-error" role="alert">{error}</div>}
    </section></div>
    <div className={`ath-modal-actions ${controls.actions}`}><button disabled={disabled} onClick={close}>Close point editing</button><button disabled={disabled||!project.undo?.length} onClick={()=>void apply('undo')}>Undo last edit</button><button disabled={disabled||!project.redo?.length} onClick={()=>void apply('redo')}>Redo last edit</button><button disabled={disabled||!eligible||!valid||loading} onClick={()=>{setPreview(null);setRetry(n=>n+1)}}>Replot selection</button><button className="ath-primary" disabled={disabled||!current||!total||loading} onClick={()=>void apply('remove')}>{draft.mode==='truncate'?'Truncate data':draft.mode==='margins'?'Remove selected glitches':'Remove point'}</button></div>
  </div>
}
