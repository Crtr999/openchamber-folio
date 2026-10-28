import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createZdrLock } from './runtime.js';
import { registerZdrLockRoutes, registerZdrAccessGuard } from './routes.js';
import { createFolderGuard } from '../commitments/zdr-guard.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const make = (clock = { t: 1_000_000 }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdr-lock-'));
  dirs.push(dir);
  const file = path.join(dir, 'zdr-lock.json');
  return { file, clock, lock: createZdrLock({ file, now: () => clock.t }) };
};

test('no PIN set means nothing is guarded', () => {
  const { lock } = make();
  expect(lock.isSet()).toBe(false);
  expect(lock.verify('1234').ok).toBe(true);
});

test('only four digits are accepted, and only a salted hash is stored', () => {
  const { lock, file } = make();
  expect(lock.set('12a4').ok).toBe(false);
  expect(lock.set('123').ok).toBe(false);
  expect(lock.set('4821').ok).toBe(true);
  const stored = fs.readFileSync(file, 'utf8');
  expect(stored).not.toContain('4821');
  expect(JSON.parse(stored).salt).toHaveLength(32);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(lock.verify('4821').ok).toBe(true);
  expect(lock.verify('4822').ok).toBe(false);
});

test('repeated wrong guesses lock the check out, even for the right PIN, then it recovers', () => {
  const { lock, clock } = make();
  lock.set('4821');
  for (let i = 0; i < 4; i += 1) expect(lock.verify('0000').retryAfterMs).toBe(0);
  const fifth = lock.verify('0000');
  expect(fifth.ok).toBe(false); expect(fifth.retryAfterMs).toBeGreaterThan(0);
  expect(lock.verify('4821').ok).toBe(false);
  clock.t += 31_000;
  expect(lock.verify('4821').ok).toBe(true);
});

test('changing or removing the PIN needs the current one', () => {
  const { lock } = make();
  lock.set('4821');
  expect(lock.set('9999', '1111').ok).toBe(false);
  expect(lock.set('9999', '4821').ok).toBe(true);
  expect(lock.clear('4821').ok).toBe(false);
  expect(lock.clear('9999').ok).toBe(true);
  expect(lock.isSet()).toBe(false);
});

test('a damaged PIN record cannot be mistaken for an unset PIN', () => {
  const { lock, file } = make();
  fs.writeFileSync(file, '{broken');
  expect(() => lock.isSet()).toThrow();
  expect(() => lock.verify('1234')).toThrow();
  expect(() => lock.set('1234')).toThrow();
  expect(() => lock.clear('1234')).toThrow();
});

test('folder discovery guards failed bindings and refuses an unavailable list', async () => {
  const app = express();
  let unavailable = false;
  registerZdrLockRoutes(app, {
    lock: make().lock, path,
    listProjectPaths: async () => { if (unavailable) throw new Error('unavailable'); return ['/ordinary', '/unknown', '/ZDR-case']; },
    resolveAllowedProviders: async (directory) => { if (directory === '/unknown') throw new Error('unavailable'); return []; },
  });
  const response = await request(app).get('/api/openchamber/zdr-lock/state');
  expect(response.body.directories).toEqual(['/unknown', '/ZDR-case']);
  unavailable = true;
  expect((await request(app).get('/api/openchamber/zdr-lock/state')).status).toBe(503);
});

test('server refuses scoped reads without a valid PIN grant and revokes expired or explicitly locked grants', async () => {
  const { lock, clock } = make();
  lock.set('4821');
  const app = express();
  app.use(express.json());
  const reads = [];
  const guard = createFolderGuard({ resolveAllowedProviders: async () => [] });
  registerZdrAccessGuard(app, { lock, path, folderGuard: guard, listProjects: async () => [{ id: 'legal', path: '/synthetic/ZDR Legal' }],
    resolveSessionDirectory: async () => '/synthetic/ZDR Legal',
  });
  registerZdrLockRoutes(app, { lock, path, listProjectPaths: async () => ['/synthetic/ZDR Legal'], resolveAllowedProviders: async () => { throw new Error('Must not read named private folder'); } });
  app.use('/api', (req, res) => { reads.push(req.path); res.json({ ok: true }); });
  for (const route of ['/api/fs/raw?path=%2Fsynthetic%2FZDR%20Legal%2Fnote', '/api/session?location%5Bdirectory%5D=%2Fsynthetic%2FZDR%20Legal', '/api/projects/legal/memory']) {
    await request(app).get(route).expect(403);
  }
  await request(app).post('/api/session').send({ location: { directory: '/synthetic/ZDR Legal' } }).expect(403);
  await request(app).get('/api/session').set('x-opencode-directory', encodeURIComponent('/synthetic/ZDR Legal')).expect(403);
  expect(reads).toEqual([]);
  await request(app).get('/api/session/ses_private/message?directory=/synthetic/ordinary').expect(403);
  await request(app).get('/api/session/ses_private/message').expect(403);
  await request(app).get('/api/session?directory=/synthetic/ordinary').expect(200);
  const verified = await request(app).post('/api/openchamber/zdr-lock/verify').send({ pin: '4821' }).expect(200);
  const token = verified.body.accessToken;
  expect(token).toHaveLength(64);
  await request(app).get('/api/session?directory=/synthetic/ZDR').set('x-openchamber-zdr-access', token).expect(200);
  await request(app).post('/api/openchamber/zdr-lock/lock').set('x-openchamber-zdr-access', token).expect(200);
  await request(app).get('/api/session?directory=/synthetic/ZDR').set('x-openchamber-zdr-access', token).expect(403);
  const next = lock.verify('4821');
  clock.t = next.expiresAt + 1;
  await request(app).get('/api/session?directory=/synthetic/ZDR').set('x-openchamber-zdr-access', next.accessToken).expect(403);
});
