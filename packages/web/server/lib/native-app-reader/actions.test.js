import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeAppActions } from './actions.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const query = { app: 'calendar', containerId: 'fixture-calendar', start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z', limit: 10, requestedByUser: true };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-reader-test-'))); roots.push(root);
  const directory = path.join(root, 'General'); await mkdir(directory);
  const session = { directory, model: { providerID: 'fixture-provider' } };
  const calls = [];
  const reader = { runtimeId: 'fixture-runtime', status: () => ({ status: 'available', permissions: 'not-checked' }), read: async (input) => { calls.push(input); return { status: 'ok', items: [], truncated: false }; } };
  const binding = { value: 'a'.repeat(64) };
  const runtime = { endpoint: 'http://127.0.0.1:4096' };
  const grant = { directory, providerID: 'fixture-provider', providerBinding: binding.value, runtimeId: reader.runtimeId, runtimeEndpoint: runtime.endpoint, app: 'calendar', containerIds: ['fixture-calendar'] };
  const save = (grants) => writeFile(path.join(root, 'native-app-read-grants.json'), JSON.stringify({ version: 1, grants }));
  await save([grant]);
  const actions = createNativeAppActions({ dataDir: root, readSession: async () => session, getReader: () => reader, getRuntimeIdentity: () => runtime.endpoint, resolveBinding: async () => binding.value });
  const read = (input = query, scope = directory, options = { contextSessionId: 'synthetic-session' }) => actions.execute('native.read', input, scope, options);
  return { root, directory, session, grant, save, calls, actions, read, reader, binding, runtime };
}
describe('native app read authorization', () => {
  it('reads only an exact approved directory/provider/container and strips caller scope', async () => {
    const f = await fixture();
    expect(await f.read({ ...query, directory: '/Legal', op: 'save', script: 'activate' })).toEqual({ status: 'ok', items: [], truncated: false });
    expect(f.calls).toEqual([{ app: 'calendar', containerId: query.containerId, start: query.start, end: query.end, limit: 10 }]);
  });
  it.each([
    { requestedByUser: false }, { requestedByUser: undefined }, { app: 'finder' },
    { start: '2026-11-18T00:00:00Z' }, { end: '2027-01-01T00:00:00Z' },
    { limit: 101 }, { limit: 0 }, { containerId: '' }, { start: '2026-11-16' },
  ])('rejects invalid or unrequested read %j before native execution', async (patch) => {
    const f = await fixture(); await expect(f.read({ ...query, ...patch })).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it('denies absent, corrupt and mismatched grants', async () => {
    const f = await fixture();
    for (const grants of [[], [{ ...f.grant, containerIds: ['*'] }], [{ ...f.grant, providerID: 'another' }], [{ ...f.grant, directory: f.root }]]) {
      await f.save(grants); await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    }
    await writeFile(path.join(f.root, 'native-app-read-grants.json'), '{broken');
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    await rm(path.join(f.root, 'native-app-read-grants.json'));
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it('requires authoritative session directory and provider, not supplied parameters', async () => {
    const f = await fixture();
    await expect(f.read(query, f.directory, {})).rejects.toMatchObject({ statusCode: 403 });
    f.session.directory = f.root;
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    f.session.directory = f.directory; f.session.model.providerID = 'another';
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it.each(['Legal', 'ZDR'])('denies %s even with a grant and through a symlink', async (name) => {
    const f = await fixture(); const blocked = path.join(f.root, name); await mkdir(blocked);
    const alias = path.join(f.root, 'alias'); await symlink(blocked, alias);
    f.session.directory = alias; await f.save([{ ...f.grant, directory: alias }]);
    await expect(f.read(query, alias)).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it('denies the ZDR provider even outside a named ZDR folder', async () => {
    const f = await fixture(); f.session.model.providerID = 'openrouter-zdr';
    await f.save([{ ...f.grant, providerID: 'openrouter-zdr' }]);
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it('reports unsupported Notes/Mail without launching a connector', async () => {
    const f = await fixture();
    for (const app of ['notes', 'mail']) {
      await f.save([{ ...f.grant, app }]); expect(await f.read({ ...query, app })).toMatchObject({ status: 'unsupported', app });
    }
    expect(f.calls).toEqual([]);
  });
  it('reports status without reading sessions or content', async () => {
    const actions = createNativeAppActions({ dataDir: '/unused', readSession: () => { throw new Error('must not read'); }, getReader: () => null });
    expect(await actions.execute('native.status', {})).toMatchObject({ status: 'unsupported' });
  });
  it('invalidates grants on endpoint/provider configuration or host runtime changes', async () => {
    const f = await fixture(); f.binding.value = 'b'.repeat(64);
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    f.binding.value = f.grant.providerBinding; f.runtime.endpoint = 'http://127.0.0.1:4097';
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    f.runtime.endpoint = f.grant.runtimeEndpoint; f.reader.runtimeId = 'restarted-runtime';
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it('creates approval only after a native user click, then allows reads and explicit revocation', async () => {
    const f = await fixture(); await f.save([]);
    let decision = 'cancelled'; const scopes = [];
    f.reader.requestApproval = async (scope) => { scopes.push(scope); return { decision }; };
    const approve = () => f.actions.execute('native.requestApproval', query, f.directory, { contextSessionId: 'synthetic-session' });
    expect(await approve()).toEqual({ status: 'cancelled' });
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
    decision = 'approved'; expect(await approve()).toMatchObject({ status: 'approved' });
    expect(await f.read()).toMatchObject({ status: 'ok' });
    expect(scopes[0]).toEqual({ directory: f.directory, providerID: 'fixture-provider', providerBinding: f.binding.value, runtimeId: 'fixture-runtime', runtimeEndpoint: f.runtime.endpoint, app: 'calendar', containerId: query.containerId, purpose: 'grant' });
    decision = 'revoked'; expect(await approve()).toMatchObject({ status: 'revoked' });
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
  });
  it('refuses a stale approval after provider or directory changes while the dialog is open', async () => {
    const f = await fixture(); await f.save([]);
    f.reader.requestApproval = async () => { f.binding.value = 'b'.repeat(64); return { decision: 'approved' }; };
    await expect(f.actions.execute('native.requestApproval', query, f.directory, { contextSessionId: 'synthetic-session' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not expose an approval fallback on hosts without a native dialog', async () => {
    const f = await fixture(); await f.save([]);
    expect(await f.actions.execute('native.requestApproval', query, f.directory, { contextSessionId: 'synthetic-session' })).toMatchObject({ status: 'unsupported' });
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
  });
  it('permits container metadata only after a local user click and never persists a content grant', async () => {
    const f = await fixture(); await f.save([]); let listings = 0; let decision = 'cancelled';
    f.reader.requestApproval = async (scope) => { expect(scope.purpose).toBe('containers'); return { decision }; };
    f.reader.containers = async ({ app }) => { listings++; return { status: 'containers', containers: [{ id: 'fixture-calendar', title: 'Synthetic list' }], truncated: false, app }; };
    const list = () => f.actions.execute('native.containers', { app: 'calendar', requestedByUser: true }, f.directory, { contextSessionId: 'synthetic-session' });
    expect(await list()).toEqual({ status: 'cancelled' }); expect(listings).toBe(0);
    decision = 'approved'; expect(await list()).toMatchObject({ status: 'containers' }); expect(listings).toBe(1);
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls).toEqual([]);
  });
  it('withholds native results if provider configuration changes during the content fetch', async () => {
    const f = await fixture();
    f.reader.read = async () => { f.binding.value = 'b'.repeat(64); return { status: 'ok', items: [{ title: 'SYNTHETIC CONTENT MUST NOT LEAVE' }], truncated: false }; };
    await expect(f.read()).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not silently replace corrupt approval state or accept caller-supplied approval', async () => {
    const f = await fixture(); let prompts = 0;
    f.reader.requestApproval = async () => { prompts++; return { decision: 'approved' }; };
    await writeFile(path.join(f.root, 'native-app-read-grants.json'), '{broken');
    await expect(f.actions.execute('native.requestApproval', { ...query, approved: true }, f.directory, { contextSessionId: 'synthetic-session' })).rejects.toMatchObject({ statusCode: 409 });
    expect(prompts).toBe(0); await expect(f.read({ ...query, approved: true })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('dispatches through the real control action allowlist and blocks follow-up sessions', async () => {
    const f = await fixture();
    const control = createOpenChamberControlService({ nativeAppActions: f.actions });
    expect(await control.execute('native.read', query, f.directory, { contextSessionId: 'synthetic-session' })).toMatchObject({ status: 'ok' });
    const followUp = createOpenChamberControlService({ nativeAppActions: f.actions, isFollowUpSession: async () => true });
    await expect(followUp.execute('native.read', query, f.directory, { contextSessionId: 'synthetic-session' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
