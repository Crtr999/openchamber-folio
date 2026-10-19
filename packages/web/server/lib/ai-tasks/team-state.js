import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const id = z.string().min(1);
export const scopeSchema = z.object({ projectId: id, teammateId: id }).strict();
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: z.string(), time: z.string(), timezone: id }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string(), timezone: id }).strict(),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(0).max(6)).min(1), time: z.string(), timezone: id }).strict(),
  z.object({ kind: z.literal('cron'), cron: id, timezone: id }).strict(),
]);
export const limitsSchema = z.object({ maxOccurrences: z.number().int().min(1).max(31), tokenGuardrail: z.number().int().min(1).max(10_000_000) }).strict();
export const routineActionsSchema = z.array(z.enum(['read-project', 'fetch-reference', 'draft-output', 'safe-compute', 'read-output'])).min(1).max(5).refine(items => new Set(items).size === items.length);
export const teammateSchema = z.object({ id, projectId: id, projectLabel: id, directory: id, agent: id, role: z.literal('manager'), revision: z.number().int().nonnegative(), readRevision: z.number().int().nonnegative() });
const failure = z.object({ stage: z.enum(['resolve', 'create', 'dispatch', 'inspect', 'pause', 'stall']), code: id, message: id, at: z.number() });
export const childSchema = z.object({ id, title: z.string(), directory: id });
// New runs freeze the effective model. Absence is retained for historical state.
export const teamModelSchema = z.object({ providerID: id, id }).strict();
export const usageSchema = z.object({ kind: z.enum(['available', 'unavailable']), tokens: z.number().nonnegative(), reportedCost: z.number().nonnegative(), sessionIds: z.array(id), dollarCapSupported: z.literal(false) });
export const artifactSchema = z.object({ path: id, label: id, sessionId: id, messageId: id, verified: z.literal(true).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), sizeBytes: z.number().int().nonnegative().optional() });
export const runSchema = z.object({ id, taskId: id, teammateId: id, projectId: id, directory: id, title: id, text: id,
  phase: z.enum(['queued', 'creating', 'dispatching', 'running', 'done', 'needs-you', 'paused']), startedAt: z.number(), revision: z.number().int(),
  sessionId: id.optional(), content: z.string().optional(), failure: failure.optional(), children: z.array(childSchema), artifacts: z.array(artifactSchema), usage: usageSchema,
  inspectFailures: z.number().int().nonnegative(), routineId: id.optional(), scheduledFor: z.number().optional(), policyRevision: id.optional(),
  model: teamModelSchema.optional(), queuePolicyRevision: id.optional(), pendingDispatch: z.literal(true).optional(), cancelledBeforeDispatch: z.literal(true).optional(), queuedAt: z.number().finite().optional(), pausePending: z.boolean().optional(), revisionOf: id.optional(), sourceRevision: z.number().int().nonnegative().optional(), savedContext: z.string().optional(),
  handoffs: z.array(z.object({ sessionId: id, messageId: id, toolId: id, status: z.literal('completed') })).optional(),
  receiptScan: z.object({ kind: z.enum(['partial', 'complete']), incompleteSessionIds: z.array(id) }).optional(),
});
export const routineSchema = z.object({ id, teammateId: id, projectId: id, revision: id, title: id, text: id, schedule: scheduleSchema,
  allowedActions: routineActionsSchema, limits: limitsSchema, status: z.enum(['proposed', 'confirmed', 'paused', 'complete']),
  occurrences: z.number().int().nonnegative(), nextRunAt: z.number().optional(), policyRevision: id, model: teamModelSchema.optional(), failure: failure.optional(),
});
const stateSchema = z.object({ version: z.literal(1), teammates: z.array(teammateSchema), runs: z.array(runSchema), routines: z.array(routineSchema) }).strict();
const lockSchema = z.object({ pid: z.number().int().positive(), nonce: id });

/** One local dispatcher, with dead-PID recovery serialized by an exclusive guard. */
export function createTeamState(filePath) {
  const lockPath = `${filePath}.dispatcher`;
  const nonce = randomUUID();
  let owned = false;
  const assertOwnership = () => {
    if (!owned) throw new Error('Team dispatcher is not claimed.');
    const current = lockSchema.parse(JSON.parse(readFileSync(lockPath, 'utf8')));
    if (current.pid !== process.pid || current.nonce !== nonce) throw new Error('Team dispatcher ownership changed.');
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  const claim = async () => {
    const handle = await open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); }
    finally { await handle.close(); }
    owned = true;
  };
  return {
    async load() {
      if (!owned) {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        try { await claim(); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const previous = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
          if (alive(previous.pid)) throw new Error('Another Mac team dispatcher owns this state.');
          // A crash during recovery itself leaves this guard for manual inspection.
          const guardPath = `${lockPath}.recovery`;
          const guard = await open(guardPath, 'wx', 0o600);
          try {
            const current = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
            if (current.nonce !== previous.nonce || alive(current.pid)) throw new Error('Team dispatcher ownership changed.');
            await unlink(lockPath);
            await claim();
          } finally { await guard.close(); await unlink(guardPath); }
        }
      }
      assertOwnership();
      try { return stateSchema.parse(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch (error) {
        if (error.code === 'ENOENT') return { version: 1, teammates: [], runs: [], routines: [] };
        throw new Error('Team tracking could not be read. No work was started.');
      }
    },
    async save(state) {
      assertOwnership();
      const parsed = stateSchema.parse(state);
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); }
      finally { await handle.close(); }
      assertOwnership();
      await rename(temporary, filePath);
      const directory = await open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    },
    assertOwnership,
    async close() {
      if (!owned) return;
      const current = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
      if (current.nonce !== nonce) throw new Error('Team dispatcher ownership changed.');
      await unlink(lockPath);
      owned = false;
    },
  };
}
