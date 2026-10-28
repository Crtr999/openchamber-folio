import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeOutlook } from './personal-outlook-native.mjs';

const identity = { id: 'exchangeAccounts:1', address: 'synthetic@example.com' };

test('non-macOS and missing Outlook are explicitly unsupported without launching automation', async () => {
  let runs = 0;
  for (const options of [{ platform: 'linux', installed: async () => true }, { platform: 'darwin', installed: async () => false }]) {
    const native = createNativeOutlook({ ...options, isBlocked: () => false, run: async () => { runs++; } });
    assert.equal(await native.available(), false);
    assert.equal((await native.connect()).access, 'unsupported');
    assert.equal((await native.probe()).reason, 'not-installed');
  }
  assert.equal(runs, 0);
});

test('only explicit connect permits a prompt; probe and reads use separate non-prompting operations', async () => {
  const calls = [];
  const native = createNativeOutlook({ platform: 'darwin', installed: async () => true, isBlocked: () => false, now: () => 1000,
    run: async (input) => { calls.push(input); return { access: 'connected', accounts: [identity], health: input.accounts.map(({ address }) => ({ address, status: 'partial' })), records: [] }; } });
  await native.probe();
  await native.connect();
  await native.read([identity]);
  assert.deepEqual(calls.map(({ op }) => op), ['probe', 'connect', 'read']);
  assert.deepEqual(calls[2].accounts, [identity]);
  assert.equal(calls[2].now, 1000);
  await assert.rejects(native.read(Array(6).fill(identity)));
  assert.equal(calls.length, 3);
});

test('permission denial, absent identities and unsupported dictionary stay distinct from connection success', async () => {
  for (const value of [{ access: 'not-connected', reason: 'permission' }, { access: 'unsupported', reason: 'accounts-unavailable' }, { access: 'error', reason: 'scripting-error' }]) {
    const native = createNativeOutlook({ platform: 'darwin', installed: async () => true, isBlocked: () => false, run: async () => value });
    const result = await native.connect();
    assert.equal(result.access, value.access);
    assert.equal(result.reason, value.reason);
    assert.deepEqual(result.records, []);
  }
});

test('enterprise mode gates native automation at use time and discards responses if policy changes', async () => {
  let blocked = true;
  let runs = 0;
  const native = createNativeOutlook({ platform: 'darwin', installed: async () => true, isBlocked: () => blocked,
    run: async () => { runs++; blocked = true; return { access: 'connected', accounts: [identity] }; } });
  await assert.rejects(native.connect(), /enterprise/);
  assert.equal(runs, 0);
  blocked = false;
  await assert.rejects(native.read([identity]), /enterprise/);
  assert.equal(runs, 1);
});

test('native process output is parsed and bounded before it can enter personal review', async () => {
  const native = createNativeOutlook({ platform: 'darwin', installed: async () => true, isBlocked: () => false,
    run: async () => ({ access: 'connected', accounts: [identity], records: [{ id: 'id', title: 'title', text: 'x'.repeat(6001), truncated: true }] }) });
  await assert.rejects(native.read([identity]));
});
