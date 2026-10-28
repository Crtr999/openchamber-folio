import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { setZdrAccessGrant } from '@/lib/runtime-auth';

const stateSchema = z.object({ pinSet: z.boolean(), directories: z.array(z.string()), retryAfterMs: z.number(), unlocked: z.boolean().optional() });
const resultSchema = z.object({ ok: z.boolean(), error: z.string().optional(), retryAfterMs: z.number().optional(), accessToken: z.string().optional(), expiresAt: z.number().optional() });
export type ZdrLockState = z.infer<typeof stateSchema>;
export type ZdrLockResult = z.infer<typeof resultSchema>;

const send = async (path: string, body: Record<string, string>): Promise<ZdrLockResult> => {
  try {
    const response = await runtimeFetch(`/api/openchamber/zdr-lock/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const parsed = resultSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || (!response.ok && parsed.data.ok)) return { ok: false, error: 'The lock could not be reached.' };
    if (parsed.data.ok && path !== 'clear' && (!parsed.data.accessToken || !parsed.data.expiresAt || parsed.data.expiresAt <= Date.now())) return { ok: false, error: 'The lock could not be reached.' };
    return parsed.data;
  } catch {
    return { ok: false, error: 'The lock could not be reached.' };
  }
};

export const readZdrLockState = async (): Promise<ZdrLockState | null> => {
  try {
    const response = await runtimeFetch('/api/openchamber/zdr-lock/state', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const parsed = stateSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
};

export const verifyZdrPin = (pin: string) => send('verify', { pin });
export const setZdrPin = (pin: string, currentPin?: string) => send('set', currentPin ? { pin, currentPin } : { pin });
export const clearZdrPin = (pin: string) => send('clear', { pin });
export const revokeZdrAccess = (): void => {
  const token = setZdrAccessGrant();
  if (!token) return;
  void runtimeFetch('/api/openchamber/zdr-lock/lock', { method: 'POST', headers: { 'x-openchamber-zdr-access': token } }).catch(() => {});
};

/** True when a path is a guarded folder or sits inside one. */
export const isPathGuarded = (directories: readonly string[], path: string | null | undefined): boolean => {
  if (!path) return false;
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const target = normalize(path);
  if (/zdr/i.test(target)) return true;
  return directories.some((directory) => {
    const root = normalize(directory);
    return target === root || (root === '/' ? target.startsWith('/') : target.startsWith(`${root}/`));
  });
};
