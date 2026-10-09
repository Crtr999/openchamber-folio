import fs, { readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readCredentialsFromDb, resolveCredentialDbPath } from '@openchamber/web/server/lib/opencode/credential-db.js';
import { getSmallModelClient } from '@openchamber/web/server/lib/small-model/client.js';

// OpenRouter credits in the context rail and, optionally, the macOS menu bar.
//
// The key comes from one of two places:
//   1. a key pasted into the badge, stored encrypted with Electron safeStorage, or
//   2. OpenCode's current read-only credential snapshot, never stored here.
// /credits requires a management key. An inference key reports only its own remaining limit,
// never an account balance, even if /credits would answer misleading HTTP-200 zeros.

const REFRESH_MS = 5 * 60 * 1000;
const creditsSchema = z.object({ data: z.object({ total_credits: z.number().finite(), total_usage: z.number().finite() }) });
const keySchema = z.object({ data: z.object({ is_management_key: z.boolean().optional(), usage: z.number().finite().nullish(), limit: z.number().finite().nullish(), limit_remaining: z.number().finite().nullish() }) });
const settingsSchema = z.object({ key: z.string().optional(), menuBar: z.boolean().default(false) });
const opencodeAuthSchema = z.object({ openrouter: z.object({ key: z.string().min(1) }).passthrough() }).passthrough();

const openRouterProvidersResponse = z.object({ data: z.array(z.object({
  id: z.string(),
  package: z.string(),
  activation: z.enum(['auto', 'enabled', 'disabled']),
  settings: z.object({ baseURL: z.string().nullable().optional() }).optional(),
})).max(1000) });

/** Authorize the existing OpenCode key only for its official native destination. */
export async function isOfficialOpenRouterBillingConnection({ getClient = getSmallModelClient } = {}) {
  try {
    const client = getClient();
    if (!client) return false;
    const candidates = openRouterProvidersResponse.parse(await client.provider.list()).data.filter(provider => provider.id === 'openrouter');
    if (candidates.length !== 1) return false;
    const provider = candidates[0];
    if (provider.activation === 'disabled' || provider.package !== '@opencode/ai/providers/openrouter') return false;
    const baseURL = provider.settings?.baseURL;
    if (baseURL === undefined) return true;
    if (!baseURL || /[{}]|%7[bd]/i.test(baseURL)) return false;
    const url = new URL(baseURL);
    return url.protocol === 'https:' && url.hostname === 'openrouter.ai' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && ['/', '/api/v1', '/api/v1/'].includes(url.pathname);
  } catch {
    return false;
  }
}

/** Main supplies the authoritative window and current local-runtime identity. */
export function isOpenRouterCreditsAuthorized(event, { owner, localOrigin, localRuntime }) {
  if (!localRuntime || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return false;
  if (event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return false;
  try {
    const expected = new URL(localOrigin);
    const actual = new URL(event.senderFrame.url);
    if (!['http:', 'https:', 'openchamber-ui:'].includes(expected.protocol)) return false;
    if (expected.username || expected.password || actual.username || actual.password) return false;
    return actual.protocol === expected.protocol && actual.hostname === expected.hostname && actual.port === expected.port;
  } catch {
    return false;
  }
}

export async function fetchBalance(key, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${key}` };
  const request = { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) };
  const info = await fetchImpl('https://openrouter.ai/api/v1/key', request);
  if (!info.ok) throw new Error(info.status === 401 ? 'OpenRouter did not accept this key.' : `OpenRouter answered ${info.status}.`);
  const data = keySchema.parse(await info.json()).data;
  if (data.is_management_key === true) {
    const credits = await fetchImpl('https://openrouter.ai/api/v1/credits', { ...request, signal: AbortSignal.timeout(10_000) });
    if (!credits.ok) throw new Error('OpenRouter account credits are unavailable.');
    const parsed = creditsSchema.parse(await credits.json());
    return { kind: 'account', amount: parsed.data.total_credits - parsed.data.total_usage, checked: Date.now() };
  }
  if (data.limit_remaining !== null && data.limit_remaining !== undefined) return { kind: 'limit', amount: data.limit_remaining, checked: Date.now() };
  throw new Error('OpenRouter did not return a remaining balance. Connect a management key in the coin counter to read account credits.');
}

export const formatBalance = (balance) => {
  if (balance.kind === 'spent') return 'Balance unavailable';
  const dollars = `$${balance.amount.toFixed(balance.amount >= 100 ? 0 : 2)}`;
  return dollars;
};

/** OpenCode's own OpenRouter key, if it has one. Returns '' when there is none or the file is unreadable. */
export function readOpencodeOpenRouterKey(env = process.env, readFile = (file) => readFileSync(file, 'utf8'), readStored = readCredentialsFromDb) {
  const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  try {
    const dataDir = path.join(dataHome, 'opencode');
    const stored = readStored({ dbPath: resolveCredentialDbPath({ dataDir, env, path }), fs });
    const parsed = opencodeAuthSchema.safeParse(stored ?? JSON.parse(readFile(path.join(dataDir, 'auth.json'))));
    if (parsed.success) return parsed.data.openrouter.key.trim();
  } catch { /* no auth file */ }
  return (env.OPENROUTER_API_KEY ?? '').trim();
}

export function createOpenRouterCredits({ filePath, safeStorage, createTray, openExternal, log = () => {}, fetchImpl = fetch, fallbackKey = () => '', isBlocked = () => false, canUseOpencodeKey = async () => false }) {
  let settings = { menuBar: false };
  try { settings = settingsSchema.parse(JSON.parse(readFileSync(filePath, 'utf8'))); } catch { settings = { menuBar: false }; }
  let balance;
  let error;
  let timer;
  let tray;
  let accountKey;
  let pending;
  let generation = 0;

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
    const { key, source } = resolveKey();
    if (accountKey !== key) {
      accountKey = key; generation += 1; balance = undefined; error = undefined; pending = undefined;
    }
    if (isBlocked()) error = 'Billing refresh is unavailable under your organization policy.';
    return { configured: Boolean(source), source, menuBar: settings.menuBar, balance, error };
  }

  function updateTray() {
    const show = settings.menuBar && Boolean(balance) && balance.kind !== 'spent';
    if (!show) { tray?.destroy(); tray = undefined; return; }
    if (!tray) tray = createTray();
    const label = `${formatBalance(balance)}${error ? ' · stale' : ''}`;
    tray.setTitle(label);
    tray.setToolTip(balance.kind === 'account' ? 'OpenRouter credits left' : 'Left under this OpenRouter key’s limit, not account credits');
    tray.setMenu([
      { label: `OpenRouter · ${label} left`, enabled: false },
      { label: `Checked ${new Date(balance.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, enabled: false },
      { type: 'separator' },
      { label: 'Refresh now', click: () => { void refresh(); } },
      { label: 'Add credits…', click: () => openExternal('https://openrouter.ai/settings/credits') },
      { type: 'separator' },
      { label: 'Hide from menu bar', click: () => { setMenuBar(false); } },
    ]);
  }

  async function refresh() {
    const { key, source } = resolveKey();
    if (accountKey !== key) {
      accountKey = key; generation += 1; balance = undefined; error = undefined; pending = undefined;
    }
    if (isBlocked()) { error = 'Billing refresh is unavailable under your organization policy.'; updateTray(); return status(); }
    if (!key) { balance = undefined; error = undefined; updateTray(); return status(); }
    if (pending) return pending;
    const owner = generation;
    const operation = (async () => {
      try {
        if (source === 'opencode' && !await canUseOpencodeKey()) {
          if (owner === generation) { error = 'The current OpenCode connection is not verified for official OpenRouter billing.'; updateTray(); }
          return status();
        }
        if (owner !== generation || resolveKey().key !== key || isBlocked()) return status();
        const next = await fetchBalance(key, fetchImpl);
        const trusted = source !== 'opencode' || await canUseOpencodeKey();
        if (owner === generation && resolveKey().key === key && !isBlocked() && trusted) { balance = next; error = undefined; }
        else if (owner === generation) error = 'Billing connection changed. Previous values may be stale.';
      } catch {
        if (owner === generation) { error = 'Could not refresh OpenRouter billing. Previous values may be stale.'; log('[openrouter-credits] refresh failed'); }
      }
      if (owner === generation) updateTray();
      return status();
    })();
    pending = operation;
    try { return await operation; } finally { if (pending === operation) pending = undefined; }
  }

  function schedule() {
    clearInterval(timer);
    // The mounted rail owns refresh. Only an opted-in menu bar item needs
    // a native timer when the rail is not mounted.
    if (!settings.menuBar) return;
    timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    timer.unref?.();
  }

  async function setKey(value) {
    if (isBlocked()) throw new Error('Provider credentials cannot be added under your organization policy.');
    const key = (value ?? '').trim();
    if (!key) { settings = { menuBar: settings.menuBar }; save(); return refresh(); }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot store the key securely right now.');
    // Check the key before keeping it, so a typo is reported instead of saved.
    const checked = await fetchBalance(key, fetchImpl);
    if (isBlocked()) throw new Error('Provider credentials cannot be added under your organization policy.');
    settings = { ...settings, key: safeStorage.encryptString(key).toString('base64') };
    accountKey = key; generation += 1; pending = undefined;
    save();
    balance = checked; error = undefined;
    updateTray();
    return status();
  }

  function setMenuBar(show) {
    settings = { ...settings, menuBar: show === true };
    save(); schedule(); updateTray();
    if (settings.menuBar) void refresh();
    return status();
  }

  return {
    start() { schedule(); if (settings.menuBar) void refresh(); },
    stop() { clearInterval(timer); generation += 1; pending = undefined; tray?.destroy(); tray = undefined; },
    status,
    refresh,
    setKey,
    setMenuBar,
    clear: () => { rmSync(filePath, { force: true }); settings = { menuBar: false }; schedule(); balance = undefined; error = undefined; return refresh(); },
  };
}
