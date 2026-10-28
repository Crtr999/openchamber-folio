import { beforeEach, expect, mock, test } from 'bun:test';

let verifyOk = true;
let readState: () => Promise<{ pinSet: boolean; directories: string[]; retryAfterMs: number } | null> = async () => ({ pinSet: true, directories: ['/zdr'], retryAfterMs: 0 });
let verify: () => Promise<{ ok: boolean }> = async () => ({ ok: verifyOk });
mock.module('@/lib/zdrLock', () => ({
  isPathGuarded: (directories: readonly string[], path: string | null | undefined) => Boolean(path && directories.some((d) => path === d || path.startsWith(`${d}/`))),
  readZdrLockState: () => readState(),
  verifyZdrPin: () => verify(),
  setZdrPin: async () => ({ ok: true }),
  clearZdrPin: async () => ({ ok: true }),
  revokeZdrAccess: () => {},
}));
const { useZdrLockStore } = await import('./useZdrLockStore');

beforeEach(() => { verifyOk = true; readState = async () => ({ pinSet: true, directories: ['/zdr'], retryAfterMs: 0 }); verify = async () => ({ ok: verifyOk }); useZdrLockStore.getState().reset(); });

test('unknown state locks paths, but a confirmed unset PIN does not', () => {
  expect(useZdrLockStore.getState().isLocked('/ordinary')).toBe(true);
  useZdrLockStore.setState({ loaded: true, pinSet: false, directories: ['/zdr'] });
  expect(useZdrLockStore.getState().isLocked('/zdr/case')).toBe(false);
});

test('failed refresh revokes unlock and refuses unknown paths until recovery', async () => {
  await useZdrLockStore.getState().refresh();
  await useZdrLockStore.getState().unlock('1234');
  readState = async () => null;
  await useZdrLockStore.getState().refresh();
  expect(useZdrLockStore.getState().loaded).toBe(false);
  expect(useZdrLockStore.getState().isLocked('/ordinary')).toBe(true);
  expect((await useZdrLockStore.getState().unlock('1234')).ok).toBe(false);
  readState = async () => ({ pinSet: true, directories: ['/zdr'], retryAfterMs: 0 });
  await useZdrLockStore.getState().refresh();
  expect(useZdrLockStore.getState().isLocked('/zdr')).toBe(true);
});

test('late verification and refresh cannot undo a lock or runtime reset', async () => {
  await useZdrLockStore.getState().refresh();
  let finishVerify: (value: { ok: boolean }) => void = () => {};
  verify = () => new Promise((resolve) => { finishVerify = resolve; });
  const pending = useZdrLockStore.getState().unlock('1234');
  useZdrLockStore.getState().lock();
  finishVerify({ ok: true });
  expect((await pending).ok).toBe(false);
  let finishRead: (value: { pinSet: boolean; directories: string[]; retryAfterMs: number } | null) => void = () => {};
  readState = () => new Promise((resolve) => { finishRead = resolve; });
  const refresh = useZdrLockStore.getState().refresh();
  useZdrLockStore.getState().reset();
  finishRead({ pinSet: false, directories: [], retryAfterMs: 0 });
  await refresh;
  expect(useZdrLockStore.getState().loaded).toBe(false);
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
