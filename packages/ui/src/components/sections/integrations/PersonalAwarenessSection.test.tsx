import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { PersonalAwarenessSection } from './PersonalAwarenessSection';

let root: Root;
let dom: Window;
let restore: () => void;
const originalFetch = globalThis.fetch;
const snapshot = {
  projects: [{ id: 'fixture', name: 'Synthetic home', models: [{ id: 'synthetic', name: 'Synthetic model' }] }],
  connected: { notion: false, calendar: false, mailAccounts: [] },
  approval: { enabled: false, projectId: 'fixture', modelID: 'synthetic', sources: ['past-chats'], mailAccounts: [] },
};
beforeEach(() => {
  dom = new Window({ url: 'https://fixture.invalid/' });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { Element: dom.Element, Node: dom.Node, navigator: dom.navigator, getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver, window: dom, document: dom.document, HTMLElement: dom.HTMLElement, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  restore = () => {
    for (const key of Object.keys(globals)) {
      const previous = descriptors[key];
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  restore();
});
const render = async () => {
  await act(async () => root.render(<I18nProvider><PersonalAwarenessSection /></I18nProvider>));
};
const button = (name: string) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent === name);

test('opening Connections never approves review and disconnected sources cannot be selected', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => { methods.push(init?.method ?? 'GET'); return Response.json({ ...snapshot, approval: null }); };
  await render();
  expect(methods).toEqual(['GET']);
  expect(button('Approve and enable review')?.disabled).toBe(true);
  const checks = Array.from(document.querySelectorAll('div[role="button"][aria-pressed]'));
  expect(checks.some((item) => item.getAttribute('aria-pressed') === 'true')).toBe(false);
  expect(checks.find((item) => item.textContent === 'Notion')?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('ZDR folders are always excluded');
  expect(document.querySelector('[data-settings-item="integrations.personal-awareness"]')).not.toBeNull();
});

test('explicit approval submits the exact selected model, folder and sources; revocation uses the same enrollment', async () => {
  const writes: Array<{ method: string; body: string }> = [];
  let enabled = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT' || init?.method === 'DELETE') {
      writes.push({ method: init.method, body: String(init.body ?? '') });
      enabled = init.method === 'PUT';
      return Response.json({ enabled });
    }
    return Response.json({ ...snapshot, approval: { ...snapshot.approval, enabled } });
  };
  await render();
  expect(button('Approve and enable review')?.disabled).toBe(true);
  const label = Array.from(document.querySelectorAll<HTMLElement>('div[role="button"][aria-pressed]')).find((item) => item.textContent?.includes('I approve sending excerpts'));
  expect(label).toBeDefined();
  await act(async () => label?.click());
  expect(button('Approve and enable review')?.disabled).toBe(false);
  await act(async () => button('Approve and enable review')?.click());
  expect(JSON.parse(writes[0].body)).toEqual({ approved: true, projectId: 'fixture', providerID: 'openai', modelID: 'synthetic', sources: ['past-chats'], mailAccounts: [] });
  expect(button('Approve and enable review')?.disabled).toBe(true);
  await act(async () => button('Revoke review approval')?.click());
  expect(writes.map((item) => item.method)).toEqual(['PUT', 'DELETE']);
  expect(button('Revoke review approval')).toBeUndefined();
});

test('an unavailable status stays an error and cannot become an empty successful approval', async () => {
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
  expect(button('Approve and enable review')?.disabled).toBe(true);
});
