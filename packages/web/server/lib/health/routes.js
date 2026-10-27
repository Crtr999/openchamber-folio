import express from 'express';
import { prepareHealthWorkspace } from './workspace.js';
import { z } from 'zod';
import { getWhoopConnection, queryHealthEvidence } from './whoop.js';
import { healthApprovalSchema, healthIdentitySchema, healthBatchSchema, healthQuerySchema, getHealthStore } from './store.js';

/** Registered behind the existing UI/client authentication, before proxying. */
export function registerHealthRoutes(app, { dataDir, prepareWorkspace = prepareHealthWorkspace }) {
  const store = getHealthStore(dataDir);
  const whoop = getWhoopConnection(store);
  const json = express.json({ limit: '8mb' });
  const respond = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (error.code === 'enterprise_mode') return res.status(403).json({ code: 'enterprise_mode', error: 'WHOOP is disabled by enterprise policy' });
      res.status(400).json({ error: 'Health request failed. Existing records were preserved.' });
    }
  };
  app.get('/api/health/privacy', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('Open Carter personal health workspace. Health records are retained on your connected Open Carter server. The health record database and WHOOP credentials are encrypted locally; original report files are retained in the private Health project folder. When you ask a health question, selected records and report files are sent to your existing OpenAI connection. Open Carter does not use these records for advertising or sell them. You can stop health sharing in Open Carter and revoke source permissions in WHOOP or Apple Health. Disconnecting a source does not delete copies already retained. This is a private personal app, not a medical provider.');
  });
  app.get('/api/health/status', respond(async (_req, res) => {
    const state = await store.read();
    res.json({ approval: state.approval, count: state.records.length, synced: state.synced, whoop: { configured: Boolean(state.whoop), connected: Boolean(state.whoop?.accessToken) } });
  }));
  app.post('/api/health/enable', json, respond(async (_req, res) => {
    const directory = await prepareWorkspace();
    await store.approve({ enabled: true, directory, providerID: 'openai' });
    res.json({ directory });
  }));
  app.put('/api/health/approval', json, respond(async (req, res) => {
    const input = healthApprovalSchema.parse(req.body);
    const current = await store.read();
    if (!current.approval || current.approval.directory !== input.directory) return res.status(403).json({ error: 'Enable the Health workspace first' });
    await store.approve(input);
    res.json({ ok: true });
  }));
  app.post('/api/health/records', json, respond(async (req, res) => {
    const input = healthBatchSchema.parse(req.body);
    const next = await store.ingest(input);
    res.json({ ok: true, count: next.records.length, synced: next.synced });
  }));
  app.post('/api/health/query', json, respond(async (req, res) => {
    res.json(await queryHealthEvidence(store, healthQuerySchema.parse(req.body)));
  }));
  app.post('/api/health/whoop/connect', json, respond(async (req, res) => res.json(await whoop.connect(req.body))));
  app.get('/api/health/whoop/callback', respond(async (req, res) => {
    const input = z.object({ state: z.string().length(8), code: z.string().min(1).max(4000) }).parse(req.query);
    await whoop.callback(input.state, input.code);
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').type('text/plain').send('WHOOP is connected. Return to Open Carter and sync health data.');
  }));
  app.post('/api/health/whoop/sync', json, respond(async (_req, res) => res.json(await whoop.sync())));
  app.delete('/api/health/whoop', respond(async (_req, res) => res.json(await whoop.disconnect())));
  app.delete('/api/health/records', json, respond(async (req, res) => {
    const body = healthIdentitySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Provide the source record to delete' });
    await store.remove(body.data.source, body.data.sourceId);
    res.json({ ok: true });
  }));
}
