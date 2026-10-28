import { afterEach, expect, test, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { createWebsiteModelsRuntime, buildWebsitePrompt, extractCompactionSummary, streamableLength, websiteReplyMessage } from './runtime.js';

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
  const native = (body, signal, provider = 'venice') => fetch(origin + '/api/openchamber/website-models/' + provider + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer local-fixture' }, body: JSON.stringify(body), signal });
  const worker = () => fetch(origin + '/api/openchamber/website-models/jobs/next', { headers: { 'x-fixture-ui': 'yes' } });
  const result = body => fetch(origin + '/api/openchamber/website-models/jobs/result', { method: 'POST', headers: { 'x-fixture-ui': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { runtime, native, worker, result, origin };
};
const request = { model: 'website', messages: [{ role: 'user', content: 'Hello' }] };
const geminiTools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
const geminiRound = async (h, body, text, page = { url: 'https://gemini.google.com/app/observed', userCount: 1 }) => {
  const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(body, undefined, 'gemini');
  const job = await (await waiting).json();
  const result = { id: job.id, lease: job.lease, text };
  if (page) result.page = page;
  await h.result(result);
  return { response: await completion, job };
};

test('Gemini reuses exactly matched tool continuations and stops repeated tool execution', async () => {
  const h = await start();
  const body = { ...request, tools: geminiTools };
  const first = await geminiRound(h, body, '{"tool_calls":[{"name":"read","arguments":{"path":"fixture"}}]}');
  expect(first.job.continuation).toBeUndefined();
  const message = (await first.response.json()).choices[0].message;
  const next = { ...body, messages: [...body.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Synthetic tool result' }] };
  const second = await geminiRound(h, next, '{"tool_calls":[{"name":"read","arguments":{"path":"fixture"}}]}', { url: 'https://gemini.google.com/app/observed', userCount: 2 });
  expect(second.job.continuation).toMatchObject({ url: 'https://gemini.google.com/app/observed', userCount: 1 });
  expect(second.job.continuation.answerHash).toMatch(/^[a-f0-9]{64}$/);
  expect(second.job.prompt).toContain('Synthetic tool result');
  expect(second.job.prompt).not.toContain('Hello');
  expect(second.response.status).toBe(422);
  expect(await second.response.text()).toContain('repeated tool');
  const duplicate = await h.native(next, undefined, 'gemini');
  expect(duplicate.status).toBe(422); expect(h.runtime.pendingCount).toBe(0);
});

test('Gemini permits four tool rounds and one final answer in one observed chat', async () => {
  const h = await start(); let body = { ...request, tools: geminiTools };
  let freshChats = 0, generations = 0, toolExecutions = 0;
  for (let round = 0; round < 5; round++) {
    const text = round < 4 ? JSON.stringify({ tool_calls: [{ name: 'read', arguments: { path: 'fixture-' + round } }] }) : 'Final answer';
    const { job, response } = await geminiRound(h, body, text, { url: 'https://gemini.google.com/app/observed', userCount: round + 1 });
    generations++; if (!job.continuation) freshChats++;
    expect(response.status).toBe(200);
    const message = (await response.json()).choices[0].message;
    if (round === 4) {
      expect(job.prompt).toContain('No client tools are available');
      expect(message.content).toBe('Final answer');
      break;
    }
    toolExecutions += message.tool_calls.length;
    body = { ...body, messages: [...body.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Synthetic result' }] };
  }
  expect({ freshChats, generations, toolExecutions }).toEqual({ freshChats: 1, generations: 5, toolExecutions: 4 });
  expect(h.runtime.pendingCount).toBe(0);
});

test('Gemini rejects duplicate pending, failed, completed and stream-mode retries without new jobs', async () => {
  for (const outcome of [{ error: 'Quota exhausted' }, { text: 'Done' }]) {
    const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
    const completion = h.native(request, undefined, 'gemini'); const job = await (await waiting).json();
    for (let i = 0; i < 10; i++) expect((await h.native({ ...request, stream: i % 2 === 0 }, undefined, 'gemini')).status).toBe(422);
    expect(h.runtime.pendingCount).toBe(1);
    await h.result({ id: job.id, lease: job.lease, ...outcome });
    expect((await completion).status).toBe(outcome.error ? 422 : 200);
    expect((await h.native(request, undefined, 'gemini')).status).toBe(422);
    expect(h.runtime.pendingCount).toBe(0);
  }
});

test('Gemini missing continuation fails closed and malformed compaction never regenerates', async () => {
  const h = await start();
  const first = await geminiRound(h, { ...request, tools: geminiTools }, '{"tool_calls":[{"name":"read","arguments":{}}]}', null);
  expect(first.response.status).toBe(422);
  expect(await first.response.text()).toContain('No tools were executed');
  const message = websiteReplyMessage('{"tool_calls":[{"name":"read","arguments":{}}]}', geminiTools);
  const next = { ...request, tools: geminiTools, messages: [...request.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Synthetic result' }] };
  expect((await h.native(next, undefined, 'gemini')).status).toBe(422);
  expect(h.runtime.pendingCount).toBe(0);
  const compact = { ...request, messages: [{ role: 'user', content: 'Summarize. <template>\n## Objective\n</template>' }] };
  const summary = await geminiRound(h, compact, 'Wrong template');
  expect(summary.response.status).toBe(422);
  expect(h.runtime.pendingCount).toBe(0);
  expect((await h.native(compact, undefined, 'gemini')).status).toBe(422);
});

test('Gemini cannot return a fifth tool round even if the website ignores the final-answer instruction', async () => {
  const h = await start(); let body = { ...request, tools: geminiTools };
  for (let round = 0; round < 5; round++) {
    const text = JSON.stringify({ tool_calls: [{ name: 'read', arguments: { path: 'fixture-' + round } }] });
    const { response, job } = await geminiRound(h, body, text, { url: 'https://gemini.google.com/app/observed', userCount: round + 1 });
    if (round === 4) {
      expect(job.prompt).toContain('No client tools are available');
      expect(response.status).toBe(422);
      expect(await response.text()).toContain('not offered');
      expect((await h.native(body, undefined, 'gemini')).status).toBe(422);
      expect(h.runtime.pendingCount).toBe(0);
      break;
    }
    const message = (await response.json()).choices[0].message;
    body = { ...body, messages: [...body.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Synthetic failure: unavailable' }] };
  }
});

test('Gemini detects equivalent nested arguments and duplicate calls within one batch', async () => {
  const h = await start();
  const calls = [{ name: 'read', arguments: { a: 1, nested: { a: 2, b: 3 } } }, { name: 'read', arguments: { nested: { b: 3, a: 2 }, a: 1 } }];
  const { response } = await geminiRound(h, { ...request, tools: geminiTools }, JSON.stringify({ tool_calls: calls }));
  expect(response.status).toBe(422); expect(await response.text()).toContain('repeated tool');
  expect(h.runtime.pendingCount).toBe(0);
});

test('Gemini cancelled and timed-out generations are never re-leased or regenerated', async () => {
  const h = await start({ timeoutMs: 500 });
  const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const controller = new AbortController();
  const completion = h.native(request, controller.signal, 'gemini').catch(() => null);
  const job = await (await waiting).json(); controller.abort(); await completion;
  await vi.waitFor(() => expect(h.runtime.pendingCount).toBe(0));
  expect((await h.native(request, undefined, 'gemini')).status).toBe(422);
  expect(await (await h.result({ id: job.id, lease: job.lease, text: 'Late answer' })).json()).toEqual({ accepted: false });
  const timed = await geminiRound(h, { ...request, messages: [{ role: 'user', content: 'Different turn' }] }, 'Done');
  expect(timed.response.status).toBe(200);
  const next = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const body = { ...request, messages: [{ role: 'user', content: 'Timeout turn' }] };
  const timeout = h.native(body, undefined, 'gemini'); const expired = await (await next).json();
  expect((await timeout).status).toBe(422); expect(h.runtime.pendingCount).toBe(0);
  expect((await h.native(body, undefined, 'gemini')).status).toBe(422);
  expect(await (await h.result({ id: expired.id, lease: expired.lease, text: 'Late answer' })).json()).toEqual({ accepted: false });
});

test('Gemini recent-request protection refuses overflow and expires without evicting earlier attempts', async () => {
  const h = await start();
  for (let i = 0; i < 128; i++) {
    const body = { ...request, messages: [{ role: 'user', content: 'Synthetic ' + i }] };
    const { response } = await geminiRound(h, body, 'Done');
    expect(response.status).toBe(200);
  }
  const body = { ...request, messages: [{ role: 'user', content: 'Overflow' }] };
  const refused = await h.native(body, undefined, 'gemini');
  expect(refused.status).toBe(422); expect(await refused.text()).toContain('safety limit');
  const first = { ...request, messages: [{ role: 'user', content: 'Synthetic 0' }] };
  expect(await (await h.native(first, undefined, 'gemini')).text()).toContain('already attempted');
  expect(h.runtime.pendingCount).toBe(0);
  const later = Date.now() + 10 * 60_000 + 1;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
  try { expect((await geminiRound(h, first, 'Done')).response.status).toBe(200); }
  finally { clock.mockRestore(); }
});
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

test('keeps only the template body of a website reply', async () => {
    const body = '## Objective\n- fix it\n## Next Move\n1. test';
    expect(extractCompactionSummary('Sure! Here it is:\n```markdown\n' + body + '\n```')).toBe(body);
    expect(extractCompactionSummary(body)).toBe(body);
    expect(extractCompactionSummary('I cannot do that.')).toBeNull();
    expect(extractCompactionSummary('## Objective\n- only one heading')).toBeNull();
});

test('asks for the template and offers no tools on a compaction request', async () => {
    const out = buildWebsitePrompt({ model: 'website', messages: [{ role: 'user', content: 'Summarize.\n<template>\n## Objective\n- x\n</template>' }], tools: [{ type: 'function', function: { name: 'read' } }] });
    expect(out.compaction).toBe(true);
    expect(out.request.tools).toEqual([]);
    expect(out.prompt).toContain('Start your reply with "## Objective"');
    expect(out.prompt).not.toContain('"tool_calls"');
});

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imageRequest = (content, tools) => ({ model: 'image-z-image-turbo', stream: false, messages: [{ role: 'system', content: 'You are an assistant.' }, { role: 'user', content }], ...(tools ? { tools } : {}) });
test('an image model sends only the prompt and returns a stored picture as markdown', async () => {
  const h = await start(); const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(imageRequest('a red apple', [{ type: 'function', function: { name: 'read' } }]));
  const job = await (await waiting).json();
  expect(job.image).toBe(true); expect(job.model).toBe('Z-Image Turbo'); expect(job.prompt).toBe('a red apple');
  await h.result({ id: job.id, lease: job.lease, image: { mime: 'image/png', base64: PIXEL, alt: 'An apple' } });
  const text = (await (await completion).json()).choices[0].message.content;
  const file = text.match(/!\[An apple\]\((.+?)\)/)?.[1];
  expect(file).toContain('venice-images');
  const fs = await import('node:fs'); expect(fs.existsSync(file)).toBe(true); fs.rmSync(file);
});
test('an image model never spends an image on a helper request or a bogus picture', async () => {
  const h = await start();
  const title = await h.native(imageRequest('a red apple'));
  expect(title.status).toBe(200); expect((await title.json()).choices[0].message.content).toBe('Image: a red apple');
  expect(h.runtime.pendingCount).toBe(0);
  const waiting = h.worker(); await vi.waitFor(() => expect(h.runtime.workerCount).toBe(1));
  const completion = h.native(imageRequest('a pear', [{ type: 'function', function: { name: 'read' } }]));
  const job = await (await waiting).json();
  await h.result({ id: job.id, lease: job.lease, image: { mime: 'image/png', base64: Buffer.from('not an image').toString('base64') } });
  expect((await completion).status).toBe(422);
});
