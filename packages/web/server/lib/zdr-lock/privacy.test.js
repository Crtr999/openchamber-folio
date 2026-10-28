import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { createZdrPrivacy, createPrivateSseFilter } from './privacy.js';
import { createZdrLock } from './runtime.js';
import { createGlobalMessageStreamWsBridge } from '../event-stream/global-ws-bridge.js';
import { createGlobalUiEventBroadcaster } from '../event-stream/runtime.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { registerZdrAccessGuard, registerZdrLockRoutes } from './routes.js';
import { registerNotificationRoutes } from '../notifications/routes.js';

const cleanup = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-fixture-'));
  cleanup.push(root);
  const legal = path.join(root, 'ZDR Legal');
  const publicDirectory = path.join(root, 'public');
  const bound = path.join(root, 'bound');
  await Promise.all([legal, publicDirectory, bound].map(directory => fs.mkdir(directory)));
  const alias = path.join(root, 'alias');
  await fs.symlink(legal, alias);
  const clock = { value: 1000 };
  const lock = createZdrLock({ file: path.join(root, 'pin.json'), now: () => clock.value });
  lock.set('4821');
  let checks = 0;
  const privacy = createZdrPrivacy({ lock, listProjectPaths: async () => [legal, publicDirectory, bound],
    listProjects: async () => [{ id: 'legal', path: legal }], realpath: directory => fs.realpath(directory),
    folderGuard: { check: async directory => { checks++; if (/zdr/i.test(directory)) throw new Error('No private configuration read permitted'); return { ok: directory !== bound }; } },
    resolveSessionDirectory: async id => ({ private: legal, public: publicDirectory })[id],
  });
  return { privacy, lock, clock, legal, publicDirectory, root, bound, alias, checks: () => checks };
};
const event = (directory, text = 'synthetic content') => ({ type: 'session.text.delta', location: { directory }, data: { text } });
const block = payload => `data: ${JSON.stringify(payload)}\n\n`;

test('global metadata and activity permanently exclude private, bound, aliased and unknown owners, even with a grant', async () => {
  const f = await fixture();
  const token = f.lock.verify('4821').accessToken;
  const sessions = [{ id: 'private', directory: f.legal }, { id: 'alias', directory: f.alias }, { id: 'bound', directory: path.join(f.bound, 'child') }, { id: 'unknown' }, { id: 'public', location: { directory: f.publicDirectory } }];
  expect(await f.privacy.filterSessions(sessions, { token })).toEqual([sessions[4]]);
  expect(await f.privacy.filterActive({ private: 'busy', public: 'busy', missing: 'busy' }, { token })).toEqual({ public: 'busy' });
  expect(await f.privacy.filterEvent({ type: 'openchamber:companion-changed', properties: { projectId: 'legal' } })).toBeNull();
  expect(await f.privacy.filterEvent({ type: 'session.text.delta', sessionID: 'private' })).toBeNull();
  expect(await f.privacy.filterEvent({ type: 'session.text.delta', data: { text: 'unknown' } })).toBeNull();
});

test('synthetic Legal unlock -> scoped content -> relock/expiry, with canonical aliases and dot paths', async () => {
  const f = await fixture();
  const content = event(f.legal);
  const options = { scope: f.alias };
  expect(await f.privacy.filterEvent(content, options)).toBeNull();
  const grant = f.lock.verify('4821');
  options.token = grant.accessToken;
  expect(await f.privacy.filterEvent(content, options)).toEqual(content);
  expect(await f.privacy.allowsDirectory(path.join(f.alias, 'child', '..'), options)).toBe(true);
  expect(await f.privacy.filterEvent(content, { token: grant.accessToken })).toBeNull();
  expect(await f.privacy.filterEvent(content, { token: grant.accessToken, scope: f.root })).toBeNull();
  expect(await f.privacy.filterEvent(event(f.bound), options)).toBeNull();
  f.lock.revoke(grant.accessToken);
  expect(await f.privacy.filterEvent(content, options)).toBeNull();
  const next = f.lock.verify('4821');
  f.clock.value = next.expiresAt + 1;
  expect(await f.privacy.filterEvent(content, { scope: f.legal, token: next.accessToken })).toBeNull();
  // Canonical case is supplied by the filesystem, never by lowercasing Linux paths.
  try {
    const alternate = await fs.realpath(f.legal.toUpperCase());
    expect(await f.privacy.canonical(f.legal.toUpperCase())).toBe(alternate);
    expect(await f.privacy.allowsDirectory(f.legal.toUpperCase())).toBe(false);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('SSE buffers fragmented frames, filters private frames and mixed references, and rechecks an open stream after revocation', async () => {
  const f = await fixture();
  const grant = f.lock.verify('4821');
  const filter = createPrivateSseFilter({ privacy: f.privacy, options: { scope: f.legal, token: grant.accessToken } });
  const encoder = new TextEncoder();
  const frame = block(event(f.legal));
  expect(await filter(encoder.encode(frame.slice(0, 18)))).toBe('');
  expect(await filter(encoder.encode(frame.slice(18)))).toBe(frame);
  f.lock.revoke(grant.accessToken);
  expect(await filter(encoder.encode(frame))).toBe('');
  const publicFrame = block(event(f.publicDirectory));
  expect(await filter(encoder.encode(publicFrame))).toBe(publicFrame);
  const mixed = block({ type: 'openchamber:worktree-changed', properties: { directories: [f.legal, f.publicDirectory] } });
  const redacted = await filter(encoder.encode(mixed));
  expect(redacted).toContain(f.publicDirectory);
  expect(redacted).not.toContain(f.legal);
  expect(await filter(encoder.encode('data: invalid\n\n'))).toBe('');
});

test('repeated events share policy work, but a symlink replacement cannot reuse a public decision', async () => {
  const f = await fixture();
  const publicAlias = path.join(f.root, 'changing-alias');
  await fs.symlink(f.publicDirectory, publicAlias);
  expect(await f.privacy.allowsDirectory(publicAlias)).toBe(true);
  const checks = f.checks();
  for (let index = 0; index < 100; index++) expect(await f.privacy.filterEvent(event(f.publicDirectory))).not.toBeNull();
  expect(f.checks()).toBe(checks);
  await fs.unlink(publicAlias);
  await fs.symlink(f.legal, publicAlias);
  expect(await f.privacy.allowsDirectory(publicAlias)).toBe(false);
  f.privacy.invalidate();
  expect(await f.privacy.allowsDirectory(publicAlias)).toBe(false);
});

test('global websocket live, replay and control fan-out never transmit private content', async () => {
  const f = await fixture();
  let publish;
  const frames = [];
  const entries = [f.legal, f.publicDirectory].map((directory, index) => ({ eventId: String(index), serializedFrame: JSON.stringify({ type: 'event', payload: event(directory), directory }) }));
  const hub = { flushPending() {}, replayAfter: () => entries, subscribeEvent: callback => { publish = callback; return () => {}; }, subscribeStatus: () => () => {}, isConnected: () => true, start() {}, stop() {} };
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = frame => frames.push(JSON.parse(frame));
  const filterEvent = (payload, options) => f.privacy.filterEvent(payload, options);
  const bridge = createGlobalMessageStreamWsBridge({ globalHub: hub, ownsGlobalHub: false, wsClients: new Set(), processForwardedEventPayload() {}, heartbeatIntervalMs: 60_000, filterEvent });
  try {
    bridge.accept(socket, { requestedLastEventId: 'before' });
    await expect.poll(() => frames.length).toBe(2);
    publish({ payload: event(f.legal), directory: f.legal, eventId: 'private-live', serialize: () => { throw new Error('Private content must not be serialized'); } });
    publish({ payload: event(f.publicDirectory), directory: f.publicDirectory, eventId: 'public-live', serialize: () => JSON.stringify({ type: 'event', payload: event(f.publicDirectory) }) });
    await expect.poll(() => frames.length).toBe(3);
    expect(JSON.stringify(frames)).not.toContain(f.legal);
    const controls = [];
    const broadcast = createGlobalUiEventBroadcaster({ sseClients: new Set([{}]), wsClients: new Set(), writeSseEvent: (_res, payload) => controls.push(payload), filterEvent });
    await broadcast(event(f.legal));
    await broadcast(event(f.publicDirectory));
    expect(controls).toEqual([event(f.publicDirectory)]);
  } finally { socket.emit('close'); bridge.close(); }
});

test('real HTTP proxy and status routes redact global payloads, allow canonical scoped unlock, and deny relocked reads', async () => {
  const f = await fixture();
  const sessions = [{ id: 'private', location: { directory: f.legal }, title: 'synthetic private title' }, { id: 'public', location: { directory: f.publicDirectory }, title: 'public title' }];
  const upstreamHeaders = [];
  const upstream = http.createServer((req, res) => {
    upstreamHeaders.push(req.headers);
    if (req.url.startsWith('/api/event')) {
      res.setHeader('content-type', 'text/event-stream');
      return res.end(block(event(f.legal)) + block(event(f.publicDirectory)));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/session/active') ? { private: 'busy', public: 'busy' } : { data: sessions, cursor: 'next' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const app = express();
  registerZdrAccessGuard(app, { lock: f.lock, path, privacy: f.privacy, listProjects: async () => [], resolveSessionDirectory: async () => null });
  registerZdrLockRoutes(app, { lock: f.lock, path, privacy: f.privacy, listProjectPaths: async () => [f.alias], resolveAllowedProviders: async () => [] });
  const statuses = { private: { status: 'busy' }, public: { status: 'busy' } };
  registerNotificationRoutes(app, { privacy: f.privacy, getSessionActivitySnapshot: () => statuses, getSessionStateSnapshot: () => statuses,
    getSessionAttentionSnapshot: () => statuses, getPendingBlockingRequestsSnapshot: () => statuses,
  });
  registerOpenCodeProxy(app, { privacy: f.privacy, getRuntime: () => ({ openCodePort: port }),
    buildOpenCodeUrl: url => `http://127.0.0.1:${port}${url}`, getOpenCodeAuthHeaders: () => ({}),
    ensureOpenCodeApiPrefix: async () => {},
  });
  try {
    const global = await request(app).get('/api/session').expect(200);
    expect(global.body.data.map(session => session.id)).toEqual(['public']);
    expect(global.body.cursor).toBe('next');
    const grant = f.lock.verify('4821');
    const unlockedGlobal = await request(app).get('/api/session').set('x-openchamber-zdr-access', grant.accessToken).expect(200);
    expect(unlockedGlobal.body.data.map(session => session.id)).toEqual(['public']);
    const scoped = await request(app).get('/api/session').query({ directory: f.alias }).set('x-openchamber-zdr-access', grant.accessToken).expect(200);
    expect(scoped.body.data.map(session => session.id)).toEqual(['private', 'public']);
    const state = await request(app).get('/api/openchamber/zdr-lock/state').expect(200);
    expect(state.body.directories).toContain(f.alias);
    expect(state.body.directories).toContain(await fs.realpath(f.legal));
    for (const route of ['/api/session/active', '/api/session-activity', '/api/sessions/status', '/api/sessions/snapshot', '/api/sessions/attention']) {
      const response = await request(app).get(route).set('x-openchamber-zdr-access', grant.accessToken).expect(200);
      expect(JSON.stringify(response.body)).not.toContain('private');
      expect(JSON.stringify(response.body)).toContain('public');
    }
    const globalEvents = await request(app).get('/api/event').set('x-openchamber-zdr-access', grant.accessToken).expect(200);
    expect(globalEvents.text).not.toContain(f.legal);
    expect(globalEvents.text).toContain(f.publicDirectory);
    const scopedEvents = await request(app).get('/api/event').set('x-openchamber-zdr-access', grant.accessToken).set('x-openchamber-zdr-directory', encodeURIComponent(f.alias)).expect(200);
    expect(scopedEvents.text).toContain(f.legal);
    f.lock.revoke(grant.accessToken);
    await request(app).get('/api/session').query({ directory: f.alias }).set('x-openchamber-zdr-access', grant.accessToken).expect(403);
    const relocked = await request(app).get('/api/event').set('x-openchamber-zdr-access', grant.accessToken).set('x-openchamber-zdr-directory', encodeURIComponent(f.alias)).expect(200);
    expect(relocked.text).not.toContain(f.legal);
    expect(upstreamHeaders.every(headers => !headers['x-openchamber-zdr-access'] && !headers['x-openchamber-zdr-directory'])).toBe(true);
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
