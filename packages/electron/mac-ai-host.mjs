import { z } from 'zod';

const preferencesSchema = z.object({
  desktopKeepAwakeEnabled: z.boolean().default(false),
  desktopAiHostKeepAwakeEnabled: z.boolean().default(false),
});
const configureSchema = z.object({ wakeProtectionEnabled: z.boolean() }).strict();
const teamWorkSchema = z.object({ state: z.enum(['required', 'idle', 'unavailable']) }).strict();
const coordinatorSchema = z.object({
  config: z.object({ enabled: z.boolean() }),
  lastCheckedAt: z.number().finite().nullable().optional(),
  nextCheckAt: z.number().finite().nullable().optional(),
  error: z.string().max(4000).optional(),
});

// One app-scoped blocker serves both the existing Keep Awake preference and
// Mac team work. The server alone starts, recovers and closes the coordinator.
export function createMacAiHost({ platform, blocker, savePreference, now = Date.now, statusTimeoutMs = 3000 }) {
  let generalEnabled = false;
  let teamEnabled = false;
  let blockerId = null;
  let nativeFailure = false;
  let stopped = false;
  let coordinator = null;
  let teamWork = { state: 'unavailable' };
  let coordinatorState = { state: 'waiting', enabled: null, lastCheckedAt: null, nextCheckAt: null, hasError: false };
  let pendingRead = null;
  let mutation = Promise.resolve();
  let power = { state: 'awake', lastSuspendAt: null, lastResumeAt: null };
  const supported = Boolean(blocker?.start && blocker?.stop && blocker?.isStarted);
  const teamSupported = platform === 'darwin' && supported;

  const active = () => {
    if (blockerId === null || !supported) return false;
    try { return blocker.isStarted(blockerId); }
    catch { nativeFailure = true; return false; }
  };
  const release = () => {
    if (blockerId === null) return;
    try {
      blocker.stop(blockerId);
      blockerId = null;
      nativeFailure = false;
    } catch {
      // Retain ownership so a later stop can retry, never start a second one.
      nativeFailure = true;
    }
  };
  const teamRequested = () => teamSupported && teamEnabled
    && (coordinatorState.state === 'enabled' || teamWork.state === 'required');
  const reconcile = () => {
    if (stopped || power.state === 'suspended' || (!generalEnabled && !teamRequested())) {
      release();
      return;
    }
    if (!supported || active()) return;
    if (blockerId !== null && nativeFailure) return;
    try {
      const id = blocker.start('prevent-app-suspension');
      if (!Number.isInteger(id) || id < 0) throw new Error('Invalid native blocker ID');
      blockerId = id;
      nativeFailure = !active();
    } catch { nativeFailure = true; }
  };
  const snapshot = () => {
    const isActive = active();
    const appRequested = generalEnabled && !stopped && power.state === 'awake';
    const team = teamRequested() && !stopped && power.state === 'awake';
    const source = isActive ? appRequested && team ? 'team-and-app' : appRequested ? 'app' : team ? 'team' : 'none' : 'none';
    const diagnostics = ['app_must_remain_running', 'network_not_verified'];
    if (platform === 'darwin') diagnostics.push('lid_may_suspend');
    if (nativeFailure) diagnostics.push('wake_protection_failed');
    if (coordinatorState.hasError) diagnostics.push('coordinator_attention');
    if (teamWork.state === 'unavailable') diagnostics.push('direct_team_wake_unavailable');
    return {
      platform,
      coordinator: { ...coordinatorState },
      teamWork: { ...teamWork },
      wakeProtection: {
        supported: teamSupported, enabled: teamEnabled, active: isActive, source,
        reason: stopped ? 'stopped' : power.state === 'suspended' ? 'suspended' : nativeFailure ? 'native_failure'
          : !teamSupported ? 'unsupported' : isActive ? 'protected' : !teamEnabled ? 'disabled'
            : coordinatorState.state === 'paused' ? 'paused' : 'coordinator_unavailable',
      },
      power: { ...power },
      diagnostics,
    };
  };
  const refresh = () => {
    if (stopped || !coordinator) return Promise.resolve(snapshot());
    if (pendingRead) return pendingRead;
    const owner = coordinator;
    let deadline;
    const unavailable = () => {
      if (owner !== coordinator || stopped) return snapshot();
      coordinatorState = { state: 'unavailable', enabled: null, lastCheckedAt: null, nextCheckAt: null, hasError: true };
      reconcile();
      return snapshot();
    };
    const read = (async () => {
      try {
        const value = coordinatorSchema.parse(await owner.status());
        if (owner !== coordinator || stopped) return snapshot();
        coordinatorState = {
          state: value.config.enabled ? 'enabled' : 'paused', enabled: value.config.enabled,
          lastCheckedAt: value.lastCheckedAt ?? null, nextCheckAt: value.nextCheckAt ?? null,
          hasError: Boolean(value.error),
        };
      } catch {
        return unavailable();
      }
      reconcile();
      return snapshot();
    })();
    // A stalled coordinator must not hang diagnostics or queue unlimited reads.
    // Keep the single read slot until the authoritative operation settles.
    const result = Promise.race([
      read,
      new Promise(resolve => { deadline = setTimeout(() => resolve(unavailable()), statusTimeoutMs); }),
    ]);
    pendingRead = result;
    void read.finally(() => {
      clearTimeout(deadline);
      if (pendingRead === result) pendingRead = null;
    });
    return pendingRead;
  };
  const serialize = (work) => {
    const result = mutation.then(() => {
      if (stopped) throw new Error('The local AI host is stopped.');
      return work();
    });
    mutation = result.catch(() => {});
    return result;
  };
  return {
    initialize(raw) {
      if (stopped) return;
      const preferences = preferencesSchema.parse(raw);
      generalEnabled = preferences.desktopKeepAwakeEnabled;
      teamEnabled = preferences.desktopAiHostKeepAwakeEnabled;
      reconcile();
    },
    attach(owner) {
      if (stopped) return Promise.resolve(snapshot());
      if (coordinator && coordinator !== owner) throw new Error('The local AI host already has a coordinator.');
      coordinator = owner;
      return refresh();
    },
    detach() {
      coordinator = null;
      teamWork = { state: 'unavailable' };
      pendingRead = null;
      coordinatorState = { state: stopped ? 'stopped' : 'waiting', enabled: null, lastCheckedAt: null, nextCheckAt: null, hasError: false };
      reconcile();
    },
    status: refresh,
    // Trusted main-process integration hook only. The owning server must publish
    // authoritative demand on startup, run/routine changes, pause and shutdown.
    // Never infer this from old inbox entries or renderer-supplied booleans.
    setTeamWork(raw) {
      if (stopped) return snapshot();
      teamWork = teamWorkSchema.parse(raw);
      reconcile();
      return snapshot();
    },
    configure(raw) {
      const input = configureSchema.parse(raw);
      return serialize(async () => {
        if (platform !== 'darwin') throw new Error('Mac-host wake protection is unavailable on this platform.');
        await savePreference('desktopAiHostKeepAwakeEnabled', input.wakeProtectionEnabled);
        teamEnabled = input.wakeProtectionEnabled;
        reconcile();
        return refresh();
      });
    },
    configureGeneral(enabled) {
      return serialize(async () => {
        await savePreference('desktopKeepAwakeEnabled', z.boolean().parse(enabled));
        generalEnabled = enabled;
        reconcile();
        return this.generalStatus();
      });
    },
    generalStatus() { return { supported, enabled: generalEnabled, active: active() }; },
    suspend() { power = { ...power, state: 'suspended', lastSuspendAt: now() }; reconcile(); },
    resume() {
      power = { ...power, state: 'awake', lastResumeAt: now() };
      if (!stopped && coordinator) {
        coordinatorState = { state: 'unavailable', enabled: null, lastCheckedAt: null, nextCheckAt: null, hasError: false };
      }
      reconcile();
      return refresh();
    },
    stop() {
      stopped = true;
      teamWork = { state: 'unavailable' };
      coordinatorState = { state: 'stopped', enabled: null, lastCheckedAt: null, nextCheckAt: null, hasError: false };
      release();
      return mutation;
    },
  };
}
