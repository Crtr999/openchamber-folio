import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage })) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { ChildStoreManager } = await import('./child-store');
const { handleEvent, createEventRoutingIndex } = await import('./sync-context');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('catalog events refresh opened locations without starting sidebar-only locations', async () => {
  const stores = new ChildStoreManager();
  const reads: Array<string | null | undefined> = [];
  const originalListAgents = opencodeClient.listAgents;
  const originalDirectory = opencodeClient.getDirectory();
  opencodeClient.setDirectory('/active');
  opencodeClient.listAgents = async (directory) => { reads.push(directory ?? '/active'); return []; };
  const cleanup = stores.configure({ onBootstrap: () => {} });
  try {
    stores.ensureChild('/active');
    for (let index = 0; index < 40; index += 1) stores.ensureChild(`/sidebar/${index}`, { bootstrap: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stores.getBootstrapState('/active')).toBe('complete');
    const routing = createEventRoutingIndex();
    for (let index = 0; index < 30; index += 1) {
      handleEvent('global', { type: 'catalog.updated', properties: { kind: 'agent' } }, stores, routing, getRuntimeKey());
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads.includes('/active')).toBe(true);
    expect(reads.some((directory) => directory?.startsWith('/sidebar/'))).toBe(false);
    // Explicitly opening a former sidebar-only location makes it live again.
    stores.ensureChild('/sidebar/0');
    await new Promise((resolve) => setTimeout(resolve, 0));
    handleEvent('global', { type: 'catalog.updated', properties: { kind: 'agent' } }, stores, routing, getRuntimeKey());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads.includes('/sidebar/0')).toBe(true);
    expect(reads.some((directory) => directory?.startsWith('/sidebar/') && directory !== '/sidebar/0')).toBe(false);
  } finally {
    cleanup();
    stores.disposeAll();
    opencodeClient.listAgents = originalListAgents;
    opencodeClient.setDirectory(originalDirectory);
  }
});
