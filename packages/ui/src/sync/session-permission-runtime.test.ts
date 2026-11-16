import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const names = ['window', 'document', 'CustomEvent', 'localStorage', 'sessionStorage'];
const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
const { respondToPermission, setActionRefs } = await import('./session-actions');
const { ChildStoreManager } = await import('./child-store');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

const initialConfig = useConfigStore.getState();
let manager = new ChildStoreManager();
let replySpy = spyOn(opencodeClient, 'replyToPermission');
const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
const switchTo = (name: string) => switchRuntimeEndpoint({ apiBaseUrl: `https://${name}.invalid`, runtimeKey: name });

beforeEach(() => {
  manager = new ChildStoreManager();
  const store = manager.ensureChild('/repo', { bootstrap: false });
  store.setState({ permission: { session: [{ id: 'request', sessionID: 'session', action: 'shell', resources: ['pwd'], save: [] }] } });
  setActionRefs(manager, () => '/repo');
  replySpy = spyOn(opencodeClient, 'replyToPermission').mockResolvedValue(true);
  switchTo('runtime-a');
});
afterEach(() => {
  manager.disposeAll();
  replySpy.mockRestore();
  useConfigStore.setState(initialConfig, true);
});
afterAll(() => {
  fetchSpy.mockRestore();
  dom.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('real permission action runtime guard', () => {
  for (const returnToOrigin of [false, true]) {
    test(`does not dispatch after switching runtimes during connection recovery${returnToOrigin ? ', even away and back' : ''}`, async () => {
      let reconnect = (_ready: boolean) => {};
      const connection = new Promise<boolean>((resolve) => { reconnect = resolve; });
      useConfigStore.setState({ isConnected: false, probeConnection: () => connection });
      const pending = respondToPermission('session', 'request', 'always');
      // Capture the rejection without asserting yet: awaiting the matcher here
      // would suspend the test before the runtime switch it is meant to race.
      const outcome = pending.then(() => 'resolved' as const, (error: Error) => error);
      switchTo('runtime-b');
      if (returnToOrigin) switchTo('runtime-a');
      reconnect(true);
      const settled = await outcome;
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toContain('runtime changed');
      expect(replySpy).not.toHaveBeenCalled();
    });
  }

  test('a controller from an obsolete runtime cannot dispatch even when connected', async () => {
    useConfigStore.setState({ isConnected: true });
    const original = getRuntimeKey();
    switchTo('runtime-b');
    await expect(respondToPermission('session', 'request', 'once', undefined, original)).rejects.toThrow('runtime changed');
    expect(replySpy).not.toHaveBeenCalled();
  });

  test('same-runtime recovery preserves each exact reply and its original directory', async () => {
    for (const response of ['once', 'always', 'reject'] as const) {
      useConfigStore.setState({ isConnected: false, probeConnection: async () => true });
      await respondToPermission('session', 'request', response);
      expect(replySpy.mock.calls.at(-1)).toEqual(['session', 'request', response, { directory: '/repo' }]);
    }
    expect(replySpy).toHaveBeenCalledTimes(3);
  });
});
