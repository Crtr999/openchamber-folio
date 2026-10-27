import { seedGlobalBlockingRequests, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { useFolderActivity } from './useFolderActivity';

/**
 * A friend is a folder, and a folder is busy when any conversation in it is
 * busy. The index that answers this is shared, so the test drives the store
 * directly rather than a fake event stream.
 */

const withDom = async (run: (root: { render: (element: React.ReactElement) => void; unmount: () => void }) => Promise<void>) => {
  const dom = new Window({ url: 'http://folder-activity.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
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
    await run({
      render: (element) => { act(() => { root.render(element); }); },
      unmount: () => { act(() => { root.unmount(); }); },
    });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
};

test('a folder is working when a conversation in it is working', async () => {
  await withDom(async ({ render, unmount }) => {
    replaceGlobalSessionStatusById(new Map([
      ['ses_1', { status: { type: 'busy' }, directory: '/work/business launch' }],
    ]));

    const seen: Record<string, ReturnType<typeof useFolderActivity>> = {};
    function Probe() {
      seen.business = useFolderActivity('/work/business launch');
      seen.other = useFolderActivity('/work/legal');
      seen.none = useFolderActivity(undefined);
      return null;
    }

    render(<Probe />);

    expect(seen.business?.working).toBe(true);
    expect(seen.business?.workingCount).toBe(1);
    expect(seen.business?.retrying).toBe(false);
    expect(seen.other?.working).toBe(false);
    expect(seen.none?.working).toBe(false);
    unmount();
  });
});

test('a retrying conversation is reported as such', async () => {
  await withDom(async ({ render, unmount }) => {
    replaceGlobalSessionStatusById(new Map([
      ['ses_1', { status: { type: 'retry', attempt: 1, message: 'waiting', next: 2 }, directory: '/work/business launch' }],
    ]));

    const seen: Record<string, ReturnType<typeof useFolderActivity>> = {};
    function Probe() {
      seen.business = useFolderActivity('/work/business launch');
      return null;
    }

    render(<Probe />);

    expect(seen.business?.working).toBe(true);
    expect(seen.business?.retrying).toBe(true);
    unmount();
  });
});

test('the same folder spelled differently is the same folder', async () => {
  await withDom(async ({ render, unmount }) => {
    replaceGlobalSessionStatusById(new Map([
      ['ses_1', { status: { type: 'busy' }, directory: '/work/business launch' }],
    ]));

    const seen: Record<string, ReturnType<typeof useFolderActivity>> = {};
    function Probe() {
      seen.trailing = useFolderActivity('/work/business launch/');
      return null;
    }

    render(<Probe />);
    expect(seen.trailing?.working).toBe(true);
    unmount();
  });
});

test('All Chats is busy when a conversation under its root is busy', async () => {
  await withDom(async ({ render, unmount }) => {
    replaceGlobalSessionStatusById(new Map([
      ['ses_1', { status: { type: 'busy' }, directory: '/chats/2026-10-19/session-abc' }],
      ['ses_2', { status: { type: 'busy' }, directory: '/chats-other/2026-10-19/session-xyz' }],
    ]));

    const seen: Record<string, ReturnType<typeof useFolderActivity>> = {};
    function Probe() {
      seen.nested = useFolderActivity('/chats', { includeNested: true });
      seen.exact = useFolderActivity('/chats');
      return null;
    }

    render(<Probe />);
    // Only the conversations under the root are its own; a sibling that
    // merely starts with the same letters is not.
    expect(seen.nested?.working).toBe(true);
    expect(seen.nested?.workingCount).toBe(1);
    // A nested folder is its own friend, so without the nested ask the
    // conversations under the root do not count.
    expect(seen.exact?.working).toBe(false);
    unmount();
  });
});

test('a blocked session waits for the user instead of making the friend dance as working', async () => {
  await withDom(async ({ render, unmount }) => {
    resetGlobalBlockingRequests();
    replaceGlobalSessionStatusById(new Map([['blocked', { status: { type: 'busy' }, directory: '/business' }]]));
    seedGlobalBlockingRequests([{ sessionId: 'blocked', directory: '/business', permissions: [], forms: [{ id: 'question', sessionID: 'blocked', title: 'Returns' }] }]);
    let activity: ReturnType<typeof useFolderActivity> | undefined;
    function Probe() { activity = useFolderActivity('/business'); return null; }
    render(<Probe />);
    expect(activity?.waiting).toBe(true);
    expect(activity?.working).toBe(false);
    expect(activity?.workingCount).toBe(0);
    resetGlobalBlockingRequests(); unmount();
  });
});
