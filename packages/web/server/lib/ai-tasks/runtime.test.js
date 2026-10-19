import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAiTaskRuntime, createTeamRuntime, AI_TASK_COLUMNS } from './runtime.js';
import { createHash } from 'node:crypto';
import { createAiTaskExecutor } from './executor.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-tasks-'));
  const filePath = path.join(directory, 'state.json');
  let clock = 1000;
  let blocked = false;
  const row = { url: 'https://www.notion.so/task', title: 'Research', status: 'Ready for AI' };
  const board = { columns: [...AI_TASK_COLUMNS], rows: [row] };
  const notion = {
    readBoard: vi.fn(async () => board), readTask: vi.fn(async () => 'Research the latest documentation.'),
    createBoard: vi.fn(async () => 'collection://ai'),
    prepareCreateBoard: vi.fn(async () => {}),
    claim: vi.fn(async () => { row.status = 'Doing'; return true; }),
    finish: vi.fn(async (run) => { if (row.status !== 'Doing') return false; row.status = run.outcome === 'done' ? 'Done' : 'Needs you'; return true; }),
  };
  const executor = {
    projects: vi.fn(async () => [{ id: 'project', label: 'Research' }]),
    resolveProject: vi.fn(async () => ({ projectId: 'project', label: 'Research', directory, agent: 'manager' })),
    children: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 'ses_task', directory })),
    send: vi.fn(async () => {}), inspect: vi.fn(async () => ({ kind: 'running' })),
  };
  await writeFile(filePath, JSON.stringify({ assignments: [{ board: 'collection://ai', page: row.url, projectId: 'project' }] }));
  const options = { filePath, notion, executor, isBlocked: () => blocked, now: () => clock };
  const runtime = createAiTaskRuntime(options);
  cleanup.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, options, board, row, notion, executor, filePath, block: () => { blocked = true; }, advance: () => { clock += 15 * 60_000; } };
}
const config = { enabled: true, board: 'collection://ai', model: 'openai/test' };
const reviewedShared = text => ({ kind: 'done', reviewEvidence: 'verified',
  content: `DONE\n${text}. The requested analysis includes its findings, assumptions and next steps.\n\n\`\`\`ai-task-review\n{"checks":[{"criterion":"Requested coverage","finding":"Checked the requested coverage and stated assumptions.","evidence":[]}],"files":[],"limitations":[]}\n\`\`\``,
});

async function sharedFixture() {
  const f = await fixture();
  const cleanupFixture = cleanup.pop();
  await f.runtime.close();
  const destination = { projectId: 'project', label: 'Research', directory: '/shared', agent: 'manager', model: { providerID: 'openai', id: 'test' }, policyRevision: 'policy', specialists: [] };
  const teamExecutor = {
    resolveProject: vi.fn(async (_projectId, model) => ({ ...destination, model: model ?? destination.model })),
    create: vi.fn(async ({ runId }) => ({ id: `ses_${runId}`, directory: destination.directory })),
    send: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ kind: 'running' })),
    children: vi.fn(async () => []),
    evidence: vi.fn(async (run) => ({ artifacts: [], usage: { kind: 'available', tokens: 1, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false }, receiptScan: { kind: 'complete', incompleteSessionIds: [] } })),
    pause: vi.fn(async () => {}),
  };
  const authority = createTeamRuntime({ filePath: path.join(path.dirname(f.filePath), 'team.json'), executor: teamExecutor, isBlocked: f.options.isBlocked, guardrails: { projectTokens: 100, accountTokens: 100 } });
  // Read-only adapter for the integration contract, until the shared owner adds getRun.
  const team = {
    send: vi.fn((input) => authority.send(input)), details: vi.fn((input) => authority.details(input)), check: vi.fn(() => authority.check()),
    getRun: vi.fn(async ({ projectId, requestId }) => {
      const taskId = createHash('sha256').update(JSON.stringify([projectId, requestId])).digest('hex');
      const teammate = (await authority.listTeammates()).find((item) => item.projectId === projectId);
      return teammate ? (await authority.details({ projectId, teammateId: teammate.id })).runs.find((run) => run.taskId === taskId) ?? null : null;
    }),
  };
  const options = { ...f.options, team };
  const runtime = createAiTaskRuntime(options);
  cleanup.push(async () => { await runtime.close(); await authority.close(); await cleanupFixture(); });
  await runtime.configure(config);
  return { ...f, options, runtime, team, authority, teamExecutor };
}

describe('Notion through shared team authority', () => {
  it('refuses a saved explicit model if the shared team authority is unavailable', async () => {
    const f = await fixture();
    await writeFile(f.filePath, JSON.stringify({ assignments: [{ board: config.board, page: f.row.url, projectId: 'project', model: { providerID: 'openai', id: 'subscription-fixture' } }] }));
    await f.runtime.configure(config); await f.runtime.check();
    expect((await f.runtime.status()).runs[0]).toMatchObject({ phase: 'needs-you', failure: { code: 'teamProvider', stage: 'create' } });
    expect(f.executor.resolveProject).not.toHaveBeenCalled();
    expect(f.executor.create).not.toHaveBeenCalled(); expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('writes Needs you rather than Done when the shared completion review is missing', async () => {
    const f = await sharedFixture(); await f.runtime.check();
    f.teamExecutor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE' });
    await f.authority.check(); await f.runtime.check();
    expect(f.row.status).toBe('Needs you');
    expect(f.notion.finish.mock.calls.at(-1)[0]).toMatchObject({ outcome: 'needs-you' });
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1);
  });
  it('sends once through the shared authority with durable request identity and real children', async () => {
    const f = await sharedFixture();
    f.team.send.mockImplementationOnce(async (input) => {
      const saved = JSON.parse(await readFile(f.filePath, 'utf8')).runs[0];
      expect(saved.teamRequestId).toBe(`notion:${saved.id}`);
      expect(saved.phase).toBe('running');
      return f.authority.send(input);
    });
    await f.runtime.check();
    const run = (await f.runtime.status()).runs[0];
    expect(run).toMatchObject({ directory: '/shared', projectLabel: 'Research', teamRunId: expect.any(String), sessionId: expect.any(String) });
    expect(f.team.send).toHaveBeenCalledWith({ projectId: 'project', title: f.row.title, text: 'Research the latest documentation.', requestId: `notion:${run.id}` });
    f.teamExecutor.children.mockResolvedValue([{ id: 'child', title: 'Research', directory: '/shared' }]);
    f.teamExecutor.evidence.mockImplementation(async (shared) => ({ artifacts: [], usage: { kind: 'available', tokens: 2, reportedCost: 0, sessionIds: [shared.sessionId, 'child'], dollarCapSupported: false } }));
    await f.authority.check();
    expect((await f.runtime.details(run.id)).children.items).toEqual([{ id: 'child', title: 'Research', directory: '/shared' }]);
    expect(f.executor.create).not.toHaveBeenCalled(); expect(f.executor.send).not.toHaveBeenCalled(); expect(f.executor.inspect).not.toHaveBeenCalled(); expect(f.executor.children).not.toHaveBeenCalled();
    expect(f.team.check).not.toHaveBeenCalled();
  });
  it('sends a card with its chosen approved model and refuses unapproved choices', async () => {
    const f = await sharedFixture();
    const chosen = { providerID: 'openai', id: 'gpt-subscription' };
    f.team.models = vi.fn(async () => [{ ...chosen, name: 'ChatGPT', default: false }]);
    await expect(f.runtime.assign({ page: f.row.url, projectId: 'project', model: { providerID: 'azure', id: 'paid' } })).rejects.toThrow('approved');
    await f.runtime.assign({ page: f.row.url, projectId: 'project', model: chosen });
    expect((await f.runtime.projects())[0].models).toEqual([{ ...chosen, name: 'ChatGPT', default: false }]);
    await f.runtime.check();
    const run = (await f.runtime.status()).runs[0];
    expect(run.model).toEqual(chosen);
    expect(f.team.send).toHaveBeenCalledWith(expect.objectContaining({ model: chosen, requestId: `notion:${run.id}` }));
    expect(f.teamExecutor.resolveProject).toHaveBeenCalledWith('project', chosen);
    expect((await f.authority.getRun({ projectId: 'project', requestId: `notion:${run.id}` })).model).toEqual(chosen);
  });
  it('applies one shared concurrency and usage authority to direct and Notion work', async () => {
    const f = await sharedFixture();
    await f.authority.send({ projectId: 'project', title: 'Direct', text: 'Direct work', requestId: 'direct' });
    await f.runtime.check();
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1);
    expect((await f.runtime.status()).runs[0].failure.stage).toBe('dispatch');
    await f.runtime.check();
    expect(f.team.send).toHaveBeenCalledTimes(1); // denied admission is never automatically retried
    f.teamExecutor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nDirect result' });
    f.teamExecutor.evidence.mockImplementation(async (run) => ({ artifacts: [], usage: { kind: 'available', tokens: 100, reportedCost: 0, sessionIds: [run.sessionId], dollarCapSupported: false } }));
    await f.authority.check();
    f.row.status = 'Ready for AI';
    await f.runtime.check();
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1); // shared lifetime guardrail also rejects new Notion work
    expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('prevents direct sends while a Notion shared run is active', async () => {
    const f = await sharedFixture(); await f.runtime.check();
    await expect(f.authority.send({ projectId: 'project', title: 'Direct', text: 'Direct work', requestId: 'direct' })).rejects.toThrow('current team run');
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1);
  });
  it('recovers after shared dispatch before Notion identity save without resending', async () => {
    const f = await sharedFixture();
    f.team.send.mockImplementationOnce(async (input) => { await f.authority.send(input); throw new Error('Response lost after durable shared send'); });
    await f.runtime.check();
    const saved = (await f.runtime.status()).runs[0];
    expect(saved.teamRunId).toBeUndefined(); expect(saved.failure.stage).toBe('dispatch');
    expect(saved.content).toBeUndefined();
    await f.runtime.close();
    const restarted = createAiTaskRuntime(f.options); cleanup.push(() => restarted.close());
    f.teamExecutor.inspect.mockResolvedValue(reviewedShared('Shared result'));
    await f.authority.check(); await restarted.check();
    expect((await restarted.status()).runs[0]).toMatchObject({ phase: 'done', content: reviewedShared('Shared result').content, teamRunId: expect.any(String) });
    expect(f.team.getRun).toHaveBeenCalledWith({ projectId: 'project', requestId: saved.teamRequestId });
    expect(f.team.send).toHaveBeenCalledTimes(1); expect(f.teamExecutor.send).toHaveBeenCalledTimes(1); expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('keeps historical runs on the legacy executor even when shared authority is injected', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check(); await f.runtime.close();
    const team = { send: vi.fn(), details: vi.fn(), getRun: vi.fn() };
    const restarted = createAiTaskRuntime({ ...f.options, team }); cleanup.push(() => restarted.close());
    f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nLegacy' });
    await restarted.check();
    expect((await restarted.status()).runs[0].phase).toBe('done');
    expect(f.executor.send).toHaveBeenCalledTimes(1); expect(f.executor.inspect).toHaveBeenCalledTimes(1);
    expect(team.send).not.toHaveBeenCalled(); expect(team.details).not.toHaveBeenCalled(); expect(team.getRun).not.toHaveBeenCalled();
  });
  it('freezes the shared writeback revision across retries and never substitutes a later answer', async () => {
    const f = await sharedFixture(); await f.runtime.check();
    f.teamExecutor.inspect.mockResolvedValue(reviewedShared('First answer'));
    await f.authority.check();
    f.notion.finish.mockRejectedValueOnce(new Error('Notion offline'));
    await f.runtime.check();
    const first = (await f.runtime.status()).runs[0];
    expect(first.phase).toBe('result'); expect(first.writebackFailure.stage).toBe('writeback');
    f.team.details.mockImplementation(async (input) => {
      const details = await f.authority.details(input);
      return { ...details, runs: details.runs.map((run) => ({ ...run, revision: run.revision + 1, content: 'DONE\nReviewed answer' })) };
    });
    await f.runtime.check();
    expect(f.notion.finish.mock.calls.at(-1)[0]).toMatchObject({ content: reviewedShared('First answer').content, teamRevision: first.teamRevision });
    expect((await f.runtime.status()).runs[0]).toMatchObject({ phase: 'done', content: reviewedShared('First answer').content });
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1); expect(f.executor.inspect).not.toHaveBeenCalled(); expect(f.team.check).not.toHaveBeenCalled();
  });
  it('preserves the shared failure stage without claiming no prompt was sent', async () => {
    const f = await sharedFixture(); f.teamExecutor.send.mockRejectedValueOnce(new Error('Lost after prompt'));
    await f.runtime.check();
    const run = (await f.runtime.status()).runs[0];
    expect(run.failure.stage).toBe('dispatch'); expect(run.teamRunId).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain('No task prompt was sent');
    await f.runtime.check();
    expect(f.teamExecutor.send).toHaveBeenCalledTimes(1); expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('keeps ambiguous dispatch tracking when lookup fails and does not treat failure as missing', async () => {
    const f = await sharedFixture();
    f.team.send.mockImplementationOnce(async (input) => { await f.authority.send(input); throw new Error('Lost response'); });
    await f.runtime.check();
    f.team.getRun.mockRejectedValueOnce(new Error('Lookup offline'));
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0]).toMatchObject({ phase: 'running', failure: { stage: 'inspect' } });
    expect(f.notion.finish).not.toHaveBeenCalled(); expect(f.team.send).toHaveBeenCalledTimes(1);
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].teamRunId).toBeTruthy();
  });
  it('does not fall back to legacy inspection if injection is removed on restart', async () => {
    const f = await sharedFixture(); await f.runtime.check(); await f.runtime.close();
    const restarted = createAiTaskRuntime({ ...f.options, team: undefined }); cleanup.push(() => restarted.close());
    await restarted.check();
    expect((await restarted.status()).runs[0]).toMatchObject({ phase: 'running', failure: { stage: 'inspect' } });
    expect(f.executor.inspect).not.toHaveBeenCalled(); expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('respects user moves during shared result writeback and requires a fresh Ready intake', async () => {
    const f = await sharedFixture(); await f.runtime.check();
    f.teamExecutor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nResult' });
    await f.authority.check(); f.row.status = 'Parked'; await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('cancelled');
    f.row.status = 'Ready for AI'; await f.runtime.check();
    const runs = (await f.runtime.status()).runs;
    expect(runs[1].teamRunId).not.toBe(runs[0].teamRunId);
    expect(f.team.send).toHaveBeenCalledTimes(2); expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('refuses shared intake before Notion or model calls under host policy', async () => {
    const f = await sharedFixture(); f.notion.readBoard.mockClear(); f.block();
    await expect(f.runtime.check()).rejects.toThrow('policy');
    expect(f.notion.readBoard).not.toHaveBeenCalled(); expect(f.team.send).not.toHaveBeenCalled(); expect(f.teamExecutor.send).not.toHaveBeenCalled();
  });
});

describe('AI task durable coordinator', () => {
  it('is off by default and idle checks do not call the model', async () => {
    const f = await fixture();
    await f.runtime.check();
    expect(f.notion.readBoard).not.toHaveBeenCalled();
    expect(f.executor.create).not.toHaveBeenCalled();
    await f.runtime.configure(config);
    f.board.rows = [];
    await f.runtime.check();
    expect(f.executor.create).not.toHaveBeenCalled();
  });
  it('validates status mapping before enabling and keeps previous configuration on failure', async () => {
    const f = await fixture(); f.board.columns = ['Done'];
    await expect(f.runtime.configure(config)).rejects.toThrow('statuses');
    expect((await f.runtime.status()).config.enabled).toBe(false);
  });
  it('persists claims and session identity before dispatch, and serializes concurrent checks', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.executor.create.mockImplementation(async () => {
      const stored = JSON.parse(await readFile(f.filePath, 'utf8'));
      expect(stored.runs[0].phase).toBe('claimed');
      return { id: 'ses_task', directory: '/workspace' };
    });
    f.executor.send.mockImplementation(async () => {
      const stored = JSON.parse(await readFile(f.filePath, 'utf8'));
      expect(stored.runs[0].sessionId).toBe('ses_task');
      expect(stored.runs[0].phase).toBe('running');
    });
    await Promise.all([f.runtime.check(), f.runtime.check()]);
    expect(f.executor.send).toHaveBeenCalledTimes(1);
  });
  it('recovers an ambiguous prompt without redispatch after restart', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.executor.send.mockRejectedValueOnce(new Error('Connection lost after send'));
    await f.runtime.check(); await f.runtime.close();
    const restarted = createAiTaskRuntime(f.options);
    cleanup.push(() => restarted.close());
    f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nResult' });
    await restarted.check();
    expect(f.executor.send).toHaveBeenCalledTimes(1);
    expect(f.notion.finish).toHaveBeenCalledTimes(1);
    expect((await restarted.status()).runs[0].phase).toBe('done');
  });
  it('does not call a partially claimed task twice', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.executor.create.mockRejectedValueOnce(new Error('Unavailable'));
    await f.runtime.check(); await f.runtime.check();
    expect(f.executor.create).toHaveBeenCalledTimes(1);
    expect(f.executor.send).not.toHaveBeenCalled();
    expect((await f.runtime.status()).runs[0].phase).toBe('needs-you');
    expect((await f.runtime.status()).runs[0].failure.stage).toBe('create');
    expect((await f.runtime.details((await f.runtime.status()).runs[0].id)).children).toEqual({ kind: 'loaded', items: [] });
  });
  it('keeps safe HTTP diagnostics durably without exporting error bodies or credentials', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.executor.create.mockRejectedValueOnce({ cause: { status: 500 }, message: 'Bearer secret credential and private prompt', body: 'private' });
    await f.runtime.check();
    const status = await f.runtime.status();
    expect(status.runs[0].failure).toMatchObject({ stage: 'create', code: 'http_500', message: 'OpenCode or Notion returned HTTP 500.' });
    expect(JSON.stringify(status)).not.toContain('secret');
    await f.runtime.close();
    const restarted = createAiTaskRuntime(f.options); cleanup.push(() => restarted.close());
    expect((await restarted.details(status.runs[0].id)).run.failure.code).toBe('http_500');
    expect(f.executor.send).not.toHaveBeenCalled();
  });
  it('does not repeat a failed claim while its card remains Ready, until the folder is explicitly reassigned', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.notion.claim.mockRejectedValueOnce(new Error('No response'));
    await f.runtime.check(); await f.runtime.check(); f.advance(); await f.runtime.check();
    expect(f.notion.claim).toHaveBeenCalledTimes(1);
    expect(f.executor.send).not.toHaveBeenCalled();
    await f.runtime.assign({ page: f.row.url, projectId: 'project' }); await f.runtime.check();
    expect(f.notion.claim).toHaveBeenCalledTimes(2);
  });
  it('records task-content failures even before a chat can exist', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.notion.readTask.mockRejectedValueOnce(new Error('Incomplete page'));
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0]).toMatchObject({ phase: 'needs-you', failure: { stage: 'read-task' } });
    expect(f.executor.create).not.toHaveBeenCalled();
  });
  it('preserves claim diagnostics and its retry lock when result writeback also fails', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    f.notion.claim.mockRejectedValueOnce({ cause: { status: 500 } });
    f.notion.finish.mockRejectedValueOnce(new Error('Your Notion connection does not allow this action.'));
    await f.runtime.check();
    const run = (await f.runtime.status()).runs[0];
    expect(run.failure).toMatchObject({ stage: 'claim', code: 'http_500' });
    expect(run.writebackFailure).toMatchObject({ stage: 'writeback', code: 'notion_access' });
    await f.runtime.check(); f.advance(); await f.runtime.check();
    expect(f.notion.claim).toHaveBeenCalledTimes(1);
    expect((await f.runtime.status()).runs[0].writebackFailure).toBeUndefined();
    expect((await f.runtime.status()).runs[0].failure.code).toBe('http_500');
  });
  it('will not pick up an unassigned card or use the legacy board model', async () => {
    const f = await fixture(); await writeFile(f.filePath, '{}');
    await f.runtime.configure(config); await f.runtime.check();
    expect(f.executor.create).not.toHaveBeenCalled();
    expect((await f.runtime.status()).error).toContain('folder');
    await f.runtime.assign({ page: f.row.url, projectId: 'project' });
    await f.runtime.check();
    expect(f.executor.create.mock.calls[0][0]).toMatchObject({ destination: { projectId: 'project', agent: 'manager' } });
    expect(f.executor.create.mock.calls[0][0]).not.toHaveProperty('model');
  });
  it('assignments validate membership and project, survive restart, and cannot reroute active work', async () => {
    const f = await fixture(); await f.runtime.configure(config);
    await expect(f.runtime.assign({ page: 'other', projectId: 'project' })).rejects.toThrow('board');
    await expect(f.runtime.assign({ page: f.row.url, projectId: 'missing' })).rejects.toThrow('existing');
    await f.runtime.assign({ page: f.row.url, projectId: 'project' }); await f.runtime.close();
    const restarted = createAiTaskRuntime(f.options); cleanup.push(() => restarted.close());
    expect((await restarted.status()).assignments[0].projectId).toBe('project');
    await restarted.check();
    await expect(restarted.assign({ page: f.row.url, projectId: 'project' })).rejects.toThrow('finish');
  });
  it('loads children from the recorded run directory and never from the currently selected project', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check();
    f.executor.children.mockResolvedValue([{ id: 'child', title: 'Research', directory: '/child' }]);
    const run = (await f.runtime.status()).runs[0];
    expect((await f.runtime.details(run.id)).children.items[0].id).toBe('child');
    expect(f.executor.children).toHaveBeenCalledWith(expect.objectContaining({ directory: run.directory, sessionId: 'ses_task' }));
    f.executor.children.mockRejectedValueOnce(new Error('offline'));
    const partial = await f.runtime.details(run.id);
    expect(partial.run.sessionId).toBe('ses_task');
    expect(partial.children.kind).toBe('failed');
  });
  it('retries only result writeback and only marks Done after confirmed writeback', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check();
    f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nResult' });
    f.notion.finish.mockRejectedValueOnce(new Error('Notion offline'));
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('result');
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('done');
    expect(f.executor.send).toHaveBeenCalledTimes(1);
    expect(f.executor.inspect).toHaveBeenCalledTimes(1);
  });
  it('respects user moves and lets a fresh Ready move authorize another run', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check();
    f.row.status = 'Parked'; f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nResult' });
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('cancelled');
    f.row.status = 'Ready for AI';
    await f.runtime.check();
    expect(f.executor.send).toHaveBeenCalledTimes(2);
  });
  it('pausing stops new pickups while existing tasks still reconcile', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check();
    await f.runtime.configure({ ...config, enabled: false });
    f.executor.inspect.mockResolvedValue({ kind: 'done', content: 'DONE\nResult' });
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('done');
    expect(f.executor.create).toHaveBeenCalledTimes(1);
  });
  it('does not treat permission waits as completion', async () => {
    const f = await fixture(); await f.runtime.configure(config); await f.runtime.check(); f.advance(); f.advance(); f.advance();
    await f.runtime.check();
    expect((await f.runtime.status()).runs[0].phase).toBe('running');
    expect(f.notion.finish).not.toHaveBeenCalled();
  });
  it('refuses policy-blocked setup, reads, creation, and dispatch before network egress', async () => {
    const f = await fixture(); f.block();
    for (const work of [() => f.runtime.status(), () => f.runtime.configure(config), () => f.runtime.check(), () => f.runtime.createBoard(), () => f.runtime.projects(), () => f.runtime.assign({ page: f.row.url, projectId: 'project' }), () => f.runtime.details('run')]) await expect(work()).rejects.toThrow('policy');
    expect(f.notion.readBoard).not.toHaveBeenCalled(); expect(f.notion.createBoard).not.toHaveBeenCalled(); expect(f.executor.create).not.toHaveBeenCalled();
  });
  it('a malformed tracking file fails closed instead of forgetting dispatched work', async () => {
    const f = await fixture(); await writeFile(f.filePath, '{broken');
    await expect(f.runtime.check()).rejects.toThrow('tracking');
    expect(f.executor.create).not.toHaveBeenCalled();
  });
  it('persists ambiguous board creation and refuses to create a duplicate', async () => {
    const f = await fixture(); f.notion.createBoard.mockRejectedValueOnce(new Error('Lost response'));
    await expect(f.runtime.createBoard()).rejects.toThrow();
    await expect(f.runtime.createBoard()).rejects.toThrow('already exists');
    expect((await f.runtime.status()).provisioning).toBe(true);
    await f.runtime.configure({ ...config, enabled: false });
    expect((await f.runtime.status()).provisioning).toBe(false);
  });
  it('a disconnected creation preflight leaves creation available after reconnect', async () => {
    const f = await fixture(); f.notion.prepareCreateBoard.mockRejectedValueOnce(new Error('Connect Notion first'));
    await expect(f.runtime.createBoard()).rejects.toThrow('Connect Notion');
    expect((await f.runtime.status()).provisioning).toBe(false);
    await f.runtime.createBoard();
    expect(f.notion.createBoard).toHaveBeenCalledTimes(1);
  });
  it('creates a private board without automatically enabling execution', async () => {
    const f = await fixture(); await f.runtime.createBoard();
    const status = await f.runtime.status();
    expect(status.config.board).toBe('collection://ai'); expect(status.config.enabled).toBe(false);
    await expect(f.runtime.createBoard()).rejects.toThrow('already exists');
  });
});

describe('OpenCode task executor', () => {
  const make = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-project-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const projects = [{ id: 'project', path: directory, label: 'Research', defaultModel: '', defaultVariant: '' }];
    const agents = [
      { id: 'manager', name: 'Manager', mode: 'all', hidden: false, permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: 'private/**', effect: 'deny' }] },
      { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false, permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] },
    ];
    const client = {
      agent: { list: vi.fn(async () => ({ data: agents })) },
      model: { default: vi.fn(async () => ({ data: { id: 'model', providerID: 'provider' } })), list: vi.fn(async () => ({ data: [{ id: 'model', providerID: 'provider' }] })) },
      session: { create: vi.fn(async () => ({ id: 'ses_task', location: { directory: '/canonical' } })), get: vi.fn(async () => ({ id: 'ses_task', location: { directory: '/canonical' }, outcome: 'succeeded' })), active: vi.fn(async () => ({})), prompt: vi.fn(async () => ({})), list: vi.fn(async () => ({ data: [], cursor: {} })) },
      message: { list: vi.fn(async () => ({ data: [{ type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [{ type: 'text', text: 'DONE\nAnswer' }, { type: 'reasoning', text: 'Private reasoning' }] }] })) },
    };
    const scopes = [];
    const executor = createAiTaskExecutor({ readProjects: async () => projects, getClient: (scope) => { scopes.push(scope); return client; } });
    return { executor, client, projects, agents, scopes, directory };
  };
  const run = { sessionId: 'ses_task', directory: '/canonical', title: 'Task' };
  it('uses explicit permissions and the server-confirmed session directory', async () => {
    const f = await make(); const destination = await f.executor.resolveProject('project');
    const session = await f.executor.create({ title: 'Task', destination, runId: 'run' });
    expect(session.directory).toBe('/canonical');
    const input = f.client.session.create.mock.calls[0][0];
    expect(input.permissions).toContainEqual({ action: '*', resource: '*', effect: 'ask' });
    expect(input.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'deny' });
    expect(input.model).toEqual({ providerID: 'provider', id: 'model' });
    expect(input.agent).toBe('manager');
    expect(input.location.directory).toBe(f.directory);
    expect(input.permissions).toContainEqual({ action: 'read', resource: 'private/**', effect: 'deny' });
    expect(input.permissions).toContainEqual({ action: 'subagent', resource: 'explore', effect: 'ask' });
  });
  it('uses the folder model, not a global or specialist default, and fails closed on missing setup', async () => {
    const f = await make(); f.projects[0].defaultModel = 'provider/model';
    expect((await f.executor.resolveProject('project')).model).toEqual({ providerID: 'provider', id: 'model' });
    expect(f.client.model.default).not.toHaveBeenCalled();
    expect(f.scopes.every((scope) => scope === f.directory)).toBe(true);
    await expect(f.executor.resolveProject('missing')).rejects.toThrow('existing project');
    f.projects[0].path = path.join(f.directory, 'missing');
    await expect(f.executor.resolveProject('project')).rejects.toThrow('unavailable');
    f.projects[0].path = f.directory; f.agents.shift();
    await expect(f.executor.resolveProject('project')).rejects.toThrow('manager');
    expect(f.client.session.create).not.toHaveBeenCalled();
  });
  it('refuses missing models and variants without inventing a workspace', async () => {
    const f = await make(); f.client.model.default.mockResolvedValueOnce({ data: null });
    await expect(f.executor.resolveProject('project')).rejects.toThrow('default model');
    f.projects[0].defaultVariant = 'invalid';
    await expect(f.executor.resolveProject('project')).rejects.toThrow('variant');
    expect(f.client.session.create).not.toHaveBeenCalled();
  });
  it('blocks provider-changing or write-capable specialists and keeps project delegation denials', async () => {
    const f = await make(); f.agents[1].model = { providerID: 'other', id: 'model' };
    const rules = () => f.executor.resolveProject('project').then((destination) => destination.permissions);
    expect(await rules()).not.toContainEqual({ action: 'subagent', resource: 'explore', effect: 'ask' });
    delete f.agents[1].model;
    f.agents[1].permissions.push({ action: 'shell', resource: 'curl *', effect: 'allow' });
    expect(await rules()).not.toContainEqual({ action: 'subagent', resource: 'explore', effect: 'ask' });
    f.agents[1].permissions.pop(); f.agents[0].permissions.push({ action: 'subagent', resource: 'explore', effect: 'deny' });
    expect(await rules()).not.toContainEqual({ action: 'subagent', resource: 'explore', effect: 'ask' });
  });
  it('paginates real child history and rejects cross-directory or wrong-parent results', async () => {
    const f = await make();
    f.client.session.list.mockResolvedValueOnce({ data: [{ id: 'child', title: 'Research', parentID: run.sessionId, location: { directory: run.directory } }], cursor: { next: 'next' } });
    expect(await f.executor.children(run)).toEqual([{ id: 'child', title: 'Research', directory: run.directory }]);
    expect(f.client.session.list.mock.calls[1][0].cursor).toBe('next');
    f.client.session.list.mockResolvedValueOnce({ data: [{ id: 'child', title: 'Research', parentID: run.sessionId, location: { directory: '/other' } }], cursor: {} });
    await expect(f.executor.children(run)).rejects.toThrow('scope');
  });
  it('exports final text only, never reasoning or tool content', async () => {
    const f = await make(); expect(await f.executor.inspect(run)).toEqual({ kind: 'done', content: 'DONE\nAnswer' });
  });
  it('requires successful outcome, completed stop answer, and the explicit DONE marker', async () => {
    const f = await make(); f.client.session.get.mockResolvedValueOnce({ id: 'ses_task', location: { directory: '/canonical' }, outcome: 'interrupted' });
    expect((await f.executor.inspect(run)).kind).toBe('needs-you');
    f.client.message.list.mockResolvedValueOnce({ data: [{ type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [{ type: 'text', text: 'NEEDS YOU\nApproval required' }] }] });
    expect((await f.executor.inspect(run)).kind).toBe('needs-you');
  });
  it('does not treat a failed activity read or a tool-call step as success', async () => {
    const f = await make(); f.client.session.active.mockRejectedValueOnce(new Error('Offline'));
    await expect(f.executor.inspect(run)).rejects.toThrow('Offline');
    f.client.message.list.mockResolvedValueOnce({ data: [{ type: 'assistant', time: { completed: 1 }, finish: 'tool-calls', content: [{ type: 'text', text: 'DONE' }] }] });
    expect((await f.executor.inspect(run)).kind).toBe('needs-you');
  });
});
