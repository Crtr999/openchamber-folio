import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';
import { FOLIO_ASK_AGENT_ID } from './folio-ask-agent.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, folioAvailable = false } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-config-'));
  temporaryDirectories.push(dataDir);
  const agentToolRuntime = {
    pluginDirectory: path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'),
    materializePlugin: vi.fn(async (flags) => {
      await fs.mkdir(agentToolRuntime.pluginDirectory, { recursive: true });
      await fs.writeFile(path.join(agentToolRuntime.pluginDirectory, 'flags.json'), JSON.stringify(flags));
      return agentToolRuntime.pluginDirectory;
    }),
    createChildEnv: vi.fn(() => ({
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3901/api/openchamber/agent-tool',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'token',
    })),
  };
  const current = { settings };
  const runtime = createManagedConfigRuntime({
    fsPromises: fs,
    path,
    dataDir,
    env,
    agentToolRuntime,
    readSettings: () => current.settings,
    isAgentMemoryAvailable: () => memoryAvailable,
    isFolioAvailable: () => folioAvailable,
  });
  const readConfigFile = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));
  return { dataDir, runtime, agentToolRuntime, current, readConfigFile };
};

describe('managed OpenCode config file', () => {
  it('points the child at a config file listing the enabled plugins', async () => {
    const { dataDir, runtime, readConfigFile } = await createHarness({
      settings: {},
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(dataDir, MANAGED_CONFIG_FILE_NAME));
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
    expect(await readConfigFile()).toEqual({
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
      agents: {},
    });
  });

  it('materializes every listed plugin directory before naming it', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();

    for (const directory of (await readConfigFile()).plugins.filter((entry) => !entry.startsWith('-'))) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
  });

  it('keeps the callback token in the child env while every tool is off', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'], agents: {} });
    // A tool switched on later reaches a process that can already call back.
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
  });

  it('rewrites the file when a tool is turned off, without a new token', async () => {
    const { dataDir, runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: {},
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentWebToolEnabled: false };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });

    const { plugins } = await readConfigFile();
    expect(plugins).toEqual(['-opencode.browser']);
    expect(agentToolRuntime.createChildEnv).toHaveBeenCalledTimes(1);
  });

  it('turns a tool back on without a restart', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false },
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentWebToolEnabled: true };
    await runtime.refreshManagedConfigFile();

    expect((await readConfigFile()).plugins).toHaveLength(2);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeWeb: true,
      includeMemory: false,
      includeNotify: false,
      includeFolio: false,
    });
  });

  it('injects the notify tool only when it is switched on', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentNotifyToolEnabled: true },
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeWeb: false,
      includeMemory: false,
      includeNotify: true,
      includeFolio: false,
    });
  });

  it('adds the notebook tool where the desktop app hosts Folio, even with every other tool off', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false },
      folioAvailable: true,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeWeb: false,
      includeMemory: false,
      includeNotify: false,
      includeFolio: true,
    });
  });

  it('leaves a config file the user owns alone and keeps the restart requirement', async () => {
    const { dataDir, runtime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    // No notebook on this install, so nothing of ours is added to the user's
    // own config content beyond the plugin list.
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'test/model',
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
    });
    await expect(fs.stat(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
  });

  it('carries the Ask AI agent into a config the user owns, without touching their own agents', async () => {
    const { runtime } = await createHarness({
      settings: {},
      folioAvailable: true,
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model","agents":{"mine":{"description":"theirs"}}}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    const content = JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT);
    // A page conversation is created on this agent by id, and OpenCode fails the
    // turn for an id it cannot resolve, so it has to reach this path too.
    expect(Object.keys(content.agents).sort()).toEqual([FOLIO_ASK_AGENT_ID, 'mine']);
    expect(content.agents.mine).toEqual({ description: 'theirs' });
  });

  it('refuses to inject its agents into a config content that is not a JSON object', async () => {
    const { runtime } = await createHarness({
      settings: {},
      folioAvailable: true,
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: 'not json' },
    });

    await expect(runtime.buildManagedChildEnv()).rejects.toThrow('valid JSON object');
  });

  it('leaves no temp file behind and never publishes a partial list', async () => {
    const { dataDir, runtime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    await runtime.refreshManagedConfigFile();

    const entries = await fs.readdir(dataDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(entries).toContain(MANAGED_CONFIG_FILE_NAME);
  });

  it('ignores the memory tool while the feature is unavailable', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: true },
      memoryAvailable: false,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'], agents: {} });
  });

  it('publishes the Ask AI agent only where the notebook tool exists', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {}, folioAvailable: true });

    await runtime.buildManagedChildEnv();

    const { agents } = await readConfigFile();
    expect(Object.keys(agents)).toEqual([FOLIO_ASK_AGENT_ID]);
  });

  it('gives the Ask AI agent a system prompt and a ruleset that denies everything but the notebook', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {}, folioAvailable: true });

    await runtime.buildManagedChildEnv();

    const agent = (await readConfigFile()).agents[FOLIO_ASK_AGENT_ID];
    // The turn is built from the agent's system prompt, so an empty one would
    // leave the page conversation running as a worker again.
    expect(agent.system).toContain('Folio notebook');
    // Last match wins in OpenCode, so the catch-all deny has to come first and
    // the notebook tools after it, or a shell command would still be allowed.
    expect(agent.permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'folio', resource: '*', effect: 'allow' },
      { action: 'openchamber', resource: '*', effect: 'allow' },
    ]);
    // Hidden so it never becomes a default agent or shows up in the picker.
    expect(agent.hidden).toBe(true);
  });

  it('leaves no Ask AI agent behind where the notebook is not hosted', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {}, folioAvailable: false });

    await runtime.buildManagedChildEnv();

    expect((await readConfigFile()).agents).toEqual({});
  });
});
