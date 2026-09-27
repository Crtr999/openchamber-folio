import { z } from 'zod';
import { create } from 'zustand';
import type { LocalEngine } from '@/lib/folio/local-engine';
import type { FolioNote } from '@/lib/folio/schema';
import { useFolioStore } from '@/lib/folio/store';
import { useHandoffStore, type FolioFocus } from '@/lib/folio/handoff';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, MOBILE_DISCONNECTED_RUNTIME_KEY } from '@/lib/runtime-switch';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { hiddenChats, readSecret, useMobileChatStore, writeSecret, type MobileChat } from './chatStore';

/**
 * iPhone side of Mac sync. The Mac listens on the local network after you pair from its
 * "Sync with iPhone" code. Every request is AES-GCM encrypted with the pairing key, which
 * lives in the Keychain; the rest of the pairing (Mac name, addresses, port) is not secret.
 */

const pairingSchema = z.object({ hosts: z.array(z.string().min(1)).min(1), port: z.number().int(), name: z.string() });
type Pairing = z.infer<typeof pairingSchema>;
const macChatSchema = z.object({ id: z.string(), title: z.string(), updated: z.number(), model: z.string() });
export type MacChat = z.infer<typeof macChatSchema>;
const assistantMessageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(), sourceIDs: z.array(z.string()) });
const assistantChatSchema = z.object({ noteID: z.string(), title: z.string(), isChat: z.boolean(), created: z.number(), modified: z.number(), messages: z.array(assistantMessageSchema) });
type AssistantChat = { noteID: string; title: string; created: number; modified: number; messages: z.infer<typeof assistantMessageSchema>[] };
const focusSchema = z.object({ noteID: z.string(), blockID: z.string().optional(), reading: z.boolean(), at: z.number() });
export type MacFocus = z.infer<typeof focusSchema>;
const syncReplySchema = z.object({ cursor: z.number(), notes: z.array(z.unknown()), macChats: z.array(macChatSchema), assistant: z.array(assistantChatSchema).default([]), macFocus: focusSchema.nullish() });
const connectReplySchema = z.object({ link: z.string() });
const assetReplySchema = z.object({ data: z.string() });
const uploadReplySchema = z.object({ path: z.string() });
const bellaReplySchema = z.object({ audio: z.string() });
/** Files above this stay where they are and are fetched when opened (the Mac accepts up to 40 MB). */
const MAX_COPY = 40_000_000;
const MAX_DOWNLOADS_PER_SYNC = 25;
const envelopeSchema = z.object({ v: z.literal(1), iv: z.string(), data: z.string() });
const stateSchema = z.object({ cursor: z.number(), localSince: z.number(), lastSync: z.number(), goodHost: z.string().optional(), macChats: z.array(macChatSchema) });

const KEY_NAME = 'folio.sync.key';
const PAIRING = 'folio.sync.pairing';
const STATE = 'folio.sync.state';

function readLocal<T>(name: string, schema: z.ZodType<T>): T | undefined {
  try { const raw = localStorage.getItem(name); if (!raw) return undefined; const parsed = schema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
function writeLocal<T>(name: string, value: T) { try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* storage full or blocked */ } }

const fromB64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

async function cryptoKey(key: string) { return crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, ['encrypt', 'decrypt']); }

type SyncRequest =
  | { op: 'sync'; t: number; since: number; notes: FolioNote[]; chats: MobileChat[]; assistant: AssistantChat[]; assistantHashes: Record<string, string>; focus?: FolioFocus }
  | { op: 'connect'; t: number }
  | { op: 'asset-get'; t: number; path: string }
  | { op: 'asset-put'; t: number; name: string; data: string }
  | { op: 'bella'; t: number; text: string };

/** Same fingerprint the Mac computes (folio-sync.mjs chatHash), so unchanged chats are not re-sent. */
async function chatHash(messages: readonly { id?: string; role: string; content: string }[]): Promise<string> {
  const text = messages.map((m) => `${(m.id ?? '').toUpperCase()}\u0000${m.role}\u0000${m.content}`).join('\u0001');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const syncable = (chat: MobileChat) => chat.messages.filter((m) => m.role !== 'system' && m.id);

async function blobToBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  return url.slice(url.indexOf(',') + 1);
}
async function base64ToBlob(data: string, type = 'application/octet-stream'): Promise<Blob> {
  return (await fetch(`data:${type};base64,${data}`)).blob();
}

async function seal(key: string, value: SyncRequest): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(key), new TextEncoder().encode(JSON.stringify(value))));
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(data) });
}

async function open<T>(key: string, body: string, schema: z.ZodType<T>): Promise<T> {
  const envelope = envelopeSchema.parse(JSON.parse(body));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, await cryptoKey(key), fromB64(envelope.data));
  return schema.parse(JSON.parse(new TextDecoder().decode(plain)));
}

/** Reads a folio-sync://pair link (from the Mac's QR code or copied link). */
export function parsePairingLink(link: string): { pairing: Pairing; key: string } | undefined {
  try {
    const url = new URL(link.trim());
    if (url.protocol !== 'folio-sync:') return undefined;
    const hosts = (url.searchParams.get('h') ?? '').split(',').filter(Boolean);
    const port = Number(url.searchParams.get('p'));
    const key = url.searchParams.get('k') ?? '';
    const pairing = pairingSchema.safeParse({ hosts, port, name: url.searchParams.get('n') || 'Mac' });
    if (!pairing.success || fromB64(key).length !== 32) return undefined;
    return { pairing: pairing.data, key };
  } catch { return undefined; }
}

const textSchema = z.string();

async function postTo(host: string, port: number, body: string): Promise<string> {
  const url = `http://${host}:${port}/folio-sync`;
  if (isCapacitorApp()) {
    // Native request: no web-view CORS or mixed-content rules, and a short timeout when the Mac is away.
    const { CapacitorHttp } = await import('@capacitor/core');
    const response = await CapacitorHttp.request({ url, method: 'POST', headers: { 'Content-Type': 'text/plain' }, data: body, responseType: 'text', connectTimeout: 4000, readTimeout: 60000 });
    const data: unknown = response.data;
    const text = textSchema.safeParse(data);
    if (response.status !== 200 || !text.success) throw new Error(`Mac answered ${response.status}`);
    return text.data;
  }
  const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Mac answered ${response.status}`);
  return response.text();
}

interface SyncState {
  pairing?: Pairing;
  lastSync?: number;
  syncing: boolean;
  error?: string;
  macChats: MacChat[];
  /** What the Mac had open at the last sync, for the "continue from your Mac" card. */
  macFocus?: MacFocus;
  /** A one-time link that connects the chats to the Mac; the app redeems it, then it is cleared. */
  connectLink?: string;
  load: () => void;
  pair: (link: string, engine: LocalEngine) => Promise<boolean>;
  unpair: () => Promise<void>;
  syncNow: (engine: LocalEngine) => Promise<void>;
}

/** Bella's voice from the Mac, as base64 WAV; undefined when not paired or the Mac is away (then the iPhone voice reads). */
let bellaDownUntil = 0;
export async function macBella(text: string): Promise<string | undefined> {
  const pairing = useSyncStore.getState().pairing;
  if (!pairing || Date.now() < bellaDownUntil) return undefined;
  try { return (await request(pairing, { op: 'bella', t: Date.now(), text }, bellaReplySchema)).audio; }
  catch { bellaDownUntil = Date.now() + 120_000; return undefined; }
}

/** Downloads one attachment from the Mac library, for opening it right away. */
export async function macAsset(path: string): Promise<Blob | undefined> {
  const pairing = useSyncStore.getState().pairing;
  if (!pairing) return undefined;
  try { return await base64ToBlob((await request(pairing, { op: 'asset-get', t: Date.now(), path }, assetReplySchema)).data); } catch { return undefined; }
}

/** Copies phone attachments to the Mac before their pages sync, so the Mac keeps them. Returns how many are still waiting. */
async function uploadAssets(pairing: Pairing, engine: LocalEngine): Promise<number> {
  const uploads = (await engine.pendingUploads()).filter((u) => u.file.size <= MAX_COPY);
  for (let i = 0; i < uploads.length; i += 1) {
    try {
      const reply = await request(pairing, { op: 'asset-put', t: Date.now(), name: uploads[i].name, data: await blobToBase64(uploads[i].file) }, uploadReplySchema);
      await engine.relinkAsset(uploads[i].ref, reply.path, uploads[i].file);
    } catch { return uploads.length - i; } // the Mac is away or refused; the rest wait for the next sync
  }
  return 0;
}

/** Keeps Mac attachments on the phone so they open with the Mac off. Big ones wait until opened. */
async function downloadAssets(pairing: Pairing, engine: LocalEngine): Promise<void> {
  for (const path of (await engine.missingAssets()).slice(0, MAX_DOWNLOADS_PER_SYNC)) {
    try { await engine.storeAsset(path, await base64ToBlob((await request(pairing, { op: 'asset-get', t: Date.now(), path }, assetReplySchema)).data)); }
    catch { /* too large or the Mac went away; it is fetched when opened */ }
  }
}

/** Brings the Mac's assistant conversations in, including replies added on the Mac to chats started here. */
async function applyAssistant(incoming: z.infer<typeof assistantChatSchema>[], started: number) {
  const store = useMobileChatStore.getState();
  const hidden = hiddenChats();
  for (const mac of incoming) {
    const id = mac.noteID.toUpperCase();
    if (hidden.has(id) || store.busyID?.toUpperCase() === id) continue;
    const existing = useMobileChatStore.getState().chats.find((c) => c.id.toUpperCase() === id);
    if (existing && existing.modified > started) continue; // changed here during this sync; it goes next time
    const tools = new Map(existing?.messages.map((m) => [(m.id ?? '').toUpperCase(), m.tools]));
    await store.save({
      id: existing?.id ?? id,
      title: mac.isChat ? mac.title : existing?.title || mac.title,
      model: existing?.model ?? store.model,
      messages: mac.messages.map((m) => ({ ...m, tools: tools.get(m.id.toUpperCase()) })),
      noteIDs: existing?.noteIDs ?? [],
      pageID: mac.isChat ? undefined : id,
      scope: existing?.scope, web: existing?.web,
      created: existing?.created ?? mac.created,
      modified: Math.max(existing?.modified ?? 0, started - 1),
    });
  }
}

let running: Promise<void> | undefined;
let lastConnectAsk = 0;

async function request<T>(pairing: Pairing, value: SyncRequest, schema: z.ZodType<T>): Promise<T> {
  const key = await readSecret(KEY_NAME);
  if (!key) throw new Error('Pair with your Mac first.');
  const state = readLocal(STATE, stateSchema);
  const body = await seal(key, value);
  let lastError = new Error('Could not reach your Mac.');
  // When the chats are connected to the Mac (Wi-Fi or the private relay, from anywhere), sync rides that connection.
  if (getRuntimeKey() !== MOBILE_DISCONNECTED_RUNTIME_KEY && (getRuntimeApiBaseUrl() || isRelayModeActive())) {
    try {
      const response = await runtimeFetch('/api/folio/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
      if (response.ok) return await open(key, await response.text(), schema);
      lastError = new Error(`Mac answered ${response.status}`);
    } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
  }
  const hosts = [...new Set([...(state?.goodHost ? [state.goodHost] : []), ...pairing.hosts])];
  for (const host of hosts) {
    try {
      const reply = await open(key, await postTo(host, pairing.port, body), schema);
      if (state && state.goodHost !== host) writeLocal(STATE, { ...state, goodHost: host });
      return reply;
    } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
  }
  throw lastError;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncing: false,
  macChats: [],
  load: () => {
    const state = readLocal(STATE, stateSchema);
    set({ pairing: readLocal(PAIRING, pairingSchema), lastSync: state?.lastSync || undefined, macChats: state?.macChats ?? [] });
  },
  pair: async (link, engine) => {
    const parsed = parsePairingLink(link);
    if (!parsed) return false;
    await writeSecret(KEY_NAME, parsed.key);
    writeLocal(PAIRING, parsed.pairing);
    writeLocal(STATE, { cursor: 0, localSince: 0, lastSync: 0, macChats: [] });
    set({ pairing: parsed.pairing, lastSync: undefined, error: undefined, macChats: [] });
    await get().syncNow(engine);
    return true;
  },
  unpair: async () => {
    await writeSecret(KEY_NAME, '');
    try { localStorage.removeItem(PAIRING); localStorage.removeItem(STATE); } catch { /* ignore */ }
    set({ pairing: undefined, lastSync: undefined, error: undefined, macChats: [] });
  },
  syncNow: async (engine) => {
    const pairing = get().pairing;
    if (!pairing) return;
    if (running) return running;
    running = (async () => {
      set({ syncing: true });
      try {
        await useFolioStore.getState().flush().catch(() => undefined);
        const state = readLocal(STATE, stateSchema) ?? { cursor: 0, localSince: 0, lastSync: 0, macChats: [] };
        const started = Date.now();
        const uploadFailures = await uploadAssets(pairing, engine);
        const chats = useMobileChatStore.getState().chats;
        const busy = useMobileChatStore.getState().busyID;
        const assistant: AssistantChat[] = chats
          .filter((c) => c.modified > state.localSince && c.id !== busy && syncable(c).length > 0 && /^[0-9a-f-]{36}$/i.test(c.id))
          .map((c) => ({ noteID: (c.pageID ?? c.id).toUpperCase(), title: c.title, created: c.created, modified: c.modified, messages: syncable(c).map((m) => ({ id: (m.id ?? '').toUpperCase(), role: m.role === 'user' ? 'user' : 'assistant', content: m.content, sourceIDs: (m.sourceIDs ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).map((x) => x.toUpperCase()) })) }));
        const hashes: [string, string][] = [];
        for (const chat of chats) hashes.push([(chat.pageID ?? chat.id).toUpperCase(), await chatHash(syncable(chat))]);
        const assistantHashes = Object.fromEntries(hashes);
        const focus = useHandoffStore.getState().local;
        const reply = await request(pairing, { op: 'sync', t: Date.now(), since: state.cursor, notes: engine.changedSince(state.localSince), chats: [], assistant, assistantHashes, focus }, syncReplySchema);
        const drafts = useFolioStore.getState().drafts;
        await engine.mergeRemote(reply.notes, (id) => Boolean(drafts[id]));
        await applyAssistant(reply.assistant, started);
        await downloadAssets(pairing, engine);
        const next = { ...state, cursor: reply.cursor, localSince: started, lastSync: Date.now(), macChats: reply.macChats };
        writeLocal(STATE, { ...(readLocal(STATE, stateSchema) ?? {}), ...next });
        if (reply.macFocus) set({ macFocus: reply.macFocus });
        // Chats not connected yet: this pairing already trusts the Mac, so ask it for a chats link once in a while.
        if (getRuntimeKey() === MOBILE_DISCONNECTED_RUNTIME_KEY && Date.now() - lastConnectAsk > 10 * 60_000) {
          lastConnectAsk = Date.now();
          try { set({ connectLink: (await request(pairing, { op: 'connect', t: Date.now() }, connectReplySchema)).link }); } catch { /* older Mac app, or OpenChamber not ready */ }
        }
        set({ lastSync: next.lastSync, macChats: reply.macChats, error: uploadFailures ? `${uploadFailures} attachment${uploadFailures === 1 ? '' : 's'} could not be copied to your Mac yet. Folio will try again.` : undefined });
        await useFolioStore.getState().refresh();
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ syncing: false });
        running = undefined;
      }
    })();
    return running;
  },
}));
