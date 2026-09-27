import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { FolioTable } from '@/lib/folio/schema';
import { FolioDatabase } from './FolioDatabase';

const table: FolioTable = {
  columns: [
    { id: 'title', name: 'Name', kind: 'title', options: [] },
    { id: 'status', name: 'Status', kind: 'status', options: ['Doing'] },
  ],
  rows: [{ id: 'row-1', values: { title: 'Protocols', status: 'Doing' } }],
  view: 'table',
};

describe('FolioDatabase', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];
  let saved: FolioTable[];

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
    opened = [];
    saved = [];
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  const draw = async (mobile: boolean) => {
    await act(async () => {
      root.render(<I18nProvider><FolioDatabase table={table} mobile={mobile}
        onChange={(next) => { saved.push(next); }}
        onOpenRow={(rowID) => { opened.push(rowID); }} /></I18nProvider>);
    });
  };
  const openButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open');
  const removeButton = () => host.querySelector('button[aria-label="Remove"]');
  const dialog = () => host.querySelector('[role="dialog"]');
  const tap = async (element: Element | null | undefined) => {
    await act(async () => { element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  };

  // The table view's only way into a row sat behind `group-hover/row:block`, and a touch screen reports
  // no hover-capable pointer, so the phone showed the row and nothing that opens it. It sits in the row
  // on a phone, so a long title truncates rather than running under the button.
  test('a row can be opened on a touch screen', async () => {
    await draw(true);
    const button = openButton();
    expect(button?.className).toContain('min-h-8');
    expect(button?.className).not.toContain('hidden');
    expect(button?.className).not.toContain('absolute');
    await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(opened).toEqual(['row-1']);
  });

  // A pointer reveals the same button over the title on hover, where the column is wide enough for it.
  test('a pointer still reveals the Open button on hover', async () => {
    await draw(false);
    const button = openButton();
    expect(button?.className).toContain('absolute');
    expect(button?.className).toContain('hidden');
    expect(button?.className).toContain('group-hover/row:block');
  });

  // `group-hover/row:visible` compiles to `@media (hover: hover)`, which a touch screen never matches, so the
  // delete button sat at `visibility: hidden` on the phone and the row could not be deleted there at all.
  test('a row can be deleted on a touch screen', async () => {
    await draw(true);
    const button = removeButton();
    expect(button?.className).toContain('min-h-8');
    expect(button?.className).not.toContain('invisible');
    expect(button?.className).not.toContain('group-hover/row:visible');
    await tap(button);
    expect(saved).toEqual([]);
  });

  // The phone shows the delete control on every row, where one stray thumb lands on it, and a row goes for
  // good: no trash, no undo. The tap opens a confirmation instead of deleting, and only the confirmation deletes.
  test('a touch delete asks before it deletes', async () => {
    await draw(true);
    await tap(removeButton());
    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('The row is deleted permanently and cannot be restored.');
    expect(saved).toEqual([]);

    const buttons = [...(panel?.querySelectorAll('button') ?? [])];
    await tap(buttons.find((button) => button.textContent === 'Remove'));
    expect(saved).toEqual([{ ...table, rows: [] }]);
    expect(dialog()).toBeNull();
  });

  // A second tap anywhere else, or Escape on the focused Cancel button, leaves the row alone.
  test('a touch delete can be dismissed without deleting', async () => {
    await draw(true);
    await tap(removeButton());
    const panel = dialog();
    const buttons = [...(panel?.querySelectorAll('button') ?? [])];
    await tap(buttons.find((button) => button.textContent === 'Cancel'));
    expect(dialog()).toBeNull();
    expect(saved).toEqual([]);

    await tap(removeButton());
    await act(async () => {
      document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(saved).toEqual([]);
  });

  // The Mac keeps the control hidden until the row is hovered, where one click is a deliberate act on a
  // wide, precise target, so it deletes without asking.
  test('a pointer deletes a row straight away', async () => {
    await draw(false);
    const button = removeButton();
    expect(button?.className).toContain('invisible');
    expect(button?.className).toContain('group-hover/row:visible');
    expect(button?.className).not.toContain('min-h-8');
    await tap(button);
    expect(saved).toEqual([{ ...table, rows: [] }]);
    expect(dialog()).toBeNull();
  });
});
