import { afterEach, beforeEach, expect, test, describe } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session, SessionStatus } from '@/lib/opencode/model';
import { applyGlobalSessionStatusEvent, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorkingSessionsStore } from './workingSessions';
import { MobileChatsSection } from './FolioMobileChatsSection';

const PROJECT = 'project-alpha';
const BUSY: SessionStatus = { type: 'busy' };
const globalNames = ['window', 'document', 'Event', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver', 'PointerEvent'];

const conversation = (id: string, title: string, updated: number): Session => ({
  id, title, directory: `/projects/alpha`, projectID: PROJECT,
  time: { created: 1, updated }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

/** The dot the Mac sidebar and the phone’s own All chats list draw for a live turn. */
const dotsIn = (root: HTMLElement, title: string) => {
  const row = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes(title));
  return row?.querySelectorAll('[data-session-activity-indicator="running"]').length ?? 0;
};

describe('the working dot on the phone’s home chat list', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let originalStatuses: typeof opencodeClient.getActiveSessionStatuses;
  let restore: () => void;
  let running: Record<string, SessionStatus> | null;
  let opened: number;

  const resume = async () => {
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost' });
    const previous = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, Event: windowInstance.Event,
      navigator: windowInstance.navigator, localStorage: windowInstance.localStorage,
      HTMLElement: windowInstance.HTMLElement, Element: windowInstance.Element, Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      ResizeObserver: windowInstance.ResizeObserver, MutationObserver: windowInstance.MutationObserver,
      PointerEvent: windowInstance.PointerEvent,
    });
    running = null;
    opened = 0;
    originalStatuses = opencodeClient.getActiveSessionStatuses;
    opencodeClient.getActiveSessionStatuses = async () => running;
    useProjectsStore.setState({ projects: [{ id: PROJECT, path: '/projects/alpha', label: 'Alpha' }], manualProjectOrder: [], activeProjectId: PROJECT });
    useGlobalSessionsStore.getState().applySnapshot([
      conversation('ses_running', 'Running chat', 30),
      conversation('ses_quiet', 'Quiet chat', 20),
      conversation('ses_overflow_1', 'Overflow one', 19),
      conversation('ses_overflow_2', 'Overflow two', 18),
      conversation('ses_overflow_3', 'Overflow three', 17),
      conversation('ses_overflow_4', 'Overflow four', 16),
    ], [], 'ready');
    useMobileSessionTreeStore.setState({ projectExpanded: { [PROJECT]: true } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    replaceGlobalSessionStatusById(new Map());
    resetSessionOrdering();
    resetSessionActivityTiming();
    useWorkingSessionsStore.setState({ confirmed: new Set(), confirmedAt: 0, raised: new Set() });
    restore = () => {
      opencodeClient.getActiveSessionStatuses = originalStatuses;
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      useMobileSessionTreeStore.setState({ projectExpanded: {} });
      useWorkingSessionsStore.setState({ confirmed: new Set(), confirmedAt: 0, raised: new Set() });
      replaceGlobalSessionStatusById(new Map());
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

  const render = async () => {
    await act(async () => root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <MobileChatsSection onOpenChats={() => { opened += 1; }} onOpenSessions={() => {}} />
        </I18nProvider>
      </ThemeSystemProvider>,
    ));
  };

  test('the row for the conversation the Mac is working on carries the dot, and no other row does', async () => {
    running = { ses_running: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_running', status: BUSY } });

    await render();

    expect(dotsIn(host, 'Running chat')).toBe(1);
    expect(dotsIn(host, 'Quiet chat')).toBe(0);
  });

  test('the dot leaves the row when the Mac finishes, without the folder or the list moving', async () => {
    running = { ses_running: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_running', status: BUSY } });
    await render();
    expect(dotsIn(host, 'Running chat')).toBe(1);

    running = {};
    await resume();

    expect(dotsIn(host, 'Running chat')).toBe(0);
    expect(host.textContent).toContain('Quiet chat');
    expect(dotsIn(host, 'Quiet chat')).toBe(0);
  });

  test('a row whose turn the phone never saw end still loses its dot', async () => {
    running = { ses_running: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_running', status: BUSY } });
    await render();

    // No idle event ever reaches the phone; only the Mac’s own list ends this turn.
    running = {};
    await resume();

    expect(dotsIn(host, 'Running chat')).toBe(0);
  });

  test('a working conversation past the per-folder cap stays capped, dot and all', async () => {
    running = { ses_overflow_4: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_overflow_4', status: BUSY } });

    await render();

    const drawn = ['Running chat', 'Quiet chat', 'Overflow one', 'Overflow two', 'Overflow three', 'Overflow four']
      .filter((title) => host.textContent?.includes(title));

    // The cap still holds: the sixth conversation is offered through "Show all", not
    // drawn with a dot, and the indicator costs the capped list nothing.
    expect(drawn).toEqual(['Running chat', 'Quiet chat', 'Overflow one', 'Overflow two', 'Overflow three']);
    expect(host.textContent).toContain('Show all 6');
    expect(dotsIn(host, 'Overflow four')).toBe(0);
  });

  test('tapping a row still opens that conversation', async () => {
    running = { ses_running: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_running', status: BUSY } });
    await render();

    const row = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Running chat'));
    await act(async () => { row?.click(); });

    expect(opened).toBe(1);
  });

  test('a collapsed folder keeps its conversations — and their dots — off the screen', async () => {
    useMobileSessionTreeStore.setState({ projectExpanded: { [PROJECT]: false } });
    running = { ses_running: BUSY };
    applyGlobalSessionStatusEvent('/projects/alpha', { type: 'session.status', properties: { sessionID: 'ses_running', status: BUSY } });

    await render();

    expect(host.textContent).toContain('Alpha');
    expect(host.textContent).not.toContain('Running chat');
    expect(host.querySelector('[data-session-activity-indicator]')).toBeNull();
  });
});
