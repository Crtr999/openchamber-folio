import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import type { HealthDataAPI } from '../health/client';

const plugin = registerPlugin<HealthDataAPI>('HealthData');
export function createHealthDataAPI(): HealthDataAPI {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') {
    return { status: async () => ({ available: false, clinical: false }), read: async () => { throw new Error('Apple Health requires the iPhone app'); } };
  }
  return {
    status: () => plugin.status(),
    read: options => plugin.read(options),
    onForeground: callback => {
      let disposed = false;
      const listener = App.addListener('appStateChange', state => { if (!disposed && state.isActive) callback(); });
      return () => { disposed = true; void listener.then(handle => handle.remove()); };
    },
  };
}
