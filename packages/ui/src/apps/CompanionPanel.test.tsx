import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { CompanionPanel } from './CompanionPanel';

let root: Root;
let dom: Window;
let restore: () => void;
const originalFetch = globalThis.fetch;
class FixtureEventSource {
  static CLOSED = 2;
  static instances: FixtureEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) { FixtureEventSource.instances.push(this); }
  close() { this.readyState = 2; }
}
const settings = { activityEnabled: false, timezone: 'UTC', quietStart: '21:00', quietEnd: '08:00', dailyAlertLimit: 6 };
beforeEach(() => {
  FixtureEventSource.instances = [];
  dom = new Window({ url: 'https://carter.fixture.invalid/mobile.html' });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const globals = { Element: dom.Element, Node: dom.Node, navigator: dom.navigator, getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver, EventSource: FixtureEventSource, window: dom, document: dom.document, HTMLElement: dom.HTMLElement, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  restore = () => {
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  useProjectsStore.setState({ activeProjectId: 'fixture-project', projects: [{ id: 'fixture-project', path: '/workspace/fixture', label: 'Fixture', addedAt: 1, lastOpenedAt: 1 }] });
  useConfigStore.setState({ currentProviderId: 'fixture-provider', currentModelId: 'fixture-model' });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  restore();
});
const render = async () => {
  await act(async () => {
    root.render(<I18nProvider><CompanionPanel onClose={() => {}} /></I18nProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
};
test('renders server-owned follow-ups and a pause changes that same schedule', async () => {
  let enabled = true;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (init?.method === 'PATCH') {
      enabled = false;
      return Response.json({ task: {} });
    }
    return Response.json({ settings, inbox: [], tasks: [{ id: 'companion:12345678', name: 'Fixture opportunity', enabled, state: { lastSessionId: 'ses_fixture' } }] });
  };
  await render();
  expect(document.body.textContent).toContain('Fixture opportunity');
  expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Open result')).toBe(true);
  const pause = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Pause');
  expect(pause).toBeDefined();
  await act(async () => { pause?.click(); });
  expect(enabled).toBe(false);
  expect(document.body.textContent).toContain('Resume');
  expect(requests.filter((url) => url.includes('/api/projects/')).every((url) => url.includes('/api/projects/fixture-project/companion'))).toBe(true);
});
test('a failed refresh preserves previously loaded responsibilities', async () => {
  let fails = false;
  globalThis.fetch = async () => fails ? new Response('unavailable', { status: 503 }) : Response.json({ settings, inbox: [], tasks: [{ id: 'companion:12345678', name: 'Keep this responsibility', enabled: true, state: {} }] });
  await render();
  fails = true;
  const refresh = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Refresh');
  await act(async () => { refresh?.click(); });
  expect(document.body.textContent).toContain('Keep this responsibility');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
});
test('an uncertain save keeps the same responsibility ID on explicit retry', async () => {
  const submitted: Array<{ id: string }> = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') {
      submitted.push(JSON.parse(String(init.body)));
      return new Response('uncertain', { status: 503 });
    }
    return Response.json({ settings, inbox: [], tasks: [] });
  };
  await render();
  const form = document.querySelectorAll('form')[1];
  expect(form).not.toBeNull();
  // Submission exercises the event boundary even with an empty test form;
  // validation is enforced independently by the production server schema.
  await act(async () => { form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  expect(submitted).toHaveLength(2);
  expect(submitted[0].id).toBe(submitted[1].id);
});

test('a companion event refreshes the inbox and dismissal persists through the server boundary', async () => {
  let dismissed = false;
  let hasUpdate = false;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PATCH') { dismissed = true; return Response.json({ inbox: [] }); }
    return Response.json({ settings, tasks: [], inbox: hasUpdate && !dismissed ? [{ id: 'ses_inbox', title: 'A useful new lead', excerpt: 'Verified changed opportunity', createdAt: 1, seen: false }] : [] });
  };
  await render();
  expect(document.body.textContent).not.toContain('A useful new lead');
  hasUpdate = true;
  await act(async () => { FixtureEventSource.instances[0]?.onmessage?.({ data: JSON.stringify({ type: 'openchamber:companion-changed', properties: { projectId: 'fixture-project' } }) }); });
  expect(document.body.textContent).toContain('A useful new lead');
  expect(document.body.textContent).toContain('Unread');
  await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Dismiss')?.click(); });
  expect(dismissed).toBe(true);
  expect(document.body.textContent).not.toContain('A useful new lead');
});

test('opening an inbox update acknowledges it and selects the real result conversation', async () => {
  let acknowledged = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') { acknowledged = JSON.parse(String(init.body)).seen === true; return Response.json({ inbox: [] }); }
    return Response.json({ settings, tasks: [], inbox: [{ id: 'ses_open_result', title: 'Open this idea', excerpt: 'New result', createdAt: 1, seen: false }] });
  };
  await render();
  await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Open result')?.click(); });
  expect(acknowledged).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open_result');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/workspace/fixture');
});
