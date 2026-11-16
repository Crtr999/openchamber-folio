import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createNativeAppReader } from './native-app-reader.mjs';

const query = { app: 'calendar', containerId: 'fixture', start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z', limit: 10 };
function fixture() {
  const calls = []; let killed = 0;
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.kill = () => { killed += 1; };
  const reader = createNativeAppReader({ executable: '/synthetic/bundled/NativeAppReader', platform: 'darwin', spawnProcess: (...args) => { calls.push(args); return child; } });
  const reply = (value) => { child.stdout.write(JSON.stringify(value)); child.emit('close', 0); };
  return { calls, child, reader, reply, killed: () => killed };
}
test('uses only fixed executable, no arguments and no shell; returns authoritative empty success', async () => {
  const f = fixture(); let input = ''; f.child.stdin.on('data', (chunk) => { input += chunk; });
  const result = f.reader.read(query); f.reply({ status: 'ok', items: [], truncated: false });
  assert.deepEqual(await result, { status: 'ok', items: [], truncated: false });
  assert.deepEqual(f.calls, [['/synthetic/bundled/NativeAppReader', [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false }]]);
  assert.deepEqual(JSON.parse(input), { ...query, op: 'read' });
});
test('rejects writes, scripts, extra fields, unsupported app, wild unbounded reads before execution', async () => {
  const f = fixture();
  for (const input of [{ ...query, op: 'save' }, { ...query, script: 'activate' }, { ...query, app: 'mail' }, { ...query, limit: 101 }, { ...query, end: '2027-01-01T00:00:00Z' }]) {
    await assert.rejects(f.reader.read(input));
  }
  assert.deepEqual(f.calls, []);
});
test('does not launch on unsupported platforms or a pre-cancelled request', async () => {
  const f = fixture();
  const unsupported = createNativeAppReader({ executable: '/unused', platform: 'linux', spawnProcess: () => assert.fail('must not spawn') });
  assert.equal((await unsupported.read(query)).status, 'unsupported');
  assert.equal((await f.reader.read(query, AbortSignal.abort())).status, 'error'); assert.deepEqual(f.calls, []);
});
test('reports missing helper without claiming it is ready or probing permissions', () => {
  const reader = createNativeAppReader({ executable: '/nonexistent/native-reader-fixture', platform: 'darwin' });
  assert.equal(reader.status().status, 'unsupported'); assert.equal(reader.status().permissions, 'not-checked');
  assert.deepEqual(reader.status().apps, { calendar: 'unsupported', reminders: 'unsupported', notes: 'unsupported', mail: 'unsupported' });
});
test('preserves permission and container failures instead of returning empty items', async () => {
  for (const status of ['permission-required', 'permission-denied', 'container-unavailable', 'unsupported', 'error']) {
    const f = fixture(); const result = f.reader.read(query); f.reply({ status, reason: 'fixture' });
    assert.deepEqual(await result, { status, reason: 'fixture' });
  }
});
test('returns bounded content and truncation, including nullable reminder end', async () => {
  const f = fixture(); const result = f.reader.read({ ...query, app: 'reminders' });
  const response = { status: 'ok', items: [{ id: 'r1', title: 'Synthetic reminder', start: query.start, end: null, allDay: true }], truncated: true };
  f.reply(response); assert.deepEqual(await result, response);
});
test('malformed, excessive item count and nonzero exits are errors, not empty success', async () => {
  for (const payload of [{ status: 'ok', items: [] }, { status: 'ok', items: Array(11).fill({ id: 'x', title: '', start: null, end: null, allDay: false }), truncated: false }]) {
    const f = fixture(); const result = f.reader.read(query); f.reply(payload); assert.equal((await result).status, 'error');
  }
  const f = fixture(); const result = f.reader.read(query); f.child.emit('close', 1); assert.equal((await result).status, 'error');
});
test('abort kills owned helper and removes outstanding operation', async () => {
  const f = fixture(); const controller = new AbortController(); const result = f.reader.read(query, controller.signal);
  controller.abort(); assert.equal((await result).status, 'error'); assert.equal(f.killed(), 1);
});
test('deadline kills owned helper and reports failure rather than empty success', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const result = f.reader.read(query);
  context.mock.timers.tick(20_000);
  assert.deepEqual(await result, { status: 'error', reason: 'Native read timed out.' }); assert.equal(f.killed(), 1);
});
test('oversized output kills helper and process errors remain unavailable', async () => {
  const f = fixture(); const result = f.reader.read(query); f.child.stdout.write('x'.repeat(512 * 1024 + 1));
  assert.equal((await result).status, 'error'); assert.equal(f.killed(), 1);
  const missing = fixture(); const unavailable = missing.reader.read(query); missing.child.emit('error', new Error('synthetic'));
  assert.equal((await unavailable).status, 'unsupported');
});
test('native implementation contains only scoped EventKit reads and no activation or permission requests', async () => {
  const source = await readFile(new URL('./native/NativeAppReader.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:AppKit|NSWorkspace|NSAppleScript|requestAccess|requestFullAccessToEvents|requestFullAccessToReminders)\b|store\.(?:save|remove|commit)|\.activate\(/);
  assert.match(source, /calendars: \[calendar\]/); assert.match(source, /calendarIdentifier == containerId/);
  assert.match(source, /permissionResult\(entity\)/); assert.match(source, /guard completed, let reminders = found/);
});
test('container discovery uses a separate metadata-only request, never a broad content query', async () => {
  const f = fixture(); let input = ''; f.child.stdin.on('data', (chunk) => { input += chunk; });
  const result = f.reader.containers({ app: 'calendar' });
  f.reply({ status: 'containers', containers: [{ id: 'selected-id', title: 'Synthetic calendar' }], truncated: false });
  assert.equal((await result).status, 'containers'); assert.deepEqual(JSON.parse(input), { app: 'calendar', op: 'containers' });
  const mismatch = fixture(); const wrong = mismatch.reader.read(query);
  mismatch.reply({ status: 'containers', containers: [], truncated: false }); assert.equal((await wrong).status, 'error');
});
