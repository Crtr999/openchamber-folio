import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const ORIGIN = 'https://mcp.notion.com';
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().optional() });
const settingsSchema = z.object({ token: z.string().optional(), clientId: z.string().optional(), expiresAt: z.number().optional(), board: z.string().default('collection://024860a0-3918-450b-93c0-074f9512c67e'), habits: z.string().default('collection://f26696d5-a0fd-4add-a9ae-a7b48f4e2a15'), destination: z.string().default('3ea4fdbe-e450-80a5-b571-f1abf619e7af') });
const rpcSchema = z.object({ result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(), isError: z.boolean().optional() }).passthrough().optional(), error: z.object({ message: z.string() }).optional() });
const fetchSchema = z.object({ text: z.string() });
const propertySchema = z.object({ name: z.string(), type: z.string(), readOnly: z.boolean().optional(), options: z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional() }).passthrough()).optional(), groups: z.record(z.string(), z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional() }).passthrough())).optional() }).passthrough();
const sourceSchema = z.object({ url: z.string(), name: z.string(), schema: z.record(z.string(), propertySchema) });
const rowsSchema = z.object({ results: z.array(z.object({ url: z.string(), title: z.string().nullable(), status: z.string().nullable(), dueStart: z.string().nullable().default(null), dueEnd: z.string().nullable().default(null), dueIsDatetime: z.union([z.literal(0), z.literal(1)]).nullable().default(null) })), has_more: z.boolean().optional() });
const taskMoveSchema = z.object({ page: z.string().min(1), status: z.string().min(1) });
const createTaskSchema = z.object({ title: z.string().trim().min(1).max(500), status: z.string().optional() });
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
  return { source, title, status, due };
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
    if (!response.ok) throw new Error(`Notion request failed (${response.status}). Reconnect if your access has expired.`);
    return response;
  };
  const storeTokens = async (tokens, clientId) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    await save({ token: encrypted, clientId, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined });
    sessionId = undefined;
    initialized = false;
    access = undefined;
  };
  const getToken = async () => {
    checkBoundary();
    const current = await load();
    if (!current.token || !safeStorage.isEncryptionAvailable()) throw new Error('Connect Notion first.');
    const tokens = tokenSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(current.token, 'base64'))));
    if (!current.expiresAt || current.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token || !current.clientId) throw new Error('Reconnect Notion.');
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
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const body = { jsonrpc: '2.0', method, params: parameters };
    if (!notification) body.id = ++rpcId;
    const response = await request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    sessionId = response.headers.get('Mcp-Session-Id') ?? sessionId;
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
        const listing = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional() })) }).parse(await rpc('tools/list', {}));
        toolDefinitions = listing.tools;
        const accessName = resolveTool('get-tool-access');
        if (accessName) access = decodeTool(await rpc('tools/call', { name: accessName.name, arguments: {} }));
        initialized = true;
      }
      const canonical = name.replace(/^notion-/, '');
      const actual = resolveTool(canonical);
      if (!actual) throw new Error('This Notion connection does not expose the required tool.');
      const permission = access?.current_tool_access?.[canonical.replaceAll('-', '_')];
      if (permission && permission.status !== 'available') throw new Error('Your Notion connection does not allow this action.');
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
  const source = async (id) => {
    let content = fetchSchema.parse(await tool('fetch', { id })).text;
    if (!content.includes('<data-source-state>')) {
      const unique = [...new Set([...content.matchAll(/collection:\/\/[0-9a-f-]+/g)].map((match) => match[0]))];
      if (unique.length !== 1) throw new Error('Choose a single Notion data source.');
      content = fetchSchema.parse(await tool('fetch', { id: unique[0] })).text;
    }
    return content;
  };
  const habits = async (day) => {
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(day);
    const content = await source((await load()).habits);
    const match = content.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/);
    if (!match) throw new Error('The habits data source is unavailable.');
    const parsed = sourceSchema.parse(JSON.parse(match[1]));
    const title = Object.values(parsed.schema).find((property) => property.type === 'title');
    const date = Object.values(parsed.schema).find((property) => property.type === 'date' && !property.readOnly);
    const checks = Object.values(parsed.schema).filter((property) => property.type === 'checkbox' && !property.readOnly).map((property) => property.name);
    if (!title || !date || !checks.length) throw new Error('Habits needs a date, title and checkbox properties.');
    const response = z.object({ results: z.array(z.record(z.string(), z.unknown())) }).parse(await tool('query-data-sources', { data: {
      mode: 'sql', data_source_urls: [parsed.url], params: [day],
      query: `SELECT url, ${checks.map(quoteSqlIdentifier).join(', ')} FROM ${quoteSqlIdentifier(parsed.url)} WHERE ${quoteSqlIdentifier(`date:${date.name}:start`)} = ? LIMIT 2`,
    } }));
    if (response.results.length > 1) throw new Error('There is more than one habits entry for today. Resolve the duplicate in Notion.');
    const row = response.results[0];
    const page = row ? z.string().parse(row.url) : null;
    cachedHabits = { source: parsed.url, title: title.name, date: date.name, checks, day, page };
    return { day, page, items: checks.map((name) => ({ name, checked: row?.[name] === '__YES__' })) };
  };
  const board = async () => {
    const current = await load();
    if (!current.board) throw new Error('Choose a Notion task database first.');
    const content = await source(current.board);
    const parsed = parseBoardSource(content);
    const dueColumns = parsed.due
      ? `${quoteSqlIdentifier(`date:${parsed.due.name}:start`)} AS dueStart, ${quoteSqlIdentifier(`date:${parsed.due.name}:end`)} AS dueEnd, ${quoteSqlIdentifier(`date:${parsed.due.name}:is_datetime`)} AS dueIsDatetime`
      : 'NULL AS dueStart, NULL AS dueEnd, NULL AS dueIsDatetime';
    const result = rowsSchema.parse(await tool('notion-query-data-sources', { data: {
      mode: 'sql', data_source_urls: [parsed.source.url],
      query: `SELECT url, ${quoteSqlIdentifier(parsed.title.name)} AS title, ${quoteSqlIdentifier(parsed.status.name)} AS status, ${dueColumns} FROM ${quoteSqlIdentifier(parsed.source.url)} ORDER BY createdTime DESC LIMIT 100`,
    } }));
    cachedBoard = { ...parsed, rows: result.results };
    return { name: parsed.source.name, columns: parsed.status.options.map((option) => option.name), rows: result.results.map(({ dueStart, dueEnd, dueIsDatetime, ...row }) => ({ ...row, due: dueStart ? { start: dueStart, end: dueEnd, isDatetime: dueIsDatetime === 1 } : null })), limited: result.results.length === 100 };
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
  return {
    close: () => { pendingAuth?.close(); pendingAuth = undefined; },
    handle: async (raw) => {
      const action = z.object({ action: z.string() }).parse(raw).action;
      if (action === 'calendar') return calendar(raw);
      if (action === 'disconnect') {
        await save({ token: undefined, clientId: undefined, expiresAt: undefined });
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
        cachedBoard = undefined;
        cachedHabits = undefined;
        return { saved: true };
      }
      if (action === 'board') return board();
      if (action === 'habits') return habits(z.object({ day: z.string() }).parse(raw).day);
      if (action === 'habit') {
        const change = z.object({ page: z.string(), name: z.string(), checked: z.boolean() }).parse(raw);
        if (!cachedHabits || cachedHabits.page !== change.page || !cachedHabits.checks.includes(change.name)) throw new Error('Refresh habits before changing a checkbox.');
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
        const target = cachedBoard;
        await tool('notion-update-page', { page_id: notionPageId(move.page), command: 'update_properties', properties: { [target.status.name]: move.status }, allow_async: false });
        if (cachedBoard === target) target.rows = target.rows.map((row) => row.url === move.page ? { ...row, status: move.status } : row);
        return { saved: true };
      }
      if (action === 'create-task') {
        const create = createTaskSchema.parse(raw);
        if (!cachedBoard) await board();
        const chosen = create.status ?? cachedBoard.status.options[0].name;
        if (!cachedBoard.status.options.some((option) => option.name === chosen)) throw new Error('Choose a status that exists on this board.');
        await tool('create-pages', { parent: { data_source_id: cachedBoard.source.url.replace('collection://', '') }, pages: [{ properties: { [cachedBoard.title.name]: create.title, [cachedBoard.status.name]: chosen } }], allow_async: false });
        cachedBoard = undefined;
        return { saved: true };
      }
      if (action === 'rename-task') {
        const rename = renameTaskSchema.parse(raw);
        if (!cachedBoard || !cachedBoard.rows.some((row) => row.url === rename.page)) throw new Error('Refresh the board before editing a task.');
        await tool('notion-update-page', { page_id: notionPageId(rename.page), command: 'update_properties', properties: { [cachedBoard.title.name]: rename.title }, allow_async: false });
        cachedBoard = undefined;
        return { saved: true };
      }
      if (action === 'delete-task') {
        const remove = deleteTaskSchema.parse(raw);
        if (!cachedBoard || !cachedBoard.rows.some((row) => row.url === remove.page)) throw new Error('Refresh the board before deleting a task.');
        const target = deleteToolCandidates.find((candidate) => resolveTool(candidate));
        if (!target) throw new Error('Your Notion connection does not allow deleting tasks.');
        await tool(target, { page_id: notionPageId(remove.page) });
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
