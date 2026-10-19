import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freeTeamGuardDirectory, freeTeamGuardSource, verifyFreeTeamExecution } from './team-host-guard.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('attests the exact reviewed guard and rules, rejecting altered source or selected model', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-host-guard-')));
  roots.push(directory);
  const input = { directory, model: { providerID: 'openrouter', id: 'exact:free' }, manager: { id: 'manager', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }, specialists: [] };
  const file = path.join(freeTeamGuardDirectory(directory), 'index.mjs');
  await mkdir(path.dirname(file), { recursive: true });
  const source = await freeTeamGuardSource(input);
  await writeFile(file, source);
  expect(await verifyFreeTeamExecution(input)).toBe(true);
  expect(await verifyFreeTeamExecution({ ...input, model: { providerID: 'openrouter', id: 'other:free' } })).toBe(false);
  await writeFile(file, source.replace("throw new Error('Free-only team work refuses", "console.log('Free-only team work refuses"));
  expect(await verifyFreeTeamExecution(input)).toBe(false);
  await writeFile(file, source);
  expect(await verifyFreeTeamExecution(input)).toBe(true);
});
