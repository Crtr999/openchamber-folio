import { describe, it, expect } from 'vitest';
import { createFreeTeamGuard } from './team-free-guard.js';

const selected = { providerID: 'opencode', id: 'space-bunny-free' };
const alternate = { providerID: 'openai', id: 'gpt-subscription' };
async function fixture({ ordinary = false, cost = 0, child = false, profiles, rootModel = selected, frozen = rootModel } = {}) {
  const hooks = new Map();
  const saved = new Map();
  const updates = [];
  const ctx = {
    session: {
      async get({ sessionID }) {
        const session = { agent: sessionID === 'child' ? 'reader' : 'manager', title: 'Approved task title', model: rootModel, location: { directory: '/approved' }, metadata: ordinary || child && sessionID === 'child' ? {} : { aiTaskRunId: 'run', aiTaskModel: frozen } };
        if (child && sessionID === 'child') session.parentID = 'parent';
        return session;
      },
      async hook(name, callback) { hooks.set(name, callback); },
      async update(input) { updates.push(input); },
    },
    model: { async list() { return { data: [selected, alternate].map(item => ({ ...item, enabled: true, capabilities: { tools: true }, cost: [{ input: cost, output: 0, cache: { read: 0, write: 0 } }] })) }; } },
    storage: { async get(key) { return saved.get(key); }, async set(key, value) { saved.set(key, value); } },
  };
  await createFreeTeamGuard({ directory: '/approved', model: selected, models: [selected, alternate], profiles, now: () => 1000 }).setup(ctx);
  return { hooks, saved, updates };
}
describe('session-only free model guard', () => {
  it('scopes actual child rules before admission without granting pending permissions', async () => {
    const profiles = [{ id: 'reader', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }];
    const f = await fixture({ child: true, profiles });
    await f.hooks.get('prompt')({ sessionID: 'child' });
    expect(f.updates).toEqual([{ sessionID: 'child', permissions: profiles[0].permissions }]);
    await expect(f.hooks.get('prompt')({ sessionID: 'parent' })).rejects.toThrow('not admitted');
    const ordinary = await fixture({ ordinary: true, profiles });
    await ordinary.hooks.get('prompt')({ sessionID: 'parent' });
    expect(ordinary.updates).toEqual([]);
  });
  it('uses the existing task title without changing ordinary title generation', async () => {
    const tagged = await fixture();
    const task = { sessionID: 'parent' };
    await tagged.hooks.get('title')(task);
    expect(task.result).toBe('Approved task title');
    const ordinary = await fixture({ ordinary: true });
    const chat = { sessionID: 'parent' };
    await ordinary.hooks.get('title')(chat);
    expect(chat.result).toBeUndefined();
  });
  it('permits the exact zero-priced model on every transport and follows real child ancestry', async () => {
    const { hooks } = await fixture({ child: true });
    for (const name of ['model.request', 'http.request', 'experimental.ws.handshake']) {
      await expect(hooks.get(name)({ sessionID: 'child', model: selected })).resolves.toBeUndefined();
      await expect(hooks.get(name)({ sessionID: 'child', model: { providerID: 'azure', id: 'paid' } })).rejects.toThrow('refuses');
    }
  });
  it('keeps every descendant on the run-selected approved model', async () => {
    const chosen = await fixture({ child: true, rootModel: alternate });
    await expect(chosen.hooks.get('model.request')({ sessionID: 'child', model: alternate })).resolves.toBeUndefined();
    await expect(chosen.hooks.get('model.request')({ sessionID: 'child', model: selected })).rejects.toThrow('refuses');
    const unreviewed = await fixture({ rootModel: { providerID: 'azure', id: 'paid' } });
    await expect(unreviewed.hooks.get('model.request')({ sessionID: 'parent', model: { providerID: 'azure', id: 'paid' } })).rejects.toThrow('frozen task model');
  });
  it('accepts a reviewed subscription model only while it stays unpriced', async () => {
    const hooks = new Map();
    const subscription = { providerID: 'openai', id: 'gpt-sub', billing: 'subscription' };
    let cost = [];
    const ctx = {
      session: { async get() { return { model: subscription, location: { directory: '/approved' }, metadata: { aiTaskRunId: 'run', aiTaskModel: { providerID: subscription.providerID, id: subscription.id } } }; }, async hook(name, callback) { hooks.set(name, callback); } },
      model: { async list() { return { data: [{ providerID: 'openai', id: 'gpt-sub', enabled: true, capabilities: { tools: true }, cost }] }; } },
      storage: { async get() { return undefined; }, async set() {} },
    };
    await createFreeTeamGuard({ directory: '/approved', model: selected, models: [selected, subscription] }).setup(ctx);
    await expect(hooks.get('model.request')({ sessionID: 'parent', model: subscription })).resolves.toBeUndefined();
    cost = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }];
    await expect(hooks.get('model.request')({ sessionID: 'parent', model: subscription })).rejects.toThrow('pricing');
  });
  it('fails closed on changed prices and does not modify ordinary chats', async () => {
    const paid = await fixture({ cost: 1 });
    await expect(paid.hooks.get('model.request')({ sessionID: 'parent', model: selected })).rejects.toThrow('pricing');
    const ordinary = await fixture({ ordinary: true, cost: 1 });
    await expect(ordinary.hooks.get('model.request')({ sessionID: 'parent', model: { providerID: 'azure', id: 'ordinary' } })).resolves.toBeUndefined();
  });
  it('refuses changing even to another reviewed model and missing frozen authority', async () => {
    const switched = await fixture({ rootModel: alternate, frozen: selected });
    await expect(switched.hooks.get('model.request')({ sessionID: 'parent', model: alternate })).rejects.toThrow('frozen');
    const missing = await fixture({ frozen: null });
    await expect(missing.hooks.get('model.request')({ sessionID: 'parent', model: selected })).rejects.toThrow('frozen');
  });
  it('rejects malformed frozen JSON and nondefault variants before transport admission', async () => {
    for (const frozen of [null, 0, 1, [], 'x', { ...selected, variant: false }, { ...selected, variant: 0 }, { ...selected, variant: null }, { ...selected, id: '' }, { ...selected, providerID: 1 }, { ...selected, extra: true }]) {
      const f = await fixture({ frozen });
      await expect(f.hooks.get('http.request')({ sessionID: 'parent', model: selected })).rejects.toThrow('frozen');
    }
    for (const id of [1, {}, []]) {
      const malformed = { providerID: 'opencode', id };
      const f = await fixture({ frozen: malformed, rootModel: malformed });
      await expect(f.hooks.get('http.request')({ sessionID: 'parent', model: malformed })).rejects.toThrow('pricing');
    }
  });
  it('records bounded 429 cooldown without prompts, credentials or paid fallback', async () => {
    const { hooks, saved } = await fixture();
    const event = { sessionID: 'parent', attempt: 3, error: { status: 429 }, decision: { retry: true, delay: 500000 } };
    await hooks.get('retry')(event);
    expect(event.decision).toEqual({ retry: false });
    expect(saved.get('free-team-cooldown')).toEqual({ until: 501000, status: 429, attempt: 3 });
    await expect(hooks.get('http.request')({ sessionID: 'parent', model: selected })).rejects.toThrow('cooling down');
  });
});
