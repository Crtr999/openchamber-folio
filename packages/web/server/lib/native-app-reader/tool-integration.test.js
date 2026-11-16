import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createAgentToolRuntime } from '../agent-tool/runtime.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
it('registers useful direct read/status tools with scoped inputs and no script execution contract', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tool-fixture-')); roots.push(dataDir);
  const calls = [];
  const runtime = createAgentToolRuntime({ crypto, fsPromises: fs, path, dataDir, getActivePort: () => 3901,
    executeAction: async (...args) => { calls.push(args); return { status: 'permission-required', reason: 'fixture' }; } });
  const directory = await runtime.materializePlugin();
  const plugin = await import(pathToFileURL(path.join(directory, 'index.js')).href);
  const tools = [];
  await plugin.default.setup({ tool: { transform: (edit) => edit({ add: (tool) => tools.push(tool) }) } });
  const control = tools.find((tool) => tool.name === 'openchamber');
  expect(control.options).toEqual({ codemode: false });
  const actions = control.input.properties.action.oneOf.map((entry) => entry.const);
  expect(actions).toContain('native.status'); expect(actions).toContain('native.read');
  expect(actions).toContain('native.requestApproval');
  expect(actions).toContain('native.containers');
  const parameters = control.input.properties.parameters.properties;
  expect(parameters.app.enum).toEqual(['calendar', 'reminders', 'notes', 'mail']);
  expect(parameters.containerId).toBeDefined(); expect(parameters.requestedByUser).toBeDefined();
  expect(parameters.script).toBeUndefined(); expect(parameters.command).toBeUndefined();
  const input = { action: 'native.read', app: 'calendar', containerId: 'fixture', requestedByUser: true };
  const result = await runtime.execute({ input, contextDirectory: '/synthetic/General', contextSessionId: 'synthetic-session' });
  expect(result).toMatchObject({ ok: true, action: 'native.read', data: { status: 'permission-required' } });
  expect(calls[0][0]).toBe('native.read');
  expect(calls[0][2]).toBe('/synthetic/General');
  expect(calls[0][3]).toMatchObject({ contextSessionId: 'synthetic-session' });
});
