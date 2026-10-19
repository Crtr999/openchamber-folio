import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectRulesSnapshot } from '@/lib/api/project-rules-schema';
import type { ProjectEntry } from '@/lib/api/types';
import type { FriendAppearance } from '@/lib/friends';
import { useI18n } from '@/lib/i18n';
import type { opencodeClient } from '@/lib/opencode/client';
import type { Agent } from '@/lib/opencode/model';
import { morphFrom } from '@/lib/motion';
import { HomeFriendAvatar } from './HomeFriendAvatar';
import { HomeFriendsWork } from './HomeFriendsWork';

type RulesConfiguration = Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>>;
type FriendDetailsTarget = { agent: Agent; name: string; appearance: FriendAppearance; origin: DOMRect | null };

function FolderInstructions({ directory }: { directory: string }) {
    const { files } = useRuntimeAPIs();
    const { t } = useI18n();
    const [snapshot, setSnapshot] = React.useState<ProjectRulesSnapshot | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        let alive = true;
        setSnapshot(null); setFailed(false);
        if (!files.readProjectRules) { setFailed(true); return; }
        void files.readProjectRules(directory, 'instructions').then(value => { if (alive) setSnapshot(value); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [directory, files]);
    return <section className="space-y-2"><h4 className="font-medium">{t('workspaceStatus.instructions')}</h4>{failed ? <p role="alert">{t('personalTools.error')}</p> : snapshot ? <><p className="break-all text-xs text-muted-foreground">{snapshot.path}</p><pre className="whitespace-pre-wrap break-words text-xs">{snapshot.content}</pre></> : <p role="status">{t('common.loading')}</p>}</section>;
}

/** Side panel for one friend: who it is, the folder rules it works under, and the folder team's work. */
export function HomeFriendDetails({ target, project, runtime, configuration, busy, error, onClose, onTalk, onCustomize, onManage, children }: {
    target: FriendDetailsTarget | null;
    project: ProjectEntry | undefined;
    runtime: string;
    configuration: RulesConfiguration | undefined;
    busy: boolean;
    error: string;
    onClose: () => void;
    onTalk: (agent: string, fresh: boolean) => void;
    onCustomize: (agent: string, origin: DOMRect | null) => void;
    onManage: (agent: string) => void;
    /** Dialogs opened from this panel, rendered inside it so they stack as nested dialogs. */
    children?: React.ReactNode;
}) {
    const { t } = useI18n();
    const popup = React.useRef<HTMLDivElement>(null);
    // Keyed on the opening rect so later re-renders of the same panel never replay the motion.
    const origin = target?.origin ?? null;
    React.useEffect(() => {
        if (!origin) return;
        const frame = requestAnimationFrame(() => { morphFrom(popup.current, origin, 200); });
        return () => cancelAnimationFrame(frame);
    }, [origin]);
    const agent = target?.agent;
    const specialist = agent?.mode === 'subagent';
    return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose(); }}>
        <DialogContent ref={popup} layerClassName="justify-end p-3" className="oc-friend-details h-full max-h-full w-[min(520px,100%)] max-w-none gap-5 p-5">
            {target && agent && <>
                <DialogHeader className="flex-row items-center gap-3 pe-8 text-start">
                    <HomeFriendAvatar body={target.appearance.body} color={target.appearance.color} className="size-14 shrink-0" />
                    <div className="min-w-0">
                        <DialogTitle className="truncate text-lg">{target.name}</DialogTitle>
                        <DialogDescription className="truncate">{agent.displayName} · {project?.label || project?.path}</DialogDescription>
                    </div>
                </DialogHeader>
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy || specialist} onClick={() => onTalk(agent.name, false)}><Icon name="chat-3" className="size-3.5" />{t('friends.continue')}</Button>
                    <Button size="sm" variant="outline" disabled={busy || specialist} onClick={() => onTalk(agent.name, true)}><Icon name="chat-new" className="size-3.5" />{t('friends.newChat')}</Button>
                    <Button size="sm" variant="ghost" onClick={event => onCustomize(agent.name, event.currentTarget.getBoundingClientRect())}><Icon name="palette" className="size-3.5" />{t('friends.customize')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => onManage(agent.name)}><Icon name="settings-3" className="size-3.5" />{t('friends.manage')}</Button>
                </div>
                {error && <p role="alert" className="break-words text-sm text-[var(--status-error-text)]">{error}</p>}
                <section className="space-y-2 text-sm">
                    <h3 className="oc-home-card-heading">{t('friends.about')}</h3>
                    <p className="whitespace-pre-wrap">{agent.description || t('friends.noDescription')}</p>
                    {specialist && <p className="text-xs text-muted-foreground">{t('friends.specialist')}</p>}
                    <p className="text-xs text-muted-foreground">{t('friends.memory')}</p>
                </section>
                <details className="oc-friend-section" open>
                    <summary>{t('friends.work')}</summary>
                    {project && <HomeFriendsWork key={JSON.stringify([runtime, project.path])} runtime={runtime} projectId={project.id} />}
                </details>
                <details className="oc-friend-section">
                    <summary>{t('friends.rules')}</summary>
                    <div className="space-y-4 text-sm"><p>{t('friends.ruleOrder')}</p><p className="break-all text-xs text-muted-foreground">{project?.path}</p>
                        {project && <FolderInstructions key={JSON.stringify([runtime, project.path])} directory={project.path} />}
                        <h4 className="font-medium">{t('friends.model')}</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ folder: project?.defaultModel ?? configuration?.defaultModel ?? null, agent: agent.model ?? null }, null, 2)}</pre>
                        <h4 className="font-medium">{t('friends.projectRules')}</h4><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-subtle p-3 text-xs">{JSON.stringify(configuration?.ruleSources ?? [], null, 2)}</pre>
                        <h4 className="font-medium">{t('friends.permissions')}</h4><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-subtle p-3 text-xs">{JSON.stringify(agent.permissions, null, 2)}</pre>
                        <h4 className="font-medium">{t('friends.instructions')}</h4><pre className="whitespace-pre-wrap break-words text-xs">{agent.system || agent.description || t('friends.noDescription')}</pre>
                    </div>
                </details>
                {children}
            </>}
        </DialogContent>
    </Dialog>;
}
