import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const number = z.number().finite().min(-1e12).max(1e12);
const money = number.nonnegative();
const prices = z.array(number.positive()).min(1).max(4096);
const teamComputeSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('stats'), values: z.array(number).min(1).max(4096) }).strict(),
  z.object({ operation: z.literal('compound_growth'), principal: money, rate: z.number().finite().min(-1).max(1), periods: z.number().int().min(0).max(4096), contribution: money }).strict(),
  z.object({ operation: z.literal('weekly_below_average'), prices, weeklyBudget: money, lookback: z.number().int().min(1).max(520) }).strict(),
]);
export const teamComputeInput = z.toJSONSchema(teamComputeSchema);
const boundedArray = z.custom((value) => Array.isArray(value) && value.length >= 1 && value.length <= 4096);
const preflight = z.object({ values: boundedArray.optional(), prices: boundedArray.optional() });

/** Fixed arithmetic only. No expression evaluator, file input, imports or callbacks. */
export function teamCompute(input, { signal, maxMs = 100 } = {}) {
  const started = performance.now();
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() - started > maxMs) throw new Error('Computation deadline exceeded');
  };
  check();
  // Zod checks array members before reporting max-length errors. Refuse size first.
  preflight.parse(input);
  const args = teamComputeSchema.parse(input);
  check();
  let result;
  switch (args.operation) {
    case 'stats': {
      let sum = 0;
      let mean = 0;
      let m2 = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const [index, value] of args.values.entries()) {
        check();
        sum += value;
        const delta = value - mean;
        mean += delta / (index + 1);
        m2 += delta * (value - mean);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const sorted = [...args.values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      result = { count: sorted.length, sum, mean, min, max, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, populationVariance: m2 / sorted.length };
      break;
    }
    case 'compound_growth': {
      let balance = args.principal;
      const rows = [];
      for (let period = 1; period <= args.periods; period++) {
        check();
        balance = balance * (1 + args.rate) + args.contribution;
        if (!Number.isFinite(balance) || Math.abs(balance) > 1e15) throw new Error('Numeric result limit exceeded');
        rows.push({ period, balance });
      }
      result = { balance, contributionTiming: 'end_of_period', rows };
      break;
    }
    case 'weekly_below_average': {
      let cash = 0;
      let units = 0;
      let baselineUnits = 0;
      let priorSum = 0;
      const rows = [];
      for (const [week, price] of args.prices.entries()) {
        check();
        cash += args.weeklyBudget;
        baselineUnits += args.weeklyBudget / price;
        const average = week >= args.lookback ? priorSum / args.lookback : null;
        const spent = average !== null && price < average ? cash : 0;
        units += spent / price;
        cash -= spent;
        const value = units * price + cash;
        if (![units, baselineUnits, value].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e15)) throw new Error('Numeric result limit exceeded');
        rows.push({ week: week + 1, price, priorAverage: average, spent, cash, units, value });
        priorSum += price;
        if (week >= args.lookback) priorSum -= args.prices[week - args.lookback];
      }
      result = { syntheticOnly: true, investedBudget: args.weeklyBudget * args.prices.length, finalValue: rows.at(-1).value, baselineValue: baselineUnits * args.prices.at(-1), rows };
      break;
    }
  }
  check();
  const envelope = { version: 1, operation: args.operation, result };
  if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024) throw new Error('Result byte limit exceeded');
  check();
  return envelope;
}
