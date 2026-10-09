import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useUIStore } from './useUIStore';

test('v22 enables previous desktop false once while preserving unrelated and future choices', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window();
  Object.assign(browser, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' } });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
  try {
    const migrate = useUIStore.persist.getOptions().migrate;
    if (!migrate) throw new Error('Expected UI persistence migration');
    const old = { sessionTabsEnabled: false, sidebarWidth: 311 };
    expect(await migrate(old, 21)).toMatchObject({ sessionTabsEnabled: true, sidebarWidth: 311 });
    expect(await migrate({ sessionTabsEnabled: false }, 22)).toMatchObject({ sessionTabsEnabled: false });
    Reflect.deleteProperty(browser, '__OPENCHAMBER_ELECTRON__');
    expect(await migrate({ sessionTabsEnabled: false }, 21)).toMatchObject({ sessionTabsEnabled: false });
  } finally {
    browser.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
