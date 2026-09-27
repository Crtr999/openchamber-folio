import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { FolioRichBlock, folioNoteLinkPrefix } from './FolioRichBlock';
import { makeBlock, type FolioBlock } from '@/lib/folio/schema';

describe('FolioRichBlock', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

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
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  const draw = async (blocks: FolioBlock[]) => {
    await act(async () => {
      root.render(<>{blocks.map((block) => <FolioRichBlock key={block.id} block={block} lazy onOpenNote={(noteID) => { opened.push(noteID); }} onChange={() => {}} onFocus={() => {}} onBlur={() => {}} onSplit={() => {}} onKind={() => {}} onRemoveEmpty={() => {}} onSlash={() => {}} onSlashKey={() => false} />)}</>);
    });
  };

  const press = async (element: Element, x: number, y: number) => {
    await act(async () => { element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); });
  };
  const release = async (element: Element, x: number, y: number) => {
    await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); });
  };
  const editors = () => host.querySelectorAll('[contenteditable]').length;

  // Every editor listens to every selection change on the page, so a page drawn as a thousand
  // editors made opening and closing it compile a thousand ProseMirror schemas. Only a block that is
  // actually being edited may hold one.
  test('a page of blocks holds no editor until one of them is touched', async () => {
    const blocks = Array.from({ length: 100 }, (_, line) => ({ ...makeBlock(), text: `line ${line}` }));
    await draw(blocks);
    expect(host.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(host.textContent).toBe(blocks.map((block) => block.text).join(''));
  });

  // The store hands the page back with fresh block objects on every poll, and a block with an editor
  // checks what it drew before drawing again. A block without one has to do the same, or a long page
  // rebuilds every one of its lines each time anything else in the workspace changes.
  test('a drawn block redraws only when the block it was handed changed', async () => {
    const typed = { ...makeBlock(), text: 'a **bold** word', marks: undefined };
    await draw([typed]);
    // Legacy markup turns into a real mark the moment the page converts the block, so the store hands
    // back a different object that draws exactly the same words.
    const normalized = { ...typed, text: 'a bold word', marks: [{ start: 2, length: 4, style: 'bold' as const }] };
    const drawn = host.querySelector('p');
    await draw([normalized]);
    expect(host.textContent).toBe('a bold word');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelector('p')).toBe(drawn);

    await draw([{ ...normalized, text: 'a bold world' }]);
    expect(host.textContent).toBe('a bold world');
    expect(host.querySelector('p')).not.toBe(drawn);
  });

  // The click that ends a press builds the editor, so the click that ends a drag must not: that is
  // the gesture for choosing text, and replacing the block's markup to start an editor would throw
  // the selection the user just made away.
  test('a drag inside a block selects text instead of starting an editor', async () => {
    await draw([{ ...makeBlock(), text: 'a line worth selecting' }]);
    const drawn = host.querySelector('p');
    await press(host.firstElementChild!, 10, 10);
    await release(host.firstElementChild!, 48, 14);
    expect(editors()).toBe(0);
    expect(host.querySelector('p')).toBe(drawn);
  });

  test('a press that lands where it was released starts the editor', async () => {
    await draw([{ ...makeBlock(), text: 'a line to put the caret in' }]);
    await press(host.firstElementChild!, 10, 10);
    await release(host.firstElementChild!, 12, 12);
    expect(editors()).toBe(1);
  });

  // A click the browser sends without a press in front of it still has to work, or a block could stop
  // taking the caret with nothing to show for it.
  test('a click with no press behind it starts the editor', async () => {
    await draw([{ ...makeBlock(), text: 'a line to put the caret in' }]);
    await release(host.firstElementChild!, 10, 10);
    expect(editors()).toBe(1);
  });

  // A drag that begins on a link is a selection too, so it selects and opens nothing; only a click on
  // the link opens the page.
  test('a link opens on a click and only on a click', async () => {
    await draw([{ ...makeBlock(), text: 'open this', marks: [{ start: 0, length: 9, style: 'link', value: `${folioNoteLinkPrefix}ABC` }] }]);
    const link = host.querySelector('a');
    await press(link!, 10, 10);
    await release(link!, 60, 16);
    expect(opened).toEqual([]);
    expect(host.querySelector('a')).toBe(link);

    await press(link!, 10, 10);
    await release(link!, 10, 10);
    expect(opened).toEqual(['ABC']);
    expect(editors()).toBe(0);
  });
});
