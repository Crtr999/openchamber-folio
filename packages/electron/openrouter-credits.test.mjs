import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenRouterCredits, fetchBalance, formatBalance, readOpencodeOpenRouterKey, isOfficialOpenRouterBillingConnection, isOpenRouterCreditsAuthorized } from './openrouter-credits.mjs';

const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
};
const fakeTray = () => {
  const calls = { title: '', destroyed: false };
  return { calls, tray: { setTitle: (t) => { calls.title = t; }, setToolTip: () => {}, setMenu: () => {}, destroy: () => { calls.destroyed = true; } } };
};

test('account keys show remaining credits; inference keys show only a remaining limit', async () => {
  const account = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(200, { data: { total_credits: 25, total_usage: 6.97 } }) : reply(200, { data: { is_management_key: true } })));
  assert.equal(account.kind, 'account'); assert.equal(formatBalance(account), '$18.03');
  const limited = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(403, {}) : reply(200, { data: { usage: 2, limit: 10, limit_remaining: 8 } })));
  assert.equal(limited.kind, 'limit'); assert.equal(limited.amount, 8);
  await assert.rejects(fetchBalance('k', async () => reply(200, { data: { usage: 3.2, limit: null, limit_remaining: null } })), /management key/);
  assert.equal(formatBalance({ kind: 'spent', amount: 3.2 }), 'Balance unavailable', 'even legacy spending cannot become a counter');
  await assert.rejects(fetchBalance('bad', async () => reply(401, {})), /did not accept/);
});

test('OpenCode’s OpenRouter key is used when none was pasted, and never written to disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  const filePath = path.join(dir, 'openrouter-credits.json');
  const seen = [];
  const credits = createOpenRouterCredits({
    filePath, safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray, openExternal: () => {},
    fallbackKey: () => 'sk-or-opencode',
    canUseOpencodeKey: async () => true,
    fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return reply(200, { data: { limit_remaining: 18.03, is_management_key: false } }); },
  });
  const status = await credits.refresh();
  assert.equal(status.source, 'opencode');
  assert.equal(status.balance.amount.toFixed(2), '18.03');
  assert.deepEqual(seen, ['Bearer sk-or-opencode']);
  assert.throws(() => readFileSync(filePath, 'utf8'));
  credits.stop();
});

test('a pasted key wins over OpenCode’s, is stored encrypted, and the menu bar item is opt-in', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  const filePath = path.join(dir, 'openrouter-credits.json');
  const { calls, tray } = fakeTray();
  let created = 0;
  const seen = [];
  const credits = createOpenRouterCredits({
    filePath, safeStorage: fakeSafeStorage, createTray: () => { created += 1; return tray; }, openExternal: () => {},
    fallbackKey: () => 'sk-or-opencode',
    canUseOpencodeKey: async () => true,
    fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return reply(200, { data: { limit_remaining: 10, is_management_key: false } }); },
  });
  const saved = await credits.setKey(' sk-or-mine ');
  assert.equal(saved.source, 'saved');
  assert.equal(created, 0, 'no menu bar item until asked');
  assert.ok(!readFileSync(filePath, 'utf8').includes('sk-or-mine'));
  await credits.refresh();
  assert.equal(seen.at(-1), 'Bearer sk-or-mine');
  credits.setMenuBar(true);
  assert.equal(calls.title, '$10.00');
  const cleared = await credits.clear();
  assert.equal(cleared.source, 'opencode');
  assert.equal(calls.destroyed, true);
  credits.stop();
});

test('reads the OpenRouter key from OpenCode’s auth.json, else OPENROUTER_API_KEY', () => {
  const env = { XDG_DATA_HOME: '/data' };
  assert.equal(readOpencodeOpenRouterKey(env, (file) => { assert.equal(file, path.join('/data', 'opencode', 'auth.json')); return JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-1' } }); }), 'sk-or-1');
  assert.equal(readOpencodeOpenRouterKey({ ...env, OPENROUTER_API_KEY: 'sk-env' }, () => { throw new Error('missing'); }), 'sk-env');
  assert.equal(readOpencodeOpenRouterKey(env, () => JSON.stringify({ anthropic: { key: 'x' } })), '');
});

test('inference keys never query management credits and missing data never becomes zero', async () => {
  const urls = [];
  await assert.rejects(fetchBalance('synthetic', async (url, init) => {
    urls.push(url); assert.equal(init.redirect, 'error');
    return reply(200, { data: { is_management_key: false, usage: 4 } });
  }), /remaining balance/);
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/key']);
  await assert.rejects(fetchBalance('synthetic', async () => reply(200, { data: {} })), /did not return/);
});

test('unrestricted inference keys cannot produce a header balance or a used menu bar counter', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  let created = 0;
  const credits = createOpenRouterCredits({
    filePath: path.join(dir, 'settings.json'), safeStorage: fakeSafeStorage,
    createTray: () => { created += 1; return fakeTray().tray; }, openExternal: () => {},
    fallbackKey: () => 'synthetic', canUseOpencodeKey: async () => true,
    fetchImpl: async () => reply(200, { data: { is_management_key: false, usage: 7.48, limit_remaining: null } }),
  });
  credits.setMenuBar(true);
  const result = await credits.refresh();
  assert.equal(result.balance, undefined); assert.ok(result.error);
  assert.equal(created, 0);
  await assert.rejects(credits.setKey('synthetic-unrestricted'), /management key/);
  assert.equal(credits.status().source, 'opencode', 'invalid balance key must not replace the provider connection');
  credits.stop();
});

test('saved encrypted management keys survive recreation and keep account balance stale on failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  const filePath = path.join(dir, 'settings.json');
  const { calls, tray } = fakeTray();
  let fail = false;
  const options = {
    filePath, safeStorage: fakeSafeStorage, createTray: () => tray, openExternal: () => {},
    fallbackKey: () => 'synthetic-inference',
    canUseOpencodeKey: async () => { throw new Error('saved keys do not use the provider fallback'); },
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer synthetic-management');
      if (fail) throw new Error('unavailable');
      return url.endsWith('/key') ? reply(200, { data: { is_management_key: true } }) : reply(200, { data: { total_credits: 25, total_usage: 6.97 } });
    },
  };
  const first = createOpenRouterCredits(options);
  await first.setKey('synthetic-management'); first.stop();
  const restored = createOpenRouterCredits(options);
  const result = await restored.refresh();
  assert.equal(result.source, 'saved'); assert.equal(result.balance.kind, 'account');
  assert.equal(formatBalance(result.balance), '$18.03');
  restored.setMenuBar(true); await restored.refresh();
  fail = true;
  const stale = await restored.refresh();
  assert.equal(stale.balance.kind, 'account'); assert.equal(formatBalance(stale.balance), '$18.03');
  assert.match(calls.title, /^\$18\.03 · stale$/); assert.ok(stale.error);
  restored.stop();
});

test('current database credentials replace legacy credentials including removed accounts', () => {
  const env = { XDG_DATA_HOME: '/synthetic' };
  const legacy = () => { throw new Error('legacy must not be read'); };
  assert.equal(readOpencodeOpenRouterKey(env, legacy, () => ({ openrouter: { key: 'current' } })), 'current');
  assert.equal(readOpencodeOpenRouterKey(env, legacy, () => ({})), '');
});

test('concurrent refreshes coalesce and failure preserves the previous value without logging secrets', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  let finish;
  let calls = 0;
  let fail = false;
  const logs = [];
  const credits = createOpenRouterCredits({
    filePath: path.join(dir, 'settings.json'), safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray,
    openExternal: () => {}, fallbackKey: () => 'synthetic-secret', log: value => logs.push(value),
    canUseOpencodeKey: async () => true,
    fetchImpl: async () => {
      calls += 1;
      if (fail) throw new Error('synthetic-secret');
      await new Promise(resolve => { finish = resolve; });
      return reply(200, { data: { limit_remaining: 7 } });
    },
  });
  const first = credits.refresh(); const second = credits.refresh();
  await Promise.resolve();
  assert.equal(calls, 1); finish(); await Promise.all([first, second]);
  fail = true;
  const stale = await credits.refresh();
  assert.equal(stale.balance.amount, 7); assert.ok(stale.error);
  assert.ok(!JSON.stringify(logs).includes('synthetic-secret'));
  credits.stop();
});

test('account changes and enterprise policy cannot publish old balances or send credentials', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  let key = 'first'; let finish; let blocked = false; let calls = 0;
  const credits = createOpenRouterCredits({
    filePath: path.join(dir, 'settings.json'), safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray,
    openExternal: () => {}, fallbackKey: () => key, isBlocked: () => blocked,
    canUseOpencodeKey: async () => true,
    fetchImpl: async () => { calls += 1; await new Promise(resolve => { finish = resolve; }); return reply(200, { data: { limit_remaining: 9 } }); },
  });
  const first = credits.refresh(); await Promise.resolve(); key = 'second';
  assert.equal(credits.status().balance, undefined); finish(); await first;
  assert.equal(credits.status().balance, undefined);
  blocked = true; await credits.refresh(); assert.equal(calls, 1);
  await assert.rejects(credits.setKey('third'), /organization policy/);
  credits.stop();
});

test('gateway overrides cannot send the OpenCode credential to official OpenRouter billing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  let calls = 0;
  const credits = createOpenRouterCredits({
    filePath: path.join(dir, 'settings.json'), safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray,
    openExternal: () => {}, fallbackKey: () => 'synthetic-gateway-secret', canUseOpencodeKey: async () => false,
    fetchImpl: async () => { calls += 1; throw new Error('must not send'); },
  });
  const result = await credits.refresh();
  assert.equal(calls, 0); assert.equal(result.balance, undefined); assert.ok(result.error);
  credits.stop();
});

test('without a mounted header or opt-in menu bar there is no native polling', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  let calls = 0;
  const credits = createOpenRouterCredits({
    filePath: path.join(dir, 'settings.json'), safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray,
    openExternal: () => {}, fallbackKey: () => 'synthetic',
    fetchImpl: async () => { calls += 1; return reply(200, { data: { usage: 1 } }); },
  });
  credits.start(); await Promise.resolve(); assert.equal(calls, 0); credits.stop();
});

test('only the official native OpenRouter destination can use its OpenCode credential', async () => {
  const official = { id: 'openrouter', package: '@opencode/ai/providers/openrouter', activation: 'auto' };
  const allowed = providers => isOfficialOpenRouterBillingConnection({ getClient: () => ({ provider: { list: async () => ({ data: providers }) } }) });
  for (const baseURL of [undefined, 'https://openrouter.ai', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/']) {
    assert.equal(await allowed([{ ...official, settings: { baseURL } }]), true);
  }
  for (const baseURL of [null, '', '{env:ENDPOINT}', 'https://gateway.example.test/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai.evil.test/api/v1', 'https://user:synthetic@openrouter.ai/api/v1', 'https://openrouter.ai/api/v1?key=synthetic', 'https://openrouter.ai/api/v1#fragment', 'https://openrouter.ai:8443/api/v1']) {
    assert.equal(await allowed([{ ...official, settings: { baseURL } }]), false);
  }
  for (const providers of [[], [official, official], [{ ...official, activation: 'disabled' }], [{ ...official, package: '@opencode/ai/providers/openai' }]]) {
    assert.equal(await allowed(providers), false);
  }
  assert.equal(await isOfficialOpenRouterBillingConnection({ getClient: () => null }), false);
  assert.equal(await isOfficialOpenRouterBillingConnection({ getClient: () => ({ provider: { list: async () => { throw new Error('offline'); } } }) }), false);
});

test('credits IPC belongs only to the trusted local main frame', () => {
  const mainFrame = { url: 'openchamber-ui://app/index.html' };
  const webContents = { mainFrame, isDestroyed: () => false };
  const owner = { webContents, isDestroyed: () => false };
  const context = { owner, localOrigin: 'openchamber-ui://app', localRuntime: true };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(isOpenRouterCreditsAuthorized(event, context), true);
  assert.equal(isOpenRouterCreditsAuthorized(event, { ...context, localRuntime: false }), false);
  assert.equal(isOpenRouterCreditsAuthorized(event, { ...context, owner: null }), false);
  assert.equal(isOpenRouterCreditsAuthorized({ ...event, senderFrame: { ...mainFrame } }, context), false);
  assert.equal(isOpenRouterCreditsAuthorized({ ...event, sender: { ...webContents } }, context), false);
  mainFrame.url = 'https://example.test/';
  assert.equal(isOpenRouterCreditsAuthorized(event, context), false);
});
