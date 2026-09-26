import { z } from 'zod';

/**
 * Chat for the standalone iPhone app. The phone cannot run OpenCode, so it talks to
 * OpenAI-compatible chat endpoints directly: OpenCode Zen (Big Pickle, GLM and the other
 * free models), OpenRouter, and OpenRouter with zero data retention.
 */

export type ProviderID = 'zen' | 'openrouter' | 'openrouter-zdr';

export interface ChatProvider {
  id: ProviderID;
  name: string;
  baseURL: string;
  extraBody?: { provider: { zdr: boolean } };
  keyHint: string;
}

export const chatProviders: readonly ChatProvider[] = [
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', keyHint: 'Starts with sk-or-. Models ending in (free) cost nothing.' },
  { id: 'zen', name: 'OpenCode Zen', baseURL: 'https://opencode.ai/zen/v1', keyHint: 'Your Zen key from opencode.ai. Zen\'s no-key free tier only works inside OpenCode.' },
  { id: 'openrouter-zdr', name: 'OpenRouter ZDR', baseURL: 'https://openrouter.ai/api/v1', extraBody: { provider: { zdr: true } }, keyHint: 'Your OpenRouter ZDR key (can be the same key).' },
];

export interface ChatModel { provider: ProviderID; id: string; name: string }

/**
 * Built-in picks. OpenRouter's ":free" models cost nothing with your OpenRouter key. Zen models need a
 * Zen key: OpenCode Zen refuses its no-key free tier outside the OpenCode app.
 */
export const defaultModels: readonly ChatModel[] = [
  { provider: 'openrouter', id: 'z-ai/glm-5.2:free', name: 'GLM 5.2 (free)' },
  { provider: 'zen', id: 'big-pickle', name: 'Big Pickle' },
  { provider: 'zen', id: 'glm-5-free', name: 'GLM 5 (free)' },
  { provider: 'zen', id: 'glm-4.7-free', name: 'GLM 4.7 (free)' },
  { provider: 'zen', id: 'kimi-k2.5-free', name: 'Kimi K2.5 (free)' },
  { provider: 'zen', id: 'minimax-m2.5-free', name: 'MiniMax M2.5 (free)' },
  { provider: 'zen', id: 'qwen3.6-plus-free', name: 'Qwen 3.6 Plus (free)' },
  { provider: 'zen', id: 'glm-5.3', name: 'GLM 5.3' },
  { provider: 'openrouter', id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
  { provider: 'openrouter-zdr', id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5 (ZDR)' },
  { provider: 'openrouter-zdr', id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (ZDR)' },
];

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

const listSchema = z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional() })) });
const chunkSchema = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }).partial().optional() })).optional() });
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })) });
const errorSchema = z.object({ error: z.union([z.string(), z.object({ message: z.string() }).transform((e) => e.message)]) });

export function providerByID(id: ProviderID): ChatProvider {
  return chatProviders.find((p) => p.id === id) ?? chatProviders[0];
}

function authKey(provider: ChatProvider, key: string | undefined): string {
  const trimmed = key?.trim();
  if (trimmed) return trimmed;
  throw new Error(`Add your ${provider.name} key in Settings first.`);
}

function errorText(status: number, body: string): string {
  try {
    const parsed = errorSchema.safeParse(JSON.parse(body));
    if (parsed.success) return `${status}: ${parsed.data.error}`;
  } catch { /* not JSON */ }
  return `${status}: ${body.slice(0, 200) || 'Request failed'}`;
}

/** Reads text out of an OpenAI-style server-sent event stream as it arrives. */
export function createStreamParser(onText: (text: string) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = chunkSchema.safeParse(JSON.parse(data));
        const text = parsed.success ? parsed.data.choices?.[0]?.delta?.content : undefined;
        if (text) onText(text);
      } catch { /* keep-alive or partial line */ }
    }
  };
}

type NativePost = (url: string, headers: Map<string, string>, body: string) => Promise<{ status: number; data: string }>;

export async function sendChat({ model, messages, key, signal, onText, nativePost }: {
  model: ChatModel; messages: ChatMessage[]; key: string | undefined; signal: AbortSignal; onText: (text: string) => void; nativePost?: NativePost;
}): Promise<void> {
  const provider = providerByID(model.provider);
  const headers = new Map<string, string>([
    ['Authorization', `Bearer ${authKey(provider, key)}`],
    ['Content-Type', 'application/json'],
    ['HTTP-Referer', 'https://github.com/Crtr999/openchamber-folio'],
    ['X-Title', 'Folio'],
  ]);
  const url = `${provider.baseURL}/chat/completions`;
  const payload = { model: model.id, messages, ...provider.extraBody };
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: Object.fromEntries(headers), body: JSON.stringify({ ...payload, stream: true }), signal });
  } catch (error) {
    if (signal.aborted || !nativePost) throw error;
    // Some providers block requests from inside the app's web view (CORS); send it natively instead, without streaming.
    const native = await nativePost(url, headers, JSON.stringify({ ...payload, stream: false }));
    if (native.status < 200 || native.status >= 300) throw new Error(errorText(native.status, native.data));
    const done = completionSchema.parse(JSON.parse(native.data));
    onText(done.choices[0]?.message.content ?? '');
    return;
  }
  if (!response.ok || !response.body) throw new Error(errorText(response.status, await response.text()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createStreamParser(onText);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parse(decoder.decode(value, { stream: true }));
  }
  parse('\n');
}

export async function listModels(providerID: ProviderID, key: string | undefined, nativeGet?: (url: string, headers: Map<string, string>) => Promise<{ status: number; data: string }>): Promise<ChatModel[]> {
  const provider = providerByID(providerID);
  const url = `${provider.baseURL}/models`;
  const headers = new Map([['Authorization', `Bearer ${authKey(provider, key)}`]]);
  let status: number; let body: string;
  try {
    const response = await fetch(url, { headers: Object.fromEntries(headers) });
    status = response.status; body = await response.text();
  } catch (error) {
    if (!nativeGet) throw error;
    ({ status, data: body } = await nativeGet(url, headers));
  }
  if (status < 200 || status >= 300) throw new Error(errorText(status, body));
  return listSchema.parse(JSON.parse(body)).data.map((m) => ({ provider: providerID, id: m.id, name: m.name ?? m.id }));
}

/* ------------------------------------------------------------------------------------------------
 * Agent: the same chat, but the model may call Folio tools (search, read and write notes, calendar)
 * and, on OpenRouter, search the web. Tool calls use the OpenAI-compatible "tools" format.
 * --------------------------------------------------------------------------------------------- */

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface JsonSchemaProperty { type: 'string' | 'number'; description: string }
export interface AgentTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: { [field: string]: JsonSchemaProperty }; required: string[] };
  /** Short line shown in the chat while and after the tool runs, e.g. "Read “Trip plan”". */
  label: (args: string) => string;
  run: (args: string) => Promise<string>;
}

const toolDeltaSchema = z.object({ index: z.number(), id: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).partial().optional() });
const agentChunkSchema = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullish(), tool_calls: z.array(toolDeltaSchema).nullish() }).partial().optional() })).optional() });
const agentCompletionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullish(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).nullish() }) })) });

interface AgentPayload {
  model: string;
  messages: WireMessage[];
  provider?: { zdr: boolean };
  tools?: { type: 'function'; function: { name: string; description: string; parameters: AgentTool['parameters'] } }[];
  plugins?: { id: 'web'; max_results: number }[];
}

/** Whether the provider can add live web results (OpenRouter's web plugin; it bills a small search fee to the key). */
export const supportsWeb = (model: ChatModel) => model.provider !== 'zen';

async function agentTurn({ model, messages, key, signal, onText, nativePost, tools, web }: {
  model: ChatModel; messages: WireMessage[]; key: string | undefined; signal: AbortSignal; onText: (text: string) => void;
  nativePost?: NativePost; tools: readonly AgentTool[]; web: boolean;
}): Promise<{ text: string; calls: ToolCall[] }> {
  const provider = providerByID(model.provider);
  const headers = new Map<string, string>([
    ['Authorization', `Bearer ${authKey(provider, key)}`],
    ['Content-Type', 'application/json'],
    ['HTTP-Referer', 'https://github.com/Crtr999/openchamber-folio'],
    ['X-Title', 'Folio'],
  ]);
  const url = `${provider.baseURL}/chat/completions`;
  const payload: AgentPayload = { model: model.id, messages, ...provider.extraBody };
  if (tools.length) payload.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (web && supportsWeb(model)) payload.plugins = [{ id: 'web', max_results: 5 }];
  let text = '';
  const calls: ToolCall[] = [];
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: Object.fromEntries(headers), body: JSON.stringify({ ...payload, stream: true }), signal });
  } catch (error) {
    if (signal.aborted || !nativePost) throw error;
    const native = await nativePost(url, headers, JSON.stringify({ ...payload, stream: false }));
    if (native.status < 200 || native.status >= 300) throw new Error(errorText(native.status, native.data));
    const message = agentCompletionSchema.parse(JSON.parse(native.data)).choices[0]?.message;
    text = message?.content ?? '';
    if (text) onText(text);
    for (const call of message?.tool_calls ?? []) calls.push({ id: call.id, type: 'function', function: call.function });
    return { text, calls };
  }
  if (!response.ok || !response.body) throw new Error(errorText(response.status, await response.text()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line: string) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') return;
    try {
      const parsed = agentChunkSchema.safeParse(JSON.parse(data));
      const delta = parsed.success ? parsed.data.choices?.[0]?.delta : undefined;
      if (delta?.content) { text += delta.content; onText(delta.content); }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls[part.index] ?? (calls[part.index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    } catch { /* keep-alive or partial line */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(take);
  }
  take(buffer);
  return { text, calls: calls.filter((c) => c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` })) };
}

const toolRefusal = /tool|function/i;

/**
 * Runs the conversation, letting the model call tools until it answers (at most eight rounds).
 * Models that do not take tools get the same request without them. Returns the final reply text.
 */
export async function runAgent({ model, messages, key, signal, onText, onTool, nativePost, tools, web }: {
  model: ChatModel; messages: WireMessage[]; key: string | undefined; signal: AbortSignal;
  onText: (text: string) => void; onTool: (label: string, name: string) => void;
  nativePost?: NativePost; tools: readonly AgentTool[]; web: boolean;
}): Promise<string> {
  const history = messages.slice();
  let offered = tools;
  for (let round = 0; round < 8; round += 1) {
    let turn: { text: string; calls: ToolCall[] };
    try {
      // Web results are fetched once per question (each search is billed), on the first round.
      turn = await agentTurn({ model, messages: history, key, signal, onText, nativePost, tools: offered, web: web && round === 0 });
    } catch (error) {
      if (!offered.length || signal.aborted || !(error instanceof Error) || !toolRefusal.test(error.message) || !/^4\d\d/.test(error.message)) throw error;
      offered = [];
      continue;
    }
    if (!turn.calls.length) return turn.text;
    history.push({ role: 'assistant', content: turn.text || null, tool_calls: turn.calls });
    if (turn.text) onText('\n\n');
    for (const call of turn.calls) {
      const tool = offered.find((t) => t.name === call.function.name);
      onTool(tool ? tool.label(call.function.arguments) : call.function.name, call.function.name);
      let result: string;
      try { result = tool ? await tool.run(call.function.arguments) : `There is no tool named ${call.function.name}.`; }
      catch (error) { result = `The tool failed: ${error instanceof Error ? error.message : String(error)}`; }
      history.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 40_000) });
    }
    if (signal.aborted) return '';
  }
  // Out of rounds: ask for an answer with what it has.
  return (await agentTurn({ model, messages: history, key, signal, onText, nativePost, tools: [], web: false })).text;
}
