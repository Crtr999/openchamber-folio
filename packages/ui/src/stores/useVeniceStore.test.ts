import { beforeEach, expect, test } from 'bun:test';
import { useVeniceStore } from './useVeniceStore';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';

beforeEach(() => {
  useVeniceStore.getState().resetWebsite();
  for (const page of useVeniceStore.getState().savedPages) useVeniceStore.getState().removeSavedPage(page.url);
  useUIStore.getState().closeMainSurfaces();
});

test('Venice saves explicit observed links only and reopens them in its website', () => {
  const venice = useVeniceStore.getState();
  venice.adoptPageTitle('https://venice.ai/observed-page', 'Observed title');
  expect(useVeniceStore.getState().savedPages).toEqual([]);
  venice.toggleSavedPage();
  const expected = [{ url: 'https://venice.ai/observed-page', title: 'Observed title' }];
  expect(useVeniceStore.getState().savedPages).toEqual(expected);
  expect(JSON.parse(getSafeStorage().getItem('open-carter.venice.saved-pages.v1') || 'null')).toEqual(expected);
  venice.openSavedPage('https://venice.ai/observed-page');
  expect(useVeniceStore.getState().request?.action).toEqual({ url: 'https://venice.ai/observed-page' });
  expect(useUIStore.getState().isVenicePageOpen).toBe(true);
  const sequence = useVeniceStore.getState().request?.sequence;
  venice.openSavedPage('https://venice.ai/not-saved');
  venice.openSavedPage('https://evil.test/');
  expect(useVeniceStore.getState().request?.sequence).toBe(sequence);
  venice.resetWebsite();
  expect(useVeniceStore.getState().pageUrl).toBeNull();
  expect(useVeniceStore.getState().savedPages).toEqual(expected);
  venice.removeSavedPage('https://venice.ai/observed-page');
  expect(useVeniceStore.getState().savedPages).toEqual([]);
});

test('Venice pins reject URL secrets and toggling never duplicates entries', () => {
  const venice = useVeniceStore.getState();
  for (const url of ['https://venice.ai/page?token=secret', 'https://venice.ai/page#secret', 'https://user:pass@venice.ai/page']) {
    venice.adoptPageTitle(url, 'Page');
    venice.toggleSavedPage();
    expect(useVeniceStore.getState().savedPages).toEqual([]);
  }
  venice.adoptPageTitle('https://venice.ai/observed-page', 'Title');
  venice.toggleSavedPage();
  venice.toggleSavedPage();
  expect(useVeniceStore.getState().savedPages).toEqual([]);
});

test('resuming Venice does not navigate or select a native session', () => {
  useVeniceStore.getState().adoptPageTitle('https://venice.ai/', 'Current page');
  useVeniceStore.getState().open();
  useVeniceStore.getState().open();
  expect(useUIStore.getState().isVenicePageOpen).toBe(true);
  expect(useVeniceStore.getState().request).toBeNull();
  expect(useVeniceStore.getState().pageTitle).toBe('Current page');
});

test('explicit website requests stay monotonic across runtime resets', () => {
  useVeniceStore.getState().open('home');
  const previous = useVeniceStore.getState().request?.sequence ?? 0;
  useVeniceStore.getState().resetWebsite();
  expect(useVeniceStore.getState().request).toBeNull();
  expect(useVeniceStore.getState().pageTitle).toBe('');
  useVeniceStore.getState().open('refresh');
  expect(useVeniceStore.getState().request?.sequence).toBeGreaterThan(previous);
});

test('external sign-in titles never become Venice navigation metadata', () => {
  for (const url of ['https://venice.ai.evil.test/', 'http://venice.ai/', 'invalid', 'https://accounts.example/']) {
    useVeniceStore.getState().adoptPageTitle('https://venice.ai/', 'Venice');
    useVeniceStore.getState().adoptPageTitle(url, 'Sign-in');
    expect(useVeniceStore.getState().pageTitle).toBe('');
  }
});

test('Venice and every other main page replace each other; Home closes all', () => {
  const ui = useUIStore.getState();
  const openPages = [
    () => ui.setChatGPTPageOpen(true),
    () => ui.setArchivePageOpen(true), () => ui.setUsageStatsPageOpen(true),
    () => ui.setScheduledTasksDialogOpen(true), () => ui.setWorktreesPageProjectId('project'),
    () => ui.setRunOverviewKey('run'), () => ui.setOpenGuestPage('guest'),
  ];
  for (const open of openPages) {
    ui.setVenicePageOpen(true);
    open();
    expect(useUIStore.getState().isVenicePageOpen).toBe(false);
    ui.setVenicePageOpen(true);
    const state = useUIStore.getState();
    expect(state.isChatGPTPageOpen || state.isArchivePageOpen || state.isUsageStatsPageOpen || state.isScheduledTasksDialogOpen).toBe(false);
    expect(state.worktreesPageProjectId).toBeNull();
    expect(state.runOverviewKey).toBeNull();
    expect(state.openGuestPageId).toBeNull();
  }
  ui.closeMainSurfaces();
  expect(useUIStore.getState().isVenicePageOpen).toBe(false);
});


test('Venice and other main surfaces are mutually exclusive without replacing native session state', () => {
  const ui = useUIStore.getState();
  ui.setChatGPTPageOpen(true);
  useVeniceStore.getState().open();
  expect(useUIStore.getState().isVenicePageOpen).toBe(true);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  ui.setScheduledTasksDialogOpen(true);
  expect(useUIStore.getState().isVenicePageOpen).toBe(false);
  useVeniceStore.getState().open();
  ui.closeMainSurfaces();
  expect(useUIStore.getState().isVenicePageOpen).toBe(false);
});


test('Venice resumes only observed chat pages and retains that choice across view resets', () => {
  const store = useVeniceStore.getState();
  store.adoptPageTitle('https://venice.ai/chat/classic/resume-test', 'Chat');
  expect(useVeniceStore.getState().resumeUrl).toBe('https://venice.ai/chat/classic/resume-test');
  expect(getSafeStorage().getItem('open-carter.venice.resume.v1')).toBe('https://venice.ai/chat/classic/resume-test');
  store.adoptPageTitle('https://venice.ai/sign-in', 'Sign in');
  store.adoptPageTitle('https://venice.ai/chat/classic/secret?token=private', 'Rejected');
  store.adoptPageTitle('https://evil.test/chat/classic/secret', 'Rejected');
  store.resetWebsite();
  expect(useVeniceStore.getState().resumeUrl).toBe('https://venice.ai/chat/classic/resume-test');
});


test('Venice website entry never selects an API model and remains separate from Gemini', () => {
  const ui = useUIStore.getState();
  ui.setGeminiPageOpen(true);
  useVeniceStore.getState().open('home');
  expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
  expect(useVeniceStore.getState().request?.action).toBe('home');
});
