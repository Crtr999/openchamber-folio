import { beforeEach, expect, test } from 'bun:test';
import { useGeminiStore } from './useGeminiStore';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';

beforeEach(() => {
  useGeminiStore.getState().resetWebsite();
  for (const page of useGeminiStore.getState().savedPages) useGeminiStore.getState().removeSavedPage(page.url);
  useUIStore.getState().closeMainSurfaces();
});

test('Gemini saves explicit observed links only and reopens them in its website', () => {
  const gemini = useGeminiStore.getState();
  gemini.adoptPageTitle('https://gemini.google.com/observed-page', 'Observed title');
  expect(useGeminiStore.getState().savedPages).toEqual([]);
  gemini.toggleSavedPage();
  const expected = [{ url: 'https://gemini.google.com/observed-page', title: 'Observed title' }];
  expect(useGeminiStore.getState().savedPages).toEqual(expected);
  expect(JSON.parse(getSafeStorage().getItem('open-carter.gemini.saved-pages.v1') || 'null')).toEqual(expected);
  gemini.openSavedPage('https://gemini.google.com/observed-page');
  expect(useGeminiStore.getState().request?.action).toEqual({ url: 'https://gemini.google.com/observed-page' });
  expect(useUIStore.getState().isGeminiPageOpen).toBe(true);
  const sequence = useGeminiStore.getState().request?.sequence;
  gemini.openSavedPage('https://gemini.google.com/not-saved');
  gemini.openSavedPage('https://evil.test/');
  expect(useGeminiStore.getState().request?.sequence).toBe(sequence);
  gemini.resetWebsite();
  expect(useGeminiStore.getState().pageUrl).toBeNull();
  expect(useGeminiStore.getState().savedPages).toEqual(expected);
  gemini.removeSavedPage('https://gemini.google.com/observed-page');
  expect(useGeminiStore.getState().savedPages).toEqual([]);
});

test('Gemini pins reject URL secrets and toggling never duplicates entries', () => {
  const gemini = useGeminiStore.getState();
  for (const url of ['https://gemini.google.com/page?token=secret', 'https://gemini.google.com/page#secret', 'https://user:pass@gemini.ai/page']) {
    gemini.adoptPageTitle(url, 'Page');
    gemini.toggleSavedPage();
    expect(useGeminiStore.getState().savedPages).toEqual([]);
  }
  gemini.adoptPageTitle('https://gemini.google.com/observed-page', 'Title');
  gemini.toggleSavedPage();
  gemini.toggleSavedPage();
  expect(useGeminiStore.getState().savedPages).toEqual([]);
});

test('resuming Gemini does not navigate or select a native session', () => {
  useGeminiStore.getState().adoptPageTitle('https://gemini.google.com/', 'Current page');
  useGeminiStore.getState().open();
  useGeminiStore.getState().open();
  expect(useUIStore.getState().isGeminiPageOpen).toBe(true);
  expect(useGeminiStore.getState().request).toBeNull();
  expect(useGeminiStore.getState().pageTitle).toBe('Current page');
});

test('explicit website requests stay monotonic across runtime resets', () => {
  useGeminiStore.getState().open('home');
  const previous = useGeminiStore.getState().request?.sequence ?? 0;
  useGeminiStore.getState().resetWebsite();
  expect(useGeminiStore.getState().request).toBeNull();
  expect(useGeminiStore.getState().pageTitle).toBe('');
  useGeminiStore.getState().open('refresh');
  expect(useGeminiStore.getState().request?.sequence).toBeGreaterThan(previous);
});

test('external sign-in titles never become Gemini navigation metadata', () => {
  for (const url of ['https://gemini.google.com.evil.test/', 'http://gemini.ai/', 'invalid', 'https://accounts.example/']) {
    useGeminiStore.getState().adoptPageTitle('https://gemini.google.com/', 'Gemini');
    useGeminiStore.getState().adoptPageTitle(url, 'Sign-in');
    expect(useGeminiStore.getState().pageTitle).toBe('');
  }
});

test('Gemini and every other main page replace each other; Home closes all', () => {
  const ui = useUIStore.getState();
  const openPages = [
    () => ui.setChatGPTPageOpen(true),
    () => ui.setArchivePageOpen(true), () => ui.setUsageStatsPageOpen(true),
    () => ui.setScheduledTasksDialogOpen(true), () => ui.setWorktreesPageProjectId('project'),
    () => ui.setRunOverviewKey('run'), () => ui.setOpenGuestPage('guest'),
  ];
  for (const open of openPages) {
    ui.setGeminiPageOpen(true);
    open();
    expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
    ui.setGeminiPageOpen(true);
    const state = useUIStore.getState();
    expect(state.isChatGPTPageOpen || state.isArchivePageOpen || state.isUsageStatsPageOpen || state.isScheduledTasksDialogOpen).toBe(false);
    expect(state.worktreesPageProjectId).toBeNull();
    expect(state.runOverviewKey).toBeNull();
    expect(state.openGuestPageId).toBeNull();
  }
  ui.closeMainSurfaces();
  expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
});


test('Gemini and other main surfaces are mutually exclusive without replacing native session state', () => {
  const ui = useUIStore.getState();
  ui.setChatGPTPageOpen(true);
  useGeminiStore.getState().open();
  expect(useUIStore.getState().isGeminiPageOpen).toBe(true);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  ui.setScheduledTasksDialogOpen(true);
  expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
  useGeminiStore.getState().open();
  ui.closeMainSurfaces();
  expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
});


test('Gemini resumes only observed chat pages and retains that choice across view resets', () => {
  const store = useGeminiStore.getState();
  store.adoptPageTitle('https://gemini.google.com/app/resume-test', 'Chat');
  expect(useGeminiStore.getState().resumeUrl).toBe('https://gemini.google.com/app/resume-test');
  expect(getSafeStorage().getItem('open-carter.gemini.resume.v1')).toBe('https://gemini.google.com/app/resume-test');
  store.adoptPageTitle('https://gemini.google.com/sign-in', 'Sign in');
  store.adoptPageTitle('https://gemini.google.com/app/secret?token=private', 'Rejected');
  store.adoptPageTitle('https://evil.test/app/secret', 'Rejected');
  store.resetWebsite();
  expect(useGeminiStore.getState().resumeUrl).toBe('https://gemini.google.com/app/resume-test');
});
