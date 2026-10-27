import { appendManagedPlugin } from './managed-plugin-config.js';
import { isMemoryToolEnabledBySettings } from '../agent-memory/feature-flag.js';

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

/**
 * Built-in OpenCode plugins OpenChamber switches off for its managed child.
 *
 * `opencode.browser` only works when OpenCode's own desktop app attaches a
 * browser to the session; OpenChamber does not implement that protocol, so its
 * tools always fail with `browser.disconnected` and agents conclude browsing is
 * unavailable instead of using `openchamber_web`. A project config that lists
 * `opencode.browser` still re-enables it, because that layer sits above ours.
 */
const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];

/**
 * Browser MCP servers the app does not start.
 *
 * OpenCode starts a copy of every MCP server for every agent that can use it,
 * and the app's runtime knows every agent in every folder — so three browser
 * servers became fifty-nine copies, a hundred and fifteen processes, and about
 * two gigabytes of memory the machine was spending on duplicate browsers.
 *
 * The app already has a browser: its own panel, its own Chromium, which the
 * user can watch while the agent works, and the `openchamber_web` tool that
 * drives it. A second browser behind a second protocol buys nothing and costs
 * the machine its memory, so the app does not start these.
 *
 * The user's own configuration is untouched: these servers still run for any
 * other client, and the setting below turns them back on inside the app.
 */
const APP_OWNED_BROWSER_MCP_SERVERS = ['playwright', 'chrome-devtools'];

/**
 * The managed OpenCode config layer.
 *
 * OpenCode 2 watches every config source it reads, including the file named by
 * the `OPENCODE_CONFIG` environment variable, and reloads its plugin list when
 * that file changes. Writing OpenChamber's own plugin entries into a file we
 * own therefore makes toggling a managed tool take effect in the running
 * process — where `OPENCODE_CONFIG_CONTENT` (an environment variable) could
 * only ever change across a restart.
 *
 * The file is OpenChamber-owned and holds nothing but `plugins`: the built-in
 * plugins OpenChamber disables, then its own plugin directories. It sits above
 * the user's global `opencode.json` and below their project config, so it never
 * shadows a project-level choice.
 *
 * When the user's own environment already sets `OPENCODE_CONFIG`, that file is
 * theirs: OpenChamber does not hijack it and falls back to merging its plugins
 * into `OPENCODE_CONFIG_CONTENT`, which keeps the old restart requirement for
 * managed-tool toggles.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.dataDir OpenChamber data directory
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => boolean} dependencies.isAgentMemoryAvailable
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  dataDir,
  env = process.env,
  agentToolRuntime = null,
  getWebsiteProviders = () => ({}),
  readSettings,
  isAgentMemoryAvailable,
}) => {
  const filePath = path.join(dataDir, MANAGED_CONFIG_FILE_NAME);
  let activeChildEnv = {};

  /** The user owns `OPENCODE_CONFIG` when their environment already set it. */
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async (pluginDirectories) => {
    await fsPromises.mkdir(dataDir, { recursive: true });
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    // The browser servers the app already provides are not started unless the
    // user asks for them inside the app.
    const disabledServers = settings?.appRunsBrowserMcpServers === true
      ? {}
      : Object.fromEntries(APP_OWNED_BROWSER_MCP_SERVERS.map((name) => [name, { disabled: true }]));
    const websiteProviders = getWebsiteProviders(activeChildEnv);
    const managed = {
      plugins: [...DISABLED_BUILTIN_PLUGINS, ...pluginDirectories],
      ...(Object.keys(websiteProviders).length ? { providers: websiteProviders } : {}),
      ...(Object.keys(disabledServers).length > 0 ? { mcp: { servers: disabledServers } } : {}),
    };
    const text = `${JSON.stringify(managed, null, 2)}\n`;
    // Temp + rename: OpenCode reacts to the write immediately, and a partial
    // read would make it drop every managed plugin until the next change.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  /**
   * Materialize the plugins the current settings ask for and return their
   * directories in load order. Directories exist on disk before the config
   * file names them.
   */
  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = isAgentMemoryAvailable() && isMemoryToolEnabledBySettings(settings);
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const codeMode = settings?.agentToolsCodeMode === true;

    const directories = [];
    if (agentToolRuntime && (includeControl || includeWeb || includeMemory || includeNotify)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeWeb, includeMemory, includeNotify, codeMode }));
    }
    return directories;
  };

  /**
   * Environment for a managed OpenCode child: the callback URL and per-child
   * token are always present, so a tool enabled later in the session can still
   * call back without a restart.
   */
  const buildManagedChildEnv = async () => {
    const directories = await materializeEnabledPlugins();
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    activeChildEnv = childEnv;
    if (ownsConfigFile()) {
      await writeConfigFile(directories);
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...DISABLED_BUILTIN_PLUGINS, ...directories]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    const websiteProviders = getWebsiteProviders(activeChildEnv);
    if (Object.keys(websiteProviders).length) {
      const config = content ? JSON.parse(content) : {};
      content = JSON.stringify({ ...config, providers: { ...websiteProviders, ...config.providers } });
    }
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  /**
   * Rewrite the managed config file after a managed-plugin setting changed, so
   * the running OpenCode picks the new plugin list up. A no-op when the user
   * owns `OPENCODE_CONFIG`; those installs still need a restart.
   *
   * @returns {Promise<{updated: boolean, reason?: string}>}
   */
  const refreshManagedConfigFile = async () => {
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeConfigFile(await materializeEnabledPlugins());
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
  };
};
