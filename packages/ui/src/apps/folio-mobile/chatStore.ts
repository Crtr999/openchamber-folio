import { z } from 'zod';
import { create } from 'zustand';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorApp } from '@/lib/platform';
import { defaultModels, type ChatMessage, type ChatModel, type ProviderID } from '@/lib/folio/mobile-chat';

const modelSchema = z.object({ provider: z.enum(['zen', 'openrouter', 'openrouter-zdr']), id: z.string(), name: z.string() });
/** What the agent did while answering (searched notes, read a page, searched the web), shown above the reply. */
const toolNoteSchema = z.object({ name: z.string(), label: z.string() });
const messageSchema = z.object({
  /** Shared with the Mac's copy of the conversation, so both sides can add to it without duplicates. */
  id: z.string().optional(),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  sourceIDs: z.array(z.string()).optional(),
  tools: z.array(toolNoteSchema).optional(),
});
const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: modelSchema,
  messages: z.array(messageSchema),
  noteIDs: z.array(z.string()),
  /** Set when this conversation belongs to a regular page on the Mac (its "thinking space"); that page is always context. */
  pageID: z.string().optional(),
  /** Context: the attached pages, or the whole library (searched per question, readable by the agent). */
  scope: z.enum(['notes', 'library']).optional(),
  web: z.boolean().optional(),
  created: z.number(),
  modified: z.number(),
});
export type MobileChat = z.infer<typeof chatSchema>;
export type StoredMessage = z.infer<typeof messageSchema>;
export type ToolNote = z.infer<typeof toolNoteSchema>;

export const newMessageID = () => crypto.randomUUID().toUpperCase();
const HIDDEN = 'folio.chats.hidden';
const hiddenSchema = z.array(z.string());
/** Mac conversations removed on the phone; sync leaves them on the Mac but does not bring them back here. */
export function hiddenChats(): Set<string> {
  try { const parsed = hiddenSchema.safeParse(JSON.parse(localStorage.getItem(HIDDEN) ?? '[]')); return new Set(parsed.success ? parsed.data : []); } catch { return new Set(); }
}
function hideChat(id: string) { try { localStorage.setItem(HIDDEN, JSON.stringify([...hiddenChats(), id.toUpperCase()])); } catch { /* storage blocked */ } }

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
let connection: Promise<IDBDatabase> | undefined;
/** Opened the first time a conversation is read or written, so importing the store never opens a database of its own. */
const database = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('folio-chats', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('chats', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const objects = async (name: 'chats' | 'meta', mode: IDBTransactionMode) => (await database()).transaction(name, mode).objectStore(name);

interface ChatState {
  loaded: boolean;
  chats: MobileChat[];
  activeID?: string;
  model: ChatModel;
  /** Models found from providers, added to the built-in list. */
  extraModels: ChatModel[];
  /** Handed over from search ("Ask") or a note's "Add to chat". */
  pendingPrompt?: string;
  pendingNoteID?: string;
  /** The chat that is streaming a reply right now; sync leaves it alone until the reply is saved. */
  busyID?: string;
  load: () => Promise<void>;
  open: (id?: string) => void;
  save: (chat: MobileChat) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setModel: (model: ChatModel) => void;
  addModels: (models: ChatModel[]) => void;
}

export const useMobileChatStore = create<ChatState>((set, get) => ({
  loaded: false,
  chats: [],
  model: defaultModels[0],
  extraModels: [],
  load: async () => {
    if (get().loaded) return;
    const rows: unknown[] = await promised((await objects('chats', 'readonly')).getAll());
    const chats = rows.flatMap((row) => { const parsed = chatSchema.safeParse(row); return parsed.success ? [parsed.data] : []; }).sort((a, b) => b.modified - a.modified);
    // Chats saved before messages had IDs get them once, so they can sync with the Mac.
    for (const chat of chats) {
      if (chat.messages.every((m) => m.id)) continue;
      chat.messages = chat.messages.map((m) => (m.id ? m : { ...m, id: newMessageID() }));
      await promised((await objects('chats', 'readwrite')).put(chat));
    }
    const saved = modelSchema.safeParse(await promised((await objects('meta', 'readonly')).get('model')));
    let lastOpen: string | undefined;
    try { lastOpen = localStorage.getItem('folio.chat.active') ?? undefined; } catch { lastOpen = undefined; }
    // Reopen the conversation that was open last time.
    set({ loaded: true, chats, model: saved.success ? saved.data : get().model, activeID: get().activeID ?? (chats.some((c) => c.id === lastOpen) ? lastOpen : undefined) });
  },
  open: (activeID) => { set({ activeID }); try { if (activeID) localStorage.setItem('folio.chat.active', activeID); else localStorage.removeItem('folio.chat.active'); } catch { /* storage blocked */ } },
  save: async (chat) => {
    set((state) => ({ chats: [chat, ...state.chats.filter((c) => c.id !== chat.id)] }));
    await promised((await objects('chats', 'readwrite')).put(chat));
  },
  remove: async (id) => {
    hideChat(id);
    set((state) => ({ chats: state.chats.filter((c) => c.id !== id), activeID: state.activeID === id ? undefined : state.activeID }));
    await promised((await objects('chats', 'readwrite')).delete(id));
  },
  setModel: (model) => { set({ model }); void objects('meta', 'readwrite').then((store) => promised(store.put(model, 'model'))); },
  addModels: (models) => set((state) => ({ extraModels: [...state.extraModels.filter((m) => !models.some((n) => n.provider === m.provider && n.id === m.id)), ...models] })),
}));

export function newChat(model: ChatModel): MobileChat {
  const now = Date.now();
  return { id: crypto.randomUUID().toUpperCase(), title: '', model, messages: [], noteIDs: [], created: now, modified: now };
}

export type { ChatMessage };

// Keys live in the iOS Keychain through the native @aparajita/capacitor-secure-storage plugin. Like the
// connection tokens in mobileConnections.ts, we call its native methods directly because its JS layer
// stalls while lazy-loading in this web view; registering by name gives a typed proxy to those methods.
interface NativeSecureStorage {
  internalSetItem: (options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>;
  internalGetItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>;
  internalRemoveItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>;
}
const nativeSecure = registerPlugin<NativeSecureStorage>('SecureStorage');
const memorySecrets = new Map<string, string>();

/** Reads a secret from the iOS Keychain (memory only in a desktop browser preview). */
export async function readSecret(name: string): Promise<string | undefined> {
  if (!isCapacitorApp()) return memorySecrets.get(name);
  try { return (await nativeSecure.internalGetItem({ prefixedKey: name, sync: false })).data ?? undefined; } catch { return undefined; }
}

export async function writeSecret(name: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!isCapacitorApp()) { if (trimmed) memorySecrets.set(name, trimmed); else memorySecrets.delete(name); return; }
  if (trimmed) await nativeSecure.internalSetItem({ prefixedKey: name, data: trimmed, sync: false, access: 0 });
  else await nativeSecure.internalRemoveItem({ prefixedKey: name, sync: false });
}

const keyName = (provider: ProviderID) => `folio.key.${provider}`;
export const readKey = (provider: ProviderID) => readSecret(keyName(provider));
export const writeKey = (provider: ProviderID, value: string) => writeSecret(keyName(provider), value);
