import { create } from 'zustand';
import { z } from 'zod';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';
import { claudePageTitle, claudePageUrl } from '@/lib/claude/website';

let requestSequence = 0;
const SAVED_KEY = 'open-carter.claude.saved-pages.v1';
const savedPagesSchema = z.array(z.object({
  url: z.string().refine(url => claudePageUrl(url) === url),
  title: z.string().trim().min(1).max(200),
}));
type SavedClaudePage = z.infer<typeof savedPagesSchema>[number];
const readSavedPages = (): SavedClaudePage[] => {
  const raw = getSafeStorage().getItem(SAVED_KEY);
  if (raw === null) return [];
  try {
    const parsed = savedPagesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.filter((page, index, pages) => pages.findIndex(other => other.url === page.url) === index) : [];
  } catch { return []; }
};
type ClaudeStore = {
  pageTitle: string;
  pageUrl: string | null;
  savedPages: SavedClaudePage[];
  adoptPageTitle: (url: string, title: string) => void;
  request: { sequence: number; action: 'home' | 'refresh' | { url: string } } | null;
  open: (action?: 'home' | 'refresh') => void;
  openSavedPage: (url: string) => void;
  toggleSavedPage: () => void;
  removeSavedPage: (url: string) => void;
  resetWebsite: () => void;
};

/** Claude owns account data. This store owns explicit website requests only. */
export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  request: null,
  pageTitle: '',
  pageUrl: null,
  savedPages: readSavedPages(),
  adoptPageTitle: (url, title) => set(state => {
    const pageTitle = claudePageTitle(url, title);
    const pageUrl = pageTitle ? claudePageUrl(url) : null;
    return state.pageTitle === pageTitle && state.pageUrl === pageUrl ? state : { pageTitle, pageUrl };
  }),
  open: (action) => {
    if (action) set({ request: { sequence: ++requestSequence, action } });
    useUIStore.getState().setClaudePageOpen(true);
  },
  openSavedPage: (url) => {
    if (!claudePageUrl(url) || !get().savedPages.some(page => page.url === url)) return;
    set({ request: { sequence: ++requestSequence, action: { url } } });
    useUIStore.getState().setClaudePageOpen(true);
  },
  toggleSavedPage: () => {
    const { pageUrl, pageTitle, savedPages } = get();
    if (!pageUrl || !pageTitle) return;
    const next = savedPages.some(page => page.url === pageUrl)
      ? savedPages.filter(page => page.url !== pageUrl)
      : [...savedPages, { url: pageUrl, title: pageTitle }];
    getSafeStorage().setItem(SAVED_KEY, JSON.stringify(next));
    set({ savedPages: next });
  },
  removeSavedPage: (url) => {
    const savedPages = get().savedPages.filter(page => page.url !== url);
    getSafeStorage().setItem(SAVED_KEY, JSON.stringify(savedPages));
    set({ savedPages });
  },
  resetWebsite: () => set({ request: null, pageTitle: '', pageUrl: null }),
}));
