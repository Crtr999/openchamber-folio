import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost:3000' });
Object.assign(browser, {
  __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
  __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
  __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:3000',
  __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000',
});
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent, DOMRect: browser.DOMRect, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionTabsStore } = await import('@/stores/useSessionTabsStore');
const { useMuseStore } = await import('@/stores/useMuseStore');
const { SessionTabsStrip } = await import('./SessionTabsStrip');
const { HeaderSessionPinMenuItem } = await import('./HeaderSessionPinMenuItem');
const { SyncProvider } = await import('@/sync/sync-context');
const { OpenCode } = await import('@opencode/client');
const initialUI = useUIStore.getState();
const initialSessionUI = useSessionUIStore.getState();
const initialSessions = useGlobalSessionsStore.getState();
const initialTabs = useSessionTabsStore.getState();
const initialMuse = useMuseStore.getState();
const session: Session = {
  id: 'session-a', title: 'Existing chat', directory: '/workspace', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
};
let root: Root;
let host: HTMLDivElement;
let creations = 0;
let selections: string[] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  creations = 0;
  selections = [];
  useUIStore.getState().closeMainSurfaces();
  useSessionUIStore.setState({
    currentSessionId: session.id,
    setCurrentSession: (id) => { if (id) selections.push(id); useSessionUIStore.setState({ currentSessionId: id }); },
    createSession: async () => { creations += 1; return null; },
  });
  useGlobalSessionsStore.setState({ activeSessions: [session] });
  useSessionTabsStore.setState({ tabIds: ['website:muse', 'website:claude', 'not-loaded'] });
  useMuseStore.setState({ pageTitle: 'My Muse page' });
  useUIStore.getState().setMusePageOpen(true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI, true);
  useSessionUIStore.setState(initialSessionUI, true);
  useGlobalSessionsStore.setState(initialSessions, true);
  useSessionTabsStore.setState(initialTabs, true);
  useMuseStore.setState(initialMuse, true);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const renderStrip = async () => {
  await act(async () => root.render(<I18nProvider><SessionTabsStrip renderMenu={() => null}>Existing chat</SessionTabsStrip></I18nProvider>));
};
const websiteButton = (title: string) => {
  const button = host.querySelector<HTMLButtonElement>(`button[role="tab"][title="${title}"]`);
  if (!button) throw new Error(`Missing website tab: ${title}`);
  return button;
};

test('websites share one strip and website activation does not add a draft or duplicate', async () => {
  await renderStrip();
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  await act(async () => websiteButton('My Muse page').click());
  expect(useUIStore.getState().isMusePageOpen).toBe(true);
  expect(websiteButton('My Muse page').getAttribute('aria-selected')).toBe('true');
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  await act(async () => websiteButton('My Muse page').click());
  expect(useSessionTabsStore.getState().tabIds).toEqual(['website:muse', 'website:claude', 'not-loaded']);
  expect(creations).toBe(0);
});

test('website buttons switch retained pages and close selects the neighbour without touching sessions', async () => {
  await renderStrip();
  await act(async () => websiteButton('Claude').click());
  expect(useUIStore.getState().isMusePageOpen).toBe(false);
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  expect(selections).toEqual([]);
  await act(async () => websiteButton('My Muse page').click());
  const close = websiteButton('My Muse page').closest('.session-tab-slot')?.querySelector<HTMLButtonElement>('button[aria-label="Close tab"]');
  if (!close) throw new Error('Missing website close button');
  await act(async () => close.click());
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(useGlobalSessionsStore.getState().activeSessions).toEqual([session]);
  expect(creations).toBe(0);
});

test('website overflow exposes a live pin and retains keyboard menu navigation', async () => {
  useMuseStore.getState().adoptPageTitle('https://muse.ai/observed-page', 'Observed page');
  await renderStrip();
  const trigger = websiteButton('Observed page').closest('.session-tab-slot')?.querySelector<HTMLButtonElement>('button[aria-label="Session tab actions"]');
  if (!trigger) throw new Error('Missing website menu trigger');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const pin = items.find(item => item.textContent === 'Pin to sidebar');
  const close = items.find(item => item.textContent === 'Close tab');
  if (!pin || !close) throw new Error('Website menu items missing');
  await act(async () => {
    pin.focus();
    pin.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(close);
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(pin);
  await act(async () => pin.click());
  expect(useMuseStore.getState().savedPages.some(page => page.url === 'https://muse.ai/observed-page')).toBe(true);
  expect(creations).toBe(0);
});

test('native tab context menu pins the existing sidebar store with keyboard navigation', async () => {
  const { useSessionPinnedStore, isSessionPinned } = await import('@/stores/useSessionPinnedStore');
  const previousPins = useSessionPinnedStore.getState();
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  useUIStore.getState().closeMainSurfaces();
  useSessionTabsStore.setState({ tabIds: [session.id] });
  const sdk = OpenCode.make({ baseUrl: 'http://opencode.test', fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }) });
  await act(async () => root.render(<SyncProvider directory="/workspace" sdk={sdk}><I18nProvider><SessionTabsStrip renderMenu={({ session: target, components }) => <>
    <HeaderSessionPinMenuItem sessionId={target.id} directory={target.directory ?? null} Item={components.Item} />
    <components.Item>Existing action</components.Item>
  </>}>Existing chat</SessionTabsStrip></I18nProvider></SyncProvider>));
  const tab = host.querySelector<HTMLElement>('[role="tab"][data-controls-open]');
  if (!tab) throw new Error('Native tab missing');
  await act(async () => tab.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })));
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const pin = items.find(item => item.textContent === 'Pin to sidebar');
  const existing = items.find(item => item.textContent === 'Existing action');
  if (!pin || !existing) throw new Error('Native context menu missing');
  await act(async () => {
    pin.focus();
    pin.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(existing);
  await act(async () => existing.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(pin);
  await act(async () => pin.click());
  expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/workspace', session.id)).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  await act(async () => useSessionPinnedStore.setState(previousPins));
});
