import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectRulesKind, ProjectRulesSnapshot } from '@/lib/api/project-rules-schema';
import type { ProjectEntry } from '@/lib/api/types';
import {
    buildGuardrailPoliciesAndPermissions,
    summarizeFolderGuardrails,
    type FolderGuardrailEffect,
    type FolderGuardrailState,
    type FriendAppearance,
} from '@/lib/friends';
import { useI18n } from '@/lib/i18n';
import type { opencodeClient } from '@/lib/opencode/client';
import type { Agent, Session } from '@/lib/opencode/model';
import { clearProviderBindingCache } from '@/lib/projectProviderBinding';
import { morphFrom } from '@/lib/motion';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { HomeFriendAvatar } from './HomeFriendAvatar';
import { HomeFriendsWork } from './HomeFriendsWork';
import { FriendMemorySection } from './FriendMemorySection';

type RulesConfiguration = Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>>;
export type FriendDetailsTarget = {
    agent: Agent;
    name: string;
    role?: string;
    appearance: FriendAppearance;
    origin: DOMRect | null;
    allAgents?: Agent[];
    specialists?: Agent[];
    sessions?: Session[];
};

function MarkdownRuleSection({
    directory,
    kind,
    title,
    hint,
    placeholder,
}: {
    directory: string;
    kind: Extract<ProjectRulesKind, 'instructions' | 'memory'>;
    title: string;
    hint: string;
    placeholder: string;
}) {
    const { files } = useRuntimeAPIs();
    const { t } = useI18n();
    const [snapshot, setSnapshot] = React.useState<ProjectRulesSnapshot | null>(null);
    const [draft, setDraft] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState<'idle' | 'saved' | 'error'>('idle');

    React.useEffect(() => {
        let alive = true;
        setSnapshot(null); setStatus('idle');
        if (!files.readProjectRules) { setStatus('error'); return; }
        void files.readProjectRules(directory, kind).then(value => {
            if (!alive) return;
            setSnapshot(value);
            setDraft(value.content);
        }).catch(() => { if (alive) setStatus('error'); });
        return () => { alive = false; };
    }, [directory, files, kind]);

    const dirty = Boolean(snapshot && draft !== snapshot.content);
    const save = async (restore = false) => {
        if (!snapshot || !files.saveProjectRules || busy) return;
        setBusy(true); setStatus('idle');
        try {
            const next = await files.saveProjectRules({
                directory,
                kind,
                expectedRevision: snapshot.revision,
                content: draft,
                settings: snapshot.settings,
                restore,
            });
            setSnapshot(next);
            setDraft(next.content);
            setStatus('saved');
        } catch {
            setStatus('error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <h4 className="text-xs font-semibold text-foreground">{title}</h4>
                    <p className="text-[11px] text-muted-foreground">{hint}</p>
                </div>
                <div className="flex items-center gap-1.5">
                    {snapshot?.previous && (
                        <Button size="xs" variant="ghost" disabled={busy || dirty} onClick={() => void save(true)}>
                            {t('personalTools.restore')}
                        </Button>
                    )}
                    <Button size="xs" variant={dirty ? 'default' : 'outline'} disabled={!snapshot || busy || !dirty} onClick={() => void save(false)}>
                        {busy ? t('common.loading') : status === 'saved' && !dirty ? 'Saved' : t('personalTools.save')}
                    </Button>
                </div>
            </div>
            {snapshot && <p className="break-all font-mono text-[10px] text-muted-foreground">{snapshot.path}</p>}
            {status === 'error' && <p role="alert" className="text-xs text-[var(--status-error-text)]">{t('personalTools.error')}</p>}
            {snapshot ? (
                <Textarea
                    value={draft}
                    disabled={busy}
                    placeholder={placeholder}
                    className="min-h-32 font-mono text-xs"
                    onChange={event => { setDraft(event.target.value); setStatus('idle'); }}
                />
            ) : status !== 'error' ? (
                <p role="status" className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : null}
        </section>
    );
}

const GUARDRAIL_ROWS: ReadonlyArray<{
    key: keyof Omit<FolderGuardrailState, 'zdrLocked' | 'allowedProviders'>;
    label: string;
    hint: string;
}> = [
    { key: 'computerUse', label: 'Virtual Computer (CarterBot)', hint: 'Linux desktop & browser screen launched on demand' },
    { key: 'macControl', label: 'Mac App Control', hint: 'Control local macOS apps via AppleScript / accessibility' },
    { key: 'browserControl', label: 'Browser Automation', hint: 'Playwright & Chrome DevTools automation' },
    { key: 'webAccess', label: 'Web Search & Fetch', hint: 'Public web search and URL fetching' },
    { key: 'fileAndShell', label: 'File Edits & Shell', hint: 'Local file modifications and terminal commands' },
    { key: 'externalDirectory', label: 'Outside Folder Access', hint: 'Read or transfer files outside this folder' },
    { key: 'subagents', label: 'Specialist Subagents', hint: 'Delegate bounded work or audits to folder specialists' },
];

function FolderGuardrailsStudio({
    project,
    primaryAgent,
    allAgents,
    configuration,
    onSaved,
}: {
    project: ProjectEntry;
    primaryAgent: Agent;
    allAgents: Agent[];
    configuration: RulesConfiguration | undefined;
    onSaved: () => void;
}) {
    const { files } = useRuntimeAPIs();
    const { t } = useI18n();
    const updateProjectMeta = useProjectsStore(s => s.updateProjectMeta);
    const initialSummary = React.useMemo(
        () => summarizeFolderGuardrails(configuration, primaryAgent, project.path),
        [configuration, primaryAgent, project.path],
    );

    const [snapshot, setSnapshot] = React.useState<ProjectRulesSnapshot | null>(null);
    const [agentName, setAgentName] = React.useState(project.defaultAgent || primaryAgent.name || 'operator');
    const [model, setModel] = React.useState(project.defaultModel || configuration?.defaultModel || '');
    const [guardrails, setGuardrails] = React.useState<FolderGuardrailState>(initialSummary);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState<'idle' | 'saved' | 'error'>('idle');

    React.useEffect(() => {
        setGuardrails(initialSummary);
        setAgentName(initialSummary.zdrLocked ? 'zdr' : (project.defaultAgent || primaryAgent.name || 'operator'));
        setModel(project.defaultModel || configuration?.defaultModel || (initialSummary.zdrLocked ? 'openrouter-zdr/anthropic/claude-sonnet-5' : ''));
    }, [initialSummary, project.defaultAgent, project.defaultModel, primaryAgent.name, configuration?.defaultModel]);

    React.useEffect(() => {
        let alive = true;
        if (!files.readProjectRules) return;
        void files.readProjectRules(project.path, 'configuration').then(value => {
            if (!alive) return;
            setSnapshot(value);
            if (value.settings.model) setModel(value.settings.model);
            if (value.settings.defaultAgent) setAgentName(value.settings.defaultAgent);
        }).catch(() => {});
        return () => { alive = false; };
    }, [files, project.path]);

    const selectableAgents = React.useMemo(() => {
        const list = allAgents.filter(item => !item.hidden && item.mode !== 'subagent');
        return list.length > 0 ? list : [primaryAgent];
    }, [allAgents, primaryAgent]);

    const toggleZdrLock = (locked: boolean) => {
        setStatus('idle');
        if (locked) {
            setAgentName('zdr');
            if (!model.startsWith('openrouter-zdr/')) {
                setModel('openrouter-zdr/anthropic/claude-sonnet-5');
            }
            setGuardrails({
                zdrLocked: true,
                allowedProviders: ['openrouter-zdr'],
                computerUse: 'deny',
                macControl: 'deny',
                browserControl: 'deny',
                webAccess: 'deny',
                fileAndShell: 'ask',
                externalDirectory: 'deny',
                subagents: 'deny',
            });
        } else {
            setAgentName('operator');
            setGuardrails({
                ...guardrails,
                zdrLocked: false,
                allowedProviders: [],
                computerUse: 'ask',
                macControl: 'ask',
                browserControl: 'ask',
                webAccess: 'allow',
                fileAndShell: 'ask',
                externalDirectory: 'ask',
                subagents: 'allow',
            });
        }
    };

    const saveGuardrails = async () => {
        if (!files.saveProjectRules || busy) return;
        setBusy(true); setStatus('idle');
        try {
            const currentSnap = snapshot ?? (files.readProjectRules ? await files.readProjectRules(project.path, 'configuration') : null);
            if (!currentSnap) throw new Error('Could not read folder configuration');
            const effectiveAgent = guardrails.zdrLocked ? 'zdr' : agentName;
            const effectiveModel = guardrails.zdrLocked && !model.startsWith('openrouter-zdr/')
                ? 'openrouter-zdr/anthropic/claude-sonnet-5'
                : model.trim();
            const built = buildGuardrailPoliciesAndPermissions(guardrails, currentSnap.settings.permissions ?? [], initialSummary);
            const next = await files.saveProjectRules({
                directory: project.path,
                kind: 'configuration',
                expectedRevision: currentSnap.revision,
                content: '',
                settings: {
                    model: effectiveModel,
                    defaultAgent: effectiveAgent,
                    share: guardrails.zdrLocked ? 'disabled' : currentSnap.settings.share,
                    policies: !guardrails.zdrLocked && guardrails.zdrLocked === initialSummary.zdrLocked
                        && JSON.stringify(guardrails.allowedProviders) === JSON.stringify(initialSummary.allowedProviders)
                        ? currentSnap.settings.policies : built.policies,
                    permissions: built.permissions,
                },
            });
            setSnapshot(next);
            updateProjectMeta(project.id, {
                defaultAgent: effectiveAgent || null,
                defaultModel: effectiveModel || null,
            });
            clearProviderBindingCache();
            setStatus('saved');
            onSaved();
        } catch {
            setStatus('error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-surface-subtle p-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-semibold text-foreground">
                        <Icon name="shield" className="size-3.5 text-primary" />
                        <span>Strict ZDR Endpoint Lock</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Pins this folder to <code className="font-mono">openrouter-zdr</code> (Zero Data Retention), blocks CarterBot, web tools, outside directories, and subagents.
                    </p>
                </div>
                <Button
                    type="button"
                    size="xs"
                    variant={guardrails.zdrLocked ? 'default' : 'outline'}
                    disabled={busy}
                    aria-pressed={guardrails.zdrLocked}
                    onClick={() => toggleZdrLock(!guardrails.zdrLocked)}
                >
                    {guardrails.zdrLocked ? 'Locked (ZDR)' : 'Enable ZDR Lock'}
                </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                    <span className="font-medium text-foreground">Folder Friend Agent</span>
                    <Select
                        value={guardrails.zdrLocked ? 'zdr' : agentName}
                        disabled={busy || guardrails.zdrLocked}
                        onValueChange={value => { setAgentName(value); setStatus('idle'); }}
                    >
                        <SelectTrigger size="sm" className="w-full">
                            <SelectValue>{guardrails.zdrLocked ? 'zdr (ZDR Locked)' : agentName}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {selectableAgents.map(item => (
                                <SelectItem key={item.name} value={item.name}>
                                    {item.displayName || item.name} ({item.name})
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </label>

                <label className="space-y-1">
                    <span className="font-medium text-foreground">{t('friends.model')}</span>
                    <Input
                        value={model}
                        disabled={busy}
                        placeholder={guardrails.zdrLocked ? 'openrouter-zdr/anthropic/claude-sonnet-5' : 'e.g. openai/gpt-6-astra'}
                        className="h-8 font-mono text-xs"
                        onChange={event => { setModel(event.target.value); setStatus('idle'); }}
                    />
                </label>
            </div>

            <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">Built-in Capability Guardrails</span>
                    <span className="text-[11px] text-muted-foreground">Launched on demand when the task needs them</span>
                </div>
                <div className="divide-y divide-border/50">
                    {GUARDRAIL_ROWS.map(row => {
                        const value = guardrails[row.key];
                        return (
                            <div key={row.key} className="flex items-center justify-between gap-2 py-2">
                                <div className="min-w-0">
                                    <div className="font-medium text-foreground">{row.label}</div>
                                    <div className="truncate text-[11px] text-muted-foreground">{row.hint}</div>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    {(['allow', 'ask', 'deny'] as const).map((effect: FolderGuardrailEffect) => (
                                        <Button
                                            key={effect}
                                            type="button"
                                            size="xs"
                                            variant={value === effect ? 'default' : 'ghost'}
                                            disabled={busy || (guardrails.zdrLocked && row.key !== 'fileAndShell')}
                                            className="h-6 px-2 text-[11px]"
                                            onClick={() => {
                                                setGuardrails({ ...guardrails, [row.key]: effect });
                                                setStatus('idle');
                                            }}
                                        >
                                            {effect === 'allow' ? 'Allow' : effect === 'ask' ? 'Ask' : 'Block'}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-muted-foreground">
                        {status === 'saved' ? 'Saved to folder guardrails & active immediately.' : status === 'error' ? t('personalTools.error') : t('friends.ruleOrder')}
                    </span>
                    <Button size="xs" disabled={busy} onClick={() => void saveGuardrails()}>
                        {busy ? t('common.loading') : 'Save Guardrails & Brain'}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** Unified Studio panel for one folder Friend: conversations, capabilities & guardrails, rules, memory, and team work. */
export function HomeFriendDetails({
    target,
    project,
    runtime,
    configuration,
    busy,
    error,
    onClose,
    onTalk,
    onSelectSession,
    onCustomize,
    onManage,
    onRefreshFolder,
    children,
}: {
    target: FriendDetailsTarget | null;
    project: ProjectEntry | undefined;
    runtime: string;
    configuration: RulesConfiguration | undefined;
    busy: boolean;
    error: string;
    onClose: () => void;
    onTalk: (agent: string, fresh: boolean) => void;
    onSelectSession?: (sessionId: string, directory: string) => void;
    onCustomize: (agent: string, origin: DOMRect | null) => void;
    onManage: (agent: string) => void;
    onRefreshFolder?: () => void;
    /** Dialogs opened from this panel, rendered inside it so they stack as nested dialogs. */
    children?: React.ReactNode;
}) {
    const { t } = useI18n();
    const popup = React.useRef<HTMLDivElement>(null);
    const origin = target?.origin ?? null;
    React.useEffect(() => {
        if (!origin) return;
        const frame = requestAnimationFrame(() => { morphFrom(popup.current, origin, 200); });
        return () => cancelAnimationFrame(frame);
    }, [origin]);
    const agent = target?.agent;
    const specialist = agent?.mode === 'subagent';
    const guardrails = React.useMemo(
        () => summarizeFolderGuardrails(configuration, agent, project?.path),
        [configuration, agent, project?.path],
    );
    const folderSessions = target?.sessions ?? [];
    const specialists = target?.specialists ?? [];

    return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose(); }}>
        <DialogContent ref={popup} layerClassName="justify-end p-3" className="oc-friend-details h-full max-h-full w-[min(580px,100%)] max-w-none gap-4 overflow-y-auto p-5">
            {target && agent && <>
                <DialogHeader className="flex-row items-center gap-3 pe-8 text-start">
                    <HomeFriendAvatar body={target.appearance.body} color={target.appearance.color} className="size-14 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <DialogTitle className="truncate text-lg">{target.name}</DialogTitle>
                            {guardrails.badges.map(badge => (
                                <span
                                    key={badge}
                                    className="rounded-full border border-border/70 bg-surface-subtle px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                                >
                                    {badge}
                                </span>
                            ))}
                        </div>
                        <DialogDescription className="truncate">
                            {target.role || agent.displayName} · {project?.label || project?.path}
                        </DialogDescription>
                    </div>
                </DialogHeader>
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy || specialist} onClick={() => onTalk(agent.name, false)}>
                        <Icon name="chat-3" className="size-3.5" />{t('friends.continue')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy || specialist} onClick={() => onTalk(agent.name, true)}>
                        <Icon name="chat-new" className="size-3.5" />{t('friends.newChat')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={event => onCustomize(agent.name, event.currentTarget.getBoundingClientRect())}>
                        <Icon name="palette" className="size-3.5" />{t('friends.customize')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onManage(agent.name)}>
                        <Icon name="settings-3" className="size-3.5" />{t('friends.manage')}
                    </Button>
                </div>
                {error && <p role="alert" className="break-words text-sm text-[var(--status-error-text)]">{error}</p>}
                <section className="space-y-1.5 text-sm">
                    <h3 className="oc-home-card-heading">{t('friends.about')}</h3>
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {agent.description || t('friends.noDescription')}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                        Every conversation started in <strong>{project?.label || 'this folder'}</strong> inherits {target.name}&apos;s built-in capabilities, folder rules (<code className="font-mono">AGENTS.md</code>), shared memory (<code className="font-mono">MEMORY.md</code>), and guardrails.
                    </p>
                </section>

                {project && folderSessions.length > 0 && (
                    <details className="oc-friend-section" open>
                        <summary>Conversations in this folder ({folderSessions.length})</summary>
                        <div className="space-y-1">
                            {folderSessions.slice(0, 6).map(session => (
                                <Button
                                    key={session.id}
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="oc-home-row flex w-full items-center justify-between text-xs"
                                    onClick={() => {
                                        onSelectSession?.(session.id, project.path);
                                        onClose();
                                    }}
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        <Icon name="chat-3" className="size-3.5 shrink-0 text-muted-foreground" />
                                        <span className="truncate">{session.title || 'Untitled conversation'}</span>
                                    </span>
                                    <Icon name="arrow-right" className="size-3.5 shrink-0 opacity-40" />
                                </Button>
                            ))}
                        </div>
                    </details>
                )}

                {project && (
                    <details className="oc-friend-section" open>
                        <summary>Brain, Capabilities &amp; Guardrails</summary>
                        <FolderGuardrailsStudio
                            key={project.id}
                            project={project}
                            primaryAgent={agent}
                            allAgents={target.allAgents ?? [agent]}
                            configuration={configuration}
                            onSaved={() => onRefreshFolder?.()}
                        />
                    </details>
                )}

                {project && (
                    <details className="oc-friend-section">
                        <summary>{t('friends.memory')}</summary>
                        <div className="pt-1">
                            <FriendMemorySection projectPath={project.path} />
                        </div>
                    </details>
                )}

                {project && (
                    <details className="oc-friend-section" open>
                        <summary>{t('friends.rules')} &amp; Memory</summary>
                        <div className="space-y-5 pt-1">
                            <MarkdownRuleSection
                                key={`instructions:${project.path}`}
                                directory={project.path}
                                kind="instructions"
                                title="Folder Rules & Personality (AGENTS.md)"
                                hint="Instructions, citation requirements, and workflow rules enforced on every conversation in this folder."
                                placeholder="Write rules, persona instructions, and workflow gates for this folder's Friend..."
                            />
                            <MarkdownRuleSection
                                key={`memory:${project.path}`}
                                directory={project.path}
                                kind="memory"
                                title="Shared Friend Memory (MEMORY.md)"
                                hint="Persistent facts, preferences, and project memory shared across all conversations in this folder."
                                placeholder="Add durable notes and memory for this folder's Friend..."
                            />
                        </div>
                    </details>
                )}

                <details className="oc-friend-section">
                    <summary>
                        {t('friends.work')}
                        {specialists.length > 0 ? ` & Specialists (${specialists.length})` : ''}
                    </summary>
                    <div className="space-y-4">
                        {specialists.length > 0 && (
                            <div className="space-y-1.5">
                                <h4 className="text-xs font-medium text-muted-foreground">Folder Specialists</h4>
                                <div className="flex flex-wrap gap-1.5">
                                    {specialists.map(sub => (
                                        <span
                                            key={sub.name}
                                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface-subtle px-2 py-1 text-xs"
                                            title={sub.description}
                                        >
                                            <Icon name="robot-2" className="size-3 text-muted-foreground" />
                                            <span>{sub.displayName || sub.name}</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {project && <HomeFriendsWork key={JSON.stringify([runtime, project.path])} runtime={runtime} projectId={project.id} />}
                    </div>
                </details>
                {children}
            </>}
        </DialogContent>
    </Dialog>;
}
