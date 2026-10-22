import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

export const commitmentSettingsSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string(),
  quietStart: z.string(),
  quietEnd: z.string(),
  dailyNudgeLimit: z.number(),
  excludedDirectories: z.array(z.string()),
});

export const commitmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueAt: z.number().nullable(),
  status: z.enum(['active', 'done', 'snoozed', 'dismissed']),
  origin: z.enum(['auto', 'manual']),
  watches: z.array(z.string()).default([]),
  research: z.boolean(),
  finding: z.string().nullable().optional(),
  snoozedUntil: z.number().nullable().optional(),
  confirmedAt: z.number().nullable().optional(),
});

const listSchema = z.object({ settings: commitmentSettingsSchema, items: z.array(commitmentSchema) });

export type CommitmentSettings = z.infer<typeof commitmentSettingsSchema>;
export type Commitment = z.infer<typeof commitmentSchema>;
export type CommitmentList = z.infer<typeof listSchema>;
export type CheckOutcome = 'started' | 'busy' | 'excluded' | 'failed';

const base = '/api/commitments';
const json = { 'Content-Type': 'application/json' };

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  const response = await runtimeFetch(`${base}${path}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Commitments request failed (${response.status})`);
  return response;
}

export async function readCommitments(): Promise<CommitmentList> {
  const response = await runtimeFetch(base);
  if (!response.ok) throw new Error(`Commitments request failed (${response.status})`);
  return listSchema.parse(await response.json());
}

export const addCommitment = (input: { title: string; dueAt: number | null; watches: string[]; research: boolean }) => send('', 'POST', input).then(() => undefined);
export const updateCommitment = (id: string, patch: Record<string, unknown>) => send(`/${encodeURIComponent(id)}`, 'PATCH', patch).then(() => undefined);
export const removeCommitment = (id: string) => send(`/${encodeURIComponent(id)}`, 'DELETE').then(() => undefined);
export const saveCommitmentSettings = (patch: Partial<CommitmentSettings>) => send('/settings', 'PUT', patch).then(() => undefined);

/** Maps the server's answer to an outcome the card can word; never throws on a refused check. */
export async function checkCommitmentNow(id: string): Promise<CheckOutcome> {
  const response = await runtimeFetch(`${base}/${encodeURIComponent(id)}/check`, { method: 'POST', headers: json, body: '{}' });
  if (response.status === 202) return 'started';
  if (response.status === 409) return 'busy';
  if (response.status === 403) return 'excluded';
  return 'failed';
}

export type DueLabel =
  | { key: 'commitments.due.noDate' }
  | { key: 'commitments.due.today' }
  | { key: 'commitments.due.tomorrow' }
  | { key: 'commitments.due.inDays'; count: number }
  | { key: 'commitments.due.overdueDay' }
  | { key: 'commitments.due.overdueDays'; count: number };

const startOfDay = (value: number) => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Whole calendar days from `now` to `dueAt` in the viewer's zone, as a label key. */
export function dueLabel(dueAt: number | null, now = Date.now()): DueLabel {
  if (dueAt === null) return { key: 'commitments.due.noDate' };
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000);
  if (days === 0) return { key: 'commitments.due.today' };
  if (days === 1) return { key: 'commitments.due.tomorrow' };
  if (days > 1) return { key: 'commitments.due.inDays', count: days };
  if (days === -1) return { key: 'commitments.due.overdueDay' };
  return { key: 'commitments.due.overdueDays', count: -days };
}
