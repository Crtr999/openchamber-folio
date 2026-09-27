import React from 'react';
import { flushSync } from 'react-dom';
import { Editor, createDocument, getHTMLFromFragment, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import type { FolioBlock } from '@/lib/folio/schema';
import { blockToDocument, documentToText } from '@/lib/folio/rich-text';
import { registerPendingEdit } from '@/lib/folio/store';

export type FocusAt = 'start' | 'end';
export interface SlashState { blockID: string; query: string; left: number; top: number; bottom: number }
/** An "@page" being typed; `from` is where the @ sits in the block's document. */
export interface MentionState extends SlashState { from: number }
export const folioNoteLinkPrefix = 'folio://note/';

// Typed at the start of a block, then Space: the same shortcuts Notion uses.
const markdownShortcuts = new Map<string, FolioBlock['kind']>([
  ['#', 'heading1'], ['##', 'heading2'], ['###', 'heading3'], ['####', 'heading4'], ['-', 'bullet'], ['*', 'bullet'], ['+', 'bullet'], ['1.', 'numbered'], ['[]', 'task'], ['[ ]', 'task'], ['>', 'toggle'], ['"', 'quote'], ['```', 'code'], ['$$', 'equation'], ['!', 'callout'],
]);

const folioExtensions = () => [StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, blockquote: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, protocols: ['folio'] } }), Highlight.configure({ multicolor: true }), TextStyle, Color];
let staticSchema: ReturnType<typeof getSchema> | undefined;
const editorClass = 'folio-rich-text outline-none min-h-[1.65em]';
/** The block drawn exactly as its editor would draw it, without an editor. */
function staticHTML(block: FolioBlock): string {
  staticSchema ??= getSchema(folioExtensions());
  const html = getHTMLFromFragment(createDocument(blockToDocument(block), staticSchema).content, staticSchema);
  return `<div class="${editorClass}">${html}</div>`;
}

/**
 * Puts the caret in the block right now. TipTap's own focus waits a frame, and keys typed in that
 * frame (fast typing straight after Enter) would still land in the previous line.
 */
function focusNow(editor: Editor, at: FocusAt | number) {
  const size = editor.state.doc.content.size;
  const pos = typeof at === 'number' ? at : at === 'start' ? 1 : Math.max(1, size - 1);
  editor.commands.setTextSelection(Math.min(Math.max(1, pos), Math.max(1, size - 1)));
  editor.view.focus();
  editor.commands.scrollIntoView();
}

interface FolioRichBlockProps {
  block: FolioBlock;
  placeholder?: string;
  focusAt?: FocusAt;
  /** Milliseconds to batch typing before `onChange` (0: every keystroke). Pending typing is flushed by `flushPendingEdits`. */
  commitDelay?: number;
  /**
   * Draw the block as plain HTML and start its editor only when it is tapped or focused. Every
   * editor listens to every selection change on the page, so a long page full of editors makes
   * each keystroke do work for all of them; this keeps it to the few blocks actually being edited.
   */
  lazy?: boolean;
  onChange: (block: FolioBlock) => void;
  onFocus: (editor: Editor) => void;
  onBlur: (editor: Editor) => void;
  onSplit: (before: Pick<FolioBlock, 'text' | 'marks'>, after: Pick<FolioBlock, 'text' | 'marks'>) => void;
  onKind: (kind: FolioBlock['kind']) => void;
  onRemoveEmpty: () => void;
  onSlash: (state: SlashState | null) => void;
  onSlashKey: (key: string) => boolean;
  onMention?: (state: MentionState | null) => void;
  onOpenNote?: (noteID: string) => void;
}

// Callbacks are read through a ref and must look up the latest page themselves, so a block re-renders only when its own content changes.
export const FolioRichBlock = React.memo(FolioRichBlockInner, (previous, next) => previous.block === next.block && previous.focusAt === next.focusAt && previous.placeholder === next.placeholder && previous.commitDelay === next.commitDelay && previous.lazy === next.lazy);

function FolioRichBlockInner(props: FolioRichBlockProps) {
  const mount = React.useRef<HTMLDivElement>(null);
  const current = React.useRef(props); current.current = props;
  const editorRef = React.useRef<Editor | null>(null);
  const slashOpen = React.useRef(false);
  const mentionOpen = React.useRef(false);
  // Typing not yet handed to onChange (only when commitDelay batches keystrokes).
  const pending = React.useRef<{ timer: ReturnType<typeof setTimeout>; unregister: () => void } | null>(null);

  const createEditor = React.useRef<() => Editor | null>(() => null);
  // Layout effects: a line drawn by Enter gets its editor and the caret in the same frame, before the next keystroke.
  React.useLayoutEffect(() => {
    if (!mount.current) return;
    const commitNow = () => {
      const waiting = pending.current;
      if (!waiting) return;
      pending.current = null;
      clearTimeout(waiting.timer);
      waiting.unregister();
      const live = editorRef.current;
      if (live && !live.isDestroyed) current.current.onChange({ ...current.current.block, ...documentToText(live.getJSON()) });
    };
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
    const reportMention = (editor: Editor) => {
      const { from, empty } = editor.state.selection;
      const before = empty ? editor.state.doc.textBetween(Math.max(1, from - 40), from, '\n') : '';
      const match = /(?:^|\s)@([^\s@]{0,30})$/.exec(before);
      if (match && current.current.onMention) {
        const at = editor.view.coordsAtPos(from);
        mentionOpen.current = true;
        current.current.onMention({ blockID: current.current.block.id, query: match[1], left: at.left, top: at.top, bottom: at.bottom, from: from - match[1].length - 1 });
      } else if (mentionOpen.current) {
        mentionOpen.current = false;
        current.current.onMention?.(null);
      }
    };
    createEditor.current = () => {
    if (editorRef.current) return editorRef.current;
    if (!mount.current) return null;
    mount.current.textContent = '';
    const editor = new Editor({
      element: mount.current,
      extensions: folioExtensions(),
      content: blockToDocument(current.current.block),
      editorProps: {
        handleKeyDown: (view, event) => {
          if ((slashOpen.current || mentionOpen.current) && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key) && current.current.onSlashKey(event.key)) {
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
            // ProseMirror's keydown is not a React event, so React would draw the new line (and move the
            // caret into it) a moment later, and fast typing would land in this line. Draw it now.
            const before = documentToText(view.state.doc.cut(0, from).toJSON()), after = documentToText(view.state.doc.cut(to).toJSON());
            flushSync(() => current.current.onSplit(before, after));
            return true;
          }
          // Tab and Shift+Tab nest and un-nest the block, like an outline.
          if (event.key === 'Tab' && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            const block = current.current.block;
            const depth = Math.max(0, Math.min(8, (block.indent ?? 0) + (event.shiftKey ? -1 : 1)));
            current.current.onChange({ ...block, ...documentToText(view.state.doc.toJSON()), indent: depth || undefined });
            return true;
          }
          // Backspace at the start of a nested block un-nests it first.
          if (event.key === 'Backspace' && atStart && (current.current.block.indent ?? 0) > 0) {
            event.preventDefault();
            const block = current.current.block;
            current.current.onChange({ ...block, ...documentToText(view.state.doc.toJSON()), indent: (block.indent ?? 1) - 1 || undefined });
            return true;
          }
          if (event.key === 'Backspace' && atStart) {
            if (current.current.block.kind !== 'text') { event.preventDefault(); current.current.onKind('text'); return true; }
            if (!view.state.doc.textContent) { event.preventDefault(); flushSync(() => current.current.onRemoveEmpty()); return true; }
          }
          return false;
        },
        // Links to other pages (inserted with @) open that page instead of a browser.
        handleClick: (_view, _pos, event) => {
          const link = event.target instanceof Element ? event.target.closest('a') : null;
          const href = link?.getAttribute('href') ?? '';
          if (!href.startsWith(folioNoteLinkPrefix) || !current.current.onOpenNote) return false;
          event.preventDefault();
          current.current.onOpenNote(href.slice(folioNoteLinkPrefix.length));
          return true;
        },
        attributes: { class: editorClass, role: 'textbox', 'aria-multiline': 'true' },
      },
      onFocus: ({ editor }) => current.current.onFocus(editor),
      onSelectionUpdate: ({ editor }) => current.current.onFocus(editor),
      onBlur: ({ editor }) => {
        current.current.onBlur(editor);
        if (slashOpen.current) { slashOpen.current = false; setTimeout(() => current.current.onSlash(null), 150); }
        if (mentionOpen.current) { mentionOpen.current = false; setTimeout(() => current.current.onMention?.(null), 150); }
      },
      onUpdate: ({ editor }) => {
        const delay = current.current.commitDelay ?? 0;
        if (delay > 0) {
          if (pending.current) clearTimeout(pending.current.timer);
          const unregister = pending.current?.unregister ?? registerPendingEdit(commitNow);
          pending.current = { timer: setTimeout(commitNow, delay), unregister };
        } else current.current.onChange({ ...current.current.block, ...documentToText(editor.getJSON()) });
        reportSlash(editor);
        reportMention(editor);
      },
    });
    editorRef.current = editor;
    return editor;
    };
    if (!current.current.lazy || current.current.focusAt) {
      const editor = createEditor.current();
      if (editor && current.current.focusAt) focusNow(editor, current.current.focusAt);
    } else mount.current.innerHTML = staticHTML(current.current.block);
    return () => { commitNow(); const editor = editorRef.current; editorRef.current = null; editor?.destroy(); };
  }, []);

  // A tap on a drawn block starts its editor right inside the tap (so iOS shows the keyboard),
  // with the caret where the finger landed.
  const activate = (event: React.MouseEvent) => {
    if (editorRef.current) return;
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    const href = link?.getAttribute('href') ?? '';
    if (href.startsWith(folioNoteLinkPrefix) && current.current.onOpenNote) { event.preventDefault(); current.current.onOpenNote(href.slice(folioNoteLinkPrefix.length)); return; }
    if (link) return;
    const editor = createEditor.current();
    if (!editor) return;
    const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    focusNow(editor, at ? at.pos : 'end');
  };

  React.useLayoutEffect(() => {
    if (!props.focusAt) return;
    const editor = editorRef.current ?? createEditor.current();
    if (!editor || editor.isFocused) return;
    focusNow(editor, props.focusAt);
  }, [props.focusAt]);

  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) { if (mount.current && props.lazy) mount.current.innerHTML = staticHTML(props.block); return; }
    // Typing still waiting to be handed over is newer than this block; it commits shortly.
    if (pending.current) return;
    const rendered = documentToText(editor.getJSON()), expected = documentToText(blockToDocument(props.block));
    if (rendered.text !== expected.text || JSON.stringify(rendered.marks) !== JSON.stringify(expected.marks)) editor.commands.setContent(blockToDocument(props.block), { emitUpdate: false });
  }, [props.block]);

  React.useEffect(() => {
    if (props.placeholder) mount.current?.style.setProperty('--folio-placeholder', JSON.stringify(props.placeholder));
    else mount.current?.style.removeProperty('--folio-placeholder');
  }, [props.placeholder]);

  return <div ref={mount} className="folio-editable min-w-0 flex-1" onClick={props.lazy ? activate : undefined} />;
}
