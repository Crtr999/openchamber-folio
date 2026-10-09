import { create } from 'zustand';
import { z } from 'zod';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';
import { musePageTitle, musePageUrl } from '@/lib/muse/website';

let requestSequence = 0;
const SAVED_KEY = 'open-carter.muse.saved-pages.v1';
const savedPagesSchema = z.array(z.object({
  url: z.string().refine(url => musePageUrl(url) === url),
  title: z.string().trim().min(1).max(200),
}));
type SavedMusePage = z.infer<typeof savedPagesSchema>[number];
const readSavedPages = (): SavedMusePage[] => {
  const raw = getSafeStorage().getItem(SAVED_KEY);
  if (raw === null) return [];
  try {
    const parsed = savedPagesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.filter((page, index, pages) => pages.findIndex(other => other.url === page.url) === index) : [];
  } catch { return []; }
};
type MuseStore = {
  expanded: boolean;
  pageTitle: string;
  pageUrl: string | null;
  savedPages: SavedMusePage[];
  adoptPageTitle: (url: string, title: string) => void;
  request: { sequence: number; action: 'home' | 'refresh' | { url: string } } | null;
  open: (action?: 'home' | 'refresh') => void;
  openSavedPage: (url: string) => void;
  toggleExpanded: () => void;
  toggleSavedPage: () => void;
  removeSavedPage: (url: string) => void;
  resetWebsite: () => void;
};

/** Only explicit website navigation is app-owned; Muse owns all account data. */
export const useMuseStore = create<MuseStore>((set, get) => ({
  expanded: true,
  request: null,
  pageTitle: '',
  pageUrl: null,
  savedPages: readSavedPages(),
  adoptPageTitle: (url, title) => set(state => {
    const pageTitle = musePageTitle(url, title);
    const pageUrl = pageTitle ? musePageUrl(url) : null;
    return state.pageTitle === pageTitle && state.pageUrl === pageUrl ? state : { pageTitle, pageUrl };
  }),
  open: (action) => {
    if (action) set({ request: { sequence: ++requestSequence, action } });
    useUIStore.getState().setMusePageOpen(true);
  },
  openSavedPage: (url) => {
    if (!musePageUrl(url) || !get().savedPages.some(page => page.url === url)) return;
    set({ request: { sequence: ++requestSequence, action: { url } } });
    useUIStore.getState().setMusePageOpen(true);
  },
  toggleExpanded: () => set(state => ({ expanded: !state.expanded })),
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
