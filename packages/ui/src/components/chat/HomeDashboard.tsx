import React from 'react';
import { CompanionPanel } from '@/apps/CompanionPanel';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore, mergeLiveSessionWithGlobalSession } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useAllSessionStatuses } from '@/sync/sync-context';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { cn, formatDirectoryName } from '@/lib/utils';
import { isElectronShell, isDesktopLocalOriginActive, isVSCodeRuntime } from '@/lib/desktop';
import { useClaudeStore } from '@/stores/useClaudeStore';
import coastalLandscape from '@/assets/home-coast.webp';
import './HomeDashboard.css';
import { HomePersonalPanels, HomeChatExport } from './HomePersonalPanels';
import { HomeWidgetLayout } from './HomeWidgetLayout';
import { HomeFriends } from './HomeFriends';
import { HomeCommitments } from './HomeCommitments';
import { openMeetingWorkspace } from '@/lib/meetings/workspace';
import { meetingsSupported } from '@/lib/meetings/contract';

export const HomeLandscape: React.FC = () => (
    <div className="oc-home-landscape" aria-hidden="true">
        <img src={coastalLandscape} alt="" width={2172} height={724} />
    </div>
);

const greetingKey = (now = new Date()) => {
    const hour = now.getHours();
    return hour < 5 ? 'home.greeting.night' : hour < 12 ? 'home.greeting.morning' : hour < 17 ? 'home.greeting.afternoon' : hour < 22 ? 'home.greeting.evening' : 'home.greeting.night';
};

/** Replaces the generic "What should we work on?" heading over the landscape. */
export const HomeGreeting: React.FC = () => {
    const { t, locale } = useI18n();
    const statuses = useAllSessionStatuses();
    const running = React.useMemo(() => Object.values(statuses).filter((status) => status && status.type !== 'idle').length, [statuses]);
    const [now, setNow] = React.useState(() => new Date());
    React.useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return (
        <div className="oc-home-greeting">
            <p className="text-[11.5px] font-medium uppercase tracking-[0.14em] text-foreground/70">
                {now.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })}
                {running ? <span className="ml-2 normal-case tracking-normal text-foreground/60">· {t('home.greeting.working', { count: running })}</span> : null}
            </p>
            <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight text-foreground md:text-3xl">{t(greetingKey(now))}, Carter</h1>
        </div>
    );
};

/** Start meeting and Meeting log. Sits beside the composer on wide windows. */
export const HomeQuickActions: React.FC<{ className?: string; stacked?: boolean }> = ({ className, stacked = false }) => {
    const { t } = useI18n();
    if (!meetingsSupported()) return null;
    const resolveActiveProjectDir = () => {
        const ui = useSessionUIStore.getState();
        const sessionDir = ui.currentSessionDirectory;
        if (sessionDir && !sessionDir.includes('/.config/openchamber/chats')) return sessionDir;
        if (ui.newSessionDraft.open && ui.newSessionDraft.target === 'project' && ui.newSessionDraft.directoryOverride) {
            return ui.newSessionDraft.directoryOverride;
        }
        return undefined;
    };
    return (
        <div className={cn(stacked ? 'flex-col items-start gap-0.5' : 'items-center gap-1', className)}>
            <Button size="sm" variant="ghost" className="oc-press h-7 rounded-full px-3 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
                onClick={() => openMeetingWorkspace({ title: '', autoStart: true, directory: resolveActiveProjectDir() })}>
                {t('meeting.quickStart')}
            </Button>
            <Button size="sm" variant="ghost" className="oc-press h-7 rounded-full px-3 text-[12px] text-muted-foreground/85 hover:text-foreground"
                onClick={() => openMeetingWorkspace({ title: '', openLog: true })}>
                {t('meeting.ui.log')}
            </Button>
        </div>
    );
};

export const HomeDashboard: React.FC = () => {
    const [companionOpen, setCompanionOpen] = React.useState(false);
    const closeCompanion = React.useCallback(() => setCompanionOpen(false), []);
    const { t } = useI18n();
    const cachedSessions = useGlobalSessionsStore((state) => state.activeSessions);
    const loadStatus = useGlobalSessionsStore((state) => state.status);
    const liveSessions = useAllLiveSessions();
    const statuses = useAllSessionStatuses();
    const ranks = useSessionOrderingStore((state) => state.rankById);
    const pinnedIds = useSessionPinnedStore((state) => state.ids);
    const projects = useProjectsStore((state) => state.projects);
    const recent = React.useMemo(() => {
        const byId = new Map(cachedSessions.map((session) => [session.id, session]));
        for (const session of liveSessions) {
            const cached = byId.get(session.id);
            byId.set(session.id, cached ? mergeLiveSessionWithGlobalSession(session, cached) : session);
        }
        return [...byId.values()]
            .filter((session) => !session.parentID && !session.time.archived)
            .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedIds, ranks))
            .slice(0, 4);
    }, [cachedSessions, liveSessions, pinnedIds, ranks]);
    const working = React.useMemo(() => liveSessions
        .filter((session) => !session.time.archived && statuses[session.id] && statuses[session.id].type !== 'idle')
        .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedIds, ranks)),
    [liveSessions, statuses, pinnedIds, ranks]);

    return (
        <div className="flex min-w-0 flex-col gap-4">
        {companionOpen ? <CompanionPanel onClose={closeCompanion} /> : null}
        {!isVSCodeRuntime() ? <Button variant="outline" size="sm" className="self-end" onClick={() => setCompanionOpen(true)}>{t('companion.title')}</Button> : null}
        <HomeQuickActions className="flex justify-end xl:hidden" />
        <HomePersonalPanels>{(personalPanels) => <HomeWidgetLayout widgets={{
            friends: { label: t('friends.title'), content: <HomeFriends /> },
            commitments: { label: t('commitments.title'), content: <HomeCommitments /> },
            working: { label: t('home.working'), content: <section>
                <h2 className="oc-home-card-heading">
                    <Icon name="flashlight" className="size-3.5" />
                    {t('home.working')}
                    <span className="oc-home-count ml-auto">{working.length}</span>
                </h2>
                {working.length ? working.slice(0, 4).map((session) => (
                    <Button key={session.id} variant="ghost" size="sm" className="oc-home-row oc-home-context-row"
                        onClick={() => useSessionUIStore.getState().setCurrentSession(session.id, session.directory)}>
                        <span className={statuses[session.id].type === 'retry' ? 'oc-home-dot oc-home-dot-retry' : 'oc-home-dot'} />
                        <span className="oc-home-row-context"><span className="truncate">{session.title}</span>
                            <span className="oc-home-row-detail">{formatDirectoryName(session.directory)}</span></span>
                        <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                    </Button>
                )) : <p className="oc-home-empty">{t('home.noWorking')}</p>}
            </section> },
            recent: { label: t('home.recent'), content: <section>
                <h2 className="oc-home-card-heading"><Icon name="chat-history" className="size-3.5" />{t('home.recent')}</h2>
                {loadStatus === 'error' && <p className="oc-home-empty text-destructive">{t('personalTools.error')}</p>}
                {recent.map((session) => (
                    <div key={session.id} className="flex min-w-0 items-center"><Button variant="ghost" size="sm" className="oc-home-row oc-home-context-row flex-1"
                        onClick={() => useSessionUIStore.getState().setCurrentSession(session.id, session.directory)}>
                        <Icon name="chat-3" className="size-3.5 text-muted-foreground" />
                        <span className="oc-home-row-context"><span className="truncate">{session.title}</span>
                            <span className="oc-home-row-detail">{formatDirectoryName(session.directory)}</span></span>
                        <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                    </Button><HomeChatExport session={session} /></div>
                ))}
                {!recent.length && loadStatus !== 'error' && <p className="oc-home-empty">
                    {loadStatus === 'ready' ? t('mobile.sessions.empty.noSessionsDescription') : t('common.loading')}
                </p>}
            </section> },
            tasks: { label: t('home.tasks'), content: personalPanels.tasks },
            calendar: { label: t('home.calendar'), content: personalPanels.calendar },
            habits: { label: t('home.habits'), content: personalPanels.habits },
            projects: { label: t('mobile.sessions.section.projects'), content: <section>
                <h2 className="oc-home-card-heading"><Icon name="folder" className="size-3.5" />{t('mobile.sessions.section.projects')}</h2>
                {projects.slice(0, 4).map((project) => (
                    <Button key={project.id} variant="ghost" size="sm" className="oc-home-row"
                        onClick={() => useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, target: 'project' })}>
                        <Icon name="folder-3" className="size-3.5 text-muted-foreground" />
                        <span className="min-w-0 truncate">{project.label || formatDirectoryName(project.path)}</span>
                        <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                    </Button>
                ))}
                {!projects.length && <p className="oc-home-empty">{t('mobile.sessions.empty.noProjectsDescription')}</p>}
            </section> },
             shortcuts: { label: t('sessions.sidebar.footer.actions.shortcuts'), content: <section>
                 <h2 className="oc-home-card-heading"><Icon name="arrow-right" className="size-3.5" />{t('sessions.sidebar.footer.actions.shortcuts')}</h2>
                 {isElectronShell() && isDesktopLocalOriginActive() && <Button variant="ghost" size="sm" className="oc-home-row"
                     onClick={() => useClaudeStore.getState().open('home')}>
                     <Icon name="chat-3" className="size-3.5 text-muted-foreground" />
                       <span>Claude</span>
                      <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                  </Button>}
                <Button variant="ghost" size="sm" className="oc-home-row"
                    onClick={() => useUIStore.getState().setScheduledTasksDialogOpen(true)}>
                    <Icon name="calendar-schedule" className="size-3.5 text-muted-foreground" />
                    <span>{t('sessions.sidebar.header.actions.scheduledTasks')}</span>
                    <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                </Button>
                <Button variant="ghost" size="sm" className="oc-home-row"
                    onClick={() => useUIStore.getState().setUsageStatsPageOpen(true)}>
                    <Icon name="bar-chart" className="size-3.5 text-muted-foreground" />
                    <span>{t('usageStats.openAction')}</span>
                    <Icon name="arrow-right" className="ml-auto size-3.5 opacity-40" />
                </Button>
            </section> },
        }} />}</HomePersonalPanels>
        </div>
    );
};
