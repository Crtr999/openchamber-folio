import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { canUseElectronDesktopIPC, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useMuseStore } from '@/stores/useMuseStore';
import { useClaudeStore } from '@/stores/useClaudeStore';

const websiteTabs = [
  { id: 'website:chatgpt', title: 'ChatGPT' },
  { id: 'website:muse', title: 'Muse' },
  { id: 'website:claude', title: 'Claude' },
] as const;

export const getWebsiteTab = (id: string) => websiteTabs.find((tab) => tab.id === id);

export const getActiveWebsiteTabId = (): string | null => {
  const ui = useUIStore.getState();
  if (ui.isChatGPTPageOpen) return 'website:chatgpt';
  if (ui.isMusePageOpen) return 'website:muse';
  if (ui.isClaudePageOpen) return 'website:claude';
  return null;
};

export const isWebsiteTabAvailable = (): boolean => canUseElectronDesktopIPC() && isDesktopLocalOriginActive();

export const activateHeaderTab = (id: string): boolean => {
  if (!useSessionTabsStore.getState().tabIds.includes(id)) return false;
  useSessionTabsStore.getState().focusTab(id);
  const ui = useUIStore.getState();
  if (getWebsiteTab(id)) {
    if (!isWebsiteTabAvailable()) return false;
    // ChatGPT's current full/integrated mode belongs to its retained workspace.
    if (id === 'website:chatgpt') ui.setChatGPTPageOpen(true);
    if (id === 'website:muse') useMuseStore.getState().open();
    if (id === 'website:claude') useClaudeStore.getState().open();
    return true;
  }
  const session = useGlobalSessionsStore.getState().activeSessions.find((entry) => entry.id === id);
  if (!session) return false;
  ui.closeMainSurfaces();
  useSessionUIStore.getState().setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
  return true;
};

const renderableTabIds = (): string[] => {
  const sessions = new Set(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id));
  const websitesAvailable = isWebsiteTabAvailable();
  return useSessionTabsStore.getState().tabIds.filter((id) => sessions.has(id) || (websitesAvailable && getWebsiteTab(id)));
};

/**
 * Count loaded sessions and available singleton websites in strip order.
 * Unknown persisted ids stay stored but are not keyboard destinations.
 */
export const activateSessionTabByIndex = (index: number): boolean => {
  const id = renderableTabIds()[index];
  return id ? activateHeaderTab(id) : false;
};

/**
 * Activate the tab one step right (+1) or left (-1) of the current session
 * in the rendered strip order, wrapping around the ends. Returns false when
 * the current session has no tab or there is nothing to move to.
 */
export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => {
  const currentSessionId = getActiveWebsiteTabId() ?? useSessionUIStore.getState().currentSessionId;
  const renderable = renderableTabIds();
  if (!currentSessionId || renderable.length < 2) return false;
  const index = renderable.indexOf(currentSessionId);
  if (index === -1) return false;
  const nextId = renderable[(index + delta + renderable.length) % renderable.length];
  return activateHeaderTab(nextId);
};

/** Closing changes only the working set. The last tab returns to an unsent draft. */
export const closeSessionTabAndActivateNeighbour = (sessionId: string): void => {
  const { tabIds, closeTab } = useSessionTabsStore.getState();
  if (!tabIds.includes(sessionId)) return;

  const { openNewSessionDraft } = useSessionUIStore.getState();
  const currentSessionId = getActiveWebsiteTabId() ?? useSessionUIStore.getState().currentSessionId;
  if (sessionId === currentSessionId) {
    const renderable = renderableTabIds();
    const index = renderable.indexOf(sessionId);
    const neighbourId = renderable[index + 1] ?? renderable[index - 1] ?? null;
    if (neighbourId) {
      activateHeaderTab(neighbourId);
    } else {
      useUIStore.getState().closeMainSurfaces();
      openNewSessionDraft();
    }
  }

  closeTab(sessionId);
};

/**
 * Notion-style "+": the next thing opened lands in a fresh tab. The tab starts
 * as a new chat draft and the new-tab palette opens over it.
 */
export const NEW_TAB_PALETTE_EVENT = 'open-carter:new-tab-palette';
export const openNewHeaderTab = (): void => {
  useSessionTabsStore.getState().requestNewTab();
  useUIStore.getState().closeMainSurfaces();
  useSessionUIStore.getState().openNewSessionDraft();
  window.dispatchEvent(new CustomEvent(NEW_TAB_PALETTE_EVENT));
};

/** Abandon a pending new tab and return to the tab the user was in. */
export const cancelNewHeaderTab = (): void => {
  const { focusedTabId, cancelNewTab } = useSessionTabsStore.getState();
  cancelNewTab();
  if (focusedTabId) activateHeaderTab(focusedTabId);
};
