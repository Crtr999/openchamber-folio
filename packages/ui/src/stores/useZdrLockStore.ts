import { create } from 'zustand';
import { clearZdrPin, isPathGuarded, readZdrLockState, revokeZdrAccess, setZdrPin, verifyZdrPin, type ZdrLockResult } from '@/lib/zdrLock';
import { setZdrAccessGrant } from '@/lib/runtime-auth';

/** How long the window can be away before an unlocked folder locks again. */
export const AUTO_LOCK_AFTER_MS = 10 * 60_000;
let revision = 0;
let refreshSequence = 0;
let unlockTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleExpiry = (expiresAt?: number) => {
  clearTimeout(unlockTimer);
  unlockTimer = expiresAt ? setTimeout(() => useZdrLockStore.getState().lock(), Math.max(0, expiresAt - Date.now())) : undefined;
};
const acceptGrant = (result: ZdrLockResult) => {
  if (result.accessToken && result.expiresAt) setZdrAccessGrant(result.accessToken, result.expiresAt);
  scheduleExpiry(result.expiresAt);
};

type ZdrLockStoreState = {
  loaded: boolean;
  pinSet: boolean;
  directories: readonly string[];
  unlocked: boolean;
  accessRevision: number;
  refresh: () => Promise<void>;
  /** Locked means a PIN is set, the path is in a guarded folder, and the PIN has not been entered. */
  isLocked: (path: string | null | undefined) => boolean;
  unlock: (pin: string) => Promise<ZdrLockResult>;
  setPin: (pin: string, currentPin?: string) => Promise<ZdrLockResult>;
  clearPin: (pin: string) => Promise<ZdrLockResult>;
  lock: () => void;
  reset: () => void;
};

export const useZdrLockStore = create<ZdrLockStoreState>()((set, get) => ({
  loaded: false,
  pinSet: false,
  directories: [],
  unlocked: false,
  accessRevision: 0,
  refresh: async () => {
    const owner = revision;
    const request = ++refreshSequence;
    const state = await readZdrLockState();
    if (owner !== revision || request !== refreshSequence) return;
    if (!state) {
      revision += 1;
      scheduleExpiry();
      revokeZdrAccess();
      set({ loaded: false, unlocked: false });
      return;
    }
    // Removing the PIN, or never having one, leaves nothing to unlock.
    set({ loaded: true, pinSet: state.pinSet, directories: state.directories });
    if (!state.pinSet || state.unlocked === false) { scheduleExpiry(); revokeZdrAccess(); set({ unlocked: false }); }
  },
  isLocked: (path) => {
    const { loaded, pinSet, unlocked, directories } = get();
    return Boolean(path) && (!loaded || (pinSet && !unlocked && isPathGuarded(directories, path)));
  },
  unlock: async (pin) => {
    if (!get().loaded || !get().pinSet) return { ok: false };
    const owner = revision;
    const result = await verifyZdrPin(pin);
    if (owner !== revision || !get().loaded) return { ok: false };
    if (result.ok) { revision += 1; acceptGrant(result); set({ unlocked: true, accessRevision: revision }); }
    return result;
  },
  setPin: async (pin, currentPin) => {
    if (!get().loaded) return { ok: false };
    const owner = ++revision;
    const result = await setZdrPin(pin, currentPin);
    if (owner !== revision) return { ok: false };
    if (result.ok) { revision += 1; acceptGrant(result); set({ pinSet: true, unlocked: true, accessRevision: revision }); }
    return result;
  },
  clearPin: async (pin) => {
    if (!get().loaded) return { ok: false };
    const owner = ++revision;
    const result = await clearZdrPin(pin);
    if (owner !== revision) return { ok: false };
    if (result.ok) { revision += 1; scheduleExpiry(); revokeZdrAccess(); set({ pinSet: false, unlocked: false }); }
    return result;
  },
  lock: () => { revision += 1; scheduleExpiry(); revokeZdrAccess(); set({ unlocked: false }); },
  reset: () => { revision += 1; refreshSequence += 1; scheduleExpiry(); revokeZdrAccess(); set({ loaded: false, pinSet: false, directories: [], unlocked: false }); },
}));
