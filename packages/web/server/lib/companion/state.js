import { z } from 'zod';

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const companionSettingsSchema = z.object({
  activityEnabled: z.boolean().default(false),
  timezone: z.string().refine((zone) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }).default('UTC'),
  quietStart: clock.default('21:00'),
  quietEnd: clock.default('08:00'),
  dailyAlertLimit: z.number().int().min(1).max(20).default(6),
}).passthrough();
const entrySchema = z.object({
  id: z.string().min(1), taskId: z.string().startsWith('companion:'),
  title: z.string().max(160), excerpt: z.string().max(1000), fingerprint: z.string(),
  claimID: z.string().nullable().optional(),
  createdAt: z.number(), seen: z.boolean(), dismissed: z.boolean(),
  attemptedAt: z.number().optional(), leaseUntil: z.number().optional(), retryAt: z.number().optional(),
}).passthrough();
const stateSchema = z.object({
  version: z.literal(1), settings: companionSettingsSchema,
  inbox: z.array(entrySchema),
  wake: z.object({ dueAt: z.number().optional(), sourceSessionId: z.string().optional(), lastEventAt: z.number().optional(), leaseUntil: z.number().optional(), lastWakeAt: z.number().optional(), day: z.string().optional(), count: z.number().int().nonnegative().default(0) }).passthrough(),
}).passthrough();

// Only a missing key is an empty companion. Malformed or future versions
// must throw so an update cannot erase unread work during recovery.
export const parseCompanionState = (value) => stateSchema.parse(value === undefined
  ? { version: 1, settings: {}, inbox: [], wake: {} }
  : value);
