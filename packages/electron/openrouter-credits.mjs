import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// OpenRouter balance in the app header ("$18.03") and, optionally, the macOS menu bar.
//
// The key comes from one of two places:
//   1. a key pasted into the badge, stored encrypted with Electron safeStorage, or
//   2. the OpenRouter key OpenCode already has (auth.json), read on each refresh and never stored here.
// Either way it is only ever sent to openrouter.ai. /credits returns the account balance; when a key
// cannot read it, the badge falls back to the key's own spending limit, or to what it has spent.

const REFRESH_MS = 5 * 60 * 1000;
const creditsSchema = z.object({ data: z.object({ total_credits: z.number(), total_usage: z.number() }) });
const keySchema = z.object({ data: z.object({ usage: z.number().nullish(), limit: z.number().nullish(), limit_remaining: z.number().nullish() }) });
const settingsSchema = z.object({ key: z.string().optional(), menuBar: z.boolean().default(false) });
const opencodeAuthSchema = z.object({ openrouter: z.object({ key: z.string().min(1) }).passthrough() }).passthrough();

export async function fetchBalance(key, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${key}` };
  const credits = await fetchImpl('https://openrouter.ai/api/v1/credits', { headers, signal: AbortSignal.timeout(10_000) });
  if (credits.ok) {
    const parsed = creditsSchema.safeParse(await credits.json());
    if (parsed.success) return { kind: 'account', amount: parsed.data.data.total_credits - parsed.data.data.total_usage, checked: Date.now() };
  }
  const info = await fetchImpl('https://openrouter.ai/api/v1/key', { headers, signal: AbortSignal.timeout(10_000) });
  if (!info.ok) throw new Error(info.status === 401 ? 'OpenRouter did not accept this key.' : `OpenRouter answered ${info.status}.`);
  const data = keySchema.parse(await info.json()).data;
  if (data.limit_remaining !== null && data.limit_remaining !== undefined) return { kind: 'limit', amount: data.limit_remaining, checked: Date.now() };
  return { kind: 'spent', amount: data.usage ?? 0, checked: Date.now() };
}

export const formatBalance = (balance) => {
  const dollars = `$${balance.amount.toFixed(balance.amount >= 100 ? 0 : 2)}`;
  return balance.kind === 'spent' ? `${dollars} used` : dollars;
};

/** OpenCode's own OpenRouter key, if it has one. Returns '' when there is none or the file is unreadable. */
export function readOpencodeOpenRouterKey(env = process.env, readFile = (file) => readFileSync(file, 'utf8')) {
  const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  try {
    const parsed = opencodeAuthSchema.safeParse(JSON.parse(readFile(path.join(dataHome, 'opencode', 'auth.json'))));
    if (parsed.success) return parsed.data.openrouter.key.trim();
  } catch { /* no auth file */ }
  return (env.OPENROUTER_API_KEY ?? '').trim();
}

export function createOpenRouterCredits({ filePath, safeStorage, createTray, openExternal, log = () => {}, fetchImpl = fetch, fallbackKey = () => '' }) {
  let settings = { menuBar: false };
  try { settings = settingsSchema.parse(JSON.parse(readFileSync(filePath, 'utf8'))); } catch { settings = { menuBar: false }; }
  let balance;
  let error;
  let timer;
  let tray;

  const readSavedKey = () => {
    if (!settings.key || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(settings.key, 'base64')); } catch { return ''; }
  };
  const resolveKey = () => {
    const saved = readSavedKey();
    if (saved) return { key: saved, source: 'saved' };
    const fallback = fallbackKey();
    return fallback ? { key: fallback, source: 'opencode' } : { key: '', source: undefined };
  };
  const save = () => writeFileSync(filePath, JSON.stringify(settings), { mode: 0o600 });

  function status() {
    const { source } = resolveKey();
    return { configured: Boolean(source), source, menuBar: settings.menuBar, balance, error };
  }

  function updateTray() {
    const show = settings.menuBar && Boolean(balance);
    if (!show) { tray?.destroy(); tray = undefined; return; }
    if (!tray) tray = createTray();
    const label = formatBalance(balance);
    tray.setTitle(label);
    tray.setToolTip(balance.kind === 'account' ? 'OpenRouter credits left' : balance.kind === 'limit' ? 'Left under this OpenRouter key’s limit' : 'Spent with this OpenRouter key');
    tray.setMenu([
      { label: `OpenRouter · ${label}${balance.kind === 'spent' ? '' : ' left'}`, enabled: false },
      { label: `Checked ${new Date(balance.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, enabled: false },
      { type: 'separator' },
      { label: 'Refresh now', click: () => { void refresh(); } },
      { label: 'Add credits…', click: () => openExternal('https://openrouter.ai/settings/credits') },
      { type: 'separator' },
      { label: 'Hide from menu bar', click: () => { setMenuBar(false); } },
    ]);
  }

  async function refresh() {
    const { key } = resolveKey();
    if (!key) { balance = undefined; error = undefined; updateTray(); return status(); }
    try { balance = await fetchBalance(key, fetchImpl); error = undefined; }
    catch (caught) { error = caught instanceof Error ? caught.message : 'Could not reach OpenRouter.'; log(`[openrouter-credits] refresh failed: ${error}`); }
    updateTray();
    return status();
  }

  function schedule() {
    clearInterval(timer);
    // Poll even without a key: OpenCode may get one later, and a refresh with no key costs nothing.
    timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    timer.unref?.();
  }

  async function setKey(value) {
    const key = (value ?? '').trim();
    if (!key) { settings = { menuBar: settings.menuBar }; save(); return refresh(); }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot store the key securely right now.');
    // Check the key before keeping it, so a typo is reported instead of saved.
    const checked = await fetchBalance(key, fetchImpl);
    settings = { ...settings, key: safeStorage.encryptString(key).toString('base64') };
    save();
    balance = checked; error = undefined;
    updateTray();
    return status();
  }

  function setMenuBar(show) {
    settings = { ...settings, menuBar: show === true };
    save(); updateTray();
    return status();
  }

  return {
    start() { schedule(); void refresh(); },
    stop() { clearInterval(timer); tray?.destroy(); tray = undefined; },
    status,
    refresh,
    setKey,
    setMenuBar,
    clear: () => { rmSync(filePath, { force: true }); settings = { menuBar: false }; balance = undefined; error = undefined; return refresh(); },
  };
}
