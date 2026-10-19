import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readSavedViewRows } from './notion-saved-view.mjs';
import { resolveNotionTaskReferences, NotionReferenceError } from './notion-task-references.mjs';

const ORIGIN = 'https://mcp.notion.com';
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().optional() });
const settingsSchema = z.object({ token: z.string().optional(), clientId: z.string().optional(), expiresAt: z.number().optional(), board: z.string().default('collection://024860a0-3918-450b-93c0-074f9512c67e'), habits: z.string().default('collection://f26696d5-a0fd-4add-a9ae-a7b48f4e2a15'), destination: z.string().default('3ea4fdbe-e450-80a5-b571-f1abf619e7af'), trashedPages: z.array(z.string()).default([]) });
const rpcSchema = z.object({ result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(), isError: z.boolean().optional() }).passthrough().optional(), error: z.object({ message: z.string() }).optional() });
const fetchSchema = z.object({ text: z.string(), url: z.string().optional(), truncated: z.boolean().optional() });
const propertySchema = z.object({ name: z.string(), type: z.string(), readOnly: z.boolean().optional(), options: z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional() }).passthrough()).optional(), groups: z.record(z.string(), z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional() }).passthrough())).optional() }).passthrough();
const sourceSchema = z.object({ url: z.string(), name: z.string(), schema: z.record(z.string(), propertySchema) });
const rowsSchema = z.object({ results: z.array(z.object({ url: z.string(), title: z.string().nullable(), status: z.string().nullable(), dueStart: z.string().nullable().default(null), dueEnd: z.string().nullable().default(null), dueIsDatetime: z.union([z.literal(0), z.literal(1)]).nullable().default(null) })), has_more: z.boolean().optional() });
const taskMoveSchema = z.object({ page: z.string().min(1), status: z.string().min(1) });
const createTaskSchema = z.object({ title: z.string().trim().min(1).max(500), status: z.string().optional() });
const aiCreateSchema = z.object({ title: z.string().trim().min(1).max(500), notes: z.string().max(100000).optional() });
const aiNotesSchema = z.object({ page: z.string().min(1), notes: z.string().max(100000) });
// Template lines that only prompt the user. They are never sent to a manager.
const NOTES_PROMPT = 'Add notes for the manager here: context, links and the deliverable you want.';
const notePrompts = [NOTES_PROMPT, 'Describe the task and the expected deliverable here.'];
export const taskNotes = (content) => content.split('\n').filter((line) => !notePrompts.includes(line.trim())).join('\n').trim();
const decodeNotesText = (text) => text.replace(/<empty-block\s*\/>/g, '').replace(/<br\s*\/?>/g, '\n')
  .replace(/\\([\\`*_~$[\]<>{}|^#])/g, '$1');
// Notion stores pages as enhanced markdown: literal special characters come
// back escaped ("$250" reads as "\$250") and blank lines as <empty-block/>.
// The notes editor decodes text formatting. A clean update acknowledgement is
// authoritative; a markdown echo is not byte-equivalent to the user's draft.
export const plainNotes = (content) => {
  let fence = null;
  return taskNotes(content.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    // Code is literal in Notion. Unescaping or trimming it changes the brief.
    if (fence) return line;
    let decoded = '';
    let offset = 0;
    for (const span of line.matchAll(/(?<!`)(`+)(?!`)(.*?)\1(?!`)/g)) {
      decoded += decodeNotesText(line.slice(offset, span.index)) + span[0];
      offset = span.index + span[0].length;
    }
    return (decoded + decodeNotesText(line.slice(offset))).trimEnd();
  }).join('\n'));
};
const notesKey = (content) => {
  let fence = null;
  return plainNotes(content).split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return `\n${line}\n`;
    }
    // Notion strips paragraph spacing, but spaces between words and code
    // indentation must never disappear from the confirmation check.
    return fence ? `${line}\n` : line.trim() ? `${line}\n` : '';
  }).join('');
};
const taskBody = (content) => {
  let fence = null;
  let offset = 0;
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (!fence && /^## Open Carter run [a-zA-Z0-9-]+\s*$/.test(line)) {
      return { brief: content.slice(0, offset).trimEnd(), results: content.slice(offset) };
    }
    offset += line.length + 1;
  }
  return { brief: content, results: '' };
};
const requireClosedNotesCode = (content) => {
  let fence = null;
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
  }
  if (fence) throw new Error('Close the code block in your notes before saving, so it cannot absorb the task results. Your draft is still here.');
};
const renameTaskSchema = z.object({ page: z.string().min(1), title: z.string().trim().min(1).max(500) });
const deleteTaskSchema = z.object({ page: z.string().min(1) });
const exportSchema = z.object({ title: z.string().min(1).max(500), content: z.string().min(1).max(500000) });
const deleteToolCandidates = ['delete-page', 'delete-pages', 'archive-page', 'move-to-trash'];

export const quoteSqlIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

export function notionPageId(value) {
  const id = value.match(/(?:^|[/\-])([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i)?.[1];
  if (!id) throw new Error('Choose a valid Notion page ID or page URL.');
  return id;
}

export function parseBoardSource(text) {
  const match = text.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/);
  if (!match) throw new Error('Choose a Notion data source with a status property.');
  const source = sourceSchema.parse(JSON.parse(match[1]));
  const title = Object.values(source.schema).find((property) => property.type === 'title');
  const status = Object.values(source.schema).find((property) => property.type === 'status' && !property.readOnly)
    ?? Object.values(source.schema).find((property) => property.type === 'select' && !property.readOnly);
  if (status && !status.options) status.options = ['to_do', 'in_progress', 'current', 'future', 'complete'].flatMap((group) => status.groups?.[group] ?? []);
  if (!title || !status || !status.options?.length) throw new Error('This data source needs a title and editable status or select property.');
  const dates = Object.values(source.schema).filter((property) => property.type === 'date');
  // Prefer an explicitly named due property. Never pick an arbitrary date when
  // a database also has scheduling, completion or other date fields.
  const due = dates.find((property) => /^(due|due date)$/i.test(property.name)) ?? (dates.length === 1 ? dates[0] : null);
  return { source, title, status, due, text };
}

export function createPersonalHome({ filePath, safeStorage, openExternal, isBlocked, fetchImpl = fetch, calendar }) {
  let settings;
  let pendingAuth;
  let refreshPromise;
  let rpcId = 0;
  let sessionId;
  let cachedBoard;
  let cachedHabits;
  let initialized = false;
  let toolDefinitions = [];
  let access;
  let queue = Promise.resolve();
  let saveQueue = Promise.resolve();
  const sourceReads = new Map();
  const boardReads = new Map();
  let connectionRevision = 0;
  const invalidateReads = () => { connectionRevision++; sourceReads.clear(); boardReads.clear(); };
  const shareBoardRead = (key, read) => {
    checkBoundary();
    if (boardReads.has(key)) return boardReads.get(key);
    const operation = read().finally(() => { if (boardReads.get(key) === operation) boardReads.delete(key); });
    boardReads.set(key, operation);
    return operation;
  };
  const checkBoundary = () => { if (isBlocked()) throw new Error('Notion connections and chat export are unavailable in enterprise mode.'); };
  const load = async () => {
    if (settings) return settings;
    try { settings = settingsSchema.parse(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the saved Notion connection.'); settings = settingsSchema.parse({}); }
    return settings;
  };
  const save = (patch) => {
    const operation = saveQueue.then(async () => {
      const current = await load();
      const next = settingsSchema.parse({ ...current, ...patch });
      await mkdir(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, filePath);
      settings = next;
    });
    saveQueue = operation.catch(() => {});
    return operation;
  };
  const request = async (url, options = {}) => {
    checkBoundary();
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN) throw new Error('Unexpected Notion endpoint.');
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok) {
      const err = new Error(`Notion request failed (${response.status}). Reconnect if your access has expired.`);
      err.status = response.status;
      throw err;
    }
    return response;
  };
  const storeTokens = async (tokens, clientId) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    await save({ token: encrypted, clientId, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined });
    invalidateReads();
    sessionId = undefined;
    initialized = false;
    access = undefined;
  };
  const getToken = async (forceRefresh = false) => {
    checkBoundary();
    const current = await load();
    if (!current.token || !safeStorage.isEncryptionAvailable()) throw new Error('Connect Notion first.');
    const tokens = tokenSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(current.token, 'base64'))));
    if (!forceRefresh && (!current.expiresAt || current.expiresAt > Date.now() + 60000)) return tokens.access_token;
    if (!tokens.refresh_token || !current.clientId) {
      if (!forceRefresh && !current.expiresAt) return tokens.access_token;
      throw new Error('Reconnect Notion.');
    }
    if (!refreshPromise) refreshPromise = (async () => {
      const response = await request(`${ORIGIN}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: current.clientId }) });
      const next = tokenSchema.parse(await response.json());
      // Refresh tokens rotate. Persist the replacement before allowing another refresh.
      await storeTokens({ ...next, refresh_token: next.refresh_token ?? tokens.refresh_token }, current.clientId);
      return next.access_token;
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };
  const rpc = async (method, parameters, notification = false) => {
    const attempt = async (token, currentSessionId) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
      if (currentSessionId) headers['Mcp-Session-Id'] = currentSessionId;
      const body = { jsonrpc: '2.0', method, params: parameters };
      if (!notification) body.id = ++rpcId;
      const response = await request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
      sessionId = response.headers.get('Mcp-Session-Id') ?? sessionId;
      return response;
    };
    let response;
    try {
      response = await attempt(await getToken(), sessionId);
    } catch (err) {
      if (err?.status === 401) {
        const refreshed = await getToken(true);
        sessionId = undefined;
        initialized = false;
        response = await attempt(refreshed, undefined);
      } else if (sessionId && [400, 404, 502, 503, 504].includes(err?.status)) {
        sessionId = undefined;
        initialized = false;
        response = await attempt(await getToken(), undefined);
      } else {
        throw err;
      }
    }
    if (notification) return;
    const text = await response.text();
    const packets = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()) : [text];
    for (const packet of packets) {
      let value;
      try { value = JSON.parse(packet); } catch { continue; }
      const result = rpcSchema.safeParse(value);
      if (!result.success) continue;
      if (result.data.error) throw new Error('Notion could not complete this request.');
      if (result.data.result) return result.data.result;
    }
    throw new Error('Notion returned an unsupported response.');
  };
  const decodeTool = (result) => {
    if (result.isError) throw new Error('Notion could not complete this request. Check the selected page and permissions.');
    const text = result.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
    if (!text) throw new Error('Notion returned no result.');
    try { return JSON.parse(text); } catch { return { text }; }
  };
  const resolveTool = (name) => toolDefinitions.find((entry) => entry.name.replace(/^notion[-_]/, '').replaceAll('_', '-') === name);
  const tool = (name, args) => {
    const operation = queue.then(async () => {
      checkBoundary();
      // Refresh before initialization; session headers may be absent on a stateless server.
      await getToken();
      if (!initialized) {
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OpenChamber Personal', version: '1.0.0' } });
        await rpc('notifications/initialized', {}, true);
        const listing = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() }).optional() })) }).parse(await rpc('tools/list', {}));
        toolDefinitions = listing.tools;
        const accessName = resolveTool('get-tool-access');
        if (accessName) access = decodeTool(await rpc('tools/call', { name: accessName.name, arguments: {} }));
        initialized = true;
      }
      const canonical = name.replace(/^notion-/, '');
      const actual = resolveTool(canonical);
      if (!actual) throw new Error('This Notion connection does not expose the required tool.');
      const permission = access?.current_tool_access?.[canonical.replaceAll('-', '_')];
      // View mode has no tool-specific quota, even when SQL/rows are metered.
      const viewRead = canonical === 'query-data-sources' && args.data?.mode === 'view';
      if (permission && !['available', 'available_with_limit'].includes(permission.status)
        && !(viewRead && ['plan_required', 'upgrade_required', 'full_version_required'].includes(permission.status))) throw new Error('Your Notion connection does not allow this action.');
      // Hosted MCP wraps updates in data; other clients expose the fields directly.
      const argumentsForTool = actual.inputSchema?.properties && Object.hasOwn(actual.inputSchema.properties, 'data') && !Object.hasOwn(args, 'data') ? { data: args } : args;
      let output = decodeTool(await rpc('tools/call', { name: actual.name, arguments: argumentsForTool }));
      if (output.async_task) {
        const taskId = z.string().parse(output.async_task.task_id);
        const poll = resolveTool('get-async-task');
        if (!poll) throw new Error('Notion queued this action. Check Notion before trying again.');
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          output = decodeTool(await rpc('tools/call', { name: poll.name, arguments: { task_id: taskId } }));
          if (output.status === 'succeeded') return output.result ?? { saved: true };
          if (output.status === 'failed') throw new Error('Notion could not complete the queued action.');
        }
        throw new Error('Notion is still processing this action. Check Notion before trying again.');
      }
      return output;
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const fetchSource = async (id) => {
    const completeFetch = async (target) => {
      const fetched = fetchSchema.parse(await tool('fetch', { id: target }));
      if (fetched.truncated || fetched.text.includes('<unknown')) throw new Error('Notion returned incomplete database metadata. Check access in Notion and refresh.');
      return fetched;
    };
    let fetched = await completeFetch(id);
    let content = fetched.text;
    if (!content.includes('<data-source-state>')) {
      const unique = [...new Set([...content.matchAll(/collection:\/\/[0-9a-f-]+/g)].map((match) => match[0]))];
      if (unique.length !== 1) throw new Error('Choose a single Notion data source.');
      fetched = await completeFetch(unique[0]);
      content = fetched.text;
    }
    if ([...content.matchAll(/<data-source-state>/g)].length !== 1) throw new Error('Choose a single Notion data source.');
    const selected = sourceSchema.parse(JSON.parse(content.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/)[1]));
    if (id.startsWith('collection://') && selected.url !== id) throw new Error('Notion returned a different data source. Check the selected database and refresh.');
    if (!content.includes('<views>') && fetched.url && !fetched.url.startsWith('collection://')) {
      const database = await completeFetch(fetched.url);
      // Keep the selected source's schema, not the first source in its database.
      content += `\n${database.text.match(/<views>[\s\S]*?<\/views>/)?.[0] ?? ''}`;
    }
    return content;
  };
  // Read-only startup metadata: at most four 1 MiB entries, fifteen seconds,
  // scoped to this encrypted connection. Rows and view validation remain live.
  // Every write uses fetchSource directly, including membership checks.
  const source = async (id, fresh = true) => {
    checkBoundary();
    if (fresh) return fetchSource(id);
    await getToken(); // rotating credentials invalidates before capturing scope
    const cached = sourceReads.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    sourceReads.delete(id);
    while (sourceReads.size >= 4) sourceReads.delete(sourceReads.keys().next().value);
    const revision = connectionRevision;
    const entry = { expiresAt: Date.now() + 300000, promise: undefined };
    entry.promise = fetchSource(id).then((text) => {
      if (revision !== connectionRevision) throw new Error('The Notion connection changed. Refresh the board.');
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) sourceReads.delete(id);
      return text;
    }).catch((error) => { if (sourceReads.get(id) === entry) sourceReads.delete(id); throw error; });
    sourceReads.set(id, entry);
    return entry.promise;
  };
  const habits = async (day) => {
    cachedHabits = undefined;
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(day);
    const content = await source((await load()).habits);
    const match = content.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/);
    if (!match) throw new Error('The habits data source is unavailable.');
    const parsed = sourceSchema.parse(JSON.parse(match[1]));
    const title = Object.values(parsed.schema).find((property) => property.type === 'title');
    const date = Object.values(parsed.schema).find((property) => property.type === 'date' && !property.readOnly);
    const checks = Object.values(parsed.schema).filter((property) => property.type === 'checkbox' && !property.readOnly).map((property) => property.name);
    if (!title || !date || !checks.length) throw new Error('Habits needs a date, title and checkbox properties.');
    const rows = await readSavedViewRows({ tool, source: parsed, text: content, properties: [title.name, date.name, ...checks] });
    const matching = rows.filter((row) => row[`date:${date.name}:start`] === day);
    if (matching.length > 1) throw new Error('There is more than one habits entry for today. Resolve the duplicate in Notion.');
    const row = matching[0];
    const page = row ? z.string().parse(row.url) : null;
    cachedHabits = { source: parsed.url, title: title.name, date: date.name, checks, day, page };
    return { day, page, items: checks.map((name) => ({ name, checked: row?.[name] === '__YES__' })) };
  };
  const taskRows = async (parsed) => {
    const current = await load();
    const trashed = new Set((current.trashedPages ?? []).map((item) => { try { return notionPageId(item); } catch { return item; } }));
    const raw = await readSavedViewRows({ tool, source: parsed.source, text: parsed.text,
      properties: [parsed.title.name, parsed.status.name, ...(parsed.due ? [parsed.due.name] : [])] });
    return rowsSchema.parse({ results: raw.filter((row) => {
      if (!trashed.size || !row.url) return true;
      try { return !trashed.has(row.url) && !trashed.has(notionPageId(row.url)); } catch { return !trashed.has(row.url); }
    }).map((row) => ({
      url: row.url, title: row[parsed.title.name] ?? null, status: row[parsed.status.name] ?? null,
      dueStart: parsed.due ? row[`date:${parsed.due.name}:start`] ?? null : null,
      dueEnd: parsed.due ? row[`date:${parsed.due.name}:end`] ?? null : null,
      dueIsDatetime: parsed.due ? row[`date:${parsed.due.name}:is_datetime`] ?? null : null,
    })) });
  };
  const board = async (fresh = true) => {
    cachedBoard = undefined;
    const current = await load();
    if (!current.board) throw new Error('Choose a Notion task database first.');
    const content = await source(current.board, fresh);
    const parsed = parseBoardSource(content);
    const result = await taskRows(parsed);
    cachedBoard = { ...parsed, rows: result.results };
    return { name: parsed.source.name, columns: parsed.status.options.map((option) => option.name), rows: result.results.map(({ dueStart, dueEnd, dueIsDatetime, ...row }) => ({ ...row, due: dueStart ? { start: dueStart, end: dueEnd, isDatetime: dueIsDatetime === 1 } : null })), limited: false };
  };
  const connect = async () => {
    checkBoundary();
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    if (pendingAuth) throw new Error('A Notion sign-in is already open.');
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
    pendingAuth = listener;
    const timeout = setTimeout(() => { listener.close(); pendingAuth = undefined; }, 600000);
    timeout.unref();
    try {
      const registration = z.object({ client_id: z.string().min(1) }).parse(await (await request(`${ORIGIN}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'OpenChamber Personal', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      })).json());
      let exchanging = false;
      listener.on('request', async (req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || exchanging) { res.writeHead(400).end(); return; }
        exchanging = true;
        try {
          checkBoundary();
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) throw new Error('Notion sign-in was cancelled.');
          const response = await request(`${ORIGIN}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registration.client_id, redirect_uri: redirectUri }) });
          await storeTokens(tokenSchema.parse(await response.json()), registration.client_id);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Notion connected. Return to OpenChamber and refresh.');
        } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Notion connection was not saved. Return to OpenChamber and reconnect.'); }
        finally { clearTimeout(timeout); listener.close(); pendingAuth = undefined; }
      });
      const params = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri, scope: 'default', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      await openExternal(`${ORIGIN}/authorize?${params}`);
      return { started: true };
    } catch (error) { clearTimeout(timeout); listener.close(); pendingAuth = undefined; throw error; }
  };
  // Separate from cachedBoard: automated work must never replace Daily To-Do
  // membership used by the existing Home controls.
  const aiSource = async (id, fresh = true) => {
    checkBoundary();
    const parsed = parseBoardSource(await source(id, fresh));
    const daily = parseBoardSource(await source((await load()).board, fresh));
    if (daily.source.url === parsed.source.url) throw new Error('Use a separate database for AI Tasks, not Daily To-Do.');
    return parsed;
  };
  const aiRows = async (parsed, status) => {
    const result = await taskRows(parsed);
    return { name: parsed.source.name, columns: parsed.status.options.map((item) => item.name), rows: result.results
      .filter((row) => !status || row.status === status).map(({ url, title, status }) => ({ url, title, status, due: null })), limited: false };
  };
  const aiMember = async (parsed, page) => {
    notionPageId(page);
    // Refresh source and view configuration as well as all pages. No cached row
    // or truncated first page can authorize a claim or result write.
    const fresh = parseBoardSource(await source(parsed.source.url));
    if (fresh.status.name !== parsed.status.name || fresh.title.name !== parsed.title.name) throw new Error('The task schema changed. Refresh the board before making changes.');
    const result = await aiRows(fresh);
    const row = result.rows.find((item) => item.url === page);
    if (!row) throw new Error('This task is no longer in the AI Tasks database.');
    return row;
  };
  const aiMove = async (parsed, page, status) => {
    if (!parsed.status.options.some((option) => option.name === status)) throw new Error('Choose a status that exists on the AI Tasks board.');
    await tool('update-page', { page_id: notionPageId(page), command: 'update_properties', properties: { [parsed.status.name]: status }, allow_async: false });
  };
  const aiContent = async (page) => {
    const fetched = fetchSchema.parse(await tool('fetch', { id: page }));
    const content = fetched.text.match(/<content>\s*([\s\S]*?)\s*<\/content>/)?.[1]
      ?? (fetched.truncated ? fetched.text.match(/<content>\s*([\s\S]*)$/)?.[1] : undefined);
    if (fetched.truncated && (!content || content.trim().length < 200)) {
      throw new Error('This task page is incomplete. Open Notion to resolve it before pickup.');
    }
    if (content === undefined) throw new Error('Notion did not return editable task content.');
    return content.replace(/<unknown\b[^>]*\/>/gi, '').replace(/<unknown\b[^>]*>[\s\S]*?<\/unknown>/gi, '');
  };
  const trashPage = async (page, confirmed, fallbackMove) => {
    z.literal(true).parse(confirmed);
    const target = deleteToolCandidates.map((name) => ({ name, definition: resolveTool(name) })).find((item) => item.definition);
    if (!target) throw new Error('Your Notion connection does not allow deleting tasks.');
    // Use only fields actually advertised by the hosted connection. Unknown
    // required parameters are a setup error, never guessed or silently omitted.
    const schema = target.definition.inputSchema;
    const wrapped = schema?.properties && Object.hasOwn(schema.properties, 'data');
    const advertised = z.object({ properties: z.record(z.string(), z.json()), required: z.array(z.string()).optional() }).safeParse(wrapped ? schema.properties.data : schema);
    if (!advertised.success) throw new Error('Notion did not advertise a supported trash-page schema.');
    const properties = advertised.data.properties;
    const id = notionPageId(page);
    const singular = z.object({ type: z.literal('string') }).safeParse(properties.page_id);
    const plural = z.object({ type: z.literal('array'), items: z.object({ type: z.literal('string') }) }).safeParse(properties.page_ids);
    const args = singular.success ? { page_id: id } : plural.success ? { page_ids: [id] } : null;
    if (!args) throw new Error('Notion did not advertise a supported trash-page schema.');
    for (const key of ['confirmed', 'confirm', 'consent', 'in_trash', 'archived']) {
      const consent = z.object({ type: z.literal('boolean').optional(), const: z.literal(true).optional(), enum: z.array(z.boolean()).optional() }).safeParse(properties[key]);
      if (Object.hasOwn(properties, key)) {
        if (!consent.success || !(consent.data.type === 'boolean' || consent.data.const === true || consent.data.enum?.includes(true))) throw new Error('Notion did not advertise a supported trash confirmation.');
        args[key] = confirmed;
      }
    }
    for (const key of advertised.data.required ?? []) {
      if (Object.hasOwn(args, key)) continue;
      throw new Error('Notion requires unsupported trash-page parameters. No task was deleted.');
    }
    if (Object.hasOwn(properties, 'allow_async')) args.allow_async = false;
    let response;
    try {
      response = await tool(target.name, args);
    } catch (error) {
      if (error?.message === 'Notion could not complete this request. Check the selected page and permissions.') {
        if (fallbackMove) await fallbackMove().catch(() => {});
        const current = await load();
        await save({ trashedPages: [...new Set([...(current.trashedPages ?? []), page, id])] });
        invalidateReads();
        return { saved: true };
      }
      throw error;
    }
    if (response.warnings?.length) throw new Error('Notion reported trash warnings. Review the task in Notion before retrying.');
    invalidateReads();
    return { saved: true };
  };
  const automation = {
    async prepareCreateBoard() {
      // Authenticate and discover capabilities before the durable creation
      // claim. A disconnected account must be reconnectable, not ambiguous.
      await tool('fetch', { id: 'notion://docs/enhanced-markdown-spec' });
      if (!resolveTool('create-database')) throw new Error('This Notion connection does not expose database creation. Connect an existing database in setup.');
    },
    async createBoard() {
      const response = fetchSchema.parse(await tool('create-database', {
        title: 'AI Tasks',
        schema: `CREATE TABLE ("Task" TITLE, "Status" SELECT('Idea':gray, 'Ready for AI':blue, 'Doing':yellow, 'Done':green, 'Needs you':red, 'Parked':brown))`,
        description: 'Open Carter tasks. Moving a card to Ready for AI authorizes pickup. Results are written to the original card.',
      }));
      const sources = [...new Set(response.text.match(/collection:\/\/[0-9a-f-]+/gi) ?? [])];
      if (sources.length !== 1) throw new Error('The board was created, but its data source could not be confirmed. Find AI Tasks in Notion and paste its URL in setup.');
      return sources[0];
    },
    async readBoard(id, status) {
      const result = await shareBoardRead(JSON.stringify(['ai', id]), async () => {
        try { const parsed = await aiSource(id, false); return await aiRows(parsed); }
        catch (error) { sourceReads.clear(); throw error; }
      });
      return status ? { ...result, rows: result.rows.filter((row) => row.status === status) } : result;
    },
    async readTask(id, page) {
      const parsed = await aiSource(id);
      const row = await aiMember(parsed, page);
      const notes = taskNotes(taskBody(await aiContent(page)).brief);
      const title = row.title?.trim();
      const references = await resolveNotionTaskReferences({ notes,
        fetchPage: async (url) => {
          try { return await tool('fetch', { id: url }); }
          catch { throw new NotionReferenceError('notion_reference_access', 'The referenced Notion page could not be read through the connected workspace. Check its access before sending the task.'); }
        },
        search: async (query) => {
          try { return await tool('search', { query, query_type: 'internal' }); }
          catch { throw new NotionReferenceError('notion_reference_access', 'Notion could not search the requested source through the connected workspace. Check its access or paste its page URL.'); }
        },
      });
      // The manager gets the title and every note on the page. A title alone
      // is still a valid quick request.
      if (notes) return (title ? `# ${title}\n\n${notes}` : notes) + references;
      if (title) return title;
      throw new Error('Describe the task in its Notion page before moving it to Ready for AI.');
    },
    async claim(id, page) {
      const parsed = await aiSource(id);
      if ((await aiMember(parsed, page)).status !== 'Ready for AI') return false;
      await aiMove(parsed, page, 'Doing');
      return true;
    },
    async move(id, page, status) { const parsed = await aiSource(id); await aiMember(parsed, page); await aiMove(parsed, page, status); return { saved: true }; },
    async delete(id, raw) {
      const remove = deleteTaskSchema.extend({ confirmed: z.literal(true) }).parse(raw);
      const parsed = await aiSource(id);
      if ((await aiMember(parsed, remove.page)).status === 'Doing') throw new Error('This task is running. Wait for it to finish before deleting it.');
      return trashPage(remove.page, remove.confirmed, () => parsed.status.options.some((option) => option.name === 'Parked') ? aiMove(parsed, remove.page, 'Parked') : Promise.resolve());
    },
    async create(id, raw) {
      const task = aiCreateSchema.parse(raw);
      const parsed = await aiSource(id);
      // Authorship defaults to Idea, never automatic authorization to execute.
      // The body is never empty, so result writeback always has an anchor.
      await tool('create-pages', { parent: { data_source_id: parsed.source.url.replace('collection://', '') }, pages: [{ properties: { [parsed.title.name]: task.title, [parsed.status.name]: 'Idea' }, content: task.notes?.trim() || NOTES_PROMPT }], allow_async: false });
      return { saved: true };
    },
    async readNotes(id, page) {
      const parsed = await aiSource(id);
      const row = await aiMember(parsed, page);
      return { notes: plainNotes(taskBody(await aiContent(page)).brief), editable: row.status !== 'Doing' };
    },
    async saveNotes(id, raw) {
      const change = aiNotesSchema.parse(raw);
      const parsed = await aiSource(id);
      // A running manager already has its brief; changing the page mid-run
      // would make the saved result disagree with what was asked.
      if ((await aiMember(parsed, change.page)).status === 'Doing') throw new Error('This task is running. Wait for it to finish before changing its notes.');
      const content = await aiContent(change.page);
      const { brief, results } = taskBody(content);
      const next = change.notes.trim() || NOTES_PROMPT;
      requireClosedNotesCode(next);
      if (brief === next || notesKey(brief) === notesKey(next)) return { saved: true };
      await tool('fetch', { id: 'notion://docs/enhanced-markdown-spec' });
      const replacement = results ? `${next}\n\n${results}` : next;
      // update_content requires a non-empty anchor. An authoritative empty
      // page has no existing blocks to preserve, so it can be initialized.
      const update = content.trim()
        ? { command: 'update_content', content_updates: [{ old_str: content, new_str: replacement }] }
        : { command: 'replace_content', new_str: replacement };
      let response;
      try {
        response = await tool('update-page', { page_id: notionPageId(change.page), ...update, allow_async: false });
      } catch (error) {
        const hasRichBlocks = /<(?:page|database|mention-page|mention-database|file|pdf|audio|video|image)\b/i.test(content);
        if (hasRichBlocks && !results) {
          response = await tool('update-page', { page_id: notionPageId(change.page), command: 'replace_content', new_str: replacement, allow_async: false });
        } else {
          // A lost acknowledgement is not permission to repeat the write. A
          // complete read can prove it already applied, including preserved results.
          let saved;
          try { saved = await aiContent(change.page); } catch { throw error; }
          if (notesKey(saved) === notesKey(replacement)) return { saved: true };
          throw error;
        }
      }
      if (response.warnings?.length) throw new Error('Notion reported content warnings. Review the task page in Notion.');
      // The hosted tool reports changed/dropped input in warnings. Do not turn
      // its clean acknowledgement into a failure because readback reformats
      // links, paragraphs, list numbering or tables. Only ambiguous writes
      // above need content-based recovery, and they never authorize a resend.
      return { saved: true };
    },
    async finish(run) {
      const parsed = await aiSource(run.board);
      const member = await aiMember(parsed, run.page);
      const marker = `Open Carter run ${run.id}`;
      let content = await aiContent(run.page);
      // A status write may have succeeded before a connection failure. Confirm
      // the marker before considering that recovered run complete.
      const status = run.outcome === 'done' ? 'Done' : 'Needs you';
      if (member.status === status && content.includes(marker)) return true;
      if (member.status !== 'Doing') return false;
      if (!content.includes(marker)) {
        if (!content.trim()) throw new Error('The task page was cleared. Restore its description before saving the result.');
        await tool('fetch', { id: 'notion://docs/enhanced-markdown-spec' });
        const chat = run.sessionId ? `[Open chat](openchamber://session/${encodeURIComponent(run.sessionId)})` : 'Not dispatched';
        const result = `\n\n## ${marker}\n\n${chat}\n\n${run.content}`;
        let response;
        try {
          response = await tool('update-page', {
            page_id: notionPageId(run.page), command: 'update_content', content_updates: [{ old_str: content, new_str: content + result }], allow_async: false,
          });
        } catch (error) {
          const hasRichBlocks = /<(?:page|database|mention-page|mention-database|file|pdf|audio|video|image)\b/i.test(content);
          if (!hasRichBlocks) throw error;
          const anchor = content.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() && !/^<(?:page|database|mention-page|mention-database)\b/i.test(line.trim())).at(-1) ?? '';
          if (anchor) {
            try {
              response = await tool('update-page', {
                page_id: notionPageId(run.page), command: 'update_content', content_updates: [{ old_str: anchor, new_str: `${anchor}${result}` }], allow_async: false,
              });
            } catch {
              response = null;
            }
          } else {
            response = null;
          }
        }
        if (response?.warnings?.length) throw new Error('Notion reported content warnings. Review the task page before retrying.');
        if (response) {
          content = await aiContent(run.page);
          if (!content.includes(marker)) throw new Error('Notion did not confirm the task result.');
        }
      }
      // Respect user moves made while content was being written.
      if ((await aiMember(parsed, run.page)).status !== 'Doing') return false;
      await aiMove(parsed, run.page, status);
      if ((await aiMember(parsed, run.page)).status !== status) throw new Error('Notion did not confirm the completed task status.');
      return true;
    },
  };
  return {
    automation,
    close: () => { pendingAuth?.close(); pendingAuth = undefined; },
    handle: async (raw) => {
      const action = z.object({ action: z.string() }).parse(raw).action;
      if (action === 'calendar') return calendar(raw);
      if (action === 'disconnect') {
        await save({ token: undefined, clientId: undefined, expiresAt: undefined });
        invalidateReads();
        initialized = false; sessionId = undefined; access = undefined; cachedBoard = undefined; cachedHabits = undefined;
        return { saved: true };
      }
      checkBoundary();
      const current = await load();
      if (action === 'status') return { connected: Boolean(current.token), signingIn: Boolean(pendingAuth), board: current.board, habits: current.habits, destination: current.destination };
      if (action === 'connect') return connect();
      if (action === 'configure') {
        const config = z.object({ board: z.string().min(1).max(2000), habits: z.string().min(1).max(2000), destination: z.string().min(1).max(2000) }).parse(raw);
        await save(config);
        invalidateReads();
        cachedBoard = undefined;
        cachedHabits = undefined;
        return { saved: true };
      }
      if (action === 'board') return shareBoardRead('daily', () => board(false).catch((error) => { sourceReads.clear(); throw error; }));
      if (action === 'habits') return habits(z.object({ day: z.string() }).parse(raw).day);
      if (action === 'habit') {
        const change = z.object({ page: z.string(), name: z.string(), checked: z.boolean() }).parse(raw);
        if (!cachedHabits || cachedHabits.page !== change.page || !cachedHabits.checks.includes(change.name)) throw new Error('Refresh habits before changing a checkbox.');
        const latest = await habits(cachedHabits.day);
        if (latest.page !== change.page || !latest.items.some((item) => item.name === change.name)) throw new Error('Refresh habits before changing a checkbox.');
        await tool('update-page', { page_id: notionPageId(change.page), command: 'update_properties', properties: { [change.name]: change.checked ? '__YES__' : '__NO__' }, allow_async: false });
        return { saved: true };
      }
      if (action === 'start-day') {
        const day = z.object({ day: z.string() }).parse(raw).day;
        const latest = await habits(day);
        if (!latest.page) {
          const target = cachedHabits;
          await tool('create-pages', { parent: { data_source_id: target.source.replace('collection://', '') }, pages: [{ properties: { [target.title]: day, [`date:${target.date}:start`]: day, [`date:${target.date}:is_datetime`]: 0 } }], allow_async: false });
        }
        return habits(day);
      }
      if (action === 'move') {
        const move = taskMoveSchema.parse(raw);
        if (!cachedBoard || !cachedBoard.rows.some((row) => row.url === move.page) || !cachedBoard.status.options.some((option) => option.name === move.status)) throw new Error('Refresh the board before changing a task.');
        await board();
        if (!cachedBoard.rows.some((row) => row.url === move.page) || !cachedBoard.status.options.some((option) => option.name === move.status)) throw new Error('Refresh the board before changing a task.');
        const target = cachedBoard;
        await tool('notion-update-page', { page_id: notionPageId(move.page), command: 'update_properties', properties: { [target.status.name]: move.status }, allow_async: false });
        if (cachedBoard === target) target.rows = target.rows.map((row) => row.url === move.page ? { ...row, status: move.status } : row);
        return { saved: true };
      }
      if (action === 'create-task') {
        const create = createTaskSchema.parse(raw);
        await board();
        const chosen = create.status ?? cachedBoard.status.options[0].name;
        if (!cachedBoard.status.options.some((option) => option.name === chosen)) throw new Error('Choose a status that exists on this board.');
        await tool('create-pages', { parent: { data_source_id: cachedBoard.source.url.replace('collection://', '') }, pages: [{ properties: { [cachedBoard.title.name]: create.title, [cachedBoard.status.name]: chosen } }], allow_async: false });
        cachedBoard = undefined;
        return { saved: true };
      }
      if (action === 'rename-task') {
        const rename = renameTaskSchema.parse(raw);
        if (!cachedBoard || !cachedBoard.rows.some((row) => row.url === rename.page)) throw new Error('Refresh the board before editing a task.');
        await board();
        if (!cachedBoard.rows.some((row) => row.url === rename.page)) throw new Error('Refresh the board before editing a task.');
        await tool('notion-update-page', { page_id: notionPageId(rename.page), command: 'update_properties', properties: { [cachedBoard.title.name]: rename.title }, allow_async: false });
        cachedBoard = undefined;
        return { saved: true };
      }
      if (action === 'delete-task') {
        const remove = deleteTaskSchema.extend({ confirmed: z.literal(true) }).parse(raw);
        if (!cachedBoard || !cachedBoard.rows.some((row) => row.url === remove.page)) throw new Error('Refresh the board before deleting a task.');
        await board();
        if (!cachedBoard.rows.some((row) => row.url === remove.page)) throw new Error('Refresh the board before deleting a task.');
        await trashPage(remove.page, remove.confirmed);
        cachedBoard = undefined;
        return { saved: true };
      }
      if (action === 'export') {
        const chat = exportSchema.parse(raw);
        if (!current.destination) throw new Error('Choose a Notion page for saved chats first.');
        await tool('fetch', { id: 'notion://docs/enhanced-markdown-spec' });
        return tool('create-pages', { parent: { page_id: notionPageId(current.destination) }, pages: [{ properties: { title: chat.title }, content: chat.content }], allow_async: false });
      }
      throw new Error('Unsupported personal homepage action.');
    },
  };
}
