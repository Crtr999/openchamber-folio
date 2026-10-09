import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerFsRoutes, mintOutsideFileGrant } from './routes.js';
import { createFsSearchRuntime } from './search.js';
import { registerPrivateMeetingDirectory, isPrivateMeetingPath } from '../meetings/private-paths.js';

describe('private meeting filesystem exclusion', () => {
  let root;
  let privateRoot;
  let file;
  let alias;
  let app;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-fs-guard-'));
    privateRoot = path.join(root, 'private-meetings');
    await fs.mkdir(privateRoot);
    file = path.join(privateRoot, 'synthetic.json');
    await fs.writeFile(file, '{"notes":"synthetic private text"}');
    await fs.writeFile(path.join(root, 'public.txt'), 'public');
    alias = path.join(root, 'alias');
    await fs.symlink(privateRoot, alias);
    registerPrivateMeetingDirectory(privateRoot);
    app = express();
    app.use(express.json());
    registerFsRoutes(app, {
      os, path, fsPromises: fs, crypto: globalThis.crypto,
      normalizeDirectoryPath: value => value,
      resolveProjectDirectory: async () => ({ directory: root }),
      openchamberUserConfigRoot: root,
      spawn: () => { throw new Error('Unexpected process spawn'); },
      resolveGitBinaryForSpawn: () => 'git',
    });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it.each(['read', 'raw', 'stat'])('refuses %s even with outside-workspace and legacy grant overrides', async route => {
    for (const target of [file, path.join(alias, 'synthetic.json')]) {
      const response = await request(app).get(`/api/fs/${route}`).query({ path: target, allowOutsideWorkspace: 'true', outsideFileGrant: 'ignored', download: 'true', optional: 'true' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('private_meeting_path');
      expect(response.text).not.toContain('synthetic private text');
    }
  });

  it('refuses direct content serving and file grants', async () => {
    expect((await request(app).get(`/api/fs/serve/${file.slice(1)}`)).status).toBe(403);
    await expect(mintOutsideFileGrant(file)).rejects.toThrow('Private meeting');
  });

  it.each(['list', 'directory-stat', 'git-dirs'])('refuses private %s and symlink aliases', async route => {
    for (const target of [privateRoot, alias]) {
      expect((await request(app).get(`/api/fs/${route}`).query({ path: target })).status).toBe(403);
    }
  });

  it('hides the private directory and its aliases from parent listings', async () => {
    const response = await request(app).get('/api/fs/list').query({ path: root });
    expect(response.status).toBe(200);
    expect(response.body.entries.map(entry => entry.name)).toEqual(['public.txt']);
  });

  it('refuses existing and nonexistent write targets through symlink parents', async () => {
    for (const target of [file, path.join(alias, 'new', 'record.json')]) {
      expect((await request(app).post('/api/fs/write').send({ path: target, content: 'overwrite' })).status).toBe(403);
      expect((await request(app).post('/api/fs/mkdir').send({ path: target })).status).toBe(403);
      expect((await request(app).post('/api/fs/upload').query({ path: target }).set('Content-Type', 'application/octet-stream').send('overwrite')).status).toBe(403);
    }
    expect(await fs.readFile(file, 'utf8')).toContain('synthetic private text');
  });

  it('refuses ancestor deletion and rename in either direction', async () => {
    expect((await request(app).post('/api/fs/delete').send({ path: root })).status).toBe(403);
    for (const [oldPath, newPath] of [[root, `${root}-renamed`], [path.join(root, 'public.txt'), file]]) {
      expect((await request(app).post('/api/fs/rename').send({ oldPath, newPath })).status).toBe(403);
    }
    expect(await fs.readFile(file, 'utf8')).toContain('synthetic private text');
  });

  it('refuses recursive searches scoped above or inside private storage', async () => {
    const search = createFsSearchRuntime({ fsPromises: fs, path });
    for (const target of [root, privateRoot, alias]) {
      await expect(search.searchFilesystemFiles(target, { query: '', limit: 20, respectGitignore: false })).rejects.toThrow('Private meeting');
    }
    expect(await isPrivateMeetingPath(path.join(alias, 'not-created', 'record.json'))).toBe(true);
    expect(await isPrivateMeetingPath(`${privateRoot}-public`)).toBe(false);
  });

  it('preserves ordinary outside-workspace file reads', async () => {
    const response = await request(app).get('/api/fs/read').query({ path: path.join(root, 'public.txt'), allowOutsideWorkspace: 'true' });
    expect(response.status).toBe(200);
    expect(response.text).toBe('public');
  });
});
