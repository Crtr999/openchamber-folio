import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Carter's ChatGPT/Codex scheduled tasks, mirrored read-only on Home.
//
// The source is the desktop app's own flat TOML files, one directory per task:
//   ~/.codex/automations/<id>/automation.toml
// Nothing here writes under ~/.codex. Open Carter never creates, edits, pauses,
// resumes, deletes or runs one of these jobs, and it never turns an external row
// into a local schedule; doing either could run the same work twice. A ChatGPT
// automation id is a provider identity and is never merged with a local
// project/task id, and no thread URL is derived because no ChatGPT thread link
// scheme has been verified.
//
// The files are parsed with a strict, line-oriented reader for the flat
// `key = "value"` subset Codex writes. Anything it cannot read with full
// confidence is quarantined rather than guessed, so the card reports a partial
// read instead of inventing a row.

const AUTOMATION_FIELDS = ['version', 'id', 'kind', 'name', 'status', 'rrule', 'target_thread_id', 'created_at', 'updated_at', 'prompt'];

const automationSchema = z.object({
  version: z.number().int().positive(),
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  rrule: z.string().min(1),
  target_thread_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  prompt: z.string(),
}).strict();

const listSchema = z.object({ action: z.literal('chatgpt-automations-list') }).strict();

/** Thrown for any file the reader cannot read with full confidence. */
class AutomationReadError extends Error {}

const FIELD_NAME = /^[A-Za-z0-9_]+$/;
const INTEGER = /^-?\d+$/;
// TOML basic strings keep these escapes; anything else is ambiguous here.
const ESCAPES = new Map([['"', '"'], ['\\', '\\'], ['n', '\n'], ['t', '\t'], ['r', '\r']]);

const parseBasicString = (body, line) => {
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '"') throw new AutomationReadError(`line ${line}: unescaped quote in a string`);
    if (character !== '\\') { value += character; continue; }
    const escaped = ESCAPES.get(body[index + 1]);
    if (escaped === undefined) throw new AutomationReadError(`line ${line}: value ends inside an escape or uses an unsupported one`);
    value += escaped;
    index += 1;
  }
  return value;
};

/**
 * Reads the flat `key = value` subset Codex writes for automations.
 * Unknown fields, repeated fields, non-integer numbers and any richer TOML
 * syntax are rejected instead of being approximated.
 */
export function parseAutomationToml(source) {
  const fields = new Map();
  String(source).split('\n').forEach((raw, index) => {
    const number = index + 1;
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).trim();
    if (!line || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator < 1) throw new AutomationReadError(`line ${number}: not a key = value pair`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!FIELD_NAME.test(key)) throw new AutomationReadError(`line ${number}: unsupported key`);
    if (!AUTOMATION_FIELDS.includes(key)) throw new AutomationReadError(`line ${number}: unknown field ${key}`);
    if (fields.has(key)) throw new AutomationReadError(`line ${number}: repeated field ${key}`);
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) throw new AutomationReadError(`line ${number}: unterminated string`);
      fields.set(key, parseBasicString(value.slice(1, -1), number));
      return;
    }
    if (!INTEGER.test(value)) throw new AutomationReadError(`line ${number}: ${key} is not a quoted string or an integer`);
    fields.set(key, Number(value));
  });
  const missing = AUTOMATION_FIELDS.filter((field) => !fields.has(field));
  if (missing.length) throw new AutomationReadError(`missing ${missing.join(', ')}`);
  const parsed = automationSchema.safeParse(Object.fromEntries(fields));
  if (!parsed.success) throw new AutomationReadError(`invalid automation fields: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return parsed.data;
}

const WEEKDAYS = new Map([['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday']]);
const WEEKDAY_INDEX = new Map([['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6], ['SU', 0]]);
// Rules whose next run these files do not state are left unknown rather than guessed.
const UNSUPPORTED_PARTS = ['COUNT', 'UNTIL', 'WKST', 'DTSTART', 'BYMONTH', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS'];

/**
 * Derives a human schedule summary plus the next run the rule actually
 * determines. A rule that states no next run returns a null nextRunAt, and a
 * rule this reader does not fully understand returns understood: false with no
 * summary at all.
 */
export function describeAutomationSchedule(rrule, { from = Date.now(), timeZone = null } = {}) {
  const unknown = { understood: false, summary: '', timeZone, nextRunAt: null };
  const rule = new Map();
  for (const part of String(rrule).replace(/^RRULE:/i, '').split(';').map((part) => part.trim()).filter(Boolean)) {
    const separator = part.indexOf('=');
    if (separator < 1) return unknown;
    const key = part.slice(0, separator).toUpperCase();
    if (rule.has(key)) return unknown;
    rule.set(key, part.slice(separator + 1));
  }
  if (UNSUPPORTED_PARTS.some((part) => rule.has(part))) return unknown;
  const frequency = rule.get('FREQ')?.toUpperCase();
  const interval = rule.has('INTERVAL') ? Number(rule.get('INTERVAL')) : 1;
  if (!frequency || !Number.isInteger(interval) || interval < 1) return unknown;
  const parts = (key) => (rule.has(key) ? rule.get(key).split(',').map((item) => item.trim()) : null);
  if (frequency === 'MINUTELY' || frequency === 'HOURLY') {
    // A clock-aligned interval fixes its own next run; a day or hour selector on
    // top of it needs an anchor this file does not carry.
    if (rule.has('BYDAY') || rule.has('BYHOUR') || rule.has('BYMINUTE')) return unknown;
    const span = frequency === 'MINUTELY' ? interval * 60_000 : interval * 3_600_000;
    const label = frequency === 'MINUTELY'
      ? (interval === 1 ? 'Every minute' : `Every ${interval} minutes`)
      : (interval === 1 ? 'Every hour' : `Every ${interval} hours`);
    return { understood: true, summary: label, timeZone, nextRunAt: Math.ceil((from + 1) / span) * span };
  }
  const hours = (parts('BYHOUR') ?? []).map(Number);
  const minutes = (parts('BYMINUTE') ?? []).map(Number);
  const clock = hours.length > 0 && minutes.length > 0
    && hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    && minutes.every((minute) => Number.isInteger(minute) && minute >= 0 && minute <= 59)
    ? `${String(hours[0]).padStart(2, '0')}:${String(minutes[0]).padStart(2, '0')}` : null;
  // BYSECOND does not change the cadence, but a non-zero second does move the
  // next run inside its minute, which this reader does not place.
  const onTheMinute = (parts('BYSECOND') ?? []).map(Number).every((second) => second === 0);
  const oneTime = hours.length === 1 && minutes.length === 1 && onTheMinute;
  if (clock === null) {
    // The cadence is readable only when the rule states no time selector at
    // all. A selector that is present but unusable leaves the rule unknown.
    if (frequency === 'DAILY' && !rule.has('BYHOUR') && !rule.has('BYMINUTE') && !rule.has('BYSECOND') && !rule.has('BYDAY')) {
      return { understood: true, summary: interval === 1 ? 'Every day' : `Every ${interval} days`, timeZone, nextRunAt: null };
    }
    return unknown;
  }
  if (frequency === 'DAILY') {
    return { understood: true, summary: `${interval === 1 ? 'Every day' : `Every ${interval} days`} at ${clock}`, timeZone,
      nextRunAt: oneTime ? nextTimeOfDay(from, clock) : null };
  }
  if (frequency !== 'WEEKLY') return unknown;
  const days = (parts('BYDAY') ?? []).map((day) => day.toUpperCase());
  // An ordinal BYDAY ("2MO") is a monthly rule this reader does not model.
  const names = days.map((day) => WEEKDAYS.get(day));
  if (!days.length || names.some((name) => !name)) return unknown;
  const cadence = interval === 1 ? 'Every' : `Every ${interval} weeks on`;
  return { understood: true, summary: `${cadence} ${names.join(', ')} at ${clock}`, timeZone,
    nextRunAt: days.length === 1 && oneTime ? nextWeekdayTime(from, WEEKDAY_INDEX.get(days[0]), clock) : null };
}

/** The next local occurrence of a time of day strictly after `from`. */
function nextTimeOfDay(from, clock) {
  const next = new Date(from);
  next.setHours(Number(clock.slice(0, 2)), Number(clock.slice(3, 5)), 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function nextWeekdayTime(from, weekday, clock) {
  const next = new Date(from);
  next.setHours(Number(clock.slice(0, 2)), Number(clock.slice(3, 5)), 0, 0);
  next.setDate(next.getDate() + (weekday - next.getDay() + 7) % 7);
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.getTime();
}

/** Called only after main.mjs verifies the trusted local main-frame boundary. */
export function createChatGPTAutomationsBridge({
  homeDirectory = os.homedir,
  readDirectory = readdirSync,
  readFile = readFileSync,
  resolveTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = Date.now,
} = {}) {
  const readTask = (id, directory, timeZone) => {
    const automation = parseAutomationToml(readFile(path.join(directory, id, 'automation.toml'), 'utf8'));
    // The directory name is the provider identity. A file claiming another id
    // cannot be matched to a job with confidence.
    if (automation.id !== id) throw new AutomationReadError('id does not match its automation directory');
    return {
      providerJobId: automation.id,
      name: automation.name,
      kind: automation.kind,
      status: automation.status,
      rrule: automation.rrule,
      providerThreadId: automation.target_thread_id,
      createdAt: automation.created_at,
      updatedAt: automation.updated_at,
      schedule: describeAutomationSchedule(automation.rrule, { from: now(), timeZone }),
    };
  };
  return {
    async handle(raw) {
      listSchema.parse(raw);
      const readAt = now();
      const timeZone = resolveTimeZone() || null;
      const directory = path.join(homeDirectory(), '.codex', 'automations');
      let entries;
      try {
        entries = readDirectory(directory, { withFileTypes: true });
      } catch (failure) {
        // A missing folder is an explicit empty feed. Every other read failure
        // stays an error so the card keeps its last good rows and says so.
        if (failure?.code === 'ENOENT') return { rows: [], readAt, partial: false, skipped: [] };
        return { rows: [], readAt, partial: false, skipped: [], error: failure instanceof Error ? failure.message : String(failure) };
      }
      const rows = [];
      const skipped = [];
      for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
        try { rows.push(readTask(entry, directory, timeZone)); }
        catch { skipped.push(entry); }
      }
      rows.sort((a, b) => (a.schedule.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.schedule.nextRunAt ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name));
      return { rows, readAt, partial: skipped.length > 0, skipped };
    },
  };
}