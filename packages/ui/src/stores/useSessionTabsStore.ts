import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

/**
 * The header's working set of sessions and singleton websites on web/desktop.
 *
 * Only ids and their order are owned here. Website ids use the `website:` prefix;
 * titles, directories and liveness come from their owning stores. Tabs are a per-client
 * projection: opening a session anywhere adds it once, closing a tab only
 * removes it from the strip and never touches the session itself. Ids whose
 * session is unknown are kept (a partially loaded global list must not
 * destroy the working set) and simply do not render until the session loads.
 */
interface SessionTabsStore {
  tabIds: string[];
  /**
   * The tab the user is "in" (Notion-style). Navigating anywhere replaces this
   * tab's content in place instead of growing the strip. It survives visits to
   * Home, so the next chat opened lands back in the same tab.
   */
  focusedTabId: string | null;
  /** Set by the header's + button: the next navigation opens a fresh tab. */
  newTabPending: boolean;

  /**
   * Navigate the focused tab to `id`. An id that already has a tab just focuses
   * it; a pending new tab appends; otherwise the focused tab is replaced in
   * place. `slotIds` keeps multi-run lanes sharing one tab.
   */
  navigateTab: (id: string, slotIds?: readonly string[]) => void;
  /** Mark that the next navigation should open in a new tab. */
  requestNewTab: () => void;
  cancelNewTab: () => void;
  focusTab: (id: string) => void;

  /**
   * Adds the session's tab. `slotIds` are sessions that share one tab with it
   * (the members of a multi-run): an existing tab of any of them is reused in
   * place instead of adding a new one.
   */
  ensureTab: (sessionId: string, slotIds?: readonly string[]) => void;
  closeTab: (sessionId: string) => void;
  closeOtherTabs: (sessionId: string) => void;
  reorderTabs: (activeId: string, overId: string) => void;
  /** Drop ids the caller has authoritatively confirmed no longer exist. */
  removeTabs: (sessionIds: readonly string[]) => void;
}

const MAX_SESSION_TABS = 10;

type PersistedSessionTabs = { tabIds: string[]; focusedTabId?: string | null };

export const useSessionTabsStore = create<SessionTabsStore>()(
  devtools(
    persist(
      (set, get) => ({
        tabIds: [],
        focusedTabId: null,
        newTabPending: false,

        navigateTab: (id, slotIds) => {
          if (!id) return;
          const { tabIds, focusedTabId, newTabPending } = get();
          if (tabIds.includes(id)) {
            set({ focusedTabId: id, newTabPending: false });
            return;
          }
          const slot = slotIds && slotIds.length > 0 ? new Set(slotIds) : null;
          const slotIndex = slot ? tabIds.findIndex((tabId) => slot.has(tabId)) : -1;
          if (slot && slotIndex >= 0) {
            const next = tabIds.flatMap((tabId, index) => (index === slotIndex ? [id] : slot.has(tabId) ? [] : [tabId]));
            set({ tabIds: next, focusedTabId: id, newTabPending: false });
            return;
          }
          const focusedIndex = !newTabPending && focusedTabId ? tabIds.indexOf(focusedTabId) : -1;
          if (focusedIndex >= 0) {
            const next = [...tabIds];
            next[focusedIndex] = id;
            set({ tabIds: next, focusedTabId: id, newTabPending: false });
            return;
          }
          const next = [...tabIds, id];
          set({
            tabIds: next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next,
            focusedTabId: id,
            newTabPending: false,
          });
        },

        requestNewTab: () => set({ newTabPending: true }),
        cancelNewTab: () => { if (get().newTabPending) set({ newTabPending: false }); },
        focusTab: (id) => {
          const { tabIds, focusedTabId, newTabPending } = get();
          if (!tabIds.includes(id) || (focusedTabId === id && !newTabPending)) return;
          set({ focusedTabId: id, newTabPending: false });
        },

        ensureTab: (sessionId, slotIds) => {
          if (!sessionId) return;
          const { tabIds } = get();
          if (tabIds.includes(sessionId)) return;
          const slot = slotIds && slotIds.length > 0 ? new Set(slotIds) : null;
          const slotIndex = slot ? tabIds.findIndex((id) => slot.has(id)) : -1;
          if (slot && slotIndex >= 0) {
            const next = tabIds.flatMap((id, index) => (index === slotIndex ? [sessionId] : slot.has(id) ? [] : [id]));
            set({ tabIds: next });
            return;
          }
          // Soft cap: with auto-add the strip only ever grows, so past the cap
          // the oldest tab (never the one being opened, which lands last)
          // leaves the working set.
          const next = [...tabIds, sessionId];
          set({ tabIds: next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next });
        },

        closeTab: (sessionId) => {
          const { tabIds } = get();
          if (!tabIds.includes(sessionId)) return;
          const index = tabIds.indexOf(sessionId);
          const next = tabIds.filter((id) => id !== sessionId);
          const { focusedTabId } = get();
          set({
            tabIds: next,
            focusedTabId: focusedTabId === sessionId ? (next[index] ?? next[index - 1] ?? null) : focusedTabId,
          });
        },

        closeOtherTabs: (sessionId) => {
          const { tabIds } = get();
          if (!tabIds.includes(sessionId)) return;
          if (tabIds.length === 1) return;
          set({ tabIds: [sessionId], focusedTabId: sessionId });
        },

        reorderTabs: (activeId, overId) => {
          const { tabIds } = get();
          const from = tabIds.indexOf(activeId);
          const to = tabIds.indexOf(overId);
          if (from < 0 || to < 0 || from === to) return;
          const next = [...tabIds];
          next.splice(to, 0, ...next.splice(from, 1));
          set({ tabIds: next });
        },

        removeTabs: (sessionIds) => {
          if (sessionIds.length === 0) return;
          const gone = new Set(sessionIds);
          const { tabIds } = get();
          const next = tabIds.filter((id) => !gone.has(id));
          if (next.length === tabIds.length) return;
          const { focusedTabId } = get();
          set({ tabIds: next, focusedTabId: focusedTabId && gone.has(focusedTabId) ? null : focusedTabId });
        },
      }),
      {
        name: 'session-tabs-store',
        storage: createDeferredSafeJSONStorage<PersistedSessionTabs>(),
        partialize: (state) => ({ tabIds: state.tabIds, focusedTabId: state.focusedTabId }),
      },
    ),
  ),
);
