import type { JSONSchema } from 'zod/v4/core';
export const teamComputeInput: JSONSchema.BaseSchema;
export type TeamComputeInput =
  | { operation: 'stats'; values: number[] }
  | { operation: 'compound_growth'; principal: number; rate: number; periods: number; contribution: number }
  | { operation: 'weekly_below_average'; prices: number[]; weeklyBudget: number; lookback: number };
export type TeamComputeResult =
  | { version: 1; operation: 'stats'; result: { count: number; sum: number; mean: number; min: number; max: number; median: number; populationVariance: number } }
  | { version: 1; operation: 'compound_growth'; result: { balance: number; contributionTiming: 'end_of_period'; rows: { period: number; balance: number }[] } }
  | { version: 1; operation: 'weekly_below_average'; result: { syntheticOnly: true; investedBudget: number; finalValue: number; baselineValue: number; rows: { week: number; price: number; priorAverage: number | null; spent: number; cash: number; units: number; value: number }[] } };
export function teamCompute(input: TeamComputeInput, options?: { signal?: AbortSignal; maxMs?: number }): TeamComputeResult;
