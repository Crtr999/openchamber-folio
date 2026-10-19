import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTeamRuntime } from './team-runtime.js';
import { createHash } from 'node:crypto';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'local-team-test-')));
  const filePath = path.join(directory, 'team.json');
  let clock = Date.UTC(2026, 9, 13, 8);
  let blocked = false;
  const destination = { projectId: 'project', label: 'Project', directory, agent: 'manager', model: { providerID: 'openai', id: 'test' }, policyRevision: 'policy', specialists: ['explore'] };
  let sequence = 0;
  const executor = {
    resolveProject: vi.fn(async (_projectId, model) => ({ ...destination, model: model ?? destination.model })),
    create: vi.fn(async () => ({ id: `ses_${++sequence}`, directory })),
    send: vi.fn(async () => {}), children: vi.fn(async () => []),
    inspect: vi.fn(async () => ({ kind: 'running' })), pause: vi.fn(async () => {}),
    evidence: vi.fn(async run => ({ usage: { kind: 'available', tokens: 20, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, artifacts: [], receiptScan: { kind: 'complete', incompleteSessionIds: [] } })),
  };
  const workStates = [];
  const options = { filePath, executor, now: () => clock, isBlocked: () => blocked, guardrails: { projectTokens: 1000, accountTokens: 2000 }, onWorkState: value => workStates.push(value) };
  const runtime = createTeamRuntime(options);
  cleanup.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, options, filePath, directory, destination, executor, workStates, block: () => { blocked = true; }, advance: () => { clock += 24 * 60 * 60_000; } };
}
const message = { projectId: 'project', title: 'Review', text: 'Read the project notes.', requestId: 'request' };
const proposal = { projectId: 'project', title: 'Review', text: 'Read project notes.', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, allowedActions: ['read-project'], limits: { maxOccurrences: 2, tokenGuardrail: 100 } };
const scope = run => ({ projectId: run.projectId, teammateId: run.teammateId });
// The injected executor owns transcript verification. These runtime tests attest
// that contract; executor.test.js tests message records and verified artifact inputs.
const done = (text = 'The reviewed summary covers the requested project notes and states its assumptions.') => ({
  kind: 'done', reviewEvidence: 'verified', content: `DONE\n${text}\nA usable deliverable with the requested coverage and explicit limitations.\n\n\`\`\`ai-task-review\n{"checks":[{"criterion":"Requested coverage","finding":"Inspected the requested project notes and checked coverage.","evidence":[]}],"files":[],"limitations":[]}\n\`\`\``,
});

describe('durable local teammate work', () => {
  it('freezes the effective default before creation and retains it through default drift and revision', async () => {
    const f = await fixture();
    const chosen = { ...f.destination.model };
    f.executor.create.mockImplementation(async ({ destination }) => {
      expect(JSON.parse(await readFile(f.filePath, 'utf8')).runs[0].model).toEqual(chosen);
      expect(destination.model).toEqual(chosen);
      return { id: 'ses_frozen', directory: f.directory };
    });
    const first = await f.runtime.send(message);
    expect(first.model).toEqual(chosen);
    f.destination.model = { providerID: 'opencode', id: 'other-default' };
    expect((await f.runtime.send(message)).model).toEqual(chosen);
    f.executor.inspect.mockResolvedValue(done()); await f.runtime.check();
    const source = (await f.runtime.details(scope(first))).runs[0];
    const revised = await f.runtime.revise({ projectId: 'project', runId: source.id, revision: source.revision, text: 'Revise the fixture.', requestId: 'revision' });
    expect(revised.model).toEqual(chosen);
    expect(f.executor.resolveProject).toHaveBeenLastCalledWith('project', chosen);
  });
  it('freezes an explicit alternate and refuses duplicate request IDs with a different model', async () => {
    const f = await fixture(); const model = { providerID: 'openai', id: 'subscription-fixture' };
    const run = await f.runtime.send({ ...message, model });
    expect(run.model).toEqual(model);
    expect(f.executor.send.mock.calls[0][0].model).toEqual(model);
    await expect(f.runtime.send({ ...message, model: f.destination.model })).rejects.toThrow('different message or model');
    expect((await f.runtime.send({ ...message, model })).id).toBe(run.id);
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('freezes a routine model at proposal and each new occurrence without following a new default', async () => {
    const f = await fixture(); const model = { ...f.destination.model };
    const routine = await f.runtime.proposeRoutine(proposal);
    expect(routine.model).toEqual(model);
    f.destination.model = { providerID: 'opencode', id: 'other-default' };
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision });
    expect(f.executor.resolveProject).toHaveBeenLastCalledWith('project', model);
    f.advance(); await f.runtime.check();
    expect((await f.runtime.inbox())[0].latestRun.model).toEqual(model);
    expect(f.executor.send.mock.calls[0][0].model).toEqual(model);
  });
  it('does not retrofit model metadata onto historical runs or redispatch them', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    const saved = JSON.parse(await readFile(f.filePath, 'utf8')); delete saved.runs[0].model;
    await writeFile(f.filePath, JSON.stringify(saved));
    expect((await f.runtime.send(message)).model).toBeUndefined();
    await expect(f.runtime.send({ ...message, model: f.destination.model })).rejects.toThrow('different message or model');
    await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0].model).toBeUndefined();
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it.each([
    { kind: 'done', content: 'DONE' },
    { kind: 'done', content: 'DONE', reviewEvidence: 'verified' },
    { ...done(), reviewEvidence: undefined },
  ])('refuses completion without a usable deliverable and verified review', async result => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.inspect.mockResolvedValue(result);
    await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'needs-you', content: expect.stringContaining('NEEDS YOU') });
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('retains the review contract across restart and refuses partial current scans', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    await f.runtime.close();
    const restarted = createTeamRuntime(f.options); cleanup.push(() => restarted.close());
    f.executor.inspect.mockResolvedValue(done());
    f.executor.evidence.mockImplementation(async input => ({ usage: { kind: 'available', tokens: 20, reportedCost: 0, sessionIds: [input.sessionId], dollarCapSupported: false }, artifacts: [], receiptScan: { kind: 'partial', incompleteSessionIds: [input.sessionId] } }));
    await restarted.check();
    expect((await restarted.details(scope(run))).runs[0].phase).toBe('needs-you');
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('preserves historical completion compatibility without retroactive review', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    const saved = JSON.parse(await readFile(f.filePath, 'utf8'));
    delete saved.runs[0].savedContext;
    await writeFile(f.filePath, JSON.stringify(saved));
    f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE' });
    await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0].phase).toBe('done');
  });
  it('passes only freshly observed artifacts to completion verification', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    const saved = JSON.parse(await readFile(f.filePath, 'utf8'));
    saved.runs[0].artifacts = [{ path: '/old', label: 'old', sessionId: run.sessionId, messageId: 'old', verified: true }];
    await writeFile(f.filePath, JSON.stringify(saved));
    await f.runtime.check();
    expect(f.executor.inspect.mock.calls[0][0].artifacts).toEqual([]);
    expect((await f.runtime.details(scope(run))).runs[0].artifacts).toHaveLength(1);
  });
  it('executes fixed operations under the host dispatcher and refuses pause during authorization', async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, 'team-output'));
    const run = await f.runtime.send(message);
    f.executor.authorizeTool = async () => ({ directory: f.directory });
    const input = { projectId: 'project', sessionID: 'child', action: 'team_compute', input: { request: '{"operation":"stats","values":[1,2,3,4]}' } };
    const signal = new AbortController().signal;
    expect(JSON.parse((await f.runtime.executeTool(input, { signal })).content).result.sum).toBe(10);
    await expect(f.runtime.executeTool({ ...input, projectId: 'other' }, { signal })).rejects.toThrow('No active');
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    f.executor.authorizeTool = () => { started(); return new Promise(resolve => { release = () => resolve({ directory: f.directory }); }); };
    const pending = f.runtime.executeTool({ ...input, action: 'team_output', input: { filename: 'never.txt', content: 'x' } }, { signal });
    await entered;
    const paused = f.runtime.pauseContinuation({ projectId: 'project', runId: run.id });
    release();
    await expect(pending).rejects.toThrow('revoked');
    await paused;
    await expect(readFile(path.join(f.directory, 'team-output/never.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.runtime.executeTool(input, { signal })).rejects.toThrow('No active');
  });
  it('passes only the host-authorized receipt to the scoped output reader without approvals', async () => {
    const f = await fixture(); await mkdir(path.join(f.directory, 'team-output'));
    const file = path.join(f.directory, 'team-output/review.md');
    const content = 'An isolated fixture deliverable.'; await writeFile(file, content);
    await f.runtime.send(message);
    const receipt = { path: file, sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), verified: true, sessionId: 'child', messageId: 'output' };
    f.executor.authorizeTool = vi.fn(async () => ({ directory: f.directory, receipt }));
    const input = { projectId: 'project', sessionID: 'reader', action: 'team_read_output', input: { filename: 'review.md' } };
    const signal = new AbortController().signal;
    expect(JSON.parse((await f.runtime.executeTool(input, { signal })).content)).toMatchObject({ content, path: file, sha256: receipt.sha256 });
    await expect(f.runtime.executeTool({ ...input, input: { ...input.input, receipt } }, { signal })).rejects.toThrow();
    await expect(f.runtime.executeTool({ ...input, input: { filename: '../review.md' } }, { signal })).rejects.toThrow();
    expect(f.executor.authorizeTool).toHaveBeenCalledOnce();
    f.executor.authorizeTool.mockResolvedValue({ directory: f.directory });
    await expect(f.runtime.executeTool(input, { signal })).rejects.toThrow();
  });
  it('requires read-output routine authorization rather than treating a read as draft-output', async () => {
    const f = await fixture(); await mkdir(path.join(f.directory, 'team-output'));
    const routine = await f.runtime.proposeRoutine({ ...proposal, allowedActions: ['read-project', 'draft-output'] });
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision });
    f.advance(); await f.runtime.check();
    f.executor.authorizeTool = vi.fn();
    await expect(f.runtime.executeTool({ projectId: 'project', sessionID: 'reader', action: 'team_read_output', input: { filename: 'review.md' } }, { signal: new AbortController().signal })).rejects.toThrow('not approved');
    expect(f.executor.authorizeTool).not.toHaveBeenCalled();
  });
  it('refuses a dispatcher whose ownership nonce was replaced', async () => {
    const f = await fixture();
    await f.runtime.inbox();
    const lockFile = f.filePath + '.dispatcher';
    const saved = await readFile(lockFile, 'utf8');
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, nonce: 'replacement' }));
    await expect(f.runtime.inbox()).rejects.toThrow('ownership changed');
    await writeFile(lockFile, saved);
  });
  it('starts inert, without model calls or invented teammates', async () => {
    const f = await fixture();
    expect(await f.runtime.inbox()).toEqual([]);
    await f.runtime.check();
    expect(f.executor.resolveProject).not.toHaveBeenCalled();
    expect(f.executor.create).not.toHaveBeenCalled();
    expect(f.workStates.at(-1)).toEqual({ state: 'idle' });
  });
  it('refuses recurrence whose approved actions omit admitted specialist tools', async () => {
    const f = await fixture();
    f.destination.childPermissions = [{ id: 'compute', permissions: [{ action: 'team_compute', resource: '*', effect: 'allow' }] }];
    await expect(f.runtime.proposeRoutine(proposal)).rejects.toThrow('action approval');
    const routine = await f.runtime.proposeRoutine({ ...proposal, allowedActions: ['read-project', 'safe-compute'] });
    expect(routine.status).toBe('proposed');
    expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('preserves newly observed counters and marks accounting stale on a later policy failure', async () => {
    const f = await fixture();
    await f.runtime.send(message);
    await f.runtime.check();
    f.executor.accounting = async run => ({ kind: 'available', tokens: 123, reportedCost: 0.01, sessionIds: [run.sessionId], dollarCapSupported: false });
    f.executor.children.mockRejectedValue(new Error('Free policy violation'));
    await f.runtime.check();
    const saved = (await f.runtime.inbox())[0].latestRun;
    expect(saved.usage).toMatchObject({ kind: 'unavailable', tokens: 123, reportedCost: 0.01 });
    await expect(f.runtime.send({ ...message, requestId: 'another' })).rejects.toThrow();
  });
  it('looks up a stable project-scoped Notion request without dispatch or writes', async () => {
    const f = await fixture(); const requestId = 'notion:run-123';
    expect(await f.runtime.getRun({ projectId: 'project', requestId })).toBeNull();
    expect(f.executor.resolveProject).not.toHaveBeenCalled();
    const run = await f.runtime.send({ ...message, requestId });
    const before = await readFile(f.filePath, 'utf8');
    f.block();
    expect(await f.runtime.getRun({ projectId: 'project', requestId })).toEqual(run);
    expect(await f.runtime.getRun({ projectId: 'other', requestId })).toBeNull();
    expect(await f.runtime.getRun({ projectId: 'project', requestId: 'notion:missing' })).toBeNull();
    expect(await readFile(f.filePath, 'utf8')).toBe(before);
    expect(f.executor.send).toHaveBeenCalledOnce(); expect(f.executor.create).toHaveBeenCalledOnce();
    await expect(f.runtime.getRun({ projectId: 'project', requestId, teammateId: run.teammateId })).rejects.toThrow();
    await f.runtime.close();
    const restarted = createTeamRuntime(f.options); cleanup.push(() => restarted.close());
    expect((await restarted.getRun({ projectId: 'project', requestId })).id).toBe(run.id);
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('publishes direct-work demand from durable state and releases it after completion', async () => {
    const f = await fixture(); await f.runtime.send(message);
    expect(f.workStates.at(-1)).toEqual({ state: 'required' });
    f.executor.inspect.mockResolvedValue(done()); await f.runtime.check();
    expect(f.workStates.at(-1)).toEqual({ state: 'idle' });
  });
  it('keeps unrelated prior results out of a new assignment', async () => {
    const f = await fixture(); const first = await f.runtime.send(message);
    f.executor.inspect.mockResolvedValue(done('The reviewed summary.')); await f.runtime.check();
    const second = await f.runtime.send({ ...message, text: 'Revise the summary.', requestId: 'followup' });
    expect(second.id).not.toBe(first.id); expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.teammateId).toBe(first.teammateId);
    expect(f.executor.send.mock.calls[1][1]).not.toContain('The reviewed summary.');
    expect(second.savedContext).toBe('Completion contract: ai-task-review-v2.');
  });
  it('persists assignment and session identity before dispatch', async () => {
    const f = await fixture();
    f.executor.create.mockImplementation(async () => {
      expect(JSON.parse(await readFile(f.filePath, 'utf8')).runs[0]).toMatchObject({ phase: 'creating', taskId: expect.any(String) });
      return { id: 'ses_real', directory: f.directory };
    });
    f.executor.send.mockImplementation(async run => {
      expect(JSON.parse(await readFile(f.filePath, 'utf8')).runs[0]).toMatchObject({ sessionId: run.sessionId, phase: 'dispatching' });
    });
    const run = await f.runtime.send(message);
    expect(run).toMatchObject({ sessionId: 'ses_real', phase: 'running' });
    expect((await f.runtime.inbox())[0]).toMatchObject({ unread: true, latestRun: { id: run.id } });
  });
  it.each(['children', 'evidence', 'result'])('retains safe %s inspection diagnostics without sensitive messages', async step => {
    const f = await fixture(); const run = await f.runtime.send(message);
    const error = new Error('Confidential body and credential must never escape');
    error.cause = { status: 503, body: 'private' };
    f.executor[step === 'result' ? 'inspect' : step].mockRejectedValue(error);
    await f.runtime.check();
    const saved = (await f.runtime.details(scope(run))).runs[0];
    expect(saved.failure).toMatchObject({ stage: 'inspect', code: `inspect-${step}-http-503` });
    expect(JSON.stringify(saved.failure)).not.toMatch(/Confidential|credential|private/);
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('distinguishes malformed result schemas from unavailable transport', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.inspect.mockResolvedValue({ kind: 'invalid', content: 'Confidential data' });
    await f.runtime.check();
    const saved = (await f.runtime.details(scope(run))).runs[0];
    expect(saved.failure).toMatchObject({ stage: 'inspect', code: 'inspect-result-invalid-response' });
    expect(JSON.stringify(saved.failure)).not.toContain('Confidential');
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('serializes sends, preserves request identity and rejects changed contents', async () => {
    const f = await fixture();
    const [first, duplicate] = await Promise.all([f.runtime.send(message), f.runtime.send(message)]);
    expect(duplicate.id).toBe(first.id);
    expect(f.executor.send).toHaveBeenCalledOnce();
    await expect(f.runtime.send({ ...message, text: 'Different.' })).rejects.toThrow('different message');
    await expect(f.runtime.send({ ...message, requestId: 'new' })).rejects.toThrow('current team run');
  });
  it('retains real children, evidence and saved results in scoped details', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.children.mockResolvedValue([{ id: 'ses_child', title: 'Read notes', directory: f.directory }]);
    f.executor.evidence.mockResolvedValue({ usage: { kind: 'available', tokens: 30, reportedCost: 0, sessionIds: [run.sessionId, 'ses_child'], dollarCapSupported: false }, artifacts: [{ path: path.join(f.directory, 'notes.md'), label: 'notes.md', sessionId: 'ses_child', messageId: 'msg' }], receiptScan: { kind: 'complete', incompleteSessionIds: [] } });
    f.executor.inspect.mockResolvedValue(done('Verified notes.'));
    await f.runtime.check();
    const details = await f.runtime.details(scope(run));
    expect(details.runs[0]).toMatchObject({ phase: 'done', content: done('Verified notes.').content, children: [{ id: 'ses_child' }], artifacts: [{ label: 'notes.md' }] });
    await expect(f.runtime.details({ ...scope(run), projectId: 'other' })).rejects.toThrow('project');
  });
  it('recovers ambiguous sends without another prompt after restart', async () => {
    const f = await fixture(); f.executor.send.mockRejectedValueOnce(new Error('Connection lost'));
    const run = await f.runtime.send(message);
    expect(run.phase).toBe('dispatching'); await f.runtime.close();
    const restarted = createTeamRuntime(f.options); cleanup.push(() => restarted.close());
    f.executor.inspect.mockResolvedValue(done('Saved result.'));
    await restarted.check();
    expect((await restarted.details(scope(run))).runs[0].phase).toBe('done');
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('keeps failed creation inspectable with no nonexistent chat link', async () => {
    const f = await fixture(); f.executor.create.mockRejectedValueOnce(new Error('Secret credential error'));
    const run = await f.runtime.send(message);
    expect(run).toMatchObject({ phase: 'needs-you', failure: { stage: 'create' } });
    expect(run.sessionId).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('Secret');
    await f.runtime.check(); expect(f.executor.create).toHaveBeenCalledOnce();
  });
  it('preserves saved results while host policy blocks new work', async () => {
    const f = await fixture(); const run = await f.runtime.send(message); f.block();
    expect((await f.runtime.details(scope(run))).runs[0].id).toBe(run.id);
    await f.runtime.check();
    expect(f.executor.pause).toHaveBeenCalledOnce();
    await expect(f.runtime.send({ ...message, requestId: 'new' })).rejects.toThrow('host policy');
    expect((await f.runtime.inbox())[0].latestRun.phase).toBe('paused');
  });
  it('acknowledges only reviewed revisions without clearing newer unread updates', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    await f.runtime.check(); const before = (await f.runtime.inbox())[0];
    await f.runtime.ack({ ...scope(run), revision: run.revision });
    expect((await f.runtime.inbox())[0].unread).toBe(true);
    await f.runtime.ack({ ...scope(run), revision: before.teammate.revision });
    expect((await f.runtime.inbox())[0].unread).toBe(false);
    await expect(f.runtime.ack({ ...scope(run), revision: 999 })).rejects.toThrow('future');
  });
  it('requires exact routine review and never dispatches an unconfirmed proposal', async () => {
    const f = await fixture(); const routine = await f.runtime.proposeRoutine(proposal); f.advance(); await f.runtime.check();
    expect(f.executor.create).not.toHaveBeenCalled();
    await expect(f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: 'wrong' })).rejects.toThrow('revision');
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision }); f.advance();
    await Promise.all([f.runtime.check(), f.runtime.check()]);
    expect(f.executor.create).toHaveBeenCalledOnce();
    expect((await f.runtime.inbox())[0].latestRun.routineId).toBe(routine.id);
  });
  it('pauses routines and bounds occurrence count', async () => {
    const f = await fixture(); const routine = await f.runtime.proposeRoutine(proposal);
    const action = { projectId: 'project', routineId: routine.id, revision: routine.revision };
    await f.runtime.confirmRoutine(action); f.advance(); await f.runtime.check();
    f.executor.inspect.mockResolvedValue(done()); await f.runtime.check();
    f.advance(); await f.runtime.check(); await f.runtime.check(); f.advance(); await f.runtime.check();
    expect(f.executor.create).toHaveBeenCalledTimes(2);
    await f.runtime.pauseRoutine(action); f.advance(); await f.runtime.check();
    expect(f.executor.create).toHaveBeenCalledTimes(2);
  });
  it('rejects changed project policy before confirming recurrence', async () => {
    const f = await fixture(); const routine = await f.runtime.proposeRoutine(proposal); f.destination.policyRevision = 'changed';
    await expect(f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision })).rejects.toThrow('policy changed');
    expect(f.executor.create).not.toHaveBeenCalled();
  });
  it('stops actual work after bounded evidence failures and exposes pause failure honestly', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.evidence.mockRejectedValue(new Error('No counters')); f.executor.pause.mockRejectedValue(new Error('Interrupt failed'));
    await f.runtime.check(); await f.runtime.check(); await f.runtime.check();
    expect(f.executor.pause).toHaveBeenCalledOnce();
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'needs-you', failure: { stage: 'pause' } });
  });
  it('pauses on observed token limits without pretending to enforce a dollar cap', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.evidence.mockResolvedValue({ usage: { kind: 'available', tokens: 1000, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, artifacts: [] });
    await f.runtime.check(); expect(f.executor.pause).toHaveBeenCalledOnce();
    await expect(f.runtime.send({ ...message, requestId: 'new' })).rejects.toThrow('guardrail');
    expect((await f.runtime.details(scope(run))).runs[0].phase).toBe('paused');
  });
  it('rejects incomplete or wrong-project child evidence', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.children.mockResolvedValue([{ id: 'ses_other', title: 'Other', directory: '/other' }]);
    await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'running', children: [], failure: { stage: 'inspect' } });
    expect(f.executor.inspect).not.toHaveBeenCalled();
  });
  it('refuses a second dispatcher and malformed persisted state without overwriting it', async () => {
    const f = await fixture(); await f.runtime.inbox();
    const second = createTeamRuntime(f.options); cleanup.push(() => second.close());
    await expect(second.inbox()).rejects.toThrow('Another Mac team dispatcher');
    await writeFile(f.filePath, '{broken');
    await expect(f.runtime.inbox()).rejects.toThrow('could not be read');
    expect(await readFile(f.filePath, 'utf8')).toBe('{broken');
    expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('blocks every new dispatch across restart until a failed pause succeeds', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    await f.runtime.check();
    const routine = await f.runtime.proposeRoutine(proposal);
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision });
    f.executor.pause.mockRejectedValue(new Error('Unavailable'));
    await f.runtime.pauseContinuation({ projectId: 'project', runId: run.id });
    await f.runtime.close();
    const restarted = createTeamRuntime(f.options); cleanup.push(() => restarted.close());
    await expect(restarted.send({ ...message, requestId: 'new' })).rejects.toThrow('pause is unverified');
    await expect(restarted.send({ ...message, projectId: 'other', requestId: 'other' })).rejects.toThrow('pause is unverified');
    f.advance(); await restarted.check();
    expect(f.executor.send).toHaveBeenCalledOnce();
    expect(f.workStates.at(-1)).toEqual({ state: 'required' });
    f.executor.pause.mockResolvedValue();
    await restarted.recover({ projectId: 'project', runId: run.id });
    await restarted.send({ ...message, requestId: 'new' });
    expect(f.executor.send).toHaveBeenCalledTimes(2);
  });
  it('resets consecutive inspection failures and leaves acknowledged no-op snapshots read', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.evidence.mockRejectedValueOnce(new Error('Unavailable'));
    await f.runtime.check(); await f.runtime.check();
    let saved = (await f.runtime.details(scope(run))).runs[0];
    expect(saved.inspectFailures).toBe(0); expect(saved.failure).toBeUndefined();
    await f.runtime.ack({ ...scope(run), revision: saved.revision });
    await f.runtime.check();
    expect((await f.runtime.inbox())[0].unread).toBe(false);
    f.executor.evidence.mockRejectedValueOnce(new Error('Unavailable'));
    await f.runtime.check();
    saved = (await f.runtime.details(scope(run))).runs[0];
    expect(saved.inspectFailures).toBe(1); expect(saved.phase).toBe('running');
    expect(f.executor.pause).not.toHaveBeenCalled();
  });
  it('saves routine resolution and ambiguous-dispatch failure reasons', async () => {
    const f = await fixture(); const routine = await f.runtime.proposeRoutine(proposal);
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: routine.id, revision: routine.revision });
    f.executor.resolveProject.mockRejectedValueOnce(new Error('private error')); f.advance(); await f.runtime.check();
    const details = await f.runtime.details({ projectId: 'project', teammateId: routine.teammateId });
    expect(details.routines[0]).toMatchObject({ status: 'paused', failure: { stage: 'resolve', code: 'unavailable' } });
    expect(JSON.stringify(details)).not.toContain('private error');
    const next = await f.runtime.proposeRoutine(proposal);
    await f.runtime.confirmRoutine({ projectId: 'project', routineId: next.id, revision: next.revision });
    f.executor.send.mockRejectedValueOnce(new Error('Ambiguous')); f.advance(); await f.runtime.check();
    expect((await f.runtime.details({ projectId: 'project', teammateId: next.teammateId })).routines[1]).toMatchObject({ status: 'paused', failure: { stage: 'dispatch' } });
  });
  it('tracks exact reviewed revisions with durable source context and never resends a duplicate', async () => {
    const f = await fixture(); const first = await f.runtime.send(message);
    f.executor.inspect.mockResolvedValue(done('Reviewed result.')); await f.runtime.check();
    const source = (await f.runtime.details(scope(first))).runs[0];
    const input = { projectId: 'project', runId: first.id, revision: source.revision, text: 'Revise for clarity.', requestId: 'revision' };
    await expect(f.runtime.revise({ ...input, revision: first.revision })).rejects.toThrow('revision changed');
    await expect(f.runtime.revise({ ...input, projectId: 'other' })).rejects.toThrow('project');
    const revised = await f.runtime.revise(input);
    expect(revised).toMatchObject({ revisionOf: source.id, sourceRevision: source.revision, text: input.text });
    expect(revised.savedContext).toContain('Reviewed result.');
    expect(f.executor.send.mock.calls[1][1]).toContain('Reviewed source run');
    expect((await f.runtime.revise(input)).id).toBe(revised.id);
    expect(f.executor.send).toHaveBeenCalledTimes(2);
    await expect(f.runtime.revise({ ...input, text: 'Different' })).rejects.toThrow('different revision');
  });
  it('bounds a perpetually pending task and recovers evidence without a resend', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.inspect.mockResolvedValue({ kind: 'pending' }); f.advance(); await f.runtime.check();
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'needs-you', failure: { stage: 'stall', code: 'deadline' } });
    expect(f.executor.pause).toHaveBeenCalledOnce();
    await f.runtime.recover({ projectId: 'project', runId: run.id });
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'needs-you', failure: { stage: 'stall' } });
    f.executor.inspect.mockResolvedValue(done('Recovered.'));
    await f.runtime.recover({ projectId: 'project', runId: run.id });
    expect((await f.runtime.details(scope(run))).runs[0]).toMatchObject({ phase: 'done', content: done('Recovered.').content });
    expect(f.executor.send).toHaveBeenCalledOnce();
  });
  it('retains lifetime usage and finite limits after recovery and restart', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.evidence.mockResolvedValue({ usage: { kind: 'available', tokens: 1000, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, artifacts: [] });
    await f.runtime.check();
    f.executor.evidence.mockResolvedValue({ usage: { kind: 'available', tokens: 0, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, artifacts: [] });
    await f.runtime.recover({ projectId: 'project', runId: run.id }); await f.runtime.close();
    const restarted = createTeamRuntime(f.options); cleanup.push(() => restarted.close());
    await expect(restarted.send({ ...message, requestId: 'new' })).rejects.toThrow('guardrail');
    expect((await restarted.details(scope(run))).runs[0].usage.tokens).toBe(1000);
    await expect(restarted.proposeRoutine({ ...proposal, limits: { ...proposal.limits, maxOccurrences: 32 } })).rejects.toThrow();
  });
  it('durably records the interruption barrier before calling the executor', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.pause.mockImplementation(async () => {
      const saved = JSON.parse(await readFile(f.filePath, 'utf8')).runs[0];
      expect(saved).toMatchObject({ phase: 'paused', pausePending: true });
    });
    await f.runtime.pauseContinuation({ projectId: 'project', runId: run.id });
    expect((await f.runtime.details(scope(run))).runs[0].pausePending).toBeUndefined();
  });
  it('does not bump unread for repeated identical inspection failure diagnostics', async () => {
    const f = await fixture(); const run = await f.runtime.send(message);
    f.executor.evidence.mockRejectedValue(new Error('Unavailable')); await f.runtime.check();
    const saved = (await f.runtime.details(scope(run))).runs[0];
    await f.runtime.ack({ ...scope(run), revision: saved.revision });
    f.advance(); await f.runtime.check();
    expect((await f.runtime.inbox())[0].unread).toBe(false);
    expect((await f.runtime.details(scope(run))).runs[0].inspectFailures).toBe(2);
  });
});
