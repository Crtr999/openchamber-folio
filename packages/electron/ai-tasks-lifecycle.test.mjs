import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAiTaskRuntime, AI_TASK_COLUMNS } from '../web/server/lib/ai-tasks/runtime.js';

const board = 'collection://fixture';
const page = 'https://www.notion.so/11111111111111111111111111111111';
const run = (phase) => ({ id: 'run', page, board, title: 'Fixture', phase, startedAt: 1, sessionId: 'ses_fixture', directory: '/fixture', content: 'Saved output', outcome: 'needs-you' });
async function fixture({ runs = [], team, referenceCode, enabled = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-lifecycle-'));
  const filePath = path.join(directory, 'state.json');
  const config = { board, enabled, model: '' };
  const assignments = [{ board, page, projectId: 'project' }];
  await writeFile(filePath, JSON.stringify({ config, runs, assignments }));
  let blocked = false; let rowStatus = 'Ready for AI'; let member = true;
  const calls = { trash: 0, claim: 0, create: 0, send: 0 };
  const notion = {
    readBoard: async () => ({ columns: AI_TASK_COLUMNS, rows: member ? [{ url: page, title: 'Fixture', status: rowStatus }] : [] }),
    readTask: async () => { if (referenceCode) throw Object.assign(new Error('PRIVATE SOURCE TEXT AND CREDENTIALS'), { code: referenceCode }); return 'Original notes'; },
    claim: async () => { calls.claim++; rowStatus = 'Doing'; return true; },
    finish: async () => { rowStatus = 'Needs you'; return true; },
    delete: async (id, input) => { assert.equal(id, board); assert.deepEqual(input, { page, confirmed: true }); calls.trash++; member = false; return { saved: true }; },
  };
  const executor = {
    projects: async () => [{ id: 'project', label: 'Fixture' }],
    resolveProject: async () => ({ projectId: 'project', label: 'Fixture', directory: '/fixture', agent: 'manager' }),
    inspect: async () => ({ kind: 'running' }), children: async () => [],
    create: async () => { calls.create++; return { id: 'ses_new', directory: '/fixture' }; },
    send: async () => { calls.send++; },
  };
  const options = { filePath, notion, executor, team, isBlocked: () => blocked };
  const runtime = createAiTaskRuntime(options);
  return { runtime, options, calls, notion, filePath, block: () => { blocked = true; },
    close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('coordinator trash requires explicit consent and rejects every active durable lifecycle', async () => {
  for (const phase of ['claimed', 'running', 'result']) {
    const f = await fixture({ runs: [run(phase)] }); try {
      await assert.rejects(f.runtime.delete({ page, confirmed: false }));
      await assert.rejects(f.runtime.delete({ page, confirmed: true }), /active run/);
      assert.equal(f.calls.trash, 0); assert.equal((await f.runtime.status()).runs[0].phase, phase);
    } finally { await f.close(); }
  }
});

test('terminal card trash removes only its future assignment and retains run output and chat history', async () => {
  const history = [run('done'), { ...run('needs-you'), id: 'blocked' }];
  const f = await fixture({ runs: history }); try {
    assert.deepEqual(await f.runtime.delete({ page, confirmed: true }), { saved: true });
    const saved = JSON.parse(await readFile(f.filePath, 'utf8'));
    assert.deepEqual(saved.runs, history); assert.deepEqual(saved.assignments, []);
    assert.equal(f.calls.send, 0); assert.equal(f.calls.trash, 1);
  } finally { await f.close(); }
});

test('trash failure preserves assignment and history; enterprise and unsupported hosts never delete', async () => {
  const f = await fixture({ runs: [run('done')] }); try {
    f.notion.delete = async () => { throw new Error('Offline'); };
    await assert.rejects(f.runtime.delete({ page, confirmed: true }), /Offline/);
    assert.equal((await f.runtime.status()).assignments.length, 1);
    assert.equal((await f.runtime.status()).runs.length, 1);
    f.notion.delete = undefined;
    await assert.rejects(f.runtime.delete({ page, confirmed: true }), /does not support/);
    f.block(); await assert.rejects(f.runtime.delete({ page, confirmed: true }), /policy/);
    assert.equal(f.calls.trash, 0);
  } finally { await f.close(); }
});

test('shared pausePending and unknown live authority are deletion barriers even after terminal Notion writeback', async () => {
  const history = { ...run('needs-you'), projectId: 'project', teamRequestId: 'request', teamRunId: 'shared', teammateId: 'manager', teamRevision: 1 };
  for (const mode of ['pending', 'running', 'missing', 'failure', 'settled']) {
    const shared = { id: 'shared', teammateId: 'manager', projectId: 'project', directory: '/fixture', revision: 1, phase: mode === 'running' ? 'running' : 'paused', sessionId: 'ses_fixture', children: [], pausePending: mode === 'pending' };
    const team = { details: async () => {
      if (mode === 'failure') throw new Error('Live lookup failed');
      return { teammate: { id: 'manager', projectId: 'project', directory: '/fixture', projectLabel: 'Fixture', agent: 'manager' }, runs: mode === 'missing' ? [] : [shared] };
    } };
    const f = await fixture({ runs: [history], team }); try {
      if (mode === 'settled') { await f.runtime.delete({ page, confirmed: true }); assert.equal(f.calls.trash, 1); }
      else { await assert.rejects(f.runtime.delete({ page, confirmed: true })); assert.equal(f.calls.trash, 0); }
      assert.deepEqual((await f.runtime.status()).runs, [history]);
    } finally { await f.close(); }
  }
});

test('deletion and pickup share the coordinator queue, preventing a deleted assignment from dispatching', async () => {
  const f = await fixture({ enabled: true }); try {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const remove = f.notion.delete;
    f.notion.delete = async (...args) => { await barrier; return remove(...args); };
    const deletion = f.runtime.delete({ page, confirmed: true });
    const check = f.runtime.check();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.claim, 0);
    release(); await deletion; await check;
    assert.equal(f.calls.claim, 0); assert.equal(f.calls.send, 0);
  } finally { await f.close(); }
});

test('reference failures expose only static actionable codes, finish Needs you and never dispatch or redispatch', async () => {
  for (const kind of ['url', 'incomplete', 'scope', 'ambiguous', 'missing', 'limit', 'access']) {
    const code = `notion_reference_${kind}`;
    const f = await fixture({ referenceCode: code, enabled: true }); try {
      const first = await f.runtime.check();
      assert.equal(first.runs[0].failure.code, code); assert.equal(first.runs[0].failure.stage, 'read-task');
      assert.equal(first.runs[0].phase, 'needs-you'); assert.doesNotMatch(JSON.stringify(first), /PRIVATE SOURCE|CREDENTIALS/);
      assert.equal(f.calls.create, 0); assert.equal(f.calls.send, 0);
      await f.runtime.check();
      await f.runtime.close();
      const restarted = createAiTaskRuntime(f.options);
      try { await restarted.check(); assert.equal(f.calls.claim, 1); assert.equal(f.calls.send, 0); }
      finally { await restarted.close(); }
    } finally { await f.close(); }
  }
});
