import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fetchQuota } from './xai.js';

let root;
let db;
let previousDb;
const save = (entry) => db.prepare('UPDATE credential SET value = ?').run(JSON.stringify({ type: 'oauth', methodID: 'device', ...entry }));

beforeEach(() => {
  previousDb = process.env.OPENCODE_DB;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-native-quota-'));
  process.env.OPENCODE_DB = path.join(root, 'fixture.db');
  db = new DatabaseSync(process.env.OPENCODE_DB);
  db.exec('CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)');
  db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run('xai', '{}', 1, 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  if (previousDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = previousDb;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('native xAI OAuth ownership', () => {
  it('reports an expired native credential without refreshing or rewriting it', async () => {
    save({ access: 'expired-access', refresh: 'fixture-refresh', expires: Date.now() - 1000 });
    const before = db.prepare('SELECT value FROM credential').get().value;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('managed by OpenCode');
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.prepare('SELECT value FROM credential').get().value).toBe(before);
  });

  it('does not exchange a refresh token when access is missing', async () => {
    save({ access: '', refresh: 'fixture-refresh' });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await fetchQuota()).error).toContain('managed by OpenCode');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads billing with a still-valid native token near expiry', async () => {
    save({ access: 'near-expiry', refresh: 'fixture-refresh', expires: Date.now() + 30000 });
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await fetchQuota();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer near-expiry');
  });

  it('picks up a token renewed by OpenCode on the next usage read', async () => {
    save({ access: 'old-access', refresh: 'fixture-refresh', expires: Date.now() - 1000 });
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await fetchQuota();
    save({ access: 'native-renewed', refresh: 'native-refresh', expires: Date.now() + 3600000 });
    await fetchQuota();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer native-renewed');
  });

  it('respects JWT expiry even when the stored expiry is later', async () => {
    const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 })).toString('base64url');
    save({ access: `header.${claims}.signature`, refresh: 'fixture-refresh', expires: Date.now() + 3600000 });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await fetchQuota()).error).toContain('managed by OpenCode');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
