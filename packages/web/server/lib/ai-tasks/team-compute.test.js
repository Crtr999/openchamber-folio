import { describe, expect, it } from 'vitest';
import { teamCompute } from './team-compute.js';

describe('bounded team arithmetic', () => {
  it('calculates actual numeric statistics including stable variance', () => {
    expect(teamCompute({ operation: 'stats', values: [1, 2, 3, 4] }).result).toEqual({ count: 4, sum: 10, mean: 2.5, min: 1, max: 4, median: 2.5, populationVariance: 1.25 });
  });
  it('compounds with end-of-period contributions', () => {
    expect(teamCompute({ operation: 'compound_growth', principal: 100, rate: 0.1, periods: 2, contribution: 10 }).result.balance).toBeCloseTo(142);
  });
  it('accumulates warm-up cash and uses only prior prices', () => {
    const result = teamCompute({ operation: 'weekly_below_average', prices: [10, 12, 8, 16], weeklyBudget: 10, lookback: 2 }).result;
    expect(result.rows.map(row => row.priorAverage)).toEqual([null, null, 11, 10]);
    expect(result.rows.map(row => row.spent)).toEqual([0, 0, 30, 0]);
    expect(result.finalValue).toBe(70);
    expect(result.baselineValue).toBeCloseTo(59.33333333333333);
  });
  it('rejects code, external file/network inputs and extra fields', () => {
    for (const input of [
      { operation: 'python', code: 'open("/etc/passwd").read()' },
      { operation: 'stats', values: [1], path: '/etc/passwd' },
      { operation: 'stats', values: [1], url: 'https://example.com' },
      { operation: 'stats', values: ['process.env'] },
    ]) expect(() => teamCompute(input)).toThrow();
  });
  it('bounds rows, numeric values, overflowing results, deadlines and cancellation', () => {
    for (const values of [[], Array(4097).fill(1), [Infinity], [NaN], [1e13]]) expect(() => teamCompute({ operation: 'stats', values })).toThrow();
    expect(() => teamCompute({ operation: 'compound_growth', principal: 1e12, rate: 1, periods: 4096, contribution: 0 })).toThrow('Numeric result limit');
    expect(() => teamCompute({ operation: 'stats', values: [1] }, { maxMs: -1 })).toThrow('deadline');
    expect(() => teamCompute({ operation: 'stats', values: [1] }, { signal: AbortSignal.abort() })).toThrow();
  });
});
