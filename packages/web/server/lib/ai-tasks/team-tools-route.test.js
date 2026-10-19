import { expect, it } from 'vitest';
import express from 'express';
import { registerTeamToolsRoute } from './team-tools-route.js';

it('requires the existing managed-child authorization and fails closed without a native team host', async () => {
  const app = express();
  let team;
  registerTeamToolsRoute(app, { express, authorizeRequest: req => req.headers.authorization === 'Bearer test-local', getTeam: () => team });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/openchamber/team-tool`;
  const request = authorization => fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' });
  try {
    expect((await request('Bearer wrong')).status).toBe(401);
    expect((await request('Bearer test-local')).status).toBe(503);
    team = { executeTool: async () => { throw new Error('Sensitive internal failure'); } };
    const refused = await request('Bearer test-local');
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain('Sensitive');
    team = { executeTool: async (_input, { signal }) => { signal.throwIfAborted(); return { content: '{"version":1}' }; } };
    expect(await (await request('Bearer test-local')).json()).toEqual({ content: '{"version":1}' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
