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
import type { Agent, Session } from '@/lib/opencode/model';
import type { ProjectEntry } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { personalHomeSupported } from '@/lib/personal-home';
import {
    OPEN_FRIEND_STUDIO_EVENT,
    folderFriendAppearance,
    folderFriendKey,
    folderFriendName,
    folderFriendRole,
    normalizeFolderKeyPath,
    readFriendLink,
    readFriendProfiles,
    resolveFolderPrimaryAgent,
    resolveFolderSpecialists,
    saveFriendProfile,
    summarizeFolderGuardrails,
    writeFriendLink,
    type FriendAppearance,
    type FriendLink,
    type FriendProfiles,
    type OpenFriendStudioDetail,
} from '@/lib/friends';
import { parseModelSelection } from '@/lib/modelIdentifier';
import { cn } from '@/lib/utils';
import { HomeFriendAvatar } from './HomeFriendAvatar';
import { HomeFriendCustomize, type FriendCustomizeTarget } from './HomeFriendCustomize';
import { HomeFriendDetails } from './HomeFriendDetails';

type FolderCatalog = {
    agents: Agent[];
    configuration: Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>>;
};
type FriendStatus = { kind: 'working' | 'retrying' | 'active' | 'unconfirmed' | 'about'; text: string };
export type FriendCard = {
    agent: string;
    name: string;
    role: string;
    appearance: FriendAppearance;
    status: FriendStatus;
    specialist: boolean;
    badges?: string[];
};
type Origin = DOMRect | null;

const SYNTHETIC_OPERATOR: Agent = {
    id: 'operator',
    name: 'operator',
    displayName: 'Operator',
    description: 'General-capable folder friend with built-in computer use, local tools, and memory — launched on demand under this folder’s rules and guardrails.',
    mode: 'all',
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
};

const SYNTHETIC_ZDR: Agent = {
    id: 'zdr',
    name: 'zdr',
    displayName: 'ZDR',
    description: 'Zero-data-retention legal friend locked strictly to openrouter-zdr endpoints and local confidential files.',
    mode: 'all',
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
};

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
                    {friend.badges && friend.badges.length > 0 && (
                        <span className="mt-0.5 flex flex-wrap gap-1">
                            {friend.badges.slice(0, 2).map(badge => (
                                <span
                                    key={badge}
                                    className="rounded border border-border/60 bg-surface-subtle px-1.5 py-0 text-[9.5px] font-medium leading-4 text-muted-foreground"
                                >
                                    {badge}
                                </span>
                            ))}
                        </span>
                    )}
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
                        <DropdownMenuItem onSelect={() => onDetails(friend.agent, originOf(friend.agent))}><Icon name="shield" className="size-3.5" />{t('friends.details')} &amp; Guardrails</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onCustomize(friend.agent, originOf(friend.agent))}><Icon name="palette" className="size-3.5" />{t('friends.customize')}</DropdownMenuItem>
                        {!friend.specialist && <DropdownMenuItem disabled={busy} onSelect={() => onNew(friend.agent)}><Icon name="chat-new" className="size-3.5" />{t('friends.newChat')}</DropdownMenuItem>}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>;
    })}</ul>;
}

const folderLabel = (item: Pick<ProjectEntry, 'label' | 'path'>) => item.label || item.path.split('/').pop() || item.path;

/** Widget header: 1-to-1 folder friends count + refresh, with optional folder selector for legacy tests. */
export function HomeFriendsHeader({ projects, project, loading, busy, onChooseFolder, onRefresh }: {
    projects: ProjectEntry[];
    project?: ProjectEntry | undefined;
    loading: boolean;
    busy: boolean;
    onChooseFolder?: (id: string) => void;
    onRefresh: () => void;
}) {
    const { t } = useI18n();
    return <div className="oc-home-card-heading oc-friends-heading">
        <h2 className="flex min-w-0 items-center gap-2">
            <Icon name="user-smile" className="size-3.5 shrink-0" />
            {t('friends.title')}
            {!onChooseFolder && projects.length > 0 && <span className="oc-home-count">{projects.length}</span>}
        </h2>
        {projects.length > 0 && <>
            {onChooseFolder ? (
                <Select value={project?.id ?? ''} disabled={busy} onValueChange={onChooseFolder}>
                    <SelectTrigger size="sm" className="oc-friends-folder ms-auto min-w-0 max-w-[14rem]" aria-label={t('friends.folder')}>
                        <Icon name="folder-3" className="size-3.5" />
                        <SelectValue placeholder={t('home.aiChooseProject')}>{project ? folderLabel(project) : undefined}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>{projects.map(item => <SelectItem key={item.id} value={item.id}>{folderLabel(item)}</SelectItem>)}</SelectContent>
                </Select>
            ) : (
                <span className="ms-auto text-[11px] font-normal text-muted-foreground">1 folder = 1 friend</span>
            )}
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

/** Friends widget on Home: each folder is its own Friend with built-in capabilities, rules, memory, and guardrails. */
export function HomeFriends() {
    const { t, locale } = useI18n();
    const projects = useProjectsStore(s => s.projects);
    const updateProjectMeta = useProjectsStore(s => s.updateProjectMeta);
    const statuses = useAllSessionStatuses();
    const liveSessions = useAllLiveSessions();
    const cachedSessions = useGlobalSessionsStore(s => s.activeSessions);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    const [catalogsByPath, setCatalogsByPath] = React.useState<Record<string, FolderCatalog>>({});
    const [profileError, setProfileError] = React.useState(false);
    const [profiles, setProfiles] = React.useState<FriendProfiles | null>(null);
    const [error, setError] = React.useState('');
    const [busyFolderId, setBusyFolderId] = React.useState('');
    const [refresh, setRefresh] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const [customize, setCustomize] = React.useState<FriendCustomizeTarget | null>(null);
    const [details, setDetails] = React.useState<{ projectId: string; origin: Origin } | null>(null);
    const [links, setLinks] = React.useState(new Map<string, FriendLink | null>());
    const sequence = React.useRef(0);
    const mutation = React.useRef(false);
    const supported = personalHomeSupported();

    const readProfiles = React.useCallback(() => {
        try { setProfiles(readFriendProfiles(localStorage, runtime)); setProfileError(false); } catch { setProfiles(null); setProfileError(true); }
    }, [runtime]);

    React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
        sequence.current += 1;
        const next = getRuntimeKey();
        setRuntime(next); setCatalogsByPath({}); setProfiles(null); setProfileError(false); setError(''); setBusyFolderId('');
        setCustomize(null); setDetails(null);
    }), []);

    React.useEffect(() => {
        if (!supported) return;
        readProfiles();
        const onStorage = () => readProfiles();
        const onVisible = () => { if (document.visibilityState === 'visible') setRefresh(value => value + 1); };
        const onOpenStudio = (event: Event) => {
            const custom = event as CustomEvent<OpenFriendStudioDetail>;
            if (custom.detail?.projectId) {
                setDetails({ projectId: custom.detail.projectId, origin: custom.detail.origin ?? null });
            }
        };
        window.addEventListener('storage', onStorage);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener(OPEN_FRIEND_STUDIO_EVENT, onOpenStudio);
        return () => {
            window.removeEventListener('storage', onStorage);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener(OPEN_FRIEND_STUDIO_EVENT, onOpenStudio);
        };
    }, [supported, readProfiles]);

    React.useEffect(() => {
        if (!projects.length || !supported) return;
        const token = ++sequence.current;
        const owner = getRuntimeKey();
        setLoading(true);
        void Promise.all(
            projects.map(async project => {
                const [items, configuration] = await Promise.all([
                    opencodeClient.listAgents(project.path),
                    opencodeClient.getRulesConfiguration(project.path),
                ]);
                return [project.path, { agents: items.filter(item => !item.hidden), configuration }] as const;
            }),
        ).then(entries => {
            if (token !== sequence.current || getRuntimeKey() !== owner) return;
            setCatalogsByPath(Object.fromEntries(entries));
            setError('');
        }).catch(failure => {
            if (token === sequence.current && owner === getRuntimeKey()) {
                setError(failure instanceof Error ? failure.message : t('personalTools.error'));
            }
        }).finally(() => {
            if (token === sequence.current) setLoading(false);
        });
        return () => { sequence.current += 1; setLoading(false); };
    }, [projects, supported, refresh, t]);

    const resolveProjectFriend = React.useCallback((project: ProjectEntry) => {
        const catalog = catalogsByPath[project.path];
        const fallbackAgent = /\bzdr\b/i.test(project.path) || /^\s*zdr\b/i.test(project.label ?? '') ? SYNTHETIC_ZDR : SYNTHETIC_OPERATOR;
        const primaryAgent = resolveFolderPrimaryAgent(project, catalog?.agents ?? [fallbackAgent], catalog?.configuration) ?? fallbackAgent;
        const guardrails = summarizeFolderGuardrails(catalog?.configuration, primaryAgent, project.path);
        const specialists = resolveFolderSpecialists(catalog?.agents ?? [], primaryAgent.name, guardrails.zdrLocked);
        const name = folderFriendName(profiles, project, primaryAgent);
        const role = folderFriendRole(profiles, project, primaryAgent, guardrails);
        const appearance = folderFriendAppearance(profiles, project.path, project.color, primaryAgent.name);
        return { catalog, primaryAgent, specialists, guardrails, name, role, appearance };
    }, [catalogsByPath, profiles]);

    const reloadLinks = React.useCallback(() => {
        const next = new Map<string, FriendLink | null>();
        for (const project of projects) {
            const { primaryAgent } = resolveProjectFriend(project);
            try {
                next.set(
                    project.id,
                    readFriendLink(localStorage, runtime, project.path, folderFriendKey(project.path))
                    ?? readFriendLink(localStorage, runtime, project.path, primaryAgent.name),
                );
            } catch {
                next.set(project.id, null);
            }
        }
        setLinks(next);
    }, [projects, resolveProjectFriend, runtime]);

    React.useEffect(() => {
        reloadLinks();
        window.addEventListener('storage', reloadLinks);
        return () => window.removeEventListener('storage', reloadLinks);
    }, [reloadLinks]);

    const sessionsByFolder = React.useMemo(() => {
        const byId = new Map<string, Session>(cachedSessions.map(session => [session.id, session]));
        for (const session of liveSessions) byId.set(session.id, session);
        const byFolder = new Map<string, Session[]>();
        for (const project of projects) {
            const normRoot = normalizeFolderKeyPath(project.path);
            const matching = [...byId.values()]
                .filter(session => {
                    if (session.parentID || session.time?.archived || !session.directory) return false;
                    const normDir = normalizeFolderKeyPath(session.directory);
                    return normDir === normRoot;
                })
                .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
            byFolder.set(project.id, matching);
        }
        return { byId, byFolder };
    }, [cachedSessions, liveSessions, projects]);

    const cards = React.useMemo<FriendCard[]>(() => {
        const now = Date.now();
        return projects.map(project => {
            const { primaryAgent, guardrails, name, role, appearance } = resolveProjectFriend(project);
            const link = links.get(project.id);
            const folderSessions = sessionsByFolder.byFolder.get(project.id) ?? [];
            const linkedSession = link?.state === 'ready' ? sessionsByFolder.byId.get(link.sessionId) : undefined;
            const activeSession = folderSessions.find(s => statuses[s.id] && statuses[s.id].type !== 'idle')
                ?? linkedSession
                ?? folderSessions[0];
            const live = activeSession ? statuses[activeSession.id] : undefined;
            const chatCount = folderSessions.length;
            const countSuffix = chatCount > 1 ? ` · ${chatCount} chats` : '';
            const status: FriendStatus = link?.state === 'creating'
                ? { kind: 'unconfirmed', text: t('friends.status.unconfirmed') }
                : live && live.type === 'retry'
                    ? { kind: 'retrying', text: `${t('friends.status.retrying')}${countSuffix}` }
                    : live && live.type !== 'idle'
                        ? { kind: 'working', text: `${t('friends.status.working')}${countSuffix}` }
                        : activeSession
                            ? { kind: 'active', text: `${t('friends.status.active', { time: relative(locale, activeSession.time.updated, now) })}${countSuffix}` }
                            : { kind: 'about', text: primaryAgent.description || t('friends.noDescription') };
            return {
                agent: project.id,
                name,
                role,
                appearance,
                status,
                specialist: false,
                badges: guardrails.badges,
            };
        });
    }, [projects, resolveProjectFriend, links, sessionsByFolder, statuses, locale, t]);

    const manage = (agentName: string, project?: ProjectEntry) => {
        const targetProject = project ?? (details ? projects.find(p => p.id === details.projectId) : projects[0]);
        if (!targetProject) return;
        const ui = useUIStore.getState();
        ui.setSettingsProjectPath(targetProject.path);
        ui.setSettingsPage('agents');
        useAgentsStore.getState().setSelectedAgent(agentName);
        ui.setSettingsDialogOpen(true);
        setDetails(null);
    };

    /** Continue reopens the folder's latest or linked conversation; `fresh` starts a new sub-conversation in that folder. */
    const talkInFolder = async (projectId: string, fresh: boolean) => {
        const project = projects.find(item => item.id === projectId);
        if (!project || mutation.current) return;
        const { name: display } = resolveProjectFriend(project);
        const owner = runtime;
        const directory = project.path;
        mutation.current = true;
        setBusyFolderId(projectId);
        setError('');
        const token = sequence.current;
        try {
            const [liveAgents, liveConfiguration] = await Promise.all([
                opencodeClient.listAgents(directory), opencodeClient.getRulesConfiguration(directory),
            ]);
            const resolvedLive = resolveFolderPrimaryAgent(project, liveAgents, liveConfiguration);
            if (!resolvedLive || resolvedLive.hidden || resolvedLive.mode === 'subagent') throw new Error(t('friends.changedChat'));
            const agentId = resolvedLive.name;
            const link = fresh ? null : (
                readFriendLink(localStorage, owner, directory, folderFriendKey(directory))
                ?? readFriendLink(localStorage, owner, directory, agentId)
            );
            if (link?.state === 'creating') throw new Error(t('friends.ambiguous'));

            const folderSessions = sessionsByFolder.byFolder.get(projectId) ?? [];
            let session: Session | undefined;
            if (!fresh) {
                if (link?.state === 'ready') {
                    try {
                        const candidate = await opencodeClient.getSession(link.sessionId, directory);
                        if (!candidate.time.archived && normalizeFolderKeyPath(candidate.directory) === normalizeFolderKeyPath(directory) && candidate.agent === agentId) session = candidate;
                    } catch {
                        // Fall back to the most recent active conversation in this folder.
                    }
                }
                if (!session && folderSessions.length > 0) {
                    const recent = folderSessions.find(item => item.agent === agentId);
                    if (recent) {
                        const candidate = await opencodeClient.getSession(recent.id, directory);
                        if (!candidate.time.archived && normalizeFolderKeyPath(candidate.directory) === normalizeFolderKeyPath(directory) && candidate.agent === agentId) session = candidate;
                    }
                }
            }

            if (!session) {
                const folderModel = parseModelSelection(project.defaultModel);
                const configModel = parseModelSelection(liveConfiguration.defaultModel);
                const chosen = folderModel ?? configModel;
                const model = folderModel
                    ? { providerID: folderModel.providerID, id: folderModel.modelID, variant: project.defaultVariant ?? folderModel.variant }
                    : resolvedLive?.model ?? (chosen ? { providerID: chosen.providerID, id: chosen.modelID, variant: chosen.variant } : undefined);
                if (getRuntimeKey() !== owner || token !== sequence.current) return;
                writeFriendLink(localStorage, owner, directory, folderFriendKey(directory), { state: 'creating' });
                reloadLinks();
                const chatNumber = folderSessions.length + 1;
                const title = fresh && chatNumber > 1
                    ? `${display} · #${chatNumber}`
                    : `${display} · ${project.label || project.path.split('/').pop()}`;
                session = await opencodeClient.createSession({ agent: agentId, model, title }, directory);
            }

            if (getRuntimeKey() !== owner || token !== sequence.current) return;
            if (normalizeFolderKeyPath(session.directory) !== normalizeFolderKeyPath(directory) || session.agent !== agentId || session.time.archived) throw new Error(t('friends.changedChat'));
            writeFriendLink(localStorage, owner, directory, folderFriendKey(directory), { state: 'ready', sessionId: session.id });
            reloadLinks();
            setDetails(null);
            useProjectsStore.getState().setActiveProject(project.id);
            useSessionUIStore.getState().setCurrentSession(session.id, directory);
        } catch (failure) {
            if (owner === getRuntimeKey() && token === sequence.current) {
                setError(failure instanceof Error ? failure.message : t('personalTools.error'));
            }
        } finally {
            mutation.current = false;
            if (owner === getRuntimeKey()) setBusyFolderId('');
        }
    };

    const openCustomizeForFolder = (projectId: string, origin: Origin) => {
        const project = projects.find(item => item.id === projectId);
        if (!project || !profiles) return;
        const { role, name, appearance } = resolveProjectFriend(project);
        setCustomize({
            agent: folderFriendKey(project.path),
            role,
            name,
            appearance,
            origin,
            folderLabel: project.label || project.path,
        });
    };

    const saveCustomize = (key: string, draft: { name: string; role?: string } & FriendAppearance) => {
        if (!profiles) throw new Error(t('friends.storageError'));
        const next = saveFriendProfile(localStorage, runtime, key, draft, profiles.revision);
        setProfiles(next);
        const matchingProject = projects.find(p => folderFriendKey(p.path) === key);
        if (matchingProject) {
            updateProjectMeta(matchingProject.id, { color: draft.color });
        }
        window.dispatchEvent(new Event('open-carter:friends-updated'));
    };

    const detailProject = details ? projects.find(item => item.id === details.projectId) : undefined;
    const detailFriend = detailProject ? resolveProjectFriend(detailProject) : null;
    const customizeDialog = <HomeFriendCustomize target={customize} onClose={() => setCustomize(null)} onSave={saveCustomize} />;

    return <section className="oc-friends" aria-busy={loading || undefined}>
        <HomeFriendsHeader
            projects={supported ? projects : []}
            loading={loading}
            busy={Boolean(busyFolderId)}
            onRefresh={() => setRefresh(value => value + 1)}
        />
        {!supported ? <p className="oc-home-empty">{t('home.desktopOnly')}</p>
            : !projects.length ? <p className="oc-home-empty">{t('friends.noFolders')}</p>
            : <>
                {profileError && <p role="alert" className="oc-home-empty text-[var(--status-error-text)]">{t('friends.storageError')}</p>}
                {error && !details && <p role="alert" className="oc-home-empty break-words text-[var(--status-error-text)]">{error}</p>}
                {cards.length ? <HomeFriendCards
                    friends={cards}
                    busyAgent={busyFolderId}
                    onOpen={projectId => void talkInFolder(projectId, false)}
                    onNew={projectId => void talkInFolder(projectId, true)}
                    onCustomize={openCustomizeForFolder}
                    onDetails={(projectId, origin) => setDetails({ projectId, origin })}
                /> : <p className="oc-home-empty" role="status">{t('common.loading')}</p>}
            </>}
        <HomeFriendDetails
            target={details && detailProject && detailFriend ? {
                agent: detailFriend.primaryAgent,
                name: detailFriend.name,
                role: detailFriend.role,
                appearance: detailFriend.appearance,
                origin: details.origin,
                allAgents: detailFriend.catalog?.agents ?? [detailFriend.primaryAgent],
                specialists: detailFriend.specialists,
                sessions: sessionsByFolder.byFolder.get(detailProject.id) ?? [],
            } : null}
            project={detailProject}
            runtime={runtime}
            configuration={detailFriend?.catalog?.configuration}
            busy={Boolean(busyFolderId)}
            error={error}
            onClose={() => setDetails(null)}
            onTalk={(_agent, fresh) => { if (detailProject) void talkInFolder(detailProject.id, fresh); }}
            onSelectSession={(sessionId, directory) => {
                if (detailProject) useProjectsStore.getState().setActiveProject(detailProject.id);
                useSessionUIStore.getState().setCurrentSession(sessionId, directory);
            }}
            onCustomize={(_agent, origin) => { if (detailProject) openCustomizeForFolder(detailProject.id, origin); }}
            onManage={agentName => manage(agentName, detailProject)}
            onRefreshFolder={() => setRefresh(value => value + 1)}
        >
            {detailProject && customizeDialog}
        </HomeFriendDetails>
        {!detailProject && customizeDialog}
    </section>;
}
