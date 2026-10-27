import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHealthStore, getHealthStore } from './store.js';
import { createHealthActions } from './actions.js';
import { createWhoopConnection } from './whoop.js';

const metric = (sourceId, value = 10) => ({ kind: 'metric', source: 'apple-health', sourceId, start: '2026-10-20T00:00:00Z', end: '2026-10-21T00:00:00Z', metric: 'active-energy', value, unit: 'kcal' });
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-health-'));
  try { await run(createHealthStore(path.join(root, 'health')), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
describe('private health storage', () => {
  it('requires explicit approval, encrypts records, and survives reopening', () => fixture(async (store, root) => {
    await expect(store.ingest({ records: [metric('one')] })).rejects.toThrow('not enabled');
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    await store.ingest({ records: [metric('private-source')] });
    const encrypted = await fs.readFile(path.join(root, 'health', 'records.enc'), 'utf8');
    expect(encrypted).not.toContain('private-source');
    const reopened = createHealthStore(path.join(root, 'health'));
    expect((await reopened.query({})).records[0]).toMatchObject({ sourceId: 'private-source', value: 10, unit: 'kcal' });
    expect((await fs.stat(path.join(root, 'health', 'key'))).mode & 0o777).toBe(0o600);
    await store.approve({ enabled: false, directory: '/Health', providerID: 'openai' });
    await expect(reopened.query({})).rejects.toThrow('not enabled');
  }));
  it('deduplicates by source identity, rejects stale updates, and keeps sources separate', () => fixture(async store => {
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    await Promise.all([store.ingest({ records: [metric('a')] }), store.ingest({ records: [metric('b', 20)] })]);
    await store.ingest({ records: [{ ...metric('a', 30), updated: '2026-10-22T00:00:00Z' }] });
    await store.ingest({ records: [metric('a', 5), { ...metric('a', 40), source: 'whoop' }] });
    const result = await store.query({});
    expect(result.total).toBe(3);
    expect(result.records.find(row => row.source === 'apple-health' && row.sourceId === 'a').value).toBe(30);
    expect((await store.query({ limit: 1 })).truncated).toBe(true);
    expect(() => store.ingest({ records: [{ ...metric('broken'), value: 'invented' }] })).toThrow();
    expect((await store.query({})).total).toBe(3);
  }));
  it('fails closed on corrupt storage or missing encryption keys', () => fixture(async (store, root) => {
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    await store.ingest({ records: [metric('a')] });
    await fs.unlink(path.join(root, 'health', 'key'));
    await expect(store.read()).rejects.toThrow('missing');
    await expect(fs.access(path.join(root, 'health', 'key'))).rejects.toThrow();
  }));
  it('requires the approved provider, directory and a real session for model queries', () => fixture(async (_unused, root) => {
    const store = getHealthStore(root);
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    await store.ingest({ records: [metric('a')] });
    let session = { model: { providerID: 'openai' }, location: { directory: '/Health' } };
    const actions = createHealthActions({ dataDir: root, readSession: async () => session });
    await expect(actions.execute('health.query', {}, '/Other', { contextSessionId: 's' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.execute('health.query', {}, '/Health', {})).rejects.toMatchObject({ statusCode: 403 });
    session = { ...session, model: { providerID: 'other' } };
    await expect(actions.execute('health.query', {}, '/Health', { contextSessionId: 's' })).rejects.toMatchObject({ statusCode: 403 });
    session = { ...session, model: { providerID: 'openai' } };
    expect((await actions.execute('health.query', {}, '/Health', { contextSessionId: 's' })).total).toBe(1);
  }));
  it('checks OAuth state, persists tokens encrypted, refreshes once, and obeys enterprise policy', () => fixture(async store => {
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    let tokens = 0;
    let now = Date.now();
    const whoop = createWhoopConnection({ store, now: () => now, enterprise: () => false, fetchImpl: async url => {
      if (String(url).includes('/oauth2/token')) { tokens++; return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }); }
      return Response.json({ records: [] });
    } });
    const { url } = await whoop.connect({ clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'http://127.0.0.1:8000/api/health/whoop/callback' });
    await expect(whoop.callback('badstate', 'code')).rejects.toThrow();
    await whoop.callback(new URL(url).searchParams.get('state'), 'code');
    expect(tokens).toBe(1);
    await expect(whoop.callback(new URL(url).searchParams.get('state'), 'code')).rejects.toThrow();
    now += 3600000;
    await Promise.all([whoop.sync(), whoop.sync()]);
    expect(tokens).toBe(2);
    await whoop.disconnect();
    await expect(whoop.sync()).rejects.toThrow('needs authorization');
    const blocked = createWhoopConnection({ store, enterprise: () => true });
    await expect(blocked.connect({})).rejects.toThrow('enterprise');
  }));
  it('does not restore authorization after disconnect during a token exchange', () => fixture(async store => {
    await store.approve({ enabled: true, directory: '/Health', providerID: 'openai' });
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const whoop = createWhoopConnection({ store, enterprise: () => false, fetchImpl: async () => {
      started(); await pending;
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    } });
    const { url } = await whoop.connect({ clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'http://127.0.0.1:8000/api/health/whoop/callback' });
    const completing = whoop.callback(new URL(url).searchParams.get('state'), 'code');
    const checked = expect(completing).rejects.toThrow('authorization changed');
    await entered;
    await whoop.disconnect();
    release();
    await checked;
    expect((await store.read()).whoop).toBeNull();
  }));

});
