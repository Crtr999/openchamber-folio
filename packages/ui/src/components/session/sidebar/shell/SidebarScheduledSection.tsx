import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { Button } from '@/components/ui/button';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { markSessionViewed, useNotificationStore } from '@/sync/notification-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { deleteScheduledTask, deleteScheduledTaskLoopFile, fetchScheduledTasks, runScheduledTaskNow, upsertScheduledTask } from '@/lib/scheduledTasksApi';
import { ScheduledTaskEditorDialog } from '@/components/session/ScheduledTaskEditorDialog';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { formatCompactUntil, sortSidebarScheduledTasks, scheduledRunActivity, type SidebarScheduledTask } from './sidebarScheduled';

const CompanionPanel = React.lazy(() => import('@/apps/CompanionPanel').then(module => ({ default: module.CompanionPanel })));

const unreadInboxSchema = z.object({ inbox: z.array(z.object({ id: z.string(), seen: z.boolean() })) });

const COLLAPSED_STORAGE_KEY = 'oc.sidebar.scheduledCollapsed';
const REFRESH_MS = 60_000;

const readCollapsed = (): boolean => {
  try { return getSafeStorage().getItem(COLLAPSED_STORAGE_KEY) === '1'; } catch { return false; }
};
const writeCollapsed = (collapsed: boolean) => {
  try { getSafeStorage().setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
};

/** Scheduled tasks from every project, listed at the top of the sidebar next to chats. */
export const SidebarScheduledSection: React.FC<{ mobileVariant: boolean; onNavigate?: () => void }> = ({ mobileVariant, onNavigate }) => {
  const { t } = useI18n();
  const statuses = useGlobalSessionStatusStore(state => state.statusById);
  const pending = useGlobalBlockingRequestsStore(state => state.bySession);
  const unread = useNotificationStore(state => state.index.session.unseenCount);
  const [followupsOpen, setFollowupsOpen] = React.useState(false);
  const closeFollowups = React.useCallback(() => setFollowupsOpen(false), []);
  const projects = useProjectsStore((state) => state.projects);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setScheduledOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const [companionUnread, setCompanionUnread] = React.useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const reloadRevision = React.useRef(0);
  const [items, setItems] = React.useState<SidebarScheduledTask[]>([]);
  const [editorTask, setEditorTask] = React.useState<ScheduledTask | null>(null);
  const [editorProjectId, setEditorProjectId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState(readCollapsed);
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  const projectKey = projects.map((project) => project.id).join('|');
  const reload = React.useCallback(async () => {
    const revision = ++reloadRevision.current;
    const runtime = getRuntimeKey();
    const results = await Promise.all(projects.map(async (project) => {
      try {
        const tasks = (await fetchScheduledTasks(project.id)).map(task => ({ task, project }));
        let unseen: Set<string> | undefined;
        if (tasks.some(item => item.task.id.startsWith('companion:'))) {
          try {
            const response = await runtimeFetch(`/api/projects/${encodeURIComponent(project.id)}/companion/inbox`);
            if (!response.ok) throw new Error('Could not read follow-up inbox');
            const inbox = unreadInboxSchema.parse(await response.json());
            unseen = new Set(inbox.inbox.filter(entry => !entry.seen).map(entry => entry.id));
          } catch { /* Preserve this project's last confirmed unread state. */ }
        } else unseen = new Set();
        return { projectId: project.id, tasks, unseen };
      } catch { return { projectId: project.id, tasks: null, unseen: undefined }; }
    }));
    if (runtime !== getRuntimeKey() || revision !== reloadRevision.current) return;
    setItems(previous => sortSidebarScheduledTasks(results.flatMap(result => result.tasks ?? previous.filter(item => item.project.id === result.projectId))));
    setCompanionUnread(previous => {
      const next = new Map(previous);
      for (const result of results) if (result.unseen) next.set(result.projectId, result.unseen);
      return next;
    });
    setNow(Date.now());
    // projectKey stands in for `projects`: reload only when the set of projects changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  React.useEffect(() => {
    void reload();
    const timer = setInterval(() => { void reload(); }, REFRESH_MS);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran' && event.type !== 'companion-changed') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void reload(); }, 400);
    });
    const runtimeUnsubscribe = subscribeRuntimeEndpointChanged(() => { reloadRevision.current++; setItems([]); setCompanionUnread(new Map()); void reload(); });
    return () => { reloadRevision.current++; clearInterval(timer); if (debounce) clearTimeout(debounce); unsubscribe(); runtimeUnsubscribe(); };
  }, [reload]);

  // Pick up edits made on the Scheduled page as soon as it closes.
  const wasScheduledOpen = React.useRef(isScheduledOpen);
  React.useEffect(() => {
    if (wasScheduledOpen.current && !isScheduledOpen) void reload();
    wasScheduledOpen.current = isScheduledOpen;
  }, [isScheduledOpen, reload]);

  const acknowledgeUnread = React.useCallback((projectId: string, sessionId?: string) => {
    if (!sessionId) return;
    markSessionViewed(sessionId);
    setCompanionUnread(previous => {
      const current = previous.get(projectId);
      if (!current?.has(sessionId)) return previous;
      const nextSet = new Set(current);
      nextSet.delete(sessionId);
      const next = new Map(previous);
      next.set(projectId, nextSet);
      return next;
    });
    void runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/companion/inbox/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seen: true }),
    }).catch(() => { /* ignore if not a companion inbox entry */ });
  }, []);

  React.useEffect(() => {
    if (!currentSessionId) return;
    for (const item of items) {
      if (item.task.state.lastSessionId === currentSessionId && (unread[currentSessionId] || companionUnread.get(item.project.id)?.has(currentSessionId))) {
        acknowledgeUnread(item.project.id, currentSessionId);
      }
    }
  }, [acknowledgeUnread, companionUnread, currentSessionId, items, unread]);

  const hasUnread = (item: SidebarScheduledTask) => Boolean(unread[item.task.state.lastSessionId || ''] || companionUnread.get(item.project.id)?.has(item.task.state.lastSessionId || ''));
  const hasAnyCompanionUnread = React.useMemo(() => {
    for (const set of companionUnread.values()) {
      if (set.size > 0) return true;
    }
    return items.some(item => item.task.id.startsWith('companion:') && Boolean(unread[item.task.state.lastSessionId || '']));
  }, [companionUnread, items, unread]);

  const toggle = () => { const next = !collapsed; setCollapsed(next); writeCollapsed(next); };
  const openManager = () => {
    for (const item of items) {
      if (hasUnread(item)) acknowledgeUnread(item.project.id, item.task.state.lastSessionId);
    }
    onNavigate?.();
    setScheduledOpen(true);
  };
  /**
   * A scheduled task is its own thing: clicking one opens it, so the
   * instructions it will run can be read and changed there. Jumping to the
   * last run showed what happened, not what will happen.
   */
  const openTask = ({ task, project }: SidebarScheduledTask) => {
    acknowledgeUnread(project.id, task.state.lastSessionId);
    setEditorProjectId(project.id);
    setEditorTask(task);
  };

  const saveTask = async (draft: Partial<ScheduledTask>) => {
    const projectId = editorProjectId;
    if (!projectId) return;
    await upsertScheduledTask(projectId, draft);
    toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
    await reload();
  };

  const runNow = async ({ task, project }: SidebarScheduledTask) => {
    setRunningId(task.id);
    try {
      const { sessionId } = await runScheduledTaskNow(project.id, task.id);
      toast.success(t('sessions.sidebar.scheduled.started', { name: task.name }));
      await Promise.all([reload(), refreshGlobalSessions()]);
      if (sessionId) {
        onNavigate?.();
        useUIStore.getState().closeMainSurfaces();
        useSessionUIStore.getState().setCurrentSession(sessionId, project.path ?? null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.sidebar.scheduled.runFailed', { name: task.name }));
    } finally {
      setRunningId(null);
    }
  };

  const describe = ({ task, project }: SidebarScheduledTask): string => {
    const lines = [task.name, project.label?.trim() || project.path];
    const next = task.state?.nextRunAt;
    if (task.enabled && next) {
      const day = new Date(next).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      lines.push(t('sessions.sidebar.scheduled.next', { time: `${day} ${formatTimeForPreference(next, timeFormatPreference)}` }));
    }
    const last = task.state?.lastRunAt;
    lines.push(last ? t('sessions.sidebar.scheduled.lastRan', { time: `${new Date(last).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatTimeForPreference(last, timeFormatPreference)}` }) : t('sessions.sidebar.scheduled.neverRan'));
    if (task.state?.lastStatus === 'error' && task.state.lastError) lines.push(t('sessions.sidebar.scheduled.lastFailed', { error: task.state.lastError }));
    lines.push(t(task.state?.lastSessionId ? 'sessions.sidebar.scheduled.openLastRun' : 'sessions.sidebar.scheduled.openManager'));
    return lines.join('\n');
  };

  const deleteTask = async () => {
    const task = editorTask;
    const projectId = editorProjectId;
    if (!task || !projectId) return false;
    if (!window.confirm(t(task.loopFile
      ? 'sessions.scheduledTasks.dialog.confirm.deleteLoopFile'
      : 'sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: task.name }))) return false;
    try {
      if (task.loopFile) await deleteScheduledTaskLoopFile(projectId, task.id);
      else await deleteScheduledTask(projectId, task.id);
      await reload();
      toast.success(t('sessions.scheduledTasks.dialog.toast.deleted'));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.deleteFailed'));
      return false;
    }
  };

  const editor = (
    <ScheduledTaskEditorDialog
      open={Boolean(editorTask)}
      task={editorTask}
      onOpenChange={(open) => { if (!open) { setEditorTask(null); setEditorProjectId(null); } }}
      onSave={saveTask}
      onDelete={deleteTask}
    />
  );

  return (
    <div className="flex-shrink-0 select-none px-2.5 pb-1" data-sidebar-scheduled>
      {!isVSCodeRuntime() && <Button variant="ghost" size="sm" className="mb-1 w-full justify-start gap-2" onClick={() => {
        const target = items.find(item => item.task.id.startsWith('companion:') && hasUnread(item))
          ?? projects.map(project => ({ project })).find(({ project }) => (companionUnread.get(project.id)?.size ?? 0) > 0)
          ?? items.find(item => item.task.id.startsWith('companion:'));
        if (target) useProjectsStore.getState().setActiveProject(target.project.id);
        for (const item of items) {
          if (item.task.id.startsWith('companion:') && hasUnread(item)) {
            acknowledgeUnread(item.project.id, item.task.state.lastSessionId);
          }
        }
        setFollowupsOpen(true);
      }}><Icon name="chat-history" className="size-3.5" />{t('companion.title')}
        {hasAnyCompanionUnread && <SessionActivityIndicator state="unread" label={t('sessions.sidebar.session.status.unread')} />}
      </Button>}
      <div className="relative group/scheduled -ml-2.5 -mr-2">
        <button
          type="button"
          onClick={toggle}
          className="group flex w-full items-center gap-1.5 rounded-md py-0.5 pl-4 pr-10 text-left hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-expanded={!collapsed}
        >
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
            <Icon name="calendar-schedule" className="h-3.5 w-3.5 text-muted-foreground/80 group-hover:hidden" />
            <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
              <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
            </span>
          </span>
          <span className="typography-ui-label font-semibold text-foreground">{t('sessions.sidebar.scheduled.title')}</span>
          {collapsed && <span className="typography-micro tabular-nums text-muted-foreground">{items.length}</span>}
        </button>
        <button
          type="button"
          onClick={openManager}
          className={cn(
            'absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            mobileVariant ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/scheduled:opacity-100 group-hover/scheduled:pointer-events-auto group-focus-within/scheduled:opacity-100 group-focus-within/scheduled:pointer-events-auto',
          )}
          aria-label={t('sessions.sidebar.scheduled.manage')}
          title={t('sessions.sidebar.scheduled.manage')}
        >
          <Icon name="add" className="h-4 w-4" />
        </button>
      </div>
      {!collapsed && (
        <ul className="max-h-56 overflow-y-auto" role="list">
          {items.map((item) => {
            const { task } = item;
            const sessionId = task.state.lastSessionId || '';
            const request = pending.get(sessionId);
            const live = statuses.get(sessionId)?.status;
            const status = scheduledRunActivity({ pending: Boolean(request?.permissions.length || request?.forms.length), live: live?.type === 'busy' || live?.type === 'retry', unread: hasUnread(item), dispatching: runningId === task.id || task.state.lastStatus === 'running', failed: task.state.lastStatus === 'error' });
            const isActive = Boolean(task.state?.lastSessionId) && task.state?.lastSessionId === currentSessionId;
            const meta = status === 'waiting' ? t('activity.needsYou') : status === 'unread' ? t('sessions.sidebar.session.status.unread') : !task.enabled
              ? t('sessions.sidebar.scheduled.paused')
              : status === 'running'
                ? t('sessions.sidebar.scheduled.running')
                : formatCompactUntil(task.state?.nextRunAt, now);
            return (
              <li key={`${item.project.id}:${task.id}`} className="group/row relative">
                <Tooltip delayDuration={450}>
                <TooltipTrigger asChild><button
                  type="button"
                  onClick={() => {
                    acknowledgeUnread(item.project.id, sessionId);
                    if (sessionId && (status === 'waiting' || status === 'running' || status === 'unread')) {
                      onNavigate?.(); useUIStore.getState().closeMainSurfaces();
                      useSessionUIStore.getState().setCurrentSession(sessionId, item.project.path);
                    } else openTask(item);
                  }}
                  aria-label={`${task.name}, ${meta}`}
                  className={cn(
                    'my-0.5 flex w-full items-center gap-2 rounded-md py-1 pl-[26px] pr-2 text-left typography-ui-label font-normal hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isActive && 'bg-interactive-selection/70 text-interactive-selection-foreground',
                    !task.enabled && 'text-muted-foreground',
                  )}
                >
                  <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                    {status === 'waiting'
                      ? <span className="size-2 rounded-full bg-[var(--status-info)]" role="img" aria-label={t('activity.needsYou')} />
                      : status === 'running' || status === 'unread'
                      ? <SessionActivityIndicator state={status} label={meta} />
                      : status === 'error'
                        ? <Icon name="error-warning" className="h-3.5 w-3.5 text-[var(--status-error)]" />
                        : <Icon name="time" className="h-3.5 w-3.5 text-muted-foreground/80" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" data-scheduled-task-name>{task.name}</span>
                  <span className={cn('max-w-24 truncate flex-shrink-0 typography-micro tabular-nums text-muted-foreground', !mobileVariant && 'group-hover/row:invisible')}>{meta}</span>
                </button></TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-left">
                  <p className="typography-ui-label font-medium break-words">{task.name}</p>
                  <p className="mt-1 typography-meta text-muted-foreground">{item.project.label || item.project.path.split('/').filter(Boolean).at(-1)}</p>
                  <p className="mt-1 typography-meta text-muted-foreground">{meta}</p>
                  <p className="mt-1 typography-meta text-muted-foreground whitespace-pre-wrap">{describe(item)}</p>
                </TooltipContent>
                </Tooltip>
                {!mobileVariant && (
                  <button
                    type="button"
                    disabled={runningId !== null}
                    onClick={(event) => { event.stopPropagation(); void runNow(item); }}
                    className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none hover:text-foreground group-hover/row:opacity-100 group-hover/row:pointer-events-auto disabled:opacity-40"
                    aria-label={t('sessions.sidebar.scheduled.runNow')}
                    title={t('sessions.sidebar.scheduled.runNow')}
                  >
                    <Icon name="play" className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editor}
      {followupsOpen && <React.Suspense fallback={null}><CompanionPanel onClose={() => { closeFollowups(); void reload(); }} /></React.Suspense>}
    </div>
  );
};
