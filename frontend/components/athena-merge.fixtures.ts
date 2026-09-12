import type { AthenaProject } from '@/lib/athena'
import type { MergePreview } from './athena-merge'

export const mergeDefaults={version:0,values:{weightby:'importance',exclude_short_data:true,short_data_margin:10,plot:'stddev',push_metadata:true,merge_references:true}} as const
export function mergePreview(p:AthenaProject,ids:string[],options:Partial<MergePreview['options']>):MergePreview{
  const opts={...mergeDefaults.values,method:'demeter-larch',array:'mu',weights:{},reference_weights:{},...options} as MergePreview['options']
  const groups=ids.map(id=>p.groups.find(g=>g.id===id)!)
  if(groups.some(g=>!g))throw new Error('Missing test source')
  if(opts.array==='chi'&&groups.some(g=>!g.result?.arrays.chi?.length))throw new Error('Process chi before merging.')
  const x=Array.from({length:8},(_,i)=>opts.array==='chi'?i*.5:8970+i)
  const weights=groups.map(g=>opts.weights[g.id]??1),total=weights.reduce((a,b)=>a+b,0)
  if(total<=0||weights.some(v=>v<0))throw new Error('Merge weights must be nonnegative with a positive total.')
  const y=x.map((_,i)=>i*.1),stddev=x.map(()=>.02)
  const traces=[{name:'Merged spectrum',x,y},{name:'Merge + standard deviation',x,y:y.map((v,i)=>v+stddev[i])},{name:'Merge − standard deviation',x,y:y.map((v,i)=>v-stddev[i])}]
  const components=groups.map(g=>({group_id:g.id,label:g.label,y:y.map(v=>v+.01)}))
  const result={x,y,stddev,details:{count:ids.length},members:groups.map((g,i)=>({group_id:g.id,label:g.label,points:g.energy.length,weight:weights[i],coefficient:weights[i]/total,extrapolated_points:0})),excluded:[],warnings:[],components}
  const plots={stddev:traces,variance:[traces[0],{name:'17.5 × standard deviation',x,y:stddev.map(v=>v*17.5)}],marked:[traces[0],...components.map(c=>({name:c.label,x,y:c.y}))]}
  return {project_id:p.id,version:p.version,group_ids:ids,options:opts,requested_options:options as MergePreview['options'],notes:[],outputs:[{role:'sample',label:opts.label??'merge',data_type:opts.array==='chi'?'chi':'mu',parameters:{...groups[0].parameters,energy_shift:0},result,curves:plots[opts.plot],plots,processing_error:null}]}
}
export function mergeSaved(p:AthenaProject,v:MergePreview):AthenaProject{
  return {...p,version:p.version+1,groups:[...p.groups,...v.outputs.map((o,i)=>({...p.groups[0],id:`merged-${i}`,label:o.label,energy:o.result.x,mu:o.result.y,parameters:o.parameters,data_type:o.data_type,marked:i===0,reference_id:null,
    source:{raw_arrays:{stddev:o.result.stddev}},result:{arrays:{energy:o.result.x,mu:o.result.y},effective:{},warnings:[]},processing_error:null}))]}
}
