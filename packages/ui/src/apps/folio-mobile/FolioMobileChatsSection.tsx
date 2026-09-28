import React from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isChatDirectoryPath, CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { sortProjectsByOrder } from '@/components/session/sidebar/list/projectSort';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { Session } from '@/lib/opencode/model';
import { getProjectLabel, normalizePath } from '../mobilePaths';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ProjectEntry } from '@/lib/api/types';
import { getSessionDirectory } from '../mobileSessionFields';
import { useIsWorkingOnMac, useWorkingSessionsWatch } from './workingSessions';

const PER_FOLDER = 5;
const row = 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[16px] active:bg-interactive-selection';

interface Folder { id: string; label: string; sessions: Session[]; project?: ProjectEntry }

/** The folder's own icon and color, exactly as the Mac sidebar shows them. */
function FolderIcon({ folder }: { folder: Folder }) {
  const { currentTheme } = useThemeSystem();
  const project = folder.project;
  const iconName = project?.icon ? PROJECT_ICON_MAP[project.icon] : undefined;
  const color = project?.color ? PROJECT_COLOR_MAP[project.color] : undefined;
  const fallback = <Icon name={folder.id === CHAT_DRAFT_PROJECT_ID ? 'chat-3' : iconName ?? 'folder'} className="size-5 shrink-0 text-muted-foreground" style={color ? { color } : undefined} />;
  if (!project?.iconImage) return fallback;
  return <span className="inline-flex size-5 shrink-0 overflow-hidden rounded" style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}>
    <ProjectIconImage project={{ id: project.id, iconImage: project.iconImage }} options={{ themeVariant: currentTheme.metadata.variant, iconColor: currentTheme.colors.surface.foreground }} className="h-full w-full object-contain" fallback={fallback} />
  </span>;
}

/**
 * One conversation in a folder, carrying the Mac's working dot when the Mac is
 * working on it. The dot is the same component, colour, size and motion the Mac
 * sidebar and the phone's own All chats list use, in the same place: right of the
 * title, before the date.
 */
function ChatRow({ session, onOpen }: { session: Session; onOpen: (session: Session) => void }) {
  const { t } = useI18n();
  const working = useIsWorkingOnMac(session.id);
  return <button type="button" className={cn(row, 'py-1.5 text-[15px]')} onClick={() => onOpen(session)}>
    <span className="min-w-0 flex-1 truncate">{session.title || t('folio.newChat')}</span>
    {working ? <SessionActivityIndicator state="running" label={t('sessions.sidebar.session.status.active')} /> : null}
    <span className="shrink-0 text-xs text-muted-foreground">{new Date(session.time.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
  </button>;
}

function FolderBlock({ folder, sortable, expanded, loading, onToggle, onOpen, onNew, onMore }: { folder: Folder; sortable: boolean; expanded: boolean; loading: boolean; onToggle: () => void; onOpen: (session: Session) => void; onNew: () => void; onMore: () => void }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id, disabled: !sortable });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && 'relative z-10 rounded-lg bg-secondary opacity-90')}>
    <button type="button" ref={setActivatorNodeRef} className={cn(row, 'select-none font-medium', sortable && 'touch-manipulation')} aria-expanded={expanded} onClick={onToggle} {...(sortable ? attributes : {})} {...(sortable ? listeners : {})}>
      <FolderIcon folder={folder} />
      <span className="min-w-0 flex-1 truncate">{folder.label}</span>
      <Icon name="arrow-right-s" className={cn('size-5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
    </button>
    {expanded && <div className="pl-7">
      <button type="button" className={cn(row, 'py-1.5 text-[15px] text-muted-foreground')} onClick={onNew}>
        <Icon name="add" className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{t('folio.newChatIn', { name: folder.label })}</span>
      </button>
      {/* Until the Mac has answered, an empty folder is "loading", never "no chats". */}
      {folder.sessions.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">{loading ? t('folio.chatsLoading') : t('folio.noChatsYet')}</p>}
      {folder.sessions.slice(0, PER_FOLDER).map((session) => <ChatRow key={session.id} session={session} onOpen={onOpen} />)}
      {folder.sessions.length > PER_FOLDER && <button type="button" className={cn(row, 'py-1.5 text-sm text-muted-foreground')} onClick={onMore}>{t('folio.showAllChats', { count: folder.sessions.length })}</button>}
    </div>}
  </div>;
}

/**
 * The Mac's OpenChamber chats on the phone's home, grouped by project folder like the Mac sidebar.
 * Folders collapse (shared with the chats drawer) and can be long-pressed and dragged into order,
 * which is the same project order the Mac uses. Hidden until the chats are connected to the Mac.
 */
export function MobileChatsSection({ onOpenChats, onOpenSessions }: { onOpenChats: () => void; onOpenSessions: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsStore((s) => s.projects);
  const manualOrder = useProjectsStore((s) => s.manualProjectOrder);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const sortOrder = useSessionDisplayStore((s) => s.projectSortOrder);
  const sessions = useGlobalSessionsStore((s) => s.activeSessions);
  // The working dot is only as good as the evidence behind it, and the list is the
  // surface that spends that evidence. Nothing else on the phone needs the Mac's
  // live activity re-checked, so it runs no further than these rows.
  useWorkingSessionsWatch();
  const expandedMap = useMobileSessionTreeStore((s) => s.projectExpanded);
  const setExpanded = useMobileSessionTreeStore((s) => s.setProjectExpanded);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const loaded = useGlobalSessionsStore((s) => s.hasLoaded);
  // Ask the Mac for its chat list whenever home is shown, the Mac connection changes, or its projects arrive,
  // so folders fill in right away instead of only after a chat has been opened.
  const hasProjects = projects.length > 0;
  React.useEffect(() => {
    let last = 0;
    const load = () => { if (Date.now() - last < 15_000) return; last = Date.now(); void refreshGlobalSessions().catch(() => undefined); };
    if (hasProjects) load();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => { last = 0; setTimeout(load, 1000); });
    return unsubscribe;
  }, [hasProjects]);
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
      list.push({ id: project.id, label: project.label ?? project.path, sessions: inside, project });
    }
    return list;
  }, [projects, manualOrder, sortOrder, sessions, t]);


  const toggleSection = () => setOpen((value) => { try { localStorage.setItem('folio.home.chatsCollapsed', value ? '1' : '0'); } catch { /* storage blocked */ } return !value; });
  const openSession = (session: Session) => { void setCurrentSession(session.id, getSessionDirectory(session) || null); onOpenChats(); };
  const newChat = (folder: Folder) => {
    const project = projects.find((p) => p.id === folder.id);
    if (project) openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
    else openNewSessionDraft({ target: 'chat', directoryOverride: null });
    onOpenChats();
  };
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
      <div className="flex-1" />
      {hasProjects && <button type="button" className="px-2 py-1 text-[15px] text-primary" onClick={onOpenSessions}>{t('folio.allChats')}</button>}
    </div>
    {open && !hasProjects && !sessions.length && <button type="button" className={cn(row, 'text-muted-foreground')} onClick={onOpenChats}>
      <Icon name="macbook" className="size-5 shrink-0" /><span className="min-w-0 flex-1 truncate">{t('folio.chatsConnecting')}</span>
    </button>}
    {open && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={folders.filter((f) => f.id !== CHAT_DRAFT_PROJECT_ID).map((f) => f.id)} strategy={verticalListSortingStrategy}>
        {folders.map((folder) => <FolderBlock key={folder.id} folder={folder} sortable={sortable && folder.id !== CHAT_DRAFT_PROJECT_ID}
          expanded={expandedMap[folder.id] ?? false} loading={!loaded} onToggle={() => setExpanded(folder.id, !(expandedMap[folder.id] ?? false))}
          onOpen={openSession} onNew={() => newChat(folder)} onMore={onOpenSessions} />)}
      </SortableContext>
    </DndContext>}
  </section>;
}
