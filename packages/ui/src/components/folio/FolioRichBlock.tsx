import React from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import type { FolioBlock } from '@/lib/folio/schema';
import { blockToDocument, documentToText } from '@/lib/folio/rich-text';

export type FocusAt = 'start' | 'end';
export interface SlashState { blockID: string; query: string; left: number; top: number; bottom: number }

// Typed at the start of a block, then Space: the same shortcuts Notion uses.
const markdownShortcuts = new Map<string, FolioBlock['kind']>([
  ['#', 'heading1'], ['##', 'heading2'], ['###', 'heading3'], ['####', 'heading4'], ['-', 'bullet'], ['*', 'bullet'], ['+', 'bullet'], ['1.', 'numbered'], ['[]', 'task'], ['[ ]', 'task'], ['>', 'toggle'], ['"', 'quote'], ['```', 'code'], ['$$', 'equation'], ['!', 'callout'],
]);

interface FolioRichBlockProps {
  block: FolioBlock;
  placeholder?: string;
  focusAt?: FocusAt;
  onChange: (block: FolioBlock) => void;
  onFocus: (editor: Editor) => void;
  onBlur: (editor: Editor) => void;
  onSplit: (before: Pick<FolioBlock, 'text' | 'marks'>, after: Pick<FolioBlock, 'text' | 'marks'>) => void;
  onKind: (kind: FolioBlock['kind']) => void;
  onRemoveEmpty: () => void;
  onSlash: (state: SlashState | null) => void;
  onSlashKey: (key: string) => boolean;
}

// Callbacks are read through a ref and must look up the latest page themselves, so a block re-renders only when its own content changes.
export const FolioRichBlock = React.memo(FolioRichBlockInner, (previous, next) => previous.block === next.block && previous.focusAt === next.focusAt && previous.placeholder === next.placeholder);

function FolioRichBlockInner(props: FolioRichBlockProps) {
  const mount = React.useRef<HTMLDivElement>(null);
  const current = React.useRef(props); current.current = props;
  const editorRef = React.useRef<Editor | null>(null);
  const slashOpen = React.useRef(false);

  React.useEffect(() => {
    if (!mount.current) return;
    const reportSlash = (editor: Editor) => {
      const text = editor.getText();
      const { from, empty } = editor.state.selection;
      const match = /^\/([^\s/]{0,24})$/.exec(text);
      if (match && empty && from === editor.state.doc.content.size - 1) {
        const at = editor.view.coordsAtPos(from);
        slashOpen.current = true;
        current.current.onSlash({ blockID: current.current.block.id, query: match[1], left: at.left, top: at.top, bottom: at.bottom });
      } else if (slashOpen.current) {
        slashOpen.current = false;
        current.current.onSlash(null);
      }
    };
    const editor = new Editor({
      element: mount.current,
      extensions: [StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, blockquote: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false } }), Highlight.configure({ multicolor: true }), TextStyle, Color],
      content: blockToDocument(current.current.block),
      editorProps: {
        handleKeyDown: (view, event) => {
          if (slashOpen.current && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key) && current.current.onSlashKey(event.key)) {
            event.preventDefault();
            return true;
          }
          const { from, to, empty } = view.state.selection;
          const atStart = empty && from <= 1;
          if (event.key === ' ' && empty) {
            const prefix = view.state.doc.textBetween(1, from, '\n');
            const kind = markdownShortcuts.get(prefix);
            if (kind && current.current.block.kind === 'text') {
              event.preventDefault();
              editorRef.current?.chain().deleteRange({ from: 1, to: from }).run();
              current.current.onKind(kind);
              return true;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            if (view.state.doc.textContent === '---') { editorRef.current?.commands.clearContent(true); current.current.onKind('divider'); return true; }
            // Enter on an empty list item ends the list, like Notion.
            if (!view.state.doc.textContent && current.current.block.kind !== 'text') { current.current.onKind('text'); return true; }
            current.current.onSplit(documentToText(view.state.doc.cut(0, from).toJSON()), documentToText(view.state.doc.cut(to).toJSON()));
            return true;
          }
          if (event.key === 'Backspace' && atStart) {
            if (current.current.block.kind !== 'text') { event.preventDefault(); current.current.onKind('text'); return true; }
            if (!view.state.doc.textContent) { event.preventDefault(); current.current.onRemoveEmpty(); return true; }
          }
          return false;
        },
        attributes: { class: 'folio-rich-text outline-none min-h-[1.65em]', role: 'textbox', 'aria-multiline': 'true' },
      },
      onFocus: ({ editor }) => current.current.onFocus(editor),
      onSelectionUpdate: ({ editor }) => current.current.onFocus(editor),
      onBlur: ({ editor }) => {
        current.current.onBlur(editor);
        if (slashOpen.current) { slashOpen.current = false; setTimeout(() => current.current.onSlash(null), 150); }
      },
      onUpdate: ({ editor }) => {
        current.current.onChange({ ...current.current.block, ...documentToText(editor.getJSON()) });
        reportSlash(editor);
      },
    });
    editorRef.current = editor;
    if (current.current.focusAt) editor.commands.focus(current.current.focusAt);
    return () => { editorRef.current = null; editor.destroy(); };
  }, []);

  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.focusAt || editor.isFocused) return;
    editor.commands.focus(props.focusAt);
  }, [props.focusAt]);

  React.useEffect(() => {
    const editor = editorRef.current; if (!editor) return;
    const rendered = documentToText(editor.getJSON()), expected = documentToText(blockToDocument(props.block));
    if (rendered.text !== expected.text || JSON.stringify(rendered.marks) !== JSON.stringify(expected.marks)) editor.commands.setContent(blockToDocument(props.block), { emitUpdate: false });
  }, [props.block]);

  React.useEffect(() => {
    if (props.placeholder) mount.current?.style.setProperty('--folio-placeholder', JSON.stringify(props.placeholder));
    else mount.current?.style.removeProperty('--folio-placeholder');
  }, [props.placeholder]);

  return <div ref={mount} className="folio-editable min-w-0 flex-1" />;
}
