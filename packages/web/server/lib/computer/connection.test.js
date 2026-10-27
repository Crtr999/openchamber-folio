import { it, expect } from 'vitest';
import { readComputerConnection, startComputerConnection } from './connection.js';
const endpoint = { baseUrl: 'http://127.0.0.1:7801', token: 'fixture' };
it('uses authoritative status without requiring the ChatGPT app', async () => {
  expect(await readComputerConnection(endpoint, { fetchImpl: async () => Response.json({ state: 'asleep' }) })).toEqual({ state: 'asleep', chatGPTAppRequired: false });
  expect(await readComputerConnection(endpoint, { fetchImpl: async () => { throw new Error('network'); } })).toEqual({ state: 'connection-unavailable', chatGPTAppRequired: false });
  expect(await readComputerConnection(null)).toEqual({ state: 'not-configured', chatGPTAppRequired: false });
});
it('wakes only a local helper without forwarding credentials through redirects', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; expect(options.redirect).toBe('error'); expect(options.method).toBe('POST'); return Response.json({ state: 'ready' }); };
  expect((await startComputerConnection(endpoint, { fetchImpl })).state).toBe('ready');
  await expect(startComputerConnection({ ...endpoint, baseUrl: 'https://external.example' }, { fetchImpl })).rejects.toThrow();
  expect(calls).toBe(1);
});
