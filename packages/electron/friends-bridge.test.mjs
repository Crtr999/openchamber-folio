import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTeamBridge } from './local-team-bridge.mjs';

test('queued assignment actions preserve exact scope and model without widening inputs', async () => {
  const calls = [];
  const record = method => async input => { calls.push({ method, input }); return input; };
  const bridge = createLocalTeamBridge({ getTeam: () => ({ enqueue: record('enqueue'), resumeQueued: record('resume'), cancelQueued: record('cancel') }) });
  const queued = { action: 'team-enqueue', projectId: 'legal', title: 'Review sources', text: 'Review the folder sources.', requestId: 'stable', model: { providerID: 'opencode', id: 'free' } };
  const { action, ...input } = queued;
  assert.deepEqual(await bridge.handle(queued), input);
  await bridge.handle({ action: 'team-resume-queued', projectId: 'legal', runId: 'run' });
  await bridge.handle({ action: 'team-cancel-queued', projectId: 'legal', runId: 'run' });
  assert.deepEqual(calls.map(c => c.method), ['enqueue', 'resume', 'cancel']);
  await assert.rejects(bridge.handle({ ...queued, permissions: 'allow-all' }));
  await assert.rejects(bridge.handle({ ...queued, model: { providerID: 'opencode', id: 'free', endpoint: 'https://other.invalid' } }));
  assert.equal(calls.length, 3);
});
