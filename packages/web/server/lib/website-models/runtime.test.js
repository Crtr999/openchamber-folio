import { afterEach, expect, test, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { createWebsiteModelsRuntime, buildWebsitePrompt, streamableLength, websiteReplyMessage } from './runtime.js';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const start = async (options = {}) => {
  const runtime = createWebsiteModelsRuntime({ enabled: true, ...options });
  const app = express();
  runtime.registerCompletionRoutes(app, { express, authorizeRequest: req => req.headers.authorization === 'Bearer local-fixture' });
  app.use((req, res, next) => req.headers['x-fixture-ui'] === 'yes' ? next() : res.sendStatus(401));
  runtime.registerWorkerRoutes(app, { express });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  cleanups.push(async () => { runtime.close(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); });
  const native = (body, signal) => fetch(origin + '/api/openchamber/website-models/venice/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer local-fixture' }, body: JSON.stringify(body), signal });
  const worker = () => fetch(origin + '/api/openchamber/website-models/jobs/next', { headers: { 'x-fixture-ui': 'yes' } });
  const result = body => fetch(origin + '/api/openchamber/website-models/jobs/result', { method: 'POST', headers: { 'x-fixture-ui': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { runtime, native, worker, result, origin };
};
const request = { model: 'website', messages: [{ role: 'user', content: 'Hello' }] };
test('website models are desktop-only, loopback-only and gated at use time', () => {
  let blocked = false; const runtime = createWebsiteModelsRuntime({ enabled: true, blocked: () => blocked });
  const env = { OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3000/api/openchamber/agent-tool', OPENCHAMBER_AGENT_TOOL_TOKEN: 'local-fixture' };
  const providers = runtime.providers(env);
  expect(Object.keys(providers)).toEqual(['opencarter-venice-website', 'opencarter-gemini-website']);
  expect(providers['opencarter-venice-website'].settings.baseURL).toBe('http://127.0.0.1:3000/api/openchamber/website-models/venice/v1');
  expect(providers['opencarter-venice-website'].models.website.limit).toEqual({ context: 65536, output: 8192 });
  expect(runtime.providers({ ...env, OPENCHAMBER_AGENT_TOOL_URL: 'https://outside.example/api/agent-tool' })).toEqual({});
  blocked = true; expect(runtime.providers(env)).toEqual({});
  expect(createWebsiteModelsRuntime().providers(env)).toEqual({});
});
test('prompt includes native context, compacts verbose tool manuals, and rejects unsupported or excessive inputs', () => {
  expect(buildWebsitePrompt(request).prompt).toContain('Hello');
  const verbose = buildWebsitePrompt({
    model: 'website',
    messages: [{ role: 'system', content: 'S'.repeat(10_000) }, { role: 'user', content: 'Hello' }],
    tools: [{ type: 'function', function: { name: 'computer.status', description: 'First line summary\n' + 'D'.repeat(5000), parameters: { type: 'object', description: 'strip me', properties: { path: { type: 'string', description: 'strip nested' } } } } }],
  }).prompt;
  expect(verbose.length).toBeLessThan(9000);
  expect(verbose.length).toBeGreaterThan(5000);
  expect(verbose).toContain('First line summary');
  expect(verbose).not.toContain('strip nested');
  expect(() => buildWebsitePrompt({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a' } }] }] })).toThrow();
  expect(() => buildWebsitePrompt({ ...request, messages: [{ role: 'user', content: 'a'.repeat(300_001) }] })).toThrow();
});
test('tool replies are mapped only for offered tools and never executed here', () => {
  const tools = [{ type: 'function', function: { name: 'computer.status' } }];
  expect(websiteReplyMessage('4')).toEqual({ role: 'assistant', content: '4' });
  const message = websiteReplyMessage('```json\n{"tool_calls":[{"name":"computer.status","arguments":{}}]}\n```', tools);
  expect(message.tool_calls[0].function).toEqual({ name: 'computer.status', arguments: '{}' });
  expect(() => websiteReplyMessage('{"tool_calls":[{"name":"shell","arguments":{}}]}', tools)).toThrow('not offered');
  expect(() => websiteReplyMessage('{"tool_calls":[{"name":"computer.status","arguments":"bad"}]}', tools)).toThrow('invalid');
});
test('native completion requires child authentication and an available worker', async () => {
  const h = await start();
  expect((await fetch(h.origin + '/api/openchamber/website-models/venice/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
  const absent = await h.native(request); expect(absent.status).toBe(422); expect(h.runtime.pendingCount).toBe(0);
  expect((await fetch(h.origin + '/api/openchamber/website-models/jobs/next')).status).toBe(401);
});
test('one worker claims a native turn and returns an ordinary native completion', async () => {
  const h = await start(); const waiting = h.worker();
  await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(request); const job = await (await waiting).json();
  expect(job.provider).toBe('venice'); expect(job.prompt).toContain('Hello');
  expect((await h.result({ id: job.id, lease: '00000000-0000-4000-8000-000000000000', text: 'wrong owner' })).status).toBe(200);
  expect(h.runtime.pendingCount).toBe(1);
  await h.result({ id: job.id, lease: job.lease, text: 'Native reply' });
  const response = await completion; expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message).toEqual({ role: 'assistant', content: 'Native reply' });
  expect(h.runtime.pendingCount).toBe(0);
});
test('stream completion preserves the normal SDK tool-call format', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const tools = [{ type: 'function', function: { name: 'computer.status', parameters: { type: 'object' } } }];
  const completion = h.native({ ...request, stream: true, tools }); const job = await (await waiting).json();
  await h.result({ id: job.id, lease: job.lease, text: '{"tool_calls":[{"name":"computer.status","arguments":{}}]}' });
  const response = await completion, stream = await response.text();
  expect(response.headers.get('content-type')).toContain('text/event-stream'); expect(stream).toContain('"finish_reason":"tool_calls"'); expect(stream).toContain('computer.status'); expect(stream).toContain('[DONE]');
});
test('abort and provider failure settle once without an automatic external retry', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const controller = new AbortController(); const cancelled = h.native(request, controller.signal).catch(() => null); const job = await (await waiting).json();
  controller.abort(); await cancelled; await vi.waitFor(() => expect(h.runtime.pendingCount).toBe(0));
  expect(await (await h.result({ id: job.id, lease: job.lease, text: 'late' })).json()).toEqual({ accepted: false });
  const next = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(request); const second = await (await next).json(); await h.result({ id: second.id, lease: second.lease, error: 'Website limit reached' });
  expect((await completion).status).toBe(422); expect(h.runtime.pendingCount).toBe(0);
});
test('bridge diagnostics expose counts and phases, never prompts or leases', async () => {
  const h = await start();
  expect((await fetch(h.origin + '/api/openchamber/website-models/jobs/status')).status).toBe(401);
  const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(request); const job = await (await waiting).json();
  await fetch(h.origin + '/api/openchamber/website-models/jobs/check', { method: 'POST', headers: { 'x-fixture-ui': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, lease: job.lease, phase: 'waiting-for-message' }) });
  const snapshot = await (await fetch(h.origin + '/api/openchamber/website-models/jobs/status', { headers: { 'x-fixture-ui': 'yes' } })).json();
  expect(snapshot.pending[0].phase).toBe('waiting-for-message');
  expect(JSON.stringify(snapshot)).not.toContain('Hello'); expect(JSON.stringify(snapshot)).not.toContain(job.lease);
  await h.result({ id: job.id, lease: job.lease, text: 'Done' }); await completion;
});
test('a delayed website failure remains HTTP 422 instead of a successful empty stream', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native({ ...request, stream: true }); const job = await (await waiting).json();
  await new Promise(resolve => setTimeout(resolve, 12_100));
  await h.result({ id: job.id, lease: job.lease, error: 'Website unavailable' });
  expect((await completion).status).toBe(422);
}, 20_000);
test('Gemini website error is a failed provider request, not a fabricated assistant answer', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = fetch(h.origin + '/api/openchamber/website-models/gemini/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer local-fixture' }, body: JSON.stringify(request) });
  const job = await (await waiting).json();
  await h.result({ id: job.id, lease: job.lease, text: 'Sorry, something went wrong. Please try your request again.' });
  expect((await completion).status).toBe(422);
});

const check = (h, body) => fetch(h.origin + '/api/openchamber/website-models/jobs/check', { method: 'POST', headers: { 'x-fixture-ui': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('a streamed reply reaches the native chat while the website is still writing it', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native({ ...request, stream: true });
  const job = await (await waiting).json();
  await check(h, { id: job.id, lease: job.lease, phase: 'waiting-for-answer', text: 'The answer ' });
  const response = await completion; expect(response.status).toBe(200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let seen = ''; const readUntil = async needle => { while (!seen.includes(needle)) { const { value, done } = await reader.read(); if (done) break; seen += decoder.decode(value); } };
  await readUntil('The answer ');
  expect(seen).toContain('"content":"The answer "');
  await check(h, { id: job.id, lease: job.lease, text: 'The answer is 42.' });
  await readUntil('is 42.');
  await h.result({ id: job.id, lease: job.lease, text: 'The answer is 42.' });
  await readUntil('[DONE]');
  const text = [...seen.matchAll(/"content":"([^"]*)"/g)].map(match => match[1]).join('');
  expect(text).toBe('The answer is 42.');
});
test('a tool request is never streamed as text and still becomes a tool call', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const tools = [{ type: 'function', function: { name: 'computer.status', parameters: { type: 'object' } } }];
  const completion = h.native({ ...request, stream: true, tools }); const job = await (await waiting).json();
  await check(h, { id: job.id, lease: job.lease, text: '{"tool_ca' });
  await check(h, { id: job.id, lease: job.lease, text: '{"tool_calls":[{"name":"computer.status","argu' });
  await h.result({ id: job.id, lease: job.lease, text: '{"tool_calls":[{"name":"computer.status","arguments":{}}]}' });
  const stream = await (await completion).text();
  expect(stream).not.toContain('tool_ca"');
  expect(stream).not.toMatch(/"content":"\{/);
  expect(stream).toContain('"finish_reason":"tool_calls"');
  expect(stream).toContain('computer.status');
});
test('streamable length holds back only what could be a tool request', () => {
  expect(streamableLength('Hello there', false)).toBe(11);
  expect(streamableLength('Hello there', true)).toBe(11);
  expect(streamableLength('Let me check. {"tool_', true)).toBe('Let me check. '.length);
  expect(streamableLength('Let me check.\n```json\n{"tool_calls":[{"na', true)).toBe('Let me check.\n'.length);
  expect(streamableLength('{"tool_calls":[{}]}', true)).toBe(0);
  expect(streamableLength('Use `code` here', true)).toBe('Use `code` here'.length);
});
test('a sentence before a tool request still maps to a tool call', () => {
  const tools = [{ type: 'function', function: { name: 'computer.status' } }];
  const message = websiteReplyMessage('I will check that now.\n{"tool_calls":[{"name":"computer.status","arguments":{}}]}', tools);
  expect(message.content).toBe('I will check that now.'); expect(message.tool_calls).toHaveLength(1);
  expect(websiteReplyMessage('Plain {"note": 1} text', tools)).toEqual({ role: 'assistant', content: 'Plain {"note": 1} text' });
});
test('the chosen website model reaches the worker, and unknown models are refused', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native({ ...request, model: 'claude-opus-5' }); const job = await (await waiting).json();
  expect(job.model).toBe('Claude Opus 5'); expect(job.kind).toBe('chat');
  await h.result({ id: job.id, lease: job.lease, text: 'ok' }); await completion;
  const refused = await h.native({ ...request, model: 'not-a-model' });
  expect(refused.status).toBe(422);
});
test('provider models come from the saved catalog with credit-only models marked', () => {
  const runtime = createWebsiteModelsRuntime({ enabled: true });
  const env = { OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3000/api/openchamber/agent-tool', OPENCHAMBER_AGENT_TOOL_TOKEN: 'local-fixture' };
  const providers = runtime.providers(env);
  const venice = providers['opencarter-venice-website'].models, gemini = providers['opencarter-gemini-website'].models;
  expect(Object.keys(venice)).toContain('website'); expect(venice['claude-opus-5'].name).toBe('Claude Opus 5 · uses credits'); expect(venice['glm-4-6'].name).toBe('GLM 4.6');
  expect(gemini['3-1-pro'].name).toBe('Gemini 3.1 Pro');
});
