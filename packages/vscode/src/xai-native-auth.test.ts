import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fetchQuotaForProvider } from './quotaProviders';

let root = '';
let db: DatabaseSync;
let previousDb: string | undefined;
const save = (access: string, expires: number) => db.prepare('UPDATE credential SET value = ?').run(JSON.stringify({ type: 'oauth', methodID: 'device', access, refresh: 'fixture-refresh', expires }));

beforeEach(() => {
  previousDb = process.env.OPENCODE_DB;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-native-vscode-'));
  process.env.OPENCODE_DB = path.join(root, 'fixture.db');
  db = new DatabaseSync(process.env.OPENCODE_DB);
  db.exec('CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)');
  db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run('xai', '{}', 1, 1);
});

afterEach(() => {
  mock.restoreAll();
  db.close();
  if (previousDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = previousDb;
  fs.rmSync(root, { recursive: true, force: true });
});

test('VS Code quota never refreshes or rewrites an expired native xAI credential', async () => {
  save('expired-access', Date.now() - 1000);
  const before = db.prepare('SELECT value FROM credential').get();
  const fetcher = mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const result = await fetchQuotaForProvider('xai');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /managed by OpenCode/);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.deepEqual(db.prepare('SELECT value FROM credential').get(), before);
});

test('VS Code quota reads the token renewed by OpenCode without an OAuth request', async () => {
  save('expired-access', Date.now() - 1000);
  const requests: { url: string; authorization: string | null }[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
    return new Response('', { status: 503 });
  });
  await fetchQuotaForProvider('xai');
  save('native-renewed', Date.now() + 30000);
  await fetchQuotaForProvider('xai');
  assert.deepEqual(requests, [{ url: 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', authorization: 'Bearer native-renewed' }]);
});
