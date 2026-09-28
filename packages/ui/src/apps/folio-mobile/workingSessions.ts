import React from 'react';
import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';

/**
 * Which of the Mac's conversations this phone shows as working, and the evidence
 * that keeps that answer honest.
 *
 * The live event channel answers at once: a `session.status` on the Mac reaches
 * the shared global status index on the phone exactly as it reaches the Mac's own
 * sidebar, so the dot appears with the same latency it has there. That channel
 * cannot answer when it matters most. A phone that was backgrounded, or whose
 * connection dropped, misses the `session.idle` that ends the turn, and the index
 * keeps the session marked busy with nothing left to clear it — the desktop's
 * recovery for a missed idle is a per-directory poll, and the phone has only the
 * one directory it has a chat open in. A dot that can never go away is worse than
 * no dot, so the index is believed only alongside a recent authoritative list
 * that agrees with it.
 *
 * That list is OpenCode's own `session.active`: global across every directory,
 * naming only the sessions running right now, so a session it omits is idle. A
 * request that fails answers nothing at all, and leaves the previous list to age
 * out rather than standing in for one. The two halves therefore divide cleanly —
 * the event channel can start a dot, the list can end one, and a list that stops
 * arriving stops being believed.
 */

/** How often the authoritative list is refreshed while a surface is showing dots. */
const REFRESH_INTERVAL_MS = 20_000;

/**
 * How long a list is still believed after it was taken. Two refresh intervals, so
 * one slow request over the relay does not take a working dot away, but a list
 * nobody refreshes is dropped rather than carried: the phone may be away, in which
 * case no interval runs and the turns the list described have long since ended.
 */
const MAX_AGE_MS = 45_000;

const NO_SESSIONS: ReadonlySet<string> = new Set();

type WorkingSessionsState = {
  /** Sessions the last successful authoritative list named as running on the Mac. */
  confirmed: ReadonlySet<string>;
  /**
   * When that list was taken. Zero means the phone has not yet read one, which is
   * the one state that shows nothing at all: a live event on its own is exactly the
   * evidence a backgrounded or disconnected phone cannot vouch for.
   */
  confirmedAt: number;
  /** Sessions a live event called active that no list since has denied. */
  raised: ReadonlySet<string>;
};

const initialState: WorkingSessionsState = { confirmed: NO_SESSIONS, confirmedAt: 0, raised: NO_SESSIONS };

export const useWorkingSessionsStore = create<WorkingSessionsState>(() => initialState);

// A live event can name a session the next list has not been asked about yet. The
// list answers on its own cadence, so without this the dot for a turn that just
// started would wait for that poll instead of appearing at once.
let liveWatchers = 0;
let endLiveWatch: (() => void) | undefined;

const startLiveWatch = () => {
  liveWatchers += 1;
  if (endLiveWatch) return;
  endLiveWatch = useGlobalSessionStatusStore.subscribe((state, previous) => {
    if (state.activeSessionIds === previous.activeSessionIds) return;
    const store = useWorkingSessionsStore.getState();
    const raised = new Set(store.raised);
    let changed = false;
    for (const sessionId of state.activeSessionIds) {
      if (raised.has(sessionId) || store.confirmed.has(sessionId)) continue;
      raised.add(sessionId);
      changed = true;
    }
    if (changed) useWorkingSessionsStore.setState({ raised });
  });
};

const stopLiveWatch = () => {
  liveWatchers -= 1;
  if (liveWatchers > 0) return;
  endLiveWatch?.();
  endLiveWatch = undefined;
};

let inFlight: Promise<void> | null = null;

/**
 * Asks the Mac which sessions are running and adopts the answer. A failed request
 * keeps the previous list and leaves its age alone, so a list nobody can refresh
 * expires out of use instead of being believed on, and a runtime switch discards
 * the reply rather than attributing another Mac's work to this one.
 */
const adoptMacActivity = async () => {
  const runtimeKey = getRuntimeKey();
  const before = useWorkingSessionsStore.getState();
  // A list this old describes a phone that has been away since; the turns it
  // named have ended, and nothing has proved otherwise.
  if (before.confirmedAt > 0 && Date.now() - before.confirmedAt > MAX_AGE_MS) {
    useWorkingSessionsStore.setState({ confirmed: NO_SESSIONS, confirmedAt: 0, raised: NO_SESSIONS });
  }
  const running = await opencodeClient.getActiveSessionStatuses();
  if (running === null || getRuntimeKey() !== runtimeKey) return;
  // A session the live channel raised before this request went out and the list
  // omits has finished. One that arrived while the request was in flight is kept,
  // because a list taken a moment earlier cannot be evidence against it.
  const denied = new Set<string>();
  for (const sessionId of before.raised) {
    if (!(sessionId in running)) denied.add(sessionId);
  }
  useWorkingSessionsStore.setState({
    confirmed: new Set(Object.keys(running)),
    confirmedAt: Date.now(),
    raised: new Set([...useWorkingSessionsStore.getState().raised].filter((sessionId) => !denied.has(sessionId))),
  });
};

const refreshNow = () => {
  inFlight ??= adoptMacActivity()
    .catch(() => undefined)
    .finally(() => { inFlight = null; });
};

/**
 * Keeps the authoritative list fresh for as long as a surface is showing dots, and
 * re-reads it at the three moments a phone can fall behind: coming back to the
 * front, moving to another Mac, and the interval that bounds a dropped stream.
 */
export const useWorkingSessionsWatch = (): void => {
  React.useEffect(() => {
    startLiveWatch();
    refreshNow();
    const every = setInterval(refreshNow, REFRESH_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshNow(); };
    const stopEndpoint = subscribeRuntimeEndpointChanged(refreshNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopLiveWatch();
      clearInterval(every);
      stopEndpoint();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
};

/**
 * Whether this conversation is working on the Mac right now. The live index alone
 * is not enough — a session it still calls busy after the turn ended would keep a
 * dot on forever — so nothing is shown until a list has proved the phone can read
 * the Mac's running sessions, and after that only while the list still agrees.
 */
export const useIsWorkingOnMac = (sessionId: string): boolean => {
  const live = useGlobalSessionStatusStore((state) => state.activeSessionIds.has(sessionId));
  const listed = useWorkingSessionsStore((state) => (
    state.confirmedAt > 0 && (state.confirmed.has(sessionId) || state.raised.has(sessionId))
  ));
  return live && listed;
};
