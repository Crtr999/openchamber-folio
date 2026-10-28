import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

// Synthetic browser and synthetic runtime only. No live server or PIN is used.
const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  ResizeObserver: browser.ResizeObserver, MutationObserver: browser.MutationObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const previousFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('/zdr-lock/')) return new Promise<Response>(() => {});
  calls.push(new URL(url, 'http://localhost').pathname);
  if (url.endsWith('/state')) return Response.json({ pinSet: true, unlocked: false, directories: ['/synthetic/ZDR Legal'], retryAfterMs: 0 });
  if (url.endsWith('/verify')) return Response.json({ ok: true, accessToken: 'synthetic-grant', expiresAt: Date.now() + 60_000 });
  return Response.json({ ok: true });
}, previousFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useZdrLockStore } = await import('@/stores/useZdrLockStore');
const { ZdrLockCurtain } = await import('./ZdrLockCurtain');

function isInputElement(node: Element | null): node is HTMLInputElement {
  return node?.tagName === 'INPUT';
}

afterAll(async () => {
  useZdrLockStore.getState().reset();
  globalThis.fetch = previousFetch;
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('synthetic Legal curtain visibly transitions locked -> unlocked -> relocked using the real lock store and runtime boundary', async () => {
  useDirectoryStore.setState({ currentDirectory: '/synthetic/ZDR Legal' });
  await useZdrLockStore.getState().refresh();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><main>Synthetic Legal workspace</main><ZdrLockCurtain /></I18nProvider>));
    expect(document.querySelector('[role="dialog"][aria-label="ZDR folder locked"]')).not.toBeNull();
    expect(document.querySelector('input[type="password"][aria-label="Four-digit PIN"]')).not.toBeNull();
    const input = document.querySelector('input[aria-label="Four-digit PIN"]');
    if (!isInputElement(input)) throw new Error('Missing PIN input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '4821');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useZdrLockStore.getState().unlocked).toBe(true);
    expect(document.querySelector('[aria-label="ZDR folder locked"]')).toBeNull();
    expect(host.textContent).toContain('Synthetic Legal workspace');
    await act(async () => useZdrLockStore.getState().lock());
    expect(document.querySelector('[aria-label="ZDR folder locked"]')).not.toBeNull();
    expect(calls).toContain('/api/openchamber/zdr-lock/verify');
    expect(calls).toContain('/api/openchamber/zdr-lock/lock');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
