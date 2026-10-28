import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalOutlook } from './personal-outlook.mjs';

const clientId = '11111111-1111-4111-8111-111111111111';
const scopes = 'User.Read Mail.Read Calendars.Read';
const tokens = { access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', expires_in: 3600, scope: scopes };
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text.split('').reverse().join('')), decryptString: (buffer) => buffer.toString().split('').reverse().join('') };

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outlook-test-'));
  const filePath = path.join(directory, 'personal-outlook.json');
  let time = Date.parse('2026-10-28T12:00:00Z');
  let blocked = false;
  const calls = [];
  const fetchImpl = async (raw, request) => {
    const url = new URL(raw);
    calls.push({ url, request });
    assert.equal(request.redirect, 'error');
    assert.ok(['https://login.microsoftonline.com', 'https://graph.microsoft.com'].includes(url.origin));
    if (url.pathname.endsWith('/devicecode')) return Response.json({ device_code: 'SYNTHETIC_DEVICE', user_code: 'TEST-CODE', expires_in: 900, interval: 5 });
    if (url.pathname.endsWith('/token')) {
      if (options.tokenResponse) return options.tokenResponse(request);
      return Response.json(tokens);
    }
    if (url.pathname === '/v1.0/me') return Response.json({ id: options.profileId ?? 'account-1', mail: 'test@example.com' });
    if (url.pathname.endsWith('/messages')) {
      if (options.failMail) return new Response(null, { status: 403 });
      const page = { value: options.emptyMail ? [] : [{ id: 'message-1', subject: 'Synthetic deadline', receivedDateTime: '2026-10-28T10:00:00Z', bodyPreview: 'Finish Friday', isRead: false }] };
      if (options.more) page['@odata.nextLink'] = 'https://evil.example/steal';
      return Response.json(page);
    }
    if (url.pathname.endsWith('/calendarView')) {
      if (options.failCalendar) return new Response(null, { status: 503 });
      return Response.json({ value: [{ id: 'event-1', subject: 'Synthetic meeting', start: { dateTime: '2026-10-29T12:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-29T13:00:00', timeZone: 'UTC' }, isAllDay: false, isCancelled: false }] });
    }
    throw new Error('Unexpected endpoint');
  };
  const native = options.native ?? { available: async () => false };
  const service = createPersonalOutlook({ filePath, safeStorage, isBlocked: () => blocked, fetchImpl, now: () => time, native });
  const authorize = async () => {
    await service.handle({ op: 'connect', clientId });
    time += 5000;
    return service.handle({ op: 'check' });
  };
  return { service, calls, filePath, authorize, advance: (ms) => { time += ms; }, block: () => { blocked = true; }, clean: async () => { service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('device authorization is explicit, interval-limited and only saved after a live verified exchange', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.handle({ op: 'status' }), { clientId: '', accounts: [], pending: null, native: { available: false, access: 'unsupported', accounts: [] } });
    assert.equal(f.calls.length, 0);
    const started = await f.service.handle({ op: 'connect', clientId });
    assert.equal(started.pending.code, 'TEST-CODE');
    assert.equal(started.accounts.length, 0);
    await f.service.handle({ op: 'check' });
    assert.equal(f.calls.length, 1);
    f.advance(5000);
    const completed = await f.service.handle({ op: 'check' });
    assert.deepEqual(completed.accounts, [{ address: 'test@example.com' }]);
    assert.equal(completed.pending, null);
    assert.ok(!JSON.stringify(completed).includes('SYNTHETIC'));
    const saved = await readFile(f.filePath, 'utf8');
    assert.ok(!saved.includes('SYNTHETIC'));
    assert.match(f.calls[0].request.body.get('scope'), /Mail.Read Calendars.Read/);
    assert.ok(!f.calls[0].request.body.get('scope').includes('Write'));
    assert.equal(f.calls[1].request.body.get('device_code'), 'SYNTHETIC_DEVICE');
  } finally { await f.clean(); }
});

test('only consent-selected accounts are read, with bounded previews and seven-day UTC events', async () => {
  const f = await fixture({ more: true });
  try {
    await f.authorize();
    f.calls.length = 0;
    const missing = await f.service.readAwareness(['other@example.com']);
    assert.equal(missing.status, 'needs-connection');
    assert.equal(f.calls.length, 0);
    const value = await f.service.readAwareness(['TEST@example.com']);
    assert.equal(value.status, 'partial');
    assert.equal(value.records.length, 2);
    assert.equal(value.records[0].truncated, true);
    assert.ok(value.records.every((record) => record.id.startsWith('test@example.com:')));
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC'));
    const calendar = f.calls.find((call) => call.url.pathname.endsWith('/calendarView'));
    assert.equal(calendar.url.searchParams.get('endDateTime'), '2026-11-04T12:00:05.000Z');
    assert.equal(calendar.request.headers.Prefer, 'outlook.timezone="UTC"');
    assert.ok(f.calls.every((call) => call.url.hostname !== 'evil.example'));
    assert.ok(f.calls.every((call) => !call.request.method || call.request.method === 'GET'));
  } finally { await f.clean(); }
});

test('one failed source keeps another successful empty source partial, not an authoritative empty success', async () => {
  const f = await fixture({ emptyMail: true, failCalendar: true });
  try {
    await f.authorize();
    const value = await f.service.readAwareness(['test@example.com']);
    assert.equal(value.status, 'partial');
    assert.equal(value.accounts[0].status, 'partial');
    assert.deepEqual(value.records, []);
  } finally { await f.clean(); }
});

test('both failed sources report error and account identity changes prevent content reads', async () => {
  const f = await fixture({ failMail: true, failCalendar: true });
  try {
    await f.authorize();
    assert.equal((await f.service.readAwareness(['test@example.com'])).status, 'error');
    const settings = JSON.parse(await readFile(f.filePath));
    settings.accounts[0].id = 'different-account';
    await writeFile(f.filePath, JSON.stringify(settings));
    f.calls.length = 0;
    assert.equal((await f.service.readAwareness(['test@example.com'])).status, 'error');
    assert.equal(f.calls.length, 1);
  } finally { await f.clean(); }
});

test('expired tokens rotate once before concurrent readers and replacement refresh tokens persist', async () => {
  const f = await fixture({ tokenResponse: (request) => Response.json({ ...tokens, refresh_token: request.body.get('grant_type') === 'refresh_token' ? 'ROTATED_REFRESH' : tokens.refresh_token }) });
  try {
    await f.authorize();
    f.advance(3600000);
    f.calls.length = 0;
    await Promise.all([f.service.readAwareness(['test@example.com']), f.service.readAwareness(['test@example.com'])]);
    assert.equal(f.calls.filter((call) => call.url.pathname.endsWith('/token')).length, 1);
    const saved = JSON.parse(await readFile(f.filePath));
    const decrypted = JSON.parse(safeStorage.decryptString(Buffer.from(saved.accounts[0].token, 'base64')));
    assert.equal(decrypted.refresh_token, 'ROTATED_REFRESH');
  } finally { await f.clean(); }
});

test('enterprise policy denies network and sign-in while cancellation and local disconnect remain usable', async () => {
  const f = await fixture();
  try {
    await f.authorize();
    f.block();
    f.calls.length = 0;
    for (const op of ['connect', 'check']) await assert.rejects(f.service.handle({ op, clientId }), /enterprise/);
    assert.deepEqual((await f.service.handle({ op: 'status' })).accounts, [{ address: 'test@example.com' }]);
    await assert.rejects(f.service.readAwareness(['test@example.com']), /enterprise/);
    await f.service.handle({ op: 'cancel' });
    assert.deepEqual((await f.service.handle({ op: 'disconnect', address: 'test@example.com' })).accounts, []);
    assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});

test('pending authorization, slowdown, cancellation and expiry never invent a connected account', async () => {
  let count = 0;
  const f = await fixture({ tokenResponse: () => Response.json({ error: ++count === 1 ? 'authorization_pending' : 'slow_down' }, { status: 400 }) });
  try {
    await f.service.handle({ op: 'connect', clientId });
    f.advance(5000);
    assert.deepEqual((await f.service.handle({ op: 'check' })).accounts, []);
    f.advance(5000);
    const slowed = await f.service.handle({ op: 'check' });
    assert.equal(slowed.pending.nextCheckAt, Date.parse('2026-10-28T12:00:20Z'));
    assert.deepEqual((await f.service.handle({ op: 'cancel' })).accounts, []);
    await f.service.handle({ op: 'connect', clientId });
    f.advance(901000);
    await assert.rejects(f.service.handle({ op: 'check' }), /expired/);
  } finally { await f.clean(); }
});

test('missing scopes, revoked refresh and malformed saved state fail closed', async () => {
  const f = await fixture({ tokenResponse: () => Response.json({ ...tokens, scope: 'User.Read' }) });
  try {
    await assert.rejects(f.authorize(), /permissions/);
    assert.deepEqual((await f.service.handle({ op: 'status' })).accounts, []);
    await writeFile(f.filePath, '{');
    await assert.rejects(f.service.handle({ op: 'status' }), /saved Outlook/);
  } finally { await f.clean(); }
  const revoked = await fixture({ tokenResponse: (request) => request.body.get('grant_type') === 'refresh_token' ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json(tokens) });
  try {
    await revoked.authorize();
    revoked.advance(3600000);
    const value = await revoked.service.readAwareness(['test@example.com']);
    assert.equal(value.status, 'error');
    assert.deepEqual(value.records, []);
  } finally { await revoked.clean(); }
});

test('native Outlook connects without Azure configuration and reads only consent-selected stable identities', async () => {
  const identity = { id: 'exchangeAccounts:42', address: 'native@example.com' };
  const calls = [];
  const native = {
    available: async () => true,
    probe: async () => { calls.push('probe'); return { access: 'connected', accounts: [identity] }; },
    connect: async () => { calls.push('connect'); return { access: 'connected', accounts: [identity] }; },
    read: async (accounts) => {
      calls.push(accounts);
      return { access: 'connected', accounts: [identity], health: [{ address: identity.address, status: 'partial' }], records: [{ id: 'native:synthetic', title: 'Synthetic excerpt', text: 'Synthetic only', truncated: true }] };
    },
  };
  const f = await fixture({ native });
  try {
    const before = await f.service.handle({ op: 'status' });
    assert.equal(before.native.access, 'not-connected');
    assert.deepEqual(calls, []);
    assert.equal((await f.service.readAwareness([identity.address])).status, 'needs-connection');
    assert.deepEqual(calls, []);
    const connected = await f.service.handle({ op: 'native-connect' });
    assert.equal(connected.clientId, '');
    assert.deepEqual(connected.native.accounts, [identity]);
    assert.equal(connected.native.access, 'connected');
    calls.length = 0;
    const value = await f.service.readAwareness([identity.address, 'unapproved@example.com']);
    assert.deepEqual(calls, [[identity]]);
    assert.equal(value.status, 'partial');
    assert.equal(value.records.length, 1);
    assert.deepEqual(value.accounts, [{ address: identity.address, status: 'partial' }, { address: 'unapproved@example.com', status: 'needs-connection' }]);
    assert.equal(f.calls.length, 0);
    f.block();
    await assert.rejects(f.service.handle({ op: 'native-connect' }), /enterprise/);
    await f.service.handle({ op: 'native-disconnect' });
    assert.equal(JSON.parse(await readFile(f.filePath)).native.enabled, false);
  } finally { await f.clean(); }
});

test('native permission denial or unreadable account identities cannot persist a connection', async () => {
  const native = { available: async () => true, connect: async () => ({ access: 'unsupported', reason: 'accounts-unavailable', accounts: [] }) };
  const f = await fixture({ native });
  try {
    await assert.rejects(f.service.handle({ op: 'native-connect' }), /did not expose any readable account identities/);
    assert.equal((await f.service.handle({ op: 'status' })).native.access, 'not-connected');
    assert.deepEqual((await f.service.handle({ op: 'status' })).native.accounts, []);
    assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});
