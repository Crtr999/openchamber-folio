import { buildResult, toUsageWindow } from '../utils/index.js';
import { requestWebsiteUsage, websiteUsageAvailable } from '../../website-models/usage-bridge.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CACHE_MS = 45_000;

/** Reads "5:07 PM" or "Oct 29 at 5:07 PM" as the next time that clock reading occurs. */
export const parseResetText = (text, now = new Date()) => {
  if (typeof text !== 'string') return null;
  const time = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!time) return null;
  let hour = Number(time[1]) % 12;
  if (/p/i.test(time[3])) hour += 12;
  const minute = Number(time[2]);
  const day = text.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  const when = new Date(now);
  when.setSeconds(0, 0);
  if (day && MONTHS.includes(day[1].toLowerCase())) {
    when.setMonth(MONTHS.indexOf(day[1].toLowerCase()), Number(day[2]));
    when.setHours(hour, minute);
    if (when.getTime() < now.getTime() - 86_400_000) when.setFullYear(when.getFullYear() + 1);
  } else {
    when.setHours(hour, minute);
    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
  }
  return when.getTime();
};

const percent = value => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

const make = ({ providerId, providerName, site, toResult }) => {
  let cached = null;
  return {
    providerId,
    providerName,
    isConfigured: () => websiteUsageAvailable(),
    fetchQuota: async () => {
      if (!websiteUsageAvailable()) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
      try {
        const data = await requestWebsiteUsage(site);
        const result = buildResult({ providerId, providerName, ok: true, configured: true, ...toResult(data) });
        cached = { at: Date.now(), result };
        return result;
      } catch (error) {
        return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
      }
    },
  };
};

export const gemini = make({
  providerId: 'gemini-website',
  providerName: 'Gemini website',
  site: 'gemini',
  toResult: data => {
    const windows = {};
    for (const row of Array.isArray(data?.windows) ? data.windows : []) {
      if (!['session', 'weekly'].includes(row?.key) || percent(row.usedPercent) === null) continue;
      windows[row.key] = toUsageWindow({ usedPercent: percent(row.usedPercent), windowSeconds: null, resetAt: parseResetText(row.resetText) });
    }
    if (!Object.keys(windows).length) throw new Error('Gemini’s usage page did not report any limits.');
    return { usage: { windows }, planLabel: typeof data?.plan === 'string' ? data.plan.slice(0, 40) : null };
  },
});

/** Venice shows only what is left, so the free-plan allowances are the totals. The longer window is the outer ring. */
const VENICE_ALLOWANCE = {
  chat: { total: 10, windowSeconds: 43_200 },
  image: { total: 15, windowSeconds: 86_400 },
};

export const venice = make({
  providerId: 'venice-website',
  providerName: 'Venice website',
  site: 'venice',
  toResult: data => {
    const windows = {};
    for (const row of Array.isArray(data?.limits) ? data.limits : []) {
      if (typeof row?.label !== 'string' || typeof row.remaining !== 'number') continue;
      const resetAt = parseResetText(row.resetText);
      const reset = typeof row.resetText === 'string' && row.resetText.trim() ? ' until ' + row.resetText.trim().slice(0, 20) : '';
      const allowance = VENICE_ALLOWANCE[row.label.trim().toLowerCase()];
      if (allowance) {
        const total = Math.max(allowance.total, row.remaining);
        const used = Math.min(100, Math.max(0, ((total - row.remaining) / total) * 100));
        windows[row.label] = toUsageWindow({ usedPercent: used, windowSeconds: allowance.windowSeconds, resetAt, valueLabel: row.remaining + '/' + total + ' left' + reset });
      } else {
        windows[row.label] = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt, valueLabel: row.remaining + ' left' + reset });
      }
    }
    if (typeof data?.balance === 'string' && data.balance.trim()) windows.Balance = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: data.balance.trim().slice(0, 30) });
    if (!Object.keys(windows).length) throw new Error('Venice’s limits page did not report anything.');
    return { usage: { windows }, planLabel: typeof data?.plan === 'string' ? data.plan.slice(0, 40) : null };
  },
});
