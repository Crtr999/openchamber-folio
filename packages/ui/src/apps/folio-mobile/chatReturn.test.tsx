import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import { makeBlock, statusSchema, type FolioNote } from '@/lib/folio/schema';
import { MobileAssistantList, type MobileView } from './FolioMobileHome';
import { useMobileChatStore, type MobileChat } from './chatStore';
import { returnToChat, useChatReturnStore, useNoteFromChat } from './chatReturn';

const page = (id: string, title: string): FolioNote => ({ id, title, icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1 });
const conversation = (id: string, title: string, modified = 1): MobileChat => ({ id, title, model: { provider: 'zen', id: 'gpt', name: 'GPT' }, messages: [{ id: `${id}-1`, role: 'user', content: `ask about ${title}` }], noteIDs: [], created: 1, modified });

const kitchen = conversation('AAAA1111', 'Kitchen plans', 3);
const roof = conversation('BBBB2222', 'Roof quote', 2);
const research = page('F61645A9-DC34-499F-B2FA-CA73D7254098', 'Research');
const budget = page('0B2E5C41-9C7B-4B0E-9C0B-2E1D6A5F7A11', 'Budget');

const status = (notes: FolioNote[], selectedID: string) => statusSchema.parse({
  notes, selectedID, status: '', importing: false, importProgress: '', listening: false,
  dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.4, voices: [], recording: false, recordingStarting: false,
  transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [],
  reminders: false, fontSize: 16, highlightStrength: 0.8, aiBusy: false, messages: [],
});

/**
 * The notes screen as the app drives it: the view it is on, and the page that is in front. A page
 * selected while the conversation is the surface behind it is the case this file is about.
 */
function NotesScreen({ view, onShowPage }: { view: MobileView; onShowPage: () => void }) {
  useNoteFromChat(view, onShowPage);
  return null;
}

describe('a page opened from a conversation', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let shown: number;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element, Node: windowInstance.Node, IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    shown = 0;
    useFolioStore.setState({ open: true, home: false, drafts: {}, status: status([research, budget], research.id) });
    useMobileChatStore.setState({ chats: [kitchen, roof], activeID: kitchen.id });
    useChatReturnStore.getState().forget();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useChatReturnStore.getState().forget();
    useMobileChatStore.setState({ chats: [], activeID: undefined });
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
  });

  /** Walks the app through a sequence of screens, the way a tap does. */
  const walk = async (steps: { view: MobileView; selectedID: string }[]) => {
    for (const step of steps) {
      await act(async () => {
        useFolioStore.setState({ status: status([research, budget], step.selectedID) });
        root.render(<NotesScreen view={step.view} onShowPage={() => { shown += 1; }} />);
      });
    }
  };

  test('tapping a page in a reply remembers the conversation, and the way back reopens that one', async () => {
    await walk([{ view: 'chat', selectedID: research.id }]);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();

    await walk([
      { view: 'chat', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
    ]);
    expect(shown).toBe(1);
    expect(useChatReturnStore.getState().chatID).toBe(kitchen.id);

    useMobileChatStore.setState({ activeID: roof.id });
    expect(returnToChat()).toBe(true);
    expect(useMobileChatStore.getState().activeID).toBe(kitchen.id);
  });

  test('a page opened from Home remembers no conversation, so the page offers no way back', async () => {
    await walk([
      { view: 'home', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
    ]);
    expect(shown).toBe(1);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();
    expect(returnToChat()).toBe(false);
  });

  test('the page in front on launch is the one the app was left on, and no conversation goes with it', async () => {
    await walk([{ view: 'notes', selectedID: budget.id }]);
    expect(shown).toBe(0);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();
  });

  test('a page the native editor opened itself forgets the conversation the other page came from', async () => {
    await walk([
      { view: 'chat', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
    ]);
    expect(useChatReturnStore.getState().chatID).toBe(kitchen.id);

    await walk([
      { view: 'chat', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
      { view: 'notes', selectedID: research.id },
    ]);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();
    expect(returnToChat()).toBe(false);
  });

  test('leaving the page spends the memory, so the next page from Home starts clean', async () => {
    await walk([
      { view: 'chat', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
      { view: 'home', selectedID: budget.id },
    ]);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();

    await walk([
      { view: 'notes', selectedID: budget.id },
      { view: 'home', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
    ]);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();
  });

  test('a conversation that is no longer on the phone is not offered as a way back', async () => {
    await walk([
      { view: 'chat', selectedID: research.id },
      { view: 'notes', selectedID: budget.id },
    ]);
    useMobileChatStore.setState({ chats: [roof], activeID: roof.id });
    expect(returnToChat()).toBe(false);
    expect(useChatReturnStore.getState().chatID).toBeUndefined();
    expect(useMobileChatStore.getState().activeID).toBe(roof.id);
  });

  test('tapping the conversation that is already open in the list still brings it up', async () => {
    const opened: (string | undefined)[] = [];
    useMobileChatStore.setState({ chats: [kitchen, roof], activeID: roof.id });
    await act(async () => { root.render(<I18nProvider><MobileAssistantList onBack={() => {}} onOpen={(id) => opened.push(id)} /></I18nProvider>); });
    // The list offers the conversation that is already open, and the store keeps that same conversation
    // selected, so the app puts the screen the user was reading back in front of them.
    const row = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Roof quote'));
    expect(row).toBeDefined();
    await act(async () => { row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(opened).toEqual([roof.id]);
    useMobileChatStore.getState().open(roof.id);
    expect(useMobileChatStore.getState().activeID).toBe(roof.id);
  });
});
