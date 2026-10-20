import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { fetchAgentMemory, type AgentMemoryEntry } from '@/lib/agentMemoryApi';
import { useUIStore } from '@/stores/useUIStore';

/**
 * What this friend remembers.
 *
 * The store behind this is the same one the agent is told about before it
 * answers, so what is listed here is exactly what the next conversation in
 * this folder starts with. Reading it is how the user sees the friend
 * accumulate: every conversation in the folder ends by adding what it settled.
 *
 * The snapshot is fetched on its own rather than read from the shared store,
 * because the shared store holds one project at a time and this panel may be
 * showing a folder that is not the active one.
 */
export function FriendMemorySection({ projectPath }: { projectPath: string }) {
    const { t } = useI18n();
    const enabled = useUIStore((state) => state.agentMemoryFeatureAvailable && state.agentMemoryToolEnabled);
    const [entries, setEntries] = React.useState<AgentMemoryEntry[] | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        let alive = true;
        setLoading(true);
        setFailed(false);
        void fetchAgentMemory(projectPath, { signal: controller.signal })
            .then((snapshot) => {
                if (!alive) return;
                setEntries(snapshot.project);
                setFailed(snapshot.projectFailed);
            })
            .catch(() => { if (alive) setFailed(true); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; controller.abort(); };
    }, [enabled, projectPath]);

    if (!enabled) {
        return (
            <section className="space-y-1.5">
                <h3 className="oc-home-card-heading">{t('friends.memory')}</h3>
                <p className="text-[11px] text-muted-foreground">{t('friends.memoryOff')}</p>
            </section>
        );
    }

    const count = entries?.length ?? 0;

    return (
        <section className="space-y-1.5">
            <h3 className="oc-home-card-heading">
                {t('friends.memory')} ({count})
            </h3>
            {failed ? (
                <p className="text-[11px] text-muted-foreground">{t('friends.memoryUnavailable')}</p>
            ) : loading && count === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('common.loading')}</p>
            ) : count === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('friends.memoryEmpty')}</p>
            ) : (
                <ul className="space-y-1">
                    {(entries ?? []).slice(0, 8).map((entry) => (
                        <li key={entry.id} className="flex min-w-0 items-start gap-2 text-[11px]">
                            <Icon name="brain-4" className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                            <span className="min-w-0">
                                <span className="text-foreground">{entry.title}</span>
                                <span className="text-muted-foreground"> · {entry.type}</span>
                            </span>
                        </li>
                    ))}
                    {count > 8 && (
                        <li className="text-[11px] text-muted-foreground">{t('friends.memoryMore', { count: count - 8 })}</li>
                    )}
                </ul>
            )}
        </section>
    );
}
