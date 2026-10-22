import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommitmentRoutes } from './routes.js';
import { createCommitmentsStore } from './store.js';

let directory;
const make = (checks = { checkNow: vi.fn(async () => ({ started: true })) }) => {
  const store = createCommitmentsStore({ fs: fsp, filePath: path.join(directory, 'commitments.json') });
  const app = express();
  // Stands in for the production API auth gate, ahead of these routes.
  app.use((req, res, next) => (req.get('Authorization') === 'Bearer fixture' ? next() : res.sendStatus(401)));
  const onChanged = vi.fn();
  registerCommitmentRoutes(app, { store, checks, onChanged });
  return { app, store, checks, onChanged };
};
const auth = (req) => req.set('Authorization', 'Bearer fixture');

beforeEach(async () => { directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'commitments-routes-')); });
afterEach(async () => { await fsp.rm(directory, { recursive: true, force: true }); });

describe('commitment routes', () => {
  it('requires authentication', async () => {
    const { app } = make();
    await request(app).get('/api/commitments').expect(401);
    await request(app).post('/api/commitments/x/check').expect(401);
  });

  it('adds, lists, edits and hides a commitment, remembering what was removed', async () => {
    const { app, store, onChanged } = make();
    const created = await auth(request(app).post('/api/commitments')).send({ title: 'Finish paper', dueAt: Date.now() + 86_400_000 }).expect(201);
    const { id } = created.body.item;
    expect(created.body.item).toMatchObject({ origin: 'manual', research: true });
    expect((await auth(request(app).get('/api/commitments')).expect(200)).body.items).toHaveLength(1);
    await auth(request(app).patch(`/api/commitments/${id}`)).send({ status: 'done' }).expect(200);
    await auth(request(app).delete(`/api/commitments/${id}`)).expect(204);
    expect((await auth(request(app).get('/api/commitments')).expect(200)).body.items).toEqual([]);
    expect((await store.read()).items[0].status).toBe('dismissed');
    expect(onChanged).toHaveBeenCalled();
  });

  it('rejects bad input without touching the store', async () => {
    const { app, store } = make();
    await auth(request(app).post('/api/commitments')).send({ title: '' }).expect(400);
    await auth(request(app).post('/api/commitments')).send({ title: 'No date or watch' }).expect(400);
    await auth(request(app).post('/api/commitments')).send({ title: 'x', dueAt: 1, nudgeCount: 5 }).expect(400);
    const { body } = await auth(request(app).post('/api/commitments')).send({ title: 'x', dueAt: 1 }).expect(201);
    await auth(request(app).patch(`/api/commitments/${body.item.id}`)).send({ nudgeCount: 9 }).expect(400);
    await auth(request(app).patch('/api/commitments/missing')).send({ status: 'done' }).expect(404);
    expect((await store.read()).items).toHaveLength(1);
  });

  it('validates settings', async () => {
    const { app } = make();
    await auth(request(app).put('/api/commitments/settings')).send({ dailyNudgeLimit: 2, quietStart: '22:00' }).expect(200);
    await auth(request(app).put('/api/commitments/settings')).send({ dailyNudgeLimit: 99 }).expect(400);
    await auth(request(app).put('/api/commitments/settings')).send({ surprise: true }).expect(400);
  });

  it('maps check outcomes to statuses', async () => {
    for (const [result, status] of [[{ started: true }, 202], [{ started: false, reason: 'busy' }, 409], [{ started: false, reason: 'excluded' }, 403], [{ started: false, reason: 'not-found' }, 404]]) {
      const { app } = make({ checkNow: vi.fn(async () => result) });
      await auth(request(app).post('/api/commitments/some-id/check')).expect(status);
    }
  });
});
