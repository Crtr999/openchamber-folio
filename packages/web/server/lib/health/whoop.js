import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_URL = 'https://api.prod.whoop.com/developer/v2/';
const scopes = ['offline', 'read:recovery', 'read:cycles', 'read:sleep', 'read:workout'];
const configuration = z.object({ clientId: z.string().min(1).max(300), clientSecret: z.string().min(1).max(1000), redirectUri: z.url().refine(raw => {
  const url = new URL(raw);
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/health/whoop/callback'
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
}) }).strict();
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive() });
const metricScore = z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null(), z.record(z.string(), z.number())]));
const rowSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), cycle_id: z.number().optional(), start: z.string().optional(), end: z.string().optional(), created_at: z.string(), updated_at: z.string(), score_state: z.string(), score: metricScore.nullable().optional() }).refine(row => row.id !== undefined || row.cycle_id !== undefined);
const pageSchema = z.object({ records: z.array(rowSchema).max(100), next_token: z.string().nullable().optional() });

export function createWhoopConnection({ store, fetchImpl = fetch, now = Date.now, enterprise = isEnterpriseMode }) {
  let refreshing = null;
  let syncing = null;
  let callbackBusy = false;
  const guard = async () => {
    if (enterprise()) throw Object.assign(new Error('WHOOP connection is disabled in enterprise mode'), { statusCode: 403, code: 'enterprise_mode' });
    const state = await store.read();
    if (!state.approval?.enabled) throw new Error('Enable health sharing first');
    return state.whoop;
  };
  const exchange = async (saved, parameters) => {
    const response = await fetchImpl(TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: saved.clientId, client_secret: saved.clientSecret, ...parameters }) });
    if (!response.ok) throw new Error('WHOOP authorization failed; reconnect the account');
    const token = tokenSchema.parse(await response.json());
    const next = { ...saved, accessToken: token.access_token, refreshToken: token.refresh_token ?? saved.refreshToken, expiresAt: now() + token.expires_in * 1000 };
    delete next.state; delete next.stateExpires;
    await store.setWhoop(next, saved);
    return next;
  };
  const authorized = async () => {
    const saved = await guard();
    if (!saved?.accessToken) throw new Error('WHOOP needs authorization');
    if ((saved.expiresAt ?? 0) > now() + 60000) return saved;
    if (!saved.refreshToken) throw new Error('WHOOP needs authorization');
    refreshing ??= exchange(saved, { grant_type: 'refresh_token', refresh_token: saved.refreshToken }).finally(() => { refreshing = null; });
    return refreshing;
  };
  const synchronize = async () => {
    const saved = await authorized();
    const records = [];
    for (const resource of ['cycle', 'recovery', 'activity/sleep', 'activity/workout']) {
      const seen = new Set();
      let next;
      do {
        const url = new URL(API_URL + resource);
        url.searchParams.set('limit', '25');
        url.searchParams.set('start', new Date(now() - 90 * 86400000).toISOString());
        if (next) url.searchParams.set('nextToken', next);
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${saved.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('WHOOP synchronization failed; previously saved data is unchanged');
        const page = pageSchema.parse(await response.json());
        for (const row of page.records) {
          if (row.score_state !== 'SCORED' || !row.score) continue;
          const score = row.score;
          const fields = resource === 'recovery' ? [['recovery_score', '%'], ['resting_heart_rate', 'count/min'], ['hrv_rmssd_milli', 'ms']]
            : resource === 'activity/sleep' ? [['sleep_performance_percentage', '%'], ['sleep_efficiency_percentage', '%']]
            : [['strain', 'WHOOP strain'], ['kilojoule', 'kJ'], ['average_heart_rate', 'count/min']];
          for (const [metric, unit] of fields) {
            const value = z.number().finite().safeParse(score[metric]);
            if (!value.success) continue;
            records.push({ kind: 'metric', source: 'whoop', sourceId: `${resource}:${row.id ?? row.cycle_id}:${metric}`, start: row.start ?? row.created_at, end: row.end ?? row.start ?? row.created_at, updated: row.updated_at, label: `WHOOP ${resource}`, metric: `whoop:${metric}`, unit, value: value.data });
          }
          if (resource === 'activity/sleep') {
            const stages = z.record(z.string(), z.number().finite()).safeParse(score.stage_summary);
            if (stages.success) for (const stage of ['total_light_sleep_time_milli', 'total_slow_wave_sleep_time_milli', 'total_rem_sleep_time_milli']) {
              if (stages.data[stage] === undefined) continue;
              records.push({ kind: 'metric', source: 'whoop', sourceId: `sleep:${row.id}:${stage}`, start: row.start ?? row.created_at, end: row.end ?? row.created_at, updated: row.updated_at, label: 'WHOOP sleep', metric: `whoop:${stage}`, unit: 'min', value: stages.data[stage] / 60000 });
            }
          }
        }
        if (records.length > 5000) throw new Error('WHOOP history is too large for one sync');
        next = page.next_token;
        if (next && seen.has(next)) throw new Error('WHOOP returned a repeated page');
        if (next) seen.add(next);
      } while (next);
    }
    await guard();
    const state = await store.ingest({ records }, { whoopAccessToken: saved.accessToken, syncedSource: 'whoop' });
    return { imported: records.length, count: state.records.length, synced: state.synced };
  };
  return {
    connect: async input => {
      await guard();
      const saved = { ...configuration.parse(input), state: randomBytes(6).toString('base64url'), stateExpires: now() + 600000 };
      await store.setWhoop(saved);
      const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
      for (const [name, value] of Object.entries({ client_id: saved.clientId, redirect_uri: saved.redirectUri, response_type: 'code', scope: scopes.join(' '), state: saved.state })) url.searchParams.set(name, value);
      return { url: url.href };
    },
    callback: async (state, code) => {
      if (callbackBusy) throw new Error('WHOOP authorization is already completing');
      callbackBusy = true;
      try {
      const saved = await guard();
      if (!saved?.state || !state || saved.state.length !== state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(saved.state)) || (saved.stateExpires ?? 0) < now() || !code) throw new Error('WHOOP authorization expired or does not match');
      const consumed = { ...saved }; delete consumed.state; delete consumed.stateExpires;
      await store.setWhoop(consumed, saved);
      await exchange(consumed, { grant_type: 'authorization_code', code, redirect_uri: saved.redirectUri });
      return { ok: true };
      } finally { callbackBusy = false; }
    },
    sync: () => { syncing ??= synchronize().finally(() => { syncing = null; }); return syncing; },
    disconnect: async () => { await store.setWhoop(null); return { ok: true }; },
  };
}

const connections = new WeakMap();
export function getWhoopConnection(store) {
  if (!connections.has(store)) connections.set(store, createWhoopConnection({ store }));
  return connections.get(store);
}
export async function queryHealthEvidence(store, input) {
  const state = await store.read();
  if (!state.approval?.enabled) throw new Error('Health sharing is not enabled');
  const sourceErrors = [];
  if (state.whoop?.accessToken && Date.now() - Date.parse(state.synced.whoop || '1970-01-01') > 15 * 60000) {
    try { await getWhoopConnection(store).sync(); }
    catch { sourceErrors.push('WHOOP could not refresh. Saved records may be stale; check their source dates.'); }
  }
  return { ...await store.query(input), sourceErrors };
}
