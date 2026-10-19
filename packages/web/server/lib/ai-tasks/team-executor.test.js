import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createTeamExecutor } from './team-executor.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture({ version = 1, verifyFreeExecution, verifyTeamTool } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-executor-')));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, '.openchamber'));
  await writeFile(path.join(directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 1, manager: 'manager', providers: ['openai'], specialists: ['reader'] }));
  await writeFile(path.join(directory, 'result.md'), 'Actual deliverable');
  const permissions = [
    { action: '*', resource: '*', effect: 'allow' }, // inherited default, superseded below
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: `${directory}/**`, effect: 'ask' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ];
  const agents = [{ id: 'manager', name: 'Manager', mode: 'primary', hidden: false, steps: 12, permissions: [...permissions, { action: 'subagent', resource: 'reader', effect: 'ask' }] },
    { id: 'reader', name: 'Reader', mode: 'subagent', hidden: false, steps: 6, permissions: [...permissions] }];
  const policies = [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'openai', effect: 'allow' }];
  const counters = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };
  const parent = { id: 'ses_parent', title: 'Manager', location: { directory }, agent: 'manager', model: { providerID: 'openai', id: 'test' }, tokens: counters, cost: 0.1, outcome: 'succeeded' };
  const child = { ...parent, id: 'ses_child', parentID: parent.id, title: 'Reader', agent: 'reader' };
  const sessions = new Map([[parent.id, parent], [child.id, child]]);
  const client = {
    model: { list: vi.fn(async () => ({ data: [{ providerID: 'openai', id: 'test' }] })) },
    agent: { list: vi.fn(async () => ({ data: agents })) },
    config: { get: vi.fn(async () => [{ type: 'document', info: { experimental: { policies } } }]) },
    plugin: { list: vi.fn(async () => ({ data: [{ id: 'open-carter-free-team-guard', features: { server: true }, state: { status: 'active' } }] })) },
    session: {
      create: vi.fn(async () => parent), prompt: vi.fn(async () => {}), get: vi.fn(async input => sessions.get(input.sessionID)),
      list: vi.fn(async () => ({ data: [child], cursor: { next: null } })), active: vi.fn(async () => ({})), interrupt: vi.fn(async () => {}),
    },
    message: { list: vi.fn(async () => ({ data: [{ id: 'msg', type: 'assistant', finish: 'stop', time: { completed: 1 }, content: [{ type: 'text', text: 'DONE\nVerified.' }], snapshot: { files: ['result.md'] } }], cursor: { next: null } })) },
  };
  if (version === 2) {
    if (verifyTeamTool) client.plugin.list.mockResolvedValue({ data: [
      { id: 'open-carter-free-team-guard', features: { server: true }, state: { status: 'active' } },
      { id: 'openchamber-team-tools', features: { server: true }, state: { status: 'active' } },
    ] });
    await writeFile(path.join(directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: parent.model, freeOnly: true, paidFallback: false,
      specialists: [{ id: 'reader', capabilities: ['read-project'] }] }));
    const v2Rules = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'ask' },
      { action: 'read', resource: '../*', effect: 'deny' }, { action: 'read', resource: '/*', effect: 'deny' }, { action: 'read', resource: '?:/*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' }];
    agents[0].permissions = [...v2Rules, { action: 'subagent', resource: 'reader', effect: 'ask' }];
    agents[1].permissions = [...v2Rules];
    for (const id of ['title', 'summary', 'compaction']) agents.push({ id, name: id, mode: 'primary', hidden: true,
      permissions: [{ action: '*', resource: '*', effect: 'deny' }], model: parent.model });
    client.model.list.mockResolvedValue({ data: [{ ...parent.model, enabled: true, capabilities: { tools: true }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] });
    parent.cost = 0; child.cost = 0;
  }
  const projects = [{ id: 'project', path: directory, defaultModel: 'openai/test' }];
  const executor = createTeamExecutor({ readProjects: async () => projects, getClient: () => client, verifyFreeExecution, verifyTeamTool });
  const run = { projectId: 'project', directory, sessionId: parent.id, title: 'Review', children: [] };
  return { executor, client, run, directory, agents, policies, parent, child, projects, sessions };
}

describe('directory-scoped team execution policy', () => {
  it('authorizes reads only from fresh complete current-team output receipts and an admitted reader model', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: async () => true, verifyTeamTool: async () => true });
    await mkdir(path.join(f.directory, 'team-output'));
    const file = path.join(f.directory, 'team-output/review.md');
    const content = 'A fixture deliverable for independent inspection.';
    await writeFile(file, content);
    const receipt = { version: 1, path: file, relativePath: 'team-output/review.md', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: f.parent.model, freeOnly: true, paidFallback: false,
      specialists: [{ id: 'reader', capabilities: ['read-output'] }] }));
    f.agents[1].permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'team_read_output', resource: '*', effect: 'allow' },
      { action: 'read', resource: '../*', effect: 'deny' }, { action: 'read', resource: '/*', effect: 'deny' }, { action: 'read', resource: '?:/*', effect: 'deny' }, { action: 'external_directory', resource: '*', effect: 'deny' }];
    const outputMessage = { id: 'msg_output', type: 'assistant', content: [{ type: 'tool', id: 'call_output', name: 'team_output', state: { status: 'completed', content: [{ type: 'text', text: JSON.stringify(receipt) }] } }] };
    f.client.message.list.mockImplementation(async ({ sessionID }) => ({ data: sessionID === f.child.id ? [outputMessage] : [], cursor: { next: null } }));
    const destination = await f.executor.resolveProject('project');
    Object.assign(f.run, { policyRevision: destination.policyRevision, model: destination.model });
    const input = { action: 'team_read_output', sessionID: f.child.id, input: { filename: 'review.md' } };
    expect(await f.executor.authorizeTool(f.run, input)).toMatchObject({ directory: f.directory, receipt: { path: file, sha256: receipt.sha256, sizeBytes: receipt.bytes, verified: true, sessionId: f.child.id } });
    // A byte-verified snapshot, saved artifact or caller receipt is not a fresh
    // completed output-tool receipt belonging to this run.
    f.run.artifacts = [{ path: file, sha256: receipt.sha256, sizeBytes: receipt.bytes, verified: true, sessionId: 'old_child', messageId: 'old' }];
    f.client.message.list.mockResolvedValue({ data: [{ id: 'snapshot', type: 'assistant', time: { completed: 1 }, snapshot: { files: ['team-output/review.md'] } }], cursor: { next: null } });
    await expect(f.executor.authorizeTool(f.run, input)).rejects.toMatchObject({ code: 'teamScope' });
    f.client.message.list.mockResolvedValue({ data: [outputMessage] });
    await expect(f.executor.authorizeTool(f.run, input)).rejects.toMatchObject({ code: 'teamScope' });
    f.client.message.list.mockImplementation(async ({ sessionID }) => ({ data: sessionID === f.child.id ? [outputMessage] : [], cursor: { next: null } }));
    f.child.model = { providerID: 'opencode', id: 'different' };
    await expect(f.executor.authorizeTool(f.run, input)).rejects.toMatchObject({ code: 'teamScope' });
    f.child.model = f.parent.model;
    await writeFile(file, 'Changed bytes');
    await expect(f.executor.authorizeTool(f.run, input)).rejects.toMatchObject({ code: 'teamScope' });
  });
  it('verifies create-only output receipts against real bytes and rejects changed content', async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, 'team-output'));
    const target = path.join(f.directory, 'team-output/result.md');
    await writeFile(target, 'Verified result');
    const receipt = { version: 1, path: target, relativePath: 'team-output/result.md', bytes: 15, sha256: createHash('sha256').update('Verified result').digest('hex') };
    f.client.message.list.mockResolvedValue({ data: [{ id: 'msg_output', type: 'assistant', content: [{ type: 'tool', id: 'call_output', name: 'team_output', state: { status: 'completed', content: [{ type: 'text', text: JSON.stringify(receipt) }] } }] }] });
    expect((await f.executor.evidence(f.run)).artifacts[0]).toMatchObject({ path: target, sha256: receipt.sha256, verified: true });
    await writeFile(target, 'Changed result');
    await expect(f.executor.evidence(f.run)).rejects.toMatchObject({ code: 'teamScope' });
  });
  it('admits bounded scoped children after inherited defaults are explicitly denied', async () => {
    const f = await fixture(); const destination = await f.executor.resolveProject('project');
    expect(destination.specialists).toEqual(['reader']);
    expect(destination.permissions).toContainEqual({ action: 'read', resource: `${f.directory}/**`, effect: 'ask' });
    expect(destination.permissions.filter(rule => rule.action === '*' && rule.resource === '*')).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    expect(destination.permissions).toContainEqual({ action: 'external_directory', resource: '*', effect: 'deny' });
  });
  it('rejects unknown projects and missing policy without choosing a fallback', async () => {
    const f = await fixture(); await expect(f.executor.resolveProject('other')).rejects.toMatchObject({ code: 'project' });
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), '{}');
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamPolicy' });
    expect(f.client.session.create).not.toHaveBeenCalled();
  });
  it('rejects unbounded managers and unsafe child tools, scope and model', async () => {
    const f = await fixture(); const manager = f.agents[0]; manager.steps = 21;
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamManager' }); manager.steps = 12;
    const child = f.agents[1];
    for (const rule of [
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'subagent', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ]) { child.permissions.push(rule); await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' }); child.permissions.pop(); }
    child.model = { providerID: 'forbidden', id: 'other' };
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' });
  });
  it('requires provider enforcement and rejects expanded provider allowances', async () => {
    const f = await fixture(); f.policies.shift();
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamProvider' });
    f.policies.unshift({ action: 'provider.use', resource: '*', effect: 'deny' });
    f.policies.push({ action: 'provider.use', resource: 'forbidden', effect: 'allow' });
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamProvider' });
  });
  it('revalidates policy revisions before creation and sending', async () => {
    const f = await fixture(); const destination = await f.executor.resolveProject('project');
    await writeFile(path.join(f.directory, 'AGENTS.md'), 'New project rules');
    await expect(f.executor.create({ title: 'Review', destination, runId: 'run' })).rejects.toMatchObject({ code: 'teamPolicy' });
    await expect(f.executor.send({ ...f.run, policyRevision: destination.policyRevision }, 'Review')).rejects.toMatchObject({ code: 'teamPolicy' });
    expect(f.client.session.create).not.toHaveBeenCalled(); expect(f.client.session.prompt).not.toHaveBeenCalled();
  });
  it('records the normalized effective default in the root metadata at creation', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: async () => true });
    const destination = await f.executor.resolveProject('project');
    expect(destination.teamModel).toEqual({ providerID: 'openai', id: 'test' });
    await f.executor.create({ title: 'Fixture', destination, runId: 'run-fixture' });
    expect(f.client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'openai', id: 'test' },
      metadata: { aiTaskRunId: 'run-fixture', aiTaskModel: { providerID: 'openai', id: 'test' } },
    }), expect.anything());
  });
  it('revalidates a legacy frozen model without overriding the fixed project default', async () => {
    const f = await fixture(); const model = { providerID: 'openai', id: 'test' };
    const destination = await f.executor.resolveProject('project', model);
    await f.executor.create({ title: 'Fixture', destination, runId: 'legacy-fixture' });
    expect(f.client.session.create.mock.calls[0][0].metadata).toEqual({ aiTaskRunId: 'legacy-fixture' });
    f.projects[0].defaultModel = 'openai/changed';
    f.client.model.list.mockResolvedValue({ data: [{ providerID: 'openai', id: 'changed' }] });
    await expect(f.executor.resolveProject('project', model)).rejects.toMatchObject({ code: 'teamProvider' });
    expect(f.projects[0].defaultModel).toBe('openai/changed');
  });
  it('reads actual direct children and sums authoritative parent and child usage', async () => {
    const f = await fixture(); const destination = await f.executor.resolveProject('project'); f.run.policyRevision = destination.policyRevision;
    expect(await f.executor.children(f.run)).toEqual([{ id: 'ses_child', title: 'Reader', directory: f.directory }]);
    const evidence = await f.executor.evidence(f.run);
    expect(evidence.usage).toMatchObject({ kind: 'available', tokens: 42, reportedCost: 0.2, sessionIds: ['ses_parent', 'ses_child'], dollarCapSupported: false });
    expect(evidence.artifacts[1]).toMatchObject({ path: path.join(f.directory, 'result.md'), sessionId: 'ses_child', messageId: 'msg' });
    expect(evidence.artifacts[1]).toMatchObject({ verified: true, sizeBytes: 18, sha256: createHash('sha256').update('Actual deliverable').digest('hex') });
  });
  it('rejects child project, parent and provider mismatches', async () => {
    const f = await fixture(); f.child.location = { directory: '/other' };
    await expect(f.executor.children(f.run)).rejects.toThrow('scope mismatch'); f.child.location = { directory: f.directory };
    f.child.parentID = 'other'; await expect(f.executor.children(f.run)).rejects.toThrow('scope mismatch'); f.child.parentID = f.parent.id;
    f.child.model = { providerID: 'forbidden', id: 'test' };
    await expect(f.executor.children(f.run)).rejects.toMatchObject({ code: 'teamScope' });
  });
  it('does not report completion while a real child is active', async () => {
    const f = await fixture(); f.client.session.active.mockResolvedValue({ ses_child: { type: 'busy' } });
    expect(await f.executor.inspect(f.run)).toEqual({ kind: 'running' });
    expect(f.client.message.list).not.toHaveBeenCalled();
  });
  it('always attempts parent interruption even if child interruption fails', async () => {
    const f = await fixture(); f.client.session.interrupt.mockImplementation(async ({ sessionID }) => { if (sessionID === 'ses_child') throw new Error('Cannot stop child'); });
    await expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
    expect(f.client.session.interrupt.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_parent', 'ses_child']);
  });
  it('interrupts the parent before enumeration and catches a newly discovered child', async () => {
    const f = await fixture();
    const late = { ...f.child, id: 'ses_late' }; f.sessions.set(late.id, late);
    f.client.session.list.mockResolvedValueOnce({ data: [f.child], cursor: { next: null } })
      .mockResolvedValue({ data: [f.child, late], cursor: { next: null } });
    await f.executor.pause(f.run);
    expect(f.client.session.interrupt.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_parent', 'ses_child', 'ses_late']);
    expect(f.client.session.interrupt.mock.invocationCallOrder[0]).toBeLessThan(f.client.session.list.mock.invocationCallOrder[0]);
    expect(f.client.session.list).toHaveBeenCalledTimes(3);
    expect(f.client.session.active).toHaveBeenCalledTimes(1);
  });
  it('stops the parent and cached children but refuses proof when enumeration fails', async () => {
    const f = await fixture(); f.run.children = [{ id: f.child.id }];
    f.client.session.list.mockRejectedValue(new Error('Unavailable'));
    await expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
    expect(f.client.session.interrupt.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_parent', 'ses_child']);
  });
  it('still attempts child interruption when the parent interrupt fails', async () => {
    const f = await fixture();
    f.client.session.interrupt.mockImplementation(async ({ sessionID }) => { if (sessionID === f.parent.id) throw new Error('Unavailable'); });
    await expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
    expect(f.client.session.interrupt.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_parent', 'ses_child']);
  });
  it('refuses unknown authoritative activity instead of treating it as inactive', async () => {
    const f = await fixture();
    for (const active of [null, [], { ses_parent: null }]) {
      f.client.session.active.mockResolvedValue(active);
      await expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
    }
    f.client.session.active.mockRejectedValue(new Error('Unavailable'));
    await expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
  });
  it('bounds active or stalled interruption proof with one deadline', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    try {
      for (const id of [f.parent.id, f.child.id]) {
        f.client.session.active.mockResolvedValue({ [id]: { type: 'busy' } });
        const paused = expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
        await vi.advanceTimersByTimeAsync(5_000); await paused;
        expect(f.client.session.active).toHaveBeenCalled();
      }
      f.client.session.interrupt.mockImplementation(() => new Promise(() => {}));
      const paused = expect(f.executor.pause(f.run)).rejects.toMatchObject({ code: 'teamPause' });
      await vi.advanceTimersByTimeAsync(5_000); await paused;
    } finally { vi.useRealTimers(); }
  });
  it('waits for interruption acknowledgement to become authoritatively inactive', async () => {
    const f = await fixture();
    f.client.session.active.mockResolvedValueOnce({ ses_child: { type: 'busy' } }).mockResolvedValue({});
    await f.executor.pause(f.run);
    expect(f.client.session.active).toHaveBeenCalledTimes(2);
    expect(f.client.session.list).toHaveBeenCalledTimes(3);
  });
  it('paginates actual receipts and explicitly marks bounded or unknown history partial', async () => {
    const f = await fixture();
    const handoff = { id: 'old_receipt', type: 'assistant', content: [{ type: 'tool', id: 'real_call', name: 'subagent', state: { status: 'completed' } }] };
    f.client.message.list.mockImplementation(async ({ cursor }) => cursor
      ? { data: [handoff], cursor: { next: null } }
      : { data: [], cursor: { next: 'older' } });
    const evidence = await f.executor.evidence(f.run);
    expect(evidence.handoffs).toEqual([{ sessionId: f.parent.id, messageId: handoff.id, toolId: 'real_call', status: 'completed' }]);
    expect(evidence.receiptScan).toEqual({ kind: 'complete', incompleteSessionIds: [] });
    expect(f.client.message.list.mock.calls[1][0]).toEqual({ sessionID: f.parent.id, cursor: 'older', limit: 100 });
    f.client.message.list.mockClear();
    f.client.message.list.mockImplementation(async () => ({ data: [handoff], cursor: { next: `page_${f.client.message.list.mock.calls.length}` } }));
    const partial = await f.executor.evidence(f.run);
    expect(partial.receiptScan).toEqual({ kind: 'partial', incompleteSessionIds: [f.parent.id, f.child.id] });
    expect(partial.handoffs).toHaveLength(1);
    expect(f.client.message.list).toHaveBeenCalledTimes(16);
    f.client.message.list.mockResolvedValue({ data: [handoff] });
    expect((await f.executor.evidence(f.run)).receiptScan.kind).toBe('partial');
    f.client.message.list.mockResolvedValue({ data: [handoff], cursor: { next: 'repeat' } });
    expect((await f.executor.evidence(f.run)).receiptScan.kind).toBe('partial');
    f.client.message.list.mockImplementation(async ({ cursor }) => {
      if (cursor) throw new Error('History unavailable');
      return { data: [handoff], cursor: { next: 'older' } };
    });
    const failedPage = await f.executor.evidence(f.run);
    expect(failedPage.receiptScan.kind).toBe('partial');
    expect(failedPage.handoffs).toHaveLength(1);
    expect(failedPage.usage.tokens).toBe(42);
  });
  it('rejects out-of-project artifact references instead of exposing them', async () => {
    const f = await fixture(); f.client.message.list.mockResolvedValue({ data: [{ id: 'msg', type: 'assistant', time: { completed: 1 }, snapshot: { files: ['../private.txt'] } }] });
    await expect(f.executor.evidence(f.run)).rejects.toMatchObject({ code: 'teamScope' });
  });
  it('rejects missing artifacts, directories and symlinks escaping the project', async () => {
    const f = await fixture();
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-artifact-')));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'private.md'), 'Private');
    await symlink(path.join(outside, 'private.md'), path.join(f.directory, 'escaped.md'));
    for (const file of ['missing.md', '.openchamber', 'escaped.md']) {
      f.client.message.list.mockResolvedValue({ data: [{ id: 'msg', type: 'assistant', time: { completed: 1 }, snapshot: { files: [file] } }] });
      await expect(f.executor.evidence(f.run)).rejects.toMatchObject({ code: 'teamScope' });
    }
  });
  it('collects completed real subagent tool evidence, never prose or guessed child links', async () => {
    const f = await fixture();
    f.client.message.list.mockResolvedValue({ data: [{ id: 'msg_tool', type: 'assistant', content: [
      { type: 'text', text: 'I handed this to reader in ses_invented.' },
      { type: 'reasoning', state: { reasoningField: 'reasoning' }, text: 'Not tool completion evidence.' },
      { type: 'tool', id: 'call_real', name: 'subagent', state: { status: 'completed' } },
      { type: 'tool', id: 'call_failed', name: 'subagent', state: { status: 'error' } },
    ] }] });
    expect((await f.executor.evidence(f.run)).handoffs).toEqual([{ sessionId: 'ses_parent', messageId: 'msg_tool', toolId: 'call_real', status: 'completed' }]);
  });
});

describe('free-only version 2 team policy', () => {
  it('keeps delegation approval unless the project definition explicitly allows it', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: async () => true });
    expect((await f.executor.resolveProject('project')).permissions).toContainEqual({ action: 'subagent', resource: 'reader', effect: 'ask' });
    f.agents[0].permissions.at(-1).effect = 'allow';
    expect((await f.executor.resolveProject('project')).permissions).toContainEqual({ action: 'subagent', resource: 'reader', effect: 'allow' });
  });
  const routingProof = vi.fn(async () => true);
  it('requires a trusted session-routing proof without rewriting maintenance defaults', async () => {
    const f = await fixture({ version: 2 });
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamProvider' });
    const ready = await fixture({ version: 2, verifyFreeExecution: routingProof });
    const destination = await ready.executor.resolveProject('project');
    expect(destination).toMatchObject({ policyVersion: 2, model: { providerID: 'openai', id: 'test' }, specialists: ['reader'] });
    expect(routingProof).toHaveBeenCalledWith(expect.objectContaining({ directory: ready.directory, model: { providerID: 'openai', id: 'test' },
      manager: { id: 'manager', permissions: destination.permissions }, specialists: destination.childPermissions }));
    ready.agents.find((agent) => agent.id === 'title').model = { providerID: 'openai', id: 'paid' };
    await expect(ready.executor.resolveProject('project')).resolves.toMatchObject({ policyVersion: 2 });
    expect(ready.client.session.create).not.toHaveBeenCalled();
  });
  it('requires the actual guard to be active with server hooks, not merely configured', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    for (const data of [[], [{ id: 'other', features: { server: true }, state: { status: 'active' } }],
      [{ id: 'open-carter-free-team-guard', features: { server: true }, state: { status: 'failed' } }],
      [{ id: 'open-carter-free-team-guard', features: {}, state: { status: 'active' } }]]) {
      f.client.plugin.list.mockResolvedValue({ data });
      await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamProvider' });
    }
    expect(f.client.session.create).not.toHaveBeenCalled();
  });
  it('does not require expanded global provider allowances or change the ordinary default', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    f.policies.push({ action: 'provider.use', resource: 'existing-other-provider', effect: 'allow' });
    await expect(f.executor.resolveProject('project')).resolves.toMatchObject({ model: { providerID: 'openai', id: 'test' } });
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: { providerID: 'free', id: 'exact' }, freeOnly: true, paidFallback: false, specialists: [] }));
    const selected = { providerID: 'free', id: 'exact' };
    f.agents.find((agent) => agent.id === 'manager').model = selected;
    f.agents.find((agent) => agent.id === 'manager').permissions = f.agents.find((agent) => agent.id === 'manager').permissions.filter((rule) => rule.action !== 'subagent');
    f.client.model.list.mockResolvedValue({ data: [{ providerID: 'openai', id: 'test' }, { ...selected, enabled: true, capabilities: { tools: true }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] });
    for (const agent of f.agents.filter((item) => item.hidden)) agent.model = selected;
    f.projects[0].defaultVariant = 'ordinary-only';
    await expect(f.executor.resolveProject('project')).resolves.toMatchObject({ model: selected });
    expect(f.projects[0]).toMatchObject({ defaultModel: 'openai/test', defaultVariant: 'ordinary-only' });
  });
  it('runs a task on its chosen reviewed zero-priced model and refuses anything else', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    const alternate = { providerID: 'openrouter', id: 'other:free' };
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: f.parent.model, models: [alternate], freeOnly: true, paidFallback: false,
      specialists: [{ id: 'reader', capabilities: ['read-project'] }] }));
    const zero = { enabled: true, capabilities: { tools: true }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] };
    f.client.model.list.mockResolvedValue({ data: [{ ...f.parent.model, ...zero, name: 'Default' }, { ...alternate, ...zero, name: 'Other' }, { providerID: 'azure', id: 'paid', enabled: true, capabilities: { tools: true }, cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] }] });
    await expect(f.executor.resolveProject('project', alternate)).resolves.toMatchObject({ model: alternate, teamModel: alternate });
    expect(routingProof).toHaveBeenLastCalledWith(expect.objectContaining({ model: f.parent.model, models: [f.parent.model, alternate] }));
    await expect(f.executor.resolveProject('project', { providerID: 'azure', id: 'paid' })).rejects.toMatchObject({ code: 'teamProvider' });
    expect(await f.executor.models('project')).toEqual([{ ...f.parent.model, name: 'Default', default: true }, { ...alternate, name: 'Other', default: false }]);
    // Children are verified against the run's model, not the policy default.
    const destination = await f.executor.resolveProject('project', alternate);
    Object.assign(f.run, { policyRevision: destination.policyRevision, model: alternate });
    f.parent.model = alternate; f.child.model = alternate;
    await expect(f.executor.children(f.run)).resolves.toHaveLength(1);
    f.child.model = { providerID: 'openai', id: 'test' };
    await expect(f.executor.children(f.run)).rejects.toMatchObject({ code: 'teamScope' });
    // Pricing drift on the chosen model blocks it while the default still lists.
    f.client.model.list.mockResolvedValue({ data: [{ providerID: 'openai', id: 'test', ...zero }, { ...alternate, ...zero, cost: [{ input: 0.1, output: 0, cache: { read: 0, write: 0 } }] }] });
    await expect(f.executor.resolveProject('project', alternate)).rejects.toMatchObject({ code: 'teamProvider' });
    expect((await f.executor.models('project')).map((item) => item.id)).toEqual(['test']);
  });
  it('rechecks live pricing, exact child inheritance and observed costs', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    const destination = await f.executor.resolveProject('project'); f.run.policyRevision = destination.policyRevision;
    await expect(f.executor.children(f.run)).resolves.toHaveLength(1);
    f.child.model = { providerID: 'openai', id: 'test', variant: 'paid-variant' };
    await expect(f.executor.children(f.run)).rejects.toMatchObject({ code: 'teamScope' });
    f.child.model = f.parent.model; f.child.cost = 0.01;
    await expect(f.executor.children(f.run)).rejects.toMatchObject({ code: 'teamProvider' });
    expect((await f.executor.evidence(f.run)).usage).toMatchObject({ kind: 'available', tokens: 42, reportedCost: 0.01 });
    await expect(f.executor.inspect(f.run)).rejects.toMatchObject({ code: 'teamProvider' });
    await expect(f.executor.send(f.run, 'Task')).rejects.toMatchObject({ code: 'teamProvider' });
    f.child.cost = 0;
    f.client.model.list.mockResolvedValue({ data: [{ ...f.parent.model, enabled: true, capabilities: { tools: true }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 1 } }] }] });
    await expect(f.executor.send(f.run, 'Task')).rejects.toMatchObject({ code: 'teamProvider' });
    expect(f.client.session.prompt).not.toHaveBeenCalled();
  });
  it('keeps glob/grep denied rather than mistaking their pattern for a directory boundary', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    const destination = await f.executor.resolveProject('project');
    expect(destination.permissions.filter((rule) => ['glob', 'grep'].includes(rule.action))).toEqual([]);
    for (const action of ['glob', 'grep', 'shell', 'execute', 'openchamber']) {
      f.agents[1].permissions.push({ action, resource: '*', effect: 'ask' });
      await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' });
      f.agents[1].permissions.pop();
    }
    f.agents[0].permissions.push({ action: 'shell', resource: '*', effect: 'ask' });
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamManager' });
  });
  it('admits only confined draft output and an attested dedicated compute tool', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof, verifyTeamTool: async () => true });
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: f.parent.model, freeOnly: true, paidFallback: false,
      specialists: [{ id: 'reader', capabilities: ['read-project', 'draft-output', 'safe-compute'] }] }));
    f.agents[1].permissions.push({ action: 'team_output', resource: '*', effect: 'ask' }, { action: 'team_compute', resource: '*', effect: 'ask' });
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamPolicy' });
    await mkdir(path.join(f.directory, 'team-output'));
    await expect(f.executor.resolveProject('project')).resolves.toMatchObject({ specialists: ['reader'] });
    expect((await f.executor.resolveProject('project')).childPermissions[0].permissions).toContainEqual({ action: 'team_compute', resource: '*', effect: 'ask' });
    f.agents[1].permissions.at(-1).effect = 'allow';
    expect((await f.executor.resolveProject('project')).childPermissions[0].permissions).toContainEqual({ action: 'team_compute', resource: '*', effect: 'allow' });
    f.agents[1].permissions.push({ action: 'edit', resource: '*', effect: 'ask' });
    await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' });
    const unattested = await fixture({ version: 2, verifyFreeExecution: routingProof });
    await writeFile(path.join(unattested.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: unattested.parent.model, freeOnly: true, paidFallback: false,
      specialists: [{ id: 'reader', capabilities: ['safe-compute'] }] }));
    await expect(unattested.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' });
  });
  it('admits a bounded researcher with ask-only fetch and no other web or host tools', async () => {
    const f = await fixture({ version: 2, verifyFreeExecution: routingProof });
    f.agents[1].id = 'researcher';
    f.agents[1].permissions.push({ action: 'webfetch', resource: '*', effect: 'ask' });
    f.agents[0].permissions.at(-1).resource = 'researcher';
    await writeFile(path.join(f.directory, '.openchamber/team-policy.json'), JSON.stringify({ version: 2, manager: 'manager', model: f.parent.model, freeOnly: true, paidFallback: false,
      specialists: [{ id: 'researcher', capabilities: ['read-project', 'fetch-reference'] }] }));
    const destination = await f.executor.resolveProject('project');
    expect(destination.childPermissions[0]).toMatchObject({ id: 'researcher' });
    expect(destination.childPermissions[0].permissions).toContainEqual({ action: 'webfetch', resource: '*', effect: 'ask' });
    for (const rule of [{ action: 'webfetch', resource: '*', effect: 'allow' }, { action: 'websearch', resource: '*', effect: 'ask' },
      { action: 'browser', resource: '*', effect: 'ask' }, { action: 'subagent', resource: '*', effect: 'ask' }]) {
      f.agents[1].permissions.push(rule);
      await expect(f.executor.resolveProject('project')).rejects.toMatchObject({ code: 'teamChild' });
      f.agents[1].permissions.pop();
    }
  });
});
