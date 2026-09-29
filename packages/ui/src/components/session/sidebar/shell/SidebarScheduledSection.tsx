import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchScheduledTasks, runScheduledTaskNow } from '@/lib/scheduledTasksApi';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { formatCompactUntil, sortSidebarScheduledTasks, type SidebarScheduledTask } from './sidebarScheduled';

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
  const projects = useProjectsStore((state) => state.projects);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setScheduledOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const [items, setItems] = React.useState<SidebarScheduledTask[]>([]);
  const [collapsed, setCollapsed] = React.useState(readCollapsed);
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  const projectKey = projects.map((project) => project.id).join('|');
  const reload = React.useCallback(async () => {
    const results = await Promise.all(projects.map(async (project) => {
      try { return (await fetchScheduledTasks(project.id)).map((task) => ({ task, project })); }
      catch { return []; }
    }));
    setItems(sortSidebarScheduledTasks(results.flat()));
    setNow(Date.now());
    // projectKey stands in for `projects`: reload only when the set of projects changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  React.useEffect(() => {
    void reload();
    const timer = setInterval(() => { void reload(); }, REFRESH_MS);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void reload(); }, 400);
    });
    return () => { clearInterval(timer); if (debounce) clearTimeout(debounce); unsubscribe(); };
  }, [reload]);

  // Pick up edits made on the Scheduled page as soon as it closes.
  const wasScheduledOpen = React.useRef(isScheduledOpen);
  React.useEffect(() => {
    if (wasScheduledOpen.current && !isScheduledOpen) void reload();
    wasScheduledOpen.current = isScheduledOpen;
  }, [isScheduledOpen, reload]);

  if (items.length === 0) return null;

  const toggle = () => { const next = !collapsed; setCollapsed(next); writeCollapsed(next); };
  const openManager = () => { onNavigate?.(); setScheduledOpen(true); };
  const openTask = ({ task, project }: SidebarScheduledTask) => {
    const sessionId = task.state?.lastSessionId;
    if (!sessionId) { openManager(); return; }
    onNavigate?.();
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().setCurrentSession(sessionId, project.path ?? null);
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

  return (
    <div className="flex-shrink-0 select-none px-2.5 pb-1" data-sidebar-scheduled>
      <div className="relative group/scheduled -ml-2.5 -mr-2">
        <button
          type="button"
          onClick={toggle}
          className="group flex w-full items-center gap-1.5 py-1 pl-4 pr-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-expanded={!collapsed}
        >
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
            <Icon name="calendar-schedule" className="h-3.5 w-3.5 text-muted-foreground/80 group-hover:hidden" />
            <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
              <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
            </span>
          </span>
          <span className="typography-ui-label font-semibold lowercase text-foreground">{t('sessions.sidebar.scheduled.title')}</span>
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
            const status = runningId === task.id ? 'running' : task.state?.lastStatus;
            const isActive = Boolean(task.state?.lastSessionId) && task.state?.lastSessionId === currentSessionId;
            const meta = !task.enabled
              ? t('sessions.sidebar.scheduled.paused')
              : status === 'running'
                ? t('sessions.sidebar.scheduled.running')
                : formatCompactUntil(task.state?.nextRunAt, now);
            return (
              <li key={`${item.project.id}:${task.id}`} className="group/row relative">
                <button
                  type="button"
                  onClick={() => openTask(item)}
                  title={describe(item)}
                  className={cn(
                    'my-0.5 flex w-full items-center gap-2 rounded-md py-1 pl-1.5 pr-2 text-left typography-ui-label hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isActive && 'bg-interactive-selection/70 text-interactive-selection-foreground',
                    !task.enabled && 'text-muted-foreground',
                  )}
                >
                  <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                    {status === 'running'
                      ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-[var(--status-warning)]" />
                      : status === 'error'
                        ? <Icon name="error-warning" className="h-3.5 w-3.5 text-[var(--status-error)]" />
                        : <Icon name="time" className="h-3.5 w-3.5 text-muted-foreground/80" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{task.name}</span>
                  <span className={cn('flex-shrink-0 typography-micro tabular-nums text-muted-foreground', !mobileVariant && 'group-hover/row:invisible')}>{meta}</span>
                </button>
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
    </div>
  );
};
