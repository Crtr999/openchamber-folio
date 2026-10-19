import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { computeRequestSchema } from './team-tools-plugin.js';
import { teamOutputInput, teamReadOutputInput } from './team-compute-output.js';

const actionCapability = { team_compute: 'safe-compute', team_output: 'draft-output', team_read_output: 'read-output' };

/** Plain v2 plugin definitions are supported by the installed runtime. No download. */
export function createTeamToolsHost({ directory, appProjectId, openCodeProjectId }) {
  return {
    id: 'openchamber-team-tools',
    async setup(ctx) {
      if (ctx.location.directory !== directory || ctx.location.project.id !== openCodeProjectId || ctx.location.project.canonical !== directory) throw new Error('Team plugin location refused');
      const source = new URL(process.env.OPENCHAMBER_AGENT_TOOL_URL);
      if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.pathname !== '/api/openchamber/agent-tool') throw new Error('Local team host unavailable');
      const token = z.string().min(1).parse(process.env.OPENCHAMBER_AGENT_TOOL_TOKEN);
      const endpoint = new URL('/api/openchamber/team-tool', source).href;
      for (const name of ['NO_PROXY', 'no_proxy']) process.env[name] = [process.env[name], '127.0.0.1'].filter(Boolean).join(',');
      const execute = action => async (input, context) => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
        signal.throwIfAborted();
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: appProjectId, sessionID: context.sessionID, action, input }),
        });
        if (!response.ok) throw new Error('Team host operation refused');
        const result = z.object({ content: z.string() }).strict().parse(await response.json());
        signal.throwIfAborted();
        return result;
      };
      const registration = await ctx.tool.transform(editor => {
        editor.add({ name: 'team_compute', description: 'Fixed arithmetic. Pass request as a JSON STRING containing {operation: stats, values: [1,2,3,4]} with valid quoted JSON keys. Operations: stats, compound_growth, weekly_below_average. No code, shell, files or network.', input: z.toJSONSchema(computeRequestSchema), options: { codemode: false }, execute: execute('team_compute') });
        editor.add({ name: 'team_output', description: 'Create one new flat txt, md, csv or json file inside team-output. Never overwrite or publish. Returns exact path, bytes and SHA-256 receipt.', input: teamOutputInput, options: { codemode: false }, execute: execute('team_output') });
        editor.add({ name: 'team_read_output', description: 'Independently read a current task artifact. Example {"filename":"draft.md"}, using the flat filename from its team_output receipt. Only host-verified current task outputs are readable. No directory listing or source reads. Evaluate supplied brief inline; never scan dot.', input: teamReadOutputInput, options: { codemode: false }, execute: execute('team_read_output') });
      });
      return () => registration.dispose();
    },
  };
}

const installationSchema = z.object({ version: z.literal(1), installations: z.array(z.object({ directory: z.string(), appProjectId: z.string(),
  openCodeProjectId: z.string(), stateFile: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();

/** Native host registry is outside agent output and project configuration. */
export async function verifyTeamToolsInstallation({ directory, projectId, tool, version }, stateFile) {
  if (version !== 1 || !Object.hasOwn(actionCapability, tool)) return false;
  try {
    const registry = installationSchema.parse(JSON.parse(await readFile(stateFile + '.tools.json', 'utf8')));
    const matches = registry.installations.filter(item => item.directory === directory && item.appProjectId === projectId && item.stateFile === stateFile);
    if (matches.length !== 1) return false;
    const file = path.join(directory, '.opencode/plugins/open-carter-team-tools/index.mjs');
    if (await realpath(file) !== file) return false;
    const manifest = JSON.parse(await readFile(path.join(path.dirname(file), 'package.json'), 'utf8'));
    if (manifest.type !== 'module' || manifest.exports?.['.'] !== './index.mjs') return false;
    return createHash('sha256').update(await readFile(file)).digest('hex') === matches[0].sha256;
  } catch { return false; }
}
