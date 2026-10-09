import { beforeEach, expect, test } from 'bun:test';
import { useMuseStore } from './useMuseStore';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';

beforeEach(() => {
  useMuseStore.getState().resetWebsite();
  for (const page of useMuseStore.getState().savedPages) useMuseStore.getState().removeSavedPage(page.url);
  useUIStore.getState().closeMainSurfaces();
});

test('only explicitly pinned observed pages become local sidebar entries', () => {
  const muse = useMuseStore.getState();
  muse.adoptPageTitle('https://muse.ai/observed', 'Observed page');
  expect(useMuseStore.getState().savedPages).toEqual([]);
  muse.toggleSavedPage();
  expect(useMuseStore.getState().savedPages).toEqual([{ url: 'https://muse.ai/observed', title: 'Observed page' }]);
  expect(JSON.parse(getSafeStorage().getItem('open-carter.muse.saved-pages.v1') || 'null')).toEqual(useMuseStore.getState().savedPages);
  muse.openSavedPage('https://muse.ai/observed');
  expect(useMuseStore.getState().request?.action).toEqual({ url: 'https://muse.ai/observed' });
  const sequence = useMuseStore.getState().request?.sequence;
  muse.openSavedPage('https://muse.ai/not-saved');
  muse.openSavedPage('https://evil.test/');
  expect(useMuseStore.getState().request?.sequence).toBe(sequence);
  muse.resetWebsite();
  expect(useMuseStore.getState().pageUrl).toBeNull();
  expect(useMuseStore.getState().savedPages).toHaveLength(1);
  muse.removeSavedPage('https://muse.ai/observed');
  expect(useMuseStore.getState().savedPages).toEqual([]);
});

test('authentication query pages cannot be saved and pin toggles do not duplicate entries', () => {
  const muse = useMuseStore.getState();
  muse.adoptPageTitle('https://muse.ai/?aymh_complete=1', 'Muse');
  muse.toggleSavedPage();
  expect(useMuseStore.getState().savedPages).toEqual([]);
  muse.adoptPageTitle('https://muse.ai/', 'Muse');
  muse.toggleSavedPage();
  muse.toggleSavedPage();
  expect(useMuseStore.getState().savedPages).toEqual([]);
});

test('opening Muse preserves the current website instead of starting a native chat', () => {
  useMuseStore.getState().open();
  expect(useUIStore.getState().isMusePageOpen).toBe(true);
  expect(useMuseStore.getState().request).toBeNull();
});

test('explicit home and refresh requests have distinct monotonic identities', () => {
  useMuseStore.getState().open('home');
  const home = useMuseStore.getState().request;
  expect(home?.action).toBe('home');
  useMuseStore.getState().open('refresh');
  expect(useMuseStore.getState().request?.action).toBe('refresh');
  expect(useMuseStore.getState().request?.sequence).toBeGreaterThan(home?.sequence ?? 0);
});

test('runtime reset clears pending commands without reusing a handled identity', () => {
  useMuseStore.getState().open('home');
  const previous = useMuseStore.getState().request?.sequence ?? 0;
  useMuseStore.getState().resetWebsite();
  expect(useMuseStore.getState().request).toBeNull();
  useMuseStore.getState().open('refresh');
  expect(useMuseStore.getState().request?.sequence).toBeGreaterThan(previous);
});

test('mirrors only a live Muse page title and resume does not request navigation', () => {
  useMuseStore.getState().adoptPageTitle('https://muse.ai/?aymh_complete=1', ' Muse — Your Personal AI Agent ');
  expect(useMuseStore.getState().pageTitle).toBe('Muse — Your Personal AI Agent');
  useMuseStore.getState().open();
  useMuseStore.getState().open();
  expect(useMuseStore.getState().request).toBeNull();
  expect(useMuseStore.getState().pageTitle).toBe('Muse — Your Personal AI Agent');
  useMuseStore.getState().resetWebsite();
  expect(useMuseStore.getState().pageTitle).toBe('');
});

test('external sign-in pages and invalid URLs do not become Muse navigation metadata', () => {
  for (const url of ['https://muse.ai.evil.example/', 'https://example.com/', 'http://muse.ai/', 'not a URL']) {
    useMuseStore.getState().adoptPageTitle('https://muse.ai/', 'Muse');
    useMuseStore.getState().adoptPageTitle(url, 'External account');
    expect(useMuseStore.getState().pageTitle).toBe('');
  }
});
