import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { I18nProvider } from '@/lib/i18n';
import { AppearanceSection } from './FolioMobileSettings';

/**
 * The phone's appearance section against the store the Mac reads. A theme chosen here has to land in
 * the same three values a theme change on the Mac writes, or sync would carry a choice the other
 * device cannot make sense of.
 */
describe('the iPhone appearance section', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let context: ThemeContextValue | undefined;
  let originalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let changes: number;

  function Probe() {
    context = useThemeSystem();
    return null;
  }

  const shown = (): ThemeContextValue => {
    if (!context) throw new Error('The theme system has not mounted');
    return context;
  };

  const picker = (): HTMLSelectElement => {
    const select = host.querySelector('select');
    if (!select) throw new Error('The appearance section has no mode picker');
    return select;
  };

  /** Both variants of one theme, in the order the section lists them: light first, then dark. */
  const variants = (label: string): HTMLButtonElement[] =>
    [...host.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);

  const marked = (): string[] =>
    [...host.querySelectorAll('button')].filter((button) => button.querySelector('svg')).map((button) => button.textContent?.trim() ?? '');

  const tap = async (button: HTMLButtonElement | undefined): Promise<void> => {
    if (!button) throw new Error('That theme is not offered');
    await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  };

  /** React tracks the value it last rendered, so a mode change has to go through the native setter. */
  const chooseMode = async (mode: string): Promise<void> => {
    const setValue = Object.getOwnPropertyDescriptor(windowInstance.HTMLSelectElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('The select value setter is missing');
    const select = picker();
    await act(async () => {
      setValue.call(select, mode);
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };

  beforeEach(() => {
    windowInstance = new Window();
    const names = ['window', 'document', 'navigator', 'localStorage', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
    originalDescriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, navigator: windowInstance.navigator,
      localStorage: windowInstance.localStorage, Element: windowInstance.Element, HTMLElement: windowInstance.HTMLElement,
      Node: windowInstance.Node, Event: windowInstance.Event, CustomEvent: windowInstance.CustomEvent,
      fetch: () => Promise.resolve(Response.json({ themes: [] })),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    changes = 0;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    windowInstance.close();
  });

  const open = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <ThemeSystemProvider>
          <I18nProvider>
            <AppearanceSection onThemeChanged={() => { changes += 1; }} />
            <Probe />
          </I18nProvider>
        </ThemeSystemProvider>,
      );
    });
  };

  test('it offers the presets the app ships, in both variants', async () => {
    await open();
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toContain('Dracula');
    expect(labels).toContain('OpenChamber');
    // Most themes ship in both variants, listed apart so neither name is ambiguous.
    expect(variants('Dracula').length).toBe(2);
    expect(picker().getAttribute('aria-label')).toBe('Light or dark');
  });

  test('picking a theme writes the choice the Mac reads, and marks the theme in use', async () => {
    await open();
    const light = shown().lightThemeId;

    await tap(variants('Dracula')[1]);

    expect(shown().darkThemeId).toBe('dracula-dark');
    expect(shown().lightThemeId).toBe(light);
    expect(shown().themeMode).toBe('dark');
    expect(shown().currentTheme.metadata.id).toBe('dracula-dark');
    // The choice is made here, so a sync follows it to the Mac.
    expect(changes).toBe(1);
    expect(marked()).toEqual(['Dracula']);

    await tap(variants('Dracula')[0]);

    expect(shown().lightThemeId).toBe('dracula-light');
    expect(shown().themeMode).toBe('light');
    expect(shown().currentTheme.metadata.id).toBe('dracula-light');
    expect(changes).toBe(2);
  });

  test('following the system keeps both presets and only changes the mode', async () => {
    await open();
    await tap(variants('Dracula')[1]);
    await tap(variants('Dracula')[0]);

    await chooseMode('system');

    expect(shown().themeMode).toBe('system');
    expect(shown().darkThemeId).toBe('dracula-dark');
    expect(shown().lightThemeId).toBe('dracula-light');
    expect(changes).toBe(3);
  });
});
