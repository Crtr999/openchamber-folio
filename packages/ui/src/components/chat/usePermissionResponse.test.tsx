import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const names = ['window', 'document', 'HTMLElement', 'Node', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'sessionStorage'];
const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.assign(globalThis, {
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const { createRoot } = await import('react-dom/client');
const { ChildStoreManager } = await import('@/sync/child-store');
const { setSyncRefs } = await import('@/sync/sync-refs');
const { setActionRefs } = await import('@/sync/session-actions');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { getPermissionReply } = await import('@/sync/permission-replies');
const { usePermissionResponse } = await import('./usePermissionResponse');
import type { PermissionRequest } from '@/types/permission';

const permission: PermissionRequest = {
  id: 'approval', sessionID: 'session', action: 'shell', resources: ['printf hello'], save: ['printf *'],
};
const initialConfig = useConfigStore.getState();
let manager = new ChildStoreManager();
let host = document.createElement('div');
let root = createRoot(host);
let latest: ReturnType<typeof usePermissionResponse> | null = null;
let replySpy = spyOn(opencodeClient, 'replyToPermission');

function Probe({ enabled = true }: { enabled?: boolean }) {
  latest = usePermissionResponse(permission, undefined, enabled);
  return <div data-pending={latest.isResponding} data-settled={latest.hasResponded} data-error={latest.hasError} />;
}
function view() {
  if (!latest) throw new Error('Probe has not rendered');
  return latest;
}
const render = async (enabled: boolean) => { await act(async () => root.render(<Probe enabled={enabled} />)); };
const remount = async () => {
  await act(async () => root.render(null));
  await render(true);
};
const key = async (name: string, shiftKey = false) => {
  await act(async () => { window.dispatchEvent(new dom.KeyboardEvent('keydown', { key: name, altKey: true, shiftKey, cancelable: true }) as unknown as Event); });
};

beforeEach(() => {
  manager = new ChildStoreManager();
  manager.ensureChild('/repo', { bootstrap: false }).setState({ permission: { session: [permission] } });
  setSyncRefs(opencodeClient.getSdkClient(), manager, '/repo');
  setActionRefs(manager, () => '/repo');
  useConfigStore.setState({ isConnected: true });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  latest = null;
  replySpy = spyOn(opencodeClient, 'replyToPermission').mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  manager.disposeAll();
  replySpy.mockRestore();
  useConfigStore.setState(initialConfig, true);
});
afterAll(() => {
  dom.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('real permission response hook', () => {
  test('collapsed prompts unregister all approval shortcuts, then re-enable them on expansion', async () => {
    await render(true);
    await render(false);
    await key('Enter');
    await key('Enter', true);
    await key('Backspace');
    expect(replySpy).not.toHaveBeenCalled();
    await render(true);
    await key('Backspace');
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[2]).toBe('reject');
  });

  test('hidden documents cannot answer an otherwise active approval', async () => {
    await render(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await key('Enter');
    await key('Enter', true);
    await key('Backspace');
    expect(replySpy).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await key('Enter');
    expect(replySpy.mock.calls[0]?.[2]).toBe('once');
  });

  test('pending and acknowledged decisions remain locked across unmount and remount', async () => {
    let acknowledge = (_success: boolean) => {};
    const completion = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    replySpy.mockImplementation(() => completion);
    await render(true);
    await key('Enter');
    expect(view().isResponding).toBe(true);
    await remount();
    expect(view().isResponding).toBe(true);
    await key('Enter', true);
    await act(async () => view().respond('always'));
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[2]).toBe('once');
    await act(async () => { acknowledge(true); await completion; });
    await remount();
    expect(view().hasResponded).toBe(true);
    await key('Enter', true);
    await act(async () => view().respond('reject'));
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  test('failed decisions survive remount and retry only after a new explicit choice', async () => {
    replySpy.mockRejectedValueOnce(new Error('offline'));
    await render(true);
    await key('Enter');
    expect(view().hasError).toBe(true);
    await remount();
    expect(view().hasError).toBe(true);
    expect(replySpy).toHaveBeenCalledTimes(1);
    await key('Backspace');
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[2]).toBe('reject');
    expect(view().hasResponded).toBe(true);
  });

  test('authoritative removal retains an in-flight lock until settlement, then releases the entry', async () => {
    let acknowledge = (_success: boolean) => {};
    const completion = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    replySpy.mockImplementation(() => completion);
    await render(true);
    await key('Enter');
    const acquire = () => getPermissionReply(manager, getRuntimeKey(), permission.sessionID, permission.id, async () => {});
    const original = acquire();
    const store = manager.children.get('/repo');
    if (!store) throw new Error('Missing directory store');
    await act(async () => store.setState({ permission: {} }));
    expect(acquire()).toBe(original);
    expect(original.getSnapshot()).toBe('pending');
    expect(await original.respond('always')).toBe(false);
    await act(async () => { acknowledge(true); await completion; });
    const stale = acquire();
    expect(stale).not.toBe(original);
    expect(stale.getSnapshot()).toBe('settled');
    expect(await stale.respond('always')).toBe(false);
    // Repeated live/removal cycles must allocate fresh state, not retain history.
    for (let index = 0; index < 50; index++) {
      store.setState({ permission: { session: [permission] } });
      const fresh = acquire();
      expect(fresh.getSnapshot()).toBe('idle');
      store.setState({ permission: {} });
      expect(acquire()).not.toBe(fresh);
      expect(fresh.getSnapshot()).toBe('settled');
    }
  });
});
