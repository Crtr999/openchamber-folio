import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useAllSessionStatuses } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import type { Agent } from '@/lib/opencode/model';
import type { ProjectEntry } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { personalHomeSupported } from '@/lib/personal-home';
import { readFriendProfiles, saveFriendProfile, friendName, friendAppearance, readFriendLink, writeFriendLink, type FriendAppearance, type FriendLink, type FriendProfiles } from '@/lib/friends';
import { parseModelSelection } from '@/lib/modelIdentifier';
import { cn } from '@/lib/utils';
import { HomeFriendAvatar } from './HomeFriendAvatar';
import { HomeFriendCustomize, type FriendCustomizeTarget } from './HomeFriendCustomize';
import { HomeFriendDetails } from './HomeFriendDetails';

type Catalog = { scope: string; agents: Agent[]; configuration: Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>> };
type FriendStatus = { kind: 'working' | 'retrying' | 'active' | 'unconfirmed' | 'about'; text: string };
type FriendCard = { agent: string; name: string; role: string; appearance: FriendAppearance; status: FriendStatus; specialist: boolean };
type Origin = DOMRect | null;
const folderKey = (runtime: string) => `open-carter:friends-folder:v1:${JSON.stringify(runtime)}`;
const readFolder = (runtime: string) => { try { return localStorage.getItem(folderKey(runtime)) ?? ''; } catch { return ''; } };

/** The card row itself; all data and actions come from the caller. */
export function HomeFriendCards({ friends, busyAgent, onOpen, onNew, onCustomize, onDetails }: {
    friends: FriendCard[];
    busyAgent: string;
    onOpen: (agent: string, origin: Origin) => void;
    onNew: (agent: string) => void;
    onCustomize: (agent: string, origin: Origin) => void;
    onDetails: (agent: string, origin: Origin) => void;
}) {
    const { t } = useI18n();
    const cards = React.useRef(new Map<string, HTMLLIElement>());
    const originOf = (agent: string): Origin => cards.current.get(agent)?.getBoundingClientRect() ?? null;
    return <ul className="oc-friend-grid" aria-label={t('friends.title')}>{friends.map(friend => {
        const busy = Boolean(busyAgent);
        return <li key={friend.agent} className="oc-friend-card" data-friend={friend.agent} data-busy={busyAgent === friend.agent ? 'true' : undefined}
            ref={element => { if (element) cards.current.set(friend.agent, element); else cards.current.delete(friend.agent); }}>
            <Button type="button" variant="ghost" className="oc-friend-card-main" disabled={busy}
                aria-label={friend.specialist ? t('friends.openDetails', { name: friend.name }) : t('friends.openChat', { name: friend.name })}
                aria-describedby={`friend-status-${friend.agent}`}
                onClick={() => (friend.specialist ? onDetails : onOpen)(friend.agent, originOf(friend.agent))}>
                <HomeFriendAvatar body={friend.appearance.body} color={friend.appearance.color} className="oc-friend-card-avatar" />
                <span className="oc-friend-card-text">
                    <span className="oc-friend-card-name">{friend.name}</span>
                    <span className="oc-friend-card-role">{friend.role}</span>
                    <span id={`friend-status-${friend.agent}`} className="oc-friend-card-status" data-kind={friend.status.kind}>
                        {(friend.status.kind === 'working' || friend.status.kind === 'retrying') && <span className="oc-friend-status-dot" aria-hidden="true" />}
                        <span className="truncate">{busyAgent === friend.agent ? t('friends.opening') : friend.status.text}</span>
                    </span>
                </span>
            </Button>
            <div className="oc-friend-card-actions">
                {!friend.specialist && <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy}
                    aria-label={`${friend.name}: ${t('friends.newChat')}`} title={t('friends.newChat')} onClick={() => onNew(friend.agent)}>
                    <Icon name="chat-new" className="size-3.5" />
                </Button>}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('friends.actions', { name: friend.name })} title={t('friends.actions', { name: friend.name })}>
                        <Icon name="more-2" className="size-3.5" />
                    </Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onCustomize(friend.agent, originOf(friend.agent))}><Icon name="palette" className="size-3.5" />{t('friends.customize')}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onDetails(friend.agent, originOf(friend.agent))}><Icon name="information" className="size-3.5" />{t('friends.details')}</DropdownMenuItem>
                        {!friend.specialist && <DropdownMenuItem disabled={busy} onSelect={() => onNew(friend.agent)}><Icon name="chat-new" className="size-3.5" />{t('friends.newChat')}</DropdownMenuItem>}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>;
    })}</ul>;
}

const folderLabel = (item: Pick<ProjectEntry, 'label' | 'path'>) => item.label || item.path.split('/').pop() || item.path;
/** Widget title with the compact folder scope and an icon-only refresh. */
export function HomeFriendsHeader({ projects, project, loading, busy, onChooseFolder, onRefresh }: {
    projects: ProjectEntry[];
    project: ProjectEntry | undefined;
    loading: boolean;
    busy: boolean;
    onChooseFolder: (id: string) => void;
    onRefresh: () => void;
}) {
    const { t } = useI18n();
    return <div className="oc-home-card-heading oc-friends-heading">
        <h2 className="flex min-w-0 items-center gap-2"><Icon name="user-smile" className="size-3.5 shrink-0" />{t('friends.title')}</h2>
        {projects.length > 0 && <>
            <Select value={project?.id ?? ''} disabled={busy} onValueChange={onChooseFolder}>
                <SelectTrigger size="sm" className="oc-friends-folder ms-auto min-w-0 max-w-[14rem]" aria-label={t('friends.folder')}>
                    <Icon name="folder-3" className="size-3.5" />
                    <SelectValue placeholder={t('home.aiChooseProject')}>{project ? folderLabel(project) : undefined}</SelectValue>
                </SelectTrigger>
                <SelectContent>{projects.map(item => <SelectItem key={item.id} value={item.id}>{folderLabel(item)}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground" disabled={loading || busy}
                aria-label={t('friends.refresh')} title={t('friends.refresh')} onClick={onRefresh}>
                <Icon name="refresh" className={cn('size-3.5', loading && 'oc-friends-spin')} />
            </Button>
        </>}
    </div>;
}

const relative = (locale: string, time: number, now: number) => {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const minutes = Math.round((time - now) / 60_000);
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    return format.format(Math.round(hours / 24), 'day');
};

/** Friends widget on Home: the selected folder's agents as cards. */
export function HomeFriends() {
    const { t, locale } = useI18n();
    const projects = useProjectsStore(s => s.projects);
    const statuses = useAllSessionStatuses();
    const liveSessions = useAllLiveSessions();
    const cachedSessions = useGlobalSessionsStore(s => s.activeSessions);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    const [projectId, setProjectId] = React.useState(() => readFolder(getRuntimeKey()));
    const [catalog, setCatalog] = React.useState<Catalog | null>(null);
    const [profileError, setProfileError] = React.useState(false);
    const [profiles, setProfiles] = React.useState<FriendProfiles | null>(null);
    const [error, setError] = React.useState('');
    const [busyAgent, setBusyAgent] = React.useState('');
    const [refresh, setRefresh] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const [customize, setCustomize] = React.useState<FriendCustomizeTarget | null>(null);
    const [details, setDetails] = React.useState<{ agent: string; origin: Origin } | null>(null);
    const [links, setLinks] = React.useState(new Map<string, FriendLink | null>());
    const sequence = React.useRef(0);
    const mutation = React.useRef(false);
    const supported = personalHomeSupported();
    const project = projects.find(item => item.id === projectId) ?? projects[0];
    const scope = JSON.stringify([runtime, project?.path]);
    const agents = React.useMemo(() => catalog?.scope === scope ? catalog.agents : [], [catalog, scope]);
    const readProfiles = React.useCallback(() => {
        try { setProfiles(readFriendProfiles(localStorage, runtime)); setProfileError(false); } catch { setProfiles(null); setProfileError(true); }
    }, [runtime]);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
        sequence.current += 1;
        const next = getRuntimeKey();
        setRuntime(next); setProjectId(readFolder(next)); setCatalog(null); setProfiles(null); setProfileError(false); setError(''); setBusyAgent('');
        setCustomize(null); setDetails(null);
    }), []);
    React.useEffect(() => {
        if (!supported) return;
        readProfiles();
        const onStorage = () => readProfiles();
        // Returning to the window re-reads the folder's agents: refresh stays implicit.
        const onVisible = () => { if (document.visibilityState === 'visible') setRefresh(value => value + 1); };
        window.addEventListener('storage', onStorage);
        document.addEventListener('visibilitychange', onVisible);
        return () => { window.removeEventListener('storage', onStorage); document.removeEventListener('visibilitychange', onVisible); };
    }, [supported, readProfiles]);
    React.useEffect(() => {
        if (!project || !supported) return;
        const token = ++sequence.current;
        const owner = getRuntimeKey();
        setLoading(true);
        void Promise.all([opencodeClient.listAgents(project.path), opencodeClient.getRulesConfiguration(project.path)]).then(([items, configuration]) => {
            if (token !== sequence.current || getRuntimeKey() !== owner) return;
            setCatalog({ scope, agents: items.filter(item => !item.hidden), configuration }); setError('');
        }).catch(failure => { if (token === sequence.current && owner === getRuntimeKey()) setError(failure instanceof Error ? failure.message : t('personalTools.error')); })
            .finally(() => { if (token === sequence.current) setLoading(false); });
        return () => { sequence.current += 1; setLoading(false); };
    }, [project, supported, scope, refresh, t]);

    // Saved conversation links for the cards' status lines. One unreadable link only affects its own card.
    const reloadLinks = React.useCallback(() => {
        const next = new Map<string, FriendLink | null>();
        for (const agent of agents) {
            try { next.set(agent.name, project ? readFriendLink(localStorage, runtime, project.path, agent.name) : null); } catch { next.set(agent.name, null); }
        }
        setLinks(next);
    }, [agents, project, runtime]);
    React.useEffect(() => {
        reloadLinks();
        window.addEventListener('storage', reloadLinks);
        return () => window.removeEventListener('storage', reloadLinks);
    }, [reloadLinks]);
    const sessions = React.useMemo(() => {
        const byId = new Map(cachedSessions.map(session => [session.id, session]));
        for (const session of liveSessions) byId.set(session.id, session);
        return byId;
    }, [cachedSessions, liveSessions]);
    const cards = React.useMemo<FriendCard[]>(() => {
        const now = Date.now();
        return agents.map(agent => {
            const link = links.get(agent.name);
            const about = agent.mode === 'subagent' ? t('friends.specialist') : agent.description || t('friends.noDescription');
            const session = link?.state === 'ready' ? sessions.get(link.sessionId) : undefined;
            const live = link?.state === 'ready' ? statuses[link.sessionId] : undefined;
            const status: FriendStatus = link?.state === 'creating' ? { kind: 'unconfirmed', text: t('friends.status.unconfirmed') }
                : live && live.type === 'retry' ? { kind: 'retrying', text: t('friends.status.retrying') }
                : live && live.type !== 'idle' ? { kind: 'working', text: t('friends.status.working') }
                : session ? { kind: 'active', text: t('friends.status.active', { time: relative(locale, session.time.updated, now) }) }
                : { kind: 'about', text: about };
            return { agent: agent.name, name: friendName(profiles, agent), role: agent.displayName, appearance: friendAppearance(profiles, agent.name), status, specialist: agent.mode === 'subagent' };
        });
    }, [agents, profiles, sessions, statuses, links, locale, t]);

    const chooseFolder = (id: string) => {
        sequence.current += 1; setProjectId(id); setCatalog(null); setError('');
        try { localStorage.setItem(folderKey(runtime), id); } catch { /* the choice still applies to this view */ }
    };
    const manage = (name: string) => {
        if (!project) return;
        const ui = useUIStore.getState();
        ui.setSettingsProjectPath(project.path); ui.setSettingsPage('agents');
        useAgentsStore.getState().setSelectedAgent(name);
        ui.setSettingsDialogOpen(true); setDetails(null);
    };
    // Continue reopens the saved link after verifying it; only `fresh` starts another conversation.
    const talk = async (id: string, fresh: boolean) => {
        const agent = agents.find(item => item.name === id);
        if (!project || !agent || agent.mode === 'subagent' || mutation.current) return;
        const owner = runtime, directory = project.path, display = friendName(profiles, agent);
        mutation.current = true; setBusyAgent(id); setError('');
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
                reloadLinks();
                session = await opencodeClient.createSession({ agent: id, model, title: `${display} · ${project.label || project.path.split('/').pop()}` }, directory);
            }
            if (getRuntimeKey() !== owner || token !== sequence.current) return;
            if (session.directory !== directory || session.agent !== id || session.time.archived) throw new Error(t('friends.changedChat'));
            writeFriendLink(localStorage, owner, directory, id, { state: 'ready', sessionId: session.id });
            reloadLinks();
            setDetails(null);
            // Replaces the focused tab like any other Home navigation.
            useSessionUIStore.getState().setCurrentSession(session.id, directory);
        } catch (failure) { if (owner === getRuntimeKey() && token === sequence.current) setError(failure instanceof Error ? failure.message : t('personalTools.error')); }
        finally { mutation.current = false; if (owner === getRuntimeKey()) setBusyAgent(''); }
    };
    const openCustomize = (id: string, origin: Origin) => {
        const agent = agents.find(item => item.name === id);
        if (!agent || !profiles) return;
        setCustomize({ agent: id, role: agent.displayName, name: friendName(profiles, agent), appearance: friendAppearance(profiles, id), origin });
    };
    const saveCustomize = (id: string, draft: { name: string } & FriendAppearance) => {
        if (!profiles) throw new Error(t('friends.storageError'));
        setProfiles(saveFriendProfile(localStorage, runtime, id, draft, profiles.revision));
    };
    const detailAgent = details ? agents.find(item => item.name === details.agent) : undefined;
    // Opened from Details, Customize stacks inside that panel as a nested dialog.
    const customizeDialog = <HomeFriendCustomize target={customize} onClose={() => setCustomize(null)} onSave={saveCustomize} />;

    return <section className="oc-friends" aria-busy={loading || undefined}>
        <HomeFriendsHeader projects={supported ? projects : []} project={project} loading={loading} busy={Boolean(busyAgent)}
            onChooseFolder={chooseFolder} onRefresh={() => setRefresh(value => value + 1)} />
        {!supported ? <p className="oc-home-empty">{t('home.desktopOnly')}</p>
            : !projects.length ? <p className="oc-home-empty">{t('friends.noFolders')}</p>
            : <>
                {profileError && <p role="alert" className="oc-home-empty text-[var(--status-error-text)]">{t('friends.storageError')}</p>}
                {error && !details && <p role="alert" className="oc-home-empty break-words text-[var(--status-error-text)]">{error}</p>}
                {cards.length ? <HomeFriendCards friends={cards} busyAgent={busyAgent}
                    onOpen={id => void talk(id, false)} onNew={id => void talk(id, true)}
                    onCustomize={openCustomize} onDetails={(id, origin) => setDetails({ agent: id, origin })} />
                    : <p className="oc-home-empty" role="status">{catalog?.scope === scope ? t('friends.empty') : t('common.loading')}</p>}
            </>}
        <HomeFriendDetails target={details && detailAgent ? { agent: detailAgent, name: friendName(profiles, detailAgent), appearance: friendAppearance(profiles, detailAgent.name), origin: details.origin } : null}
            project={project} runtime={runtime} configuration={catalog?.scope === scope ? catalog.configuration : undefined}
            busy={Boolean(busyAgent)} error={error}
            onClose={() => setDetails(null)} onTalk={(id, fresh) => void talk(id, fresh)} onCustomize={openCustomize} onManage={manage}>
            {detailAgent && customizeDialog}
        </HomeFriendDetails>
        {!detailAgent && customizeDialog}
    </section>;
}
