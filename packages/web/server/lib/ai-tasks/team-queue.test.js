import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTeamRuntime } from './team-runtime.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'friends-queue-')));
  const filePath = path.join(directory, 'team.json');
  const control = { blocked: false, policy: 'reviewed', instructions: 'original', creates: 0, sends: 0, complete: false, failCreate: false };
  const executor = {
    resolveProject: async (projectId, model) => ({ projectId, label: projectId, directory, agent: 'manager', model: model ?? { providerID: 'opencode', id: 'free' }, policyRevision: control.policy, queuePolicyRevision: control.policy + control.instructions, specialists: ['explore'] }),
    create: async () => { control.creates += 1; const state = JSON.parse(await readFile(filePath, 'utf8')); expect(state.runs.at(-1).pendingDispatch).toBeUndefined(); expect(state.runs.at(-1).phase).toBe('creating'); if (control.failCreate) throw new Error('Ambiguous create'); return { id: `ses_${control.creates}`, directory }; },
    send: async () => { control.sends += 1; },
    children: async () => [],
    inspect: async () => control.complete ? { kind: 'done', reviewEvidence: 'verified', content: 'DONE\nReviewed result.' } : { kind: 'running' },
    evidence: async run => ({ usage: { kind: 'available', tokens: 10, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, artifacts: [], receiptScan: { kind: 'complete', incompleteSessionIds: [] } }),
    pause: async () => {},
  };
  const options = { filePath, executor, isBlocked: () => control.blocked, guardrails: { projectTokens: 1000, accountTokens: 2000 } };
  let runtime = createTeamRuntime(options);
  cleanup.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, control, filePath, restart: async () => { await runtime.close(); runtime = createTeamRuntime(options); } };
}
const input = { projectId: 'folder', title: 'Read project notes', text: 'Summarize the project notes with citations.', requestId: 'stable-request' };
const scope = run => ({ projectId: run.projectId, teammateId: run.teammateId });
describe('folder friend task queue', () => {
  it('durably saves one keyed assignment without executing and refuses a conflicting retry', async () => {
    const f = await fixture(); const first = await f.runtime.enqueue(input);
    expect(first.pendingDispatch).toBe(true); expect(first.model).toEqual({ providerID: 'opencode', id: 'free' });
    expect((await f.runtime.enqueue(input)).id).toBe(first.id);
    await expect(f.runtime.enqueue({ ...input, text: 'Different work' })).rejects.toThrow('different assignment');
    expect(f.control.creates).toBe(0); expect(f.control.sends).toBe(0);
    expect(JSON.parse(await readFile(f.filePath, 'utf8')).runs).toHaveLength(1);
  });
  it('resumes known-undispatched work after restart and sends exactly once', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    await f.restart(); await f.runtime.check(); await f.runtime.check();
    expect(f.control.creates).toBe(1); expect(f.control.sends).toBe(1);
    expect((await f.runtime.details(scope(run))).runs[0].phase).toBe('running');
  });
  it('refuses rules that changed while waiting', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    f.control.policy = 'changed'; await f.runtime.check();
    const next = (await f.runtime.details(scope(run))).runs[0];
    expect(next.phase).toBe('needs-you'); expect(next.failure.code).toBe('policy-changed'); expect(f.control.creates).toBe(0);
  });
  it('rejects changed agent instructions even when the old policy digest stays the same', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    f.control.instructions = 'changed'; await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0].failure.code).toBe('policy-changed'); expect(f.control.sends).toBe(0);
  });
  it('keeps paused work paused across restart and validates explicit resume', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    await f.runtime.pauseContinuation({ projectId: run.projectId, runId: run.id });
    await f.restart(); await f.runtime.check(); expect(f.control.creates).toBe(0);
    await expect(f.runtime.resumeQueued({ projectId: 'other-folder', runId: run.id })).rejects.toThrow();
    await f.runtime.resumeQueued({ projectId: run.projectId, runId: run.id });
    await f.runtime.check(); expect(f.control.sends).toBe(1);
  });
  it('cancels a waiting assignment without deleting its history or sending a prompt', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    await f.runtime.cancelQueued({ projectId: run.projectId, runId: run.id }); await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0].cancelledBeforeDispatch).toBe(true); expect(f.control.creates).toBe(0);
    await expect(f.runtime.resumeQueued({ projectId: run.projectId, runId: run.id })).rejects.toThrow();
  });
  it('queues behind live work and never exceeds one running assignment', async () => {
    const f = await fixture(); await f.runtime.send({ ...input, requestId: 'live' });
    await f.runtime.enqueue(input); await f.runtime.check(); expect(f.control.creates).toBe(1);
    f.control.complete = true; await f.runtime.check(); expect(f.control.creates).toBe(2); expect(f.control.sends).toBe(2);
  });
  it('bounds the per-folder queue and rejects blocked hosts', async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) await f.runtime.enqueue({ ...input, requestId: `task-${i}` });
    await expect(f.runtime.enqueue(input)).rejects.toThrow('full');
    f.control.blocked = true;
    await expect(f.runtime.enqueue({ ...input, projectId: 'other' })).rejects.toThrow('host policy');
    await f.runtime.check(); expect(f.control.creates).toBe(0);
  });
  it('never retries ambiguous session creation after reopening', async () => {
    const f = await fixture(); const run = await f.runtime.enqueue(input);
    f.control.failCreate = true; await f.runtime.check();
    await f.restart(); await f.runtime.check();
    expect(f.control.creates).toBe(1); expect(f.control.sends).toBe(0);
    expect((await f.runtime.details(scope(run))).runs[0].pendingDispatch).toBeUndefined();
  });
});
