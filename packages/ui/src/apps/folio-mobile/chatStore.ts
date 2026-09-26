import { z } from 'zod';
import { create } from 'zustand';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorApp } from '@/lib/platform';
import { defaultModels, type ChatMessage, type ChatModel, type ProviderID } from '@/lib/folio/mobile-chat';

const modelSchema = z.object({ provider: z.enum(['zen', 'openrouter', 'openrouter-zdr']), id: z.string(), name: z.string() });
const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: modelSchema,
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
  noteIDs: z.array(z.string()),
  created: z.number(),
  modified: z.number(),
});
export type MobileChat = z.infer<typeof chatSchema>;

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('folio-chats', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('chats', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const objects = async (name: 'chats' | 'meta', mode: IDBTransactionMode) => (await database).transaction(name, mode).objectStore(name);

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
  /** A chat from the Mac being read on the phone. */
  macChat?: { id: string; title: string; model: string; messages?: ChatMessage[]; error?: string };
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
    const saved = modelSchema.safeParse(await promised((await objects('meta', 'readonly')).get('model')));
    set({ loaded: true, chats, model: saved.success ? saved.data : get().model });
  },
  open: (activeID) => set({ activeID, macChat: undefined }),
  save: async (chat) => {
    set((state) => ({ chats: [chat, ...state.chats.filter((c) => c.id !== chat.id)] }));
    await promised((await objects('chats', 'readwrite')).put(chat));
  },
  remove: async (id) => {
    set((state) => ({ chats: state.chats.filter((c) => c.id !== id), activeID: state.activeID === id ? undefined : state.activeID }));
    await promised((await objects('chats', 'readwrite')).delete(id));
  },
  setModel: (model) => { set({ model }); void objects('meta', 'readwrite').then((store) => promised(store.put(model, 'model'))); },
  addModels: (models) => set((state) => ({ extraModels: [...state.extraModels.filter((m) => !models.some((n) => n.provider === m.provider && n.id === m.id)), ...models] })),
}));

export function newChat(model: ChatModel): MobileChat {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: '', model, messages: [], noteIDs: [], created: now, modified: now };
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
