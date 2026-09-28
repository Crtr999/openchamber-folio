import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import { useFolioAskModelStore } from '@/lib/folio/ask';
import { makeBlock, statusSchema, type FolioNote } from '@/lib/folio/schema';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { FolioAskPanel } from './FolioAskPanel';

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

const statusFor = (notes: FolioNote[]) => statusSchema.parse({
  notes, selectedID: notes[0].id, status: '', importing: false, importProgress: '', listening: false,
  dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.4, voices: [], recording: false, recordingStarting: false,
  transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [],
  reminders: false, fontSize: 16, highlightStrength: 0.8, aiBusy: false, messages: [],
});

describe('FolioAskPanel', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let askSelection: ReturnType<typeof useFolioAskModelStore.getState>['selection'];

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
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
      activeSessions: [{ id: 'ses_1', title: 'Torts outline', directory: '/fixture', projectID: 'p', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }],
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
