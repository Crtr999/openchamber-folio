import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCompanionRoutes } from './routes.js';
import { createFolderGuard } from '../commitments/zdr-guard.js';
const makeApp = () => {
  const saved = [];
  const tasks = [{ id: 'companion:12345678', name: 'Follow up', enabled: true, execution: { prompt: 'check', permissionAutoAccept: false }, schedule: { kind: 'daily' }, state: {} }, { id: 'ordinary', name: 'Other schedule' }];
  const app = express();
  // Represents the production API auth gate, ahead of these routes.
  app.use((req, res, next) => req.get('Authorization') === 'Bearer fixture' ? next() : res.sendStatus(401));
  registerCompanionRoutes(app, { scheduledTaskService: {
    listProjects: async () => [{ id: 'project', path: '/synthetic/ordinary' }],
    async list(project) { if (project !== 'project') throw Object.assign(new Error('missing'), { statusCode: 404 }); return tasks; },
    async upsert(project, task) { saved.push({ project, task }); return { task, created: true }; },
  }, folderGuard: { check: async () => ({ ok: true }) } });
  return { app, saved };
};
const body = { id: 'companion:12345678', name: 'Check opportunity', prompt: 'Check selected project', time: '09:00', timezone: 'America/New_York', providerID: 'openai', modelID: 'fixture', enabled: true };
describe('companion project schedules', () => {
  it('refuses named, bound, nested and unreadable private folders before any project read or mutation', async () => {
    for (const directory of ['/synthetic/ZDR Legal', '/synthetic/private', '/synthetic/private/child', '/synthetic/unreadable']) {
      const touched = [];
      const app = express();
      const guard = createFolderGuard({
        listProjectPaths: async () => ['/synthetic/private'],
        resolveAllowedProviders: async (target) => {
          if (target.includes('ZDR')) throw new Error('Named private folder must never be inspected');
          if (target.includes('unreadable')) throw new Error('Unavailable');
          return target === '/synthetic/private' ? ['openrouter-zdr'] : [];
        },
      });
      registerCompanionRoutes(app, { folderGuard: guard,
        scheduledTaskService: { listProjects: async () => [{ id: 'private', path: directory }], list: async () => { touched.push('sync'); return []; } },
        projectConfigRuntime: { readCompanionState: async () => { touched.push('read'); }, updateCompanionState: async () => { touched.push('write'); } },
      });
      await request(app).get('/api/projects/private/companion/inbox').expect(403).expect(({ body }) => expect(body.code).toBe('private_folder'));
      await request(app).patch('/api/projects/private/companion/inbox/result').send({ dismissed: true }).expect(403);
      expect(touched).toEqual([]);
    }
  });
  it('keeps auth and project boundaries and excludes unrelated schedules', async () => {
    const { app } = makeApp();
    await request(app).get('/api/projects/project/companion').expect(401);
    const response = await request(app).get('/api/projects/project/companion').set('Authorization', 'Bearer fixture').expect(200);
    expect(response.body.tasks.map((task) => task.id)).toEqual(['companion:12345678']);
    await request(app).get('/api/projects/other/companion').set('Authorization', 'Bearer fixture').expect(404);
  });
  it('creates a bounded goal without blanket approval or replacing ordinary schedules', async () => {
    const { app, saved } = makeApp();
    await request(app).put('/api/projects/project/companion').set('Authorization', 'Bearer fixture').send(body).expect(200);
    expect(saved).toHaveLength(1);
    expect(saved[0].task.execution).toMatchObject({ permissionAutoAccept: false, goalEnabled: true, goalTokenBudget: 10000 });
    expect(saved[0].task.schedule).toEqual({ kind: 'daily', times: ['09:00'], timezone: 'America/New_York' });
  });
  it('rejects invalid times, zones and injected approval settings', async () => {
    const { app, saved } = makeApp();
    for (const mutation of [{ time: '25:00' }, { timezone: 'invalid' }, { permissionAutoAccept: true }, { id: 'ordinary' }]) {
      await request(app).put('/api/projects/project/companion').set('Authorization', 'Bearer fixture').send({ ...body, ...mutation }).expect(400);
    }
    expect(saved).toEqual([]);
  });
  it('pauses a responsibility while retaining its execution and refuses other IDs', async () => {
    const { app, saved } = makeApp();
    await request(app).patch('/api/projects/project/companion/companion:12345678').set('Authorization', 'Bearer fixture').send({ enabled: false }).expect(200);
    expect(saved[0].task.enabled).toBe(false);
    expect(saved[0].task.execution.prompt).toBe('check');
    await request(app).patch('/api/projects/project/companion/ordinary').set('Authorization', 'Bearer fixture').send({ enabled: false }).expect(400);
  });
});
