import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { opencodeClient } from '@/lib/opencode/client';
import type { SessionStatus } from '@/lib/opencode/model';
import { applyGlobalSessionStatusEvent, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { useIsWorkingOnMac, useWorkingSessionsStore, useWorkingSessionsWatch } from './workingSessions';

const WORKING = 'ses_working';
const IDLE = 'ses_idle';
const STARTED = 'ses_started';

const BUSY: SessionStatus = { type: 'busy' };
const globalNames = ['window', 'document', 'Event', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];

/** One row, plus the watch that keeps the evidence behind it fresh. */
function Row({ sessionId }: { sessionId: string }) {
  useWorkingSessionsWatch();
  const working = useIsWorkingOnMac(sessionId);
  return <span data-session={sessionId}>{working ? 'working' : 'idle'}</span>;
}

const emptyStore = () => useWorkingSessionsStore.setState({ confirmed: new Set(), confirmedAt: 0, raised: new Set() });

describe('which of the Mac’s conversations the phone shows as working', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let originalStatuses: typeof opencodeClient.getActiveSessionStatuses;
  let restore: () => void;
  let running: Record<string, SessionStatus> | null;
  let requests: number;
  let now: number;

  const render = async (sessionIds: string[]) => {
    await act(async () => root.render(<>{sessionIds.map((id) => <Row key={id} sessionId={id} />)}</>));
  };

  /** The next authoritative read, as the phone's watcher asks for it on a resume. */
  const resume = async () => {
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  const shown = (sessionId: string) => host.querySelector(`[data-session="${sessionId}"]`)?.textContent;

  beforeEach(() => {
    windowInstance = new Window();
    const previous = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, Event: windowInstance.Event,
      HTMLElement: windowInstance.HTMLElement, Element: windowInstance.Element, Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    now = 1_700_000_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    requests = 0;
    running = null;
    originalStatuses = opencodeClient.getActiveSessionStatuses;
    opencodeClient.getActiveSessionStatuses = async () => {
      requests += 1;
      return running;
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    replaceGlobalSessionStatusById(new Map());
    resetSessionOrdering();
    resetSessionActivityTiming();
    emptyStore();
    restore = () => {
      clock.mockRestore();
      opencodeClient.getActiveSessionStatuses = originalStatuses;
      replaceGlobalSessionStatusById(new Map());
      emptyStore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    restore();
    await windowInstance.happyDOM.close();
  });

  test('the Mac’s running sessions get a dot and the settled ones do not', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });

    await render([WORKING, IDLE]);

    expect(requests).toBe(1);
    expect(shown(WORKING)).toBe('working');
    expect(shown(IDLE)).toBe('idle');
  });

  test('the dot goes away when the idle event arrives', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });
    await render([WORKING]);
    expect(shown(WORKING)).toBe('working');

    running = {};
    await act(async () => {
      applyGlobalSessionStatusEvent('/repo', { type: 'session.idle', properties: { sessionID: WORKING } });
    });

    expect(shown(WORKING)).toBe('idle');
  });

  test('a turn the phone missed ending still clears, because the Mac’s list says it finished', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });
    await render([WORKING]);
    expect(shown(WORKING)).toBe('working');

    // The phone was backgrounded here: it never hears the idle, and its own index
    // still calls the session busy. Only the Mac can end this one.
    running = {};
    await resume();

    expect(shown(WORKING)).toBe('idle');
  });

  test('a turn that starts after the list was read shows without waiting for the next one', async () => {
    running = {};
    await render([STARTED]);
    expect(shown(STARTED)).toBe('idle');
    expect(requests).toBe(1);

    await act(async () => {
      applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: STARTED, status: BUSY } });
    });

    expect(shown(STARTED)).toBe('working');
    expect(requests).toBe(1);
  });

  test('nothing shows until the phone has read the Mac’s running sessions once', async () => {
    running = null;
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });

    await render([WORKING]);

    expect(requests).toBe(1);
    expect(shown(WORKING)).toBe('idle');
  });

  test('a list that stops arriving ages out instead of holding the dot on forever', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });
    await render([WORKING]);
    expect(shown(WORKING)).toBe('working');

    // Every read from here fails — the Mac went to sleep, or the relay dropped —
    // while the phone's own index still says the session is busy. A failed read
    // proves nothing either way, so the previous answer stands until it is too old.
    running = null;
    now += 30_000;
    await resume();
    expect(shown(WORKING)).toBe('working');

    now += 30_000;
    await resume();

    expect(shown(WORKING)).toBe('idle');
  });

  test('one slow read over the relay does not take a working dot away', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });
    await render([WORKING]);

    running = null;
    now += 30_000;
    await resume();

    expect(shown(WORKING)).toBe('working');
  });

  test('a session that picks up a new turn gets its dot back', async () => {
    running = { [WORKING]: BUSY };
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: WORKING, status: BUSY } });
    await render([WORKING]);

    running = {};
    await resume();
    expect(shown(WORKING)).toBe('idle');

    running = { [WORKING]: BUSY };
    await resume();
    expect(shown(WORKING)).toBe('working');
  });
});
