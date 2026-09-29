import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenRouterCredits, fetchBalance, formatBalance, readOpencodeOpenRouterKey } from './openrouter-credits.mjs';

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

test('account keys show the balance; other keys fall back to their limit or spending', async () => {
  const account = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(200, { data: { total_credits: 25, total_usage: 6.97 } }) : reply(500, {})));
  assert.equal(account.kind, 'account'); assert.equal(formatBalance(account), '$18.03');
  const limited = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(403, {}) : reply(200, { data: { usage: 2, limit: 10, limit_remaining: 8 } })));
  assert.equal(limited.kind, 'limit'); assert.equal(limited.amount, 8);
  const spent = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(401, {}) : reply(200, { data: { usage: 3.2, limit: null, limit_remaining: null } })));
  assert.equal(formatBalance(spent), '$3.20 used');
  await assert.rejects(fetchBalance('bad', async () => reply(401, {})), /did not accept/);
});

test('OpenCode’s OpenRouter key is used when none was pasted, and never written to disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-'));
  const filePath = path.join(dir, 'openrouter-credits.json');
  const seen = [];
  const credits = createOpenRouterCredits({
    filePath, safeStorage: fakeSafeStorage, createTray: () => fakeTray().tray, openExternal: () => {},
    fallbackKey: () => 'sk-or-opencode',
    fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return reply(200, { data: { total_credits: 20, total_usage: 1.97 } }); },
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
    fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return reply(200, { data: { total_credits: 10, total_usage: 0 } }); },
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
