import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import { announceMacTheme, clearFolioTheme, readFolioTheme, takeMacTheme, useFolioThemeSync } from './theme';

const light = getDefaultTheme(false).metadata.id;
const dark = getDefaultTheme(true).metadata.id;

/** What a Mac that has not seen a change of its own reports: the theme it is showing, unstamped. */
const macTheme = (over: Partial<{ mode: 'light' | 'dark' | 'system'; light: string; dark: string; at: number }> = {}) => ({
  mode: 'dark' as const, light, dark: 'dracula-dark', at: 0, ...over,
});

/** The phone as the app drives it: the theme it shows, and the record sync compares against the Mac's. */
function Phone() {
  useFolioThemeSync();
  return null;
}

describe('the iPhone theme in Folio sync', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let context: ThemeContextValue | undefined;
  let originalDescriptors: Map<string, PropertyDescriptor | undefined>;

  function Probe() {
    context = useThemeSystem();
    return null;
  }

  const shown = (): ThemeContextValue => {
    if (!context) throw new Error('The theme system has not mounted');
    return context;
  };

  beforeEach(() => {
    windowInstance = new Window();
    const names = ['window', 'document', 'navigator', 'localStorage', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
    originalDescriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, navigator: windowInstance.navigator,
      localStorage: windowInstance.localStorage, Element: windowInstance.Element, HTMLElement: windowInstance.HTMLElement,
      Node: windowInstance.Node, Event: windowInstance.Event, CustomEvent: windowInstance.CustomEvent,
      // The theme system's own reload of custom themes has nothing to serve here.
      fetch: () => Promise.resolve(Response.json({ themes: [] })),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
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
    await act(async () => { root.render(<ThemeSystemProvider><Phone /><Probe /></ThemeSystemProvider>); });
  };

  test('a phone that has not chosen a theme takes the one the Mac is showing', async () => {
    await open();
    expect(readFolioTheme()).toBeUndefined();

    const accepted = takeMacTheme(macTheme());
    expect(accepted?.dark).toBe('dracula-dark');
    await act(async () => { announceMacTheme(macTheme()); });

    expect(shown().darkThemeId).toBe('dracula-dark');
    expect(shown().themeMode).toBe('dark');
    // The Mac's stamp travels with its choice, so the phone does not look like the newest change.
    expect(readFolioTheme()?.at).toBe(0);
  });

  test('a theme chosen here is stamped, so it outranks the Mac standing choice', async () => {
    await open();
    const before = Date.now();
    await act(async () => { shown().setTheme('dracula-dark'); });

    const record = readFolioTheme();
    expect(record?.mode).toBe('dark');
    expect(record?.light).toBe(light);
    expect(record?.dark).toBe('dracula-dark');
    expect(record?.at ?? 0).toBeGreaterThanOrEqual(before);

    // The Mac's report is older than that, so the phone keeps what the user picked here.
    expect(takeMacTheme(macTheme({ at: before - 60_000 }))).toBeUndefined();
    expect(shown().darkThemeId).toBe('dracula-dark');
    expect(readFolioTheme()?.dark).toBe('dracula-dark');
  });

  test('a newer Mac choice replaces the phone record and keeps the Mac stamp', async () => {
    await open();
    await act(async () => { shown().setDarkThemePreference('dracula-dark'); });
    const chosen = readFolioTheme()?.at ?? 0;
    const fromMac = macTheme({ mode: 'light', light: 'nord-light', dark: 'nord-dark', at: chosen + 1_000 });

    const accepted = takeMacTheme(fromMac);
    expect(accepted).toEqual(fromMac);
    await act(async () => { announceMacTheme(fromMac); });

    expect(shown().lightThemeId).toBe('nord-light');
    expect(shown().darkThemeId).toBe('nord-dark');
    expect(shown().themeMode).toBe('light');
    expect(readFolioTheme()).toEqual(fromMac);
  });

  test('an older peer without a theme changes nothing', async () => {
    await open();
    await act(async () => { shown().setTheme('dracula-dark'); });
    const record = readFolioTheme();

    // An older Mac build sends no theme at all, and a paired phone that has chosen nothing has none.
    expect(takeMacTheme(null)).toBeUndefined();
    expect(takeMacTheme(undefined)).toBeUndefined();
    expect(readFolioTheme()).toEqual(record);
    expect(shown().darkThemeId).toBe('dracula-dark');
  });

  test('pairing with a Mac again starts from that Mac theme', async () => {
    await open();
    await act(async () => { shown().setTheme('dracula-dark'); });
    expect(readFolioTheme()).toBeDefined();

    clearFolioTheme();
    expect(readFolioTheme()).toBeUndefined();
    expect(takeMacTheme(macTheme())?.dark).toBe('dracula-dark');
  });
});
