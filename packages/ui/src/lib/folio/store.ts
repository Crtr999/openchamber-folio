import { create } from 'zustand';
import type { FolioAPI, FolioNote, FolioRequest, FolioResponse, FolioStatus } from './schema';

interface Draft { note: FolioNote; base: number; version: number }
interface FolioStore {
  api?: FolioAPI;
  status?: FolioStatus;
  drafts: Record<string, Draft>;
  open: boolean;
  error?: string;
  saving: boolean;
  bind: (api?: FolioAPI) => void;
  refresh: () => Promise<void>;
  edit: (note: FolioNote) => void;
  flush: () => Promise<void>;
  run: (request: FolioRequest) => Promise<FolioResponse | undefined>;
  close: () => Promise<void>;
}
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | undefined;
let refreshing = false;

// Cheap fingerprint so an unchanged poll does not replace `status` and re-render every page and block.
function statusSignature(status: FolioStatus): string {
  const { notes, messages, meeting, ...rest } = status;
  return JSON.stringify([
    rest,
    notes.map(note => note.id + ':' + note.modified),
    messages.length,
    meeting ? [meeting.id, meeting.ended, meeting.segments.length, meeting.transcript.length, meeting.completedSegmentIDs.length] : null,
  ]);
}
let lastSignature = '';

export const useFolioStore = create<FolioStore>((set, get) => {
  async function request(input: FolioRequest) {
    const api = get().api;
    if (!api) throw new Error('Folio is available in the local macOS desktop app.');
    const response = await api.request(input);
    if (!response.ok) throw new Error(response.error || 'Folio could not complete this operation.');
    if (response.state) {
      const signature = statusSignature(response.state);
      if (signature !== lastSignature || !get().status) {
        lastSignature = signature;
        set({ status: response.state });
      }
    }
    return response;
  }
  async function saveDrafts() {
    set({ saving: true });
    try {
      while (Object.keys(get().drafts).length) {
        const draft = Object.values(get().drafts)[0];
        const response = await request({ command: 'save', note: draft.note, expectedModified: draft.base });
        const saved = response.state?.notes.find(note => note.id === draft.note.id);
        if (!saved) throw new Error('Folio did not confirm the saved page. Your edit is still open.');
        set(state => {
          const drafts = { ...state.drafts };
          const latest = drafts[draft.note.id];
          if (latest?.version === draft.version) delete drafts[draft.note.id];
          else if (latest) drafts[draft.note.id] = { ...latest, base: saved.modified };
          return { drafts, error: undefined };
        });
      }
    } finally { set({ saving: false }); }
  }
  return {
    drafts: {}, open: false, saving: false,
    bind: api => set({ api }),
    refresh: async () => {
      if (refreshing || saving || !get().api || Object.keys(get().drafts).length) return;
      refreshing = true;
      try { await request({ command: 'state' }); }
      catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
      finally { refreshing = false; }
    },
    edit: note => {
      set(state => ({ drafts: { ...state.drafts, [note.id]: {
        note, base: state.drafts[note.id]?.base ?? note.modified,
        version: (state.drafts[note.id]?.version ?? 0) + 1,
      } } }));
      clearTimeout(timer);
      timer = setTimeout(() => { void get().flush().catch(() => undefined); }, 350);
    },
    flush: async () => {
      clearTimeout(timer);
      if (!saving) saving = saveDrafts().catch(error => {
        set({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }).finally(() => { saving = undefined; });
      await saving;
    },
    run: async input => {
      try {
        await get().flush();
        const response = await request(input);
        if (input.command === 'select' || input.command === 'create') set({ open: true });
        set({ error: undefined });
        return response;
      } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
    },
    close: async () => { try { await get().flush(); set({ open: false }); } catch { /* Keep the unsaved page visible. */ } },
  };
});
