import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClaudeLogo } from '@/components/ui/ClaudeLogo';
import { I18nProvider } from '@/lib/i18n';
import { useClaudeStore } from '@/stores/useClaudeStore';
import { useUIStore } from '@/stores/useUIStore';
import { ClaudeWorkspace } from './ClaudeWorkspace';

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
  useClaudeStore.getState().resetWebsite();
  useUIStore.getState().setSessionTabsEnabled(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useClaudeStore.getState().resetWebsite();
  browser.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(visible: boolean) {
  await act(async () => root.render(<I18nProvider><ClaudeWorkspace visible={visible} /></I18nProvider>));
}

test('Claude opens lazily and retains one guest across selections; Full never reloads a draft', async () => {
  await render(false);
  expect(host.querySelector('webview')).toBeNull();
  await act(async () => useClaudeStore.getState().open('home'));
  await render(true);
  const guest = browser.document.querySelector('webview');
  if (!guest) throw new Error('Expected Claude guest');
  let loads = 0;
  let focusCount = 0;
  Object.assign(guest, {
    getURL: () => 'https://claude.ai/', getTitle: () => 'Claude',
    canGoBack: () => true, canGoForward: () => false,
    loadURL: async () => { loads++; }, focus: () => { focusCount++; },
  });
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  for (let i = 0; i < 3; i++) {
    await render(false);
    await act(async () => useClaudeStore.getState().open());
    await render(true);
    expect(host.querySelector('webview')).toBe(guest);
  }
  expect(host.querySelectorAll('webview').length).toBe(1);
  expect(guest.getAttribute('src')).toBe('https://claude.ai/');
  expect(guest.getAttribute('partition')).toBe('persist:open-carter-claude');
  expect(guest.hasAttribute('preload')).toBe(false);
  const full = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Full Claude');
  if (!full) throw new Error('Expected Full Claude control');
  await act(async () => full.click());
  expect(focusCount).toBe(1);
  expect(loads).toBe(0);
  expect(host.textContent).toContain('Saved links are local to this device');
  const logo = host.querySelector('#claude-website-tab span[aria-hidden="true"]');
  expect(logo?.classList.contains('bg-current')).toBe(true);
  expect(host.querySelector('#claude-website-tab svg')).toBeNull();
});

test('Claude branding uses the bundled symbol as a theme-colored mask', () => {
  const markup = renderToStaticMarkup(<ClaudeLogo className="size-4" />);
  expect(markup).toContain('claude-code.svg');
  expect(markup).toContain('mask-image:');
  expect(markup).toContain('bg-current size-4');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain('robot-2');
});

test('external sign-in title is excluded and load failure is explicit', async () => {
  await render(true);
  const guest = browser.document.querySelector('webview');
  if (!guest) throw new Error('Expected Claude guest');
  Object.assign(guest, {
    getURL: () => 'https://accounts.example/login', getTitle: () => 'Private account',
    canGoBack: () => false, canGoForward: () => false,
  });
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  expect(useClaudeStore.getState().pageTitle).toBe('');
  await act(async () => guest.dispatchEvent(new browser.CustomEvent('did-fail-load', { detail: { isMainFrame: true, errorCode: -105 } })));
  expect(host.textContent).toContain('This page could not be loaded');
});

test('navigation clears the previous live title before adopting the next page', async () => {
  await render(true);
  const guest = browser.document.querySelector('webview');
  if (!guest) throw new Error('Expected Claude guest');
  let title = 'Previous workspace page';
  Object.assign(guest, {
    getURL: () => 'https://claude.ai/', getTitle: () => title,
    canGoBack: () => false, canGoForward: () => false,
  });
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  expect(useClaudeStore.getState().pageTitle).toBe(title);
  await act(async () => guest.dispatchEvent(new browser.Event('did-start-loading')));
  expect(useClaudeStore.getState().pageTitle).toBe('');
  title = 'Next workspace page';
  await act(async () => guest.dispatchEvent(new browser.Event('did-stop-loading')));
  expect(useClaudeStore.getState().pageTitle).toBe(title);
});

test('shared header tabs replace the local website tablist without remounting the guest', async () => {
  await render(true);
  const guest = host.querySelector('webview');
  expect(host.querySelectorAll('[role="tab"]').length).toBe(1);
  await act(async () => useUIStore.getState().setSessionTabsEnabled(true));
  expect(host.querySelectorAll('[role="tab"]').length).toBe(0);
  expect(host.querySelector('webview')).toBe(guest);
});
