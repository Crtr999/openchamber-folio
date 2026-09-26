import { z } from 'zod';

/**
 * OpenRouter balance for the little credits badge. The account balance comes from /credits, which
 * OpenRouter only answers for a management key. With a regular key we fall back to /key: its own
 * spending limit when it has one, otherwise what it has spent.
 */

export interface OpenRouterBalance {
  /** "account": credits left on the account; "limit": left under this key's limit; "spent": only usage is known. */
  kind: 'account' | 'limit' | 'spent';
  amount: number;
  checked: number;
}

const creditsSchema = z.object({ data: z.object({ total_credits: z.number(), total_usage: z.number() }) });
const keySchema = z.object({ data: z.object({ usage: z.number().nullish(), limit: z.number().nullish(), limit_remaining: z.number().nullish() }) });

export type BalanceGet = (url: string, headers: Map<string, string>) => Promise<{ status: number; data: string }>;

const webGet: BalanceGet = async (url, headers) => {
  const response = await fetch(url, { headers: Object.fromEntries(headers), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, data: await response.text() };
};

export async function fetchOpenRouterBalance(key: string, nativeGet?: BalanceGet): Promise<OpenRouterBalance> {
  const headers = new Map([['Authorization', `Bearer ${key.trim()}`]]);
  const get: BalanceGet = async (url, h) => { try { return await webGet(url, h); } catch (error) { if (!nativeGet) throw error; return nativeGet(url, h); } };
  const credits = await get('https://openrouter.ai/api/v1/credits', headers);
  if (credits.status === 200) {
    const parsed = creditsSchema.safeParse(JSON.parse(credits.data));
    if (parsed.success) return { kind: 'account', amount: parsed.data.data.total_credits - parsed.data.data.total_usage, checked: Date.now() };
  }
  const info = await get('https://openrouter.ai/api/v1/key', headers);
  if (info.status !== 200) throw new Error(info.status === 401 ? 'OpenRouter did not accept this key.' : `OpenRouter answered ${info.status}.`);
  const data = keySchema.parse(JSON.parse(info.data)).data;
  if (data.limit_remaining !== null && data.limit_remaining !== undefined) return { kind: 'limit', amount: data.limit_remaining, checked: Date.now() };
  return { kind: 'spent', amount: data.usage ?? 0, checked: Date.now() };
}

export const formatDollars = (amount: number) => `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
