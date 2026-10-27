import { z } from 'zod';
const statusSchema = z.object({ state: z.enum(['ready', 'asleep', 'starting', 'unavailable']), cachedTools: z.number().optional() });
const localBroker = endpoint => {
  if (!endpoint?.baseUrl || !endpoint.token) return null;
  const url = new URL(endpoint.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) return null;
  return url.origin;
};
export async function readComputerConnection(endpoint, { fetchImpl = fetch } = {}) {
  if (!endpoint) return { state: 'not-configured', chatGPTAppRequired: false };
  const base = localBroker(endpoint);
  if (!base) return { state: 'unsupported', chatGPTAppRequired: false };
  try {
    const result = await fetchImpl(base + '/api/connection/status', { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (result.ok) return { ...statusSchema.parse(await result.json()), chatGPTAppRequired: false };
    // Existing computers without the recovery endpoint still report their real state.
    const state = await fetchImpl(base + '/api/state', { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    return { state: state.ok ? 'ready' : 'connection-unavailable', chatGPTAppRequired: false };
  } catch { return { state: 'connection-unavailable', chatGPTAppRequired: false }; }
}
export async function startComputerConnection(endpoint, { fetchImpl = fetch } = {}) {
  const base = localBroker(endpoint);
  if (!base) throw new Error('A local CarterBot recovery connection is required');
  const response = await fetchImpl(base + '/api/connection/start', { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(180000), redirect: 'error' });
  if (!response.ok) throw new Error('The computer could not start; inspect the connection. The ChatGPT app is not required.');
  return { ...statusSchema.parse(await response.json()), chatGPTAppRequired: false };
}
