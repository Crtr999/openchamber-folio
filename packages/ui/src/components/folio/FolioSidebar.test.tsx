import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useFolioStore } from '@/lib/folio/store';
import { makeBlock, statusSchema, type FolioNote, type FolioRequest } from '@/lib/folio/schema';
import { FolioSidebar } from './FolioSidebar';

const research: FolioNote = { id: 'F61645A9-DC34-499F-B2FA-CA73D7254098', title: 'Research', icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1 };
const archived: FolioNote = { ...research, id: '0B2E5C41-9C7B-4B0E-9C0B-2E1D6A5F7A11', title: 'Old note', trashed: true };
const status = statusSchema.parse({
  notes: [research, archived], selectedID: research.id, status: '', importing: false, importProgress: '', listening: false,
  dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.4, voices: [], recording: false, recordingStarting: false,
  transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [],
  reminders: false, fontSize: 16, highlightStrength: 0.8, aiBusy: false, messages: [],
});

describe('FolioSidebar', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let requests: FolioRequest[];

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
    useFolioStore.setState({
      open: true, home: false, drafts: {}, status,
      api: { request: async (input: FolioRequest) => { requests.push(input); return { id: 'test', ok: true }; } },
    });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useFolioStore.setState({ open: false, status: undefined, api: undefined });
  });

  const draw = async () => {
    await act(async () => { root.render(<I18nProvider><FolioSidebar /></I18nProvider>); });
  };
  const fire = async (element: Element | null | undefined, type: 'click' | 'contextmenu') => {
    await act(async () => { element?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 40, clientY: 40 })); });
  };
  const press = async (key: string) => {
    await act(async () => { document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })); });
  };
  const rowButton = (title: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === title);
  // The menu and the confirmation both go to the document body, out of the sidebar's clipped column.
  const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label);
  const dialog = () => document.querySelector('[role="dialog"]');
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === label);
  const openMenuOn = async (title: string) => { await fire(rowButton(title), 'contextmenu'); };

  // A page tree row and the Trash section are one tap away from each other, and moving a page out of the
  // tree leaves the pointer over a different page, so the tap is worth a second look before it happens.
  test('moving a page to the Trash asks first', async () => {
    await draw();
    await openMenuOn('Research');
    await fire(menuItem('Move to Trash'), 'click');
    expect(requests).toEqual([]);
    expect(dialog()?.textContent).toContain('The page moves to the Trash. Nothing is deleted, so you can bring it back.');
  });

  // Backing out of the confirmation has to leave the page exactly where it was, on the Cancel button and
  // on Escape, because the dialog opens under the same pointer that asked for it.
  test('cancelling the confirmation leaves the page in the notebook', async () => {
    await draw();
    await openMenuOn('Research');
    await fire(menuItem('Move to Trash'), 'click');
    await fire(dialogButton('Cancel'), 'click');
    expect(dialog()).toBeNull();
    expect(requests).toEqual([]);

    await openMenuOn('Research');
    await fire(menuItem('Move to Trash'), 'click');
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(requests).toEqual([]);
  });

  // Only the confirmation puts the page in the Trash, and it says which way the flag goes, because the
  // engine keeps the page either way.
  test('confirming the confirmation puts the page in the Trash', async () => {
    await draw();
    await openMenuOn('Research');
    await fire(menuItem('Move to Trash'), 'click');
    await fire(dialogButton('Remove'), 'click');
    expect(requests).toEqual([{ command: 'trash', noteID: research.id, flag: false }]);
    expect(dialog()).toBeNull();
  });

  // Restoring is the way back out of the Trash, so a dialog in front of it would only slow that down.
  test('restoring a page from the Trash never asks', async () => {
    await draw();
    await fire(rowButton('Trash1'), 'click');
    await openMenuOn('Old note');
    await fire(menuItem('Restore'), 'click');
    expect(requests).toEqual([{ command: 'trash', noteID: archived.id, flag: true }]);
    expect(dialog()).toBeNull();
  });

  // The confirmation only claimed the trash item: the rest of the menu is a page's everyday controls.
  test('the other menu items still run their command', async () => {
    await draw();
    await openMenuOn('Research');
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent))
      .toEqual(['Open', 'Add a page inside', 'Favorite', 'Duplicate', 'Move to Trash']);
    await fire(menuItem('Duplicate'), 'click');
    expect(requests).toEqual([{ command: 'duplicate', noteID: research.id }]);
  });

  // The Trash section is what makes the promise in the confirmation true, so it keeps its count and its list.
  test('the Trash section still counts and lists trashed pages', async () => {
    await draw();
    const header = rowButton('Trash1');
    expect(header).toBeDefined();
    await fire(header, 'click');
    expect(host.textContent).toContain('Old note');
  });
});
