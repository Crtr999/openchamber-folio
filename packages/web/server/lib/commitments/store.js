import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const validZone = (zone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
};
const systemZone = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validZone(zone) ? zone : 'UTC';
};

export const MAX_ITEMS = 200;

export const commitmentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  timezone: z.string().refine(validZone).default(systemZone),
  quietStart: clock.default('21:00'),
  quietEnd: clock.default('08:00'),
  dailyNudgeLimit: z.number().int().min(1).max(5).default(3),
  // Folders the user never wants tracked. The ZDR guard is separate and
  // cannot be switched off from here.
  excludedDirectories: z.array(z.string().min(1).max(4096)).max(100).default([]),
}).passthrough();

export const commitmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  // Epoch milliseconds, or null for something watched without a date.
  dueAt: z.number().int().nullable().default(null),
  status: z.enum(['active', 'done', 'snoozed', 'dismissed']).default('active'),
  origin: z.enum(['auto', 'manual']),
  sourceSessionId: z.string().optional(),
  // Kept so a folder that later becomes excluded stops being checked.
  sourceDirectory: z.string().optional(),
  watches: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  // Work, legal or client matters are tracked but never searched on the web.
  research: z.boolean().default(true),
  finding: z.string().max(1000).default(''),
  findingFingerprint: z.string().default(''),
  snoozedUntil: z.number().int().nullable().default(null),
  // The user's first look at an auto-added item.
  confirmedAt: z.number().int().nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  doneAt: z.number().int().nullable().default(null),
  lastCheckedAt: z.number().int().nullable().default(null),
  lastNudgedAt: z.number().int().nullable().default(null),
  overdueAskedAt: z.number().int().nullable().default(null),
  nudgeCount: z.number().int().nonnegative().default(0),
  lastDecisionSessionId: z.string().nullable().default(null),
  lastDecisionFingerprint: z.string().nullable().default(null),
}).passthrough();

const stateSchema = z.object({
  version: z.literal(1),
  settings: commitmentSettingsSchema,
  items: z.array(commitmentSchema),
  // Messages sent today in the user's time zone; the daily budget.
  delivery: z.object({ day: z.string(), count: z.number().int().nonnegative() }).nullable().default(null),
}).passthrough();

// Only a missing file is an empty list. Anything malformed or from a newer
// version throws, so a bad read can never be followed by a write that erases
// the user's commitments.
export const parseCommitmentsState = (value) => stateSchema.parse(value === undefined
  ? { version: 1, settings: {}, items: [] }
  : value);

const userPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  dueAt: z.number().int().nullable().optional(),
  watches: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
  research: z.boolean().optional(),
  status: z.enum(['active', 'done', 'snoozed', 'dismissed']).optional(),
  snoozedUntil: z.number().int().nullable().optional(),
  confirmed: z.literal(true).optional(),
}).strict();

export const createCommitmentsStore = ({ fs, filePath, now = Date.now, newId = randomUUID }) => {
  let queue = Promise.resolve();

  const readState = async () => {
    let raw;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return parseCommitmentsState(undefined);
      throw error;
    }
    return parseCommitmentsState(JSON.parse(raw));
  };

  const writeState = async (state) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${newId()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  // Writes are serialized and each starts from a fresh read. Returning the
  // same object leaves the file untouched.
  const update = (change) => {
    const run = queue.then(async () => {
      const current = await readState();
      const next = parseCommitmentsState(await change(current));
      if (next !== current) await writeState(next);
      return next;
    });
    queue = run.catch(() => {});
    return run;
  };

  const add = (input) => update((state) => {
    if (state.items.filter((item) => item.status !== 'dismissed').length >= MAX_ITEMS) {
      throw Object.assign(new Error('Too many commitments; remove some first'), { statusCode: 409 });
    }
    const time = now();
    const item = commitmentSchema.parse({
      id: newId(), status: 'active', watches: [], research: true, finding: '',
      ...input, createdAt: time, updatedAt: time,
    });
    return { ...state, items: [...state.items, item] };
  }).then((state) => state.items.at(-1));

  // The user's edits only. The check runtime uses `update` directly, so the
  // agent has no path to mark something done.
  const patch = async (id, changes) => {
    const parsed = userPatchSchema.parse(changes);
    let found = null;
    await update((state) => {
      const time = now();
      return {
        ...state,
        items: state.items.map((item) => {
          if (item.id !== id) return item;
          const { confirmed, ...fields } = parsed;
          const next = { ...item, ...fields, updatedAt: time };
          if (confirmed && !item.confirmedAt) next.confirmedAt = time;
          if (fields.status === 'done') next.doneAt = time;
          if (fields.status === 'active') { next.doneAt = null; next.snoozedUntil = null; }
          if (fields.status && fields.status !== 'snoozed' && fields.snoozedUntil === undefined) next.snoozedUntil = null;
          found = next;
          return next;
        }),
      };
    });
    return found;
  };

  const remove = async (id) => {
    let removed = false;
    await update((state) => {
      const items = state.items.filter((item) => item.id !== id);
      removed = items.length !== state.items.length;
      return removed ? { ...state, items } : state;
    });
    return removed;
  };

  const setSettings = (settings) => update((state) => ({
    ...state, settings: commitmentSettingsSchema.parse({ ...state.settings, ...settings }),
  })).then((state) => state.settings);

  return { read: readState, update, add, patch, remove, setSettings };
};
