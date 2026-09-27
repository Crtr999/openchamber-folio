import React from 'react';
import { createPortal } from 'react-dom';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FolioIcon } from './FolioIcon';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import { reorderSiblings, sortSiblings } from '@/lib/folio/order';
import type { FolioNote } from '@/lib/folio/schema';
import { useUIStore } from '@/stores/useUIStore';

const rowClass = 'group/folio flex h-7 items-center gap-1 rounded-md pr-1 text-sm text-foreground/85 hover:bg-interactive-hover';

/** Collapsed sections are remembered on this device. */
function useCollapsed(key: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = React.useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const toggle = () => setCollapsed((value) => { try { localStorage.setItem(key, value ? '0' : '1'); } catch { /* storage blocked */ } return !value; });
  return [collapsed, toggle];
}

function SectionHeader({ label, collapsed, onToggle, active, onOpen, action }: { label: string; collapsed: boolean; onToggle: () => void; active?: boolean; onOpen?: () => void; action?: React.ReactNode }) {
  return <div className={cn(rowClass, 'mt-1 pl-1', active && 'bg-interactive-selection')}>
    <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover" aria-expanded={!collapsed} aria-label={label} onClick={onToggle}>
      <Icon name="arrow-right-s" className={cn('size-4 transition-transform', !collapsed && 'rotate-90')} />
    </button>
    <button type="button" className="min-w-0 flex-1 truncate text-left text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onOpen ?? onToggle}>{label}</button>
    {action}
  </div>;
}

/** A page row that can be dragged among its siblings (drag on a Mac, long-press on touch). */
function SortableRow({ id, line, children }: { id: string; line: React.ReactNode; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  // Only the page's own line starts a drag, so nested pages drag on their own.
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'relative z-10 opacity-70')}>
    <div ref={setActivatorNodeRef} className="select-none" {...attributes} {...listeners}>{line}</div>
    {children}
  </div>;
}

/**
 * Notes live in the same scroll list as project chats, directly under the project folders,
 * styled like Notion's sidebar: favorites, then the page tree, then Trash. Favorites and Notes
 * collapse, and pages can be dragged into order among their siblings.
 */
export function FolioSidebar() {
  const { t } = useI18n();
  const api = useFolioStore((s) => s.api);
  const notes = useFolioStore((s) => s.status?.notes);
  const selectedID = useFolioStore((s) => (s.open && !s.home ? s.status?.selectedID : undefined));
  const homeOpen = useFolioStore((s) => s.open && s.home);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [showTrash, setShowTrash] = React.useState(false);
  const [menu, setMenu] = React.useState<{ note: FolioNote; x: number; y: number }>();
  const [favoritesCollapsed, toggleFavorites] = useCollapsed('folio.sidebar.favoritesCollapsed');
  const [notesCollapsed, toggleNotes] = useCollapsed('folio.sidebar.notesCollapsed');
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  // Opening a page inside other pages unfolds the tree down to it.
  React.useEffect(() => {
    if (!selectedID) return;
    const chain: string[] = [];
    for (let cursor = notes?.find((n) => n.id === selectedID)?.parentID, guard = 0; cursor && guard < 20; guard += 1) { chain.push(cursor); cursor = notes?.find((n) => n.id === cursor)?.parentID; }
    if (chain.length) setExpanded((old) => (chain.every((id) => old.has(id)) ? old : new Set([...old, ...chain])));
  }, [selectedID, notes]);
  if (!api) return null;

  const live = (notes ?? []).filter((note) => !note.trashed && !note.isChat);
  const trashed = (notes ?? []).filter((note) => note.trashed);
  const favorites = live.filter((note) => note.favorite);
  const byParent = new Map<string, FolioNote[]>();
  for (const note of live) {
    const key = note.parentID && live.some((p) => p.id === note.parentID) ? note.parentID : '';
    byParent.set(key, [...(byParent.get(key) ?? []), note]);
  }
  const leave = () => useUIStore.getState().closeMainSurfaces();
  const open = (note: FolioNote) => { leave(); void useFolioStore.getState().run({ command: 'select', noteID: note.id }); };
  const create = (parentID?: string) => {
    leave();
    if (parentID) setExpanded((old) => new Set(old).add(parentID));
    void useFolioStore.getState().run({ command: 'create', parentID });
  };
  const toggle = (id: string) => setExpanded((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const parentKey = (id: string) => { const note = live.find((n) => n.id === id); return note?.parentID && live.some((p) => p.id === note.parentID) ? note.parentID : ''; };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = String(active.id), target = String(over.id);
    const key = parentKey(moved);
    if (key !== parentKey(target)) return; // pages move among their own siblings
    for (const note of reorderSiblings(byParent.get(key) ?? [], moved, target)) useFolioStore.getState().edit(note);
  };

  const row = (note: FolioNote, depth: number, allowChildren: boolean): React.ReactNode => {
    const children = allowChildren ? sortSiblings(byParent.get(note.id) ?? []) : [];
    const isOpen = expanded.has(note.id);
    const hasChildren = allowChildren && children.length > 0;
    const line = <div className={cn(rowClass, selectedID === note.id && 'bg-interactive-selection text-foreground')} style={{ paddingLeft: 4 + depth * 14 }}
      onDoubleClick={(event) => { event.preventDefault(); setMenu({ note, x: event.clientX, y: event.clientY }); }}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ note, x: event.clientX, y: event.clientY }); }}>
      {/* Pages with pages inside always show their arrow, like Notion's tree. */}
      <button type="button" className={cn('flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover', !hasChildren && 'invisible')} aria-label={isOpen ? t('folio.collapse') : t('folio.expand')} aria-expanded={hasChildren ? isOpen : undefined} tabIndex={hasChildren ? 0 : -1} onClick={() => toggle(note.id)}>
        <Icon name="arrow-right-s" className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
      </button>
      <span className="flex size-5 shrink-0 items-center justify-center"><FolioIcon value={note.icon} /></span>
      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => open(note)}>{note.title || t('folio.untitled')}</button>
      {allowChildren && <button type="button" className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover group-hover/folio:flex" aria-label={t('folio.addInside')} title={t('folio.addInside')} onClick={() => create(note.id)}>
        <Icon name="add" className="size-3.5" />
      </button>}
    </div>;
    if (!allowChildren) return <React.Fragment key={`f-${note.id}`}>{line}</React.Fragment>;
    return <SortableRow key={note.id} id={note.id} line={line}>
      {isOpen && (children.length
        ? <SortableContext items={children.map((c) => c.id)} strategy={verticalListSortingStrategy}>{children.map((child) => row(child, depth + 1, true))}</SortableContext>
        : <div className="h-6 text-xs text-muted-foreground/70" style={{ paddingLeft: 30 + (depth + 1) * 14 }}>{t('folio.empty')}</div>)}
    </SortableRow>;
  };
  const roots = sortSiblings(byParent.get('') ?? []);

  return <section className="mt-3 pb-2" aria-label={t('folio.notes')}>
    {favorites.length > 0 && <>
      <SectionHeader label={t('folio.favorites')} collapsed={favoritesCollapsed} onToggle={toggleFavorites} />
      {!favoritesCollapsed && favorites.map((note) => row(note, 0, false))}
    </>}
    <SectionHeader label={t('folio.notes')} collapsed={notesCollapsed} onToggle={toggleNotes} active={homeOpen}
      onOpen={() => { leave(); void useFolioStore.getState().openHome(); }}
      action={<button type="button" className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.newPage')} title={t('folio.newPage')} onClick={() => create()}>
        <Icon name="add" className="size-3.5" />
      </button>} />
    {!notesCollapsed && <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={roots.map((n) => n.id)} strategy={verticalListSortingStrategy}>
          {roots.map((note) => row(note, 0, true))}
        </SortableContext>
      </DndContext>
      {live.length === 0 && <button type="button" className={cn(rowClass, 'w-full pl-2 text-muted-foreground')} onClick={() => create()}>+ {t('folio.newPage')}</button>}
      {trashed.length > 0 && <>
        <button type="button" className={cn(rowClass, 'mt-1 w-full pl-2 text-muted-foreground')} aria-expanded={showTrash} onClick={() => setShowTrash(!showTrash)}>
          <Icon name="delete-bin" className="size-3.5" /><span>{t('folio.trash')}</span><span className="ml-auto text-xs">{trashed.length}</span>
        </button>
        {showTrash && trashed.map((note) => row(note, 1, false))}
      </>}
    </>}
    {/* In a portal: the sidebar clips and transforms its content, which cut the menu off at its edge. */}
    {menu && createPortal(<>
      <div className="fixed inset-0 z-50" onClick={() => setMenu(undefined)} onContextMenu={(e) => { e.preventDefault(); setMenu(undefined); }} />
      <div role="menu" className="fixed z-50 w-52 rounded-xl border border-border bg-background p-1.5 text-sm shadow-2xl" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 220) }}>
        {([
          ['file-text', t('folio.open'), () => open(menu.note)],
          ['add', t('folio.addInside'), () => create(menu.note.id)],
          ['star', menu.note.favorite ? t('folio.unfavorite') : t('folio.favorite'), () => useFolioStore.getState().edit({ ...menu.note, favorite: !menu.note.favorite })],
          ['file-copy', t('folio.duplicate'), () => { void useFolioStore.getState().run({ command: 'duplicate', noteID: menu.note.id }); }],
        ] satisfies [IconName, string, () => void][]).map(([icon, label, action]) => <button key={label} type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-interactive-hover" onClick={() => { setMenu(undefined); action(); }}>
          <Icon name={icon} className="size-4 text-muted-foreground" />{label}
        </button>)}
        <div className="my-1 border-t border-border" />
        <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-interactive-hover"
          onClick={() => { const target = menu.note; setMenu(undefined); void useFolioStore.getState().run({ command: 'trash', noteID: target.id, flag: target.trashed }); }}>
          <Icon name="delete-bin" className="size-4" />{menu.note.trashed ? t('folio.restore') : t('folio.moveToTrash')}
        </button>
      </div>
    </>, document.body)}
  </section>;
}
