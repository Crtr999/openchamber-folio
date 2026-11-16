import { create } from 'zustand';
import { useUIStore } from './useUIStore';
import { mistralPageTitle, mistralPageUrl } from '@/lib/mistral/website';

let requestSequence = 0;
type MistralStore = {
  pageTitle: string;
  pageUrl: string | null;
  adoptPageTitle: (url: string, title: string) => void;
  request: { sequence: number; action: 'home' | 'refresh' } | null;
  open: (action?: 'home' | 'refresh') => void;
  resetWebsite: () => void;
};

/** Mistral owns account data. This store owns explicit website requests only. */
export const useMistralStore = create<MistralStore>((set) => ({
  request: null,
  pageTitle: '',
  pageUrl: null,
  adoptPageTitle: (url, title) => set(state => {
    const pageTitle = mistralPageTitle(url, title);
    const pageUrl = pageTitle ? mistralPageUrl(url) : null;
    return state.pageTitle === pageTitle && state.pageUrl === pageUrl ? state : { pageTitle, pageUrl };
  }),
  open: (action) => {
    if (action) set({ request: { sequence: ++requestSequence, action } });
    useUIStore.getState().setMistralPageOpen(true);
  },
  resetWebsite: () => set({ request: null, pageTitle: '', pageUrl: null }),
}));
