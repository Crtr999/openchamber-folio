import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectRulesSnapshot } from '@/lib/api/project-rules-schema';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { opencodeClient } from '@/lib/opencode/client';
import type { Agent } from '@/lib/opencode/model';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { personalHomeSupported } from '@/lib/personal-home';
import { readFriendProfiles, saveFriendName, friendName, readFriendLink, writeFriendLink, type FriendProfiles } from '@/lib/friends';
import { parseModelSelection } from '@/lib/modelIdentifier';
import { cn } from '@/lib/utils';
import { HomeFriendsWork } from './HomeFriendsWork';

type Catalog = { scope: string; agents: Agent[]; configuration: Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>> };
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
function FriendFace({ name }: { name: string }) {
    return <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-interactive-selection text-lg font-medium text-interactive-selection-foreground">{name.slice(0, 1).toUpperCase()}<span className="ms-0.5 text-xs">·</span></span>;
}

export function HomeFriends() {
    const { t } = useI18n();
    const projects = useProjectsStore(s => s.projects);
    const [open, setOpen] = React.useState(false);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    const [projectId, setProjectId] = React.useState('');
    const [selected, setSelected] = React.useState('');
    const [tab, setTab] = React.useState<'conversation' | 'rules' | 'work'>('conversation');
    const [catalog, setCatalog] = React.useState<Catalog | null>(null);
    const [profileError, setProfileError] = React.useState(false);
    const [profiles, setProfiles] = React.useState<FriendProfiles | null>(null);
    const [name, setName] = React.useState('');
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [refresh, setRefresh] = React.useState(0);
    const sequence = React.useRef(0);
    const mutation = React.useRef(false);
    const project = projects.find(item => item.id === projectId);
    const scope = JSON.stringify([runtime, project?.path]);
    const agents = catalog?.scope === scope ? catalog.agents : [];
    const agent = agents.find(item => item.name === selected) ?? agents[0];
    const display = agent ? friendName(profiles, agent) : '';
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => { sequence.current += 1; setRuntime(getRuntimeKey()); setCatalog(null); setProfiles(null); setProfileError(false); setError(''); setBusy(false); setOpen(false); }), []);
    React.useEffect(() => {
        if (!open) return;
        try { setProfiles(readFriendProfiles(localStorage, runtime)); setProfileError(false); } catch { setProfiles(null); setProfileError(true); }
        const onStorage = () => { try { setProfiles(readFriendProfiles(localStorage, runtime)); setProfileError(false); } catch { setProfiles(null); setProfileError(true); } };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [runtime, open, t]);
    React.useEffect(() => {
        if (!open || !project || !personalHomeSupported()) return;
        const token = ++sequence.current;
        const owner = getRuntimeKey();
        void Promise.all([opencodeClient.listAgents(project.path), opencodeClient.getRulesConfiguration(project.path)]).then(([items, configuration]) => {
            if (token !== sequence.current || getRuntimeKey() !== owner) return;
            setCatalog({ scope, agents: items.filter(item => !item.hidden), configuration }); setError('');
        }).catch(failure => { if (token === sequence.current && owner === getRuntimeKey()) setError(failure instanceof Error ? failure.message : t('personalTools.error')); });
        return () => { sequence.current += 1; };
    }, [open, project, scope, refresh, t]);
    React.useEffect(() => { setName(display); }, [display]);
    const manage = () => {
        if (!project) return;
        const ui = useUIStore.getState();
        ui.setSettingsProjectPath(project.path); ui.setSettingsPage('agents');
        useAgentsStore.getState().setSelectedAgent(agent?.name ?? null);
        ui.setSettingsDialogOpen(true); setOpen(false);
    };
    const talk = async (fresh: boolean) => {
        if (!project || !agent || agent.mode === 'subagent' || mutation.current) return;
        const owner = runtime, directory = project.path, id = agent.name;
        mutation.current = true; setBusy(true); setError('');
        const token = sequence.current;
        try {
            const link = fresh ? null : readFriendLink(localStorage, owner, directory, id);
            if (link?.state === 'creating') throw new Error(t('friends.ambiguous'));
            let session;
            if (link?.state === 'ready') session = await opencodeClient.getSession(link.sessionId, directory);
            else {
                const live = (await opencodeClient.listAgents(directory)).find(item => item.name === id && !item.hidden && item.mode !== 'subagent');
                if (!live) throw new Error(t('friends.changedChat'));
                const folderModel = parseModelSelection(project.defaultModel);
                const configModel = parseModelSelection(catalog?.configuration.defaultModel);
                const chosen = folderModel ?? configModel;
                const model = folderModel ? { providerID: folderModel.providerID, id: folderModel.modelID, variant: project.defaultVariant ?? folderModel.variant }
                    : live.model ?? (chosen ? { providerID: chosen.providerID, id: chosen.modelID, variant: chosen.variant } : undefined);
                if (getRuntimeKey() !== owner || token !== sequence.current) return;
                writeFriendLink(localStorage, owner, directory, id, { state: 'creating' });
                session = await opencodeClient.createSession({ agent: id, model, title: `${display} · ${project.label || project.path.split('/').pop()}` }, directory);
            }
            if (getRuntimeKey() !== owner || token !== sequence.current) return;
            if (session.directory !== directory || session.agent !== id || session.time.archived) throw new Error(t('friends.changedChat'));
            writeFriendLink(localStorage, owner, directory, id, { state: 'ready', sessionId: session.id });
            setOpen(false); useSessionUIStore.getState().setCurrentSession(session.id, directory);
        } catch (failure) { if (owner === getRuntimeKey() && token === sequence.current) setError(failure instanceof Error ? failure.message : t('personalTools.error')); }
        finally { mutation.current = false; if (owner === getRuntimeKey()) setBusy(false); }
    };
    if (!personalHomeSupported()) return null;
    return <section className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-3"><Icon name="user-smile" className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><h2 className="text-sm font-medium">{t('friends.title')}</h2><p className="text-xs text-muted-foreground">{t('friends.subtitle')}</p></div><Button size="sm" variant="outline" onClick={() => { if (!projectId || !projects.some(item => item.id === projectId)) setProjectId(projects[0]?.id ?? ''); setOpen(true); }}>{t('friends.open')}</Button></div>
        <Dialog open={open} onOpenChange={value => { if (!mutation.current) setOpen(value); }}><DialogContent className="flex max-h-[88dvh] w-[min(1050px,95vw)] max-w-none flex-col overflow-hidden"><DialogHeader><DialogTitle>{t('friends.title')}</DialogTitle><DialogDescription>{t('friends.subtitle')}</DialogDescription></DialogHeader>
            <div className="flex flex-wrap items-center gap-2"><Select value={projectId} disabled={busy} onValueChange={id => { sequence.current += 1; setProjectId(id); setSelected(''); setCatalog(null); setError(''); }}><SelectTrigger className="max-w-sm" aria-label={t('home.aiProject')}><SelectValue placeholder={t('home.aiChooseProject')}>{project ? (project.label || project.path.split('/').pop()) : undefined}</SelectValue></SelectTrigger><SelectContent>{projects.map(item => <SelectItem key={item.id} value={item.id}>{item.label || item.path.split('/').pop()}</SelectItem>)}</SelectContent></Select><Button size="xs" variant="ghost" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('home.refresh')}</Button><Button size="xs" variant="ghost" disabled={busy || !project} onClick={manage}>{t('friends.manage')}</Button></div>
            {profileError && <p role="alert" className="text-sm text-destructive">{t('friends.storageError')}</p>}
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            {!project && <p>{t('mobile.sessions.empty.noProjectsDescription')}</p>}
            {project && !catalog && !error && <p role="status">{t('common.loading')}</p>}
            <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto md:grid-cols-[200px_minmax(0,1fr)]">
                <aside className="space-y-1" aria-label={t('friends.title')}>{agents.map(item => <Button key={item.name} variant="ghost" className={cn('h-auto w-full justify-start gap-3 py-3 text-start', item.name === agent?.name && 'bg-interactive-selection text-interactive-selection-foreground')} disabled={busy} aria-pressed={item.name === agent?.name} onClick={() => { setSelected(item.name); setTab('conversation'); }}><FriendFace name={friendName(profiles, item)} /><span className="min-w-0"><span className="block truncate">{friendName(profiles, item)}</span><span className="block truncate text-xs text-muted-foreground">{item.displayName}</span></span></Button>)}</aside>
                <div className="min-w-0 space-y-4">{agent && <>
                    <div className="flex items-center gap-3"><FriendFace name={display} /><div><h3 className="text-lg font-medium">{tab === 'work' ? t('friends.work') : display}</h3><p className="text-xs text-muted-foreground">{agent.name} · {project?.label || project?.path}</p></div></div>
                    <div className="flex flex-wrap gap-1 border-b border-border pb-2" aria-label={t('friends.views')}>{(['conversation', 'rules', 'work'] as const).map(value => <Button key={value} size="sm" variant="chip" aria-pressed={tab === value} onClick={() => setTab(value)}>{t(`friends.${value}`)}</Button>)}</div>
                    {tab === 'conversation' && <div className="space-y-4">
                        <p className="whitespace-pre-wrap text-sm">{agent.description || t('friends.noDescription')}</p>
                        <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (!profiles || !agent || !name.trim()) return; try { setProfiles(saveFriendName(localStorage, runtime, agent.name, name.trim(), profiles.revision)); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : t('friends.storageError')); } }}><Input className="max-w-xs" aria-label={t('friends.name')} value={name} maxLength={32} onChange={event => setName(event.target.value)} /><Button type="submit" variant="outline" size="sm" disabled={!profiles || !name.trim() || name.trim() === display}>{t('home.save')}</Button></form>
                        <p className="text-xs text-muted-foreground">{t('friends.identity')}</p>
                        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || agent.mode === 'subagent'} onClick={() => void talk(false)}>{t('friends.continue')}</Button><Button variant="ghost" size="sm" disabled={busy || agent.mode === 'subagent'} onClick={() => void talk(true)}>{t('friends.newChat')}</Button></div>
                        {agent.mode === 'subagent' && <p className="text-xs text-muted-foreground">{t('friends.specialist')}</p>}
                        <p className="text-sm text-muted-foreground">{t('friends.memory')}</p>
                    </div>}
                    {tab === 'rules' && <div className="space-y-4 text-sm"><p>{t('friends.ruleOrder')}</p><p className="break-all text-xs text-muted-foreground">{project?.path}</p>{project && <FolderInstructions key={scope} directory={project.path} />}<h4 className="font-medium">{t('friends.model')}</h4><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ folder: project?.defaultModel ?? catalog?.configuration.defaultModel ?? null, agent: agent.model ?? null }, null, 2)}</pre><h4 className="font-medium">{t('friends.projectRules')}</h4><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-elevated p-3 text-xs">{JSON.stringify(catalog?.configuration.ruleSources ?? [], null, 2)}</pre><h4 className="font-medium">{t('friends.permissions')}</h4><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-elevated p-3 text-xs">{JSON.stringify(agent.permissions, null, 2)}</pre><h4 className="font-medium">{t('friends.instructions')}</h4><pre className="whitespace-pre-wrap break-words text-xs">{agent.system || agent.description || t('friends.noDescription')}</pre></div>}
                    {tab === 'work' && project && <HomeFriendsWork key={scope} runtime={runtime} projectId={project.id} />}
                </>}</div>
            </div>
        </DialogContent></Dialog>
    </section>;
}
