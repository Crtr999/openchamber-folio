import { z } from 'zod';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';

const timestamp = z.iso.datetime({ offset: true });
const base = { source: z.enum(['apple-health', 'whoop', 'lab', 'record']), sourceId: z.string(), start: timestamp, end: timestamp, label: z.string().optional(), updated: timestamp.optional() };
export const healthRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('metric'), metric: z.string(), unit: z.string(), value: z.number() }),
  z.object({ ...base, kind: z.literal('document'), title: z.string(), text: z.string(), file: z.string().optional(), textTruncated: z.boolean().optional() }),
]);
export const healthStatusSchema = z.object({ approval: z.object({ enabled: z.boolean(), directory: z.string(), providerID: z.literal('openai') }).nullable(), count: z.number(), synced: z.record(z.string(), z.string()), whoop: z.object({ configured: z.boolean(), connected: z.boolean() }) });
export type HealthRecord = z.infer<typeof healthRecordSchema>;
export interface HealthDataAPI {
  onForeground?(callback: () => void): () => void;
  status(): Promise<{ available: boolean; clinical: boolean }>;
  read(options: { days: number; clinical: boolean }): Promise<{ records: HealthRecord[]; errors: string[]; emptyMeansUnknown: boolean; readAt: string }>;
}
export async function healthRequest(path: string, body?: { records: HealthRecord[] } | { enabled: boolean; directory: string; providerID: 'openai' } | { clientId: string; clientSecret: string; redirectUri: string } | { source?: 'lab' | 'record' | 'apple-health' | 'whoop'; start?: string; limit?: number }, method = body === undefined ? 'GET' : 'POST') {
  const options: RequestInit = { method };
  if (body !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
  const response = await runtimeFetch(`/api/health/${path}`, options);
  if (!response.ok) throw new Error('Health request failed');
  return response.json();
}
export async function uploadHealthRecords(records: HealthRecord[], runtimeKey: string) {
  const current = () => { if (getRuntimeKey() !== runtimeKey) throw new Error('Health server changed'); };
  // Keep a clinical document intact and bound each request below the server limit.
  let batch: HealthRecord[] = [], size = 0;
  for (const record of records) {
    const length = JSON.stringify(record).length;
    if (batch.length && (size + length > 2_000_000 || batch.length >= 100)) {
      current();
      await healthRequest('records', { records: batch }); batch = []; size = 0;
    }
    batch.push(record); size += length;
  }
  current();
  if (batch.length) await healthRequest('records', { records: batch });
}
