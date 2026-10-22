import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { SettingsCheckboxRow, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { readAiTaskStatus, readAiTaskProjects, assignAiTask, readAiTaskDetails, configureAiTasks, checkAiTasks, readAiTaskBoard, createAiTask, readAiTaskNotes, saveAiTaskNotes, createAiTaskBoard, moveAiTask, deleteAiTask, personalHomeSupported, type HomeNotionBoard, type AiTaskModel } from '@/lib/personal-home';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useAllChatsFriendName } from '@/hooks/useAllChatsFriendName';
import { HomeAiTaskList } from './HomeAiTaskList';
import { HomeTaskComposer } from './HomeTaskComposer';

const READY = 'Ready for AI';
// The host's built-in folderless destination; its chats appear in All Chats.
const ALL_CHATS = 'openchamber:all-chats';
const modelKey = (model: AiTaskModel) => `${model.providerID}/${model.id}`;
// Provider names are product names, so they are not translated.
const providerNames = new Map([['openai', 'ChatGPT'], ['openrouter', 'OpenRouter'], ['opencode', 'OpenCode'], ['anthropic', 'Claude'], ['claude-code', 'Claude']]);
const modelLabel = (model: AiTaskModel & { name: string }) => `${providerNames.get(model.providerID) ?? model.providerID} · ${model.name}`;
// The last model chosen for a folder is a convenience default, never an authorization.
const rememberedModel = z.object({ providerID: z.string().min(1), id: z.string().min(1) });
const rememberedKey = (projectId: string) => `open-carter:ai-task-model:v1:${projectId}`;
const readRemembered = (projectId: string): AiTaskModel | undefined => {
    try {
        const parsed = rememberedModel.safeParse(JSON.parse(localStorage.getItem(rememberedKey(projectId)) ?? 'null'));
        return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
};
const remember = (projectId: string, model: AiTaskModel) => {
    try { localStorage.setItem(rememberedKey(projectId), JSON.stringify(model)); } catch { /* the explicit per-card choice is already saved */ }
};

export function HomeAiTasks({ active = true }: { active?: boolean }) {
    const { t } = useI18n();
    // A task with no folder goes to All Chats, so the picker says the friend's
    // name rather than asking for a folder that was never needed.
    const allChatsName = useAllChatsFriendName() ?? t('home.aiNoFolder');
    const projectLabel = (project: { id: string; label?: string }) => project.id === ALL_CHATS ? allChatsName : project.label ?? '';
    const blocked = useEnterpriseMode();
    const networkBlocked = useEnterprisePolicyStore((state) => state.networkAccessBlocked);
    const [status, setStatus] = React.useState<Awaited<ReturnType<typeof readAiTaskStatus>> | null>(null);
    // A successful assignment acknowledgement is authoritative even when the
    // following status read fails. Never replace it with the pre-write snapshot.
    const [confirmedAssignments, setConfirmedAssignments] = React.useState<Map<string, { page: string; projectId: string; model: AiTaskModel }>>(() => new Map());
    const [board, setBoard] = React.useState<HomeNotionBoard | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [slow, setSlow] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);
    const [projectsError, setProjectsError] = React.useState('');
    const [deleting, setDeleting] = React.useState<{ page: string; title: string } | null>(null);
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const [config, setConfig] = React.useState({ board: '', model: '', enabled: false });
    const [draft, setDraft] = React.useState('');
    const [projects, setProjects] = React.useState<Awaited<ReturnType<typeof readAiTaskProjects>>>([]);
    const [runId, setRunId] = React.useState<string | null>(null);
    const [details, setDetails] = React.useState<Awaited<ReturnType<typeof readAiTaskDetails>> | null>(null);
    const [detailsError, setDetailsError] = React.useState('');
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    // The card's Notion page body is the manager's brief. `send` means the user
    // asked to hand the card off and is confirming its notes first.
    const [notes, setNotes] = React.useState<{ page: string; title: string; text: string; editable: boolean; loaded: boolean; send: boolean } | null>(null);
    const revision = React.useRef(0);
    const pending = React.useRef(false);
    const signature = React.useRef('');
    const refreshSequence = React.useRef(0);
    const refreshPending = React.useRef<Promise<void> | null>(null);
    const projectsPending = React.useRef<Promise<void> | null>(null);
    const catalogSequence = React.useRef(0);
    const allowed = personalHomeSupported() && !blocked && !networkBlocked;
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
    React.useEffect(() => {
        if (!busy && !refreshing) { setSlow(false); return; }
        const timer = window.setTimeout(() => setSlow(true), 15_000);
        return () => window.clearTimeout(timer);
    }, [busy, refreshing]);
    const refresh = React.useCallback((force = false) => {
        if (refreshPending.current) return refreshPending.current;
        const sequence = ++refreshSequence.current;
        const version = revision.current;
        const owner = getRuntimeKey();
        const current = () => sequence === refreshSequence.current && version === revision.current && owner === getRuntimeKey();
        setRefreshing(true);
        // The model catalog may wait for OpenCode readiness. It must never
        // hold the Notion board's first paint or erase a successful board read.
        if (!projectsPending.current) {
            const catalog = catalogSequence.current;
            const catalogCurrent = () => catalog === catalogSequence.current && owner === getRuntimeKey();
            const request = readAiTaskProjects().then((next) => {
                if (catalogCurrent()) { setProjects(next); setProjectsError(''); }
            }).catch((failure: Error) => { if (catalogCurrent()) setProjectsError(failure.message); }).finally(() => {
                if (projectsPending.current === request) projectsPending.current = null;
            });
            projectsPending.current = request;
        }
        const request = (async () => {
            const next = await readAiTaskStatus();
            if (!current()) return;
            // Setup is local authority. A slow or broken Notion board must not
            // prevent the user from opening setup to repair its configuration.
            setStatus(next);
            setConfirmedAssignments(new Map());
            if (!next.config.board) setBoard(null);
            const nextSignature = JSON.stringify([next.config, next.runs, next.lastCheckedAt]);
            const nextBoard = next.config.board && (force || signature.current !== nextSignature) ? await readAiTaskBoard() : undefined;
            if (!current()) return;
            if (nextBoard) setBoard(nextBoard);
            signature.current = nextSignature;
            setError('');
        })().finally(() => {
            if (refreshPending.current === request) { refreshPending.current = null; setRefreshing(false); }
        });
        refreshPending.current = request;
        return request;
    }, []);
    React.useEffect(() => {
        revision.current += 1;
        catalogSequence.current += 1;
        refreshPending.current = null; projectsPending.current = null;
        setConfirmedAssignments(new Map());
        setRefreshing(false); setStatus(null); setBoard(null); setError(''); setProjectsError(''); setProjects([]); setRunId(null); setDetails(null); setNotes(null); setDeleting(null); signature.current = '';
    }, [allowed, runtime]);
    React.useEffect(() => {
        if (!allowed || !active) return;
        let disposed = false;
        const update = (force = false) => {
            if (pending.current) return;
            const version = revision.current;
            void refresh(force).catch((failure: Error) => { if (!disposed && version === revision.current) setError(failure.message); });
        };
        update();
        const warmup = window.setTimeout(() => update(true), 3_500);
        const timer = window.setInterval(() => update(), 30_000);
        return () => { disposed = true; revision.current += 1; catalogSequence.current += 1; refreshPending.current = null; projectsPending.current = null; window.clearTimeout(warmup); window.clearInterval(timer); };
    }, [allowed, active, runtime, refresh]);
    React.useEffect(() => {
        setDetails(null); setDetailsError('');
        if (!runId || !allowed || !active) return;
        let disposed = false;
        const owner = getRuntimeKey();
        const timer = window.setTimeout(() => { if (!disposed) setDetailsError(t('home.aiSlow')); }, 15_000);
        void readAiTaskDetails(runId).then((next) => {
            if (!disposed && owner === getRuntimeKey()) { setDetails(next); setDetailsError(''); }
        }).catch((failure: Error) => { if (!disposed && owner === getRuntimeKey()) setDetailsError(failure.message); }).finally(() => window.clearTimeout(timer));
        return () => { disposed = true; window.clearTimeout(timer); };
    }, [runId, runtime, allowed, active, t]);
    const refreshWithError = () => {
        const version = revision.current;
        const owner = getRuntimeKey();
        void refresh(true).catch((failure) => {
            if (version === revision.current && owner === getRuntimeKey()) setError(failure instanceof Error ? failure.message : String(failure));
        });
    };
    const run = async (action: () => Promise<void>) => {
        if (pending.current) return;
        pending.current = true; revision.current += 1; setBusy(true); setError('');
        const version = revision.current;
        const owner = getRuntimeKey();
        try {
            await action();
            // The mutation is complete. Release its controls without waiting
            // for an unrelated Notion read, which can fail independently.
            if (version === revision.current && owner === getRuntimeKey()) {
                // An older read cannot overwrite this mutation. Finish that
                // read before fetching its replacement, never overlap polls.
                const previous = refreshPending.current ?? Promise.resolve();
                const update = () => { if (version === revision.current && owner === getRuntimeKey()) refreshWithError(); };
                void previous.then(update, update);
            }
        } catch (failure) {
            if (version === revision.current && owner === getRuntimeKey()) setError(failure instanceof Error ? failure.message : String(failure));
        } finally { pending.current = false; setBusy(false); }
    };
    const openNotes = (page: string, title: string) => run(async () => {
        setNotes({ page, title, text: '', editable: false, loaded: false, send: false });
        const owner = getRuntimeKey();
        const saved = await readAiTaskNotes(page);
        if (owner !== getRuntimeKey()) return;
        setNotes((current) => current?.page === page ? { ...current, text: saved.notes, editable: saved.editable, loaded: true } : current);
    });
    const chooseModel = (projectId: string, preferred?: AiTaskModel) => {
        const project = projects.find((item) => item.id === projectId);
        const remembered = readRemembered(projectId);
        const approved = (candidate?: AiTaskModel) => candidate && project?.models.find((item) => modelKey(item) === modelKey(candidate));
        const model = approved(preferred) || approved(remembered) || project?.models.find((item) => item.default);
        if (!model) throw new Error(t('chat.modelControls.metadataUnavailable'));
        return { providerID: model.providerID, id: model.id };
    };
    const saveAssignment = async (page: string, projectId: string, model: AiTaskModel) => {
        const owner = getRuntimeKey();
        const version = revision.current;
        await assignAiTask(page, projectId, model);
        if (owner !== getRuntimeKey() || version !== revision.current) throw new Error(t('chat.modelControls.metadataUnavailable'));
        setConfirmedAssignments((current) => new Map(current).set(page, { page, projectId, model }));
    };
    const ensureAssignment = async (page: string) => {
        const assignment = confirmedAssignments.get(page) ?? status?.assignments.find((item) => item.page === page);
        if (assignment?.model) {
            const project = projects.find((item) => item.id === assignment.projectId);
            if (!project?.models.some((item) => modelKey(item) === modelKey(assignment.model!))) throw new Error(t('chat.modelControls.metadataUnavailable'));
            return;
        }
        const projectId = assignment?.projectId ?? ALL_CHATS;
        if (!assignment && !projects.some((item) => item.id === ALL_CHATS && item.models.length)) throw new Error(t('home.aiChooseProjectFirst'));
        await saveAssignment(page, projectId, chooseModel(projectId));
    };
    const saveNotes = (send: boolean) => notes && void run(async () => {
        if (send) await ensureAssignment(notes.page);
        if (notes.text.trim() || !send) await saveAiTaskNotes(notes.page, notes.text);
        if (send) await moveAiTask(notes.page, READY);
        setNotes(null);
    });
    const moveTask = (page: string, destination: string) => void run(async () => {
        // Moving to Send to manager authorizes the card; the host starts pickup immediately.
        if (destination !== READY) { await moveAiTask(page, destination); return; }
        await ensureAssignment(page);
        // Confirm the brief first: a card with no notes opens its notes instead.
        const saved = await readAiTaskNotes(page);
        if (saved.notes) { await moveAiTask(page, destination); return; }
        setNotes({ page, title: board?.rows.find((row) => row.url === page)?.title ?? '', text: '', editable: saved.editable, loaded: true, send: true });
    });
    if (!allowed) return active ?<p className="oc-home-empty">{t(blocked || networkBlocked ? 'home.blocked' : 'home.desktopOnly')}</p> : null;
    const phaseLabel = (phase: NonNullable<typeof status>['runs'][number]['phase']) => {
        if (phase === 'done') return t('home.aiDone');
        if (phase === 'needs-you') return t('home.aiNeedsYou');
        if (phase === 'cancelled') return t('home.aiCancelled');
        return t('home.aiWorking');
    };
    return <section hidden={!active} className="oc-home-task-panel">
        <div className="oc-home-card-heading oc-ai-heading">
            <h2>{t('home.aiTitle')}</h2>
            <div className="ml-auto flex shrink-0 flex-wrap gap-1">
                <Button size="xs" variant="ghost" disabled={busy || !status?.config.enabled} onClick={() => void run(async () => { await checkAiTasks(); })}>{t('home.aiCheck')}</Button>
                <Button size="xs" variant="ghost" disabled={busy || refreshing} onClick={refreshWithError}>{t('home.refresh')}</Button>
                <Button size="xs" variant="ghost" disabled={busy || !status} onClick={() => { setConfig(status?.config ?? config); setSettingsOpen(true); }}>{t('home.aiSetup')}</Button>
            </div>
        </div>
        {board && <div className="oc-ai-composer"><HomeTaskComposer value={draft} onChange={setDraft} disabled={busy} onSubmit={() => void run(async () => { await createAiTask(draft.trim()); setDraft(''); })} /></div>}
        <p className="oc-home-empty text-[11px]" role="status">{refreshing ? t(board ? 'home.aiRefreshing' : 'home.aiLoading') : status ? t(status.config.enabled ? 'home.aiActive' : 'home.aiPaused') : error ? '' : t('common.loading')}</p>
        {slow && <p role="status" className="oc-home-empty">{t('home.aiSlow')}</p>}
        {(error || status?.error || projectsError) && <div className="oc-home-task-error"><p role="alert">{error || status?.error || projectsError}</p><Button size="xs" variant="outline" disabled={busy || refreshing} onClick={refreshWithError}>{t('home.refresh')}</Button></div>}
        {refreshing && !board && <div className="oc-home-task-skeleton" aria-hidden="true"><div /><div /><div /></div>}
        {status && !status.config.board && <><p className="oc-home-empty">{t('home.aiInstructions')}</p>
            <Button size="sm" variant="outline" disabled={busy || !status || status.provisioning} onClick={() => void run(async () => { await createAiTaskBoard(); })}>{t('home.aiCreateBoard')}</Button>
        </>}
        {board && <HomeAiTaskList board={board} disabled={busy} folded={['Done', 'Parked']} columnLabel={(column) => column === READY ? t('home.aiSendToManager') : column} onMove={moveTask}
            renderAction={(row) => ['Idea', 'Parked', 'Needs you'].includes(row.status ?? '') && board.columns.includes(READY)
                ? <Button size="xs" variant="outline" disabled={busy} onClick={() => moveTask(row.url, READY)}><Icon name="send-plane" className="size-3.5" />{t('home.aiSend')}</Button> : null}
            renderTask={(row) => {
                const assignment = confirmedAssignments.get(row.url) ?? status?.assignments.find((item) => item.page === row.url);
                const project = projects.find((item) => item.id === assignment?.projectId);
                const runs = status?.runs.filter((item) => item.page === row.url) ?? [];
                const latest = runs.at(-1);
                const active = runs.some((item) => !['done', 'needs-you', 'cancelled'].includes(item.phase));
                const model = assignment?.model && project?.models.find((item) => modelKey(item) === modelKey(assignment.model!));
                const fallback = project?.models.find((item) => item.default);
                return <>
                    <a href={row.url} target="_blank" rel="noreferrer" dir="auto" className="oc-ai-task-title">{row.title || t('home.untitled')}</a>
                    <div className="oc-ai-task-meta">
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void openNotes(row.url, row.title ?? '')}><Icon name="sticky-note" className="size-3.5" />{t('home.aiNotes')}</Button>
                        <Button size="icon" variant="ghost" className="size-6" disabled={busy || active || row.status === 'Doing' || !status} aria-label={t('home.aiDelete')} title={t(active || row.status === 'Doing' ? 'home.aiDeleteActive' : 'home.aiDelete')} onClick={() => { setError(''); setDeleting({ page: row.url, title: row.title || t('home.untitled') }); }}><Icon name="delete-bin" className="size-3.5" /></Button>
                        <Select value={project?.id ?? ''} disabled={busy || active || !projects.length} onValueChange={(projectId) => void run(async () => {
                            await saveAssignment(row.url, projectId, chooseModel(projectId, assignment?.model));
                        })}>
                            <SelectTrigger size="settings" className="oc-ai-task-select" aria-label={t('home.aiProject')}><SelectValue placeholder={allChatsName}>{project ? projectLabel(project) : allChatsName}</SelectValue></SelectTrigger>
                            <SelectContent>{projects.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.models.length}>{item.models.length ? projectLabel(item) : t('home.aiNoTeam', { folder: projectLabel(item) })}</SelectItem>)}</SelectContent>
                        </Select>
                        {project && <Select value={model ? modelKey(model) : ''} disabled={busy || active || !project.models.length} onValueChange={(key) => void run(async () => {
                            const chosen = project.models.find((item) => modelKey(item) === key);
                            if (!chosen) throw new Error(t('chat.modelControls.metadataUnavailable'));
                            const selected = { providerID: chosen.providerID, id: chosen.id };
                            await saveAssignment(row.url, project.id, selected);
                            remember(project.id, selected);
                        })}>
                            <SelectTrigger size="settings" className="oc-ai-task-select" aria-label={t('home.aiModel')} aria-invalid={!!assignment?.model && !model}><SelectValue placeholder={t('home.aiModel')}>{model ? modelLabel(model) : assignment?.model ? `${modelKey(assignment.model)} · ${t('chat.modelControls.metadataUnavailable')}` : fallback ? t('home.aiDefaultModel', { model: modelLabel(fallback) }) : t('home.aiModel')}</SelectValue></SelectTrigger>
                            <SelectContent>{project.models.map((item) => <SelectItem key={modelKey(item)} value={modelKey(item)}>{modelLabel(item)}</SelectItem>)}</SelectContent>
                        </Select>}
                        {latest && <Button size="xs" variant="ghost" className={cn(latest.phase === 'needs-you' && 'text-destructive')} onClick={() => setRunId(latest.id)}>{phaseLabel(latest.phase)} · {t('home.aiDetails')}</Button>}
                    </div>
                </>;
            }} />}
        {board && !board.rows.length && <p className="oc-home-empty">{t('home.aiEmpty')}</p>}
        {!!status?.runs.length && <details className="oc-ai-history">
            <summary>{t('home.aiRunHistory', { count: status.runs.length })}</summary>
            {status.runs.slice().reverse().map((item) => <div key={item.id} className="flex min-w-0 items-center gap-2 py-0.5 text-xs">
                <Button size="xs" variant="link" className="min-w-0 flex-1 justify-start truncate" onClick={() => setRunId(item.id)}>{item.title}</Button>
                <span className="shrink-0 text-muted-foreground">{phaseLabel(item.phase)}</span>
                <Button size="xs" variant="ghost" onClick={() => setRunId(item.id)}>{t('home.aiDetails')}</Button>
            </div>)}
        </details>}
        <Dialog open={active && runId !== null} onOpenChange={(open) => { if (!open) setRunId(null); }}><DialogContent className="max-h-[80dvh] overflow-y-auto"><DialogHeader><DialogTitle>{details?.run.title || t('home.aiDetails')}</DialogTitle><DialogDescription>{details?.run.projectLabel || t('home.aiProjectDefaults')}</DialogDescription></DialogHeader>
            {detailsError && <p role="alert" className="break-words text-sm text-destructive">{detailsError}</p>}
            {!details && !detailsError && <p role="status">{t('common.loading')}</p>}
            {details && <div className="space-y-3 text-sm leading-relaxed">
                <p>{phaseLabel(details.run.phase)}</p>
                {details.run.model && <p dir="ltr" className="text-xs text-muted-foreground">{providerNames.get(details.run.model.providerID) ?? details.run.model.providerID} · {details.run.model.id}</p>}
                <p dir="ltr" className="break-all text-xs text-muted-foreground">{details.run.id}</p>
                {[details.run.failure, details.run.writebackFailure].map((failure, index) => failure && <p key={index} role="alert" dir="auto" className="break-words text-destructive">{t('home.aiFailureStage', { stage: failure.stage, code: failure.code })} {failure.message}</p>)}
                {details.run.sessionId && details.run.directory ? <Button size="sm" variant="outline" onClick={() => {
                    const { sessionId, directory } = details.run;
                    if (sessionId && directory) { setRunId(null); useSessionUIStore.getState().setCurrentSession(sessionId, directory); }
                }}>{t('home.aiOpenChat')}</Button> : <p>{t('home.aiNoChat')}</p>}
                {details.children.kind === 'failed' ? <p role="alert" className="text-destructive">{details.children.failure.message}</p> : details.children.items.map((child) => <Button key={child.id} size="sm" variant="ghost" className="block max-w-full truncate" onClick={() => { setRunId(null); useSessionUIStore.getState().setCurrentSession(child.id, child.directory); }}>{child.title}</Button>)}
                {details.run.content && <p dir="auto" className="whitespace-pre-wrap break-words">{details.run.content}</p>}
                <a href={details.run.page} target="_blank" rel="noreferrer" className="inline-block break-all underline">{t('home.aiOpenTask')}</a>
            </div>}
        </DialogContent></Dialog>
        <Dialog open={active && deleting !== null} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent role="alertdialog" showCloseButton={!busy}><DialogHeader><DialogTitle>{t('home.aiDeleteTitle')}</DialogTitle><DialogDescription>{t('home.aiDeleteDescription', { title: deleting?.title ?? '' })}</DialogDescription></DialogHeader>
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>{t('home.aiDeleteCancel')}</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => deleting && void run(async () => {
                const owner = getRuntimeKey();
                const version = revision.current;
                await deleteAiTask(deleting.page);
                if (owner !== getRuntimeKey() || version !== revision.current) return;
                setBoard((current) => current ? { ...current, rows: current.rows.filter((row) => row.url !== deleting.page) } : current);
                setDeleting(null);
            })}>{busy ? t('common.loading') : t('home.aiDeleteConfirm')}</Button></div>
        </DialogContent></Dialog>
        <Dialog open={active && notes !== null} onOpenChange={(open) => { if (!open && !busy) setNotes(null); }}><DialogContent><DialogHeader><DialogTitle dir="auto">{notes?.title || t('home.aiNotesTitle')}</DialogTitle><DialogDescription>{t('home.aiNotesHint')}</DialogDescription></DialogHeader>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('home.aiReferenceHint')}</p>
            {notes && !notes.loaded && <p role="status">{t('common.loading')}</p>}
            {notes && !notes.loaded && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {notes?.loaded && <div className="space-y-3">
                {!notes.editable && <p role="status" className="text-sm text-muted-foreground">{t('home.aiNotesLocked')}</p>}
                {notes.send && !notes.text.trim() && <p role="status" className="text-sm text-muted-foreground">{t('home.aiNotesEmpty')}</p>}
                <Textarea dir="auto" rows={10} maxLength={100000} value={notes.text} disabled={busy || !notes.editable} aria-label={t('home.aiNotesTitle')} placeholder={t('home.aiReferencePlaceholder')} onChange={(event) => setNotes({ ...notes, text: event.target.value })} />
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                {notes.editable && <div className="flex flex-wrap justify-end gap-2">
                    {notes.send && !notes.text.trim() && <Button size="sm" variant="ghost" disabled={busy} onClick={() => saveNotes(true)}>{t('home.aiNotesSendTitle')}</Button>}
                    <Button size="sm" variant={notes.send ? 'outline' : 'default'} disabled={busy} onClick={() => saveNotes(false)}>{t('home.aiNotesSave')}</Button>
                    {status?.assignments.some((item) => item.page === notes.page) && <Button size="sm" disabled={busy || !notes.text.trim()} onClick={() => saveNotes(true)}>{t('home.aiNotesSaveSend')}</Button>}
                </div>}
            </div>}
        </DialogContent></Dialog>
        <Dialog open={active && settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogHeader><DialogTitle>{t('home.aiSetup')}</DialogTitle><DialogDescription>{t('home.aiInstructions')}</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={(event) => {
                event.preventDefault();
                void run(async () => { await configureAiTasks(config); setSettingsOpen(false); });
            }}>
                <SettingsStackedField label={t('home.aiDatabase')}><Input required={config.enabled} maxLength={2000} value={config.board} disabled={busy} aria-label={t('home.aiDatabase')} onChange={(event) => setConfig({ ...config, board: event.target.value })} /></SettingsStackedField>
                <p className="text-xs leading-relaxed text-muted-foreground">{t('home.aiProjectDefaults')}</p>
                <SettingsCheckboxRow checked={config.enabled} disabled={busy} onChange={(enabled) => setConfig({ ...config, enabled })} label={t('home.aiEnable')} />
                <p className="text-xs leading-relaxed text-muted-foreground">{t('home.aiDisclosure')}</p>
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                <Button type="submit" disabled={busy}>{busy ? t('common.loading') : t('home.save')}</Button>
            </form>
        </DialogContent></Dialog>
    </section>;
}
