export interface NativeAppReadQuery {
  app: 'calendar' | 'reminders';
  containerId: string;
  start: string;
  end: string;
  limit: number;
}
export type NativeAppReadResult = {
  status: 'ok';
  items: Array<{ id: string; title: string; start: string | null; end: string | null; allDay: boolean }>;
  truncated: boolean;
} | { status: 'permission-required' | 'permission-denied' | 'unsupported' | 'error' | 'container-unavailable'; reason: string };
export interface NativeAppReader {
  runtimeId: string;
  requestApproval?: (scope: {
    directory: string; providerID: string; providerBinding: string; runtimeId: string; runtimeEndpoint: string;
    app: 'calendar' | 'reminders'; containerId: string; purpose: 'grant' | 'containers';
  }) => Promise<{ decision: 'approved' | 'revoked' | 'cancelled' | 'unavailable' | 'busy' }>;
  status: () => {
    status: 'available' | 'unsupported';
    apps: { calendar: 'scoped-eventkit' | 'unsupported'; reminders: 'scoped-eventkit' | 'unsupported'; notes: 'unsupported'; mail: 'unsupported' };
    permissions: 'not-checked'; requires: string[]; background: true;
  };
  read: (query: NativeAppReadQuery, signal?: AbortSignal) => Promise<NativeAppReadResult>;
  containers: (query: { app: 'calendar' | 'reminders' }, signal?: AbortSignal) => Promise<{
    status: 'containers'; containers: Array<{ id: string; title: string }>; truncated: boolean;
  } | { status: 'permission-required' | 'permission-denied' | 'unsupported' | 'error' | 'container-unavailable'; reason: string }>;
}
