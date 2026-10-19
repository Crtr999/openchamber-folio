import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { StoreApi } from 'zustand';
import { I18nProvider } from '@/lib/i18n';
import { useI18nStore } from '@/lib/i18n/store';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useClaudeStore } from '@/stores/useClaudeStore';
import { useChatGPTStore } from '@/stores/useChatGPTStore';
import { HeaderSessionPinMenuItem } from './HeaderSessionPinMenuItem';
import { WebsiteTabPinMenuItem } from './WebsiteTabPinMenuItem';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
  Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const preserve = <State,>(store: StoreApi<State>) => {
  const state = store.getState();
  return () => store.setState(state);
};
const restoreStores = [preserve(useGlobalSessionsStore), preserve(useSessionPinnedStore), preserve(useSessionUIStore),
  preserve(useClaudeStore), preserve(useChatGPTStore), preserve(useI18nStore)];
const Item: SessionTabMenuComponents['Item'] = props => <button {...props} />;
const session: Session = {
  id: 'target', directory: '/authoritative-worktree', title: 'Target', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
};
let root: Root;
beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  useSessionUIStore.setState({ currentSessionId: 'other', currentSessionDirectory: '/wrong-active-directory' });
  useGlobalSessionsStore.getState().upsertSession(session);
  useClaudeStore.setState({ pageUrl: null, pageTitle: '', savedPages: [] });
  useChatGPTStore.setState({ status: 'idle', activePath: '/', chats: [], pinnedPaths: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreStores.forEach(restore => restore());
  document.body.replaceChildren();
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const render = async (element: React.ReactNode) => {
  await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
  const button = document.querySelector('button');
  if (!button) throw new Error('Missing pin menu item');
  return button;
};

test('pins inactive menu target using authoritative ownership and updates live from sidebar mutations', async () => {
  const button = await render(<HeaderSessionPinMenuItem sessionId="target" directory="/stale-hint" Item={Item} />);
  expect(button.textContent).toBe('Pin to sidebar');
  await act(async () => button.click());
  expect(isSessionPinned(useSessionPinnedStore.getState().ids, session.directory, session.id)).toBe(true);
  expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/wrong-active-directory', session.id)).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('other');
  expect(button.textContent).toBe('Unpin from sidebar');
  await act(async () => useSessionPinnedStore.getState().toggle({ directory: '/authoritative-worktree', sessionId: session.id }));
  expect(button.textContent).toBe('Pin to sidebar');
});

test('re-resolves a moved session and refuses unknown ownership', async () => {
  const button = await render(<HeaderSessionPinMenuItem sessionId="target" directory="/stale-hint" Item={Item} />);
  await act(async () => useGlobalSessionsStore.getState().upsertSession({ ...session, directory: '/moved' }));
  await act(async () => button.click());
  expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/moved', session.id)).toBe(true);
  const missing = await render(<HeaderSessionPinMenuItem sessionId="unknown" directory={null} Item={Item} />);
  expect(missing.disabled).toBe(true);
});

for (const [tabId, store, url] of [
  ['website:claude', useClaudeStore, 'https://claude.ai/observed-page'],
] as const) {
  test(`${tabId} saves observed metadata only and disables root, loading, and external URLs`, async () => {
    const button = await render(<WebsiteTabPinMenuItem tabId={tabId} Item={Item} />);
    expect(button.disabled).toBe(true);
    await act(async () => store.getState().adoptPageTitle(new URL('/', url).href, 'Provider home'));
    expect(button.disabled).toBe(true);
    await act(async () => store.getState().adoptPageTitle(url, 'Observed page'));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(store.getState().savedPages).toEqual([{ url, title: 'Observed page' }]);
    expect(button.textContent).toBe('Unpin from sidebar');
    await act(async () => button.click());
    expect(store.getState().savedPages).toEqual([]);
    for (const invalid of ['', 'https://example.com/page', `${url}?secret=ignored`, `${url}#fragment`]) {
      await act(async () => store.getState().adoptPageTitle(invalid, 'Invalid'));
      expect(button.disabled).toBe(true);
    }
  });
}

test('ChatGPT requires current ready observed conversation, never root or stale snapshots', async () => {
  const button = await render(<WebsiteTabPinMenuItem tabId="website:chatgpt" Item={Item} />);
  expect(button.disabled).toBe(true);
  await act(async () => useChatGPTStore.setState({ status: 'ready', activePath: '/c/observed-id', chats: [{ path: '/c/observed-id', title: 'Observed' }] }));
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(useChatGPTStore.getState().pinnedPaths).toEqual(['/c/observed-id']);
  expect(button.textContent).toBe('Unpin from sidebar');
  await act(async () => useChatGPTStore.setState({ status: 'unavailable' }));
  expect(button.disabled).toBe(true);
  await act(async () => useChatGPTStore.setState({ status: 'ready', activePath: '/c/not-observed' }));
  expect(button.disabled).toBe(true);
});

test('pin labels are translated in every shipped locale without remounting or changing the pin', async () => {
  const button = await render(<HeaderSessionPinMenuItem sessionId="target" directory="/authoritative-worktree" Item={Item} />);
  await act(async () => button.click());
  for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'] as const) {
    await act(async () => new Promise<void>(resolve => {
      const unsubscribe = useI18nStore.subscribe(state => {
        if (state.loadingLocale === null) { unsubscribe(); resolve(); }
      });
      useI18nStore.getState().setLocale(locale);
      if (useI18nStore.getState().loadingLocale === null) { unsubscribe(); resolve(); }
    }));
    const messages = useI18nStore.getState().dictionary;
    expect(messages['header.sessionTabs.pinSidebar']).not.toBe('Pin to sidebar');
    expect(messages['header.sessionTabs.unpinSidebar']).not.toBe('Unpin from sidebar');
    expect(button.textContent).toBe(messages['header.sessionTabs.unpinSidebar']);
    expect(document.querySelector('button')).toBe(button);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/authoritative-worktree', session.id)).toBe(true);
  }
});
