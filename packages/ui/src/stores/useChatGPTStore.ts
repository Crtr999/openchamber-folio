import { create } from 'zustand';
import { z } from 'zod';
import { getSafeStorage } from './utils/safeStorage';
import { useUIStore } from './useUIStore';
import { isChatGPTChatPath, isChatGPTPagePath, type ChatGPTEntry, type WebsiteSnapshot } from '@/lib/chatgpt/website';

type ChatGPTRequest =
  | { kind: 'navigate'; path: string }
  | { kind: 'shortcut'; label: 'Library' | 'Plugins' | 'Explore' | 'Projects' | 'Scheduled' | 'Health' }
  | { kind: 'older' }
  | { kind: 'refresh' };
let requestSequence = 0;
const PIN_KEY = 'open-carter.chatgpt.pins.v1';
const pinSchema = z.array(z.string().refine(isChatGPTChatPath));
const readPins = (): string[] => {
  const raw = getSafeStorage().getItem(PIN_KEY);
  if (!raw) return [];
  try { return pinSchema.parse(JSON.parse(raw)); } catch { return []; }
};

type ChatGPTStore = {
  expanded: boolean;
  mode: 'integrated' | 'full';
  account: string | null;
  chats: ChatGPTEntry[];
  projects: ChatGPTEntry[];
  openedPaths: string[];
  activePath: string;
  pinnedPaths: string[];
  status: 'idle' | 'ready' | 'unavailable' | 'signed-out';
  request: { sequence: number; action: ChatGPTRequest } | null;
  toggleExpanded: () => void;
  open: (action?: ChatGPTRequest, mode?: 'integrated' | 'full') => void;
  setMode: (mode: 'integrated' | 'full') => void;
  adoptSnapshot: (snapshot: WebsiteSnapshot) => void;
  markUnavailable: () => void;
  togglePin: (path: string) => void;
  closeTab: (path: string) => void;
  clearAccount: () => void;
  resetWebsite: () => void;
};

export const useChatGPTStore = create<ChatGPTStore>((set, get) => ({
  expanded: false, mode: 'integrated', account: null, chats: [], projects: [], openedPaths: [], activePath: '/',
  pinnedPaths: readPins(), status: 'idle', request: null,
  toggleExpanded: () => {
    const expanded = !get().expanded;
    set({ expanded });
    if (expanded) get().open();
  },
  open: (action, mode = 'integrated') => {
    if (action?.kind === 'navigate' && !isChatGPTPagePath(action.path)) return;
    if (action) set({ mode, expanded: true, request: { sequence: ++requestSequence, action } });
    else set({ mode, expanded: true });
    useUIStore.getState().setChatGPTPageOpen(true);
  },
  setMode: (mode) => set({ mode }),
  adoptSnapshot: (snapshot) => {
    if (snapshot.kind === 'unavailable') { get().markUnavailable(); return; }
    if (snapshot.kind === 'signed-out') {
      set({ status: 'signed-out', account: null, chats: [], projects: [], openedPaths: [], activePath: '/' });
      return;
    }
    const previous = get();
    const changedAccount = previous.account !== null && previous.account !== snapshot.account;
    const openedPaths = changedAccount ? [] : previous.openedPaths;
    const chats = !changedAccount && snapshot.chats.length === 0 ? previous.chats : snapshot.chats;
    const activePath = isChatGPTChatPath(snapshot.path) ? snapshot.path : '/';
    const nextPaths = activePath !== '/' && !openedPaths.includes(activePath) ? [...openedPaths, activePath] : openedPaths;
    // Sidebar snapshots describe only ChatGPT's loaded history, never all account data.
    if (previous.status === 'ready' && previous.account === snapshot.account && previous.activePath === activePath
      && JSON.stringify(previous.chats) === JSON.stringify(chats) && JSON.stringify(previous.projects) === JSON.stringify(snapshot.projects)) return;
    set({ status: 'ready', account: snapshot.account, chats, projects: snapshot.projects, activePath, openedPaths: nextPaths });
  },
  markUnavailable: () => { if (get().status !== 'unavailable') set({ status: 'unavailable' }); },
  togglePin: (path) => {
    if (!isChatGPTChatPath(path)) return;
    const pinnedPaths = get().pinnedPaths.includes(path) ? get().pinnedPaths.filter(p => p !== path) : [...get().pinnedPaths, path];
    getSafeStorage().setItem(PIN_KEY, JSON.stringify(pinnedPaths));
    set({ pinnedPaths });
  },
  closeTab: (path) => {
    const openedPaths = get().openedPaths.filter(p => p !== path);
    set({ openedPaths });
    if (get().activePath !== path) return;
    const next = openedPaths.at(-1);
    if (next) get().open({ kind: 'navigate', path: next });
    else { set({ activePath: '/' }); useUIStore.getState().closeMainSurfaces(); }
  },
  clearAccount: () => set({ account: null, chats: [], projects: [], openedPaths: [], activePath: '/', status: 'signed-out' }),
  resetWebsite: () => set({ account: null, chats: [], projects: [], openedPaths: [], activePath: '/', status: 'idle', request: null, expanded: false }),
}));
