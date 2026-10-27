import { create } from 'zustand';
import { z } from 'zod';
import { useUIStore } from './useUIStore';
import { getSafeStorage } from './utils/safeStorage';
import { geminiPageTitle, geminiPageUrl } from '@/lib/gemini/website';

let requestSequence = 0;
const SAVED_KEY = 'open-carter.gemini.saved-pages.v1';
const RESUME_KEY = 'open-carter.gemini.resume.v1';
const resumeSchema = z.string().refine(raw => {
  const accepted = geminiPageUrl(raw);
  return Boolean(accepted && /^\/app(\/[^/]+)?$/.test(new URL(accepted).pathname));
});
const readResume = () => {
  const parsed = resumeSchema.safeParse(getSafeStorage().getItem(RESUME_KEY));
  return parsed.success ? parsed.data : null;
};
const savedPagesSchema = z.array(z.object({
  url: z.string().refine(url => geminiPageUrl(url) === url),
  title: z.string().trim().min(1).max(200),
}));
type SavedGeminiPage = z.infer<typeof savedPagesSchema>[number];
const readSavedPages = (): SavedGeminiPage[] => {
  const raw = getSafeStorage().getItem(SAVED_KEY);
  if (raw === null) return [];
  try {
    const parsed = savedPagesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.filter((page, index, pages) => pages.findIndex(other => other.url === page.url) === index) : [];
  } catch { return []; }
};
type GeminiStore = {
  pageTitle: string;
  resumeUrl: string | null;
  pageUrl: string | null;
  savedPages: SavedGeminiPage[];
  adoptPageTitle: (url: string, title: string) => void;
  request: { sequence: number; action: 'home' | 'refresh' | { url: string } } | null;
  open: (action?: 'home' | 'refresh') => void;
  openSavedPage: (url: string) => void;
  toggleSavedPage: () => void;
  removeSavedPage: (url: string) => void;
  resetWebsite: () => void;
};

/** Gemini owns account data. This store owns explicit website requests only. */
export const useGeminiStore = create<GeminiStore>((set, get) => ({
  request: null,
  pageTitle: '',
  resumeUrl: readResume(),
  pageUrl: null,
  savedPages: readSavedPages(),
  adoptPageTitle: (url, title) => set(state => {
    const pageTitle = geminiPageTitle(url, title);
    const pageUrl = pageTitle ? geminiPageUrl(url) : null;
    const resume = resumeSchema.safeParse(pageUrl);
    const resumeUrl = resume.success ? resume.data : state.resumeUrl;
    if (resumeUrl && resumeUrl !== state.resumeUrl) getSafeStorage().setItem(RESUME_KEY, resumeUrl);
    return state.pageTitle === pageTitle && state.pageUrl === pageUrl && state.resumeUrl === resumeUrl ? state : { pageTitle, pageUrl, resumeUrl };
  }),
  open: (action) => {
    if (action) set({ request: { sequence: ++requestSequence, action } });
    useUIStore.getState().setGeminiPageOpen(true);
  },
  openSavedPage: (url) => {
    if (!geminiPageUrl(url) || !get().savedPages.some(page => page.url === url)) return;
    set({ request: { sequence: ++requestSequence, action: { url } } });
    useUIStore.getState().setGeminiPageOpen(true);
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
