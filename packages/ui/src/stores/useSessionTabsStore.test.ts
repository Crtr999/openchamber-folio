import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionTabsStore } from './useSessionTabsStore';

describe('useSessionTabsStore', () => {
  beforeEach(() => {
    useSessionTabsStore.setState({ tabIds: [], focusedTabId: null, newTabPending: false });
  });

  test('ensureTab appends once and preserves order', () => {
    const store = useSessionTabsStore.getState();
    store.ensureTab('a');
    store.ensureTab('b');
    store.ensureTab('a');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'b']);
  });

  test('lanes of one run share a tab: opening another lane reuses it in place', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'lane-1', 'b', 'lane-2'] });
    useSessionTabsStore.getState().ensureTab('lane-3', ['lane-1', 'lane-2', 'lane-3']);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'lane-3', 'b']);
    useSessionTabsStore.getState().ensureTab('c', []);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'lane-3', 'b', 'c']);
  });

  test('closeTab removes only the given id; closeOtherTabs keeps only it', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'] });
    useSessionTabsStore.getState().closeTab('b');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'c']);
    useSessionTabsStore.getState().closeOtherTabs('c');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['c']);
  });

  test('reorderTabs moves by id and ignores unknown ids', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'] });
    useSessionTabsStore.getState().reorderTabs('c', 'a');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['c', 'a', 'b']);
    const before = useSessionTabsStore.getState().tabIds;
    useSessionTabsStore.getState().reorderTabs('x', 'a');
    expect(useSessionTabsStore.getState().tabIds).toBe(before);
  });

  test('caps the working set at 10, evicting the oldest tab', () => {
    useSessionTabsStore.setState({ tabIds: Array.from({ length: 10 }, (_, i) => `s${i}`) });
    useSessionTabsStore.getState().ensureTab('s-new');
    const ids = useSessionTabsStore.getState().tabIds;
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('s1');
    expect(ids.at(-1)).toBe('s-new');
  });

  test('removeTabs drops only confirmed-gone ids and no-ops otherwise', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'] });
    const before = useSessionTabsStore.getState().tabIds;
    useSessionTabsStore.getState().removeTabs(['x']);
    expect(useSessionTabsStore.getState().tabIds).toBe(before);
    useSessionTabsStore.getState().removeTabs(['a']);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['b']);
  });

  test('singleton website ids reuse the session working set and persist in order', async () => {
    const store = useSessionTabsStore.getState();
    store.ensureTab('a');
    store.ensureTab('website:muse');
    store.ensureTab('website:claude');
    store.ensureTab('website:muse');
    store.reorderTabs('website:claude', 'a');
    const storage = useSessionTabsStore.persist.getOptions().storage;
    if (!storage) throw new Error('Missing tab persistence');
    const snapshot = await storage.getItem('session-tabs-store');
    expect(snapshot?.state.tabIds).toEqual(['website:claude', 'a', 'website:muse']);
    if (!snapshot) throw new Error('Missing persisted tab snapshot');
    useSessionTabsStore.setState({ tabIds: [] });
    await storage.setItem('session-tabs-store', snapshot);
    await useSessionTabsStore.persist.rehydrate();
    expect(useSessionTabsStore.getState().tabIds).toEqual(['website:claude', 'a', 'website:muse']);
    store.closeTab('website:muse');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['website:claude', 'a']);
  });

  test('navigateTab replaces the focused tab in place (Notion-style)', () => {
    const store = useSessionTabsStore.getState();
    store.navigateTab('a');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a']);
    store.navigateTab('b');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['b']);
    expect(useSessionTabsStore.getState().focusedTabId).toBe('b');
  });

  test('+ opens the next navigation in a new tab, then replacement resumes', () => {
    const store = useSessionTabsStore.getState();
    store.navigateTab('a');
    store.requestNewTab();
    store.navigateTab('b');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'b']);
    store.focusTab('a');
    store.navigateTab('c');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['c', 'b']);
  });

  test('navigating to an id that already has a tab only focuses it', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'], focusedTabId: 'a' });
    useSessionTabsStore.getState().navigateTab('b');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'b']);
    expect(useSessionTabsStore.getState().focusedTabId).toBe('b');
  });

  test('closing the focused tab moves focus to its neighbour', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'], focusedTabId: 'b' });
    useSessionTabsStore.getState().closeTab('b');
    expect(useSessionTabsStore.getState().focusedTabId).toBe('c');
  });
});
