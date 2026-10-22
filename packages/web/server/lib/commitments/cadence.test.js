import { describe, expect, it } from 'vitest';
import { DAY, checkIntervalMs, isCheckDue, isNudgeEligible, isQuiet, milestoneCrossed, nudgesLeftToday, selectDue } from './cadence.js';

const NOW = Date.UTC(2026, 9, 22, 15, 0);
const item = (over = {}) => ({
  id: 'a', title: 'Paper', status: 'active', origin: 'manual', watches: [], research: true,
  dueAt: NOW + 10 * DAY, createdAt: NOW - 30 * DAY, confirmedAt: null, lastCheckedAt: null,
  snoozedUntil: null, overdueAskedAt: null, ...over,
});

describe('deadline cadence', () => {
  it('tightens as the date approaches', () => {
    const interval = (days) => checkIntervalMs(item({ dueAt: NOW + days * DAY }), NOW);
    expect(interval(30)).toBe(7 * DAY);
    expect(interval(10)).toBe(84 * 3_600_000);
    expect(interval(4)).toBe(DAY);
    expect(interval(0.5)).toBe(12 * 3_600_000);
  });

  it('a watch condition forces at most a daily look', () => {
    expect(checkIntervalMs(item({ dueAt: NOW + 30 * DAY, watches: ['pickup'] }), NOW)).toBe(DAY);
    expect(checkIntervalMs(item({ dueAt: null, watches: ['pickup'] }), NOW)).toBe(DAY);
  });

  it('is due only after its interval has passed', () => {
    const base = item({ dueAt: NOW + 4 * DAY });
    expect(isCheckDue({ ...base, lastCheckedAt: NOW - 2 * 3_600_000 }, NOW)).toBe(false);
    expect(isCheckDue({ ...base, lastCheckedAt: NOW - DAY - 1 }, NOW)).toBe(true);
    expect(isCheckDue({ ...base, lastCheckedAt: null }, NOW)).toBe(true);
  });

  it('asks about an overdue item once, then stops', () => {
    expect(isCheckDue(item({ dueAt: NOW - DAY }), NOW)).toBe(true);
    expect(isCheckDue(item({ dueAt: NOW - DAY, overdueAskedAt: NOW - 1 }), NOW)).toBe(false);
  });

  it('never checks undated items without a watch, done, dismissed or snoozed items', () => {
    expect(isCheckDue(item({ dueAt: null }), NOW)).toBe(false);
    expect(isNudgeEligible(item({ status: 'done' }), NOW)).toBe(false);
    expect(isNudgeEligible(item({ status: 'dismissed' }), NOW)).toBe(false);
    expect(isNudgeEligible(item({ status: 'snoozed', snoozedUntil: NOW + DAY }), NOW)).toBe(false);
    expect(isNudgeEligible(item({ status: 'snoozed', snoozedUntil: NOW - 1 }), NOW)).toBe(true);
  });

  it('keeps an auto-added item silent for a day unless the user looked', () => {
    const fresh = item({ origin: 'auto', createdAt: NOW - 3_600_000 });
    expect(isNudgeEligible(fresh, NOW)).toBe(false);
    expect(isNudgeEligible({ ...fresh, confirmedAt: NOW - 1000 }, NOW)).toBe(true);
    expect(isNudgeEligible({ ...fresh, createdAt: NOW - DAY - 1 }, NOW)).toBe(true);
  });

  it('reports the milestone passed since the last check', () => {
    const base = item({ dueAt: NOW + 1.5 * DAY, lastCheckedAt: NOW - 2 * DAY });
    expect(milestoneCrossed(base, NOW)).toBe('2 days');
    expect(milestoneCrossed({ ...base, lastCheckedAt: NOW - 3_600_000 }, NOW)).toBeNull();
    expect(milestoneCrossed(item({ dueAt: NOW - 1 }), NOW)).toBe('overdue');
    expect(milestoneCrossed(item({ dueAt: null }), NOW)).toBeNull();
  });

  it('knows quiet hours across midnight and the daily budget', () => {
    const settings = { timezone: 'America/New_York', quietStart: '21:00', quietEnd: '08:00', dailyNudgeLimit: 1 };
    expect(isQuiet(Date.UTC(2026, 9, 23, 3, 0), settings)).toBe(true); // 23:00 local
    expect(isQuiet(Date.UTC(2026, 9, 22, 14, 0), settings)).toBe(false); // 10:00 local
    expect(nudgesLeftToday({ settings, delivery: null }, NOW)).toBe(1);
    expect(nudgesLeftToday({ settings, delivery: { day: '2026-10-22', count: 1 } }, NOW)).toBe(0);
    expect(nudgesLeftToday({ settings, delivery: { day: '2026-10-21', count: 1 } }, NOW)).toBe(1);
  });

  it('orders due items by nearest date', () => {
    const state = { items: [item({ id: 'far', dueAt: NOW + 20 * DAY }), item({ id: 'near', dueAt: NOW + 3 * DAY }), item({ id: 'watch', dueAt: null, watches: ['x'] })] };
    expect(selectDue(state, NOW).map((entry) => entry.id)).toEqual(['near', 'far', 'watch']);
  });
});
