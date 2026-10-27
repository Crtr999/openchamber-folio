import crypto from 'node:crypto';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { catalogFromNames, defaultCatalog, readCatalogFile, writeCatalogFile } from './catalog.js';
import { setWebsiteUsageRequester } from './usage-bridge.js';

const toolSchema = z.object({ type: z.literal('function'), function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() }) });
const textSchema = z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() })).transform(parts => parts.map(part => part.text).join('\n'))]);
const callSchema = z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) });
const requestSchema = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']), content: textSchema.nullish(), tool_call_id: z.string().optional(), tool_calls: z.array(callSchema).optional() })).min(1).max(1000),
  tools: z.array(toolSchema).max(256).optional(), tool_choice: z.unknown().optional(),
});
const resultSchema = z.object({ id: z.string().uuid(), lease: z.string().uuid(), text: z.string().max(500_000).optional(), error: z.string().max(1000).optional(), data: z.unknown().optional() });
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const stripDescriptions = (key, value) => ['description', '$schema', 'additionalProperties'].includes(key) ? undefined : value;
const compactTool = tool => {
  const entry = { name: tool.function.name };
  if (tool.function.description) entry.description = tool.function.description.trim().split(/\r?\n/)[0].slice(0, 160);
  if (tool.function.parameters) entry.parameters = JSON.parse(JSON.stringify(tool.function.parameters, stripDescriptions));
  return entry;
};

export function buildWebsitePrompt(body) {
  const request = requestSchema.parse(body);
  if (JSON.stringify(request.messages).length > 300_000) throw fail('This website account request exceeds the local bridge context limit. Shorten or compact the conversation.', 413);
  const tools = request.tools ?? [];
  const messages = request.messages.map(msg => (msg.role === 'system' || msg.role === 'developer') && msg.content && msg.content.length > 7000
    ? { ...msg, content: msg.content.slice(0, 5200) + '\n...\n' + msg.content.slice(-1600) }
    : msg);
  const instructions = [
    'Continue the following conversation for its native chat client. Reply as the assistant to the latest turn. Follow your normal safety rules.',
    'The transcript below contains role-labeled messages and any tool results already supplied by the client. Never claim a tool ran unless its result is present.',
    tools.length ? 'If a client tool is needed, reply with ONLY a JSON object of this exact shape: {"tool_calls":[{"name":"listed_tool_name","arguments":{}}]}. The client applies its normal permissions before executing a tool. Otherwise reply normally. These are the available client tools:\n' + JSON.stringify(tools.map(compactTool)) : 'Reply normally. No client tools are available for this request.',
    'CONVERSATION TRANSCRIPT\n' + JSON.stringify(messages),
  ].join('\n\n');
  if (instructions.length > 300_000) throw fail('This website account request exceeds the local bridge context limit. Shorten or compact the conversation.', 413);
  return { request, prompt: instructions };
}

const toolCallsSchema = z.object({ tool_calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })).min(1).max(8) });
const toolMessage = (parsed, tools, content) => {
  const allowed = new Set(tools.map(tool => tool.function.name));
  if (parsed.tool_calls.some(call => !allowed.has(call.name))) throw fail('The website requested a tool that was not offered. No tool was executed.', 422);
  return { role: 'assistant', content: content || null, tool_calls: parsed.tool_calls.map(call => ({ id: 'call_' + crypto.randomUUID().replaceAll('-', ''), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
};

export function websiteReplyMessage(text, tools = []) {
  const trimmed = text.trim();
  const json = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let candidate;
  try { candidate = JSON.parse(json); } catch { candidate = undefined; }
  if (candidate && Object.hasOwn(candidate, 'tool_calls')) {
    const parsed = toolCallsSchema.safeParse(candidate);
    if (!parsed.success) throw fail('The website returned an invalid tool request. No tool was executed.', 422);
    return toolMessage(parsed.data, tools, '');
  }
  // Models sometimes add a sentence before the JSON. Accept a trailing tool request.
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?"tool_calls"[\s\S]*\})\s*```\s*$/i);
  const start = fenced ? fenced.index : trimmed.lastIndexOf('{"tool_calls"');
  const body = fenced ? fenced[1] : start >= 0 && trimmed.endsWith('}') ? trimmed.slice(start) : null;
  if (body !== null) {
    let tail; try { tail = JSON.parse(body); } catch { tail = undefined; }
    const parsed = tail ? toolCallsSchema.safeParse(tail) : null;
    if (parsed?.success) return toolMessage(parsed.data, tools, trimmed.slice(0, start).trim());
  }
  return { role: 'assistant', content: text };
}

const TOOL_MARK = '{"tool_calls"';
const FENCED_MARK = '```json\n{"tool_calls"';
/** How much of a still-growing reply is safe to show: never a tool request or
 * the start of one, which only becomes a real tool call once it is complete. */
export function streamableLength(text, hasTools) {
  if (!hasTools) return text.length;
  const mark = text.indexOf('"tool_calls"');
  if (mark >= 0) {
    const brace = text.lastIndexOf('{', mark);
    let end = brace >= 0 ? brace : mark;
    const fence = text.lastIndexOf('```', end);
    if (fence >= 0 && /^```(?:json)?\s*$/i.test(text.slice(fence, end))) end = fence;
    return end;
  }
  for (let n = Math.min(text.length, FENCED_MARK.length); n > 0; n--) {
    const tail = text.slice(-n);
    if (TOOL_MARK.startsWith(tail) || FENCED_MARK.startsWith(tail)) return text.length - n;
  }
  return text.length;
}

/** One ordinary OpenCode model request, delivered to exactly one local renderer.
 * Requests start a fresh website turn with the full native transcript, so no
 * website conversation is guessed or shared between native sessions.
 * The same worker also reads each account's usage and model list.
 */
export function createWebsiteModelsRuntime({ enabled = false, blocked = isEnterpriseMode, timeoutMs = 240_000, catalogFile = null } = {}) {
  let closed = false;
  const jobs = new Map();
  const waiters = new Set();
  const active = new Set();
  const recent = [];
  let lastWorkerSeen = 0;
  let catalog = readCatalogFile(catalogFile);
  let catalogTimer = null;
  let catalogRefreshedAt = 0;
  const WORKER_GRACE_MS = 15_000;
  const armWorkerTimer = job => {
    clearTimeout(job.workerTimer);
    job.workerTimer = setTimeout(() => settle(job, fail('The local website account worker disconnected. No retry was made.')), WORKER_GRACE_MS);
  };
  const settle = (job, error, value) => {
    if (!jobs.delete(job.id)) return;
    clearTimeout(job.timer); clearTimeout(job.workerTimer); active.delete(job.provider);
    recent.push({ provider: job.provider, kind: job.kind, phase: job.phase, inputCharacters: job.prompt.length, elapsedMs: Date.now() - job.startedAt, outcome: error ? 'failed' : 'completed', ...(error && job.kind !== 'chat' ? { reason: String(error.message ?? error).slice(0, 160) } : {}) });
    if (recent.length > 8) recent.shift();
    if (error) job.reject(error); else job.resolve(value);
    for (const waiter of [...waiters]) waiter.wake();
  };
  const nextJob = () => {
    const job = [...jobs.values()].find(row => !row.lease && !active.has(row.provider));
    if (!job) return null;
    active.add(job.provider); job.lease = crypto.randomUUID();
    armWorkerTimer(job);
    return { id: job.id, lease: job.lease, provider: job.provider, kind: job.kind, prompt: job.prompt, model: job.model };
  };
  const workerConnected = () => Date.now() - lastWorkerSeen <= 45_000;
  /** Usage and model-list reads share the chat worker; they never send a message. */
  const runAux = (provider, kind, limitMs = 60_000) => new Promise((resolve, reject) => {
    if (!workerConnected()) { reject(fail('Open Carter’s website account bridge is not connected. Open the app on this Mac and retry.')); return; }
    const job = { id: crypto.randomUUID(), kind, provider, prompt: '', model: null, resolve, reject, lease: null, timer: null, startedAt: Date.now(), phase: 'queued' };
    jobs.set(job.id, job);
    job.timer = setTimeout(() => settle(job, fail('The website did not answer in time.', 422)), limitMs);
    for (const waiter of [...waiters]) waiter.wake();
  });
  const refreshCatalog = async () => {
    for (const provider of ['venice', 'gemini']) {
      try {
        const data = z.object({ names: z.array(z.string()).max(300), paid: z.array(z.string()).max(300).optional() }).parse(await runAux(provider, 'models'));
        const next = catalogFromNames(provider, data.names, catalog, data.paid ?? []);
        if (next !== catalog) { catalog = next; writeCatalogFile(catalogFile, catalog); }
      } catch { /* Keep the saved list; the next launch tries again. */ }
    }
    catalogRefreshedAt = Date.now();
  };
  const scheduleCatalogRefresh = () => {
    if (closed || catalogTimer || Date.now() - catalogRefreshedAt < 6 * 3600_000) return;
    catalogTimer = setTimeout(() => { void refreshCatalog().finally(() => { catalogTimer = null; }); }, 20_000);
  };
  if (enabled) setWebsiteUsageRequester(provider => runAux(provider, 'usage', 60_000));
  const modelLabel = (provider, id) => {
    if (id === 'website') return null;
    const entry = catalog[provider]?.find(item => item.id === id);
    if (!entry) throw fail('That model is no longer offered by this website account. Pick another model.', 422);
    return entry.name;
  };
  const permitted = req => enabled && !closed && !blocked() && loopback(req.socket?.remoteAddress);
  const providers = childEnv => {
    if (!enabled || closed || blocked() || !childEnv?.OPENCHAMBER_AGENT_TOOL_URL || !childEnv?.OPENCHAMBER_AGENT_TOOL_TOKEN) return {};
    const endpoint = new URL(childEnv.OPENCHAMBER_AGENT_TOOL_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) return {};
    const model = (id, name) => [id, { modelID: id, name, capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 65536, output: 8192 } }];
    return Object.fromEntries(['venice', 'gemini'].map(provider => ['opencarter-' + provider + '-website', {
      name: provider === 'venice' ? 'Venice website · free account' : 'Gemini website · Google account',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: endpoint.origin + '/api/openchamber/website-models/' + provider + '/v1', apiKey: childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN },
      models: Object.fromEntries([
        model('website', provider === 'venice' ? 'Venice website account (site default)' : 'Gemini website account (site default)'),
        ...catalog[provider].map(entry => model(entry.id, (provider === 'gemini' ? 'Gemini ' + entry.name : entry.name) + (entry.paid ? ' · uses credits' : ''))),
      ]),
    }]));
  };
  const registerCompletionRoutes = (app, { express, authorizeRequest }) => {
    app.post('/api/openchamber/website-models/:provider/v1/chat/completions', express.json({ limit: '2mb' }), async (req, res) => {
      if (!permitted(req)) return res.status(403).json({ error: { message: 'Website account providers are available only on this Mac, outside enterprise mode.' } });
      if (!authorizeRequest(req)) return res.status(401).json({ error: { message: 'Unauthorized website account request.' } });
      if (!['venice', 'gemini'].includes(req.params.provider)) return res.status(404).end();
      let job, started = false, sent = 0;
      try {
        const { request, prompt } = buildWebsitePrompt(req.body);
        const label = modelLabel(req.params.provider, request.model);
        // Counts only: never log prompts, replies, headers or account details.
        console.info('[website-models] request', { provider: req.params.provider, model: request.model, inputCharacters: prompt.length, toolCount: request.tools?.length ?? 0 });
        if (!workerConnected()) throw fail('Open Carter’s website account bridge is not connected. Open the app on this Mac and retry.');
        if (jobs.size >= 8) throw fail('The website accounts are busy. Wait for a current reply before retrying.', 409);
        const hasTools = (request.tools?.length ?? 0) > 0;
        const created = Math.floor(Date.now() / 1000);
        const reply = new Promise((resolve, reject) => {
          job = { id: crypto.randomUUID(), kind: 'chat', provider: req.params.provider, model: label, prompt, resolve, reject, lease: null, timer: null, startedAt: Date.now(), phase: 'queued' };
          jobs.set(job.id, job);
          job.timer = setTimeout(() => settle(job, fail('The website did not finish in time. Check its account connection before retrying.', 422)), timeoutMs);
        });
        const id = 'chatcmpl-' + job.id;
        const send = (delta, reason = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n');
        const begin = () => {
          if (started) return;
          started = true;
          res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.flushHeaders?.();
          send({ role: 'assistant' });
        };
        // Show the reply as the website writes it. Tool requests are held back until complete.
        if (request.stream) job.onPartial = text => {
          if (req.params.provider === 'gemini' && /^sorry,?\s+something went wrong/i.test(text.trim())) return;
          const end = streamableLength(text, hasTools);
          if (end > sent) { begin(); send({ content: text.slice(sent, end) }); sent = end; }
        };
        const abort = () => { if (!res.writableEnded) settle(job, fail('Website account request cancelled.', 499)); };
        res.once('close', abort);
        for (const waiter of [...waiters]) waiter.wake();

        try {
          const text = await reply;
          console.info('[website-models] reply', { provider: req.params.provider, outputCharacters: text.length });
          const message = websiteReplyMessage(text, request.tools ?? []);
          const finish = message.tool_calls ? 'tool_calls' : 'stop';
          if (!request.stream) return res.json({ id, object: 'chat.completion', created, model: request.model, choices: [{ index: 0, message, finish_reason: finish }] });
          begin();
          const shown = text.slice(0, sent), body = message.content ?? '';
          if (body.length > sent && body.startsWith(shown)) send({ content: body.slice(sent) });
          if (message.tool_calls) send({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) });
          send({}, finish); res.end('data: [DONE]\n\n');
        } finally { res.off('close', abort); }
      } catch (error) {
        if (job) settle(job, error);
        const message = error instanceof z.ZodError ? 'The website account bridge supports text conversation requests only.' : error.message || 'Website account request failed.';
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
        else res.status(error.status || 400).json({ error: { message, type: 'website_account_error' } });
      }
    });
  };
  const registerWorkerRoutes = (app, { express }) => {
    app.get('/api/openchamber/website-models/jobs/next', async (req, res) => {
      if (!permitted(req)) return res.status(403).end();
      lastWorkerSeen = Date.now();
      scheduleCatalogRefresh();
      let finish;
      const close = () => { if (finish) finish(null); };
      const result = await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => finish(null), 25_000);
        const wake = () => { const job = nextJob(); if (job) finish(job); };
        finish = value => { if (done) return; done = true; clearTimeout(timer); waiters.delete(waiter); req.off('aborted', close); res.off('close', close); resolve(value); };
        const waiter = { wake, cancel: () => finish(null) };
        req.once('aborted', close); res.once('close', close); waiters.add(waiter); wake();
      });
      if (res.destroyed) return;
      if (!result) return res.status(204).end();
      res.json(result);
    });
    app.post('/api/openchamber/website-models/jobs/result', express.json({ limit: '1mb' }), (req, res) => {
      if (!permitted(req)) return res.status(403).end();
      const parsed = resultSchema.safeParse(req.body); if (!parsed.success) return res.status(400).end();
      const result = parsed.data, job = jobs.get(result.id);
      if (!job || job.lease !== result.lease) return res.json({ accepted: false });
      if (result.error) settle(job, fail(result.error, 422));
      else if (job.kind !== 'chat') {
        if (result.data === undefined) return res.status(400).json({ error: 'No data was received.' });
        settle(job, null, result.data);
      }
      else if (result.text?.trim()) {
        if (job.provider === 'gemini' && /^Sorry,\s*something went wrong\.\s*Please try your request again\.?$/i.test(result.text.trim())) settle(job, fail('Gemini returned its website error. Confirm a normal message works in its account connection before retrying.', 422));
        else settle(job, null, result.text);
      }
      else return res.status(400).json({ error: 'No website reply was received.' });
      res.json({ accepted: true });
    });
    app.get('/api/openchamber/website-models/jobs/status', (req, res) => {
      if (!permitted(req)) return res.status(403).end();
      res.json({ pending: [...jobs.values()].map(job => ({ provider: job.provider, kind: job.kind, model: job.model, phase: job.phase, inputCharacters: job.prompt.length, elapsedMs: Date.now() - job.startedAt })), recent });
    });
    app.post('/api/openchamber/website-models/jobs/check', express.json({ limit: '1mb' }), (req, res) => {
      if (!permitted(req)) return res.status(403).end();
      lastWorkerSeen = Date.now();
      const parsed = resultSchema.extend({ phase: z.enum(['loading', 'selecting-model', 'sending', 'reading', 'waiting-for-page', 'waiting-for-message', 'waiting-for-answer']).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).end();
      const job = jobs.get(parsed.data.id);
      const live = Boolean(job && job.lease === parsed.data.lease);
      if (live) {
        job.phase = parsed.data.phase ?? job.phase; armWorkerTimer(job);
        // The website's partial reply, so the native chat can show it as it is written.
        if (typeof parsed.data.text === 'string' && job.onPartial) { try { job.onPartial(parsed.data.text); } catch { /* A broken stream is settled by the request itself. */ } }
      }
      res.json({ active: live });
    });
  };
  const close = () => { closed = true; clearTimeout(catalogTimer); setWebsiteUsageRequester(null); for (const job of jobs.values()) settle(job, fail('Website account bridge stopped.')); for (const waiter of [...waiters]) waiter.cancel(); };
  return { providers, registerCompletionRoutes, registerWorkerRoutes, close, get pendingCount() { return jobs.size; }, get workerCount() { return waiters.size; }, get catalog() { return catalog; }, requestUsage: provider => runAux(provider, 'usage') };
}
