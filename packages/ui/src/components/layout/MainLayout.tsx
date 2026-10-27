import { WebsiteModelRuntime } from '@/components/views/WebsiteModelRuntime';
import { DirectorOverlay } from '@/components/chat/DirectorOverlay';
import { GeminiWorkspace } from '@/components/views/GeminiWorkspace';
import { useGeminiStore } from '@/stores/useGeminiStore';
import { useChatGPTStore } from '@/stores/useChatGPTStore';
import { HomeSceneBackdrop } from '@/components/chat/HomeSceneBackdrop';
import { useClaudeStore } from '@/stores/useClaudeStore';
import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { GuestHosts } from './GuestHosts';
import { PluginPane } from './PluginPane';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { NotionSearchPalette } from './NotionSearchPalette';
import { PillToaster } from './PillToaster';
import { openTodayCard } from '@/lib/searchPalette';
import { personalHomeSupported } from '@/lib/personal-home';
import { parseRoute } from '@/lib/router';
import { HelpDialog } from '../ui/HelpDialog';
import { OpenCodeStatusDialog } from '../ui/OpenCodeStatusDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { SpaceAccessDialog } from '@/components/session/spaces/SpaceAccessDialog';
import { SpaceActionsSheet, SpaceDeleteDialog } from '@/components/session/spaces/SpaceActions';
import { SpaceSetupOutputDialog } from '@/components/session/spaces/SpaceSetupOutput';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { UsageStatsView } from '@/components/views/usage/UsageStatsView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { RunOverview } from '@/components/multirun/RunOverview';
import { RunAutoFusion } from '@/lib/multirun/autoFusion';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';

import { ChatView } from '@/components/views/ChatView';
import { ChatGPTWorkspace } from '@/components/views/ChatGPTWorkspace';
import { VeniceWorkspace } from '@/components/views/VeniceWorkspace';
import { useVeniceStore } from '@/stores/useVeniceStore';
import { ClaudeWorkspace } from '@/components/views/ClaudeWorkspace';
import { MeetingWorkspace } from '@/components/views/MeetingWorkspace';
import { MeetingReminders } from '@/components/views/MeetingReminders';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';

const loadSettingsWindow = () => import('@/components/views/SettingsWindow').then(m => m.SettingsWindow);

/**
 * Desktop-surface layout: the chat owns the main area, and every other
 * surface (git, diff, files, terminal, ...) opens in the ContextPanel via the
 * rail. Phone-sized viewports run the separate MobileApp shell — a viewport
 * crossing the threshold reloads into it (see watchHostedSurfaceViewport).
 */
// Scrollbars stay hidden until something actually scrolls (see index.css).
const installAutoHideScrollbars = () => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (event: Event) => {
        const target = event.target === document ? document.documentElement : event.target;
        if (!(target instanceof Element)) return;
        if (!target.hasAttribute('data-oc-scrolling')) target.setAttribute('data-oc-scrolling', '');
        const previous = timers.get(target);
        if (previous) window.clearTimeout(previous);
        timers.set(target, window.setTimeout(() => { target.removeAttribute('data-oc-scrolling'); timers.delete(target); }, 1100));
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
};

export const MainLayout: React.FC = () => {
    const [launchSessionId] = React.useState(() => parseRoute().sessionId);
    React.useEffect(() => installAutoHideScrollbars(), []);
    // The first time the app is opened (or brought forward) each day, the Today
    // card greets you: today's meetings and what is due. Once per day; Esc closes it.
    React.useEffect(() => {
        if (!personalHomeSupported()) return;
        const KEY = 'open-carter:today-shown';
        const dayKey = () => new Date().toLocaleDateString('en-CA');
        const maybeShow = () => {
            if (document.visibilityState !== 'visible') return;
            let last: string | null = null;
            try { last = window.localStorage.getItem(KEY); } catch { /* storage optional */ }
            if (last === dayKey()) return;
            try { window.localStorage.setItem(KEY, dayKey()); } catch { /* storage optional */ }
            openTodayCard();
        };
        const first = window.setTimeout(maybeShow, 2500);
        window.addEventListener('focus', maybeShow);
        return () => { window.clearTimeout(first); window.removeEventListener('focus', maybeShow); };
    }, []);
    // Ordinary launches open Home. Explicit session URLs (including reloads)
    // keep their requested chat instead of racing the startup Home policy.
    React.useEffect(() => {
        if (launchSessionId) return;
        const bootAt = Date.now();
        let acted = false;
        const markActed = () => { acted = true; };
        window.addEventListener('pointerdown', markActed, true);
        window.addEventListener('keydown', markActed, true);
        const goHome = () => {
            if (acted || Date.now() - bootAt > 8000) return;
            const state = useSessionUIStore.getState();
            if (state.currentSessionId) state.openNewSessionDraft({ automatic: true });
        };
        goHome();
        const unsubscribe = useSessionUIStore.subscribe(goHome);
        const stop = window.setTimeout(() => { unsubscribe(); }, 8000);
        return () => {
            unsubscribe(); window.clearTimeout(stop);
            window.removeEventListener('pointerdown', markActed, true);
            window.removeEventListener('keydown', markActed, true);
        };
    }, [launchSessionId]);
    useSessionListSync({ isVSCode: false });
    useTerminalSessionKeepalive();
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const contextRailVisible = useUIStore((state) => state.contextRailVisible);
    // The grant dialog of isolated spaces; the main layout is never VS Code's (decision 16).
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    // Load the windowed settings dialog on its first open: its chunk graph
    // (CodeMirror editor, vim mode, theme tooling) stays off startup. Once
    // loaded it stays mounted so the close animation and state behave as
    // before. A failed load closes the dialog so the next click tries again.
    const SettingsWindow = useOnDemandComponent(isSettingsDialogOpen, loadSettingsWindow, () => setSettingsDialogOpen(false));
    const isRunOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const isUsageStatsPageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    const isChatGPTPageOpen = useUIStore((state) => state.isChatGPTPageOpen);
    const isClaudePageOpen = useUIStore((state) => state.isClaudePageOpen);
    const isVenicePageOpen = useUIStore(state => state.isVenicePageOpen);
    const isGeminiPageOpen = useUIStore(state => state.isGeminiPageOpen);
    const isWebsiteAssistantPageOpen = isChatGPTPageOpen || isClaudePageOpen || isVenicePageOpen || isGeminiPageOpen;
    const openGuestPageId = useUIStore((state) => state.openGuestPageId);
    const guestPages = useGuestPages();
    const guestPage = guestPages.find((guest) => guest.id === openGuestPageId);
    React.useEffect(() => {
        if (openGuestPageId && !guestPage) useUIStore.getState().setOpenGuestPage(null);
    }, [openGuestPageId, guestPage]);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
        useUIStore.getState().setOpenGuestPage(null);
        useUIStore.getState().setChatGPTPageOpen(false);
        useChatGPTStore.getState().resetWebsite();
        useUIStore.getState().setClaudePageOpen(false);
        useClaudeStore.getState().resetWebsite();
        useUIStore.getState().setVenicePageOpen(false);
        useVeniceStore.getState().resetWebsite();
        useUIStore.getState().setGeminiPageOpen(false);
        useGeminiStore.getState().resetWebsite();
    }), []);
    // Any full-page surface replacing the chat area. While open, the chat is
    // fully hidden (not just covered) so none of its floating chrome bleeds
    // through, and selecting a session or draft anywhere closes the surface.
    const isSurfacePageOpen = isWebsiteAssistantPageOpen || isScheduledTasksPageOpen || isArchivePageOpen || isUsageStatsPageOpen || Boolean(worktreesPageProjectId) || isRunOverviewOpen || Boolean(guestPage);

    React.useEffect(() => {
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = useSessionUIStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== prev.currentSessionId;
            // Draft identity change covers re-opening a draft while one is
            // already open (the boolean alone never transitions then).
            const draftOpened = Boolean(state.newSessionDraft?.open) && state.newSessionDraft !== prev.newSessionDraft;
            if (sessionSelected || draftOpened) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
        };
    }, []);
    const { isMobile } = useDeviceInfo();

    useUpdatePolling();


    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                data-oc-personal-interactions="true"
                className="main-content-safe-area relative flex h-[100dvh] bg-background"
            >
                <HomeSceneBackdrop />
                <CommandPalette />
                <NotionSearchPalette />
                <PillToaster />
                <HelpDialog />
                <OpenCodeStatusDialog />
                <RunAutoFusion />
                <SessionDialogs />
                {isolatedSpacesEnabled ? <><SpaceAccessDialog /><SpaceActionsSheet /><SpaceDeleteDialog /><SpaceSetupOutputDialog /></> : null}

                {/* Persistent top-left controls (toggle + project actions) that
                    stay put while the sidebar/header animate beneath them. */}
                <TitlebarLeftControls />
                {/* One continuous titlebar, independent of sidebar width. */}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-page-scroll-lock="true">
                    <Header />
                    <MeetingWorkspace />
                    <MeetingReminders />
                    <div className="flex min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                    <Sidebar
                        isOpen={isSidebarOpen}
                        isMobile={isMobile}
                    >
                        <SessionSidebar isVisible={isSidebarOpen} />
                    </Sidebar>
                    <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                        <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                            <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                                <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                    {/* Holds the chat and the context panel together, so its
                                        width does not move when the context panel opens. The
                                        work-status panel measures this rather than the chat,
                                        which the context panel animates. */}
                                    <div className="relative grid grid-cols-[minmax(0,1fr)_auto] flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                                        <main data-main-chat-pane="true" className="min-w-0 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                            <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                                <ErrorBoundary><ChatView active={!isSettingsDialogOpen && !isSurfacePageOpen} /></ErrorBoundary>
                                            </div>
                                            <ErrorBoundary><RunOverview /></ErrorBoundary>
                                            <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
                                            <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                            {isUsageStatsPageOpen && (
                                                <div className="absolute inset-0 z-10 bg-background">
                                                    <ErrorBoundary><UsageStatsView /></ErrorBoundary>
                                                </div>
                                            )}
                                            <ErrorBoundary><WorktreesView /></ErrorBoundary>
                                            <ErrorBoundary><DirectorOverlay /></ErrorBoundary>
                                            {isElectronShell() && isDesktopLocalOriginActive() && <ErrorBoundary>
                                                <WebsiteModelRuntime />
                                                <ChatGPTWorkspace visible={isChatGPTPageOpen} />
                                            </ErrorBoundary>}
                                            {isElectronShell() && isDesktopLocalOriginActive() && <ErrorBoundary>
                                                <ClaudeWorkspace visible={isClaudePageOpen} />
                                            </ErrorBoundary>}
                                            {isElectronShell() && isDesktopLocalOriginActive() && <ErrorBoundary>
                                                <VeniceWorkspace visible={isVenicePageOpen} />
                                                <GeminiWorkspace visible={isGeminiPageOpen} />
                                            </ErrorBoundary>}
                                            {guestPage && <div className="absolute inset-0 z-10 bg-background">
                                                <ErrorBoundary><PluginPane mode={`plugin:${guestPage.id}`} surface="page" item={null}
                                                    onDismiss={() => useUIStore.getState().setOpenGuestPage(null)} /></ErrorBoundary>
                                            </div>}
                                        </main>
                                        <div className={!contextRailVisible || isWebsiteAssistantPageOpen ? 'hidden' : 'contents'}><ContextPanel visible={contextRailVisible && !isWebsiteAssistantPageOpen} /></div>
                                    </div>
                                </div>
                            </div>
                            {contextRailVisible && !isWebsiteAssistantPageOpen && <div data-page-scroll-lock="true">
                                <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
                            </div>}
                            <ErrorBoundary><GuestHosts /></ErrorBoundary>
                        </div>
                    </div>
                </div>

                </div>
                {/* Settings: windowed dialog with blur */}
                {SettingsWindow ? (
                    <SettingsWindow
                        open={isSettingsDialogOpen}
                        onOpenChange={setSettingsDialogOpen}
                    />
                ) : null}
            </div>
        </DiffWorkerProvider>
    );
};
