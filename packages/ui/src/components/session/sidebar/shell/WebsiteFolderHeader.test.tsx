import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { WebsiteFolderHeader } from './WebsiteFolderHeader';

test('website folders share a replace-in-place disclosure without changing website selection', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const label of ['ChatGPT', 'Muse', 'Claude']) {
      let opened = 0;
      let toggled = 0;
      let added = 0;
      const render = (expanded: boolean) => root.render(<WebsiteFolderHeader
        label={label} logo={<span data-provider-logo={label} />} selected={true}
        expanded={expanded} controlsId={`${label}-pages`}
        onOpen={() => { opened++; }} onToggle={() => { toggled++; }}
      ><button aria-label="Add" onClick={() => { added++; }} /></WebsiteFolderHeader>);
      await act(async () => render(false));
      const disclosure = container.querySelector<HTMLButtonElement>('[aria-expanded]');
      const selection = container.querySelector<HTMLButtonElement>('[aria-pressed]');
      const logoSlot = container.querySelector('[data-provider-logo]')?.parentElement;
      expect(disclosure?.getAttribute('aria-controls')).toBe(`${label}-pages`);
      expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
      expect(disclosure?.type).toBe('button');
      expect(disclosure?.tabIndex).toBe(0);
      expect(disclosure?.classList.contains('absolute')).toBe(true);
      expect(disclosure?.classList.contains('left-4')).toBe(true);
      expect(disclosure?.classList.contains('group-focus-within/website:opacity-100')).toBe(true);
      expect(logoSlot?.classList.contains('group-hover/website:invisible')).toBe(true);
      expect(logoSlot?.classList.contains('group-focus-within/website:invisible')).toBe(true);
      expect(selection?.getAttribute('aria-pressed')).toBe('true');
      expect(selection?.classList.contains('pl-4')).toBe(true);
      expect(selection?.textContent).toContain(label);
      expect(container.firstElementChild?.classList.contains('bg-interactive-selection')).toBe(true);
      await act(async () => disclosure?.click());
      expect(toggled).toBe(1);
      expect(opened).toBe(0);
      await act(async () => selection?.click());
      expect(opened).toBe(1);
      expect(toggled).toBe(1);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add"]')?.click());
      expect(added).toBe(1);
      await act(async () => render(true));
      expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
