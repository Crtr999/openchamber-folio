import { buildResult, toUsageWindow } from '../utils/index.js';
import { requestWebsiteUsage, websiteUsageAvailable } from '../../website-models/usage-bridge.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CACHE_MS = 45_000;
const STALE_MS = 24 * 3600_000;

/** Reads "5:07 PM", "Oct 29 at 5:07 PM", or a relative span such as "Resets in 26 days". */
export const parseResetText = (text, now = new Date()) => {
  if (typeof text !== 'string') return null;
  const relative = text.match(/\bin\s+([\d.]+)\s*(second|minute|hour|day|week)s?\b/i);
  if (relative) {
    const scale = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[relative[2].toLowerCase()];
    const ms = Number(relative[1]) * scale;
    return Number.isFinite(ms) && ms > 0 ? now.getTime() + ms : null;
  }
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
        // The website can be busy answering a chat or between pages. Keep showing the last
        // reading rather than dropping the meter; a reading older than a day is not kept.
        if (cached && Date.now() - cached.at < STALE_MS) return cached.result;
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

/** Mistral's admin console lists the subscription's included monthly allowances
 * as dollar amounts, so the ring is share-of-allowance and the label carries the dollars. */
const MISTRAL_WINDOW_SECONDS = 30 * 86_400;

export const mistral = make({
  providerId: 'mistral-website',
  providerName: 'Mistral',
  site: 'mistral',
  toResult: data => {
    const windows = {};
    for (const row of Array.isArray(data?.allowances) ? data.allowances : []) {
      if (!['api', 'vibe'].includes(row?.key) || typeof row.used !== 'number' || typeof row.total !== 'number' || !(row.total > 0)) continue;
      const label = row.key === 'api' ? 'API' : 'Vibe Code';
      windows[label] = toUsageWindow({
        usedPercent: Math.min(100, Math.max(0, (row.used / row.total) * 100)),
        windowSeconds: MISTRAL_WINDOW_SECONDS,
        resetAt: parseResetText(row.resetText),
        valueLabel: '$' + row.used + ' of $' + row.total + ' used',
      });
    }
    if (!Object.keys(windows).length) throw new Error('Mistral’s subscription page did not report any allowances.');
    return { usage: { windows }, planLabel: typeof data?.plan === 'string' ? data.plan.slice(0, 40) : null };
  },
});

/** Venice shows only what is left, so the free-plan allowances are the totals. The longer window is the outer ring. */
const VENICE_ALLOWANCE = {
  chat: { total: 10, windowSeconds: 43_200 },
  image: { total: 15, windowSeconds: 86_400 },
};

/** Venice stops listing an allowance once it is used up. A row that was nearly gone on the
 * last reading and is now absent is shown as spent, not dropped, until its reset time. */
const veniceSeen = new Map();

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
    const present = new Set(Object.keys(windows).map(key => key.trim().toLowerCase()));
    for (const row of Array.isArray(data?.limits) ? data.limits : []) {
      if (typeof row?.label === 'string' && typeof row.remaining === 'number') veniceSeen.set(row.label.trim().toLowerCase(), { remaining: row.remaining, resetAt: parseResetText(row.resetText), at: Date.now() });
    }
    if (present.size) {
      for (const [key, allowance] of Object.entries(VENICE_ALLOWANCE)) {
        const seen = veniceSeen.get(key);
        if (present.has(key)) continue;
        // Last reading nearly spent, or (after a restart) the other allowances are listed and this one is not.
        const inferred = !seen && key === 'chat' && present.size >= 2;
        if (!inferred && (!seen || seen.remaining > 2 || Date.now() - seen.at > allowance.windowSeconds * 1000)) continue;
        const label = key[0].toUpperCase() + key.slice(1);
        windows[label] = toUsageWindow({ usedPercent: 100, windowSeconds: allowance.windowSeconds, resetAt: seen?.resetAt && seen.resetAt > Date.now() ? seen.resetAt : null, valueLabel: '0/' + allowance.total + ' left · ' + (inferred ? 'not listed, likely spent' : 'limit reached') });
      }
    }
    if (typeof data?.balance === 'string' && data.balance.trim()) windows.Balance = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: data.balance.trim().slice(0, 30) });
    if (!Object.keys(windows).length) throw new Error('Venice’s limits page did not report anything.');
    return { usage: { windows }, planLabel: typeof data?.plan === 'string' ? data.plan.slice(0, 40) : null };
  },
});
