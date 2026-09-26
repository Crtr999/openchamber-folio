import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import type { FolioBlock } from './schema';
interface FolioPalette { [name: string]: string }
export const folioColors: FolioPalette = { gray:'#A8B0AC',brown:'#BD8A62',orange:'#FF8F4D',yellow:'#FFCC45',green:'#7DD69E',blue:'#6EB8FF',purple:'#B38AFF',pink:'#F78CBE',red:'#FF6E71' };
function toMark(mark: NonNullable<FolioBlock['marks']>[number]): NonNullable<JSONContent['marks']>[number] {
  if (mark.style === 'color') return { type:'textStyle',attrs:{color:folioColors[mark.value || ''] || mark.value} };
  if (mark.style === 'highlight') return {type:'highlight',attrs:{color:folioColors[mark.value || ''] || mark.value}};
  if (mark.style === 'link') return {type:'link',attrs:{href:mark.value}};
  return {type:mark.style};
}
function legacyInline(source: string): Pick<FolioBlock,'text'|'marks'> {
  const marks: NonNullable<FolioBlock['marks']>=[];let text='',cursor=0;
  const pattern=/(\*\*|==|::|~~|`|\*)([^\n]+?)\1|\[([^\]]+)\]\(((?:https?:\/\/|mailto:|folio:)[^\s)]+)\)/g;
  for(const match of source.matchAll(pattern)) {
    text+=source.slice(cursor,match.index);const start=text.length;
    const delimiter=match[1],inner=match[2] ?? match[3];
    const nested=delimiter==='`'?{text:inner,marks:[]}:legacyInline(inner);
    text+=nested.text;
    marks.push(...(nested.marks || []).map(mark=>({...mark,start:mark.start+start})));
    const style=delimiter==='**'?'bold':delimiter==='*'?'italic':delimiter==='~~'?'strike':delimiter==='`'?'code':delimiter?'highlight':'link';
    const mark: NonNullable<FolioBlock['marks']>[number]={start,length:nested.text.length,style};
    if(style==='highlight')mark.value='yellow';if(style==='link')mark.value=match[4];marks.push(mark);
    cursor=match.index+match[0].length;
  }
  text+=source.slice(cursor);return {text,marks};
}
export function blockToDocument(original: FolioBlock): JSONContent {
  const block=original.marks===undefined&&original.kind!=='code'?{...original,...legacyInline(original.text)}:original;
  const boundaries = new Set([0,block.text.length]);
  for (const mark of block.marks || []) {boundaries.add(mark.start);boundaries.add(mark.start+mark.length);}
  const points=[...boundaries].filter(n=>n>=0 && n<=block.text.length).sort((a,b)=>a-b);
  const content: JSONContent[]=[];
  for (let i=0;i<points.length-1;i++) {
    const start=points[i],end=points[i+1];
    const marks=(block.marks || []).filter(mark=>mark.start<=start && mark.start+mark.length>=end).map(toMark);
    const parts=block.text.slice(start,end).split('\n');
    parts.forEach((text,index)=>{if(index)content.push({type:'hardBreak'});if(text)content.push({type:'text',text,marks});});
  }
  return {type:'doc',content:[{type:'paragraph',content}]};
}
export function documentToText(doc: JSONContent): Pick<FolioBlock,'text'|'marks'> {
  let text='';const marks: NonNullable<FolioBlock['marks']>=[];
  function walk(node: JSONContent) {
    if(node.type==='hardBreak'){text+='\n';return;}
    if(node.text) {
      const start=text.length;text+=node.text;
      for(const mark of node.marks || []) {
        const kind=mark.type;
        const style=kind==='textStyle'?'color':kind;
        if(style!=='bold' && style!=='italic' && style!=='underline' && style!=='strike' && style!=='code' && style!=='highlight' && style!=='color' && style!=='link')continue;
        const raw=style==='link'?mark.attrs?.href:mark.attrs?.color;
        const parsed=z.string().safeParse(raw);
        const value=parsed.success?(Object.entries(folioColors).find(([,hex])=>hex.toLowerCase()===parsed.data.toLowerCase())?.[0] || parsed.data):undefined;
        const next: NonNullable<FolioBlock['marks']>[number]={start,length:node.text.length,style};
        if(value)next.value=value;
        marks.push(next);
      }
    }
    node.content?.forEach((child,index)=>{if(node.type==='doc' && index)text+='\n';walk(child);});
  }
  walk(doc);return {text,marks};
}
