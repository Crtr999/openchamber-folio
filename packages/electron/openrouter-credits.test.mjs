import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenRouterCredits, fetchBalance, formatBalance } from './openrouter-credits.mjs';

const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });

test('management keys show the account balance; regular keys fall back to their limit or spending', async () => {
  const account = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(200, { data: { total_credits: 25, total_usage: 5.16 } }) : reply(500, {})));
  assert.equal(account.kind, 'account'); assert.equal(formatBalance(account), '$19.84');
  const limited = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(403, {}) : reply(200, { data: { usage: 2, limit: 10, limit_remaining: 8 } })));
  assert.equal(limited.kind, 'limit'); assert.equal(limited.amount, 8);
  const spent = await fetchBalance('k', async (url) => (url.endsWith('/credits') ? reply(401, {}) : reply(200, { data: { usage: 3.2, limit: null, limit_remaining: null } })));
  assert.equal(formatBalance(spent), '$3.20 used');
  await assert.rejects(fetchBalance('bad', async () => reply(401, {})), /did not accept/);
});

test('the key is stored encrypted, the menu bar item follows the balance, and removing clears both', async () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'or-credits-')), 'c.json');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().slice(4) };
  const titles = [];
  let destroyed = 0;
  const credits = createOpenRouterCredits({
    filePath, safeStorage, openExternal: () => {},
    createTray: () => ({ setTitle: (s) => titles.push(s), setToolTip: () => {}, setMenu: () => {}, destroy: () => { destroyed += 1; } }),
    fetchImpl: async (url) => (url.endsWith('/credits') ? reply(200, { data: { total_credits: 20, total_usage: 0 } }) : reply(500, {})),
  });
  const status = await credits.setKey('sk-or-v1-secret');
  assert.equal(status.balance.amount, 20);
  assert.ok(!readFileSync(filePath, 'utf8').includes('sk-or-v1-secret'));
  assert.deepEqual(titles, ['$20.00']);
  credits.setMenuBar(false);
  assert.equal(destroyed, 1);
  credits.clear();
  assert.equal(credits.status().configured, false);
  credits.stop();
});
