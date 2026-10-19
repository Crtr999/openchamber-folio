import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTeamToolsPlugin } from './team-tools-plugin.js';

const cleanup = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'team-plugin-')));
  cleanup.push(directory); mkdirSync(path.join(directory, 'team-output'));
  const tools = new Map();
  const grants = new Set(['team_compute', 'team_output', 'team_read_output']);
  const receipts = new Map();
  const session = { id: 'ses_team', location: { directory } };
  let disposed = false;
  // Public v2 Plugin.define is an identity wrapper. This fixture exercises real executors, not mocked modules.
  const plugin = createTeamToolsPlugin({ define: definition => definition }, { directory, projectId: 'business', exclusiveOutputOwnership: true,
    authorize: async ({ sessionID, action }) => sessionID === 'ses_team' && grants.has(action),
    readReceipt: async ({ sessionID, input }) => sessionID === 'ses_team' ? receipts.get(input.filename) : undefined });
  const ctx = { location: { directory, project: { id: 'business', canonical: directory } },
    session: { get: async () => session }, tool: { transform: async callback => { callback({ add: tool => tools.set(tool.name, tool) }); return { dispose: async () => { disposed = true; } }; } } };
  const close = await plugin.setup(ctx);
  return { ctx, plugin, directory, tools, grants, receipts, session, close, disposed: () => disposed, context: { sessionID: 'ses_team', signal: new AbortController().signal } };
}
describe('v2 team tool registration', () => {
  it('registers exact tools, produces arithmetic and real output, and disposes registration', async () => {
    const f = await fixture();
    expect([...f.tools.keys()]).toEqual(['team_compute', 'team_output', 'team_read_output']);
    const result = await f.tools.get('team_compute').execute({ request: JSON.stringify({ operation: 'stats', values: [2, 4] }) }, f.context);
    expect(JSON.parse(result.content).result.mean).toBe(3);
    const output = await f.tools.get('team_output').execute({ filename: 'receipt.json', content: result.content }, f.context);
    expect(readFileSync(JSON.parse(output.content).path, 'utf8')).toBe(result.content);
    expect(output).not.toHaveProperty('output');
    await f.close(); expect(f.disposed()).toBe(true);
  });
  it('refuses other locations, wrong-session records, moved sessions and revoked permissions', async () => {
    const f = await fixture();
    const compute = f.tools.get('team_compute'); const args = { request: JSON.stringify({ operation: 'stats', values: [1] }) };
    f.grants.delete('team_compute');
    await expect(compute.execute(args, f.context)).rejects.toThrow('permission refused');
    f.grants.add('team_compute'); f.session.id = 'ses_other';
    await expect(compute.execute(args, f.context)).rejects.toThrow('scope refused');
    f.session.id = 'ses_team'; f.session.location.directory = '/other';
    await expect(compute.execute(args, f.context)).rejects.toThrow('scope refused');
    f.ctx.location.project.id = 'legal';
    await expect(f.plugin.setup(f.ctx)).rejects.toThrow('location refused');
  });
  it('reviews actual output through the host receipt owner without a permission-request API', async () => {
    const f = await fixture();
    const emitted = JSON.parse((await f.tools.get('team_output').execute({ filename: 'draft.md', content: 'The independently reviewed output.' }, f.context)).content);
    const read = f.tools.get('team_read_output');
    await expect(read.execute({ filename: 'draft.md' }, f.context)).rejects.toThrow();
    f.receipts.set('draft.md', { path: emitted.path, sha256: emitted.sha256, sizeBytes: emitted.bytes, verified: true });
    const actual = JSON.parse((await read.execute({ filename: 'draft.md' }, f.context)).content);
    expect(actual.content).toBe('The independently reviewed output.');
    f.grants.delete('team_read_output');
    await expect(read.execute({ filename: 'draft.md' }, f.context)).rejects.toThrow('permission refused');
    expect(f.ctx.session).not.toHaveProperty('permission');
  });
  it('refuses cancellation and external publishing without any external transport', async () => {
    const f = await fixture();
    await expect(f.tools.get('team_compute').execute({ operation: 'stats', values: [1] }, { ...f.context, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(f.tools.get('team_output').execute({ filename: 'external.txt', content: 'x', url: 'https://example.com' }, f.context)).rejects.toThrow();
  });
  it('decodes JSON data without coercion, expressions, extra fields or unbounded requests', async () => {
    const f = await fixture();
    const compute = f.tools.get('team_compute');
    for (const request of ['not JSON', '{"operation":"stats","values":"[1,2]"}', '{"operation":"stats","values":["1",2]}', '{"operation":"stats","values":[1],"code":"process.exit()"}', 'x'.repeat(131073)]) {
      await expect(compute.execute({ request }, f.context)).rejects.toThrow();
    }
    await expect(compute.execute({ request: '{"operation":"stats","values":[1]}', extra: true }, f.context)).rejects.toThrow();
  });
  it('ends a blocked context lookup on cancellation even when the client ignores its signal', async () => {
    const f = await fixture();
    f.ctx.session.get = () => new Promise(() => {});
    const controller = new AbortController();
    const pending = f.tools.get('team_output').execute({ filename: 'never.txt', content: 'x' }, { ...f.context, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() => readFileSync(path.join(f.directory, 'team-output', 'never.txt'))).toThrow();
  });
});
