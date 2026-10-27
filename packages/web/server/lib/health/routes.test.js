import { it, expect } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerHealthRoutes } from './routes.js';
import { prepareHealthWorkspace } from './workspace.js';
it('retains health data across authenticated clients without exposing credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-health-http-'));
  const app = express();
  app.use((req, res, next) => req.headers.authorization === 'Bearer fixture' ? next() : res.sendStatus(401));
  registerHealthRoutes(app, { dataDir: directory, prepareWorkspace: () => prepareHealthWorkspace(path.join(directory, 'home')) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = (route, body, method = 'POST') => fetch(base + route, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    expect((await fetch(base + '/api/health/status')).status).toBe(401);
    expect((await first('/api/health/records', { records: [] })).status).toBe(400);
    expect((await first('/api/health/enable', {})).status).toBe(200);
    const record = { kind: 'document', source: 'lab', sourceId: 'fixture-report', start: '2026-10-26T00:00:00Z', end: '2026-10-26T00:00:00Z', title: 'Fixture only', text: 'Example result, not a real medical record' };
    expect((await first('/api/health/records', { records: [record] })).status).toBe(200);
    const second = await fetch(base + '/api/health/query', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: '{}' });
    expect((await second.json()).records[0]).toMatchObject({ sourceId: 'fixture-report' });
    const status = await (await first('/api/health/status', undefined, 'GET')).json();
    expect(status.count).toBe(1);
    expect(status.whoop).toEqual({ configured: false, connected: false });
    expect(JSON.stringify(status)).not.toContain('Example result');
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});
