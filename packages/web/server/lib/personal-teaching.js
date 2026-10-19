import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigLayers } from './opencode/shared.js';
import { isEnterpriseMode } from './enterprise-mode.js';

const connectionSchema = z.object({ type: z.literal('remote'), enabled: z.boolean().optional(), url: z.string().url(), headers: z.record(z.string(), z.string()) });
const stateSchema = z.object({ recording: z.array(z.object({ screen: z.string(), id: z.string().regex(/^[a-zA-Z0-9-]+$/) })), recordings: z.array(z.string()) });
const idSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9-]+$/) });
const stoppedSchema = idSchema.extend({ seconds: z.number().nonnegative(), events: z.number().int().nonnegative() });
const screen = 'open-carter-teach';
const resolveCredential = (value) => value.replace(/\{(file|env):([^}]+)\}/g, (_match, kind, name) => {
  if (kind === 'env') return process.env[name]?.trim() ?? '';
  const file = name.startsWith('~/') ? path.join(os.homedir(), name.slice(2)) : name;
  if (!path.isAbsolute(file) || statSync(file).size > 65_536) throw new Error('teaching_not_connected');
  return readFileSync(file, 'utf8').trim();
});

/** Local desktop broker. No routes, listener, model calls or user-Mac capture. */
export function createPersonalTeaching({ fetchImpl = fetch, readConfig = () => readConfigLayers().mergedConfig, blocked = isEnterpriseMode, resolveSecret = resolveCredential } = {}) {
  let owner = null;
  let pending = null;
  let recent = null;
  let captureOwned = false;
  const guard = () => { if (blocked()) throw new Error('enterprise_mode: Teaching is disabled by your administrator.'); };
  const connect = () => {
    guard();
    const config = z.object({ mcp: z.object({ carterbot: connectionSchema }) }).safeParse(readConfig());
    if (!config.success || config.data.mcp.carterbot.enabled === false) throw new Error('teaching_not_connected');
    const entry = config.data.mcp.carterbot;
    const endpoint = new URL(entry.url);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp'
      || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('teaching_invalid_connection');
    let bearer;
    try { const configured = new Headers(entry.headers).get('authorization'); bearer = configured ? resolveSecret(configured) : null; }
    catch { throw new Error('teaching_not_connected'); }
    if (!bearer?.startsWith('Bearer ') || bearer.length < 10 || bearer.includes('{')) throw new Error('teaching_not_connected');
    return { origin: endpoint.origin, bearer };
  };
  const request = async (connection, pathname, body) => {
    // Stopping our already-owned capture sends no user content. Keep this
    // cleanup possible if an administrator disables teaching mid-recording.
    if (pathname !== '/api/teach/stop' || connection !== owner) guard();
    const options = { method: body ? 'POST' : 'GET', redirect: 'error', headers: { authorization: connection.bearer }, signal: AbortSignal.timeout(15_000) };
    if (body) { options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetchImpl(`${connection.origin}${pathname}`, options);
    if (!response.ok) { await response.body?.cancel(); throw new Error('teaching_connection_failed'); }
    // Do not include upstream errors or credentials in renderer-visible errors.
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('teaching_response_too_large');
    return JSON.parse(text);
  };
  const view = (connection, id) => `${connection.origin}${id ? `/files/recordings/${encodeURIComponent(id)}/screen.mp4` : `/?screen=${screen}&solo=1`}`;
  const snapshot = async (connection) => {
    const state = stateSchema.parse(await request(connection, '/api/state'));
    const recording = state.recording.find((entry) => entry.screen === screen);
    return { phase: recording ? 'recording' : recent ? 'review' : 'ready', recordingId: recording?.id ?? recent?.id ?? null, seconds: recent?.seconds ?? 0, viewUrl: view(connection), videoUrl: !recording && recent ? view(connection, recent.id) : null, recordings: state.recordings.filter((id) => /^[a-zA-Z0-9-]+-open-carter-teach$/.test(id)).slice(0, 30) };
  };
  const exclusive = (work) => {
    if (pending) throw new Error('teaching_busy');
    pending = work().finally(() => { pending = null; });
    return pending;
  };
  return {
    async status() { const connection = owner ?? connect(); const state = await snapshot(connection); if (state.phase === 'recording') { owner = connection; captureOwned = true; } return state; },
    start() { return exclusive(async () => {
      const connection = owner ?? connect();
      const state = await snapshot(connection);
      if (state.phase === 'recording') { owner = connection; captureOwned = true; return state; }
      owner = connection;
      await request(connection, '/api/screen/open', { name: screen });
      // Keep owner on uncertain failures. Status/stop must reconcile, never retry
      // a potentially successful start without checking authoritative state.
      captureOwned = true;
      const started = idSchema.parse(await request(connection, '/api/teach/start', { screen }));
      recent = null;
      return { phase: 'recording', recordingId: started.id, seconds: 0, viewUrl: view(connection), videoUrl: null, recordings: state.recordings };
    }); },
    stop() { return exclusive(async () => {
      const connection = owner ?? connect();
      const stopped = stoppedSchema.parse(await request(connection, '/api/teach/stop', { screen }));
      captureOwned = false;
      recent = stopped;
      return snapshot(connection);
    }); },
    async review(id) {
      const connection = owner ?? connect();
      const state = await snapshot(connection);
      if (state.phase === 'recording' || !state.recordings.includes(id)) throw new Error('teaching_review_unavailable');
      recent = { id, seconds: 0 };
      return snapshot(connection);
    },
    async dismiss() {
      if (pending) await pending.catch(() => {});
      if (!owner || !captureOwned) return { closed: true };
      if (blocked()) { recent = stoppedSchema.parse(await request(owner, '/api/teach/stop', { screen })); captureOwned = false; return { closed: true }; }
      const state = await snapshot(owner);
      if (state.phase === 'recording') await this.stop();
      else captureOwned = false;
      return { closed: true };
    },
    /** Fixed internal MCP operations, never an arbitrary renderer tool bridge. */
    async skillTool(name, args) {
      guard();
      if (!['teach_watch', 'skill_list', 'skill_read', 'skill_save'].includes(name)) throw new Error('teaching_invalid_tool');
      const connection = connect();
      const id = randomUUID();
      const response = await fetchImpl(`${connection.origin}/mcp`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { authorization: connection.bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('teaching_connection_failed'); }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 24_000_000) throw new Error('teaching_response_too_large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      guard();
      const text = Buffer.concat(chunks).toString('utf8');
      const envelopes = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
        : [JSON.parse(text)];
      const envelope = envelopes.find(entry => entry.id === id);
      const result = z.object({ isError: z.boolean().optional(), content: z.array(z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string().max(200_000) }),
        z.object({ type: z.literal('image'), data: z.string().max(2_000_000).regex(/^[A-Za-z0-9+/=]+$/), mimeType: z.literal('image/jpeg') }),
      ])).max(30) }).parse(envelope?.result);
      if (envelope.error || result.isError) throw new Error('teaching_tool_failed');
      return result.content;
    },
    /** Main process sets an isolated HttpOnly cookie, never a token-bearing URL. */
    credentials() { const connection = owner ?? connect(); guard(); return { origin: connection.origin, token: connection.bearer.slice(7) }; },
  };
}
