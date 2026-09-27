import React from 'react';
import type { Editor } from '@tiptap/core';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { flushPendingEdits, useFolioStore } from '@/lib/folio/store';
import { blockKinds, colorNames, makeBlock, type FolioBlock, type FolioNote, type FolioRequest } from '@/lib/folio/schema';
import { folioColors } from '@/lib/folio/rich-text';
import { useInputStore } from '@/sync/input-store';
import { FolioDatabase } from './FolioDatabase';
import { FolioIcon } from './FolioIcon';
import { FolioIconPicker } from './FolioIconPicker';
import { FolioSyncDialog } from './FolioSyncDialog';
import { FolioRichBlock, folioNoteLinkPrefix, type FocusAt, type MentionState, type SlashState } from './FolioRichBlock';
import './folio.css';
import { FolioReader } from './FolioReader';
import { FolioAskPanel } from './FolioAskPanel';
import { FolioHabits } from './FolioHabits';
import { sortSiblings } from '@/lib/folio/order';
import { noteToMarkdown } from '@/lib/folio/local-engine';
import { useHandoffStore } from '@/lib/folio/handoff';
import { folioSyncCommand, reportFolioFocus } from '@/lib/desktop';

type ColorName = typeof colorNames[number];
/** On the phone, keystrokes reach the store (and redraw the page around the block) once typing pauses. */
const MOBILE_COMMIT_DELAY = 300;
type Paint = 'textColor' | 'highlight';
type BlockKind = FolioBlock['kind'];
type SlashCommand = { id: string; glyph?: string; kind?: BlockKind; database?: 'board' | 'table' | 'library'; label: string; icon: IconName; keys: string[]; group: 'basic' | 'databases' };

const menuItem = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover disabled:opacity-40';
const quiet = 'rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-interactive-hover hover:text-foreground';
const tool = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40';
// Pulses blue while running, like the chat mic; clicking again stops it.
const toolLive = 'animate-pulse bg-[color-mix(in_srgb,var(--status-info)_16%,transparent)] text-[var(--status-info)] hover:text-[var(--status-info)]';

/** Shows each color itself, not just its name. Keeps the text selection while clicking. */
function Swatches({ kind, label, onPick, compact }: { kind: Paint; label: (color: ColorName) => string; onPick: (color: ColorName) => void; compact?: boolean }) {
  return <div className="flex items-center gap-1" role="group">{colorNames.map((color) => {
    const hex = color === 'none' ? undefined : folioColors[color];
    return <button key={color} type="button" title={label(color)} aria-label={label(color)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(color)}
      className={cn(compact ? 'size-5' : 'size-6', 'flex shrink-0 items-center justify-center rounded-full border border-border/70 text-[11px] font-bold leading-none transition-transform hover:scale-110')}
      style={kind === 'highlight' ? { background: hex ?? 'transparent' } : { color: hex ?? 'currentColor' }}>
      {kind === 'textColor' ? 'A' : color === 'none' ? '⊘' : null}
    </button>;
  })}</div>;
}

function latestNote(): FolioNote | undefined {
  flushPendingEdits();
  const s = useFolioStore.getState();
  const base = s.status?.notes.find((n) => n.id === s.status?.selectedID);
  return base && (s.drafts[base.id]?.note || base);
}
function noteByID(id: string): FolioNote | undefined {
  flushPendingEdits();
  const s = useFolioStore.getState();
  return s.drafts[id]?.note ?? s.status?.notes.find((n) => n.id === id);
}

const blockIcons = new Map<BlockKind, IconName>([
  ['text', 'text'], ['bullet', 'list-unordered'], ['numbered', 'list-indefinite'], ['task', 'checkbox'], ['toggle', 'arrow-right-s'], ['quote', 'double-quotes-l'], ['callout', 'lightbulb'], ['code', 'code'], ['equation', 'code'], ['divider', 'subtract'], ['page', 'file-text'],
]);
const blockAliases = new Map<BlockKind, string[]>([
  ['text', ['text', 'paragraph', 'p']], ['heading1', ['h1', 'heading1', 'title']], ['heading2', ['h2', 'heading2']], ['heading3', ['h3', 'heading3']], ['heading4', ['h4', 'heading4']], ['toggleHeading1', ['toggleh1', 'th1']], ['toggleHeading2', ['toggleh2', 'th2']], ['toggleHeading3', ['toggleh3', 'th3']], ['bullet', ['bullet', 'list', 'ul', '-']], ['numbered', ['numbered', 'ol', 'number', '1.']], ['task', ['todo', 'task', 'check', 'checkbox', '[]']], ['toggle', ['toggle', 'collapse', '>']], ['quote', ['quote', 'blockquote', '"']], ['callout', ['callout', 'note', 'tip']], ['code', ['code', 'snippet']], ['equation', ['equation', 'math', 'latex']], ['divider', ['divider', 'hr', 'line', '---']], ['page', ['page', 'link', 'subpage']],
]);

/** Phone layout hooks: the standalone iPhone app has a menu instead of "Back to chat", and its own chat. */
export interface FolioMobileHooks {
  onMenu: () => void;
  onAddToChat: (markdown: string, noteID: string) => void;
  /** iOS opens file pickers and share sheets only inside the tap, so these run synchronously from the click. */
  onAttach: (noteID: string) => void;
  onImport: () => void;
  onExport: (note: FolioNote, kind: string) => void;
  onExportLibrary: () => void;
  /** Summarizes the page with the phone's chat model and appends the summary. */
  onSummarize: (note: FolioNote) => void;
}

/** The Mac engine writes seconds since 2001; the iPhone engine writes milliseconds since 1970. */
const folioDate = (value: number) => new Date(value > 1e11 ? value : (value + 978_307_200) * 1000);

/** On the Mac home: the page the iPhone last had open (and the passage, if reading), one click to continue. */
function ContinueFromPhone({ notes, onOpen }: { notes: readonly FolioNote[]; onOpen: (id: string, blockID: string | undefined, reading: boolean) => void }) {
  const { t } = useI18n();
  const [focus, setFocus] = React.useState<{ noteID: string; blockID?: string; reading: boolean; at: number }>();
  React.useEffect(() => { void folioSyncCommand('status').then((status) => setFocus(status?.phoneFocus)).catch(() => undefined); }, []);
  const note = focus ? notes.find((n) => n.id.toUpperCase() === focus.noteID && !n.trashed) : undefined;
  if (!focus || !note || Date.now() - focus.at > 3 * 86_400_000) return null;
  return <button type="button" className="mb-8 flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left hover:bg-interactive-hover" onClick={() => onOpen(note.id, focus.blockID, focus.reading)}>
    <Icon name="smartphone" className="size-5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{focus.reading ? t('folio.continueReadingFromPhone') : t('folio.continueFromPhone')}</span><span className="block truncate text-sm font-medium">{note.title || t('folio.untitled')}</span></span>
    <Icon name="arrow-right-s" className="size-4 text-muted-foreground" />
  </button>;
}

export function FolioWorkspace({ mobile }: { mobile?: FolioMobileHooks } = {}) {
  const { t } = useI18n();
  const status = useFolioStore((s) => s.status);
  const drafts = useFolioStore((s) => s.drafts);
  const saving = useFolioStore((s) => s.saving);
  const error = useFolioStore((s) => s.error);
  const home = useFolioStore((s) => s.home);
  const found = useFolioStore((s) => s.found);
  const articleRef = React.useRef<HTMLElement>(null);
  // The title grows with its text; measuring forces a layout of the page, so only when the title changes.
  const titleRef = React.useRef<HTMLTextAreaElement>(null);
  // Dragging across blocks selects whole blocks, like Notion: then Delete removes them and ⌘C copies them.
  const [blockRange, setBlockRange] = React.useState<{ anchor: number; focus: number }>();
  const rangeStart = React.useRef<{ index: number; x: number; y: number } | undefined>(undefined);
  const blockIndexAt = (x: number, y: number): number | undefined => {
    const current = note; if (!current) return undefined;
    const hit = document.elementFromPoint(x, y)?.closest('[data-block-id]')?.getAttribute('data-block-id');
    const direct = hit ? current.blocks.findIndex((b) => b.id === hit) : -1;
    if (direct >= 0) return direct;
    // In the margin or between blocks: the nearest block by height.
    let best: number | undefined, distance = Infinity;
    articleRef.current?.querySelectorAll('[data-block-id]').forEach((element) => {
      const rect = element.getBoundingClientRect();
      const d = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const index = current.blocks.findIndex((b) => b.id === element.getAttribute('data-block-id'));
      if (index >= 0 && d < distance) { distance = d; best = index; }
    });
    return best;
  };
  const onRangePointerDown = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || mobile) return;
    if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a')) return;
    const index = blockIndexAt(event.clientX, event.clientY);
    rangeStart.current = index === undefined ? undefined : { index, x: event.clientX, y: event.clientY };
    if (blockRange) setBlockRange(undefined);
  };
  const onRangePointerMove = (event: React.PointerEvent) => {
    const start = rangeStart.current;
    if (!start || !(event.buttons & 1)) return;
    const index = blockIndexAt(event.clientX, event.clientY);
    if (index === undefined || (index === start.index && !blockRange)) return;
    if (!blockRange) {
      window.getSelection()?.removeAllRanges();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    if (blockRange?.focus !== index || blockRange.anchor !== start.index) setBlockRange({ anchor: start.index, focus: index });
  };
  const onRangePointerUp = () => { rangeStart.current = undefined; };
  React.useEffect(() => {
    if (!blockRange) return;
    const onKey = (event: KeyboardEvent) => {
      const current = latestNote(); if (!current) return;
      const from = Math.min(blockRange.anchor, blockRange.focus), to = Math.max(blockRange.anchor, blockRange.focus);
      const picked = current.blocks.slice(from, to + 1);
      if (event.key === 'Escape') { setBlockRange(undefined); return; }
      if ((event.metaKey || event.ctrlKey) && (event.key === 'c' || event.key === 'x')) {
        event.preventDefault();
        void navigator.clipboard?.writeText(noteToMarkdown({ ...current, title: '', blocks: picked }).replace(/^# .*\n\n/, '')).catch(() => undefined);
        if (event.key === 'c') return;
      } else if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      event.preventDefault();
      const rest = current.blocks.filter((_, i) => i < from || i > to);
      edit({ ...current, blocks: rest.length ? rest : [makeBlock()] });
      setBlockRange(undefined);
    };
    const onDown = (event: PointerEvent) => { if (!articleRef.current?.contains(event.target instanceof Node ? event.target : null)) setBlockRange(undefined); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown); };
  }, [blockRange]); // eslint-disable-line react-hooks/exhaustive-deps -- latestNote and edit read current state
  const { edit, run, close } = useFolioStore.getState();
  const [active, setActive] = React.useState<{ id: string; editor: Editor }>();
  const [blockMenuID, setBlockMenuID] = React.useState<string>();
  const [focus, setFocus] = React.useState<{ id: string; at: FocusAt; n: number }>();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [readStart, setReadStart] = React.useState<string>();
  // A "continue reading" card (from the other device) opens this page in reading mode at that passage.
  const readRequest = useHandoffStore((s) => s.readRequest);
  const currentID = status?.selectedID;
  React.useEffect(() => {
    if (!readRequest || readRequest.noteID !== currentID) return;
    setReadStart(readRequest.blockID); setReading(true);
    useHandoffStore.getState().clearReadRequest();
  }, [readRequest, currentID]);
  // Report the page in front so the other device can offer to continue here; the Mac forwards it to sync.
  const localFocus = useHandoffStore((s) => s.local);
  React.useEffect(() => { if (currentID && !home) useHandoffStore.getState().report({ noteID: currentID, reading: false }); }, [currentID, home]);
  React.useEffect(() => { if (localFocus && !mobile) void reportFolioFocus(localFocus).catch(() => undefined); }, [localFocus, mobile]);
  const [syncOpen, setSyncOpen] = React.useState(false);
  // Ask AI sits beside the page on the Mac (the phone has its own chat screen).
  const [askOpen, setAskOpenState] = React.useState(() => { try { return localStorage.getItem('folio.ask.open') === '1'; } catch { return false; } });
  const setAskOpen = React.useCallback((open: boolean) => { setAskOpenState(open); try { localStorage.setItem('folio.ask.open', open ? '1' : '0'); } catch { /* storage blocked */ } }, []);
  const askToggle = React.useRef(() => {}); askToggle.current = () => setAskOpen(!askOpen);
  const [recordConfirm, setRecordConfirm] = React.useState(false);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [link, setLink] = React.useState('');
  const [slash, setSlash] = React.useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = React.useState(0);
  const [mention, setMention] = React.useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [bubble, setBubble] = React.useState<{ top: number; left: number }>();
  const [, setSelectionTick] = React.useState(0);

  const selected = status?.notes.find((n) => n.id === status.selectedID);
  const note = !home && selected ? (drafts[selected.id]?.note || selected) : undefined;
  const title = note?.title;
  React.useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [title, note?.id]);
  const call = (input: FolioRequest) => { setMenuOpen(false); void run({ noteID: note?.id, ...input }); };
  const utility = (kind: string) => call({ command: 'utility', kind });
  const focusBlock = (id: string, at: FocusAt) => setFocus((old) => ({ id, at, n: (old?.n ?? 0) + 1 }));

  // ---- Format menu: waits for a finished selection, sits below it so the text stays visible.
  const pointerDown = React.useRef(false);
  const bubbleRef = React.useRef<HTMLDivElement>(null);
  const activeEditor = React.useRef<Editor | undefined>(undefined);
  const placeBubble = React.useCallback((editor: Editor) => {
    if (editor.isDestroyed) return;
    const { from, to, empty } = editor.state.selection;
    if (empty || !editor.isFocused || pointerDown.current) { setBubble(undefined); return; }
    const start = editor.view.coordsAtPos(from), end = editor.view.coordsAtPos(to);
    const menuHeight = bubbleRef.current?.offsetHeight || 124;
    const menuWidth = Math.min(420, window.innerWidth - 16);
    const below = end.bottom + 12;
    const top = below + menuHeight < window.innerHeight - 8 ? below : Math.max(8, start.top - menuHeight - 12);
    setBubble({ top, left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, Math.min(start.left, end.left))) });
  }, []);
  const bubbleShown = React.useRef(false);
  bubbleShown.current = bubble !== undefined;
  const trackSelection = React.useCallback((editor: Editor, blockID: string) => {
    activeEditor.current = editor;
    setActive((previous) => previous?.editor === editor ? previous : { id: blockID, editor });
    // The format menu (the only thing showing the selection's marks) needs a redraw only while a
    // selection is highlighted. A caret moving as you type must not redraw the whole page.
    if (!editor.state.selection.empty || bubbleShown.current) setSelectionTick((n) => n + 1);
    placeBubble(editor);
  }, [placeBubble]);
  React.useEffect(() => {
    const down = (event: MouseEvent) => { if (event.target instanceof Node && bubbleRef.current?.contains(event.target)) return; pointerDown.current = true; setBubble(undefined); };
    const up = () => { if (!pointerDown.current) return; pointerDown.current = false; requestAnimationFrame(() => { if (activeEditor.current) placeBubble(activeEditor.current); }); };
    document.addEventListener('mousedown', down, true); document.addEventListener('mouseup', up, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('mouseup', up, true); };
  }, [placeBubble]);
  const paint = (kind: Paint, color: ColorName) => {
    const editor = active?.editor; if (!editor || editor.isDestroyed) return;
    const chain = editor.chain().focus();
    if (kind === 'textColor') { if (color === 'none') chain.unsetColor().run(); else chain.setColor(folioColors[color]).run(); }
    else { if (color === 'none') chain.unsetHighlight().run(); else chain.setHighlight({ color: folioColors[color] }).run(); }
  };
  const colorLabel = (kind: Paint) => (color: ColorName) => `${t(kind === 'textColor' ? 'folio.textColor' : 'folio.highlight')}: ${t(`folio.color.${color}`)}`;

  React.useEffect(() => { setActive(undefined); setSlash(null); setMention(null); setBlockMenuID(undefined); }, [note?.id]);
  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n' || key === 'j' || (key === 'e' && event.shiftKey)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (key === 'n') void useFolioStore.getState().run({ command: 'create' });
        if (key === 'j') { if (mobile) void useFolioStore.getState().run({ command: 'utility', kind: 'assistant' }); else askToggle.current(); }
        if (key === 'e') void useFolioStore.getState().run({ command: 'export' });
      }
    };
    window.addEventListener('keydown', shortcut, true); return () => window.removeEventListener('keydown', shortcut, true);
  }, [mobile]);

  // ---- Block edits always start from the latest saved-or-draft page.
  const updateBlock = React.useCallback((block: FolioBlock) => { const current = latestNote(); if (current) edit({ ...current, blocks: current.blocks.map((b) => b.id === block.id ? block : b) }); }, [edit]);
  const insertAfter = (afterID: string | undefined, block: FolioBlock) => {
    const current = latestNote(); if (!current) return;
    const blocks = [...current.blocks];
    blocks.splice(afterID ? blocks.findIndex((b) => b.id === afterID) + 1 : blocks.length, 0, block);
    edit({ ...current, blocks }); focusBlock(block.id, 'start');
  };
  const setKind = (id: string, kind: BlockKind) => {
    const current = latestNote(); const block = current?.blocks.find((b) => b.id === id); if (!current || !block) return;
    updateBlock({ ...block, kind });
    if (kind === 'divider') insertAfter(id, makeBlock()); else focusBlock(id, 'end');
  };
  const removeEmpty = (id: string) => {
    const current = latestNote(); if (!current) return;
    const index = current.blocks.findIndex((b) => b.id === id);
    if (index <= 0) return;
    edit({ ...current, blocks: current.blocks.filter((b) => b.id !== id) });
    focusBlock(current.blocks[index - 1].id, 'end');
  };
  // ---- Drag a block by its handle to another place, like Notion. Nested lines travel with their parent.
  const [dragging, setDragging] = React.useState<{ id: string; before: number; lineTop: number }>();
  // Phone: one toolbar above the keyboard (like Notion) while a line is being edited.
  const [editing, setEditing] = React.useState(false);
  const [turnInto, setTurnInto] = React.useState(false);
  React.useEffect(() => {
    if (!mobile) return;
    const update = () => { const inside = Boolean(articleRef.current?.contains(document.activeElement)); setEditing(inside); if (!inside) setTurnInto(false); };
    const later = () => setTimeout(update, 0);
    document.addEventListener('focusin', update); document.addEventListener('focusout', later);
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', later); };
  }, [mobile]);
  const dragStart = React.useRef<{ id: string; x: number; y: number; moved: boolean } | undefined>(undefined);
  const dropSlot = (y: number): { before: number; lineTop: number } | undefined => {
    const current = latestNote(); const article = articleRef.current; if (!current || !article) return undefined;
    const origin = article.getBoundingClientRect().top;
    const rows = [...article.querySelectorAll<HTMLElement>('[data-block-id]')];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        const index = current.blocks.findIndex((b) => b.id === row.dataset.blockId);
        if (index >= 0) return { before: index, lineTop: rect.top - origin - 1 };
      }
    }
    const last = rows.at(-1)?.getBoundingClientRect();
    return last ? { before: current.blocks.length, lineTop: last.bottom - origin } : undefined;
  };
  const moveBlockTo = (id: string, before: number) => {
    const current = latestNote(); if (!current) return;
    const from = current.blocks.findIndex((b) => b.id === id); if (from < 0) return;
    const depth = current.blocks[from].indent ?? 0;
    let end = from + 1;
    while (end < current.blocks.length && (current.blocks[end].indent ?? 0) > depth) end += 1;
    if (before >= from && before <= end) return; // dropped onto itself
    const moving = current.blocks.slice(from, end);
    const rest = [...current.blocks.slice(0, from), ...current.blocks.slice(end)];
    const at = before > from ? before - moving.length : before;
    edit({ ...current, blocks: [...rest.slice(0, at), ...moving, ...rest.slice(at)] });
  };
  const onHandleDown = (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { id, x: event.clientX, y: event.clientY, moved: false };
  };
  const onHandleMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current; if (!start) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    if (!start.moved) { start.moved = true; setBlockMenuID(undefined); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }
    // Near the top or bottom of the page, keep scrolling while dragging.
    const scroller = articleRef.current?.parentElement;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (event.clientY < box.top + 60) scroller.scrollBy(0, -14);
      else if (event.clientY > box.bottom - 60) scroller.scrollBy(0, 14);
    }
    const slot = dropSlot(event.clientY);
    if (slot) setDragging((old) => (old?.before === slot.before && old.id === start.id ? old : { id: start.id, ...slot }));
  };
  const onHandleUp = (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    const start = dragStart.current; dragStart.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (start?.moved) { const slot = dragging; setDragging(undefined); if (slot) moveBlockTo(id, slot.before); return; }
    setDragging(undefined);
    setBlockMenuID(blockMenuID === id ? undefined : id);
  };

  const move = (id: string, delta: number) => {
    const current = latestNote(); if (!current) return;
    const blocks = [...current.blocks], index = blocks.findIndex((b) => b.id === id), target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]]; edit({ ...current, blocks });
  };

  // ---- "/" commands.
  const slashCommands = React.useMemo<SlashCommand[]>(() => [
    ...blockKinds.filter((kind) => kind !== 'attachment' && kind !== 'pageIn' && kind !== 'toggleHeading4').map((kind): SlashCommand => ({
      id: kind, kind, glyph: /eading([1-4])$/.exec(kind)?.[1] ? `H${/eading([1-4])$/.exec(kind)?.[1]}` : undefined, label: t(`folio.block.${kind}`), icon: blockIcons.get(kind) ?? (kind.startsWith('toggle') ? 'arrow-right-s' : 'text'), keys: blockAliases.get(kind) ?? [kind.toLowerCase()], group: 'basic',
    })),
    { id: 'db-board', database: 'board', label: t('folio.board'), icon: 'layout-column', keys: ['board', 'kanban', 'stages', 'todo board'], group: 'databases' },
    { id: 'db-table', database: 'table', label: t('folio.table'), icon: 'table-2', keys: ['table', 'database', 'db', 'spreadsheet'], group: 'databases' },
    { id: 'db-library', database: 'library', label: t('folio.library'), icon: 'book-open', keys: ['library', 'books', 'reading'], group: 'databases' },
  ], [t]);
  const slashResults = React.useMemo(() => {
    if (!slash) return [];
    const q = slash.query.toLowerCase().replace(/\s+/g, '');
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.label.toLowerCase().replace(/\s+/g, '').includes(q) || c.keys.some((k) => k.replace(/\s+/g, '').startsWith(q)));
  }, [slash, slashCommands]);
  React.useEffect(() => setSlashIndex(0), [slash?.query, slash?.blockID]);

  const createDatabase = async (blockID: string, kind: 'board' | 'table' | 'library') => {
    const original = latestNote(); const block = original?.blocks.find((b) => b.id === blockID); if (!original || !block) return;
    updateBlock({ ...block, kind: 'page', text: '', marks: [] });
    const response = await run({ command: 'create', kind: kind === 'library' ? 'library' : 'table', parentID: original.id });
    const createdID = response?.state?.selectedID;
    if (!createdID || createdID === original.id) return;
    const parent = noteByID(original.id);
    if (parent) edit({ ...parent, blocks: parent.blocks.map((b) => b.id === blockID ? { ...b, kind: 'page', asset: createdID, text: '' } : b) });
    const created = noteByID(createdID);
    if (created?.table && kind === 'board') edit({ ...created, table: { ...created.table, view: 'board' } });
  };
  const applySlash = (command: SlashCommand | undefined) => {
    const state = slash; setSlash(null);
    if (!command || !state) return;
    const current = latestNote(); const block = current?.blocks.find((b) => b.id === state.blockID); if (!block) return;
    if (command.database) { void createDatabase(block.id, command.database); return; }
    if (!command.kind) return;
    updateBlock({ ...block, kind: command.kind, text: '', marks: [] });
    if (command.kind === 'divider') insertAfter(block.id, makeBlock()); else focusBlock(block.id, 'end');
  };
  // ---- "@" links to other pages.
  const mentionResults = React.useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return (status?.notes ?? []).filter((n) => !n.trashed && !n.isChat && n.id !== status?.selectedID && (n.title || '').toLowerCase().includes(q)).slice(0, 8);
  }, [mention, status?.notes, status?.selectedID]);
  React.useEffect(() => setMentionIndex(0), [mention?.query, mention?.blockID]);
  const applyMention = (target: FolioNote | undefined) => {
    const state = mention; setMention(null);
    const editor = activeEditor.current;
    if (!target || !state || !editor || editor.isDestroyed) return;
    const to = editor.state.selection.from;
    editor.chain().focus().deleteRange({ from: state.from, to }).insertContent([
      { type: 'text', text: target.title || t('folio.untitled'), marks: [{ type: 'link', attrs: { href: folioNoteLinkPrefix + target.id } }] },
      { type: 'text', text: ' ' },
    ]).unsetMark('link').run();
  };
  const openLinkedNote = React.useCallback((noteID: string) => {
    if (useFolioStore.getState().status?.notes.some((n) => n.id === noteID)) void useFolioStore.getState().run({ command: 'select', noteID });
  }, []);

  const onSlashKey = (key: string) => {
    if (mention) {
      if (key === 'Escape') { setMention(null); return true; }
      if (key === 'ArrowDown') { setMentionIndex((i) => Math.min(mentionResults.length - 1, i + 1)); return true; }
      if (key === 'ArrowUp') { setMentionIndex((i) => Math.max(0, i - 1)); return true; }
      if (key === 'Enter' || key === 'Tab') { if (!mentionResults.length) return false; applyMention(mentionResults[mentionIndex]); return true; }
      return false;
    }
    if (!slash) return false;
    if (key === 'Escape') { setSlash(null); return true; }
    if (key === 'ArrowDown') { setSlashIndex((i) => Math.min(slashResults.length - 1, i + 1)); return true; }
    if (key === 'ArrowUp') { setSlashIndex((i) => Math.max(0, i - 1)); return true; }
    if (key === 'Enter' || key === 'Tab') { if (!slashResults.length) return false; applySlash(slashResults[slashIndex]); return true; }
    return false;
  };

  // Read aloud speaks only the highlighted text; with nothing highlighted it reads the whole page.
  const selectedText = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !articleRef.current?.contains(selection.anchorNode)) return '';
    return selection.toString().trim();
  };
  const readAloud = () => {
    if (status?.speaking) { call({ command: 'stop-reading' }); return; }
    const text = selectedText();
    call(text ? { command: 'read', text } : { command: 'read' });
  };

  // Opened from search: scroll to the matching line and highlight it, like Notion.
  React.useEffect(() => {
    if (!found || found.noteID !== note?.id) return;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      useFolioStore.getState().setFound(undefined);
      const element = articleRef.current?.querySelector(`[data-block-id="${CSS.escape(found.blockID)}"]`);
      if (!(element instanceof HTMLElement)) return;
      element.scrollIntoView({ block: 'center' });
      element.classList.remove('folio-found'); void element.offsetWidth; element.classList.add('folio-found');
      const needle = found.query.toLowerCase();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? '').toLowerCase().indexOf(needle);
        if (at < 0 || !needle) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length);
        CSS.highlights.set('folio-found', new Highlight(range));
        break;
      }
      clear = setTimeout(() => { CSS.highlights.delete('folio-found'); element.classList.remove('folio-found'); }, 6000);
    });
    return () => { cancelAnimationFrame(frame); if (clear) { clearTimeout(clear); CSS.highlights.delete('folio-found'); } };
  }, [found, note?.id]);

  // A backup file the iPhone app can import (Settings → Import backup). Attachments stay on the Mac.
  const exportForPhone = () => {
    setMenuOpen(false);
    const notes = useFolioStore.getState().status?.notes.filter((n) => !n.isChat) ?? [];
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'folio', version: 1, exported: Date.now(), notes })], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `Folio backup ${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const compose = async () => {
    setMenuOpen(false);
    const response = await run({ command: 'markdown', noteID: note?.id, flag: true });
    if (response?.text && mobile && note) { mobile.onAddToChat(response.text, note.id); return; }
    if (response?.text) { useInputStore.getState().setPendingInputText(response.text, 'append'); await close(); }
  };

  if (!status) return <div className="p-8 text-muted-foreground">{error || t('common.loading')}</div>;

  // Collapsed toggles hide what follows them.
  // A closed toggle hides what is nested under it (deeper blocks), or, when nothing is nested, the blocks up to the next toggle or heading.
  const hidden = new Set<string>(); let hiddenLevel: number | undefined; let hiddenToggle = false; let hideDeeperThan: number | undefined;
  const pageBlocks = note?.blocks ?? [];
  pageBlocks.forEach((block, index) => {
    const level = Number(block.kind.match(/(?:h|H)eading([1-4])/)?.[1] || 0);
    const depth = block.indent ?? 0;
    if (hideDeeperThan !== undefined) { if (depth > hideDeeperThan) { hidden.add(block.id); return; } hideDeeperThan = undefined; }
    if (hiddenLevel !== undefined) { if (level > 0 && level <= hiddenLevel) hiddenLevel = undefined; else { hidden.add(block.id); return; } }
    if (hiddenToggle) { if (block.kind === 'toggle' || level > 0) hiddenToggle = false; else { hidden.add(block.id); return; } }
    if (block.kind.startsWith('toggleHeading') && block.checked) hiddenLevel = level;
    if (block.kind === 'toggle' && block.checked) {
      if ((pageBlocks[index + 1]?.indent ?? 0) > depth) hideDeeperThan = depth; else hiddenToggle = true;
    }
  });
  const crumbs: FolioNote[] = [];
  for (let cursor = note && status.notes.find((n) => n.id === note.parentID), guard = 0; cursor && guard < 20; cursor = status.notes.find((n) => n.id === cursor?.parentID), guard += 1) crumbs.unshift(cursor);
  const isDescendant = (candidate: string): boolean => {
    const seen = new Set<string>(); let cursor = status.notes.find((n) => n.id === candidate);
    while (cursor) { if (cursor.id === note?.id || seen.has(cursor.id)) return true; seen.add(cursor.id); cursor = status.notes.find((n) => n.id === cursor?.parentID); }
    return false;
  };
  const createKinds = [['note', 'file-text', 'folio.newPage'], ['board', 'layout-column', 'folio.board'], ['table', 'table-2', 'folio.table'], ['library', 'book-open', 'folio.library'], ['meeting', 'mic', 'folio.meeting'], ['chat', 'chat-new', 'folio.chat']] as const;
  const createFromMenu = async (kind: typeof createKinds[number][0]) => {
    setMenuOpen(false);
    const response = await run({ command: 'create', kind: kind === 'board' ? 'table' : kind, parentID: undefined });
    const created = response?.state?.selectedID && noteByID(response.state.selectedID);
    if (kind === 'board' && created && created.table) edit({ ...created, table: { ...created.table, view: 'board' } });
  };
  let numbered = 0;

  return <div className="flex h-full bg-background text-foreground">
  <div className="folio-workspace flex h-full min-w-0 flex-1 flex-col bg-background text-foreground">
    {reading && note && <FolioReader note={note} startAt={readStart} onClose={() => { setReading(false); setReadStart(undefined); useHandoffStore.getState().report({ noteID: note.id, reading: false }); }} onListen={(text) => call({ command: 'read', text })}
      onPlace={(blockID) => useHandoffStore.getState().report({ noteID: note.id, blockID, reading: true })} />}
    {/* One slim bar replaces the old stacked toolbars; everything else lives in the ⋯ menu. */}
    <header className="flex h-11 shrink-0 items-center gap-1 px-3">
      {mobile
        ? <button type="button" className={tool} onClick={mobile.onMenu} aria-label={t('folio.goBack')} title={t('folio.goBack')}><Icon name="arrow-left-s" className="size-6" /></button>
        : <button type="button" className={quiet} onClick={() => void close()} title={t('folio.back')}><Icon name="arrow-left-s" className="inline size-4" /> {t('folio.back')}</button>}
      <nav className="flex min-w-0 shrink items-center gap-1 truncate pl-2 text-sm text-muted-foreground" aria-label={t('folio.pages')}>
        {home ? <span className="text-foreground">{t('folio.notes')}</span> : <>
          {!mobile && crumbs.map((crumb) => <React.Fragment key={crumb.id}><button type="button" className="truncate hover:text-foreground" onClick={() => call({ command: 'select', noteID: crumb.id })}>{crumb.title || t('folio.untitled')}</button><span>/</span></React.Fragment>)}
          {note && <span className="truncate text-foreground">{note.title || t('folio.untitled')}</span>}
        </>}
      </nav>
      {note && <div className="ml-2 flex shrink-0 items-center gap-0.5" role="toolbar" aria-label={t('folio.more')} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className={tool} title={t('folio.readerOpen')} aria-label={t('folio.readerOpen')} onClick={() => { void useFolioStore.getState().flush().catch(() => undefined); setReading(true); }}>
          <Icon name="book-open" className="size-4" />
        </button>
        <button type="button" className={cn(tool, status.speaking && toolLive)} aria-pressed={status.speaking} title={status.speaking ? t('folio.stopReading') : t('folio.read')} aria-label={status.speaking ? t('folio.stopReading') : t('folio.read')} onClick={readAloud}>
          {status.speaking ? <Icon name="stop" className="size-4" /> : <Icon name="volume-up" className="size-4" />}
        </button>
        {!mobile && <button type="button" className={cn(tool, status.listening && toolLive)} aria-pressed={status.listening} title={status.listening ? t('folio.stopDictating') : t('folio.dictate')} aria-label={status.listening ? t('folio.stopDictating') : t('folio.dictate')} onClick={() => call({ command: status.listening ? 'stop-listening' : 'listen' })}>
          <Icon name="mic" className="size-4" />
        </button>}
        <button type="button" className={cn(tool, status.recording && toolLive)} aria-pressed={status.recording} title={status.recording ? t('folio.stopRecording') : t('folio.recordings')} aria-label={status.recording ? t('folio.stopRecording') : t('folio.recordings')}
          onClick={() => { if (status.recording) call({ command: 'stop-recording' }); else if (mobile) setRecordConfirm(true); else utility('meeting'); }}>
          <Icon name="record-circle" className="size-4" />
        </button>
        {!mobile && <button type="button" className={tool} title={t('folio.attach')} aria-label={t('folio.attach')} onClick={() => call({ command: 'attach' })}>
          <Icon name="attachment-2" className="size-4" />
        </button>}
      </div>}
      <div className="flex-1" />
      <span className={cn('px-2 text-xs text-muted-foreground', mobile && 'sr-only')} aria-live="polite">{saving || Object.keys(drafts).length ? t('folio.saving') : t('folio.saved')}</span>
      {note && !mobile && <button type="button" className={quiet} disabled={note.excludedFromAI} onClick={() => void compose()}>{t('folio.addToChat')}</button>}
      <div className="relative">
        {!mobile && note && <button type="button" className={cn(quiet, 'flex items-center gap-1.5', askOpen && 'bg-interactive-selection text-foreground')} aria-pressed={askOpen} title={`${t('folio.askTitle')} (⌘J)`} onClick={() => setAskOpen(!askOpen)}>
          <Icon name="sparkling" className="size-4" />{t('folio.askTitle')}
        </button>}
        <button type="button" className={quiet} aria-label={t('folio.more')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="more-fill" className="size-4" /></button>
        {menuOpen && <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-9 z-50 max-h-[75vh] w-64 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl">
            {createKinds.map(([kind, icon, label]) => <button key={kind} type="button" className={menuItem} onClick={() => void createFromMenu(kind)}><Icon name={icon} className="size-4 text-muted-foreground" />{t(label)}</button>)}
            {note && <>
              <div className="my-1 border-t border-border" />
              {mobile && <>
                <button type="button" className={menuItem} disabled={note.excludedFromAI} onClick={() => { setMenuOpen(false); void compose(); }}><Icon name="chat-new" className="size-4 text-muted-foreground" />{t('folio.addToChat')}</button>
                <button type="button" className={menuItem} onClick={() => { setMenuOpen(false); mobile.onAttach(note.id); }}><Icon name="attachment-2" className="size-4 text-muted-foreground" />{t('folio.attach')}</button>
                <button type="button" className={menuItem} onClick={() => { setMenuOpen(false); call({ command: status.listening ? 'stop-listening' : 'listen' }); }}><Icon name="mic" className="size-4 text-muted-foreground" />{status.listening ? t('folio.stopDictating') : t('folio.dictate')}</button>
              </>}
              <button type="button" className={menuItem} onClick={() => { edit({ ...note, favorite: !note.favorite }); setMenuOpen(false); }}><Icon name="star" className="size-4 text-muted-foreground" />{t('folio.favorite')}{note.favorite ? ' ✓' : ''}</button>
              <button type="button" className={menuItem} onClick={() => { edit({ ...note, excludedFromAI: !note.excludedFromAI }); setMenuOpen(false); }}><Icon name="lock" className="size-4 text-muted-foreground" />{t('folio.private')}{note.excludedFromAI ? ' ✓' : ''}</button>
              <label className={cn(menuItem, 'cursor-default')}><Icon name="folder" className="size-4 text-muted-foreground" /><select className="min-w-0 flex-1 bg-transparent text-sm" aria-label={t('folio.parent')} value={note.parentID || ''} onChange={(e) => edit({ ...note, parentID: e.target.value || undefined })}><option value="">{t('folio.parent')}: {t('folio.root')}</option>{status.notes.filter((n) => !isDescendant(n.id) && !n.trashed).map((n) => <option key={n.id} value={n.id}>{n.title || t('folio.untitled')}</option>)}</select></label>
              <button type="button" className={menuItem} onClick={() => { setMenuOpen(false); setReading(true); }}><Icon name="book-open" className="size-4 text-muted-foreground" />{t('folio.readerOpen')}</button>
              <button type="button" className={menuItem} onClick={() => call({ command: 'duplicate' })}><Icon name="file-copy" className="size-4 text-muted-foreground" />{t('folio.duplicate')}</button>
              {!mobile && <button type="button" className={menuItem} onClick={() => utility('history')}><Icon name="history" className="size-4 text-muted-foreground" />{t('folio.history')}</button>}
              <div className="my-1 border-t border-border" />
              <div className="px-2 pt-1 text-xs text-muted-foreground">{t('folio.import')}</div>
              {(mobile ? ['notes'] : ['notes', 'documents', 'ocr', ...(note.table ? ['csv'] : [])]).map((kind) => <button key={kind} type="button" className={cn(menuItem, 'pl-4')} onClick={() => { if (mobile) { setMenuOpen(false); mobile.onImport(); } else call({ command: 'import', kind, flag: kind === 'ocr' }); }}>{kind === 'notes' ? t('folio.pages') : kind === 'documents' ? t('folio.attach') : kind.toUpperCase()}</button>)}
              <div className="px-2 pt-1 text-xs text-muted-foreground">{t('folio.export')}</div>
              {['md', 'txt', ...(mobile ? [] : ['pdf']), ...(note.table ? ['csv'] : [])].map((kind) => <button key={kind} type="button" className={cn(menuItem, 'pl-4')} onClick={() => { if (mobile) { setMenuOpen(false); mobile.onExport(note, kind); } else call({ command: 'export', kind }); }}>{kind.toUpperCase()}</button>)}
              <button type="button" className={cn(menuItem, 'pl-4')} onClick={() => { if (mobile) { setMenuOpen(false); mobile.onExportLibrary(); } else call({ command: 'export-library' }); }}>{t('folio.allPages')}</button>
              {!mobile && <button type="button" className={cn(menuItem, 'pl-4')} onClick={exportForPhone}>{t('folio.exportForPhone')}</button>}
            </>}
            <div className="my-1 border-t border-border" />
            {mobile && note && <button type="button" className={menuItem} disabled={note.excludedFromAI} onClick={() => { setMenuOpen(false); mobile.onSummarize(note); }}><Icon name="sparkling" className="size-4 text-muted-foreground" />{t('folio.summarize')}</button>}
            {(['calendar', 'assistant', 'settings'] as const).map((kind) => <button key={kind} type="button" className={menuItem} onClick={() => {
              // The iPhone reads its own calendar; the Mac opens the native calendar window.
              if (mobile && kind === 'calendar') { setMenuOpen(false); void run({ command: 'calendar-connect' }).then(() => utility('calendar')); return; }
              if (!mobile && kind === 'assistant') { setMenuOpen(false); setAskOpen(true); return; }
              utility(kind);
            }}><Icon name={kind === 'calendar' ? 'calendar' : kind === 'assistant' ? 'sparkling' : 'settings-3'} className="size-4 text-muted-foreground" />{t(`folio.${kind}`)}</button>)}
            {!mobile && <button type="button" className={menuItem} onClick={() => { setMenuOpen(false); setSyncOpen(true); }}><Icon name="smartphone" className="size-4 text-muted-foreground" />{t('folio.syncTitle')}</button>}
            {note && <><div className="my-1 border-t border-border" /><button type="button" className={cn(menuItem, 'text-destructive')} onClick={() => call({ command: 'trash', flag: note.trashed })}><Icon name="delete-bin" className="size-4" />{t(note.trashed ? 'folio.restore' : 'folio.trash')}</button></>}
          </div>
        </>}
      </div>
    </header>

    {(error || status.error) && <div role="alert" className="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] px-3 py-2 text-sm"><span className="flex-1">{error || status.error}</span><button type="button" className={quiet} onClick={() => void useFolioStore.getState().flush().catch(() => undefined)}>{t('folio.retry')}</button></div>}
    {(status.recording || status.transcribing || status.importing || status.listening) && <div role="status" className="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-secondary px-3 py-2 text-sm"><span className="flex-1">{status.recordingProgress || status.importProgress || status.dictation}</span><button type="button" className={quiet} onClick={() => call({ command: status.recording ? 'stop-recording' : status.transcribing ? 'cancel-transcription' : status.importing ? 'cancel-import' : 'stop-listening' })}>{t('folio.stop')}</button></div>}
    {recordConfirm && <div role="dialog" aria-label={t('folio.recordMeeting')} className="mx-4 mb-2 rounded-lg border border-border bg-background p-3 text-sm shadow-lg">
      <p className="mb-1 font-medium">{t('folio.recordMeeting')}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t('folio.recordConsent')}</p>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => { setRecordConfirm(false); call({ command: 'record', flag: true }); }}>{t('folio.startRecording')}</button>
        <button type="button" className="rounded-md bg-secondary px-3 py-2" onClick={() => setRecordConfirm(false)}>{t('folio.cancel')}</button>
      </div>
    </div>}
    {status.calendarPrompt && <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm"><span className="flex-1">{status.calendarPrompt.title}</span><button type="button" className={quiet} onClick={() => call({ command: 'calendar-prepare', eventID: status.calendarPrompt?.id })}>{t('folio.meeting')}</button><button type="button" className={quiet} onClick={() => call({ command: 'calendar-dismiss' })}>×</button></div>}

    <div className="min-h-0 flex-1 overflow-auto" onScroll={() => { setBubble(undefined); setSlash(null); setMention(null); }}>
      {!note && <div className={cn('mx-auto w-full max-w-5xl', mobile ? 'px-4 py-6' : 'pl-14 pr-8 py-10')}>
        <h1 className="mb-6 text-3xl font-bold">{t('folio.notes')}</h1>
        <div className="mb-10 grid grid-cols-3 gap-2">
          {createKinds.map(([kind, icon, label]) => <button key={kind} type="button" className="flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-left text-sm hover:bg-interactive-hover" onClick={() => void createFromMenu(kind)}><Icon name={icon} className="size-4 text-muted-foreground" />{t(label)}</button>)}
        </div>
        {!mobile && <ContinueFromPhone notes={status.notes} onOpen={(id, blockID, isReading) => { void run({ command: 'select', noteID: id }).then(() => { if (isReading) useHandoffStore.getState().openReader(id, blockID); }); }} />}
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('folio.today')}</div>
        <div className="mb-8"><FolioHabits compact={Boolean(mobile)} /></div>
        {status.events.length > 0 && <>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('folio.upcoming')}</div>
          <div className="mb-8">{status.events.slice(0, 8).map((event) => <button key={event.id} type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover" onClick={() => call({ command: 'calendar-prepare', eventID: event.id })}>
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{folioDate(event.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            <span className="min-w-0 flex-1 truncate">{event.title}</span>
            <Icon name="file-add" className="size-4 shrink-0 text-muted-foreground" />
          </button>)}</div>
        </>}
        {status.calendarConnected && <label className="-mt-6 mb-8 flex items-center gap-2 px-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={status.reminders} onChange={(e) => call({ command: 'calendar-reminders', flag: e.target.checked })} />
          {t('folio.meetingReminders')}
        </label>}
        {mobile && !status.calendarConnected && <button type="button" className="mb-8 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm" onClick={() => call({ command: 'calendar-connect' })}><Icon name="calendar" className="size-4 text-muted-foreground" />{t('folio.connectCalendar')}</button>}
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('folio.recent')}</div>
        {[...status.notes].filter((n) => !n.trashed).sort((a, b) => b.modified - a.modified).map((n) => <button key={n.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover" onClick={() => call({ command: 'select', noteID: n.id })}>
          <FolioIcon value={n.icon} /><span className="min-w-0 flex-1 truncate">{n.title || t('folio.untitled')}</span><span className="text-xs text-muted-foreground">{folioDate(n.modified).toLocaleDateString()}</span>
        </button>)}
      </div>}

      {note && <article ref={articleRef} className={cn('relative mx-auto w-full max-w-5xl pb-40', mobile ? 'pl-8 pr-4 pt-4' : 'pl-14 pr-8 pt-10', blockRange && 'select-none')} style={{ fontSize: status.fontSize }}
        onPointerDown={onRangePointerDown} onPointerMove={onRangePointerMove} onPointerUp={onRangePointerUp}>
        {/* Where a dragged block will land. */}
        {dragging && <div aria-hidden className="pointer-events-none absolute z-20 h-0.5 rounded bg-[var(--primary)]" style={{ top: dragging.lineTop, left: mobile ? 32 : 56, right: mobile ? 16 : 32 }} />}
        <div className="group/title relative mb-1">
          {note.icon
            ? <button type="button" className="mb-2 rounded-md p-1 text-5xl leading-none hover:bg-interactive-hover" aria-label={t('folio.icon')} onClick={() => setIconOpen(!iconOpen)}><FolioIcon value={note.icon} large /></button>
            : <button type="button" className={cn(quiet, 'mb-2 flex items-center gap-1.5 opacity-0 focus-visible:opacity-100 group-hover/title:opacity-100', iconOpen && 'opacity-100')} onClick={() => setIconOpen(!iconOpen)}><Icon name="emotion-happy" className="size-4" />{t('folio.addIcon')}</button>}
          {iconOpen && <FolioIconPicker onClose={() => setIconOpen(false)}
            onPick={(icon) => { const current = latestNote(); if (current) edit({ ...current, icon }); setIconOpen(false); }}
            onRemove={() => { const current = latestNote(); if (current) edit({ ...current, icon: '' }); setIconOpen(false); }} />}
        </div>
        {/* Wraps like Notion instead of cutting off long titles. */}
        <textarea rows={1} ref={titleRef}
          aria-label={t('folio.title')} placeholder={t('folio.untitled')} className={cn('mb-1 block w-full resize-none overflow-hidden bg-transparent font-bold leading-tight outline-none placeholder:text-muted-foreground/50', mobile ? 'text-[2em]' : 'text-[2.5em]')} value={note.title}
          onChange={(e) => { edit({ ...note, title: e.target.value.replace(/\n/g, ' ') }); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const first = note.blocks[0]; if (first) focusBlock(first.id, 'start'); else insertAfter(undefined, makeBlock()); } }} />
        <input aria-label={t('folio.tags')} placeholder={`# ${t('folio.tags')}`} className="mb-6 w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/40" value={note.tags.join(', ')} onChange={(e) => edit({ ...note, tags: e.target.value.split(',').map((s) => s.trim()) })} />

        {note.table && <FolioDatabase table={note.table} onChange={(table) => edit({ ...note, table })} />}

        {note.blocks.map((block, blockIndex) => {
          numbered = block.kind === 'numbered' ? numbered + 1 : 0;
          if (hidden.has(block.id)) return null;
          const toggled = block.checked, isToggle = block.kind.startsWith('toggle');
          const linked = (block.kind === 'page' || block.kind === 'pageIn') && block.asset ? status.notes.find((n) => n.id === block.asset) : undefined;
          const inRange = Boolean(blockRange) && blockIndex >= Math.min(blockRange?.anchor ?? 0, blockRange?.focus ?? 0) && blockIndex <= Math.max(blockRange?.anchor ?? 0, blockRange?.focus ?? 0);
          return <div key={block.id} data-block-id={block.id} className={cn('folio-block group/block relative flex items-start gap-1.5 rounded-sm', inRange && 'bg-interactive-selection', dragging?.id === block.id && 'opacity-40')} data-kind={block.kind} data-checked={block.checked}
            style={{ marginLeft: block.indent ? `${block.indent * 1.5}em` : undefined, backgroundColor: block.highlight === 'none' ? undefined : `color-mix(in srgb, ${folioColors[block.highlight]} ${status.highlightStrength * 100}%, transparent)` }}>
            {/* Handles only appear on hover, in the left margin, like Notion. The phone has none: every line
                carrying its own controls made iOS slow down each keystroke, so it uses one keyboard toolbar. */}
            {!mobile && <div className={cn('absolute top-0.5 flex opacity-0 transition-opacity group-hover/block:opacity-100', mobile ? '-left-7 group-focus-within/block:opacity-70' : '-left-12', blockMenuID === block.id && 'opacity-100')}>
              {!mobile && <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.newBlock')} title={t('folio.newBlock')} onClick={() => insertAfter(block.id, makeBlock())}><Icon name="add" className="size-4" /></button>}
              <button type="button" className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-interactive-hover active:cursor-grabbing" aria-label={t('folio.block')} title={`${t('folio.dragBlock')} · ${t('folio.block')}`}
                onPointerDown={(e) => onHandleDown(e, block.id)} onPointerMove={onHandleMove} onPointerUp={(e) => onHandleUp(e, block.id)} onPointerCancel={() => { dragStart.current = undefined; setDragging(undefined); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBlockMenuID(blockMenuID === block.id ? undefined : block.id); } }}><Icon name="draggable" className="size-4" /></button>
            </div>}
            {blockMenuID === block.id && <>
              <div className="fixed inset-0 z-30" onClick={() => setBlockMenuID(undefined)} />
              <div className={cn('absolute top-7 z-40 max-h-96 w-60 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl', mobile ? 'left-0' : '-left-12')}>
                <div className="px-2 pb-1 text-xs text-muted-foreground">{t('folio.block')}</div>
                {blockKinds.filter((kind) => kind !== 'attachment').map((kind) => <button key={kind} type="button" className={cn(menuItem, block.kind === kind && 'bg-interactive-selection')} onClick={() => { setKind(block.id, kind); setBlockMenuID(undefined); }}>{t(`folio.block.${kind}`)}</button>)}
                <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{t('folio.highlight')}</div>
                <div className="px-2 pb-2"><Swatches compact kind="highlight" label={colorLabel('highlight')} onPick={(color) => updateBlock({ ...block, highlight: color })} /></div>
                <div className="flex border-t border-border pt-1">
                  <button type="button" className={cn(menuItem, 'justify-center')} aria-label={t('folio.up')} onClick={() => move(block.id, -1)}>↑</button>
                  <button type="button" className={cn(menuItem, 'justify-center')} aria-label={t('folio.down')} onClick={() => move(block.id, 1)}>↓</button>
                  <button type="button" className={cn(menuItem, 'justify-center')} aria-label={t('folio.outdent')} disabled={!block.indent} onClick={() => updateBlock({ ...block, indent: (block.indent ?? 1) - 1 || undefined })}>⇤</button>
                  <button type="button" className={cn(menuItem, 'justify-center')} aria-label={t('folio.indent')} disabled={(block.indent ?? 0) >= 8} onClick={() => updateBlock({ ...block, indent: (block.indent ?? 0) + 1 })}>⇥</button>
                  <button type="button" className={cn(menuItem, 'justify-center text-destructive')} aria-label={t('folio.remove')} onClick={() => { const current = latestNote(); if (current) edit({ ...current, blocks: current.blocks.filter((b) => b.id !== block.id) }); setBlockMenuID(undefined); }}><Icon name="delete-bin" className="size-4" /></button>
                </div>
              </div>
            </>}
            {block.kind === 'task' && <input className="mt-[0.45em] size-4 shrink-0 accent-[var(--primary)]" type="checkbox" checked={block.checked} aria-label={block.text || t('folio.block.task')} onChange={(e) => updateBlock({ ...block, checked: e.target.checked })} />}
            {block.kind === 'bullet' && <span className="w-5 shrink-0 text-center leading-[1.65]">•</span>}
            {block.kind === 'numbered' && <span className="w-5 shrink-0 text-right leading-[1.65] tabular-nums">{numbered}.</span>}
            {isToggle && <button type="button" className="mt-[0.2em] shrink-0 rounded p-0.5 text-muted-foreground hover:bg-interactive-hover" aria-expanded={!toggled} aria-label={t('folio.open')} onClick={() => updateBlock({ ...block, checked: !block.checked })}><Icon name="arrow-right-s" className={cn('size-4 transition-transform', !toggled && 'rotate-90')} /></button>}
            {block.kind === 'callout' && <span className="shrink-0 leading-[1.65]">💡</span>}
            {block.kind === 'divider' ? <hr className="my-3 flex-1 border-border" />
              : block.kind === 'attachment' ? <button type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-interactive-hover" onClick={() => call({ command: 'open-attachment', blockID: block.id })}><Icon name="clipboard" className="size-4" />{block.text || t('folio.attach')}</button>
              : linked ? <button type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 font-medium underline decoration-border underline-offset-4 hover:bg-interactive-hover" onClick={() => call({ command: 'select', noteID: linked.id })}><FolioIcon value={linked.icon} />{linked.title || t('folio.untitled')}</button>
              : (block.kind === 'page' || block.kind === 'pageIn') && !block.text ? <select className="rounded-md bg-transparent px-1 py-0.5 text-sm text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.openPage')} value="" onChange={(e) => updateBlock({ ...block, asset: e.target.value })}><option value="">{t('folio.openPage')}…</option>{status.notes.filter((n) => !n.trashed && n.id !== note.id).map((n) => <option key={n.id} value={n.id}>{n.title || t('folio.untitled')}</option>)}</select>
              : <FolioRichBlock block={block} commitDelay={mobile ? MOBILE_COMMIT_DELAY : 0} lazy={Boolean(mobile)}
                placeholder={block.kind === 'text' ? t('folio.slashPlaceholder') : t(`folio.block.${block.kind}`)}
                focusAt={focus?.id === block.id ? focus.at : undefined}
                onChange={updateBlock}
                onFocus={(editor) => trackSelection(editor, block.id)}
                onBlur={() => setTimeout(() => { if (!bubbleRef.current?.contains(document.activeElement)) setBubble(undefined); }, 0)}
                onKind={(kind) => setKind(block.id, kind)}
                onRemoveEmpty={() => removeEmpty(block.id)}
                onSlash={setSlash}
                onSlashKey={onSlashKey}
                onMention={setMention}
                onOpenNote={openLinkedNote}
                onSplit={(before, after) => {
                  const current = latestNote(); if (!current) return;
                  const position = current.blocks.findIndex((b) => b.id === block.id); if (position < 0) return;
                  const original = current.blocks[position];
                  const carry: BlockKind = ['bullet', 'numbered', 'task'].includes(original.kind) ? original.kind : 'text';
                  const next: FolioBlock = { ...makeBlock(), ...after, kind: carry, indent: original.indent };
                  const blocks = [...current.blocks]; blocks.splice(position, 1, { ...original, ...before }, next);
                  edit({ ...current, blocks }); focusBlock(next.id, 'start');
                }} />}
                      </div>;
        })}
        {/* Pages and databases inside this page are listed in it, like Notion's nested pages. */}
        {(() => {
          const linked = new Set(note.blocks.flatMap((b) => (b.kind === 'page' || b.kind === 'pageIn') && b.asset ? [b.asset] : []));
          const inside = sortSiblings(status.notes.filter((n) => n.parentID === note.id && !n.trashed && !linked.has(n.id)));
          if (!inside.length) return null;
          return <div className="mt-4">{inside.map((child) => <button key={child.id} type="button" className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-interactive-hover" onClick={() => call({ command: 'select', noteID: child.id })}>
            <span className="flex w-6 justify-center"><FolioIcon value={child.icon} /></span>
            <span className="min-w-0 flex-1 truncate border-b border-border/70 pb-px">{child.title || t('folio.untitled')}</span>
          </button>)}</div>;
        })()}
        {/* Clicking the empty space below the last block continues writing, like Notion. */}
        <button type="button" className="block h-32 w-full cursor-text" aria-label={t('folio.newBlock')} onClick={() => {
          const last = note.blocks[note.blocks.length - 1];
          if (last && last.kind === 'text' && !last.text) focusBlock(last.id, 'end'); else insertAfter(last?.id, makeBlock());
        }} />
      </article>}
    </div>

    {slash && <div role="listbox" aria-label={t('folio.block')} className="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl"
      style={{ left: Math.min(slash.left, window.innerWidth - 300), top: slash.bottom + 330 < window.innerHeight ? slash.bottom + 6 : Math.max(8, slash.top - 330) }}
      onMouseDown={(e) => e.preventDefault()}>
      {slashResults.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('folio.noMatches')}</div>}
      {(['basic', 'databases'] as const).map((group) => {
        const items = slashResults.filter((c) => c.group === group);
        return items.length ? <div key={group}>
          <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">{t(group === 'basic' ? 'folio.basicBlocks' : 'folio.databases')}</div>
          {items.map((command) => { const i = slashResults.indexOf(command); return <button key={command.id} type="button" role="option" aria-selected={i === slashIndex}
            className={cn(menuItem, i === slashIndex && 'bg-interactive-selection')} onMouseMove={() => setSlashIndex(i)} onClick={() => applySlash(command)}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-xs font-semibold">{command.glyph ?? <Icon name={command.icon} className="size-4" />}</span>{command.label}
          </button>; })}
        </div> : null;
      })}
    </div>}

    {syncOpen && <FolioSyncDialog onClose={() => setSyncOpen(false)} />}
    {mention && <div role="listbox" aria-label={t('folio.linkPage')} className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl"
      style={{ left: Math.max(8, Math.min(mention.left, window.innerWidth - 296)), top: mention.bottom + 300 < window.innerHeight ? mention.bottom + 6 : Math.max(8, mention.top - 300) }}
      onMouseDown={(e) => e.preventDefault()}>
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">{t('folio.linkPage')}</div>
      {mentionResults.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('folio.noMatches')}</div>}
      {mentionResults.map((target, i) => <button key={target.id} type="button" role="option" aria-selected={i === mentionIndex} className={cn(menuItem, i === mentionIndex && 'bg-interactive-selection')}
        onMouseMove={() => setMentionIndex(i)} onClick={() => applyMention(target)}>
        <FolioIcon value={target.icon} /><span className="truncate">{target.title || t('folio.untitled')}</span>
      </button>)}
    </div>}

    {mobile && editing && active && (() => {
      const current = note?.blocks.find((b) => b.id === active.id);
      if (!current) return null;
      // Buttons never take focus, so the keyboard stays up and the caret stays put.
      const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();
      const key = 'flex h-10 min-w-10 shrink-0 items-center justify-center rounded-lg px-2 text-[15px] text-foreground active:bg-interactive-selection disabled:opacity-40';
      const kinds: BlockKind[] = ['text', 'heading1', 'heading2', 'heading3', 'bullet', 'numbered', 'task', 'toggle', 'quote', 'callout', 'code', 'divider'];
      return <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur" onPointerDown={keep} onMouseDown={keep}>
        {turnInto && <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {kinds.map((kind) => <button key={kind} type="button" className={cn(key, 'text-sm', current.kind === kind && 'bg-interactive-selection')} onClick={() => { setKind(current.id, kind); setTurnInto(false); }}>{t(`folio.block.${kind}`)}</button>)}
        </div>}
        <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-1" role="toolbar" aria-label={t('folio.block')}>
          <button type="button" className={cn(key, 'font-semibold', turnInto && 'bg-interactive-selection')} aria-label={t('folio.turnInto')} aria-expanded={turnInto} onClick={() => setTurnInto(!turnInto)}>Aa</button>
          <button type="button" className={cn(key, current.kind === 'task' && 'bg-interactive-selection')} aria-label={t('folio.block.task')} onClick={() => setKind(current.id, current.kind === 'task' ? 'text' : 'task')}><Icon name="checkbox" className="size-5" /></button>
          <button type="button" className={cn(key, current.kind === 'bullet' && 'bg-interactive-selection')} aria-label={t('folio.block.bullet')} onClick={() => setKind(current.id, current.kind === 'bullet' ? 'text' : 'bullet')}><Icon name="list-unordered" className="size-5" /></button>
          <button type="button" className={key} aria-label={t('folio.outdent')} disabled={!current.indent} onClick={() => updateBlock({ ...current, indent: (current.indent ?? 1) - 1 || undefined })}>⇤</button>
          <button type="button" className={key} aria-label={t('folio.indent')} disabled={(current.indent ?? 0) >= 8} onClick={() => updateBlock({ ...current, indent: (current.indent ?? 0) + 1 })}>⇥</button>
          <button type="button" className={key} aria-label={t('folio.up')} onClick={() => { move(current.id, -1); focusBlock(current.id, 'end'); }}><Icon name="arrow-up" className="size-5" /></button>
          <button type="button" className={key} aria-label={t('folio.down')} onClick={() => { move(current.id, 1); focusBlock(current.id, 'end'); }}><Icon name="arrow-down" className="size-5" /></button>
          <button type="button" className={key} aria-label={t('folio.undo')} onClick={() => { if (!active.editor.isDestroyed) active.editor.commands.undo(); }}><Icon name="arrow-go-back" className="size-5" /></button>
          <div className="flex-1" />
          <button type="button" className={key} aria-label={t('folio.hideKeyboard')} onClick={() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }}><Icon name="arrow-down-s" className="size-6" /></button>
        </div>
      </div>;
    })()}

    {bubble && active && !active.editor.isDestroyed && <div ref={bubbleRef} role="toolbar" aria-label={t('folio.block')} className="fixed z-50 flex flex-col gap-1.5 rounded-xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur" style={{ top: bubble.top, left: bubble.left, width: Math.min(420, window.innerWidth - 16) }} onMouseDown={(e) => e.preventDefault()}>
      <div className="flex items-center gap-0.5">
        {([['bold', 'B', 'font-bold'], ['italic', 'I', 'italic'], ['underline', 'U', 'underline'], ['strike', 'S', 'line-through'], ['code', '</>', 'font-mono']] as const).map(([format, glyph, style]) => <button key={format} type="button" className={cn('h-7 rounded-md px-2 text-sm hover:bg-interactive-hover', style, active.editor.isActive(format) && 'bg-interactive-selection')} title={t(`folio.${format}`)} aria-label={t(`folio.${format}`)} onClick={() => active.editor.chain().focus().toggleMark(format).run()}>{glyph}</button>)}
        <button type="button" className="h-7 rounded-md px-2 text-sm hover:bg-interactive-hover" onClick={() => setLinkOpen(!linkOpen)}>{t('folio.link')}</button>
      </div>
      {linkOpen && <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//i.test(link)) active.editor.chain().focus().setLink({ href: link }).run(); else if (!link) active.editor.chain().focus().unsetLink().run(); setLinkOpen(false); setLink(''); }}>
        <input className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm" aria-label={t('folio.link')} placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
        <button type="submit" className="rounded-md px-2 text-sm hover:bg-interactive-hover">✓</button>
      </form>}
      <div className="flex items-center gap-2"><span className="w-16 text-[11px] text-muted-foreground">{t('folio.textColor')}</span><Swatches compact kind="textColor" label={colorLabel('textColor')} onPick={(color) => paint('textColor', color)} /></div>
      <div className="flex items-center gap-2"><span className="w-16 text-[11px] text-muted-foreground">{t('folio.highlight')}</span><Swatches compact kind="highlight" label={colorLabel('highlight')} onPick={(color) => paint('highlight', color)} /></div>
    </div>}
  </div>
  {!mobile && askOpen && note && <FolioAskPanel note={note} onClose={() => setAskOpen(false)} />}
  </div>;
}
