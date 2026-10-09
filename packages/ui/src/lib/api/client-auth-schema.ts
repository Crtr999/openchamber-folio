import { z } from 'zod';

/** Public metadata only; credentials and relay trust anchors are never projected into device lists. */
export const remoteClientRecordsSchema = z.array(z.object({
  id: z.string(), label: z.string(), createdAt: z.string(),
  lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(),
  clientKind: z.string().nullable().optional(), authMethod: z.string().nullable().optional(),
  pairingId: z.string().nullable().optional(), usesRelay: z.boolean().optional(),
  expiresAt: z.string().nullable().optional(),
  deviceName: z.string().nullable().optional(), devicePlatform: z.string().nullable().optional(),
  deviceModel: z.string().nullable().optional(), appVersion: z.string().nullable().optional(),
  lastTransport: z.enum(['relay', 'direct']).nullable().optional(),
}));

export const remoteClientListSchema = z.object({ clients: remoteClientRecordsSchema });
