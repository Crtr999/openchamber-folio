import type {
  ClientAuthAPI,
  PairingSessionCreateResult,
  PendingPairingRecord,
  RemoteClientCreateResult,
  RemoteClientPurgeRevokedResult,
  RemoteClientRecord,
  RemoteClientRevokeResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { remoteClientListSchema } from '@openchamber/ui/lib/api/client-auth-schema';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebClientAuthAPI = (request: typeof runtimeFetch = runtimeFetch): ClientAuthAPI => ({
  async listClients(): Promise<RemoteClientRecord[]> {
    const response = await request('/api/client-auth/clients', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const payload = await jsonOrNull<{ error?: string }>(response);
      throw new Error(payload?.error || response.statusText || 'Failed to load remote clients');
    }
    return remoteClientListSchema.parse(await response.json()).clients;
  },

  async createClient(input = {}): Promise<RemoteClientCreateResult> {
    const response = await request('/api/client-auth/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ label: input.label ?? '' }),
    });
    const payload = await jsonOrNull<RemoteClientCreateResult & { error?: string }>(response);
    if (!response.ok || !payload?.client || typeof payload.token !== 'string') {
      throw new Error(payload?.error || response.statusText || 'Failed to create remote client token');
    }
    return payload;
  },

  async createPairingSession(input = {}): Promise<PairingSessionCreateResult> {
    const response = await request('/api/client-auth/pairing/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        label: input.label ?? '',
        ...(input.allowedClientKinds ? { allowedClientKinds: input.allowedClientKinds } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(typeof input.includeRelay === 'boolean' ? { includeRelay: input.includeRelay } : {}),
        ...(typeof input.includeDirect === 'boolean' ? { includeDirect: input.includeDirect } : {}),
      }),
    });
    const payload = await jsonOrNull<PairingSessionCreateResult & { error?: string }>(response);
    if (!response.ok || typeof payload?.pairing?.secret !== 'string' || !payload?.server) {
      throw new Error(payload?.error || response.statusText || 'Failed to create pairing session');
    }
    return payload;
  },

  async listPendingPairings(): Promise<PendingPairingRecord[]> {
    const response = await request('/api/client-auth/pairing/sessions', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ pending?: PendingPairingRecord[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pending pairings');
    }
    return Array.isArray(payload.pending) ? payload.pending : [];
  },

  async getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }> {
    const response = await request('/api/client-auth/pairing/transports', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ local?: string | null; lan?: string | null; relayAvailable?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pairing transports');
    }
    return { local: payload.local ?? null, lan: payload.lan ?? null, relayAvailable: payload.relayAvailable !== false };
  },

  async cancelPairing(id: string): Promise<{ cancelled: boolean }> {
    const response = await request(`/api/client-auth/pairing/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ cancelled?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to cancel pairing');
    }
    return { cancelled: payload.cancelled === true };
  },

  async revokeClient(id: string): Promise<RemoteClientRevokeResult> {
    const response = await request(`/api/client-auth/clients/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientRevokeResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to revoke remote client');
    }
    return payload;
  },

  async purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult> {
    const response = await request('/api/client-auth/clients', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientPurgeRevokedResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to clear revoked clients');
    }
    return payload;
  },
});
