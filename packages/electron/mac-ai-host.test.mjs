import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMacAiHost } from './mac-ai-host.mjs';

function fixture(options = {}) {
  const calls = [];
  const ids = new Set();
  let enabled = true;
  const coordinator = {
    status: async () => ({ config: { enabled }, error: '', lastCheckedAt: 42, nextCheckAt: 100 }),
    start: () => assert.fail('native host must not start a coordinator'),
    close: () => assert.fail('server owns coordinator shutdown'),
    check: () => assert.fail('diagnostics must not dispatch'),
  };
  const host = createMacAiHost({
    platform: 'darwin', now: () => 123,
    blocker: {
      start(type) { calls.push(['start', type]); ids.add(calls.length); return calls.length; },
      stop(id) { calls.push(['stop', id]); ids.delete(id); },
      isStarted: id => ids.has(id),
    },
    savePreference: async (key, value) => { calls.push(['save', key, value]); },
    ...options,
  });
  return { host, coordinator, calls, ids, pause: () => { enabled = false; } };
}

test('saved opt-outs and default preferences never acquire wake protection', async () => {
  for (const preferences of [{}, { desktopAiHostKeepAwakeEnabled: false }]) {
    const f = fixture();
    f.host.initialize(preferences);
    assert.equal((await f.host.attach(f.coordinator)).wakeProtection.enabled, false);
    assert.equal(f.calls.length, 0);
    await f.host.stop();
  }
});

test('startup waits for the server coordinator; repeated calls share one blocker', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.host.status()).coordinator.state, 'waiting');
  await f.host.attach(f.coordinator);
  await Promise.all(Array.from({ length: 20 }, () => f.host.attach(f.coordinator)));
  assert.deepEqual(f.calls, [['start', 'prevent-app-suspension']]);
  assert.throws(() => f.host.attach({ ...f.coordinator }), /already has/);
  assert.equal((await f.host.status()).wakeProtection.source, 'team');
  await f.host.stop();
  assert.equal(f.ids.size, 0);
});

test('pause releases the team lease but preserves an independent app opt-in', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  await f.host.attach(f.coordinator);
  f.pause();
  const paused = await f.host.status();
  assert.equal(paused.coordinator.state, 'paused');
  assert.equal(paused.wakeProtection.active, false);
  assert.equal(paused.wakeProtection.reason, 'paused');
  await f.host.configureGeneral(true);
  assert.equal((await f.host.status()).wakeProtection.source, 'app');
  await f.host.configure({ wakeProtectionEnabled: false });
  assert.equal(f.ids.size, 1);
  await f.host.stop();
  assert.equal(f.ids.size, 0);
});

test('quit releases synchronously before backend drain and late startup cannot reacquire', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true, desktopKeepAwakeEnabled: true });
  await f.host.attach(f.coordinator);
  const stopped = f.host.stop();
  assert.equal(f.ids.size, 0);
  await stopped;
  await f.host.stop();
  await f.host.attach(f.coordinator);
  await f.host.resume();
  f.host.initialize({ desktopKeepAwakeEnabled: true });
  assert.equal((await f.host.status()).coordinator.state, 'stopped');
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
});

test('unavailable native support and start failure are honest diagnostics', async () => {
  const unsupported = fixture({ blocker: null });
  unsupported.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  const value = await unsupported.host.attach(unsupported.coordinator);
  assert.equal(value.wakeProtection.supported, false);
  assert.equal(value.wakeProtection.active, false);
  assert.equal(value.wakeProtection.reason, 'unsupported');
  const failed = fixture({ blocker: { start() { throw new Error('private native failure'); }, stop() {}, isStarted: () => false } });
  failed.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  const status = await failed.host.attach(failed.coordinator);
  assert.equal(status.wakeProtection.reason, 'native_failure');
  assert.ok(status.diagnostics.includes('wake_protection_failed'));
  assert.equal(JSON.stringify(status).includes('private'), false);
  await unsupported.host.stop();
  await failed.host.stop();
});

test('configuration is strict, durable before activation, and rolls back on save failure', async () => {
  let finishSave;
  const f = fixture({ savePreference: () => new Promise(resolve => { finishSave = resolve; }) });
  f.host.initialize({});
  await f.host.attach(f.coordinator);
  assert.throws(() => f.host.configure({ wakeProtectionEnabled: 'yes' }));
  assert.throws(() => f.host.configure({ wakeProtectionEnabled: true, shell: 'unexpected' }));
  const saving = f.host.configure({ wakeProtectionEnabled: true });
  await Promise.resolve();
  assert.equal(f.ids.size, 0);
  finishSave();
  assert.equal((await saving).wakeProtection.active, true);
  await f.host.stop();
  const failed = fixture({ savePreference: async () => { throw new Error('disk full'); } });
  await failed.host.attach(failed.coordinator);
  await assert.rejects(failed.host.configure({ wakeProtectionEnabled: true }), /disk full/);
  assert.equal((await failed.host.status()).wakeProtection.enabled, false);
  assert.equal(failed.ids.size, 0);
  await failed.host.stop();
});

test('restart restores only saved preferences and reads existing coordinator without dispatch', async () => {
  const original = fixture();
  await original.host.attach(original.coordinator);
  await original.host.configure({ wakeProtectionEnabled: true });
  assert.ok(original.calls.some(call => call[0] === 'save' && call[1] === 'desktopAiHostKeepAwakeEnabled' && call[2]));
  await original.host.stop();
  const restarted = fixture();
  restarted.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  restarted.pause();
  assert.equal((await restarted.host.attach(restarted.coordinator)).wakeProtection.active, false);
  await restarted.host.stop();
});

test('sleep releases protection; wake rereads coordinator and records only power timestamps', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  await f.host.attach(f.coordinator);
  f.host.suspend();
  assert.equal(f.ids.size, 0);
  assert.equal((await f.host.status()).wakeProtection.reason, 'suspended');
  const resumed = await f.host.resume();
  assert.equal(resumed.wakeProtection.active, true);
  assert.deepEqual(resumed.power, { state: 'awake', lastSuspendAt: 123, lastResumeAt: 123 });
  await f.host.stop();
});

test('failed authoritative reads release team protection and never masquerade as pause', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  await f.host.attach(f.coordinator);
  f.coordinator.status = async () => { throw new Error('secret credential'); };
  const status = await f.host.status();
  assert.equal(status.coordinator.state, 'unavailable');
  assert.equal(status.coordinator.enabled, null);
  assert.equal(status.wakeProtection.active, false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  await f.host.stop();
});

test('stalled status is bounded, coalesced, and cannot reacquire after quit', async () => {
  const f = fixture({ statusTimeoutMs: 5 });
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  let finish;
  let reads = 0;
  f.coordinator.status = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const waiting = f.host.attach(f.coordinator);
  const results = await Promise.all([waiting, ...Array.from({ length: 20 }, () => f.host.status())]);
  assert.ok(results.every(result => result.coordinator.state === 'unavailable'));
  await f.host.status();
  assert.equal(reads, 1);
  await f.host.stop();
  finish({ config: { enabled: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ids.size, 0);
  assert.equal((await f.host.status()).coordinator.state, 'stopped');
});

test('non-Mac team configuration refuses without writing preferences', async () => {
  const f = fixture({ platform: 'linux' });
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  assert.equal((await f.host.attach(f.coordinator)).wakeProtection.supported, false);
  await assert.rejects(f.host.configure({ wakeProtectionEnabled: true }), /unavailable/);
  assert.equal(f.calls.length, 0);
  await f.host.stop();
});

test('native stop failure retains blocker ownership and retries cleanup without duplication', async () => {
  let starts = 0;
  let stops = 0;
  let running = false;
  const f = fixture({ blocker: {
    start() { starts++; running = true; return 7; },
    isStarted: () => running,
    stop() { if (++stops === 1) throw new Error('native stop failed'); running = false; },
  } });
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  await f.host.attach(f.coordinator);
  f.pause();
  assert.ok((await f.host.status()).diagnostics.includes('wake_protection_failed'));
  await f.host.configureGeneral(true);
  assert.equal(starts, 1);
  await f.host.stop();
  assert.equal(running, false);
  assert.equal(stops, 2);
});

test('stale reads from a detached coordinator cannot change its replacement', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  let finishOld;
  f.coordinator.status = () => new Promise(resolve => { finishOld = resolve; });
  const old = f.host.attach(f.coordinator);
  f.host.detach();
  const replacement = { status: async () => ({ config: { enabled: false } }) };
  await f.host.attach(replacement);
  finishOld({ config: { enabled: true } });
  await old;
  assert.equal((await f.host.status()).coordinator.state, 'paused');
  assert.equal(f.ids.size, 0);
  await f.host.stop();
});

test('trusted team demand hook protects direct work while Notion pickups are off', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: true });
  f.pause();
  const initial = await f.host.attach(f.coordinator);
  assert.equal(initial.wakeProtection.active, false);
  assert.equal(initial.teamWork.state, 'unavailable');
  const required = f.host.setTeamWork({ state: 'required' });
  assert.equal(required.coordinator.state, 'paused');
  assert.equal(required.wakeProtection.active, true);
  assert.equal(required.wakeProtection.source, 'team');
  f.host.setTeamWork({ state: 'required' });
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(f.host.setTeamWork({ state: 'idle' }).wakeProtection.active, false);
  f.host.setTeamWork({ state: 'required' });
  f.host.detach();
  assert.equal(f.ids.size, 0);
  assert.throws(() => f.host.setTeamWork({ state: 'running' }));
  assert.throws(() => f.host.setTeamWork({ state: 'required', dispatch: true }));
  await f.host.stop();
  assert.equal(f.host.setTeamWork({ state: 'required' }).wakeProtection.active, false);
});

test('direct team demand never overrides the saved wake opt-out', async () => {
  const f = fixture();
  f.host.initialize({ desktopAiHostKeepAwakeEnabled: false });
  assert.equal(f.host.setTeamWork({ state: 'required' }).wakeProtection.active, false);
  assert.equal(f.calls.length, 0);
  await f.host.stop();
});
