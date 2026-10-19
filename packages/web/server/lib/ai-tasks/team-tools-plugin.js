import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { teamCompute } from './team-compute.js';
import { createTeamOutputWriter, createTeamOutputReader, teamOutputInput, teamReadOutputInput } from './team-compute-output.js';

const sessionSchema = z.object({ id: z.string().min(1), location: z.object({ directory: z.string().min(1) }) });
const locationSchema = z.object({ directory: z.string().min(1), project: z.object({ id: z.string().min(1), canonical: z.string().min(1) }) });
// A single JSON string survives the exact free model's string-only tool arguments.
// Decoding is data-only; teamCompute still strictly validates every field and limit.
export const computeRequestSchema = z.object({ request: z.string().min(1).max(131072) }).strict();

/** Only the serialized production dispatcher calls this synchronous writer. */
export function createTeamOperation({ directory }) {
  const write = createTeamOutputWriter({ directory, exclusiveOutputOwnership: true });
  const read = createTeamOutputReader({ directory, exclusiveOutputOwnership: true });
  return (action, input, { signal, receipt }) => {
    if (action === 'team_compute') return teamCompute(JSON.parse(computeRequestSchema.parse(input).request), { signal });
    if (action === 'team_output') return write(input, { signal });
    if (action === 'team_read_output') return read(input, { signal, receipt });
    throw new Error('Unknown team operation');
  };
}

async function boundedRequest(signal, request) {
  const budget = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  budget.throwIfAborted();
  let rejectOnAbort;
  const interrupted = new Promise((resolve, reject) => {
    rejectOnAbort = () => reject(budget.reason);
    budget.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([request(budget), interrupted]);
  } finally {
    budget.removeEventListener('abort', rejectOnAbort);
  }
}

/** Host injects Plugin from its existing @opencode/plugin resolution. No config writes. */
export function createTeamToolsPlugin(Plugin, { directory, projectId, authorize, readReceipt, exclusiveOutputOwnership }) {
  const root = z.string().min(1).parse(directory);
  const projectID = z.string().min(1).parse(projectId);
  if (realpathSync(root) !== root) throw new Error('Canonical team directory required');
  const writeOutput = createTeamOutputWriter({ directory: root, exclusiveOutputOwnership });
  const readOutput = createTeamOutputReader({ directory: root, exclusiveOutputOwnership });
  return Plugin.define({
    id: 'openchamber-team-tools',
    async setup(ctx) {
      const location = locationSchema.parse(ctx.location);
      if (location.directory !== root || location.project.canonical !== root || location.project.id !== projectID) throw new Error('Team plugin location refused');
      const execute = (action, operation) => async (input, context) => {
        const signal = context.signal;
        signal.throwIfAborted();
        const sessionID = z.string().min(1).parse(context.sessionID);
        const session = sessionSchema.parse(await boundedRequest(signal, budget => ctx.session.get({ sessionID }, { signal: budget })));
        if (session.id !== sessionID || session.location.directory !== root || realpathSync(root) !== root) throw new Error('Team session scope refused');
        // Approval derives from current host run identity and capability grants, not model inputs or plugin options.
        const allowed = await boundedRequest(signal, budget => authorize({ sessionID, directory: root, projectId: projectID, action, signal: budget }));
        if (allowed !== true) throw new Error('Team capability permission refused');
        const current = sessionSchema.parse(await boundedRequest(signal, budget => ctx.session.get({ sessionID }, { signal: budget })));
        if (current.id !== sessionID || current.location.directory !== root || realpathSync(root) !== root) throw new Error('Team session scope refused');
        signal.throwIfAborted();
        const receipt = action === 'team_read_output' ? await boundedRequest(signal, budget => readReceipt({ sessionID, input, signal: budget })) : undefined;
        signal.throwIfAborted();
        return { content: JSON.stringify(operation(input, { signal, receipt })) };
      };
      const registration = await ctx.tool.transform((editor) => {
        editor.add({ name: 'team_compute', description: 'Bounded numeric arithmetic. Supply request as a JSON string, for example {"request":"{\"operation\":\"stats\",\"values\":[1,2,3,4]}"}. Operations: stats (values), compound_growth (principal, rate, periods, contribution), weekly_below_average (prices, weeklyBudget, lookback). No code, shell, files or network. Contributions are end-of-period. Backtests use only preceding lookback weeks, accumulate cash during warm-up, spend all cash below average, and ignore fees and taxes.', input: z.toJSONSchema(computeRequestSchema), options: { codemode: false }, execute: execute('team_compute', (input, options) => teamCompute(JSON.parse(computeRequestSchema.parse(input).request), options)) });
        editor.add({ name: 'team_output', description: 'Create a new flat txt, md, csv or json deliverable in the approved team-output directory. Never overwrite. Returns exact path, byte count and SHA-256 receipt. No external publishing.', input: teamOutputInput, options: { codemode: false }, execute: execute('team_output', writeOutput) });
        editor.add({ name: 'team_read_output', description: 'Read actual output bytes for independent review. Pass {"filename":"draft.md"}, the flat filename from a current task team_output receipt. No listing, source files or paths. Use supplied brief inline; never read dot or scan folders.', input: teamReadOutputInput, options: { codemode: false }, execute: execute('team_read_output', readOutput) });
      });
      return () => registration.dispose();
    },
  });
}
