import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { OpenRouterCreditsStatus } from '@/lib/desktop';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { OpenRouterBalanceBadge } = await import('./OpenRouterBalanceBadge');
let root: Root;
let calls: string[];
let response: OpenRouterCreditsStatus;

beforeEach(() => {
  calls = [];
  response = { configured: true, source: 'opencode', menuBar: false, balance: { kind: 'account', amount: 18.03, checked: 1 } };
  window.__OPENCHAMBER_ELECTRON__ = { runtime: 'electron' };
  window.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://localhost';
  Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: {
    invoke: async (command: string) => { calls.push(command); return response; },
  } });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: 'local' });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const render = async () => { await act(async () => root.render(<I18nProvider><OpenRouterBalanceBadge /></I18nProvider>)); };

test('the rail renders a compact coin with accessible official dollars, never token estimates or other provider reads', async () => {
  await render();
  expect(document.querySelector('button')?.textContent).toBe('$18.03');
  expect(document.querySelector('use')?.getAttribute('href')).toBe('#oc-coin');
  expect(document.querySelector('button')?.getAttribute('aria-label')).toContain('$18.03');
  expect(document.querySelector('button > span')?.className).toBe('sr-only');
  expect(calls).toEqual(['desktop_openrouter_credits']);
});
test('the remaining balance panel escapes rail clipping and closes on Escape', async () => {
  await render();
  await act(async () => document.querySelector('button')?.click());
  expect(document.querySelector('[role="dialog"]')?.parentElement).toBe(document.body);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('$18.03');
  await act(async () => browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test('failed refresh keeps last known dollars visibly stale instead of inventing zero', async () => {
  response = { ...response, error: 'Previous values may be stale.' };
  await render();
  expect(document.querySelector('button')?.textContent).toBe('$18.03');
  expect(document.querySelector('button')?.title).toContain('stale');
});
test('legacy spending never renders as a counter, and missing data never becomes zero', async () => {
  response = { ...response, balance: { kind: 'spent', amount: 7.48, checked: 1 } };
  await render();
  expect(document.querySelector('button')?.textContent).toBe('Balance unavailable');
  expect(document.querySelector('button')?.title).toContain('management key');
  await act(async () => document.querySelector('button')?.click());
  expect(document.body.textContent).not.toContain('used');
  expect(document.body.textContent).not.toContain('$7.48');
  expect(document.querySelector('input[type="password"]')?.getAttribute('aria-label')).toBe('OpenRouter management key');
  response = { configured: true, source: 'opencode', menuBar: false, error: 'Unavailable' };
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(document.body.textContent).not.toContain('$0');
});
test('a remaining key limit is not labeled as account credits', async () => {
  response = { ...response, balance: { kind: 'limit', amount: 8, checked: 1 } };
  await render();
  expect(document.querySelector('button')?.textContent).toBe('$8.00');
  expect(document.querySelector('button')?.title).toContain('remaining key limit, not account credits');
  await act(async () => document.querySelector('button')?.click());
  expect(document.body.textContent).toContain('Account credits require an OpenRouter management key');
});
test('no connected key offers secure balance setup without a invented amount', async () => {
  response = { configured: false, menuBar: false };
  await render();
  expect(document.querySelector('button')?.textContent).toBe('Connect balance');
  expect(document.body.textContent).not.toContain('$');
});
test('remote runtimes and web clients have no counter or credit polling', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://example.test', runtimeKey: 'remote:test' });
  await render();
  expect(document.querySelector('button')).toBeNull();
  expect(calls).toEqual([]);
  Reflect.deleteProperty(window, '__OPENCHAMBER_ELECTRON__');
  Reflect.deleteProperty(window, '__OPENCHAMBER_DESKTOP__');
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: 'local' }));
  expect(document.querySelector('button')).toBeNull();
  expect(calls).toEqual([]);
});
test('switching runtime removes the counter and ignores an in-flight local answer', async () => {
  let finish: ((value: OpenRouterCreditsStatus) => void) | undefined;
  Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: { invoke: async (command: string) => {
    calls.push(command);
    return new Promise<OpenRouterCreditsStatus>(resolve => { finish = resolve; });
  } } });
  await render();
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://example.test', runtimeKey: 'remote:test' }));
  await act(async () => finish?.(response));
  expect(document.querySelector('button')).toBeNull();
  expect(calls).toEqual(['desktop_openrouter_credits']);
});
