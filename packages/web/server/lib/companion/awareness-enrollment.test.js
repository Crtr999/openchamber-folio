import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAwarenessEnrollment } from './awareness-enrollment.js';
import { createPersonalAwareness } from './personal-awareness.js';

const base = '/api/companion/personal-awareness';
const approval = { approved: true, projectId: 'home', providerID: 'openai', modelID: 'fixture', sources: ['past-chats'], mailAccounts: [] };
const fixture = () => {
  let state = { settings: { enabled: true, timezone: 'UTC' }, items: [] };
  let blocked = false;
  let failApproval = false;
  const tasks = new Map();
  const reads = [];
  const store = { read: async () => structuredClone(state), update: async (change) => {
    const next = await change(structuredClone(state));
    if (failApproval && next.awareness.enabled) throw new Error('fixture persistence failure');
    state = next; return state;
  } };
  const guard = { check: async (directory) => ({ ok: directory === '/synthetic/home' }) };
  const app = express();
  app.use((req, res, next) => req.get('Authorization') === 'Bearer fixture' ? next() : res.sendStatus(401));
  registerAwarenessEnrollment(app, { store, guard,
    scheduledTaskService: {
      listProjects: async () => [{ id: 'home', path: '/synthetic/home' }, { id: 'zdr', path: '/synthetic/ZDR' }],
      list: async () => [...tasks.values()],
      upsert: async (_project, task) => { tasks.set(task.id, structuredClone(task)); return { task }; },
      remove: async (_project, id) => tasks.delete(id),
    },
    getClient: (directory) => { reads.push(directory); return { model: { list: async () => ({ data: [
      { id: 'fixture', providerID: 'openai' }, { id: 'disabled', providerID: 'openai', enabled: false }, { id: 'other', providerID: 'other' },
    ] }) } }; },
    resolveAllowedProviders: async () => [],
    readConnections: async () => ({ notion: false, calendar: false, mailAccounts: ['verified@example.com'] }),
    isBlocked: () => blocked, now: () => 123,
  });
  app.use((_error, _req, res, _next) => res.sendStatus(500));
  const call = (method) => request(app)[method](base).set('Authorization', 'Bearer fixture');
  return { app, call, store, guard, reads, tasks, state: () => state,
    block: () => { blocked = true; }, fail: () => { failApproval = true; } };
};

describe('explicit personal-review enrollment', () => {
  it('does not enroll on status, preserves authentication, excludes private folders and lists only configured enabled OpenAI models', async () => {
    const f = fixture();
    await request(f.app).get(base).expect(401);
    const result = await f.call('get').expect(200);
    expect(result.body.approval).toBe(null);
    expect(result.body.projects).toEqual([{ id: 'home', name: '/synthetic/home', models: [{ id: 'fixture', name: 'fixture' }] }]);
    expect(f.reads).toEqual(['/synthetic/home']);
    expect(f.tasks.size).toBe(0);
    expect(f.state().awareness).toBeUndefined();
  });
  it('rejects missing consent, disconnected sources, arbitrary mailboxes/models, empty sources and private folders without writing', async () => {
    const f = fixture();
    for (const mutation of [{ approved: false }, { sources: [] }, { projectId: 'zdr' }, { modelID: 'disabled' }, { providerID: 'other' },
      { sources: ['notion'] }, { sources: ['calendar'] }, { sources: ['outlook'], mailAccounts: [] },
      { sources: ['outlook'], mailAccounts: ['unverified@example.com'] }, { mailAccounts: ['verified@example.com'] }]) {
      await f.call('put').send({ ...approval, ...mutation }).expect(400);
    }
    expect(f.tasks.size).toBe(0);
    expect(f.state().awareness).toBeUndefined();
  });
  it('persists exact source/model approval, creates the real engine schedule, and the engine consumes only approved chats', async () => {
    const f = fixture();
    await f.call('put').send(approval).expect(200);
    const task = f.tasks.get('companion:personal-awareness');
    expect(task).toMatchObject({ enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      execution: { providerID: 'openai', modelID: 'fixture', permissionAutoAccept: false, goalEnabled: true, goalTokenBudget: 10000 } });
    expect(f.state().awareness).toMatchObject({ projectId: 'home', providerID: 'openai', modelID: 'fixture', sources: ['past-chats'], mailAccounts: [], enabled: true, approvedAt: 123 });
    let sourceReads = 0;
    const engine = createPersonalAwareness({ store: f.store, guard: f.guard,
      resolveAllowedProviders: async () => [], getClient: () => ({ session: { list: async () => ({ data: [], cursor: {} }), active: async () => ({}) } }),
      readSources: async ({ sources }) => { sourceReads++; expect(sources).toEqual(['past-chats']); return []; },
      readInbox: async () => { throw new Error('Unapproved source must not be read'); },
      isBlocked: () => false, readMetadata: async () => ({}), isArchived: async () => false,
    });
    const prompt = await engine.prepare({ sessionID: 'synthetic', projectID: 'home', directory: '/synthetic/home', task });
    expect(prompt).toContain('past-chats');
    expect(prompt).not.toContain('Earlier follow-up');
    expect(sourceReads).toBe(1);
    await f.call('delete').expect(200);
    expect(f.state().awareness.enabled).toBe(false);
    expect(f.tasks.get(task.id).enabled).toBe(false);
    await expect(engine.prepare({ sessionID: 'after-revoke', projectID: 'home', directory: '/synthetic/home', task })).rejects.toThrow();
  });
  it('keeps consent disabled and removes the new schedule after a failed approval write', async () => {
    const f = fixture(); f.fail();
    await f.call('put').send(approval).expect(500);
    expect(f.state().awareness.enabled).toBe(false);
    expect(f.tasks.size).toBe(0);
  });
  it('preserves an existing schedule and its history disabled after a failed replacement approval', async () => {
    const f = fixture();
    await f.call('put').send(approval).expect(200);
    const prior = f.tasks.get('companion:personal-awareness');
    prior.state = { lastSessionId: 'synthetic-history' };
    f.fail();
    await f.call('put').send({ ...approval, sources: ['outlook'], mailAccounts: ['verified@example.com'] }).expect(500);
    expect(f.state().awareness.enabled).toBe(false);
    expect(f.tasks.get(prior.id)).toEqual({ ...prior, enabled: false });
  });
  it('refuses enterprise enrollment before reading connections, while revocation stays available', async () => {
    const f = fixture(); f.block();
    await f.call('get').expect(403);
    await f.call('put').send(approval).expect(403);
    expect(f.reads).toEqual([]);
    await f.call('delete').expect(200);
  });
});
