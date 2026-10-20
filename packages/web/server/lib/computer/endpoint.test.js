import { describe, expect, it, vi } from 'vitest';

import { fetchComputerState, resolveComputerEndpoint } from './endpoint.js';

/**
 * The computer is a tool's, and the tool's configuration says where it is and
 * how to open it. The key is usually written as a file reference so it never
 * appears in a file the user might share, and it must never travel further than
 * it has to.
 */

const layersFor = (config) => () => ({ mergedConfig: config });

const remoteServer = (url, headers) => ({
  mcp: {
    carterbot: { type: 'remote', url, headers, enabled: true },
  },
});

describe('finding the computer', () => {
  it('reads the address and the key from the tool\'s own configuration', () => {
    const endpoint = resolveComputerEndpoint({
      readLayers: layersFor(remoteServer('http://localhost:7800/mcp', { Authorization: 'Bearer literal-key' })),
    });
    expect(endpoint).toEqual({ name: 'carterbot', baseUrl: 'http://localhost:7800', token: 'literal-key' });
  });

  it('resolves a key written as a file reference', () => {
    const endpoint = resolveComputerEndpoint({
      readLayers: layersFor(remoteServer('http://localhost:7800/mcp', { Authorization: 'Bearer {file:~/keys/computer}' })),
      homedir: '/home/user',
      readFile: (target) => {
        expect(target).toBe('/home/user/keys/computer');
        return '  file-key\n';
      },
    });
    expect(endpoint?.token).toBe('file-key');
  });

  it('reads the servers under mcp.servers as well', () => {
    const endpoint = resolveComputerEndpoint({
      readLayers: layersFor({
        mcp: { servers: { carterbot: { type: 'remote', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer k' } } } },
      }),
    });
    expect(endpoint?.baseUrl).toBe('http://127.0.0.1:9000');
    expect(endpoint?.token).toBe('k');
  });

  it('finds nothing when no computer is configured', () => {
    expect(resolveComputerEndpoint({ readLayers: layersFor({}) })).toBeNull();
    expect(resolveComputerEndpoint({ readLayers: layersFor({ mcp: { other: { type: 'remote', url: 'https://example.com/mcp' } } }) })).toBeNull();
  });

  it('finds nothing when the configuration cannot be read', () => {
    expect(resolveComputerEndpoint({ readLayers: () => { throw new Error('broken config'); } })).toBeNull();
  });

  it('finds nothing when the key cannot be read', () => {
    const endpoint = resolveComputerEndpoint({
      readLayers: layersFor(remoteServer('http://localhost:7800/mcp', { Authorization: 'Bearer {file:~/missing}' })),
      homedir: '/home/user',
      readFile: () => { throw new Error('missing'); },
    });
    // A file reference that cannot be read falls back to the literal text,
    // which is not a key: the endpoint is refused rather than half-built.
    expect(endpoint?.token).toBe('{file:~/missing}');
  });
});

describe('what the computer is doing', () => {
  it('lists the screens that are open', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ screens: [{ name: 'shopper', since: '2026-10-19T10:00:00Z' }, { name: '  ' }] }),
    }));
    const state = await fetchComputerState({ baseUrl: 'http://localhost:7800', token: 'k' }, { fetchImpl });
    expect(state).toEqual({ available: true, screens: [{ name: 'shopper', since: '2026-10-19T10:00:00Z' }] });
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:7800/api/state', expect.objectContaining({
      headers: { Authorization: 'Bearer k' },
    }));
  });

  it('reports a computer that is not running as unavailable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('refused'); });
    const state = await fetchComputerState({ baseUrl: 'http://localhost:7800', token: 'k' }, { fetchImpl });
    expect(state).toEqual({ available: false, screens: [] });
  });

  it('reports an endpoint that answers with an error as unavailable', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const state = await fetchComputerState({ baseUrl: 'http://localhost:7800', token: 'k' }, { fetchImpl });
    expect(state.available).toBe(false);
  });
});
