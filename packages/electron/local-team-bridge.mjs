import { z } from 'zod';

const id = z.string().min(1);
const text = z.string().trim().min(1).max(80_000);
const title = z.string().trim().min(1).max(120);
const schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: id, time: id, timezone: id }).strict(),
  z.object({ kind: z.literal('daily'), time: id, timezone: id }).strict(),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(0).max(6)).min(1), time: id, timezone: id }).strict(),
  z.object({ kind: z.literal('cron'), cron: id, timezone: id }).strict(),
]);
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('team-enqueue'), projectId: id, title, text, requestId: id.max(200), model: z.object({ providerID: id, id }).strict().optional() }).strict(),
  z.object({ action: z.literal('team-cancel-queued'), projectId: id, runId: id }).strict(),
  z.object({ action: z.literal('team-resume-queued'), projectId: id, runId: id }).strict(),
  z.object({ action: z.literal('team-inbox') }).strict(),
  z.object({ action: z.literal('team-details'), projectId: id, teammateId: id }).strict(),
  z.object({ action: z.literal('team-send'), projectId: id, title, text, requestId: id.max(200) }).strict(),
  z.object({ action: z.literal('team-revise'), projectId: id, runId: id, revision: z.number().int().nonnegative(), text, requestId: id.max(200) }).strict(),
  z.object({ action: z.literal('team-recover'), projectId: id, runId: id }).strict(),
  z.object({ action: z.literal('team-ack'), projectId: id, teammateId: id, revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('team-propose-routine'), projectId: id, title, text, schedule,
    allowedActions: z.array(z.enum(['read-project', 'fetch-reference', 'draft-output', 'safe-compute'])).min(1).max(4).refine(items => new Set(items).size === items.length),
    limits: z.object({ maxOccurrences: z.number().int().min(1).max(31), tokenGuardrail: z.number().int().min(1).max(10_000_000) }).strict(),
  }).strict(),
  z.object({ action: z.literal('team-confirm-routine'), projectId: id, routineId: id, revision: id }).strict(),
  z.object({ action: z.literal('team-pause-routine'), projectId: id, routineId: id, revision: id }).strict(),
  z.object({ action: z.literal('team-pause-continuation'), projectId: id, runId: id }).strict(),
]);

/** Called only after main.mjs verifies the trusted local main-frame boundary. */
export function createLocalTeamBridge({ getTeam, now = Date.now }) {
  return {
    async handle(raw) {
      const { action, ...input } = actionSchema.parse(raw);
      const team = getTeam();
      if (!team) return { code: 'team_runtime_unavailable', message: 'Team runtime is not available on this host.', at: now() };
      switch (action) {
        case 'team-enqueue': return team.enqueue(input);
        case 'team-cancel-queued': return team.cancelQueued(input);
        case 'team-resume-queued': return team.resumeQueued(input);
        case 'team-inbox': return team.inbox();
        case 'team-details': return team.details(input);
        case 'team-send': return team.send(input);
        case 'team-revise': return team.revise(input);
        case 'team-recover': return team.recover(input);
        case 'team-ack': return team.ack(input);
        case 'team-propose-routine': return team.proposeRoutine(input);
        case 'team-confirm-routine': return team.confirmRoutine(input);
        case 'team-pause-routine': return team.pauseRoutine(input);
        case 'team-pause-continuation': return team.pauseContinuation(input);
      }
    },
  };
}
