import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createNativeOutlook } from './personal-outlook-native.mjs';

const authority = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const graph = 'https://graph.microsoft.com/v1.0';
const scopes = 'offline_access User.Read Mail.Read Calendars.Read';
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), scope: z.string() });
const accountSchema = z.object({ id: z.string().min(1), address: z.string().email(), token: z.string().min(1), expiresAt: z.number() });
const nativeIdentitySchema = z.object({ id: z.string().min(1).max(2000), address: z.string().email() });
const settingsSchema = z.object({ clientId: z.string().uuid().optional(), accounts: z.array(accountSchema).max(5).default([]), native: z.object({ enabled: z.boolean(), accounts: z.array(nativeIdentitySchema).max(50) }).default({ enabled: false, accounts: [] }) });
const profileSchema = z.object({ id: z.string().min(1), mail: z.string().email().nullable().optional(), userPrincipalName: z.string().optional() });
const deviceSchema = z.object({ device_code: z.string().min(1), user_code: z.string().min(1), expires_in: z.number().positive().max(3600), interval: z.number().positive().max(60).default(5) });
const errorSchema = z.object({ error: z.string() });
const messagesSchema = z.object({ value: z.array(z.object({ id: z.string(), subject: z.string(), receivedDateTime: z.string(), bodyPreview: z.string(), isRead: z.boolean(), from: z.object({ emailAddress: z.object({ name: z.string().optional(), address: z.string().optional() }) }).optional() })).max(25), '@odata.nextLink': z.string().optional() });
const eventsSchema = z.object({ value: z.array(z.object({ id: z.string(), subject: z.string(), start: z.object({ dateTime: z.string(), timeZone: z.string() }), end: z.object({ dateTime: z.string(), timeZone: z.string() }), isAllDay: z.boolean(), isCancelled: z.boolean(), location: z.object({ displayName: z.string() }).optional() })).max(25), '@odata.nextLink': z.string().optional() });

/** Native-only, read-only delegated Microsoft access. No browser cookies or app secrets. */
export function createPersonalOutlook({ filePath, safeStorage, isBlocked, fetchImpl = fetch, now = Date.now, native = createNativeOutlook({ isBlocked, now }) }) {
  let pending;
  let closed = false;
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const guard = () => {
    if (closed) throw new Error('Outlook connection is closed.');
    if (isBlocked()) throw new Error('Outlook is unavailable in enterprise mode.');
  };
  const load = async () => {
    try { return settingsSchema.parse(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return settingsSchema.parse({});
      throw new Error('Could not read the saved Outlook connection.');
    }
  };
  const save = async (value) => {
    if (closed) throw new Error('Outlook connection is closed.');
    const settings = settingsSchema.parse(value);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(settings), { mode: 0o600 });
    await rename(temp, filePath);
  };
  const request = async (url, options = {}) => {
    guard();
    const parsed = new URL(url);
    if (parsed.origin !== 'https://login.microsoftonline.com' && parsed.origin !== 'https://graph.microsoft.com') throw new Error('Unexpected Microsoft endpoint.');
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    guard();
    return response;
  };
  const exchange = (parameters) => request(`${authority}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters) });
  const profile = async (token) => {
    const response = await request(`${graph}/me?$select=id,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Microsoft could not verify the account. Reconnect Outlook.');
    return profileSchema.parse(await response.json());
  };
  const storeToken = async (settings, account, tokens) => {
    guard();
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    const granted = new Set(tokens.scope.split(' ').map((scope) => scope.toLowerCase().replace('https://graph.microsoft.com/', '')));
    if (!['user.read', 'mail.read', 'calendars.read'].every((scope) => granted.has(scope))) throw new Error('Microsoft did not grant the requested read-only permissions. Reconnect Outlook.');
    const saved = { ...account, expiresAt: now() + tokens.expires_in * 1000, token: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') };
    await save({ ...settings, accounts: [...settings.accounts.filter((item) => item.id !== saved.id && item.address.toLowerCase() !== saved.address.toLowerCase()), saved] });
    return saved;
  };
  const accessToken = async (settings, account) => {
    guard();
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    const tokens = tokenSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(account.token, 'base64'))));
    if (account.expiresAt > now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error('Reconnect Outlook.');
    const response = await exchange({ client_id: settings.clientId, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: scopes });
    if (!response.ok) throw new Error('Microsoft authorization expired. Reconnect Outlook.');
    const next = tokenSchema.parse(await response.json());
    await storeToken(settings, account, { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token });
    return next.access_token;
  };
  const status = async (settings) => {
    if (pending && pending.expiresAt <= now()) pending = undefined;
    const available = await native.available();
    let nativeAccess = { access: available ? 'not-connected' : 'unsupported' };
    if (settings.native.enabled && available && !isBlocked()) {
      try { nativeAccess = await native.probe(); } catch { nativeAccess = { access: 'error' }; }
    }
    return { clientId: settings.clientId ?? '', accounts: settings.accounts.map(({ address }) => ({ address })),
      native: { available, access: nativeAccess.access, accounts: settings.native.enabled ? settings.native.accounts : [] },
      pending: pending ? { code: pending.user_code, expiresAt: pending.expiresAt, nextCheckAt: pending.nextCheckAt } : null };
  };
  const handle = async (raw) => {
    const { op } = z.object({ op: z.enum(['status', 'connect', 'check', 'cancel', 'disconnect', 'native-connect', 'native-disconnect']) }).parse(raw);
    // Local removal and cancellation stay available under enterprise policy.
    if (op === 'status') return status(await load());
    if (op === 'native-disconnect') {
      const settings = await load();
      await save({ ...settings, native: { enabled: false, accounts: [] } });
      return status(await load());
    }
    if (op === 'cancel') { pending = undefined; return status(await load()); }
    if (op === 'disconnect') {
      const { address } = z.object({ address: z.string().email() }).parse(raw);
      const settings = await load();
      pending = undefined;
      await save({ ...settings, accounts: settings.accounts.filter((item) => item.address.toLowerCase() !== address.toLowerCase()) });
      return status(await load());
    }
    guard();
    const settings = await load();
    if (op === 'native-connect') {
      const result = await native.connect();
      guard();
      if (result.access !== 'connected' || !result.accounts.length) {
        const reason = result.reason === 'permission' ? 'Allow Open Carter to control Microsoft Outlook in macOS Automation settings.'
          : result.reason === 'not-installed' ? 'Microsoft Outlook is not installed in /Applications on this Mac.'
            : result.reason === 'accounts-unavailable' ? 'Outlook did not expose any readable account identities through its scripting interface. No mailbox was read.'
              : 'Outlook could not expose readable account identities through its scripting interface. No mailbox was read.';
        throw new Error(reason);
      }
      await save({ ...settings, native: { enabled: true, accounts: nativeIdentitySchema.array().max(50).parse(result.accounts) } });
      return status(await load());
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    if (op === 'connect') {
      const { clientId } = z.object({ clientId: z.string().uuid() }).parse(raw);
      if (pending) throw new Error('An Outlook sign-in is already open. Cancel it first.');
      if (settings.accounts.length >= 5) throw new Error('Disconnect an Outlook account before adding another.');
      if (settings.clientId && settings.clientId !== clientId && settings.accounts.length) throw new Error('Disconnect Outlook accounts before changing the Microsoft application ID.');
      const response = await request(`${authority}/devicecode`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, scope: scopes }) });
      if (!response.ok) throw new Error('Microsoft could not start sign-in. Check the application ID, public client flow, and your organization policy.');
      const device = deviceSchema.parse(await response.json());
      await save({ ...settings, clientId });
      pending = { ...device, clientId, expiresAt: now() + device.expires_in * 1000, nextCheckAt: now() + device.interval * 1000 };
      return status(await load());
    }
    if (!pending || pending.expiresAt <= now()) { pending = undefined; throw new Error('Outlook sign-in expired. Start again.'); }
    if (pending.nextCheckAt > now()) return status(settings);
    const attempt = pending;
    attempt.nextCheckAt = now() + attempt.interval * 1000;
    const response = await exchange({ client_id: attempt.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: attempt.device_code });
    if (!response.ok) {
      const failure = errorSchema.safeParse(await response.json());
      if (failure.success && failure.data.error === 'authorization_pending') return status(settings);
      if (failure.success && failure.data.error === 'slow_down') { attempt.interval += 5; attempt.nextCheckAt = now() + attempt.interval * 1000; return status(settings); }
      pending = undefined;
      throw new Error('Microsoft sign-in was denied or expired. Start again.');
    }
    // A successful exchange consumes the code. Never retry it after a failed save.
    pending = undefined;
    const tokens = tokenSchema.parse(await response.json());
    const account = await profile(tokens.access_token);
    const address = z.string().email().parse(account.mail ?? account.userPrincipalName);
    await storeToken(settings, { id: account.id, address }, tokens);
    return status(await load());
  };
  const readAwareness = async (addresses) => {
    guard();
    const selected = z.array(z.string().email()).max(5).parse(addresses);
    const records = [];
    const accounts = [];
    const saved = await load();
    const nativeSelected = saved.native.enabled ? saved.native.accounts.filter((account) => selected.some((address) => address.toLowerCase() === account.address.toLowerCase())) : [];
    if (nativeSelected.length) {
      try {
        const value = await native.read(nativeSelected);
        guard();
        if (value.access !== 'connected') throw new Error('Native Outlook needs authorization.');
        // The private adapter accepts only selected stable account identities.
        records.push(...value.records);
        accounts.push(...value.health);
      } catch { accounts.push(...nativeSelected.map(({ address }) => ({ address, status: 'error' }))); }
    }
    for (const address of [...new Set(selected.map((item) => item.toLowerCase()))]) {
      if (nativeSelected.some((account) => account.address.toLowerCase() === address)) continue;
      // Reload after each refresh so one account cannot overwrite another's rotated token.
      const settings = await load();
      const account = settings.accounts.find((item) => item.address.toLowerCase() === address);
      if (!account) { accounts.push({ address, status: 'needs-connection' }); continue; }
      let failed = false;
      let partial = false;
      let completed = 0;
      try {
        const token = await accessToken(settings, account);
        const verified = await profile(token);
        if (verified.id !== account.id) throw new Error('Microsoft account changed.');
        const end = new Date(now() + 7 * 86400000).toISOString();
        const start = new Date(now()).toISOString();
        const resources = [
          { kind: 'mail', url: `${graph}/me/mailFolders/inbox/messages?${new URLSearchParams({ '$top': '10', '$orderby': 'receivedDateTime desc', '$filter': `receivedDateTime ge ${new Date(now() - 14 * 86400000).toISOString()}`, '$select': 'id,subject,receivedDateTime,bodyPreview,isRead,from' })}`, schema: messagesSchema },
          { kind: 'calendar', url: `${graph}/me/calendarView?${new URLSearchParams({ startDateTime: start, endDateTime: end, '$top': '10', '$orderby': 'start/dateTime', '$select': 'id,subject,start,end,isAllDay,isCancelled,location' })}`, schema: eventsSchema },
        ];
        for (const resource of resources) {
          try {
            const response = await request(resource.url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
            if (!response.ok) throw new Error('Microsoft source read failed.');
            const page = resource.schema.parse(await response.json());
            partial ||= Boolean(page['@odata.nextLink']) || page.value.length > 10;
            completed++;
            // Provider next links are coverage signals, never trusted destinations.
            for (const item of page.value.slice(0, 10)) {
              const text = JSON.stringify({ account: address, kind: resource.kind, ...item });
              records.push({ id: `${address}:${resource.kind}:${item.id}`.slice(0, 4096), title: item.subject.slice(0, 2000), text: text.slice(0, 6000), truncated: resource.kind === 'mail' || text.length > 6000 });
            }
          } catch { failed = true; }
        }
      } catch { failed = true; }
      accounts.push({ address, status: failed ? completed ? 'partial' : 'error' : partial ? 'partial' : 'ready' });
    }
    guard();
    const allReady = accounts.every((account) => account.status === 'ready');
    const allMissing = !accounts.length || accounts.every((account) => account.status === 'needs-connection');
    return { source: 'outlook', status: allMissing ? 'needs-connection' : allReady ? 'ready' : records.length || accounts.some((account) => account.status === 'ready' || account.status === 'partial') ? 'partial' : 'error', records, accounts };
  };
  return { handle: (raw) => serialized(() => handle(raw)), readAwareness: (addresses) => serialized(() => readAwareness(addresses)), close: () => { closed = true; pending = undefined; } };
}
