import { describe, expect, it } from 'vitest';
import { createWebClientAuthAPI } from './clientAuth';

describe('remote device list', () => {
  it('rejects malformed success instead of pretending there are no devices', async () => {
    const api = createWebClientAuthAPI(async () => Response.json({}));
    await expect(api.listClients()).rejects.toThrow();
  });
  it('preserves public device version and transport while discarding credentials', async () => {
    const api = createWebClientAuthAPI(async () => Response.json({ clients: [{ id: 'phone', label: 'Phone', createdAt: '2026-10-01', lastUsedAt: null, revokedAt: null, appVersion: '2.0.4', deviceModel: 'iPhone', lastTransport: 'relay', token: 'secret' }] }));
    const devices = await api.listClients();
    expect(devices[0]).toMatchObject({ appVersion: '2.0.4', deviceModel: 'iPhone', lastTransport: 'relay' });
    expect(devices[0]).not.toHaveProperty('token');
  });
  it('distinguishes valid empty and access-denied lists', async () => {
    const empty = createWebClientAuthAPI(async () => Response.json({ clients: [] }));
    expect(await empty.listClients()).toEqual([]);
    const denied = createWebClientAuthAPI(async () => Response.json({ error: 'Denied' }, { status: 403 }));
    await expect(denied.listClients()).rejects.toThrow('Denied');
  });
});
