import type { UsageWindow } from '@/types';

export type SubscriptionRing = {
  key: string;
  window: UsageWindow;
};

export type SubscriptionRings = {
  outer: SubscriptionRing | null;
  inner: SubscriptionRing | null;
};

const SHORT_WINDOW_KEYS = new Set(['5h', 'session']);
const LONG_WINDOW_KEYS = new Set(['weekly', '7d']);
const NONE: SubscriptionRings = { outer: null, inner: null };

const finiteNumber = (value: number | null): number | null => (
  value !== null && Number.isFinite(value) ? value : null
);

const hasUsedPercent = (window: UsageWindow): boolean => finiteNumber(window.usedPercent) !== null;

const duration = (window: UsageWindow): number => finiteNumber(window.windowSeconds) ?? Number.POSITIVE_INFINITY;

/**
 * Pick the rate windows that belong on the dual ring.
 *
 * The outer ring is the longer window (weekly or 7-day). The inner ring is
 * the shorter one (5-hour, or whatever shorter window the provider reports).
 * A provider that reports a single pool gets one ring. Windows without a used
 * percent, such as a credit balance, are not rings.
 */
export const pickSubscriptionRings = (
  windows: Record<string, UsageWindow> | null | undefined,
): SubscriptionRings => {
  const entries = Object.entries(windows ?? {})
    .filter((entry): entry is [string, UsageWindow] => hasUsedPercent(entry[1]))
    .map(([key, window]) => ({ key, window }));

  if (entries.length === 0) return NONE;

  const byDuration = entries.slice().sort((left, right) => duration(left.window) - duration(right.window));
  const short = entries.find((entry) => SHORT_WINDOW_KEYS.has(entry.key)) ?? byDuration[0];
  const long = entries.find((entry) => entry.key !== short.key && LONG_WINDOW_KEYS.has(entry.key))
    ?? entries
      .filter((entry) => entry.key !== short.key)
      .sort((left, right) => duration(right.window) - duration(left.window))[0]
    ?? null;

  if (!long) return { outer: short, inner: null };

  const shortIsOuter = duration(short.window) > duration(long.window);
  const outer = shortIsOuter ? short : long;
  const inner = shortIsOuter ? long : short;
  return { outer, inner };
};
