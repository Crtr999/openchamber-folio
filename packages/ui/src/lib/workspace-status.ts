import { z } from 'zod';
import type { RemoteClientRecord } from '@/lib/api/types';

// Project only public status fields; never carry relay identities or pairing credentials into the UI.
export const serverInfoSchema = z.object({ openchamberVersion: z.string() });
export const relayStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.string(),
  connectedClients: z.number().optional(),
  blockedByEnterprise: z.boolean().optional(),
});


export function deviceActivity(client: RemoteClientRecord, now: number): 'revoked' | 'expired' | 'recent' | 'inactive' | 'unseen' {
  if (client.revokedAt) return 'revoked';
  if (client.expiresAt && Date.parse(client.expiresAt) <= now) return 'expired';
  const lastUsed = client.lastUsedAt ? Date.parse(client.lastUsedAt) : NaN;
  if (!Number.isFinite(lastUsed)) return 'unseen';
  // Authenticated requests are recorded at most once a minute. Recency is not a live connection.
  return now - lastUsed >= -5000 && now - lastUsed <= 90_000 ? 'recent' : 'inactive';
}

export function versionRelation(server: string, device: string | null | undefined): 'sameVersion' | 'differentVersion' | 'unreported' {
  if (!device?.trim()) return 'unreported';
  return server.trim().replace(/^v/, '') === device.trim().replace(/^v/, '') ? 'sameVersion' : 'differentVersion';
}
