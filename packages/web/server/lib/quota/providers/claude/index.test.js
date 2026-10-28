import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credential = vi.fn();

import { fetchQuota as fetchClaudeQuota, isConfigured, resetClaudeQuotaCache } from './index.js';

const request = vi.fn();
const fetchQuota = () => fetchClaudeQuota({ readCredential: credential, fetchImpl: request });

const CREDENTIAL = {
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
  expiresAt: Date.now() + 3_600_000,
  planLabel: 'max',
  source: 'keychain',
};

const PAYLOAD = {
  limits: [
    { kind: 'session', percent: 5, resets_at: '2026-08-14T19:10:00Z', scope: null },
    { kind: 'weekly_all', percent: 4, resets_at: '2026-08-20T15:00:00Z', scope: null },
  ],
};

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
});

const errorResponse = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
});

beforeEach(() => {
  resetClaudeQuotaCache();
  credential.mockReturnValue(CREDENTIAL);
  request.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Claude quota provider', () => {
  it('preserves sample age throughout a 30-minute cooldown and accepts a fresh zero when it ends', async () => {
    let now = Date.UTC(2026, 7, 20, 14, 59);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    request.mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '1800' }))
      .mockResolvedValueOnce(jsonResponse({ limits: [
        { kind: 'weekly_all', percent: 0, resets_at: '2026-08-27T15:00:00Z' },
      ] }));
    const initial = await fetchQuota();
    now += 30_000;
    const limited = await fetchQuota();
    now += 29 * 60_000;
    const cached = await fetchQuota();
    expect(limited.ok).toBe(false);
    expect(cached.ok).toBe(false);
    expect(cached.error).toBe('Rate limited. Retrying soon.');
    expect(limited.fetchedAt).toBe(initial.fetchedAt);
    expect(cached.fetchedAt).toBe(initial.fetchedAt);
    expect(cached.usage.windows['7d'].usedPercent).toBe(4);
    expect(request).toHaveBeenCalledTimes(2);
    now += 60_000;
    const fresh = await fetchQuota();
    expect(request).toHaveBeenCalledTimes(3);
    expect(fresh.ok).toBe(true);
    expect(fresh.fetchedAt).toBe(now);
    expect(fresh.usage.windows['7d'].usedPercent).toBe(0);
  });

  it('does not cache an unreadable usage response as an authoritative empty sample', async () => {
    request.mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(jsonResponse({ unrelated: true }));
    await fetchQuota();
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
  });

  it('keeps first-load usage unknown during a 30-minute cooldown without manufacturing a zero', async () => {
    let now = Date.UTC(2026, 7, 20, 14);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    request.mockResolvedValue(errorResponse(429, { 'retry-after': '1800' }));
    const first = await fetchQuota();
    now += 29 * 60_000;
    const cached = await fetchQuota();
    expect(first.ok).toBe(false);
    expect(cached.ok).toBe(false);
    expect(cached.usage).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reports not configured when no credential source has a token', async () => {
    credential.mockReturnValue(null);

    expect(isConfigured({ readCredential: credential })).toBe(false);
    const result = await fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('returns windows and the plan label from the credential', async () => {
    request.mockResolvedValue(jsonResponse(PAYLOAD));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('max');
    expect(result.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('coalesces concurrent refreshes into one Anthropic request', async () => {
    let resolveResponse;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    request.mockImplementation(fetchMock);

    const first = fetchQuota();
    const second = fetchQuota();
    resolveResponse(jsonResponse(PAYLOAD));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
  });

  it('keeps serving the last good values while Anthropic rate limits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '120' }));
    request.mockImplementation(fetchMock);

    await fetchQuota();
    const rateLimited = await fetchQuota();

    expect(rateLimited.ok).toBe(false);
    expect(rateLimited.error).toBe('Rate limited. Retrying soon.');
    expect(rateLimited.usage.windows['5h'].usedPercent).toBe(5);
  });

  it('does not call Anthropic again while the rate-limit cooldown is active', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    request.mockImplementation(fetchMock);

    await fetchQuota();
    await fetchQuota();
    await fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never shows one account cached values after the credential changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(errorResponse(429));
    request.mockImplementation(fetchMock);

    await fetchQuota();
    credential.mockReturnValue({ ...CREDENTIAL, accessToken: 'access-b', refreshToken: 'refresh-b', planLabel: null });
    const afterSwitch = await fetchQuota();

    expect(afterSwitch.ok).toBe(false);
    expect(afterSwitch.usage).toBeNull();
  });

  it('explains an expired session instead of reporting a bare 401', async () => {
    request.mockResolvedValue(errorResponse(401));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('Claude Code');
  });

  it('surfaces a network failure instead of an empty successful result', async () => {
    request.mockRejectedValue(new Error('socket hang up'));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('socket hang up');
  });
});
