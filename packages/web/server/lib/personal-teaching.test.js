import { describe, expect, it } from 'vitest';
import { createPersonalTeaching } from './personal-teaching.js';

const readConfig = () => ({ mcp: { carterbot: { type: 'remote', url: 'http://localhost:7800/mcp', headers: { Authorization: 'Bearer test-token' } } } });
const recordingId = '2026-10-18-00-00-00-open-carter-teach';
function fixture() {
  let recording = false;
  let failed = '';
  const calls = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (pathname === failed) throw new Error('network failed');
    if (pathname === '/api/state') return Response.json({ recording: recording ? [{ screen: 'open-carter-teach', id: recordingId }] : [], recordings: recording ? [] : [recordingId, 'other-recording'] });
    if (pathname === '/api/screen/open') return Response.json({ ok: true });
    if (pathname === '/api/teach/start') { recording = true; return Response.json({ id: recordingId }); }
    if (pathname === '/api/teach/stop') { recording = false; return Response.json({ id: recordingId, seconds: 3, events: 2 }); }
    throw new Error('Unexpected endpoint');
  };
  const service = createPersonalTeaching({ readConfig, fetchImpl, blocked: () => false });
  return { service, calls, fail: (pathname) => { failed = pathname; } };
}

describe('local teaching broker', () => {
  it('starts, reconciles duplicate starts, stops and reviews without leaking credentials', async () => {
    const { service, calls } = fixture();
    expect((await service.status()).phase).toBe('ready');
    const started = await service.start();
    expect(started.phase).toBe('recording');
    expect(JSON.stringify(started)).not.toContain('test-token');
    await service.start();
    expect(calls.filter((call) => call.pathname === '/api/teach/start')).toHaveLength(1);
    const stopped = await service.stop();
    expect(stopped).toMatchObject({ phase: 'review', seconds: 3, recordingId });
    expect(stopped.videoUrl).toBe(`http://localhost:7800/files/recordings/${recordingId}/screen.mp4`);
    expect(stopped.recordings).toEqual([recordingId]);
    await expect(service.review('other-recording')).rejects.toThrow('teaching_review_unavailable');
    expect((await service.review(recordingId)).phase).toBe('review');
    for (const { options } of calls) { expect(options.redirect).toBe('error'); expect(options.headers.authorization).toBe('Bearer test-token'); }
  });
  it('dismiss stops owned capture and does nothing before connecting', async () => {
    const { service, calls } = fixture();
    await service.dismiss(); expect(calls).toHaveLength(0);
    await service.start(); await service.dismiss();
    expect((await service.status()).phase).toBe('review');
    expect(calls.filter((call) => call.pathname === '/api/teach/stop')).toHaveLength(1);
  });
  it('does not turn connection failures into an empty ready state', async () => {
    const { service, fail } = fixture();
    await service.start(); fail('/api/state');
    await expect(service.status()).rejects.toThrow();
    await expect(service.dismiss()).rejects.toThrow();
  });
  it('enforces enterprise policy at each operation before network access', async () => {
    let requests = 0;
    const service = createPersonalTeaching({ readConfig, blocked: () => true, fetchImpl: async () => { requests++; return Response.json({}); } });
    await expect(service.status()).rejects.toThrow('enterprise_mode');
    await expect(service.start()).rejects.toThrow('enterprise_mode');
    expect(requests).toBe(0);
  });
  it('rejects unconfigured, disabled, credential-bearing and insecure remote endpoints', async () => {
    for (const entry of [{}, { type: 'remote', enabled: false, url: 'http://localhost:7800/mcp', headers: {} }, { type: 'remote', url: 'http://example.test/mcp', headers: { Authorization: 'Bearer test-token' } }, { type: 'remote', url: 'https://secret@example.test/mcp', headers: { Authorization: 'Bearer test-token' } }]) {
      const service = createPersonalTeaching({ readConfig: () => ({ mcp: { carterbot: entry } }), blocked: () => false, fetchImpl: async () => { throw new Error('must not fetch'); } });
      await expect(service.status()).rejects.not.toThrow('must not fetch');
    }
  });
  it('reads bounded typed MCP material through JSON and SSE without exposing credentials', async () => {
    for (const sse of [false, true]) {
      const service = createPersonalTeaching({ readConfig, blocked: () => false, fetchImpl: async (url, options) => {
        expect(url).toBe('http://localhost:7800/mcp'); expect(options.redirect).toBe('error');
        expect(options.headers.authorization).toBe('Bearer test-token');
        const input = JSON.parse(options.body); expect(input.params.name).toBe('teach_watch');
        const result = { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: 'events' }, { type: 'image', data: '/9j/', mimeType: 'image/jpeg' }] } };
        return sse ? new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(result);
      } });
      const result = await service.skillTool('teach_watch', { source: recordingId });
      expect(result).toHaveLength(2); expect(JSON.stringify(result)).not.toContain('test-token');
      await expect(service.skillTool('run', {})).rejects.toThrow('invalid_tool');
    }
  });
  it('refuses MCP tool failures and policy revocation while reading', async () => {
    let blocked = false;
    const service = createPersonalTeaching({ readConfig, blocked: () => blocked, fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body); blocked = true;
      return Response.json({ id: input.id, result: { content: [{ type: 'text', text: 'private response' }] } });
    } });
    await expect(service.skillTool('skill_list', {})).rejects.toThrow('enterprise_mode');
  });
});
