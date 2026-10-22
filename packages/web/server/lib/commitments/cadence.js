import { DateTime } from 'luxon';

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
// An auto-added item stays silent for a day unless the user has looked at it.
export const AUTO_GRACE_MS = DAY;
// Moments worth a message even when nothing new was found.
const MILESTONES = [
  { label: '7 days', ms: 7 * DAY },
  { label: '2 days', ms: 2 * DAY },
  { label: '1 day', ms: DAY },
  { label: 'today', ms: 0 },
];

/** How long to wait between checks, from how close the date is. */
export const checkIntervalMs = (item, now) => {
  const watched = item.watches.length > 0 ? DAY : Infinity;
  if (item.dueAt == null) return watched;
  const left = item.dueAt - now;
  const byDate = left <= DAY ? 12 * HOUR : left <= 7 * DAY ? DAY : left <= 14 * DAY ? 84 * HOUR : 7 * DAY;
  return Math.min(byDate, watched);
};

export const isNudgeEligible = (item, now) => {
  if (item.status === 'done' || item.status === 'dismissed') return false;
  if (item.status === 'snoozed' && (item.snoozedUntil == null || item.snoozedUntil > now)) return false;
  if (item.snoozedUntil != null && item.snoozedUntil > now) return false;
  if (item.origin === 'auto' && !item.confirmedAt && now - item.createdAt < AUTO_GRACE_MS) return false;
  return true;
};

export const isCheckDue = (item, now) => {
  if (!isNudgeEligible(item, now)) return false;
  if (item.dueAt != null && item.dueAt < now) return !item.overdueAskedAt;
  if (item.dueAt == null && item.watches.length === 0) return false;
  return now - (item.lastCheckedAt ?? 0) >= checkIntervalMs(item, now);
};

/** The milestone passed since the last check, if any. */
export const milestoneCrossed = (item, now) => {
  if (item.dueAt == null) return null;
  if (item.dueAt < now) return 'overdue';
  const since = item.lastCheckedAt ?? item.createdAt;
  const before = item.dueAt - since;
  const after = item.dueAt - now;
  return MILESTONES.find(({ ms }) => before > ms && after <= ms)?.label ?? null;
};

export const localDay = (time, zone) => DateTime.fromMillis(time, { zone }).toISODate();

export const isQuiet = (time, settings) => {
  const clock = DateTime.fromMillis(time, { zone: settings.timezone }).toFormat('HH:mm');
  const { quietStart: start, quietEnd: end } = settings;
  if (start === end) return false;
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
};

export const nudgesLeftToday = (state, time) => {
  const day = localDay(time, state.settings.timezone);
  const sent = state.delivery?.day === day ? state.delivery.count : 0;
  return Math.max(0, state.settings.dailyNudgeLimit - sent);
};

/** Due items, nearest date first; undated watches go last. */
export const selectDue = (state, time) => state.items
  .filter((item) => isCheckDue(item, time))
  .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
