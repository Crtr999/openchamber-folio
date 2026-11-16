import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAppApproval } from './native-app-approval.mjs';

const scope = { directory: '/synthetic/General', providerID: 'fixture', providerBinding: 'a'.repeat(64), runtimeId: 'fixture-host', runtimeEndpoint: 'http://127.0.0.1:4096', app: 'calendar', containerId: 'user-selected-fixture-id', purpose: 'grant' };
test('only an actual native user choice approves or revokes, with Cancel as the default', async () => {
  const owner = {}; let response = 0; const dialogs = [];
  const approve = createNativeAppApproval({ getOwner: () => owner, isLocalOwner: () => true,
    showMessageBox: async (parent, options) => { dialogs.push({ parent, options }); return { response }; } });
  assert.deepEqual(await approve(scope), { decision: 'cancelled' });
  response = 1; assert.deepEqual(await approve(scope), { decision: 'approved' });
  response = 2; assert.deepEqual(await approve(scope), { decision: 'revoked' });
  assert.equal(dialogs[0].parent, owner); assert.equal(dialogs[0].options.defaultId, 0); assert.equal(dialogs[0].options.cancelId, 0);
  for (const value of [scope.directory, scope.providerID, scope.containerId, scope.providerBinding.slice(0, 12)]) assert.ok(dialogs[0].options.detail.includes(value));
});
test('missing, remote or changed owners never receive native approval', async () => {
  let owner = {}; let local = false;
  const approve = createNativeAppApproval({ getOwner: () => owner, isLocalOwner: () => local,
    showMessageBox: async () => { owner = {}; return { response: 1 }; } });
  assert.deepEqual(await approve(scope), { decision: 'unavailable' });
  local = true; assert.deepEqual(await approve(scope), { decision: 'unavailable' });
  owner = null; assert.deepEqual(await approve(scope), { decision: 'unavailable' });
});
test('one pending approval cannot queue additional native prompts', async () => {
  const owner = {}; let finish;
  const approve = createNativeAppApproval({ getOwner: () => owner, isLocalOwner: () => true,
    showMessageBox: () => new Promise((resolve) => { finish = resolve; }) });
  const first = approve(scope); assert.deepEqual(await approve(scope), { decision: 'busy' });
  finish({ response: 0 }); assert.deepEqual(await first, { decision: 'cancelled' });
});
test('approval contract cannot carry an arbitrary script, app or execution command', async () => {
  const approve = createNativeAppApproval({ getOwner: () => assert.fail('must not open dialog'), isLocalOwner: () => true, showMessageBox: () => assert.fail('must not prompt') });
  await assert.rejects(approve({ ...scope, script: 'activate' }));
  await assert.rejects(approve({ ...scope, app: 'mail' }));
});
test('metadata-only approval explicitly discloses names/IDs and offers no ongoing grant', async () => {
  const owner = {}; let shown;
  const approve = createNativeAppApproval({ getOwner: () => owner, isLocalOwner: () => true,
    showMessageBox: async (_owner, options) => { shown = options; return { response: 1 }; } });
  assert.deepEqual(await approve({ ...scope, purpose: 'containers' }), { decision: 'approved' });
  assert.deepEqual(shown.buttons, ['Cancel', 'Show container names']);
  assert.match(shown.detail, /creates no ongoing grant/); assert.match(shown.detail, /no event or reminder content/);
});
