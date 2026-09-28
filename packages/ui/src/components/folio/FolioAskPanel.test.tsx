import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { makeBlock, statusSchema, type FolioNote } from '@/lib/folio/schema';
import type { Root } from 'react-dom/client';

// The composer is a controlled textarea, so React's change event has to see a
// DOM that already exists when react-dom is first imported. The globals are
// installed before that import for the same reason the rest of the suite does.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useFolioStore } = await import('@/lib/folio/store');
const { useFolioAskModelStore, writePageChats } = await import('@/lib/folio/ask');
const { FOLIO_ASK_AGENT, FOLIO_ASK_PERMISSIONS } = await import('@/lib/folio/ask-agent');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { FolioAskPanel } = await import('./FolioAskPanel');

const page: FolioNote = { id: 'F61645A9-DC34-499F-B2FA-CA73D7254098', title: 'Villanova Law', icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1 };
const child: FolioNote = { ...page, id: '0B2E5C41-9C7B-4B0E-9C0B-2E1D6A5F7A11', title: 'Constitutional Law', parentID: page.id };
const syllabus: FolioNote = {
  ...page,
  id: '9A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D',
  title: 'Syllabus',
  blocks: [{ id: 'B0A1B2C3-D4E5-4F60-8A7B-8C9D0E1F2A3B', kind: 'attachment', text: 'Sylvanyn syllabus.pdf', checked: false, highlight: 'none' }],
};

const catalog = [{
  id: 'openrouter', name: 'OpenRouter', activation: 'auto' as const, package: '@ai-sdk/openai-compatible',
  models: [{
    id: 'stealth/space-bunny-alpha', modelID: 'stealth/space-bunny-alpha', providerID: 'openrouter', name: 'Space Bunny Alpha',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [{ id: 'low' }, { id: 'max' }],
    time: { released: 0 }, cost: [], status: 'active' as const, enabled: true, limit: { context: 1000, output: 1000 },
  }],
}];

/** A row as the global session list delivers it, top-level or a subagent child. */
const session = (id: string, title: string, parentID?: string) => ({
  id, title, parentID, directory: '/Users/someone/Projects/app', projectID: 'p', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 },
});

const statusFor = (notes: FolioNote[]) => statusSchema.parse({
  notes, selectedID: notes[0].id, status: '', importing: false, importProgress: '', listening: false,
  dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.4, voices: [], recording: false, recordingStarting: false,
  transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [],
  reminders: false, fontSize: 16, highlightStrength: 0.8, aiBusy: false, messages: [],
});

describe('FolioAskPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  let askSelection: ReturnType<typeof useFolioAskModelStore.getState>['selection'];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    askSelection = useFolioAskModelStore.getState().selection;
    useFolioAskModelStore.getState().clear();
    useFolioStore.setState({ open: true, home: false, drafts: {}, status: statusFor([page, child, syllabus]) });
    useConfigStore.setState({
      providers: catalog,
      currentProviderId: 'openrouter',
      currentModelId: 'stealth/space-bunny-alpha',
      currentVariant: 'max',
      directoryScoped: {},
    });
    useGlobalSessionsStore.setState({
      activeSessions: [session('ses_1', 'Torts outline')],
    });
    useSkillsStore.setState({ skillsByDirectory: { __default__: [{ name: 'dataviz', path: '/skills/dataviz', scope: 'user', source: 'opencode', description: 'Charts that read well' }] } });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useFolioAskModelStore.setState({ selection: askSelection });
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
  });

  const draw = async () => { await act(async () => { root.render(<I18nProvider><FolioAskPanel note={page} onClose={() => {}} /></I18nProvider>); }); };
  const click = async (element: HTMLElement | null | undefined) => {
    await act(async () => { element?.click(); });
  };
  const thinking = () => host.querySelector('button[aria-label^="Thinking:"]')?.textContent;

  test('names the model it will answer with, and the thinking level it will use', async () => {
    await draw();
    expect(host.querySelector('button[aria-label="Model"]')?.textContent).toContain('Space Bunny Alpha');
    expect(thinking()).toBe('Max');
  });

  test('the thinking control steps through the levels the model declares and stops at Default', async () => {
    await draw();
    await click(host.querySelector<HTMLElement>('button[aria-label^="Thinking:"]'));
    expect(thinking()).toBe('Default');
    await click(host.querySelector<HTMLElement>('button[aria-label^="Thinking:"]'));
    expect(thinking()).toBe('Low');
    // The choice lands in the panel's own store, which is what the send reads,
    // so a model change made in a chat cannot move this conversation.
    expect(useFolioAskModelStore.getState().selection).toEqual({ providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha', variant: 'low' });
  });
});

describe('the Chats group in the Ask AI picker', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    useFolioAskModelStore.getState().clear();
    useFolioStore.setState({ open: true, home: false, drafts: {}, status: statusFor([page, child]) });
    useConfigStore.setState({ providers: catalog, currentProviderId: 'openrouter', currentModelId: 'stealth/space-bunny-alpha', currentVariant: 'max', directoryScoped: {} });
    useSkillsStore.setState({ skillsByDirectory: {} });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
  });

  const draw = async () => { await act(async () => { root.render(<I18nProvider><FolioAskPanel note={page} onClose={() => {}} /></I18nProvider>); }); };

  /** Types into the composer the way a person does, so the "@" list opens. */
  const typeMention = async (text: string) => {
    const field = host.querySelector('textarea');
    if (!field) throw new Error('Missing composer');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Missing textarea setter');
    await act(async () => {
      setValue.call(field, text);
      field.setSelectionRange(text.length, text.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  // A row is a label plus, sometimes, the page it sits under, so the label is
  // read on its own rather than as the whole row's text.
  const groupLabels = (label: string) => {
    const heading = [...host.querySelectorAll('[role="listbox"] div')].find((node) => node.textContent === label);
    return [...(heading?.parentElement?.querySelectorAll('[role="option"] span') ?? [])]
      .filter((node) => !node.className.includes('max-w-'))
      .map((node) => node.textContent);
  };
  const listText = () => host.querySelector('[role="listbox"]')?.textContent ?? '';

  test('offers the conversations the session list holds, and no subagent run', async () => {
    // A realistic snapshot: the conversations the user started, plus the child
    // sessions OpenCode records underneath them for every subagent it ran.
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('ses_chat', 'General Chat'),
        session('ses_statz', 'Statz'),
        session('ses_zdr', 'Routing to ZDR models on OpenRouter'),
        session('ses_sub_1', 'General Chat (@explorer subagent)', 'ses_chat'),
        session('ses_sub_2', 'Statz (@general subagent)', 'ses_statz'),
      ],
    });
    await draw();
    await typeMention('@');

    // The group is reached from the store, not from a list built in the test.
    expect(listText()).toContain('Chats');
    expect(groupLabels('Chats')).toEqual(['General Chat', 'Statz', 'Routing to ZDR models on OpenRouter']);
  });

  test('reaches a conversation the server left untitled rather than hiding it', async () => {
    useGlobalSessionsStore.setState({ activeSessions: [session('ses_blank', ''), session('ses_named', 'Statz')] });
    await draw();
    await typeMention('@');

    expect(groupLabels('Chats')).toEqual(['Untitled', 'Statz']);
  });

  test('one word finds a page and a conversation at once', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [session('ses_chat', 'Constitutional Law outline'), session('ses_sub', 'Constitutional Law outline (@explorer subagent)', 'ses_chat')],
    });
    await draw();
    await typeMention('@Constitutional');

    expect(groupLabels('Pages')).toEqual(['Constitutional Law']);
    expect(groupLabels('Chats')).toEqual(['Constitutional Law outline']);
  });

  test('says there is no conversation to mention instead of leaving the group out', async () => {
    useGlobalSessionsStore.setState({ activeSessions: [] });
    await draw();
    await typeMention('@');

    // The other groups still answer, and the empty Chats group explains itself,
    // so a session list that never arrived cannot read as an unfinished feature.
    expect(groupLabels('Pages')).toEqual(['Villanova Law', 'Constitutional Law']);
    expect(listText()).toContain('No chats to mention yet');
  });

  test('reports a search that matches nothing rather than showing a stale group', async () => {
    useGlobalSessionsStore.setState({ activeSessions: [session('ses_chat', 'General Chat')] });
    await draw();
    await typeMention('@zzzz');

    expect(host.querySelectorAll('[role="option"]').length).toBe(0);
    expect(listText()).toContain('Nothing to mention');
  });
});

/** The arguments one `sendMessage` call was made with. */
interface AskSend { content: string; agent?: string; parts?: Array<{ text: string }> }

describe('what a page conversation sends', () => {
  let host: HTMLDivElement;
  let root: Root;
  let sends: AskSend[];
  let sendMessage: ReturnType<typeof useSessionUIStore.getState>['sendMessage'];
  let agentName: string | undefined;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    sends = [];
    // A page that already has its conversation, so a send never has to create a
    // directory or a session: what is under test is what travels with the turn.
    writePageChats({ [page.id]: { sessionId: 'ses_page', directory: '/chats/session-page' } });
    useFolioStore.setState({
      open: true,
      home: false,
      drafts: {},
      status: statusFor([page, child]),
      api: { request: async (input) => (input.command === 'markdown' ? { id: page.id, ok: true, text: 'Contracts I read this term.' } : { id: page.id, ok: true }) },
    });
    useConfigStore.setState({ providers: catalog, currentProviderId: 'openrouter', currentModelId: 'stealth/space-bunny-alpha', currentVariant: 'max', directoryScoped: {}, currentAgentName: 'build' });
    useSkillsStore.setState({ skillsByDirectory: {} });
    // The ordinary chat is on a coding agent. A page conversation must not see it.
    agentName = useConfigStore.getState().currentAgentName;
    sendMessage = useSessionUIStore.getState().sendMessage;
    useSessionUIStore.setState({
      sendMessage: (content, _providerID, _modelID, agent, _attachments, _mention, parts) => {
        sends.push({ content, agent, parts });
        return Promise.resolve();
      },
    });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useSessionUIStore.setState({ sendMessage });
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
    writePageChats({});
  });

  const draw = async (note: FolioNote = page) => { await act(async () => { root.render(<I18nProvider><FolioAskPanel note={note} onClose={() => {}} /></I18nProvider>); }); };
  const ask = async (question: string, note: FolioNote = page) => {
    await draw(note);
    const field = host.querySelector('textarea');
    if (!field) throw new Error('Missing composer');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Missing textarea setter');
    await act(async () => {
      setValue.call(field, question);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(); });
  };
  const context = () => sends[0]?.parts?.[0]?.text ?? '';

  test('runs on Folio\'s own agent, not the one the ordinary chat is on', async () => {
    await ask('What does this page say?');

    expect(agentName).toBe('build');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.agent).toBe(FOLIO_ASK_AGENT);
  });

  test('keeps that agent when the ordinary chat is switched to another one', async () => {
    await ask('What does this page say?');
    useConfigStore.setState({ currentAgentName: 'plan' });
    await ask('And what about the cases?');

    expect(sends).toHaveLength(2);
    expect(sends.map((entry) => entry.agent)).toEqual([FOLIO_ASK_AGENT, FOLIO_ASK_AGENT]);
  });

  test('sends the page as the thing the question is about', async () => {
    await ask('What does this page say?');

    // The page is named as the subject before anything else, and its text is
    // wrapped as the page rather than left as an aside to the question.
    expect(context().indexOf(page.title)).toBeLessThan(context().indexOf('Contracts I read this term.'));
    expect(context()).toContain('Contracts I read this term.');
    expect(context()).toContain('do not search the filesystem');
  });

  test('withholds the content of a page the user excluded from AI', async () => {
    const privatePage = { ...page, title: 'Therapy notes', excludedFromAI: true };
    useFolioStore.setState({ status: statusFor([privatePage, child]) });

    await ask('What does this page say?', privatePage);

    expect(sends).toHaveLength(1);
    expect(context()).toContain('excluded from AI');
    expect(context()).not.toContain('Contracts I read this term.');
  });

  test('still carries the notebook tool set rather than the chat\'s tools', async () => {
    // The ruleset travels with the session, not with the turn, so it is asserted
    // where the page conversation gets it: Folio's own module.
    expect(FOLIO_ASK_PERMISSIONS[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(FOLIO_ASK_PERMISSIONS.filter((rule) => rule.effect === 'allow').map((rule) => rule.action))
      .toEqual(['folio', 'openchamber']);
  });
});
