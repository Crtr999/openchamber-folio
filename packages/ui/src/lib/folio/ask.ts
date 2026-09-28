import { create } from 'zustand';
import { z } from 'zod';
import type { AskModelSelection } from './ask-model';

/** Whether the Ask AI side panel is open beside the page (Mac). Shared by the page and the right-hand rail. */
const read = () => { try { return localStorage.getItem('folio.ask.open') === '1'; } catch { return false; } };
export const useFolioAskStore = create<{ open: boolean; setOpen: (open: boolean) => void; toggle: () => void }>((set, get) => ({
  open: read(),
  setOpen: (open) => { set({ open }); try { localStorage.setItem('folio.ask.open', open ? '1' : '0'); } catch { /* storage blocked */ } },
  toggle: () => get().setOpen(!get().open),
}));

// ---------------------------------------------------------------------------
// The model Ask AI answers with
// ---------------------------------------------------------------------------

/**
 * The panel's own model choice, kept out of the config store on purpose.
 *
 * Ask AI is a separate conversation from the chat beside it, and it previously
 * took whatever model that chat was on at send time. A change there silently
 * moved every page conversation, and a page conversation then failed on a model
 * the user had never chosen for it. Holding the choice here makes the send and
 * the picker read the same value.
 */
const modelSelectionSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const modelKey = 'folio.ask.model.v1';
const readModel = (): AskModelSelection | undefined => {
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(localStorage.getItem(modelKey) ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
};
const writeModel = (selection: AskModelSelection | undefined) => {
  try {
    if (selection) localStorage.setItem(modelKey, JSON.stringify(selection));
    else localStorage.removeItem(modelKey);
  } catch { /* storage blocked */ }
};

type AskModelState = {
  selection: AskModelSelection | undefined;
  /** Picks a model and, with it, the thinking level to send. */
  setModel: (providerID: string, modelID: string, variant?: string) => void;
  clear: () => void;
};

export const useFolioAskModelStore = create<AskModelState>((set) => ({
  selection: readModel(),
  setModel: (providerID, modelID, variant) => {
    const next: AskModelSelection = { providerID, modelID };
    if (variant) next.variant = variant;
    writeModel(next);
    set({ selection: next });
  },
  clear: () => { writeModel(undefined); set({ selection: undefined }); },
}));

// ---------------------------------------------------------------------------
// The conversation each page has with the AI
// ---------------------------------------------------------------------------

/** Remembered on this Mac, so reopening a page returns to the same conversation. */
export interface PageChat {
  sessionId: string;
  directory: string;
  /** The page revision whose text the conversation already carries. */
  sentModified?: number;
}

const chatKey = 'folio.ask.v1';
const chatsSchema = z.record(z.string(), z.object({
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  sentModified: z.number().optional(),
}));

export function readPageChats(): Record<string, PageChat> {
  try {
    const parsed = chatsSchema.safeParse(JSON.parse(localStorage.getItem(chatKey) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

export function writePageChats(chats: Record<string, PageChat>) {
  try { localStorage.setItem(chatKey, JSON.stringify(chats)); } catch { /* storage blocked */ }
}
