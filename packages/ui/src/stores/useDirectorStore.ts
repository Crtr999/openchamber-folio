import { create } from 'zustand';
import type { FriendBody, FriendColor } from '@/lib/friends';

const STORAGE_KEY = 'open-carter:director:v1';

export type DirectorPhase = 'summon' | 'scan' | 'compose' | 'deliver';

export type DirectorRun = {
  id: number;
  phase: DirectorPhase;
  directory: string;
  friend: { name: string; body: FriendBody; color: FriendColor };
  original: string;
  improved?: string;
  used?: { rules: boolean; memoryFile: boolean; entries: number };
  /** Bumped when the person skips: the composer sends their words as written. */
  skipped?: boolean;
};

type DirectorState = {
  enabled: boolean;
  run: DirectorRun | null;
  /** Folders whose server said no (ZDR), so the toggle can say why instead of failing again. */
  blocked: readonly string[];
  setEnabled: (enabled: boolean) => void;
  begin: (run: Omit<DirectorRun, 'id' | 'phase'>) => number;
  update: (id: number, patch: Partial<Pick<DirectorRun, 'phase' | 'improved' | 'used' | 'skipped'>>) => void;
  end: (id: number) => void;
  block: (directory: string) => void;
};

const readEnabled = (): boolean => {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === 'on'; } catch { return false; }
};

let nextId = 1;

export const useDirectorStore = create<DirectorState>()((set, get) => ({
  enabled: readEnabled(),
  run: null,
  blocked: [],
  setEnabled: (enabled) => {
    try { globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* A remembered choice is a convenience. */ }
    set({ enabled });
  },
  begin: (run) => {
    const id = nextId++;
    set({ run: { ...run, id, phase: 'summon' } });
    return id;
  },
  update: (id, patch) => {
    const run = get().run;
    if (run?.id === id) set({ run: { ...run, ...patch } });
  },
  end: (id) => {
    if (get().run?.id === id) set({ run: null });
  },
  block: (directory) => set((state) => (state.blocked.includes(directory) ? state : { blocked: [...state.blocked, directory] })),
}));
