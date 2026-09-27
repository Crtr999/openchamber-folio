import { create } from 'zustand';

/** Whether the Ask AI side panel is open beside the page (Mac). Shared by the page and the right-hand rail. */
const read = () => { try { return localStorage.getItem('folio.ask.open') === '1'; } catch { return false; } };
export const useFolioAskStore = create<{ open: boolean; setOpen: (open: boolean) => void; toggle: () => void }>((set, get) => ({
  open: read(),
  setOpen: (open) => { set({ open }); try { localStorage.setItem('folio.ask.open', open ? '1' : '0'); } catch { /* storage blocked */ } },
  toggle: () => get().setOpen(!get().open),
}));
