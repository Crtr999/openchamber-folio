import React from 'react';
import { FolioIcon } from './FolioIcon';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import type { FolioNote } from '@/lib/folio/schema';
import { useUIStore } from '@/stores/useUIStore';

const rowClass = 'group/folio flex h-7 items-center gap-1 rounded-md pr-1 text-sm text-foreground/85 hover:bg-interactive-hover';

/**
 * Notes live in the same scroll list as project chats, directly under the project folders,
 * styled like Notion's sidebar: favorites first, then a nested page tree, then Trash.
 */
export function FolioSidebar() {
  const { t } = useI18n();
  const api = useFolioStore((s) => s.api);
  const notes = useFolioStore((s) => s.status?.notes);
  const selectedID = useFolioStore((s) => (s.open && !s.home ? s.status?.selectedID : undefined));
  const homeOpen = useFolioStore((s) => s.open && s.home);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [showTrash, setShowTrash] = React.useState(false);
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

  const row = (note: FolioNote, depth: number, allowChildren: boolean): React.ReactNode => {
    const children = allowChildren ? byParent.get(note.id) ?? [] : [];
    const isOpen = expanded.has(note.id);
    return <React.Fragment key={`${allowChildren ? 't' : 'f'}-${note.id}`}>
      <div className={cn(rowClass, selectedID === note.id && 'bg-interactive-selection text-foreground')} style={{ paddingLeft: 4 + depth * 14 }}>
        <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover" aria-label={note.title || t('folio.untitled')} aria-expanded={allowChildren ? isOpen : undefined} onClick={() => allowChildren ? toggle(note.id) : open(note)}>
          <span className={cn(allowChildren && 'group-hover/folio:hidden')}><FolioIcon value={note.icon} /></span>
          {allowChildren && <Icon name="arrow-right-s" className={cn('hidden size-4 group-hover/folio:block transition-transform', isOpen && 'rotate-90')} />}
        </button>
        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => open(note)}>{note.title || t('folio.untitled')}</button>
        {allowChildren && <button type="button" className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover group-hover/folio:flex" aria-label={t('folio.addInside')} title={t('folio.addInside')} onClick={() => create(note.id)}>
          <Icon name="add" className="size-3.5" />
        </button>}
      </div>
      {allowChildren && isOpen && (children.length
        ? children.map((child) => row(child, depth + 1, true))
        : <div className="h-6 text-xs text-muted-foreground/70" style={{ paddingLeft: 30 + (depth + 1) * 14 }}>{t('folio.empty')}</div>)}
    </React.Fragment>;
  };

  return <section className="mt-3 pb-2" aria-label={t('folio.notes')}>
    {favorites.length > 0 && <>
      <div className="px-1.5 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">{t('folio.favorites')}</div>
      {favorites.map((note) => row(note, 0, false))}
    </>}
    <div className={cn(rowClass, 'mt-1 pl-1', homeOpen && 'bg-interactive-selection')}>
      <button type="button" className="min-w-0 flex-1 truncate px-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => { leave(); void useFolioStore.getState().openHome(); }}>{t('folio.notes')}</button>
      <button type="button" className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.newPage')} title={t('folio.newPage')} onClick={() => create()}>
        <Icon name="add" className="size-3.5" />
      </button>
    </div>
    {(byParent.get('') ?? []).map((note) => row(note, 0, true))}
    {live.length === 0 && <button type="button" className={cn(rowClass, 'w-full pl-2 text-muted-foreground')} onClick={() => create()}>+ {t('folio.newPage')}</button>}
    {trashed.length > 0 && <>
      <button type="button" className={cn(rowClass, 'mt-1 w-full pl-2 text-muted-foreground')} aria-expanded={showTrash} onClick={() => setShowTrash(!showTrash)}>
        <Icon name="delete-bin" className="size-3.5" /><span>{t('folio.trash')}</span><span className="ml-auto text-xs">{trashed.length}</span>
      </button>
      {showTrash && trashed.map((note) => row(note, 1, false))}
    </>}
  </section>;
}
