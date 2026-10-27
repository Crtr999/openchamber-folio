import { describe, expect, test } from 'bun:test';
import { pickSubscriptionRings } from './subscriptionUsageRings';
import type { UsageWindow } from '@/types';

const window = (usedPercent: number | null, windowSeconds: number | null): UsageWindow => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

describe('pickSubscriptionRings', () => {
  test('puts the 5-hour window inside the weekly window', () => {
    const rings = pickSubscriptionRings({
      '5h': window(12, 5 * 3600),
      weekly: window(40, 7 * 86400),
      credits_balance: { ...window(null, null), valueLabel: '$4.00' },
    });

    expect(rings.inner?.key).toBe('5h');
    expect(rings.outer?.key).toBe('weekly');
  });

  test('treats Claude\'s 7-day window as the outer ring', () => {
    const rings = pickSubscriptionRings({
      '5h': window(5, 5 * 3600),
      '7d': window(20, 7 * 86400),
    });

    expect(rings.inner?.key).toBe('5h');
    expect(rings.outer?.key).toBe('7d');
  });

  test('keeps a named weekly window outside a longer unnamed window', () => {
    const rings = pickSubscriptionRings({
      '5h': window(5, 5 * 3600),
      weekly: window(20, 7 * 86400),
      monthly: window(8, 30 * 86400),
    });

    expect(rings.inner?.key).toBe('5h');
    expect(rings.outer?.key).toBe('weekly');
  });

  test('uses one ring when the provider reports a single pool', () => {
    const rings = pickSubscriptionRings({
      billing_cycle: window(22, null),
    });

    expect(rings.outer?.key).toBe('billing_cycle');
    expect(rings.inner).toBeNull();
  });

  test('returns nothing when no window has a used percent', () => {
    expect(pickSubscriptionRings(undefined)).toEqual({ outer: null, inner: null });
    expect(pickSubscriptionRings({ credits_balance: window(null, null) })).toEqual({ outer: null, inner: null });
  });
});
