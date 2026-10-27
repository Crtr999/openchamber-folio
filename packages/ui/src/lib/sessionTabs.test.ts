import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { activateHeaderTab, activateSessionTabByIndex, activateAdjacentSessionTab, closeSessionTabAndActivateNeighbour } from './sessionTabs';

const browser = new Window({ url: 'http://localhost:3000' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, localStorage: browser.localStorage })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
Object.assign(browser, {
  __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
  __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
  __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:3000',
  __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000',
});
const initialSessionUI = useSessionUIStore.getState();
const initialUI = useUIStore.getState();
const initialSessions = useGlobalSessionsStore.getState();
const initialTabs = useSessionTabsStore.getState();
const selections: string[] = [];
let draftRequests = 0;
let creationRequests = 0;
const session = (id: string): Session => ({
  id, title: id, directory: '/workspace', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

beforeEach(() => {
  Object.assign(browser, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' }, __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000' });
  selections.length = 0;
  draftRequests = 0;
  creationRequests = 0;
  useUIStore.getState().closeMainSurfaces();
  useGlobalSessionsStore.setState({ activeSessions: [session('a'), session('b')] });
  useSessionTabsStore.setState({ tabIds: ['a', 'website:chatgpt', 'website:claude', 'b', 'unknown'] });
  useSessionUIStore.setState({
    currentSessionId: 'a',
    setCurrentSession: (id) => { if (id) selections.push(id); useSessionUIStore.setState({ currentSessionId: id }); },
    openNewSessionDraft: () => { draftRequests += 1; useSessionUIStore.setState({ currentSessionId: null }); },
    createSession: async () => { creationRequests += 1; return null; },
  });
});

afterEach(() => {
  useSessionUIStore.setState(initialSessionUI, true);
  useUIStore.setState(initialUI, true);
  useGlobalSessionsStore.setState(initialSessions, true);
  useSessionTabsStore.setState(initialTabs, true);
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('website selection resumes one tab; session selection closes website views without creation', () => {
  expect(activateSessionTabByIndex(1)).toBe(true);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(true);
  expect(activateSessionTabByIndex(1)).toBe(true);
  expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'website:chatgpt', 'website:claude', 'b', 'unknown']);
  expect(activateHeaderTab('b')).toBe(true);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  expect(selections).toEqual(['b']);
  expect(creationRequests).toBe(0);
  expect(draftRequests).toBe(0);
});

test('adjacent shortcuts use website selection and wrap in the rendered order', () => {
  activateHeaderTab('website:chatgpt');
  expect(activateAdjacentSessionTab(1)).toBe(true);
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  expect(activateAdjacentSessionTab(1)).toBe(true);
  expect(selections).toEqual(['b']);
  expect(activateAdjacentSessionTab(1)).toBe(true);
  expect(selections).toEqual(['b', 'a']);
});

test('closing active website selects its neighbour and retains unknown ids', () => {
  activateHeaderTab('website:chatgpt');
  closeSessionTabAndActivateNeighbour('website:chatgpt');
  expect(useUIStore.getState().isClaudePageOpen).toBe(true);
  expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'website:claude', 'b', 'unknown']);
  expect(useGlobalSessionsStore.getState().activeSessions.map(entry => entry.id)).toEqual(['a', 'b']);
  expect(creationRequests).toBe(0);
});

test('close-neighbour crosses from a session to a website and back to a session', () => {
  closeSessionTabAndActivateNeighbour('a');
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(true);
  activateHeaderTab('website:claude');
  closeSessionTabAndActivateNeighbour('website:claude');
  expect(useUIStore.getState().isClaudePageOpen).toBe(false);
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  expect(selections).toEqual(['b']);
  expect(useSessionTabsStore.getState().tabIds).toEqual(['website:chatgpt', 'b', 'unknown']);
  expect(creationRequests).toBe(0);
  expect(draftRequests).toBe(0);
});

test('closing underlying session does not leave active website or create a draft', () => {
  activateHeaderTab('website:chatgpt');
  closeSessionTabAndActivateNeighbour('a');
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(true);
  expect(selections).toEqual([]);
  expect(draftRequests).toBe(0);
});

test('last website closes to an unsent draft, never a created session', () => {
  useSessionTabsStore.setState({ tabIds: ['website:chatgpt', 'unknown'] });
  activateHeaderTab('website:chatgpt');
  closeSessionTabAndActivateNeighbour('website:chatgpt');
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  expect(useSessionTabsStore.getState().tabIds).toEqual(['unknown']);
  expect(draftRequests).toBe(1);
  expect(creationRequests).toBe(0);
});

test('unsupported runtime hides website destinations and unknown tabs cannot create pages', () => {
  Object.assign(browser, { __OPENCHAMBER_ELECTRON__: undefined });
  expect(activateHeaderTab('website:chatgpt')).toBe(false);
  expect(activateHeaderTab('website:chatgpt')).toBe(false);
  expect(activateHeaderTab('unknown')).toBe(false);
  expect(activateSessionTabByIndex(1)).toBe(true);
  expect(selections).toEqual(['b']);
  expect(activateSessionTabByIndex(2)).toBe(false);
  expect(creationRequests).toBe(0);
});

test('remote desktop cannot activate retained local website tabs and preserves their ids', () => {
  Object.assign(browser, { __OPENCHAMBER_API_BASE_URL__: 'https://remote.example.test' });
  expect(activateHeaderTab('website:chatgpt')).toBe(false);
  expect(activateHeaderTab('website:claude')).toBe(false);
  expect(activateSessionTabByIndex(1)).toBe(true);
  expect(selections).toEqual(['b']);
  expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'website:chatgpt', 'website:claude', 'b', 'unknown']);
});

test('Venice and Gemini tabs resume independently and close to their native neighbour', () => {
  useSessionTabsStore.setState({ tabIds: ['a', 'website:venice', 'website:gemini', 'b'] });
  expect(activateHeaderTab('website:venice')).toBe(true);
  expect(useUIStore.getState().isVenicePageOpen).toBe(true);
  expect(activateAdjacentSessionTab(1)).toBe(true);
  expect(useUIStore.getState().isGeminiPageOpen).toBe(true);
  expect(useUIStore.getState().isVenicePageOpen).toBe(false);
  closeSessionTabAndActivateNeighbour('website:gemini');
  expect(useUIStore.getState().isGeminiPageOpen).toBe(false);
  expect(selections).toEqual(['b']);
  expect(creationRequests).toBe(0);
});

test('remote and non-Electron runtimes cannot open either website account', () => {
  useSessionTabsStore.setState({ tabIds: ['website:venice', 'website:gemini'] });
  Object.assign(browser, { __OPENCHAMBER_API_BASE_URL__: 'https://remote.example.test' });
  for (const id of ['website:venice', 'website:gemini']) expect(activateHeaderTab(id)).toBe(false);
  Object.assign(browser, { __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000', __OPENCHAMBER_ELECTRON__: undefined });
  for (const id of ['website:venice', 'website:gemini']) expect(activateHeaderTab(id)).toBe(false);
  expect(useUIStore.getState().isVenicePageOpen || useUIStore.getState().isGeminiPageOpen).toBe(false);
});
