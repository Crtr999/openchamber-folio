import { create } from 'zustand';

/**
 * "Pick up where you left off" between the Mac and the iPhone. Each device reports the page in
 * front (and the passage, when reading); sync carries it to the other device, which offers a
 * one-tap "continue" card. Only the latest focus per device is kept.
 */
export interface FolioFocus { noteID: string; blockID?: string; reading: boolean; at: number }

interface HandoffState {
  /** This device's latest focus. */
  local?: FolioFocus;
  /** A request to open a page in reading mode at a passage (from a "continue reading" card). */
  readRequest?: { noteID: string; blockID?: string };
  report: (focus: Omit<FolioFocus, 'at'>) => void;
  openReader: (noteID: string, blockID?: string) => void;
  clearReadRequest: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  report: (focus) => set({ local: { ...focus, at: Date.now() } }),
  openReader: (noteID, blockID) => set({ readRequest: { noteID, blockID } }),
  clearReadRequest: () => set({ readRequest: undefined }),
}));
