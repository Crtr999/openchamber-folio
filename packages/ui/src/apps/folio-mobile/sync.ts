import { z } from 'zod';
import { create } from 'zustand';
import type { LocalEngine } from '@/lib/folio/local-engine';
import type { FolioNote } from '@/lib/folio/schema';
import { useFolioStore } from '@/lib/folio/store';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, MOBILE_DISCONNECTED_RUNTIME_KEY } from '@/lib/runtime-switch';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { readSecret, useMobileChatStore, writeSecret, type MobileChat } from './chatStore';

/**
 * iPhone side of Mac sync. The Mac listens on the local network after you pair from its
 * "Sync with iPhone" code. Every request is AES-GCM encrypted with the pairing key, which
 * lives in the Keychain; the rest of the pairing (Mac name, addresses, port) is not secret.
 */

const pairingSchema = z.object({ hosts: z.array(z.string().min(1)).min(1), port: z.number().int(), name: z.string() });
type Pairing = z.infer<typeof pairingSchema>;
const macChatSchema = z.object({ id: z.string(), title: z.string(), updated: z.number(), model: z.string() });
export type MacChat = z.infer<typeof macChatSchema>;
const syncReplySchema = z.object({ cursor: z.number(), notes: z.array(z.unknown()), macChats: z.array(macChatSchema) });
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
  | { op: 'sync'; t: number; since: number; notes: FolioNote[]; chats: MobileChat[] };

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
  load: () => void;
  pair: (link: string, engine: LocalEngine) => Promise<boolean>;
  unpair: () => Promise<void>;
  syncNow: (engine: LocalEngine) => Promise<void>;
}

let running: Promise<void> | undefined;

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
        const chats = useMobileChatStore.getState().chats.filter((c) => c.modified > state.localSince && c.messages.length > 0);
        const reply = await request(pairing, { op: 'sync', t: Date.now(), since: state.cursor, notes: engine.changedSince(state.localSince), chats }, syncReplySchema);
        const drafts = useFolioStore.getState().drafts;
        await engine.mergeRemote(reply.notes, (id) => Boolean(drafts[id]));
        const next = { ...state, cursor: reply.cursor, localSince: started, lastSync: Date.now(), macChats: reply.macChats };
        writeLocal(STATE, { ...(readLocal(STATE, stateSchema) ?? {}), ...next });
        set({ lastSync: next.lastSync, macChats: reply.macChats, error: undefined });
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
