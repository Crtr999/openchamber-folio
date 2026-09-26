import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { z } from 'zod';

// Two-way sync between this Mac's Folio notebook and the standalone iPhone app.
//
// Off until the user turns it on. Then a small HTTP listener answers one route on the local
// network. Every request and reply is AES-256-GCM encrypted with a 32-byte key that only this
// Mac and the paired phone hold (it travels once, inside the pairing QR code), so someone on the
// same Wi-Fi can neither read notes nor send changes. Turning sync off deletes the key.
//
// Dates: the Swift engine writes seconds since 2001; the phone uses milliseconds since 1970.

const DEFAULT_PORT = 47651;
const MAX_BODY = 24 * 1024 * 1024;
const MAX_SKEW_MS = 10 * 60 * 1000;
const APPLE_EPOCH_S = 978_307_200;
/** Parent page that holds chats started on the iPhone, so they show in the Mac's notes tree. */
export const PHONE_CHATS_PAGE_ID = 'F0110000-0000-4000-8000-000000000001';

const configSchema = z.object({ key: z.string().min(40), port: z.number().int().min(1024).max(65535) });
const envelopeSchema = z.object({ v: z.literal(1), iv: z.string(), data: z.string() });
const markSchema = z.object({ start: z.number(), length: z.number(), style: z.string(), value: z.string().optional() }).passthrough();
const noteSchema = z.object({ id: z.string(), title: z.string(), modified: z.number(), created: z.number(), parentID: z.string().optional(), isChat: z.boolean().optional(), blocks: z.array(z.object({ marks: z.array(markSchema).optional() }).passthrough()) }).passthrough();
const chatSchema = z.object({
  id: z.string().uuid(), title: z.string(), modified: z.number(), created: z.number(),
  model: z.object({ name: z.string() }).passthrough(),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
});
const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sync'), t: z.number(), since: z.number(), notes: z.array(noteSchema), chats: z.array(chatSchema) }),
  z.object({ op: z.literal('chat'), t: z.number(), sessionID: z.string().min(1).max(200) }),
]);
const sessionListSchema = z.object({ data: z.array(z.object({ id: z.string(), title: z.string().optional(), time: z.object({ updated: z.number().optional(), created: z.number() }), model: z.object({ id: z.string() }).passthrough().optional(), parentID: z.string().optional() }).passthrough()) });
const messageListSchema = z.object({ data: z.array(z.object({ type: z.string(), time: z.object({ created: z.number() }).passthrough(), text: z.string().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional() }).passthrough()), cursor: z.unknown().optional() });

const toPhoneTime = (seconds) => (seconds > 1e11 ? seconds : Math.round((seconds + APPLE_EPOCH_S) * 1000));
const toMacTime = (ms) => ms / 1000 - APPLE_EPOCH_S;

export function encrypt(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), data: data.toString('base64') });
}

export function decrypt(key, body) {
  const envelope = envelopeSchema.parse(JSON.parse(body));
  const raw = Buffer.from(envelope.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'));
}

function textBlock(text, kind = 'text', marks = []) {
  return { id: randomUUID().toUpperCase(), kind, text, checked: false, highlight: 'none', marks };
}

/** Renders a phone chat as a readable page: who said what, in order. */
export function chatToNote(chat) {
  const blocks = [textBlock(`Chat on iPhone · ${chat.model.name}`, 'callout')];
  for (const message of chat.messages) {
    if (message.role === 'system') continue;
    const label = message.role === 'user' ? 'You' : chat.model.name;
    blocks.push(textBlock(label, 'heading3'));
    for (const paragraph of message.content.split(/\n{2,}/)) if (paragraph.trim()) blocks.push(textBlock(paragraph.trim()));
  }
  return { id: chat.id.toUpperCase(), title: chat.title || 'iPhone chat', icon: '💬', parentID: PHONE_CHATS_PAGE_ID, blocks, tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: toMacTime(chat.created), modified: toMacTime(chat.modified) };
}

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
  return out;
}

function bonjourName() {
  try { return `${execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 1500 }).trim()}.local`; } catch { return `${os.hostname().replace(/\.local$/, '')}.local`; }
}

export function createFolioSync({ engine, configPath, getLocalOrigin, log = () => {}, defaultPort = DEFAULT_PORT }) {
  let server = null;
  let config = null;
  let lastSync = 0;
  try { config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))); } catch { config = null; }

  const keyBytes = () => Buffer.from(config.key, 'base64url');

  async function engineState() {
    const response = await engine.request({ command: 'state' });
    if (!response.ok) throw new Error(response.error || 'Folio is not ready.');
    return response.state.notes;
  }

  async function upsert(note) {
    const response = await engine.request({ command: 'upsert', note });
    if (!response.ok) log(`[folio-sync] skipped a page: ${response.error}`);
  }

  async function ensurePhoneChatsPage(notes) {
    if (notes.some((n) => n.id === PHONE_CHATS_PAGE_ID)) return;
    const now = toMacTime(Date.now());
    await upsert({ id: PHONE_CHATS_PAGE_ID, title: 'iPhone chats', icon: '📱', blocks: [textBlock('Chats you started in Folio on your iPhone.')], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now });
  }

  async function macChats() {
    const origin = getLocalOrigin();
    if (!origin) return [];
    try {
      const response = await fetch(`${origin}/api/session?limit=40`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return [];
      return sessionListSchema.parse(await response.json()).data
        .filter((s) => !s.parentID)
        .map((s) => ({ id: s.id, title: s.title || 'Untitled chat', updated: s.time.updated ?? s.time.created, model: s.model?.id ?? '' }));
    } catch { return []; }
  }

  async function chatMessages(sessionID) {
    const origin = getLocalOrigin();
    if (!origin) throw new Error('OpenChamber is not ready.');
    const response = await fetch(`${origin}/api/session/${encodeURIComponent(sessionID)}/message?limit=200`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Could not read that chat (${response.status}).`);
    const messages = [];
    for (const message of messageListSchema.parse(await response.json()).data.sort((a, b) => a.time.created - b.time.created)) {
      if (message.type === 'user' && message.text) messages.push({ role: 'user', content: message.text });
      if (message.type === 'assistant') {
        const text = (message.content ?? []).filter((part) => part.type === 'text' && part.text).map((part) => part.text).join('\n\n');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    }
    return messages;
  }

  async function handleSync(request) {
    let notes = await engineState();
    const byID = new Map(notes.map((n) => [n.id, n]));
    // Parents before children, so a new subpage finds its new parent.
    const incoming = [];
    const waiting = new Map(request.notes.map((n) => [n.id.toUpperCase(), n]));
    while (waiting.size) {
      const ready = [...waiting.values()].filter((n) => !n.parentID || !waiting.has(n.parentID.toUpperCase()) || n.parentID.toUpperCase() === n.id.toUpperCase());
      const batch = ready.length ? ready : [...waiting.values()];
      for (const note of batch) { incoming.push(note); waiting.delete(note.id.toUpperCase()); }
    }
    let applied = 0;
    for (const note of incoming) {
      const id = note.id.toUpperCase();
      if (id === PHONE_CHATS_PAGE_ID) continue;
      const mac = byID.get(id);
      const modified = toMacTime(note.modified);
      if (mac && mac.modified >= modified - 0.0005) continue;
      await upsert({ ...note, id, parentID: note.parentID?.toUpperCase(), created: toMacTime(note.created), modified });
      applied += 1;
    }
    if (request.chats.length) {
      await ensurePhoneChatsPage(notes);
      for (const chat of request.chats) {
        const page = chatToNote(chat);
        const mac = byID.get(page.id);
        if (!mac || mac.modified < page.modified - 0.0005) { await upsert(page); applied += 1; }
      }
    }
    if (applied) notes = await engineState();
    const phoneChatPages = new Set([PHONE_CHATS_PAGE_ID, ...notes.filter((n) => n.parentID === PHONE_CHATS_PAGE_ID).map((n) => n.id)]);
    const cursor = Date.now();
    const changed = notes
      .filter((n) => !n.isChat && !phoneChatPages.has(n.id) && toPhoneTime(n.modified) > request.since)
      .map((n) => ({ ...n, created: toPhoneTime(n.created), modified: toPhoneTime(n.modified) }));
    lastSync = cursor;
    return { t: cursor, cursor, notes: changed, macChats: await macChats(), applied };
  }

  async function handle(body) {
    const request = requestSchema.parse(decrypt(keyBytes(), body));
    if (Math.abs(Date.now() - request.t) > MAX_SKEW_MS) throw new Error('Clock mismatch between iPhone and Mac.');
    if (request.op === 'chat') return { t: Date.now(), messages: await chatMessages(request.sessionID) };
    return handleSync(request);
  }

  function listen() {
    if (server || !config) return;
    const current = http.createServer((req, res) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/folio-sync') { res.writeHead(404, headers); res.end(); return; }
      const chunks = []; let size = 0; let aborted = false;
      req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { aborted = true; res.writeHead(413, headers); res.end(); req.destroy(); } else chunks.push(chunk); });
      req.on('end', async () => {
        if (aborted) return;
        try {
          const reply = await handle(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
          res.end(encrypt(keyBytes(), reply));
        } catch (error) {
          // Wrong key, tampered or stale requests all look the same from outside.
          res.writeHead(400, headers);
          res.end(error instanceof z.ZodError ? 'Invalid request' : 'Could not sync');
          log(`[folio-sync] request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      });
    });
    current.on('error', (error) => { log(`[folio-sync] listener error: ${error.message}`); if (server === current) server = null; });
    current.listen(config.port, '0.0.0.0', () => log(`[folio-sync] listening on port ${config.port}`));
    server = current;
  }

  function status() {
    if (!config) return { enabled: false };
    const hosts = [bonjourName(), ...lanAddresses()];
    const params = new URLSearchParams({ h: hosts.join(','), p: String(config.port), k: config.key, n: os.hostname().replace(/\.local$/, '') });
    return { enabled: true, listening: Boolean(server), port: config.port, hosts, lastSync, pairingURL: `folio-sync://pair?${params.toString()}` };
  }

  return {
    start: () => listen(),
    status,
    enable() {
      if (!config) {
        config = { key: randomBytes(32).toString('base64url'), port: defaultPort };
        writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      }
      listen();
      return status();
    },
    disable() {
      server?.close(); server = null; config = null; lastSync = 0;
      rmSync(configPath, { force: true });
      return status();
    },
    stop() { server?.close(); server = null; },
  };
}
