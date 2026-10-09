import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useMuseStore } from '@/stores/useMuseStore';
import { MuseWorkspace } from './MuseWorkspace';

let browser: Window;
let host: HTMLDivElement;
let root: Root;
let descriptors: Map<string, PropertyDescriptor | undefined>;
const globals = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];

beforeEach(() => {
  browser = new Window({ url: 'http://localhost:3000' });
  descriptors = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useMuseStore.getState().resetWebsite();
});

afterEach(async () => {
  await act(async () => root.unmount());
  useMuseStore.getState().resetWebsite();
  browser.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(visible: boolean) {
  await act(async () => root.render(<I18nProvider><MuseWorkspace visible={visible} /></I18nProvider>));
}

test('opens lazily and retains exactly one website guest with tabs owned by the header', async () => {
  await render(false);
  expect(host.querySelector('webview')).toBeNull();
  await act(async () => useMuseStore.getState().open('home'));
  await render(true);
  const guest = browser.document.querySelector('webview');
  if (!guest) throw new Error('Expected Muse guest');
  let loads = 0;
  let focuses = 0;
  Object.assign(guest, {
    getURL: () => 'https://muse.ai/?aymh_complete=1',
    getTitle: () => 'Muse — Your Personal AI Agent',
    canGoBack: () => true,
    canGoForward: () => false,
    loadURL: async () => { loads++; },
    focus: () => { focuses++; },
  });
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  expect(loads).toBe(0); // src has already fulfilled the initial Home request.
  expect(useMuseStore.getState().pageTitle).toBe('Muse — Your Personal AI Agent');
  expect(host.textContent).toContain('Muse history mirroring is not verified');
  const full = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Full Muse');
  if (!full) throw new Error('Expected Full Muse control');
  await act(async () => full.click());
  expect(focuses).toBe(1);
  expect(loads).toBe(0);
  for (let i = 0; i < 3; i++) {
    await render(false);
    expect(host.querySelector('webview')).toBe(guest);
    await act(async () => useMuseStore.getState().open());
    await render(true);
    expect(host.querySelector('webview')).toBe(guest);
  }
  expect(host.querySelectorAll('webview').length).toBe(1);
  expect(host.querySelectorAll('[role="tab"]').length).toBe(0);
  expect(loads).toBe(0);
  await act(async () => useMuseStore.getState().open('home'));
  expect(loads).toBe(1);
  expect(guest.getAttribute('partition')).toBe('persist:open-carter-muse');
  expect(guest.hasAttribute('preload')).toBe(false);
  expect(guest.hasAttribute('allowpopups')).toBe(true); // Main denies extra windows and loads links in place.
});

test('does not mirror external login page titles and keeps website failures explicit', async () => {
  await render(true);
  const guest = browser.document.querySelector('webview');
  if (!guest) throw new Error('Expected Muse guest');
  Object.assign(guest, {
    getURL: () => 'https://example.com/login',
    getTitle: () => 'Private sign-in title',
    canGoBack: () => false,
    canGoForward: () => false,
  });
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  expect(host.querySelector('[role="tab"]')).toBeNull();
  expect(useMuseStore.getState().pageTitle).toBe('');
  await act(async () => guest.dispatchEvent(new browser.CustomEvent('did-fail-load', { detail: { isMainFrame: true, errorCode: -105 } })));
  expect(host.textContent).toContain('This page could not be loaded');
});
