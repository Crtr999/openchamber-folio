import { FolioIcon } from './FolioIcon';
import { folioSymbols } from '@/lib/folio/icons';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import { blockKinds, blockKindSchema, colorNames, makeBlock, type FolioBlock, type FolioRequest } from '@/lib/folio/schema';
import { folioColors } from '@/lib/folio/rich-text';
import { useInputStore } from '@/sync/input-store';
import { FolioDatabase } from './FolioDatabase';
import { FolioRichBlock } from './FolioRichBlock';
import './folio.css';
const field='bg-transparent border border-border rounded-md px-2 py-1 text-sm';
type ColorName=typeof colorNames[number];
type Paint='textColor'|'highlight';
/** Shows each color itself, not just its name. Keeps the text selection while clicking. */
function Swatches({kind,label,onPick,compact}:{kind:Paint;label:(color:ColorName)=>string;onPick:(color:ColorName)=>void;compact?:boolean}) {
 return <div className="flex items-center gap-1" role="group">{colorNames.map(color=>{
  const hex=color==='none'?undefined:folioColors[color];
  return <button key={color} type="button" title={label(color)} aria-label={label(color)} onMouseDown={e=>e.preventDefault()} onClick={()=>onPick(color)}
   className={(compact?'size-5':'size-6')+' shrink-0 rounded-full border border-border/70 flex items-center justify-center text-[11px] font-bold leading-none hover:scale-110 transition-transform'}
   style={kind==='highlight'?{background:hex??'transparent'}:{color:hex??'currentColor'}}>
   {kind==='textColor'?'A':color==='none'?'⊘':null}
  </button>;
 })}</div>;
}
function latestNote(){const s=useFolioStore.getState();const base=s.status?.notes.find(n=>n.id===s.status?.selectedID);return base&&(s.drafts[base.id]?.note||base);}
export function FolioWorkspace() {
 const {t}=useI18n();const {status,drafts,edit,run,close,saving,error}=useFolioStore();
 const [active,setActive]=React.useState<{id:string;editor:Editor}>();
 const [blockMenuID,setBlockMenuID]=React.useState<string>();
 const [focusBlock,setFocusBlock]=React.useState<string>();
 const [link,setLink]=React.useState('');const [linkOpen,setLinkOpen]=React.useState(false);
 const [bubble,setBubble]=React.useState<{top:number;left:number}>();
 const [, setSelectionTick]=React.useState(0);
 // The format menu waits until the selection is finished (mouse released) and sits below the
 // selected line, so it never covers the text being selected.
 const pointerDown=React.useRef(false);
 const bubbleRef=React.useRef<HTMLDivElement>(null);
 const activeEditor=React.useRef<Editor | undefined>(undefined);
 const placeBubble=React.useCallback((editor:Editor)=>{
  if(editor.isDestroyed)return;
  const {from,to,empty}=editor.state.selection;
  if(empty||!editor.isFocused||pointerDown.current){setBubble(undefined);return;}
  const start=editor.view.coordsAtPos(from),end=editor.view.coordsAtPos(to);
  const menuHeight=bubbleRef.current?.offsetHeight||124;
  const below=end.bottom+12;
  const top=below+menuHeight<window.innerHeight-8?below:Math.max(8,start.top-menuHeight-12);
  const left=Math.max(8,Math.min(window.innerWidth-440,Math.min(start.left,end.left)));
  setBubble({top,left});
 },[]);
 const trackSelection=React.useCallback((editor:Editor,blockID:string)=>{
  activeEditor.current=editor;
  setActive(previous=>previous?.editor===editor?previous:{id:blockID,editor});
  setSelectionTick(n=>n+1);
  placeBubble(editor);
 },[placeBubble]);
 React.useEffect(()=>{
  const down=(event:MouseEvent)=>{if(event.target instanceof Node&&bubbleRef.current?.contains(event.target))return;pointerDown.current=true;setBubble(undefined);};
  const up=()=>{if(!pointerDown.current)return;pointerDown.current=false;requestAnimationFrame(()=>{if(activeEditor.current)placeBubble(activeEditor.current);});};
  document.addEventListener('mousedown',down,true);document.addEventListener('mouseup',up,true);
  return()=>{document.removeEventListener('mousedown',down,true);document.removeEventListener('mouseup',up,true);};
 },[placeBubble]);
 const paint=(kind:Paint,color:ColorName)=>{const editor=active?.editor;if(!editor||editor.isDestroyed)return;const chain=editor.chain().focus();
  if(kind==='textColor'){if(color==='none')chain.unsetColor().run();else chain.setColor(folioColors[color]).run();}
  else{if(color==='none')chain.unsetHighlight().run();else chain.setHighlight({color:folioColors[color]}).run();}};
 const colorLabel=(kind:Paint)=>(color:ColorName)=>`${t(kind==='textColor'?'folio.textColor':'folio.highlight')}: ${t(`folio.color.${color}`)}`;

 const selected=status?.notes.find(n=>n.id===status.selectedID);const note=selected&&(drafts[selected.id]?.note || selected);
 const hidden=new Set<string>();let hiddenLevel: number | undefined;let hiddenToggle=false;
 for(const block of note?.blocks || []) {
  const level=Number(block.kind.match(/(?:h|H)eading([1-4])/)?.[1] || 0);
  if(hiddenLevel!==undefined) {if(level>0&&level<=hiddenLevel)hiddenLevel=undefined;else{hidden.add(block.id);continue;}}
  if(hiddenToggle) {if(block.kind==='toggle'||level>0)hiddenToggle=false;else{hidden.add(block.id);continue;}}
  if(block.kind.startsWith('toggleHeading')&&block.checked)hiddenLevel=level;
  if(block.kind==='toggle'&&block.checked)hiddenToggle=true;
 }
 React.useEffect(()=>{setActive(undefined);},[note?.id]);
 const isDescendant=(candidate:string):boolean=>{
   const seen=new Set<string>();let cursor=status?.notes.find(n=>n.id===candidate);
   while(cursor){if(cursor.id===note?.id||seen.has(cursor.id))return true;seen.add(cursor.id);cursor=status?.notes.find(n=>n.id===cursor?.parentID);}
   return false;
 };
 const call=(input:FolioRequest)=>void run({noteID:note?.id,...input});
 const utility=(kind:string)=>call({command:'utility',kind});
 React.useEffect(()=>{
  const shortcut=(event:KeyboardEvent)=>{
   if(!event.metaKey&&!event.ctrlKey)return;
   const key=event.key.toLowerCase();
   if(key==='n'||key==='k'||key==='j'||(key==='e'&&event.shiftKey)){
    event.preventDefault();event.stopImmediatePropagation();
    if(key==='n')void useFolioStore.getState().run({command:'create'});
    if(key==='k')document.getElementById('folio-search')?.focus();
    if(key==='j')void useFolioStore.getState().run({command:'utility',kind:'assistant'});
    if(key==='e')void useFolioStore.getState().run({command:'export'});
   }
  };
  window.addEventListener('keydown',shortcut,true);return()=>window.removeEventListener('keydown',shortcut,true);
 },[]);
 const updateBlock=React.useCallback((block:FolioBlock)=>{const current=latestNote();if(current)edit({...current,blocks:current.blocks.map(b=>b.id===block.id?block:b)});},[edit]);
 const addBlock=(after?:string)=>{if(!note)return;const blocks=[...note.blocks],block=makeBlock();blocks.splice(after?blocks.findIndex(b=>b.id===after)+1:blocks.length,0,block);setFocusBlock(block.id);edit({...note,blocks});};
 const move=(id:string,delta:number)=>{if(!note)return;const blocks=[...note.blocks],index=blocks.findIndex(b=>b.id===id),target=index+delta;if(target<0||target>=blocks.length)return;[blocks[index],blocks[target]]=[blocks[target],blocks[index]];edit({...note,blocks});};
 const selectedText=()=>active&&!active.editor.isDestroyed?active.editor.state.doc.textBetween(active.editor.state.selection.from,active.editor.state.selection.to,'\n'):'';
 const compose=async()=>{const response=await run({command:'markdown',noteID:note?.id,flag:true});if(response?.text){useInputStore.getState().setPendingInputText(response.text,'append');await close();}};
 if(!status)return <div className="p-8">{error || t('common.loading')}</div>;
 return <div className="folio-workspace h-full flex flex-col bg-background text-foreground">
  <div className="flex items-center flex-wrap gap-2 border-b border-border p-3">
   <Button size="sm" variant="ghost" onClick={()=>void close()}>{t('folio.back')}</Button><span className="flex-1"/>
   {(['calendar','assistant','settings'] as const).map(kind=><Button key={kind} size="sm" variant="ghost" onClick={()=>utility(kind)}>{t(`folio.${kind}`)}</Button>)}
   <span className="text-xs text-muted-foreground" aria-live="polite">{saving || Object.keys(drafts).length?t('folio.saving'):t('folio.saved')}</span>
  </div>
  {(error||status.error)&&<div role="alert" className="p-3 border-b border-border text-destructive flex gap-3"><span className="flex-1">{error||status.error}</span><Button size="sm" variant="ghost" onClick={()=>void useFolioStore.getState().flush().catch(()=>undefined)}>{t('folio.retry')}</Button></div>}
  {(status.recording||status.transcribing||status.importing||status.listening)&&<div role="status" className="p-3 border-b border-border text-sm">{status.recordingProgress || status.importProgress || status.dictation}<Button size="sm" variant="ghost" onClick={()=>call({command:status.recording?'stop-recording':status.transcribing?'cancel-transcription':status.importing?'cancel-import':'stop-listening'})}>{t('folio.stop')}</Button></div>}
  {status.calendarPrompt&&<div className="p-3 border-b border-border flex gap-2 items-center"><span className="flex-1">{status.calendarPrompt.title}</span><Button size="sm" onClick={()=>call({command:'calendar-prepare',eventID:status.calendarPrompt?.id})}>{t('folio.meeting')}</Button><Button size="sm" variant="ghost" onClick={()=>call({command:'calendar-dismiss'})}>×</Button></div>}
  <div className="flex flex-wrap gap-2 border-b border-border px-5 py-2">
   {(['newPage','table','library','meeting','chat'] as const).map(kind=><Button key={kind} size="sm" variant="ghost" onClick={()=>call({command:'create',kind:kind==='newPage'?'note':kind})}>{t(`folio.${kind}`)}</Button>)}
   <details className="relative"><summary className="cursor-pointer text-sm py-2">{t('folio.import')}</summary><div className="absolute z-30 bg-background border border-border rounded-lg p-2 w-48 shadow-lg">
    {['notes','documents','ocr',...(note?.table?['csv']:[])].map(kind=><Button key={kind} className="w-full justify-start" size="sm" variant="ghost" onClick={()=>call({command:'import',kind,flag:kind==='ocr'})}>{kind==='notes'?t('folio.pages'):kind==='documents'?t('folio.attach'):kind.toUpperCase()}</Button>)}
   </div></details>
   <details className="relative"><summary className="cursor-pointer text-sm py-2">{t('folio.export')}</summary><div className="absolute z-30 bg-background border border-border rounded-lg p-2 w-48 shadow-lg">{['md','txt','pdf',...(note?.table?['csv']:[])].map(kind=><Button key={kind} className="w-full justify-start" size="sm" variant="ghost" onClick={()=>call({command:'export',kind})}>{kind.toUpperCase()}</Button>)}<Button className="w-full" size="sm" variant="ghost" onClick={()=>call({command:'export-library'})}>{t('folio.allPages')}</Button></div></details>
  </div>
  {note&&<>
   <div className="flex flex-wrap gap-1 px-5 py-2 border-b border-border">
    <Button size="sm" variant="ghost" onClick={()=>call({command:'read',text:selectedText() || undefined})}>{t('folio.read')}</Button>
    {status.speaking&&<><Button size="sm" variant="ghost" onClick={()=>call({command:'pause-reading'})}>{t('folio.pause')}</Button><Button size="sm" variant="ghost" onClick={()=>call({command:'stop-reading'})}>{t('folio.stop')}</Button></>}
    <Button size="sm" variant="ghost" aria-pressed={status.listening} onClick={()=>call({command:status.listening?'stop-listening':'listen'})}>{t('folio.dictate')}</Button>
    <Button size="sm" variant="ghost" onClick={()=>utility('meeting')}>{t('folio.recordings')}</Button>
    <Button size="sm" variant="ghost" onClick={()=>call({command:'attach'})}>{t('folio.attach')}</Button>
    <Button size="sm" variant="ghost" onClick={()=>utility('history')}>{t('folio.history')}</Button>
    <Button size="sm" variant="ghost" disabled={note.excludedFromAI} onClick={()=>void compose()}>OpenChamber ↗</Button>
   </div>
   <div className="flex flex-wrap items-center gap-1 px-5 py-2 border-b border-border" onMouseDown={e=>{if(e.target instanceof HTMLElement && e.target.closest('button'))e.preventDefault();}}>
    {(['bold','italic','underline','strike','code'] as const).map(format=><Button key={format} size="sm" variant="ghost" disabled={!active||active.editor.isDestroyed} onClick={()=>active?.editor.chain().focus().toggleMark(format).run()}>{t(`folio.${format}`)}</Button>)}
    <Button size="sm" variant="ghost" disabled={!active} onClick={()=>setLinkOpen(!linkOpen)}>{t('folio.link')}</Button>
    <span className="text-xs text-muted-foreground pl-2">{t('folio.textColor')}</span><Swatches kind="textColor" label={colorLabel('textColor')} onPick={color=>paint('textColor',color)}/>
    <span className="text-xs text-muted-foreground pl-2">{t('folio.highlight')}</span><Swatches kind="highlight" label={colorLabel('highlight')} onPick={color=>paint('highlight',color)}/>
    {linkOpen&&<form className="flex gap-1" onSubmit={e=>{e.preventDefault();if(/^https?:\/\//i.test(link))active?.editor.chain().focus().setLink({href:link}).run();else if(!link)active?.editor.chain().focus().unsetLink().run();setLinkOpen(false);}}><input className={field} aria-label={t('folio.link')} placeholder="https://" value={link} onChange={e=>setLink(e.target.value)}/><Button size="sm" type="submit">✓</Button></form>}
   </div>
   <div className="overflow-auto flex-1 min-h-0 px-8 py-7" onScroll={()=>setBubble(undefined)}><article className="max-w-5xl mx-auto" style={{fontSize:status.fontSize}}>
    <div className="flex gap-3 mb-5"><details className="relative"><summary className="text-3xl cursor-pointer list-none" aria-label={t('folio.icon')}><FolioIcon value={note.icon}/></summary><div className="absolute z-30 bg-background border border-border rounded-lg p-3 w-72"><div className="grid grid-cols-8 gap-1">{Object.entries(folioSymbols).map(([name,symbol])=><Button key={name} size="sm" variant="ghost" className="p-0" onClick={()=>edit({...note,icon:name})}>{symbol}</Button>)}</div><input className={field+' w-full mt-2'} aria-label={t('folio.icon')} value={note.icon} onChange={e=>edit({...note,icon:e.target.value})}/></div></details><input aria-label={t('folio.title')} placeholder={t('folio.newPage')} className="bg-transparent outline-none text-3xl font-semibold w-full" value={note.title} onChange={e=>edit({...note,title:e.target.value})}/></div>
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mb-6">
     <label>{t('folio.tags')} <input className={field} value={note.tags.join(', ')} onChange={e=>edit({...note,tags:e.target.value.split(',').map(s=>s.trim())})}/></label>
     <label>{t('folio.parent')} <select className={dropdownTriggerVariants({size:'sm'})} value={note.parentID || ''} onChange={e=>edit({...note,parentID:e.target.value || undefined})}><option value="">{t('folio.root')}</option>{status.notes.filter(n=>!isDescendant(n.id)&&!n.trashed).map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
     <label><input type="checkbox" checked={note.favorite} onChange={e=>edit({...note,favorite:e.target.checked})}/> {t('folio.favorite')}</label>
     <label><input type="checkbox" checked={note.excludedFromAI} onChange={e=>edit({...note,excludedFromAI:e.target.checked})}/> {t('folio.private')}</label>
    </div>
    {note.table&&<FolioDatabase table={note.table} onChange={table=>edit({...note,table})}/>}
    {note.blocks.map((block,index)=>{
     if(hidden.has(block.id))return null;
     const toggled=block.checked,isToggle=block.kind.startsWith('toggle');
     return <div key={block.id} className="folio-block group relative py-1 flex gap-2" data-kind={block.kind} data-checked={block.checked} style={{backgroundColor:block.highlight==='none'?undefined:`color-mix(in srgb, ${folioColors[block.highlight]} ${status.highlightStrength*100}%, transparent)`}}>
      <details className="shrink-0 text-xs" open={blockMenuID===block.id} onToggle={event=>{if(event.currentTarget.open)setBlockMenuID(block.id);else if(blockMenuID===block.id)setBlockMenuID(undefined);}}><summary className="cursor-pointer text-muted-foreground py-1.5 list-none" aria-label={t('folio.block')}>⋮⋮</summary><div className="absolute left-0 top-9 z-20 bg-background border border-border rounded-lg p-2 shadow-lg w-52 space-y-1">
       <select aria-label={t('folio.block')} className={dropdownTriggerVariants({size:'sm'})+' w-full'} value={block.kind} onChange={e=>{const parsed=blockKindSchema.safeParse(e.target.value);if(parsed.success)updateBlock({...block,kind:parsed.data});}}>{blockKinds.map(kind=><option key={kind} value={kind}>{t(`folio.block.${kind}`)}</option>)}</select>
       <div className="text-xs text-muted-foreground">{t('folio.highlight')}</div><Swatches compact kind="highlight" label={colorLabel('highlight')} onPick={color=>updateBlock({...block,highlight:color})}/>
       <div className="flex"><Button size="sm" variant="ghost" aria-label={t('folio.up')} onClick={()=>move(block.id,-1)}>↑</Button><Button size="sm" variant="ghost" aria-label={t('folio.down')} onClick={()=>move(block.id,1)}>↓</Button><Button size="sm" variant="ghost" aria-label={t('folio.newBlock')} onClick={()=>addBlock(block.id)}>+</Button><Button size="sm" variant="ghost" aria-label={t('folio.remove')} onClick={()=>edit({...note,blocks:note.blocks.filter(b=>b.id!==block.id)})}>×</Button></div>
      </div></details>
      {block.kind==='task'&&<input className="mt-2 self-start" type="checkbox" checked={block.checked} aria-label={t('folio.block')} onChange={e=>updateBlock({...block,checked:e.target.checked})}/>}
      {block.kind==='bullet'&&<span>•</span>}{block.kind==='numbered'&&<span>{index+1}.</span>}
      {isToggle&&<Button size="sm" variant="ghost" className="px-1 h-7" aria-expanded={!toggled} aria-label={t('folio.open')} onClick={()=>updateBlock({...block,checked:!block.checked})}>{toggled?'▸':'▾'}</Button>}
      {block.kind==='divider'?<hr className="my-4 flex-1 border-border"/>:block.kind==='attachment'?<Button variant="outline" onClick={()=>call({command:'open-attachment',blockID:block.id})}>{block.text || t('folio.attach')}</Button>:<div className="min-w-0 flex-1"><FolioRichBlock onMenu={()=>setBlockMenuID(block.id)} block={block} autoFocus={focusBlock===block.id} onChange={updateBlock} onFocus={editor=>trackSelection(editor,block.id)} onBlur={()=>setBubble(undefined)} onSplit={(before,after)=>{
       const current=latestNote();if(!current)return;const position=current.blocks.findIndex(b=>b.id===block.id);if(position<0)return;const original=current.blocks[position];
       const next={...makeBlock(),...after,kind:(['bullet','numbered','task'].includes(original.kind)?original.kind:'text')};
       const parsed=blockKindSchema.parse(next.kind);const newBlock={...next,kind:parsed};
       const blocks=[...current.blocks];blocks.splice(position,1,{...original,...before},newBlock);setFocusBlock(newBlock.id);edit({...current,blocks});
      }}/>
{(block.kind==='page'||block.kind==='pageIn')&&<select className={dropdownTriggerVariants({size:'sm'})} aria-label={t('folio.pages')} value={block.asset || ''} onChange={e=>updateBlock({...block,asset:e.target.value})}><option value="">—</option>{status.notes.filter(n=>!n.trashed).map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</select>}{(block.kind==='page'||block.kind==='pageIn')&&block.asset&&<Button size="sm" variant="link" onClick={()=>call({command:'select',noteID:block.asset})}>{t('folio.open')}</Button>}</div>}
     </div>;
    })}
    <Button className="mt-3" size="sm" variant="ghost" onClick={()=>addBlock()}>+ {t('folio.newBlock')}</Button>
    <div className="mt-12 pt-4 border-t border-border flex gap-2"><Button size="sm" variant="ghost" onClick={()=>call({command:'duplicate'})}>{t('folio.duplicate')}</Button><Button size="sm" variant="ghost" onClick={()=>call({command:'trash',flag:note.trashed})}>{t(note.trashed?'folio.restore':'folio.trash')}</Button></div>
   </article></div>
   {bubble&&active&&!active.editor.isDestroyed&&<div ref={bubbleRef} role="toolbar" aria-label={t('folio.block')} className="fixed z-50 flex flex-col gap-1.5 rounded-xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur" style={{top:bubble.top,left:bubble.left,width:420}} onMouseDown={e=>e.preventDefault()}>
    <div className="flex items-center gap-0.5">
     {([['bold','B','font-bold'],['italic','I','italic'],['underline','U','underline'],['strike','S','line-through'],['code','</>','font-mono']] as const).map(([format,glyph,style])=><Button key={format} size="sm" variant={active.editor.isActive(format)?'secondary':'ghost'} className={'h-7 px-2 '+style} title={t(`folio.${format}`)} aria-label={t(`folio.${format}`)} onClick={()=>active.editor.chain().focus().toggleMark(format).run()}>{glyph}</Button>)}
     <Button size="sm" variant="ghost" className="h-7 px-2" onClick={()=>setLinkOpen(true)}>{t('folio.link')}</Button>
    </div>
    <div className="flex items-center gap-2"><span className="w-16 text-[11px] text-muted-foreground">{t('folio.textColor')}</span><Swatches compact kind="textColor" label={colorLabel('textColor')} onPick={color=>paint('textColor',color)}/></div>
    <div className="flex items-center gap-2"><span className="w-16 text-[11px] text-muted-foreground">{t('folio.highlight')}</span><Swatches compact kind="highlight" label={colorLabel('highlight')} onPick={color=>paint('highlight',color)}/></div>
   </div>}
  </>}
 </div>;
}
