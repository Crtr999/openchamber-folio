import type { ProviderResult, UsageWindow } from '@/types';

const currentWindows = (windows: Record<string, UsageWindow>, now: number): Record<string, UsageWindow> => {
  let current = windows;
  for (const [key, window] of Object.entries(windows)) {
    if (window.resetAt === null || !Number.isFinite(window.resetAt) || window.resetAt > now) continue;
    if (window.usedPercent === null && window.remainingPercent === null && !window.valueLabel) continue;
    if (current === windows) current = { ...windows };
    // This sample describes the expired period, not the new period's usage.
    current[key] = { ...window, usedPercent: null, remainingPercent: null, valueLabel: null, resetAfterSeconds: 0 };
  }
  return current;
};

/** Keep the original samples intact; expired windows have no current reading. */
export const currentQuotaReadings = (results: ProviderResult[], now: number): ProviderResult[] => {
  let changed = false;
  const readings = results.map(result => {
    if (!result.usage) return result;
    const windows = currentWindows(result.usage.windows, now);
    let models = result.usage.models;
    for (const [key, model] of Object.entries(result.usage.models ?? {})) {
      const modelWindows = currentWindows(model.windows, now);
      if (modelWindows !== model.windows) models = { ...models, [key]: { ...model, windows: modelWindows } };
    }
    if (windows === result.usage.windows && models === result.usage.models) return result;
    changed = true;
    const usage = { ...result.usage, windows };
    if (models !== result.usage.models) usage.models = models;
    return { ...result, usage };
  });
  return changed ? readings : results;
};

/** One timer covers provider-wide and model-scoped windows across all consumers. */
export const nextQuotaResetAt = (results: ProviderResult[], now: number): number | null => {
  let next: number | null = null;
  for (const result of results) {
    if (!result.usage) continue;
    const groups = [result.usage, ...Object.values(result.usage.models ?? {})];
    for (const group of groups) {
      for (const window of Object.values(group.windows)) {
        const resetAt = window.resetAt;
        if (resetAt !== null && Number.isFinite(resetAt) && resetAt > now && (next === null || resetAt < next)) next = resetAt;
      }
    }
  }
  return next;
};
