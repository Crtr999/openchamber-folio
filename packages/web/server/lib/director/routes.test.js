import { expect, test } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { buildDirectorPrompt, cleanImprovedPrompt, registerDirectorRoutes } from './routes.js';

test('the prompt carries rules, memory and the draft, and marks them as data', () => {
  const text = buildDirectorPrompt({ folderName: 'Business Launch', rules: 'Be terse.', memoryFile: 'Kelby Capital LLC', entries: [{ title: 'Entity', body: 'PA single-member' }], draft: 'fix the OA' });
  expect(text).toContain('FOLDER: Business Launch');
  expect(text).toContain('Kelby Capital LLC');
  expect(text).toContain('- Entity: PA single-member');
  expect(text).toContain('<draft>\nfix the OA\n</draft>');
});

test('wrappers around the improved prompt are removed', () => {
  expect(cleanImprovedPrompt('```\nDo the thing.\n```')).toBe('Do the thing.');
  expect(cleanImprovedPrompt('Improved prompt: Do the thing.')).toBe('Do the thing.');
  expect(cleanImprovedPrompt('"Do the thing."')).toBe('Do the thing.');
  expect(cleanImprovedPrompt(undefined)).toBe('');
});

const start = async ({ allowed = [], configured, generate }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'director-'));
  await fs.writeFile(path.join(dir, 'MEMORY.md'), 'Entity is Kelby Capital LLC.');
  const app = express();
  const calls = [];
  registerDirectorRoutes(app, {
    fsPromises: fs, path,
    agentMemoryRuntime: { readAll: async () => ({ project: [{ title: 'Name', body: 'Kelby' }], global: [] }) },
    isAgentMemoryEnabled: async () => true,
    resolveProjectId: async () => 'p1',
    resolveAllowedProviders: async () => allowed,
    listProjectPaths: async () => configured ?? [dir],
    getSmallModelService: async () => ({ generateSmallModelText: async (input) => { calls.push(input); return generate ? generate(input) : { text: 'Improved draft.', modelID: 'm' }; } }),
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = (body) => fetch('http://127.0.0.1:' + server.address().port + '/api/openchamber/director/improve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { dir, post, calls, close: () => new Promise((resolve) => server.close(resolve)) };
};

test('improves a draft with the folder memory and reports what it used', async () => {
  const h = await start({});
  try {
    const res = await h.post({ prompt: 'fix the OA', directory: h.dir, folderName: 'Business Launch' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('Improved draft.');
    expect(body.used).toEqual({ rules: false, memoryFile: true, entries: 1 });
    expect(h.calls[0].prompt).toContain('Entity is Kelby Capital LLC.');
  } finally { await h.close(); }
});

test('refuses ZDR folders, unconfigured folders and empty drafts without calling a model', async () => {
  const zdr = await start({ allowed: ['openrouter-zdr'] });
  try {
    const res = await zdr.post({ prompt: 'x', directory: zdr.dir });
    expect(res.status).toBe(403); expect((await res.json()).reason).toBe('zdr'); expect(zdr.calls).toHaveLength(0);
  } finally { await zdr.close(); }
  const other = await start({ configured: ['/somewhere/else'] });
  try {
    expect((await other.post({ prompt: 'x', directory: other.dir })).status).toBe(403);
    expect((await other.post({ prompt: '  ', directory: other.dir })).status).toBe(400);
    expect(other.calls).toHaveLength(0);
  } finally { await other.close(); }
});

test('a model failure comes back as an error the composer can fall back from', async () => {
  const h = await start({ generate: async () => { throw Object.assign(new Error('no model'), { statusCode: 404 }); } });
  try {
    const res = await h.post({ prompt: 'x', directory: h.dir });
    expect(res.status).toBe(404);
  } finally { await h.close(); }
});
