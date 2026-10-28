import { create } from 'zustand';
import { clearZdrPin, isPathGuarded, readZdrLockState, setZdrPin, verifyZdrPin, type ZdrLockResult } from '@/lib/zdrLock';

/** How long the window can be away before an unlocked folder locks again. */
export const AUTO_LOCK_AFTER_MS = 10 * 60_000;

type ZdrLockStoreState = {
  loaded: boolean;
  pinSet: boolean;
  directories: readonly string[];
  unlocked: boolean;
  refresh: () => Promise<void>;
  /** Locked means a PIN is set, the path is in a guarded folder, and the PIN has not been entered. */
  isLocked: (path: string | null | undefined) => boolean;
  unlock: (pin: string) => Promise<ZdrLockResult>;
  setPin: (pin: string, currentPin?: string) => Promise<ZdrLockResult>;
  clearPin: (pin: string) => Promise<ZdrLockResult>;
  lock: () => void;
};

export const useZdrLockStore = create<ZdrLockStoreState>()((set, get) => ({
  loaded: false,
  pinSet: false,
  directories: [],
  unlocked: false,
  refresh: async () => {
    const state = await readZdrLockState();
    if (!state) return;
    // Removing the PIN, or never having one, leaves nothing to unlock.
    set({ loaded: true, pinSet: state.pinSet, directories: state.directories });
    if (!state.pinSet) set({ unlocked: false });
  },
  isLocked: (path) => {
    const { pinSet, unlocked, directories } = get();
    return pinSet && !unlocked && isPathGuarded(directories, path);
  },
  unlock: async (pin) => {
    const result = await verifyZdrPin(pin);
    if (result.ok) set({ unlocked: true });
    return result;
  },
  setPin: async (pin, currentPin) => {
    const result = await setZdrPin(pin, currentPin);
    if (result.ok) set({ pinSet: true, unlocked: true });
    return result;
  },
  clearPin: async (pin) => {
    const result = await clearZdrPin(pin);
    if (result.ok) set({ pinSet: false, unlocked: false });
    return result;
  },
  lock: () => set({ unlocked: false }),
}));
