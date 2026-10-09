import { beforeEach, expect, test } from 'bun:test';
import { useClaudeStore } from './useClaudeStore';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';

beforeEach(() => {
  useClaudeStore.getState().resetWebsite();
  for (const page of useClaudeStore.getState().savedPages) useClaudeStore.getState().removeSavedPage(page.url);
  useUIStore.getState().closeMainSurfaces();
});

test('Claude saves explicit observed links only and reopens them in its website', () => {
  const claude = useClaudeStore.getState();
  claude.adoptPageTitle('https://claude.ai/observed-page', 'Observed title');
  expect(useClaudeStore.getState().savedPages).toEqual([]);
  claude.toggleSavedPage();
  const expected = [{ url: 'https://claude.ai/observed-page', title: 'Observed title' }];
  expect(useClaudeStore.getState().savedPages).toEqual(expected);
  expect(JSON.parse(getSafeStorage().getItem('open-carter.claude.saved-pages.v1') || 'null')).toEqual(expected);
  claude.openSavedPage('https://claude.ai/observed-page');
  expect(useClaudeStore.getState().request?.action).toEqual({ url: 'https://claude.ai/observed-page' });
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  const sequence = useClaudeStore.getState().request?.sequence;
  claude.openSavedPage('https://claude.ai/not-saved');
  claude.openSavedPage('https://evil.test/');
  expect(useClaudeStore.getState().request?.sequence).toBe(sequence);
  claude.resetWebsite();
  expect(useClaudeStore.getState().pageUrl).toBeNull();
  expect(useClaudeStore.getState().savedPages).toEqual(expected);
  claude.removeSavedPage('https://claude.ai/observed-page');
  expect(useClaudeStore.getState().savedPages).toEqual([]);
});

test('Claude pins reject URL secrets and toggling never duplicates entries', () => {
  const claude = useClaudeStore.getState();
  for (const url of ['https://claude.ai/page?token=secret', 'https://claude.ai/page#secret', 'https://user:pass@claude.ai/page']) {
    claude.adoptPageTitle(url, 'Page');
    claude.toggleSavedPage();
    expect(useClaudeStore.getState().savedPages).toEqual([]);
  }
  claude.adoptPageTitle('https://claude.ai/observed-page', 'Title');
  claude.toggleSavedPage();
  claude.toggleSavedPage();
  expect(useClaudeStore.getState().savedPages).toEqual([]);
});

test('resuming Claude does not navigate or select a native session', () => {
  useClaudeStore.getState().adoptPageTitle('https://claude.ai/', 'Current page');
  useClaudeStore.getState().open();
  useClaudeStore.getState().open();
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  expect(useClaudeStore.getState().request).toBeNull();
  expect(useClaudeStore.getState().pageTitle).toBe('Current page');
});

test('explicit website requests stay monotonic across runtime resets', () => {
  useClaudeStore.getState().open('home');
  const previous = useClaudeStore.getState().request?.sequence ?? 0;
  useClaudeStore.getState().resetWebsite();
  expect(useClaudeStore.getState().request).toBeNull();
  expect(useClaudeStore.getState().pageTitle).toBe('');
  useClaudeStore.getState().open('refresh');
  expect(useClaudeStore.getState().request?.sequence).toBeGreaterThan(previous);
});

test('external sign-in titles never become Claude navigation metadata', () => {
  for (const url of ['https://claude.ai.evil.test/', 'http://claude.ai/', 'invalid', 'https://accounts.example/']) {
    useClaudeStore.getState().adoptPageTitle('https://claude.ai/', 'Claude');
    useClaudeStore.getState().adoptPageTitle(url, 'Sign-in');
    expect(useClaudeStore.getState().pageTitle).toBe('');
  }
});

test('Claude and every other main page replace each other; Home closes all', () => {
  const ui = useUIStore.getState();
  const openPages = [
    () => ui.setChatGPTPageOpen(true), () => ui.setMusePageOpen(true),
    () => ui.setArchivePageOpen(true), () => ui.setUsageStatsPageOpen(true),
    () => ui.setScheduledTasksDialogOpen(true), () => ui.setWorktreesPageProjectId('project'),
    () => ui.setRunOverviewKey('run'), () => ui.setOpenGuestPage('guest'),
  ];
  for (const open of openPages) {
    ui.setClaudePageOpen(true);
    open();
    expect(useUIStore.getState().isClaudePageOpen).toBe(false);
    ui.setClaudePageOpen(true);
    const state = useUIStore.getState();
    expect(state.isMusePageOpen || state.isChatGPTPageOpen || state.isArchivePageOpen || state.isUsageStatsPageOpen || state.isScheduledTasksDialogOpen).toBe(false);
    expect(state.worktreesPageProjectId).toBeNull();
    expect(state.runOverviewKey).toBeNull();
    expect(state.openGuestPageId).toBeNull();
  }
  ui.closeMainSurfaces();
  expect(useUIStore.getState().isClaudePageOpen).toBe(false);
});
