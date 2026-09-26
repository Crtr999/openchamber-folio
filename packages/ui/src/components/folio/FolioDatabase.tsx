import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { columnKinds, columnKindSchema, type FolioTable } from '@/lib/folio/schema';
const fieldClass='bg-transparent border border-border rounded-md px-2 py-1 text-sm';
export function FolioDatabase({table,onChange}:{table:FolioTable;onChange:(table:FolioTable)=>void}) {
 const {t}=useI18n();const [editingColumn,setEditingColumn]=React.useState<string>();
 const update=(change:Partial<FolioTable>)=>onChange({...table,...change});
 const column=table.columns.find(c=>c.id===editingColumn);
 const groupedBy=table.columns.find(c=>c.id===(table.view==='chart'?table.chartBy:table.groupBy)) || table.columns.find(c=>c.kind==='select'||c.kind==='status') || table.columns[0];
 const groups=[...new Set([...(groupedBy?.options || []),...table.rows.map(row=>row.values[groupedBy?.id || ''] || '')])];
 const cell=(row:FolioTable['rows'][number],col:FolioTable['columns'][number])=>{
  const value=row.values[col.id] || '';
  const change=(text:string)=>update({rows:table.rows.map(r=>r.id===row.id?{...r,values:{...r.values,[col.id]:text}}:r)});
  if(col.kind==='select'||col.kind==='status')return <select aria-label={col.name} className={dropdownTriggerVariants({size:'sm'})+' w-full'} value={value} onChange={e=>change(e.target.value)}><option value="">—</option>{[...new Set([...col.options,...(value?[value]:[])])].map(option=><option key={option}>{option}</option>)}</select>;
  return <input aria-label={col.name} className={fieldClass+' w-full min-w-28'} type={col.kind==='date'?'date':col.kind==='number'||col.kind==='rating'?'number':'text'} min={col.kind==='rating'?0:undefined} max={col.kind==='rating'?5:undefined} value={value} onChange={e=>change(e.target.value)}/>;
 };
 return <section className="space-y-4 py-4">
  <div className="flex flex-wrap gap-2">{(['table','board','chart'] as const).map(view=><Button key={view} size="sm" variant="chip" aria-pressed={table.view===view} onClick={()=>update({view})}>{t(`folio.${view}`)}</Button>)}
   <Button size="sm" variant="outline" onClick={()=>update({rows:[...table.rows,{id:crypto.randomUUID(),values:{}}]})}>{t('folio.row')}</Button>
   <Button size="sm" variant="outline" onClick={()=>{const id=crypto.randomUUID();update({columns:[...table.columns,{id,name:t('folio.name'),kind:'text',options:[]}]});setEditingColumn(id);}}>{t('folio.column')}</Button>
   {table.view!=='table'&&<label className="text-sm">{t('folio.group')} <select className={dropdownTriggerVariants({size:'sm'})} value={groupedBy?.id || ''} onChange={e=>update(table.view==='chart'?{chartBy:e.target.value}:{groupBy:e.target.value})}>{table.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
  </div>
  {column&&<div className="flex flex-wrap gap-2 p-3 border border-border rounded-lg">
   <input className={fieldClass} aria-label={t('folio.name')} value={column.name} onChange={e=>update({columns:table.columns.map(c=>c.id===column.id?{...c,name:e.target.value}:c)})}/>
   <select className={dropdownTriggerVariants({size:'sm'})} aria-label={t('folio.kind')} value={column.kind} onChange={e=>{const parsed=columnKindSchema.safeParse(e.target.value);if(parsed.success)update({columns:table.columns.map(c=>c.id===column.id?{...c,kind:parsed.data}:c)});}}>{columnKinds.map(kind=><option key={kind} value={kind}>{t(`folio.property.${kind}`)}</option>)}</select>
   {(column.kind==='select'||column.kind==='status')&&<input className={fieldClass} aria-label={t('folio.options')} placeholder={t('folio.options')} value={column.options.join(', ')} onChange={e=>update({columns:table.columns.map(c=>c.id===column.id?{...c,options:e.target.value.split(',').map(s=>s.trim())}:c)})}/>}
   <Button size="sm" variant="ghost" onClick={()=>{update({columns:table.columns.filter(c=>c.id!==column.id)});setEditingColumn(undefined);}}>{t('folio.remove')}</Button><Button size="sm" variant="ghost" onClick={()=>setEditingColumn(undefined)}>✓</Button>
  </div>}
  {table.view==='table'&&<div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr>{table.columns.map(c=><th key={c.id} className="text-left p-2 border-b border-border"><Button size="sm" variant="ghost" onClick={()=>setEditingColumn(c.id)}>{c.name}</Button></th>)}<th/></tr></thead><tbody>{table.rows.map(row=><tr key={row.id}>{table.columns.map(col=><td key={col.id} className="p-1 border-b border-border">{cell(row,col)}</td>)}<td><Button size="sm" variant="ghost" aria-label={t('folio.remove')} onClick={()=>update({rows:table.rows.filter(r=>r.id!==row.id)})}>×</Button></td></tr>)}</tbody></table></div>}
  {table.view==='board'&&<div className="flex gap-4 overflow-x-auto">{groups.map(group=><section key={group} className="min-w-60 flex-1 rounded-lg border border-border p-3"><h3 className="font-medium pb-3">{group || '—'} · {table.rows.filter(r=>(r.values[groupedBy?.id || ''] || '')===group).length}</h3>{table.rows.filter(r=>(r.values[groupedBy?.id || ''] || '')===group).map(row=><div key={row.id} className="mb-3 rounded-md bg-secondary p-3 space-y-2">{table.columns.map(col=><label key={col.id} className="block text-xs text-muted-foreground">{col.name}{cell(row,col)}</label>)}</div>)}</section>)}</div>}
  {table.view==='chart'&&<div className="space-y-3" role="img" aria-label={t('folio.chart')}>{groups.map(group=>{const count=table.rows.filter(r=>(r.values[groupedBy?.id || ''] || '')===group).length;return <div key={group} className="grid grid-cols-[140px_1fr_40px] items-center gap-3 text-sm"><span className="truncate">{group || '—'}</span><div className="bg-secondary rounded h-7"><div className="h-7 bg-primary rounded" style={{width:`${count/Math.max(1,table.rows.length)*100}%`}}/></div><span>{count}</span></div>;})}</div>}
 </section>;
}
