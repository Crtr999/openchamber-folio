import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalTeamBridge } from './local-team-bridge.mjs';

test('missing local runtime returns a stable unavailable state, not an empty inbox', async () => {
  const bridge = createLocalTeamBridge({ getTeam: () => null, now: () => 42 });
  assert.deepEqual(await bridge.handle({ action: 'team-inbox' }), {
    code: 'team_runtime_unavailable', message: 'Team runtime is not available on this host.', at: 42,
  });
});

test('inbox reads resolve the current runtime at call time', async () => {
  let team = null;
  const bridge = createLocalTeamBridge({ getTeam: () => team });
  assert.equal((await bridge.handle({ action: 'team-inbox' })).code, 'team_runtime_unavailable');
  const result = [{ teammate: { id: 'manager' }, unread: true }];
  team = { inbox: async () => result };
  assert.equal(await bridge.handle({ action: 'team-inbox' }), result);
});

test('writes preserve project scope, request identity and reviewed routine revisions', async () => {
  const calls = [];
  const record = name => async input => { calls.push({ name, input }); return input; };
  const team = {
    details: record('details'), send: record('send'), revise: record('revise'), recover: record('recover'), ack: record('ack'), proposeRoutine: record('proposeRoutine'),
    confirmRoutine: record('confirmRoutine'), pauseRoutine: record('pauseRoutine'), pauseContinuation: record('pauseContinuation'),
  };
  const bridge = createLocalTeamBridge({ getTeam: () => team });
  const requests = [
    ['details', { action: 'team-details', projectId: 'project', teammateId: 'manager' }],
    ['send', { action: 'team-send', projectId: 'project', title: 'Task', text: 'Read the project rules.', requestId: 'same-request' }],
    ['revise', { action: 'team-revise', projectId: 'project', runId: 'run', revision: 7, text: 'Revise the verified draft.', requestId: 'revision-request' }],
    ['recover', { action: 'team-recover', projectId: 'project', runId: 'run' }],
    ['ack', { action: 'team-ack', projectId: 'project', teammateId: 'manager', revision: 7 }],
    ['proposeRoutine', { action: 'team-propose-routine', projectId: 'project', title: 'Review', text: 'Read project notes.',
      schedule: { kind: 'daily', time: '09:00', timezone: 'America/New_York' }, allowedActions: ['read-project'],
      limits: { maxOccurrences: 2, tokenGuardrail: 1000 } }],
    ['confirmRoutine', { action: 'team-confirm-routine', projectId: 'project', routineId: 'routine', revision: 'reviewed-revision' }],
    ['pauseRoutine', { action: 'team-pause-routine', projectId: 'project', routineId: 'routine', revision: 'reviewed-revision' }],
    ['pauseContinuation', { action: 'team-pause-continuation', projectId: 'project', runId: 'run' }],
  ];
  for (const [name, request] of requests) {
    const { action, ...input } = request;
    assert.deepEqual(await bridge.handle(request), input);
    assert.deepEqual(calls.at(-1), { name, input });
  }
});

test('malformed or broadened actions cannot reach the runtime', async () => {
  let lookups = 0;
  const bridge = createLocalTeamBridge({ getTeam: () => { lookups += 1; return null; } });
  for (const request of [
    { action: 'team-delete', projectId: 'project' },
    { action: 'team-inbox', directory: '/other-project' },
    { action: 'team-send', projectId: 'project', title: 'Task', text: 'Read notes.' },
    { action: 'team-revise', projectId: 'project', runId: 'run', text: 'Unreviewed revision.', requestId: 'revision-request' },
    { action: 'team-revise', projectId: 'project', runId: 'run', revision: 1, text: 'Revise.', requestId: 'revision-request', approved: true },
    { action: 'team-confirm-routine', projectId: 'project', routineId: 'routine' },
    { action: 'team-ack', projectId: 'project', teammateId: 'manager', revision: -1 },
    { action: 'team-propose-routine', projectId: 'project', title: 'Task', text: 'Send mail.',
      schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, allowedActions: ['send-mail'],
      limits: { maxOccurrences: 2, tokenGuardrail: 1000 } },
  ]) await assert.rejects(bridge.handle(request));
  assert.equal(lookups, 0);
});

test('authoritative runtime failures remain failures and are not silently retried', async () => {
  let calls = 0;
  const failure = new Error('durable state read failed');
  const bridge = createLocalTeamBridge({ getTeam: () => ({ inbox: async () => { calls += 1; throw failure; } }) });
  await assert.rejects(bridge.handle({ action: 'team-inbox' }), error => error === failure);
  assert.equal(calls, 1);
});
