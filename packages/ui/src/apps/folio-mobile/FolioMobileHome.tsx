import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FolioIcon } from '@/components/folio/FolioIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findHit } from '@/lib/folio/search';
import { useFolioStore } from '@/lib/folio/store';
import type { FolioNote } from '@/lib/folio/schema';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reorderSiblings, sortSiblings } from '@/lib/folio/order';
import { useMobileChatStore } from './chatStore';
import { MobileChatsSection } from './FolioMobileChatsSection';
import { FolioHabits } from '@/components/folio/FolioHabits';
import { useHandoffStore } from '@/lib/folio/handoff';
import { useSyncStore } from './sync';

/** Screens reached from the phone's home: notes, search, calendar and the assistant's conversations. */
export type MobileView = 'home' | 'notes' | 'search' | 'calendar' | 'assistant' | 'chat' | 'chats' | 'settings';

const row = 'flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-[17px] active:bg-interactive-selection';
const pill = 'flex h-12 items-center justify-center rounded-full bg-secondary text-muted-foreground active:bg-interactive-selection';

const live = (notes: readonly FolioNote[] | undefined) => (notes ?? []).filter((n) => !n.trashed && !n.isChat);

function useOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = React.useState(() => { try { return localStorage.getItem(key) !== '1'; } catch { return true; } });
  return [open, () => setOpen((value) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* storage blocked */ } return !value; })];
}

function Section({ title, open, onToggle, action, count, children }: { title: string; open: boolean; onToggle: () => void; action?: React.ReactNode; count?: number; children: React.ReactNode }) {
  return <section className="mb-4">
    <div className="flex items-center px-2 pb-1 pt-2">
      <button type="button" className="flex items-center gap-1 text-[15px] font-medium text-muted-foreground" aria-expanded={open} onClick={onToggle}>
        {title}<Icon name="arrow-down-s" className={cn('size-4 transition-transform', !open && '-rotate-90')} />
        {/* A closed section still says how much is inside, so it never looks empty. */}
        {!open && count !== undefined && <span className="ml-1 rounded-full bg-secondary px-2 text-xs tabular-nums">{count}</span>}
      </button>
      <div className="flex-1" />{action}
    </div>
    {open && children}
  </section>;
}

function TreeRow({ note, depth, notes, openNote, expanded, onToggle }: { note: FolioNote; depth: number; notes: readonly FolioNote[]; openNote: (id: string) => void; expanded: Set<string>; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: note.id });
  const hasChildren = notes.some((n) => n.parentID === note.id);
  const open = expanded.has(note.id);
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'relative z-10 rounded-lg bg-secondary opacity-90')}>
    <div className="flex items-center" style={{ paddingLeft: depth * 18 }}>
      {/* Long-press the page to drag it among its siblings; a tap opens it. */}
      <button type="button" ref={setActivatorNodeRef} className={cn(row, 'min-w-0 flex-1 select-none touch-manipulation')} onClick={() => openNote(note.id)} {...attributes} {...listeners}>
        <span className="flex w-7 shrink-0 justify-center text-[20px]"><FolioIcon value={note.icon} /></span>
        <span className="min-w-0 flex-1 truncate">{note.title || t('folio.untitled')}</span>
      </button>
      {hasChildren && <button type="button" className="flex size-10 shrink-0 items-center justify-center text-muted-foreground" aria-expanded={open} aria-label={open ? t('folio.collapse') : t('folio.expand')} onClick={() => onToggle(note.id)}>
        <Icon name="arrow-right-s" className={cn('size-5 transition-transform', open && 'rotate-90')} />
      </button>}
    </div>
    {open && <Tree notes={notes} parentID={note.id} depth={depth + 1} openNote={openNote} expanded={expanded} onToggle={onToggle} />}
  </div>;
}

function Tree({ notes, parentID, depth, openNote, expanded, onToggle }: { notes: readonly FolioNote[]; parentID?: string; depth: number; openNote: (id: string) => void; expanded: Set<string>; onToggle: (id: string) => void }) {
  const children = sortSiblings(notes.filter((n) => (n.parentID && notes.some((p) => p.id === n.parentID) ? n.parentID : undefined) === parentID));
  return <SortableContext items={children.map((n) => n.id)} strategy={verticalListSortingStrategy}>
    {children.map((note) => <TreeRow key={note.id} note={note} depth={depth} notes={notes} openNote={openNote} expanded={expanded} onToggle={onToggle} />)}
  </SortableContext>;
}

/** The page the Mac had open at the last sync (and the passage, when reading): one tap to continue on the phone. */
function ContinueFromMac({ openNote }: { openNote: (id: string) => void }) {
  const { t } = useI18n();
  const focus = useSyncStore((s) => s.macFocus);
  const local = useHandoffStore((s) => s.local);
  const notes = useFolioStore((s) => s.status?.notes);
  const note = focus ? notes?.find((n) => n.id.toUpperCase() === focus.noteID.toUpperCase() && !n.trashed) : undefined;
  // Only when the Mac moved on more recently than this phone, and not days ago.
  if (!focus || !note || (local && local.at >= focus.at) || Date.now() - focus.at > 3 * 86_400_000) return null;
  return <button type="button" className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-secondary px-4 py-3 text-left active:bg-interactive-selection"
    onClick={() => { openNote(note.id); if (focus.reading) useHandoffStore.getState().openReader(note.id, focus.blockID); }}>
    <Icon name="macbook" className="size-6 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{focus.reading ? t('folio.continueReadingFromMac') : t('folio.continueFromMac')}</span><span className="block truncate text-[16px] font-medium">{note.title || t('folio.untitled')}</span></span>
    <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />
  </button>;
}

/** Home, laid out like Notion on iPhone: tabs up top, recents and the page tree, search / ask / new page at the bottom. */
export function MobileHome({ onView, onOpenNote: openNote, onNewPage, onAsk }: { onView: (view: MobileView) => void; onOpenNote: (id: string) => void; onNewPage: () => void; onAsk: () => void }) {
  const { t } = useI18n();
  const notes = live(useFolioStore((s) => s.status?.notes));
  const pairing = useSyncStore((s) => s.pairing);
  const soon = useFolioStore((s) => s.status?.events.some((e) => e.start - Date.now() < 60 * 60_000 && e.end > Date.now()));
  const [todayOpen, toggleToday] = useOpen('folio.home.v2.todayCollapsed');
  const [recentOpen, toggleRecent] = useOpen('folio.home.v2.recentCollapsed');
  const [favoritesOpen, toggleFavorites] = useOpen('folio.home.v2.favoritesCollapsed');
  const [treeOpen, toggleTree] = useOpen('folio.home.v2.notesCollapsed');
  const [more, setMore] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const favorites = sortSiblings(notes.filter((n) => n.favorite));
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  const toggleNode = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const parentOf = (id: string) => { const note = notes.find((n) => n.id === id); return note?.parentID && notes.some((p) => p.id === note.parentID) ? note.parentID : ''; };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = String(active.id), target = String(over.id);
    const key = parentOf(moved);
    if (key !== parentOf(target)) return;
    for (const note of reorderSiblings(notes.filter((n) => parentOf(n.id) === key), moved, target)) useFolioStore.getState().edit(note);
  };
  const recents = [...notes].sort((a, b) => b.modified - a.modified).slice(0, 8);
  const initial = (pairing?.name.trim()[0] ?? 'F').toUpperCase();

  return <div className="relative flex h-full flex-col">
    <nav className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3" aria-label={t('folio.menu')}>
      <button type="button" className="flex size-12 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-lg font-medium text-muted-foreground" aria-label={t('folio.settings')} onClick={() => onView('settings')}>{initial}</button>
      <div className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-secondary px-4 text-[17px] font-medium" aria-current="page"><Icon name="home" className="size-5" />{t('folio.home')}</div>
      <button type="button" className={cn(pill, 'w-14')} aria-label={t('folio.chats')} onClick={() => onView('chats')}><Icon name="chat-3" className="size-5" /></button>
      <button type="button" className={cn(pill, 'relative w-14')} aria-label={t('folio.calendar')} onClick={() => onView('calendar')}>
        <Icon name="calendar" className="size-5" />{soon && <span className="absolute right-3 top-2.5 size-2 rounded-full bg-[var(--status-error)]" />}
      </button>
      <button type="button" className={cn(pill, 'w-14')} aria-label={t('folio.offlineChat')} onClick={() => onView('assistant')}><Icon name="inbox" className="size-5" /></button>
    </nav>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-32">
      <ContinueFromMac openNote={openNote} />
      <Section title={t('folio.today')} open={todayOpen} onToggle={toggleToday}>
        <div className="px-2 pb-1"><FolioHabits compact /></div>
      </Section>
      <Section title={t('folio.recent')} open={recentOpen} onToggle={toggleRecent} count={recents.length}>
        {recents.map((note) => <button key={note.id} type="button" className={row} onClick={() => openNote(note.id)}>
          <span className="flex w-7 shrink-0 justify-center text-[20px]"><FolioIcon value={note.icon} /></span>
          <span className="min-w-0 flex-1 truncate">{note.title || t('folio.untitled')}</span>
        </button>)}
      </Section>
      <MobileChatsSection onOpenChats={() => onView('chats')} />
      {favorites.length > 0 && <Section title={t('folio.favorites')} open={favoritesOpen} onToggle={toggleFavorites} count={favorites.length}>
        {favorites.map((note) => <button key={note.id} type="button" className={row} onClick={() => openNote(note.id)}>
          <span className="flex w-7 shrink-0 justify-center text-[20px]"><FolioIcon value={note.icon} /></span>
          <span className="min-w-0 flex-1 truncate">{note.title || t('folio.untitled')}</span>
        </button>)}
      </Section>}
      <Section title={t('folio.privatePages')} open={treeOpen} onToggle={toggleTree} count={notes.filter((n) => !n.parentID || !notes.some((p) => p.id === n.parentID)).length}
        action={<div className="relative">
          <button type="button" className="flex size-9 items-center justify-center text-muted-foreground" aria-label={t('folio.more')} aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more-fill" className="size-5" /></button>
          {more && <>
            <div className="fixed inset-0 z-40" onClick={() => setMore(false)} />
            <div className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border bg-background p-1.5 shadow-2xl">
              <button type="button" className={cn(row, 'text-[15px]')} onClick={() => { setMore(false); onNewPage(); }}><Icon name="file-add" className="size-4 text-muted-foreground" />{t('folio.newPage')}</button>
              <button type="button" className={cn(row, 'text-[15px]')} onClick={() => { setMore(false); void useFolioStore.getState().run({ command: 'create', kind: 'table' }); }}><Icon name="table-2" className="size-4 text-muted-foreground" />{t('folio.table')}</button>
            </div>
          </>}
        </div>}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <Tree notes={notes} depth={0} openNote={openNote} expanded={expanded} onToggle={toggleNode} />
        </DndContext>
      </Section>
    </div>

    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-6 [background:linear-gradient(to_top,var(--background)_55%,transparent)]">
      <button type="button" className="pointer-events-auto flex size-14 shrink-0 items-center justify-center rounded-full border border-border bg-background shadow-lg" aria-label={t('folio.search')} onClick={() => onView('search')}><Icon name="search" className="size-6" /></button>
      <button type="button" className="pointer-events-auto flex h-14 min-w-0 flex-1 items-center gap-3 rounded-full border border-border bg-background pl-2 pr-4 text-[17px] text-muted-foreground shadow-lg" onClick={onAsk}>
        <span className="flex size-10 items-center justify-center rounded-full bg-secondary"><Icon name="sparkling" className="size-5 text-foreground" /></span>{t('folio.askAI')}
      </button>
      <button type="button" className="pointer-events-auto flex size-14 shrink-0 items-center justify-center rounded-full border border-border bg-background shadow-lg" aria-label={t('folio.newPage')} onClick={onNewPage}><Icon name="edit-2" className="size-6" /></button>
    </div>
  </div>;
}

function Back({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  const { t } = useI18n();
  return <header className="flex h-12 shrink-0 items-center gap-1 px-2">
    <button type="button" className="flex size-10 items-center justify-center rounded-full text-muted-foreground" aria-label={t('folio.goBack')} onClick={onBack}><Icon name="arrow-left-s" className="size-6" /></button>
    <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</h1>
    {action}
  </header>;
}

export function MobileSearch({ onBack, onAsk, onOpenNote: openNote }: { onBack: () => void; onAsk: (prompt: string) => void; onOpenNote: (id: string) => void }) {
  const { t } = useI18n();
  const notes = useFolioStore((s) => s.status?.notes);
  const [query, setQuery] = React.useState('');
  const trimmed = query.trim();
  const results = React.useMemo(() => trimmed
    ? rankByQuery((notes ?? []).filter((n) => !n.trashed), trimmed, (n) => [n.title, ...n.tags, n.blocks.map((b) => b.text).join(' ')]).slice(0, 20).map((note) => ({ note, hit: findHit(note, trimmed) }))
    : [], [notes, trimmed]);
  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-2 px-3 pb-2 pt-3">
      <div className="flex h-11 flex-1 items-center gap-2 rounded-full bg-secondary px-4">
        <Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
        <input autoFocus className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground" placeholder={t('folio.searchOrAsk')} aria-label={t('folio.searchOrAsk')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <button type="button" className="px-2 text-[16px] text-primary" onClick={onBack}>{t('folio.cancel')}</button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
      {trimmed && <button type="button" className={row} onClick={() => onAsk(trimmed)}><Icon name="sparkling" className="size-5 shrink-0 text-primary" /><span className="truncate">{t('folio.ask')}: “{trimmed}”</span></button>}
      {results.map(({ note, hit }) => <button key={note.id} type="button" className={cn(row, 'items-start')} onClick={() => {
        useFolioStore.getState().setFound(hit ? { noteID: note.id, blockID: hit.blockID, query: hit.match } : undefined);
        openNote(note.id);
      }}>
        <span className="mt-0.5 flex w-7 shrink-0 justify-center"><FolioIcon value={note.icon} /></span>
        <span className="min-w-0 flex-1"><span className="block truncate">{note.title || t('folio.untitled')}</span>
          {hit && <span className="line-clamp-2 text-sm text-muted-foreground">{hit.before}<mark className="rounded-sm bg-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] px-0.5 text-foreground">{hit.match}</mark>{hit.after}</span>}</span>
      </button>)}
      {trimmed && results.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{t('folio.noMatches')}</p>}
    </div>
  </div>;
}

export function MobileCalendar({ onBack, onOpened }: { onBack: () => void; onOpened: () => void }) {
  const { t } = useI18n();
  const status = useFolioStore((s) => s.status);
  const run = (command: 'calendar-connect' | 'calendar-refresh') => { void useFolioStore.getState().run({ command }); };
  React.useEffect(() => { if (status?.calendarConnected) run('calendar-refresh'); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- refresh once when opened
  const days = new Map<string, NonNullable<typeof status>['events']>();
  for (const event of status?.events ?? []) {
    const day = new Date(event.start).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return <div className="flex h-full flex-col">
    <Back title={t('folio.calendar')} onBack={onBack} />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
      {!status?.calendarConnected
        ? <button type="button" className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-3 text-[16px]" onClick={() => run('calendar-connect')}><Icon name="calendar" className="size-5" />{t('folio.connectCalendar')}</button>
        : <>
          <label className="mb-4 mt-2 flex items-center gap-3 rounded-xl bg-secondary px-4 py-3 text-[15px]">
            <span className="flex-1">{t('folio.meetingReminders')}</span>
            <input type="checkbox" className="size-5" checked={status.reminders} onChange={(e) => { void useFolioStore.getState().run({ command: 'calendar-reminders', flag: e.target.checked }); }} />
          </label>
          {days.size === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('folio.noEvents')}</p>}
          {[...days.entries()].map(([day, events]) => <section key={day} className="mb-5">
            <h2 className="mb-1 px-1 text-sm font-medium text-muted-foreground">{day}</h2>
            {events.map((event) => <button key={event.id} type="button" className={cn(row, 'items-start')} onClick={() => { void useFolioStore.getState().run({ command: 'calendar-prepare', eventID: event.id }).then(onOpened); }}>
              <span className="w-16 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">{new Date(event.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              <span className="min-w-0 flex-1"><span className="block truncate">{event.title}</span><span className="block truncate text-sm text-muted-foreground">{event.calendar}{event.joinURL ? ` · ${t('folio.videoCall')}` : ''}</span></span>
              <Icon name="file-add" className="mt-1 size-4 shrink-0 text-muted-foreground" />
            </button>)}
          </section>)}
        </>}
    </div>
  </div>;
}

/** The assistant's conversations: started here or on the Mac, continued from either. */
export function MobileAssistantList({ onBack, onOpen }: { onBack: () => void; onOpen: (id?: string) => void }) {
  const { t } = useI18n();
  const chats = useMobileChatStore((s) => s.chats);
  const notes = useFolioStore((s) => s.status?.notes);
  return <div className="flex h-full flex-col">
    <Back title={t('folio.offlineChat')} onBack={onBack} action={<button type="button" className="flex size-10 items-center justify-center text-muted-foreground" aria-label={t('folio.newChat')} onClick={() => onOpen(undefined)}><Icon name="chat-new" className="size-5" /></button>} />
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-10">
      {chats.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('folio.chatEmpty')}</p>}
      {chats.map((chat) => {
        const page = chat.pageID ? notes?.find((n) => n.id === chat.pageID) : undefined;
        const last = chat.messages.at(-1)?.content ?? '';
        return <button key={chat.id} type="button" className={cn(row, 'items-start')} onClick={() => onOpen(chat.id)}>
          <Icon name={page ? 'file-text' : 'chat-3'} className="mt-1 size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{chat.title || page?.title || t('folio.newChat')}</span>
            <span className="line-clamp-1 text-sm text-muted-foreground">{last}</span>
          </span>
          <span className="shrink-0 pt-1 text-xs text-muted-foreground">{new Date(chat.modified).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
        </button>;
      })}
    </div>
  </div>;
}
