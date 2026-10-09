import { beforeEach, expect, test } from 'bun:test';
import { useChatGPTStore } from './useChatGPTStore';
import { useUIStore } from './useUIStore';
import type { WebsiteSnapshot } from '@/lib/chatgpt/website';

const snapshot = (account = 'A'): Extract<WebsiteSnapshot, { kind: 'ready' } > => ({ kind: 'ready', account, path: '/c/one', chats: [{ path: '/c/one', title: 'One' }], projects: [], integratedAvailable: true });
beforeEach(() => { useChatGPTStore.getState().resetWebsite(); useChatGPTStore.setState({ pinnedPaths: [] }); useUIStore.getState().closeMainSurfaces(); });

test('new chats discovered in website history become native history and tabs', () => {
  const store = useChatGPTStore.getState();
  store.adoptSnapshot(snapshot());
  expect(useChatGPTStore.getState().chats[0]?.path).toBe('/c/one');
  expect(useChatGPTStore.getState().openedPaths).toEqual(['/c/one']);
  const chats = useChatGPTStore.getState().chats;
  store.adoptSnapshot(snapshot());
  expect(useChatGPTStore.getState().chats).toBe(chats);
  store.markUnavailable();
  expect(useChatGPTStore.getState().chats).toBe(chats);
});

test('closing a tab leaves history and local pin intact', () => {
  const store = useChatGPTStore.getState();
  store.adoptSnapshot(snapshot()); store.togglePin('/c/one'); store.open(); store.closeTab('/c/one');
  expect(useChatGPTStore.getState().openedPaths).toEqual([]);
  expect(useChatGPTStore.getState().chats).toHaveLength(1);
  expect(useChatGPTStore.getState().pinnedPaths).toEqual(['/c/one']);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
});

test('account switch and logout clear ephemeral history and tabs', () => {
  const store = useChatGPTStore.getState(); store.adoptSnapshot(snapshot());
  store.adoptSnapshot({ ...snapshot('B'), path: '/', chats: [] });
  expect(useChatGPTStore.getState().openedPaths).toEqual([]);
  expect(useChatGPTStore.getState().chats).toEqual([]);
  store.adoptSnapshot(snapshot()); store.adoptSnapshot({ kind: 'signed-out' });
  expect(useChatGPTStore.getState().account).toBeNull();
  expect(useChatGPTStore.getState().chats).toEqual([]);
});

test('startup account clearing preserves pending shortcut, reset uses unique requests', () => {
  const store = useChatGPTStore.getState(); store.open({ kind: 'shortcut', label: 'Library' }, 'full');
  const request = useChatGPTStore.getState().request; store.clearAccount();
  expect(useChatGPTStore.getState().request).toBe(request);
  store.resetWebsite(); store.open({ kind: 'navigate', path: '/' });
  expect(useChatGPTStore.getState().request?.sequence).toBeGreaterThan(request?.sequence ?? 0);
});

test('invalid native navigation cannot load a third-party page', () => {
  useChatGPTStore.getState().open({ kind: 'navigate', path: '//evil.example/' });
  expect(useChatGPTStore.getState().request).toBeNull();
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
});


test('a partial empty sidebar during navigation preserves previously loaded history', () => {
  const store = useChatGPTStore.getState(); store.adoptSnapshot(snapshot());
  store.adoptSnapshot({ ...snapshot(), path: '/', chats: [] });
  expect(useChatGPTStore.getState().chats).toEqual([{ path: '/c/one', title: 'One' }]);
  expect(useChatGPTStore.getState().activePath).toBe('/');
});
