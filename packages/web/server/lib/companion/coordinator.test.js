import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createCompanionCoordinator, PROJECT_MONITOR_ID } from './coordinator.js';
import { registerCompanionRoutes } from './routes.js';
import express from 'express';
import request from 'supertest';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carter-companion-'));
  const config = createProjectConfigRuntime({ fsPromises: await import('node:fs/promises'), path, projectsDirPath: directory });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let time = Date.parse('2026-10-22T12:00:00Z');
  const runs = []; const notices = [];
  let failNotice = false;
  const service = createScheduledTaskService({
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project', path: '/workspace/project' }, { id: 'other', path: '/workspace/other' }] }),
    sanitizeProjects: (projects) => projects, projectConfigRuntime: config,
    scheduledTasksRuntime: { syncProject: (id) => config.listScheduledTasks(id), runNow: async (project, task) => { runs.push({ project, task }); return { ok: true, sessionID: 'ses_run' }; } },
  });
  const make = () => createCompanionCoordinator({
    projectConfigRuntime: config, scheduledTaskService: service, now: () => time,
    inspectResult: async (id) => ({ kind: 'update', enrollment: { projectId: 'project', taskId: 'companion:12345678' }, reply: id === 'ses_changed' ? 'A changed opportunity' : 'A useful opportunity' }),
    readMetadata: async (id) => id === 'own' ? { openchamber: { companion: {} } } : {},
    readLastReply: async () => 'Recent project goal', isRootSession: async (id) => id !== 'child',
    notifyUpdate: async (project, entry) => { if (failNotice) throw new Error('offline'); notices.push({ project, entry }); return true; },
    logger: { warn: () => {} },
  });
  const coordinator = make();
  const app = express();
  app.use((req, res, next) => req.get('Authorization') === 'Bearer fixture' ? next() : res.sendStatus(401));
  registerCompanionRoutes(app, { scheduledTaskService: service, projectConfigRuntime: config, companionCoordinator: coordinator });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  return { config, coordinator, make, service, app, notices, runs, now: () => time, advance: (ms) => { time += ms; }, failNotice: (value) => { failNotice = value; } };
};
const enroll = (app, enabled = true) => request(app).put('/api/projects/project/companion/settings').set('Authorization', 'Bearer fixture').send({ activityEnabled: enabled, timezone: 'UTC', quietStart: '21:00', quietEnd: '08:00', dailyAlertLimit: 2, providerID: 'fixture', modelID: 'fixture' });

describe('durable companion coordinator', () => {
  it('coalesces concurrent results and survives a restart without duplicate alert attempts', async () => {
    const f = await fixture(); const second = f.make();
    await Promise.all([f.coordinator.considerCompletion('ses_new'), second.considerCompletion('ses_new')]);
    expect((await f.config.readCompanionState('project')).inbox).toHaveLength(1);
    await Promise.all([f.make().tick(), second.tick()]);
    expect(f.notices).toHaveLength(1);
    await f.make().tick();
    expect(f.notices).toHaveLength(1);
    expect((await f.config.readCompanionState('project')).inbox[0].attemptedAt).toBe(f.now());
  });
  it('defers quiet-hour alerts, preserves unseen work and enforces the daily limit', async () => {
    const f = await fixture(); await enroll(f.app).expect(200);
    f.advance(10 * 3600_000);
    await f.coordinator.considerCompletion('ses_new');
    await f.coordinator.tick(); expect(f.notices).toHaveLength(0);
    f.advance(10 * 3600_000);
    await f.make().tick(); expect(f.notices).toHaveLength(1);
    await f.config.updateCompanionState('project', (state) => ({ ...state, settings: { ...state.settings, dailyAlertLimit: 1 } }));
    await f.coordinator.considerCompletion('ses_changed');
    await f.coordinator.tick(); expect(f.notices).toHaveLength(1);
    expect((await f.config.readCompanionState('project')).inbox.filter((entry) => !entry.seen)).toHaveLength(2);
  });
  it('backs off failed notification attempts and retries after restarting', async () => {
    const f = await fixture(); await f.coordinator.considerCompletion('ses_new'); f.failNotice(true);
    await f.coordinator.tick();
    expect((await f.config.readCompanionState('project')).inbox[0].attemptedAt).toBeUndefined();
    f.failNotice(false); await f.make().tick(); expect(f.notices).toHaveLength(0);
    f.advance(300_001); await f.make().tick(); expect(f.notices).toHaveLength(1);
  });
  it('does not alert for results read or dismissed from another client', async () => {
    const f = await fixture(); await f.coordinator.considerCompletion('ses_new');
    await request(f.app).patch('/api/projects/project/companion/inbox/ses_new').set('Authorization', 'Bearer fixture').send({ seen: true }).expect(200);
    await f.make().tick(); expect(f.notices).toHaveLength(0);
    const result = await request(f.app).get('/api/projects/project/companion/inbox').set('Authorization', 'Bearer fixture').expect(200);
    expect(result.body.inbox[0]).toMatchObject({ id: 'ses_new', seen: true });
    await request(f.app).patch('/api/projects/project/companion/inbox/ses_new').set('Authorization', 'Bearer fixture').send({ dismissed: true }).expect(200);
    expect((await f.config.readCompanionState('project')).inbox).toHaveLength(1);
  });
  it('changing quiet hours preserves the saved responsibility and selected provider', async () => {
    const f = await fixture(); await enroll(f.app).expect(200);
    const monitor = (await f.service.list('project')).find((task) => task.id === PROJECT_MONITOR_ID);
    await f.service.upsert('project', { ...monitor, execution: { ...monitor.execution, prompt: 'Review assignment chats only. Do not access files.' } });
    await request(f.app).put('/api/projects/project/companion/settings').set('Authorization', 'Bearer fixture')
      .send({ activityEnabled: true, timezone: 'America/New_York', quietStart: '20:00', quietEnd: '08:00', dailyAlertLimit: 4, providerID: 'openai', modelID: 'approved-model' }).expect(200);
    expect((await f.service.list('project')).find((task) => task.id === PROJECT_MONITOR_ID).execution)
      .toMatchObject({ prompt: 'Review assignment chats only. Do not access files.', providerID: 'openai', modelID: 'approved-model' });
    expect((await f.service.list('project')).find((task) => task.id === PROJECT_MONITOR_ID).execution.permissionAutoAccept).not.toBe(true);
  });
  it('seeks the user after enrolled project activity, with debounce, durable cooldown and no self loop', async () => {
    const f = await fixture(); await enroll(f.app).expect(200);
    const event = (id) => ({ type: 'session.idle', properties: { sessionID: id } });
    await f.coordinator.observe(event('own'), '/workspace/project');
    await f.coordinator.observe(event('child'), '/workspace/project');
    await f.coordinator.observe(event('outside'), '/workspace/unrelated');
    await f.coordinator.tick(); expect(f.runs).toHaveLength(0);
    await f.coordinator.observe(event('source'), '/workspace/project');
    expect(await f.coordinator.activityContext('project', PROJECT_MONITOR_ID)).toContain('Recent project goal');
    await f.make().tick(); expect(f.runs).toHaveLength(0);
    f.advance(120_001); await Promise.all([f.coordinator.tick(), f.make().tick()]);
    expect(f.runs).toEqual([{ project: 'project', task: PROJECT_MONITOR_ID }]);
    f.advance(60_001); await f.coordinator.observe(event('source'), '/workspace/project'); await f.make().tick();
    expect(f.runs).toHaveLength(1);
    await enroll(f.app, false).expect(200);
    f.advance(3 * 3600_000); await f.make().tick(); expect(f.runs).toHaveLength(1);
    await expect(f.coordinator.activityContext('project', PROJECT_MONITOR_ID)).rejects.toThrow('paused');
  });
  it('preserves other project fields during concurrent writes and refuses malformed companion state', async () => {
    const f = await fixture();
    await Promise.all([f.coordinator.considerCompletion('ses_new'), f.config.updateProjectSetup('project', { draftStarters: [] })]);
    const file = f.config.resolveProjectConfigPath('project');
    const document = JSON.parse(await readFile(file, 'utf8'));
    document.futureField = { retained: true }; document.companion.futureField = 'retained';
    await writeFile(file, JSON.stringify(document));
    await f.coordinator.considerCompletion('ses_changed');
    expect(JSON.parse(await readFile(file, 'utf8')).futureField).toEqual({ retained: true });
    expect((await f.config.readCompanionState('project')).futureField).toBe('retained');
    const malformed = JSON.stringify({ ...document, companion: { version: 99 } });
    await writeFile(file, malformed);
    await expect(f.config.updateCompanionState('project', (state) => state)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(malformed);
  });
  it('authenticates every inbox/settings path and rejects project escapes or injected approval', async () => {
    const f = await fixture();
    await request(f.app).get('/api/projects/project/companion/inbox').expect(401);
    await request(f.app).get('/api/projects/missing/companion/inbox').set('Authorization', 'Bearer fixture').expect(404);
    await request(f.app).put('/api/projects/project/companion/settings').set('Authorization', 'Bearer fixture').send({ activityEnabled: true, providerID: 'fixture', modelID: 'fixture', permissionAutoAccept: true }).expect(400);
    await enroll(f.app).expect(200);
    const tasks = await f.service.list('project');
    expect(tasks[0].execution.permissionAutoAccept).not.toBe(true);
    expect(tasks[0].execution).toMatchObject({ goalEnabled: true, goalTokenBudget: 10000 });
    await request(f.app).patch('/api/projects/project/companion/inbox/missing').set('Authorization', 'Bearer fixture').send({ excerpt: 'injected' }).expect(400);
  });
});

describe('connected-source wake signals', () => {
  it('requires normal authentication and enrollment, accepts no prompt, and coalesces signals', async () => {
    const f = await fixture(); const route = '/api/projects/project/companion/wake';
    await request(f.app).post(route).send({}).expect(401);
    await request(f.app).post(route).set('Authorization', 'Bearer fixture').send({}).expect(409);
    await enroll(f.app).expect(200);
    await request(f.app).post(route).set('Authorization', 'Bearer fixture').send({ prompt: 'override' }).expect(400);
    await request(f.app).post(route).set('Authorization', 'Bearer fixture').send({}).expect(202);
    const due = (await f.config.readCompanionState('project')).wake.dueAt;
    f.advance(30_000);
    await request(f.app).post(route).set('Authorization', 'Bearer fixture').send({}).expect(202);
    expect((await f.config.readCompanionState('project')).wake.dueAt).toBe(due);
    f.advance(120_001); await f.coordinator.tick(); expect(f.runs).toHaveLength(1);
  });
});

describe('coordinator recovery boundaries', () => {
  it('recovers an expired delivery lease and isolates a corrupt project', async () => {
    const f = await fixture();
    await f.coordinator.considerCompletion('ses_new');
    await f.config.updateCompanionState('project', (state) => ({ ...state, inbox: state.inbox.map((entry) => ({ ...entry, leaseUntil: f.now() + 120000, claimID: 'abandoned' })) }));
    await writeFile(f.config.resolveProjectConfigPath('other'), JSON.stringify({ companion: { version: 99 } }));
    await f.make().tick(); expect(f.notices).toHaveLength(0);
    f.advance(120001); await f.make().tick(); expect(f.notices).toHaveLength(1);
  });
  it('limits activity checks to three daily across restarts', async () => {
    const f = await fixture(); await enroll(f.app).expect(200);
    for (let index = 0; index < 4; index += 1) {
      await f.make().requestCheck('project');
      f.advance(120001); await f.make().tick();
      f.advance(7200001);
    }
    expect(f.runs).toHaveLength(3);
    expect((await f.config.readCompanionState('project')).wake.count).toBe(3);
  });
  it('rolls back the monitor schedule when state persistence fails', async () => {
    const f = await fixture();
    await writeFile(f.config.resolveProjectConfigPath('project'), JSON.stringify({ companion: { version: 99 } }));
    await enroll(f.app).expect(500);
    expect(await f.service.list('project')).toHaveLength(0);
  });
});
