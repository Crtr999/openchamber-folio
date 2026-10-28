import { describe, expect, test } from 'bun:test';
import type { ProviderResult, UsageWindow } from '@/types';
import { pickSubscriptionRings } from '@/components/layout/subscriptionUsageRings';
import { currentQuotaReadings, nextQuotaResetAt } from './currentReadings';

const start = Date.UTC(2026, 7, 20, 14, 59);
const window = (usedPercent: number | null, resetAt: number | null): UsageWindow => ({
  usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  resetAt, resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null, windowSeconds: null,
});
const sample = (used = 74): ProviderResult => ({
  providerId: 'claude', providerName: 'Claude', ok: true, configured: true, fetchedAt: start,
  usage: { windows: { '5h': window(12, start + 3_600_000), '7d': window(used, start + 60_000) } },
});

describe('current quota readings', () => {
  test('returns unchanged samples until the exact reset boundary', () => {
    const samples = [sample()];
    expect(currentQuotaReadings(samples, start + 59_999)).toBe(samples);
    expect(nextQuotaResetAt(samples, start)).toBe(start + 60_000);
  });

  test('expired zero and nonzero samples are unknown, never an inferred new-period zero', () => {
    for (const used of [0, 74]) {
      const samples = [sample(used)];
      const readings = currentQuotaReadings(samples, start + 60_000);
      expect(readings[0].usage?.windows['7d'].usedPercent).toBeNull();
      expect(readings[0].usage?.windows['7d'].remainingPercent).toBeNull();
      expect(readings[0].fetchedAt).toBe(start);
      expect(samples[0].usage?.windows['7d'].usedPercent).toBe(used);
      const rings = pickSubscriptionRings(readings[0].usage?.windows);
      expect(rings.outer?.key).toBe('7d');
      expect(rings.inner?.window.usedPercent).toBe(12);
      expect(nextQuotaResetAt(samples, start + 60_000)).toBe(start + 3_600_000);
    }
  });

  test('a 30-minute cached response stays unknown after reset until a new-period sample arrives', () => {
    const cached = sample(0);
    expect(currentQuotaReadings([cached], start + 30 * 60_000)[0].usage?.windows['7d'].usedPercent).toBeNull();
    const fresh = sample(0);
    fresh.fetchedAt = start + 30 * 60_000;
    if (!fresh.usage) throw new Error('Missing synthetic usage');
    fresh.usage.windows['7d'].resetAt = start + 7 * 86_400_000;
    expect(currentQuotaReadings([fresh], fresh.fetchedAt)[0].usage?.windows['7d'].usedPercent).toBe(0);
  });

  test('a successful read of an already expired period still cannot establish current usage', () => {
    const oldPeriod = sample(0);
    oldPeriod.fetchedAt = start + 120_000;
    expect(currentQuotaReadings([oldPeriod], oldPeriod.fetchedAt)[0].usage?.windows['7d'].usedPercent).toBeNull();
  });

  test('model windows expire independently and stale value labels cannot masquerade as current readings', () => {
    const result = sample();
    if (!result.usage) throw new Error('Missing synthetic usage');
    const balance = { ...window(null, null), valueLabel: '$4.00' };
    result.usage.windows.credits_balance = balance;
    result.usage.models = { Sonnet: { windows: { '7d': { ...window(20, start + 10_000), valueLabel: '20%' } } } };
    const readings = currentQuotaReadings([result], start + 10_000);
    expect(readings[0].usage?.models?.Sonnet.windows['7d'].valueLabel).toBeNull();
    expect(readings[0].usage?.models?.Sonnet.windows['7d'].usedPercent).toBeNull();
    expect(readings[0].usage?.windows['7d']).toBe(result.usage.windows['7d']);
    expect(readings[0].usage?.windows.credits_balance).toBe(balance);
    expect(result.usage.models.Sonnet.windows['7d'].valueLabel).toBe('20%');
    expect(nextQuotaResetAt([result], start)).toBe(start + 10_000);
  });

  test('absent usage and reset-less balances create no expiry timer', () => {
    const result = sample();
    result.usage = { windows: { credits_balance: { ...window(null, null), valueLabel: '$0.00' } } };
    const samples = [result, { ...result, usage: null }];
    expect(currentQuotaReadings(samples, start)).toBe(samples);
    expect(nextQuotaResetAt(samples, start)).toBeNull();
  });
});
