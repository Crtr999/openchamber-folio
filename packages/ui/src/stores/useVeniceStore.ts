import { create } from 'zustand';
import { z } from 'zod';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';
import { venicePageTitle, venicePageUrl } from '@/lib/venice/website';

let requestSequence = 0;
const SAVED_KEY = 'open-carter.venice.saved-pages.v1';
const RESUME_KEY = 'open-carter.venice.resume.v1';
const resumeSchema = z.string().refine(raw => {
  const accepted = venicePageUrl(raw);
  return Boolean(accepted && /^\/chat\/(classic|agent)(\/[^/]+)?$/.test(new URL(accepted).pathname));
});
const readResume = () => {
  const parsed = resumeSchema.safeParse(getSafeStorage().getItem(RESUME_KEY));
  return parsed.success ? parsed.data : null;
};
const savedPagesSchema = z.array(z.object({
  url: z.string().refine(url => venicePageUrl(url) === url),
  title: z.string().trim().min(1).max(200),
}));
type SavedVenicePage = z.infer<typeof savedPagesSchema>[number];
const readSavedPages = (): SavedVenicePage[] => {
  const raw = getSafeStorage().getItem(SAVED_KEY);
  if (raw === null) return [];
  try {
    const parsed = savedPagesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.filter((page, index, pages) => pages.findIndex(other => other.url === page.url) === index) : [];
  } catch { return []; }
};
type VeniceStore = {
  pageTitle: string;
  resumeUrl: string | null;
  pageUrl: string | null;
  savedPages: SavedVenicePage[];
  adoptPageTitle: (url: string, title: string) => void;
  request: { sequence: number; action: 'home' | 'refresh' | { url: string } } | null;
  open: (action?: 'home' | 'refresh') => void;
  openSavedPage: (url: string) => void;
  toggleSavedPage: () => void;
  removeSavedPage: (url: string) => void;
  resetWebsite: () => void;
};

/** Venice owns account data. This store owns explicit website requests only. */
export const useVeniceStore = create<VeniceStore>((set, get) => ({
  request: null,
  pageTitle: '',
  resumeUrl: readResume(),
  pageUrl: null,
  savedPages: readSavedPages(),
  adoptPageTitle: (url, title) => set(state => {
    const pageTitle = venicePageTitle(url, title);
    const pageUrl = pageTitle ? venicePageUrl(url) : null;
    const resume = resumeSchema.safeParse(pageUrl);
    const resumeUrl = resume.success ? resume.data : state.resumeUrl;
    if (resumeUrl && resumeUrl !== state.resumeUrl) getSafeStorage().setItem(RESUME_KEY, resumeUrl);
    return state.pageTitle === pageTitle && state.pageUrl === pageUrl && state.resumeUrl === resumeUrl ? state : { pageTitle, pageUrl, resumeUrl };
  }),
  open: (action) => {
    if (action) set({ request: { sequence: ++requestSequence, action } });
    useUIStore.getState().setVenicePageOpen(true);
  },
  openSavedPage: (url) => {
    if (!venicePageUrl(url) || !get().savedPages.some(page => page.url === url)) return;
    set({ request: { sequence: ++requestSequence, action: { url } } });
    useUIStore.getState().setVenicePageOpen(true);
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
