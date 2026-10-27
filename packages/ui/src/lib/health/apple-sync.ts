import React from 'react';
import { z } from 'zod';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isCapacitorApp } from '@/lib/platform';
import { healthRecordSchema, healthStatusSchema, healthRequest, uploadHealthRecords } from './client';

const preferences = z.object({ enabled: z.boolean(), clinical: z.boolean() });
const key = () => `opencarter.health.apple-sync.${encodeURIComponent(getRuntimeKey())}`;
export function setAppleHealthSyncPreference(value: z.infer<typeof preferences>) {
  getSafeStorage().setItem(key(), JSON.stringify(preferences.parse(value)));
}
/** Opt-in foreground refresh only: no background polling or permission bypass. */
export function useAppleHealthSync() {
  const { healthData } = useRuntimeAPIs();
  React.useEffect(() => {
    if (!healthData || !isCapacitorApp()) return;
    let active = true, working = false, lastAttempt = 0;
    let owner = getRuntimeKey();
    const run = async () => {
      if (working || !active) return;
      const current = getRuntimeKey();
      if (owner !== current) { owner = current; lastAttempt = 0; }
      if (Date.now() - lastAttempt < 5 * 60000) return;
      let value;
      try { value = preferences.parse(JSON.parse(getSafeStorage().getItem(key()) || 'null')); } catch { return; }
      if (!value.enabled) return;
      working = true; lastAttempt = Date.now();
      try {
        const status = healthStatusSchema.parse(await healthRequest('status'));
        if (!status.approval?.enabled || !active || getRuntimeKey() !== current) return;
        const available = z.object({ available: z.boolean() }).parse(await healthData.status());
        if (!available.available || !active || getRuntimeKey() !== current) return;
        const result = z.object({ records: z.array(healthRecordSchema) }).parse(await healthData.read({ days: 30, clinical: value.clinical }));
        if (!active || getRuntimeKey() !== current) return;
        await uploadHealthRecords(result.records, current);
      } catch {
        // Last successful source timestamps remain unchanged on any failure.
      } finally { working = false; }
    };
    const stop = healthData.onForeground?.(() => { void run(); });
    void run();
    return () => { active = false; stop?.(); };
  }, [healthData]);
}
