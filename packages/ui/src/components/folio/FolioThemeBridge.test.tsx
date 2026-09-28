import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { z } from 'zod';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { FolioThemeBridge } from './FolioThemeBridge';
import { syncedThemeSchema, type SyncedTheme } from '@/lib/folio/theme-sync';

/** What the window reports: the choice it is showing, and the moment that choice was made. */
const reportedSchema = syncedThemeSchema.extend({ at: z.number().optional() });
type Reported = z.infer<typeof reportedSchema>;

const reportArgsSchema = z.object({ action: z.literal('theme'), theme: reportedSchema });

/**
 * The Mac end of the theme sync, against the desktop bridge the preload exposes. What matters here is
 * the stamping: a report without a change time is the Mac's standing theme, and a phone theme that is
 * applied is reported back with the phone's own stamp so the two devices stop exchanging it.
 */
describe('the Mac theme bridge', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let context: ThemeContextValue | undefined;
  let originalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let reports: Reported[];
  let pending: SyncedTheme | null;

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
    reports = [];
    pending = null;
    Object.assign(windowInstance, {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_PLATFORM__: 'darwin',
      __OPENCHAMBER_DESKTOP__: {
        invoke: (command: string, args?: { action?: unknown; theme?: unknown }) => {
          if (command !== 'desktop_folio_sync') return Promise.resolve(null);
          if (args?.action === 'theme-take') return Promise.resolve(pending);
          const parsed = reportArgsSchema.safeParse(args);
          if (!parsed.success) return Promise.resolve(null);
          reports.push(parsed.data.theme);
          return Promise.resolve(null);
        },
      },
    });
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
    await act(async () => { root.render(<ThemeSystemProvider><FolioThemeBridge /><Probe /></ThemeSystemProvider>); });
  };

  test('it reports what is showing, so a phone syncing now gets it', async () => {
    await open();
    expect(reports.length).toBe(1);
    expect(reports[0]).toEqual({ mode: shown().themeMode, light: shown().lightThemeId, dark: shown().darkThemeId });
    // Nothing was changed here, so the report must not claim to be a newer change than the phone's.
    expect(reports[0].at).toBeUndefined();

    const before = Date.now();
    await act(async () => { shown().setTheme('dracula-dark'); });
    expect(reports.at(-1)?.dark).toBe('dracula-dark');
    expect(reports.at(-1)?.at ?? 0).toBeGreaterThanOrEqual(before);
  });

  test('a phone theme is applied and reported back with the phone stamp', async () => {
    await open();
    const fromPhone: SyncedTheme = { mode: 'light', light: 'nord-light', dark: 'nord-dark', at: 1_700_000_000_000 };

    await act(async () => {
      windowInstance.dispatchEvent(new windowInstance.CustomEvent('folio:theme-synced', { detail: fromPhone }));
    });

    expect(shown().lightThemeId).toBe('nord-light');
    expect(shown().darkThemeId).toBe('nord-dark');
    expect(shown().themeMode).toBe('light');
    expect(reports.at(-1)).toEqual(fromPhone);
  });

  test('a window that opens after the phone synced picks the theme up once', async () => {
    const fromPhone: SyncedTheme = { mode: 'dark', light: 'openchamber-light', dark: 'dracula-dark', at: 1_700_000_000_000 };
    pending = fromPhone;

    await open();

    expect(shown().darkThemeId).toBe('dracula-dark');
    // The theme is reported back once, with the phone's own stamp, and not re-stamped as a change here.
    expect(reports.filter((entry) => entry.dark === 'dracula-dark' && entry.at === fromPhone.at).length).toBe(1);
    expect(reports.length).toBe(2);
  });

  test('an event that is not a theme leaves the window alone', async () => {
    await open();
    await act(async () => {
      windowInstance.dispatchEvent(new windowInstance.CustomEvent('folio:theme-synced', { detail: { mode: 'neon' } }));
    });

    expect(shown().lightThemeId).not.toBe('nord-light');
    expect(reports.length).toBe(1);
  });
});
