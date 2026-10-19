import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createTeamToolsHost, verifyTeamToolsInstallation } from './team-tools-host.js';

const cleanup = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('requires matching entrypoint bytes and an explicit manifest resolving that entrypoint', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'team-install-')));
  cleanup.push(directory);
  const plugin = path.join(directory, '.opencode/plugins/open-carter-team-tools');
  await mkdir(plugin, { recursive: true });
  const source = 'export default {id:"openchamber-team-tools"};';
  await writeFile(path.join(plugin, 'index.mjs'), source);
  const stateFile = path.join(directory, 'host-state.json');
  await writeFile(stateFile + '.tools.json', JSON.stringify({ version: 1, installations: [{ directory, appProjectId: 'app', openCodeProjectId: 'oc', stateFile, sha256: createHash('sha256').update(source).digest('hex') }] }));
  const input = { directory, projectId: 'app', tool: 'team_compute', version: 1 };
  expect(await verifyTeamToolsInstallation(input, stateFile)).toBe(false);
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './index.mjs' } }));
  expect(await verifyTeamToolsInstallation(input, stateFile)).toBe(true);
  expect(await verifyTeamToolsInstallation({ ...input, tool: 'team_read_output' }, stateFile)).toBe(true);
  expect(await verifyTeamToolsInstallation({ ...input, projectId: 'other' }, stateFile)).toBe(false);
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './other.mjs' } }));
  expect(await verifyTeamToolsInstallation(input, stateFile)).toBe(false);
});
it('refuses registration at another actual OpenCode project', async () => {
  const plugin = createTeamToolsHost({ directory: '/approved', appProjectId: 'app', openCodeProjectId: 'oc' });
  await expect(plugin.setup({ location: { directory: '/approved', project: { id: 'other', canonical: '/approved' } } })).rejects.toThrow('location refused');
});
