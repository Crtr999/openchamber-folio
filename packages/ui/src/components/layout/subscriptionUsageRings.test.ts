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

  test('returns nothing for absent windows or a balance without a used percent', () => {
    expect(pickSubscriptionRings(undefined)).toEqual({ outer: null, inner: null });
    expect(pickSubscriptionRings({ credits_balance: window(null, null) })).toEqual({ outer: null, inner: null });
  });

  test('an unknown weekly reading keeps the outer position instead of promoting the short window', () => {
    for (const key of ['weekly', '7d']) {
      const rings = pickSubscriptionRings({
        '5h': window(0, 5 * 3600),
        [key]: window(null, 7 * 86400),
      });
      expect(rings.outer?.key).toBe(key);
      expect(rings.outer?.window.usedPercent).toBeNull();
      expect(rings.inner?.key).toBe('5h');
    }
  });

  test('a current provider-reported weekly zero remains a valid ring', () => {
    const rings = pickSubscriptionRings({
      '5h': window(15, 5 * 3600),
      weekly: window(0, 7 * 86400),
    });
    expect(rings.outer?.key).toBe('weekly');
    expect(rings.outer?.window.usedPercent).toBe(0);
    expect(rings.outer?.window.remainingPercent).toBe(100);
  });

  test('the picker never infers zero from a reset timestamp', () => {
    const rings = pickSubscriptionRings({ weekly: { ...window(74, 7 * 86400), resetAt: 1, resetAfterSeconds: 0 } });
    expect(rings.outer?.window.usedPercent).toBe(74);
  });
});
