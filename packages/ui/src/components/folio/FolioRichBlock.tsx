import React from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import type { FolioBlock } from '@/lib/folio/schema';
import { blockToDocument, documentToText } from '@/lib/folio/rich-text';

export function FolioRichBlock({block,onChange,onFocus,onSplit,autoFocus,onMenu}:{block:FolioBlock;onChange:(block:FolioBlock)=>void;onFocus:(editor:Editor)=>void;onSplit:(before:Pick<FolioBlock,'text'|'marks'>,after:Pick<FolioBlock,'text'|'marks'>)=>void;autoFocus?:boolean;onMenu:()=>void}) {
  const mount=React.useRef<HTMLDivElement>(null);
  const current=React.useRef({block,onChange,onFocus,onSplit,autoFocus,onMenu});current.current={block,onChange,onFocus,onSplit,autoFocus,onMenu};
  const editorRef=React.useRef<Editor | null>(null);
  React.useEffect(()=>{
    if(!mount.current)return;
    const editor=new Editor({element:mount.current,extensions:[StarterKit.configure({heading:false,bulletList:false,orderedList:false,listItem:false,listKeymap:false,blockquote:false,codeBlock:false,horizontalRule:false,link:{openOnClick:false}}),Highlight.configure({multicolor:true}),TextStyle,Color],content:blockToDocument(current.current.block),
      editorProps:{handleKeyDown:(view,event)=>{
        if(event.key==='/' && view.state.selection.$from.parentOffset===0){event.preventDefault();current.current.onMenu();return true;}
        if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){
          event.preventDefault();
          const {from,to}=view.state.selection;
          current.current.onSplit(documentToText(view.state.doc.cut(0,from).toJSON()),documentToText(view.state.doc.cut(to).toJSON()));
          return true;
        }
        return false;
      },attributes:{class:'folio-rich-text outline-none min-h-7',role:'textbox','aria-multiline':'true'}},
      onFocus:({editor})=>current.current.onFocus(editor),
      onSelectionUpdate:({editor})=>current.current.onFocus(editor),
      onUpdate:({editor})=>current.current.onChange({...current.current.block,...documentToText(editor.getJSON())}),
    });
    editorRef.current=editor;if(current.current.autoFocus)editor.commands.focus('start');return()=>{editorRef.current=null;editor.destroy();};
  },[]);
  React.useEffect(()=>{
    const editor=editorRef.current;if(!editor)return;
    const rendered=documentToText(editor.getJSON()),expected=documentToText(blockToDocument(block));
    if(rendered.text!==expected.text || JSON.stringify(rendered.marks)!==JSON.stringify(expected.marks)) editor.commands.setContent(blockToDocument(block),{emitUpdate:false});
  },[block]);
  return <div ref={mount} className="min-w-0 flex-1" />;
}
