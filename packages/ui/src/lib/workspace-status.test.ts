import { describe, expect, test } from 'bun:test';
import { deviceActivity, relayStatusSchema, serverInfoSchema, versionRelation } from './workspace-status';
import type { RemoteClientRecord } from './api/types';

const now = Date.parse('2026-10-05T12:00:00Z');
const client: RemoteClientRecord = { id: 'phone', label: 'Phone', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: null, revokedAt: null };
describe('phone status interpretation', () => {
  test('paired without a request is not presented as active', () => {
    expect(deviceActivity(client, now)).toBe('unseen');
    expect(deviceActivity({ ...client, lastUsedAt: 'invalid' }, now)).toBe('unseen');
  });
  test('revocation and expiry take precedence over recent activity', () => {
    const recent = { ...client, lastUsedAt: new Date(now - 30_000).toISOString() };
    expect(deviceActivity(recent, now)).toBe('recent');
    expect(deviceActivity({ ...recent, revokedAt: recent.lastUsedAt }, now)).toBe('revoked');
    expect(deviceActivity({ ...recent, expiresAt: new Date(now - 1).toISOString() }, now)).toBe('expired');
    expect(deviceActivity({ ...recent, lastUsedAt: new Date(now - 91_000).toISOString() }, now)).toBe('inactive');
    expect(deviceActivity({ ...recent, lastUsedAt: new Date(now + 60_000).toISOString() }, now)).toBe('inactive');
  });
  test('unreported and different versions do not become compatibility verdicts', () => {
    expect(versionRelation('2.0.4', null)).toBe('unreported');
    expect(versionRelation('2.0.4', 'v2.0.4')).toBe('sameVersion');
    expect(versionRelation('2.0.4', '2.0.5')).toBe('differentVersion');
  });
  test('status projections discard relay identity and reject invalid responses', () => {
    expect(relayStatusSchema.parse({ enabled: true, state: 'connected', serverId: 'private', token: 'private' })).toEqual({ enabled: true, state: 'connected' });
    expect(serverInfoSchema.safeParse({}).success).toBe(false);
    expect(relayStatusSchema.safeParse({ enabled: 'yes', state: 'connected' }).success).toBe(false);
  });
});
