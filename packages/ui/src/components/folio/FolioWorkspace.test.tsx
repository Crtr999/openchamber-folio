import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import { makeBlock, statusSchema, type FolioNote, type FolioRequest } from '@/lib/folio/schema';
import { FolioWorkspace, type FolioMobileHooks } from './FolioWorkspace';

const page: FolioNote = { id: 'F61645A9-DC34-499F-B2FA-CA73D7254098', title: 'Research', icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1 };
const statusFor = (note: FolioNote) => statusSchema.parse({
  notes: [note], selectedID: note.id, status: '', importing: false, importProgress: '', listening: false,
  dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.4, voices: [], recording: false, recordingStarting: false,
  transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [],
  reminders: false, fontSize: 16, highlightStrength: 0.8, aiBusy: false, messages: [],
});

describe('FolioWorkspace', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let requests: FolioRequest[];
  let viaBar: number;
  let viaChevron: number;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    requests = [];
    viaBar = 0;
    viaChevron = 0;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
  });

  const seed = (note: FolioNote) => {
    useFolioStore.setState({
      open: true, home: false, drafts: {}, status: statusFor(note),
      api: { request: async (input: FolioRequest) => { requests.push(input); return { id: 'test', ok: true }; } },
    });
  };
  const draw = async (note: FolioNote) => {
    seed(note);
    await act(async () => { root.render(<I18nProvider><FolioWorkspace /></I18nProvider>); });
  };
  const drawOnPhone = async (chatReturn?: { title: string; onBack: () => void }) => {
    seed(page);
    const mobile: FolioMobileHooks = {
      onMenu: () => { viaChevron += 1; }, chatReturn,
      onAddToChat: () => {}, onAttach: () => {}, onImport: () => {}, onExport: () => {}, onExportLibrary: () => {}, onSummarize: () => {},
    };
    await act(async () => { root.render(<I18nProvider><FolioWorkspace mobile={mobile} /></I18nProvider>); });
  };
  const fire = async (element: Element | null | undefined) => {
    await act(async () => { element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  };
  const buttonStartingWith = (label: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label));
  // The trash item lives in the ⋯ menu, which is only drawn while the menu is open.
  const openMenu = async () => { await fire(host.querySelector('button[aria-label="More"]')); };
  const menuButton = (label: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === label);
  const dialog = () => host.querySelector('[role="dialog"]');
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === label);
  const chooseTrash = async (label: string) => { await openMenu(); await fire(menuButton(label)); };

  // Reading a page and then losing it from the recent list is a worse outcome than a second tap, so the
  // editor's menu asks before the page goes.
  test('the editor menu asks before it puts a page in the Trash', async () => {
    await draw(page);
    await chooseTrash('Trash');
    expect(requests).toEqual([]);
    expect(dialog()?.textContent).toContain('The page moves to the Trash. Nothing is deleted, so you can bring it back.');
  });

  // Backing out leaves the page open and untouched, whether the user reads Cancel or presses Escape.
  test('cancelling the confirmation leaves the page alone', async () => {
    await draw(page);
    await chooseTrash('Trash');
    await fire(dialogButton('Cancel'));
    expect(dialog()).toBeNull();
    expect(requests).toEqual([]);
    expect(host.textContent).toContain('Research');
  });

  // The confirmation is the only thing that runs the command, against the page that is open.
  test('confirming the confirmation puts the page in the Trash', async () => {
    await draw(page);
    await chooseTrash('Trash');
    await fire(dialogButton('Remove'));
    expect(requests).toEqual([{ noteID: page.id, command: 'trash', flag: false }]);
    expect(dialog()).toBeNull();
  });

  // A page can be selected from the sidebar or a sync while the confirmation stands open, and the answer
  // belongs to the page the user was asked about, not to whatever is open when they press Remove.
  test('the confirmation trashes the page it was opened for', async () => {
    await draw(page);
    const other: FolioNote = { ...page, id: '0B2E5C41-9C7B-4B0E-9C0B-2E1D6A5F7A11', title: 'Other' };
    await chooseTrash('Trash');
    await act(async () => { useFolioStore.setState({ status: statusFor(other) }); });
    await fire(dialogButton('Remove'));
    expect(requests).toEqual([{ noteID: page.id, command: 'trash', flag: false }]);
  });

  // A page already in the Trash is put back from the same menu, and that direction has nothing to undo.
  test('restoring a page from the editor menu never asks', async () => {
    await draw({ ...page, trashed: true });
    await chooseTrash('Restore');
    expect(requests).toEqual([{ noteID: page.id, command: 'trash', flag: true }]);
    expect(dialog()).toBeNull();
  });

  // The phone's way back to the conversation a page came out of. It appears only when there is such a
  // conversation, because on a page opened from Home it would name a place the user never left.
  test('a page opened from a conversation offers it by name, and takes the user back to it', async () => {
    await drawOnPhone({ title: 'Kitchen plans', onBack: () => { viaBar += 1; } });
    expect(buttonStartingWith('Back to')?.textContent).toBe('Back to Kitchen plans');
    await fire(buttonStartingWith('Back to'));
    expect(viaBar).toBe(1);
  });

  test('a page with no conversation behind it still leaves through the back control, and names none', async () => {
    await drawOnPhone();
    expect(buttonStartingWith('Back to')).toBeUndefined();
    await fire(host.querySelector('button[aria-label="Back"]'));
    expect(viaChevron).toBe(1);
  });

  test('a conversation with no title yet is still a way back, without a name to name', async () => {
    await drawOnPhone({ title: '', onBack: () => { viaBar += 1; } });
    expect(buttonStartingWith('Back to')?.textContent).toBe('Back to chat');
    await fire(buttonStartingWith('Back to'));
    expect(viaBar).toBe(1);
  });

  // ---- The dots in the left margin, the way Notion takes a whole block.
  const threeLines: FolioNote = { ...page, title: 'Kitchen', blocks: [
    { ...makeBlock(), text: 'Buy milk' },
    { ...makeBlock(), text: 'Call the plumber' },
    { ...makeBlock(), text: 'Water the plants' },
  ] };
  const blocks = () => [...host.querySelectorAll('[data-block-id]')];
  const taken = () => blocks().filter((row) => row.className.includes('bg-interactive-selection'));
  const dots = (row: Element) => {
    const handle = row.querySelector('button[aria-label="Block type"]');
    if (!handle) throw new Error('the block drew no handle');
    return handle;
  };
  // happy-dom has no pointer capture, so the handle is handed the three methods a press uses.
  const press = async (element: Element, x: number, y: number, type: string) => {
    Object.assign(element, { setPointerCapture: () => {}, hasPointerCapture: () => true, releasePointerCapture: () => {} });
    await act(async () => { element.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 })); });
  };
  const clickDots = async (row: Element) => {
    const handle = dots(row);
    await press(handle, 20, 40, 'pointerdown');
    await press(handle, 20, 40, 'pointerup');
  };
  const pressKey = async (key: string, meta = false) => {
    await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key, metaKey: meta })); });
  };
  const blockTexts = () => (useFolioStore.getState().drafts[threeLines.id]?.note ?? useFolioStore.getState().status?.notes[0])?.blocks.map((block) => block.text);

  test('the dots take the whole block, and only that block', async () => {
    await draw(threeLines);
    await clickDots(blocks()[1]);
    expect(taken()).toEqual([blocks()[1]]);
    expect(blocks()[0].className).not.toContain('bg-interactive-selection');
    expect(blocks()[2].className).not.toContain('bg-interactive-selection');
  });

  // Otherwise there is no way back to nothing but Escape and clicking away, and the control feels stuck.
  test('the same dots again let the block go', async () => {
    await draw(threeLines);
    await clickDots(blocks()[1]);
    await clickDots(blocks()[1]);
    expect(taken()).toEqual([]);
  });

  // A drag moves the block and takes nothing: the same press is told apart by how far it travelled.
  test('a drag moves the block and selects nothing', async () => {
    await draw(threeLines);
    const handle = dots(blocks()[0]);
    await press(handle, 20, 40, 'pointerdown');
    await press(handle, 20, 140, 'pointermove');
    await press(handle, 20, 140, 'pointerup');
    expect(taken()).toEqual([]);
    expect(blockTexts()).toEqual(['Call the plumber', 'Water the plants', 'Buy milk']);
  });

  test('Delete on a block the dots took removes that block and no other', async () => {
    await draw(threeLines);
    await clickDots(blocks()[1]);
    await pressKey('Delete');
    expect(blockTexts()).toEqual(['Buy milk', 'Water the plants']);
    expect(taken()).toEqual([]);
  });

  test('Escape on a block the dots took lets it go', async () => {
    await draw(threeLines);
    await clickDots(blocks()[2]);
    expect(taken()).toHaveLength(1);
    await pressKey('Escape');
    expect(taken()).toEqual([]);
  });

  // The block menu keeps the keyboard, and the dots keep the pointer: one gesture, one outcome.
  test('the dots no longer open the block menu, but Enter and Space still do', async () => {
    await draw(threeLines);
    const kindButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Heading 1');
    expect(kindButton()).toBeUndefined();
    await clickDots(blocks()[0]);
    expect(kindButton()).toBeUndefined();
    expect(taken()).toHaveLength(1);

    await act(async () => { dots(blocks()[0]).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(kindButton()).toBeDefined();
    expect(taken()).toHaveLength(1);

    await act(async () => { dots(blocks()[0]).dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(kindButton()).toBeUndefined();
  });

  // A selection that survived the user reaching for the text would highlight a block they are editing.
  test('clicking into a taken block lets the highlight go so the caret can be put down', async () => {
    await draw(threeLines);
    await clickDots(blocks()[1]);
    expect(taken()).toHaveLength(1);
    const text = blocks()[1].querySelector('.folio-editable');
    if (!text) throw new Error('the block drew no text');
    await act(async () => { text.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, clientX: 60, clientY: 40 })); });
    expect(taken()).toEqual([]);
  });
});
