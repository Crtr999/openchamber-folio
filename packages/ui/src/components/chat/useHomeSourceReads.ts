import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type HomeReadObservation =
    | { kind: 'unknown' }
    | { kind: 'read'; readAt: number }
    | { kind: 'failed'; readAt: number | null };
export type HomeReadSource = 'board' | 'habits' | 'calendar';
export type HomeSourceReads = { [Source in HomeReadSource]: HomeReadObservation };

/** In-memory evidence only. A completion time says nothing about native cache age. */
export function createHomeSourceReads(runtime: string, currentRuntime: () => string, now = Date.now) {
    let snapshot: HomeSourceReads = { board: { kind: 'unknown' }, habits: { kind: 'unknown' }, calendar: { kind: 'unknown' } };
    const generations = { board: 0, habits: 0, calendar: 0 };
    const listeners = new Set<() => void>();
    const publish = (next: HomeSourceReads) => {
        snapshot = next;
        for (const listener of listeners) listener();
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        reset: (...sources: HomeReadSource[]) => {
            const next = { ...snapshot };
            for (const source of sources) { generations[source] += 1; next[source] = { kind: 'unknown' }; }
            publish(next);
        },
        begin: (source: HomeReadSource) => {
            const generation = generations[source];
            const accepted = () => runtime === currentRuntime() && generation === generations[source];
            return {
                success: () => { if (accepted()) publish({ ...snapshot, [source]: { kind: 'read', readAt: now() } }); },
                failure: () => {
                    if (!accepted()) return;
                    const previous = snapshot[source];
                    publish({ ...snapshot, [source]: { kind: 'failed', readAt: previous.kind === 'unknown' ? null : previous.readAt } });
                },
            };
        },
    };
}

export function useHomeSourceReads(runtime: string) {
    const tracker = useMemo(() => createHomeSourceReads(runtime, getRuntimeKey), [runtime]);
    useEffect(() => () => tracker.reset('board', 'habits', 'calendar'), [tracker]);
    const reads = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);
    return { reads, beginRead: tracker.begin, resetReads: tracker.reset };
}
