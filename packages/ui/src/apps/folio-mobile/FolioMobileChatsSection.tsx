import React from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isChatDirectoryPath, CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { sortProjectsByOrder } from '@/components/session/sidebar/list/projectSort';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { Session } from '@/lib/opencode/model';
import { getProjectLabel, normalizePath } from '../mobilePaths';
import { getSessionDirectory } from '../mobileSessionFields';

const PER_FOLDER = 5;
const row = 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[16px] active:bg-interactive-selection';

interface Folder { id: string; label: string; sessions: Session[] }

function FolderBlock({ folder, sortable, expanded, onToggle, onOpen, onMore }: { folder: Folder; sortable: boolean; expanded: boolean; onToggle: () => void; onOpen: (session: Session) => void; onMore: () => void }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id, disabled: !sortable });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'relative z-10 rounded-lg bg-secondary opacity-90')}>
    <button type="button" ref={setActivatorNodeRef} className={cn(row, 'select-none font-medium', sortable && 'touch-manipulation')} aria-expanded={expanded} onClick={onToggle} {...(sortable ? attributes : {})} {...(sortable ? listeners : {})}>
      <Icon name={folder.id === CHAT_DRAFT_PROJECT_ID ? 'chat-3' : 'folder'} className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{folder.label}</span>
      <Icon name="arrow-right-s" className={cn('size-5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
    </button>
    {expanded && <div className="pl-7">
      {folder.sessions.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('folio.noChatsYet')}</p>}
      {folder.sessions.slice(0, PER_FOLDER).map((session) => <button key={session.id} type="button" className={cn(row, 'py-1.5 text-[15px]')} onClick={() => onOpen(session)}>
        <span className="min-w-0 flex-1 truncate">{session.title || t('folio.newChat')}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{new Date(session.time.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </button>)}
      {folder.sessions.length > PER_FOLDER && <button type="button" className={cn(row, 'py-1.5 text-sm text-muted-foreground')} onClick={onMore}>{t('folio.showAllChats', { count: folder.sessions.length })}</button>}
    </div>}
  </div>;
}

/**
 * The Mac's OpenChamber chats on the phone's home, grouped by project folder like the Mac sidebar.
 * Folders collapse (shared with the chats drawer) and can be long-pressed and dragged into order,
 * which is the same project order the Mac uses. Hidden until the chats are connected to the Mac.
 */
export function MobileChatsSection({ onOpenChats }: { onOpenChats: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsStore((s) => s.projects);
  const manualOrder = useProjectsStore((s) => s.manualProjectOrder);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const sortOrder = useSessionDisplayStore((s) => s.projectSortOrder);
  const sessions = useGlobalSessionsStore((s) => s.activeSessions);
  const expandedMap = useMobileSessionTreeStore((s) => s.projectExpanded);
  const setExpanded = useMobileSessionTreeStore((s) => s.setProjectExpanded);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
  const [open, setOpen] = React.useState(() => { try { return localStorage.getItem('folio.home.chatsCollapsed') !== '1'; } catch { return true; } });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const folders = React.useMemo(() => {
    const top = sessions.filter((s) => !s.parentID).sort((a, b) => b.time.updated - a.time.updated);
    const ordered = sortProjectsByOrder(projects.map((p) => ({ ...p, label: p.label?.trim() || getProjectLabel(p.path), path: normalizePath(p.path) })), sortOrder, manualOrder);
    const taken = new Set<string>();
    const list: Folder[] = [];
    const chats = top.filter((s) => isChatDirectoryPath(getSessionDirectory(s)));
    chats.forEach((s) => taken.add(s.id));
    if (chats.length) list.push({ id: CHAT_DRAFT_PROJECT_ID, label: t('folio.chats'), sessions: chats });
    for (const project of ordered) {
      const inside = top.filter((s) => !taken.has(s.id) && normalizePath(getSessionDirectory(s)).startsWith(project.path));
      inside.forEach((s) => taken.add(s.id));
      list.push({ id: project.id, label: project.label ?? project.path, sessions: inside });
    }
    return list;
  }, [projects, manualOrder, sortOrder, sessions, t]);

  if (!projects.length && !sessions.length) return null;
  const toggleSection = () => setOpen((value) => { try { localStorage.setItem('folio.home.chatsCollapsed', value ? '1' : '0'); } catch { /* storage blocked */ } return !value; });
  const openSession = (session: Session) => { void setCurrentSession(session.id, getSessionDirectory(session) || null); onOpenChats(); };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = projects.findIndex((p) => p.id === active.id);
    const to = projects.findIndex((p) => p.id === over.id);
    if (from >= 0 && to >= 0) reorderProjects(from, to);
  };
  const sortable = sortOrder === 'manual';

  return <section className="mb-4">
    <div className="flex items-center px-2 pb-1 pt-2">
      <button type="button" className="flex items-center gap-1 text-[15px] font-medium text-muted-foreground" aria-expanded={open} onClick={toggleSection}>
        {t('folio.chats')}<Icon name="arrow-down-s" className={cn('size-4 transition-transform', !open && '-rotate-90')} />
      </button>
    </div>
    {open && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={folders.filter((f) => f.id !== CHAT_DRAFT_PROJECT_ID).map((f) => f.id)} strategy={verticalListSortingStrategy}>
        {folders.map((folder) => <FolderBlock key={folder.id} folder={folder} sortable={sortable && folder.id !== CHAT_DRAFT_PROJECT_ID}
          expanded={expandedMap[folder.id] ?? false} onToggle={() => setExpanded(folder.id, !(expandedMap[folder.id] ?? false))}
          onOpen={openSession} onMore={onOpenChats} />)}
      </SortableContext>
    </DndContext>}
  </section>;
}
