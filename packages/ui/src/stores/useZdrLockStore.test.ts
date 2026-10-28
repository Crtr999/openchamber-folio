import { beforeEach, expect, mock, test } from 'bun:test';

let verifyOk = true;
mock.module('@/lib/zdrLock', () => ({
  isPathGuarded: (directories: readonly string[], path: string | null | undefined) => Boolean(path) && directories.some((d) => path === d || (path as string).startsWith(`${d}/`)),
  readZdrLockState: async () => ({ pinSet: true, directories: ['/zdr'], retryAfterMs: 0 }),
  verifyZdrPin: async () => ({ ok: verifyOk }),
  setZdrPin: async () => ({ ok: true }),
  clearZdrPin: async () => ({ ok: true }),
}));
const { useZdrLockStore } = await import('./useZdrLockStore');

beforeEach(() => { verifyOk = true; useZdrLockStore.setState({ loaded: false, pinSet: false, directories: [], unlocked: false }); });

test('nothing is locked until a PIN is set', () => {
  useZdrLockStore.setState({ pinSet: false, directories: ['/zdr'] });
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(false);
});

test('a guarded path is locked until the right PIN, other paths never are', async () => {
  await useZdrLockStore.getState().refresh();
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(true);
  expect(useZdrLockStore.getState().isLocked('/legal')).toBe(false);
  verifyOk = false;
  expect((await useZdrLockStore.getState().unlock('0000')).ok).toBe(false);
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(true);
  verifyOk = true;
  expect((await useZdrLockStore.getState().unlock('1234')).ok).toBe(true);
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(false);
  useZdrLockStore.getState().lock();
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(true);
});

test('removing the PIN leaves nothing locked', async () => {
  await useZdrLockStore.getState().refresh();
  await useZdrLockStore.getState().clearPin('1234');
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(false);
});
