import { FolioIcon } from './FolioIcon';
import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import type { FolioNote } from '@/lib/folio/schema';
import { useUIStore } from '@/stores/useUIStore';

export function FolioSidebar() {
  const {t}=useI18n();const api=useFolioStore(s=>s.api);const status=useFolioStore(s=>s.status);const error=useFolioStore(s=>s.error);const {run,refresh}=useFolioStore.getState();
  const [query,setQuery]=React.useState('');const [filter,setFilter]=React.useState('all');
  const [collapsed,setCollapsed]=React.useState<Set<string>>(new Set());
  if(!api)return null;
  const notes=status?.notes || [];
  const visible=notes.filter(n=>(filter==='trash'?n.trashed:!n.trashed) && (filter!=='favorites'||n.favorite) && (!query || `${n.title} ${n.tags.join(' ')} ${n.blocks.map(b=>b.text).join(' ')}`.toLowerCase().includes(query.toLowerCase())));
  const open=(note:FolioNote)=>{useUIStore.getState().closeMainSurfaces();void run({command:'select',noteID:note.id});};
  const flat=Boolean(query)||filter!=='all';
  function tree(parentID?:string,depth=0):React.ReactNode {
    if(depth>100)return null;
    return visible.filter(n=>flat || (n.parentID===parentID || (!parentID && !visible.some(p=>p.id===n.parentID)))).map(note=>{
      const children=visible.some(n=>n.parentID===note.id);const expanded=!collapsed.has(note.id);
      return <React.Fragment key={note.id}><div className={`flex items-center rounded-md ${status?.selectedID===note.id?'bg-interactive-selection':''}`} style={{paddingLeft:flat?0:depth*12}}>
        <Button variant="ghost" size="sm" className="w-6 px-0" aria-label={note.title} aria-expanded={children?expanded:undefined} disabled={!children} onClick={()=>setCollapsed(old=>{const next=new Set(old);if(next.has(note.id))next.delete(note.id);else next.add(note.id);return next;})}>{children?(expanded?'⌄':'›'):''}</Button>
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1 normal-case" onClick={()=>open(note)}><FolioIcon value={note.icon}/><span className="truncate">{note.title || t('folio.newPage')}</span>{note.favorite?'☆':''}</Button>
      </div>{!flat&&expanded&&tree(note.id,depth+1)}</React.Fragment>;
    });
  }
  return <section className="border-t border-border px-3 py-2 min-h-32 max-h-[42vh] flex flex-col" aria-label={t('folio.pages')}>
    <div className="flex items-center justify-between"><Button variant="ghost" size="sm" onClick={()=>void refresh()}>{t('folio.pages')}</Button><Button variant="ghost" size="sm" aria-label={t('folio.newPage')} onClick={()=>{useUIStore.getState().closeMainSurfaces();void run({command:'create'});}}>+</Button></div>
    <input id="folio-search" className="w-full bg-transparent border border-border rounded-md px-2 py-1 text-sm" aria-label={t('folio.search')} placeholder={t('folio.search')} value={query} onChange={event=>setQuery(event.target.value)}/>
    <div className="flex gap-1 py-1">{(['all','favorites','trash'] as const).map(value=><Button key={value} variant="ghost" size="sm" className="px-1 text-xs" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{t(value==='all'?'folio.allPages':value==='favorites'?'folio.favorites':'folio.trash')}</Button>)}</div>
    <div className="overflow-y-auto min-h-0">{tree()}{!visible.length&&<p className="p-2 text-xs text-muted-foreground">{t('folio.empty')}</p>}</div>
    {error&&<Button variant="ghost" size="sm" onClick={()=>void refresh()}>{t('folio.retry')}</Button>}
  </section>;
}
