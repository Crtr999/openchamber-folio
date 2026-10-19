import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCheckboxRow, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import {
    personalHomeSupported, readAiTaskProjects, readTeamInbox, readTeamDetails, sendTeamMessage, acknowledgeTeam,
    proposeTeamRoutine, confirmTeamRoutine, pauseTeamRoutine, pauseTeamContinuation, readAiHostStatus, configureAiHost,
    TeamRuntimeUnavailableError, readTeamDraft, writeTeamDraft, reviseTeamRun, recoverTeamRun, type HomeTeamDetails,
} from '@/lib/personal-home';
import { HomeTeamRoutineForm, HomeTeamRoutineReview } from './HomeTeamRoutineForm';
import { HomeTeamRunDetails } from './HomeTeamRunDetails';

type MessageDraft = { text: string; requestId: string };
const failureMessage = (failure: Error | string) => failure instanceof Error ? failure.message : String(failure);

export function HomeTeamInbox({ active = true }: { active?: boolean }) {
    const { t, locale } = useI18n();
    const blocked = useEnterpriseMode();
    const networkBlocked = useEnterprisePolicyStore((state) => state.networkAccessBlocked);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    const [snapshotRuntime, setSnapshotRuntime] = React.useState(runtime);
    const [projectId, setProjectId] = React.useState('');
    const [focusedRunId, setFocusedRunId] = React.useState<string | null>(null);
    const [projects, setProjects] = React.useState<Awaited<ReturnType<typeof readAiTaskProjects>>>([]);
    const [inbox, setInbox] = React.useState<Awaited<ReturnType<typeof readTeamInbox>> | null>(null);
    const [details, setDetails] = React.useState<HomeTeamDetails | null>(null);
    const [host, setHost] = React.useState<Awaited<ReturnType<typeof readAiHostStatus>> | null>(null);
    const [error, setError] = React.useState('');
    const [mutationError, setMutationError] = React.useState('');
    const [draftStorageError, setDraftStorageError] = React.useState(false);
    const [hostError, setHostError] = React.useState('');
    const [detailsError, setDetailsError] = React.useState('');
    const [serviceReady, setServiceReady] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [snapshotAt, setSnapshotAt] = React.useState<number | null>(null);
    const [slow, setSlow] = React.useState(false);
    const [refreshRevision, setRefreshRevision] = React.useState(0);
    const [drafts, setDrafts] = React.useState<Map<string, MessageDraft>>(() => new Map());
    const generation = React.useRef(0);
    const readSequence = React.useRef(0);
    const mutationPending = React.useRef(false);
    const inboxRead = React.useRef<Promise<void> | null>(null);
    const detailRead = React.useRef<Promise<HomeTeamDetails> | null>(null);
    const allowed = personalHomeSupported() && !blocked && !networkBlocked;
    const visible = React.useRef(active && allowed);
    visible.current = active && allowed;
    const draftKey = JSON.stringify([runtime, projectId]);
    const draft = drafts.get(draftKey);
    const teammate = inbox?.find((row) => row.teammate.projectId === projectId)?.teammate;
    const teammateId = teammate?.id;
    const visibleDetails = details?.teammate.projectId === projectId && details.teammate.id === teammate?.id ? details : null;
    const canWrite = allowed && serviceReady && Boolean(projectId) && !busy;
    const interruptionPending = inbox?.some((row) => row.latestRun?.pausePending || row.latestRun?.failure?.stage === 'pause') || visibleDetails?.runs.some((run) => run.pausePending || run.failure?.stage === 'pause');
    const canDispatch = canWrite && !interruptionPending;
    const hostState = host && !hostError ? `${t(host.power.state === 'awake' ? 'home.teamAwake' : 'home.teamPause')} · ${t(host.coordinator.state === 'enabled' ? 'home.teamPickupsEnabled' : host.coordinator.state === 'paused' ? 'home.teamPickupsPaused' : 'home.teamUnavailable')}` : t('home.teamUnavailable');
    const teamWorkState = host && !hostError ? t(host.teamWork.state === 'required' ? 'home.teamWorkRequired' : host.teamWork.state === 'idle' ? 'home.teamWorkIdle' : 'home.teamUnavailable') : t('home.teamUnavailable');
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
    React.useEffect(() => {
        if (!loading && !busy) { setSlow(false); return; }
        const timer = window.setTimeout(() => setSlow(true), 15_000);
        return () => window.clearTimeout(timer);
    }, [loading, busy]);
    const refresh = React.useCallback(async () => {
        if (!visible.current || document.visibilityState === 'hidden' || mutationPending.current) return;
        if (inboxRead.current) return inboxRead.current;
        const sequence = ++readSequence.current;
        const version = generation.current;
        const owner = getRuntimeKey();
        const current = () => sequence === readSequence.current && version === generation.current && owner === getRuntimeKey();
        setLoading(true);
        // Native diagnostics and project discovery cannot hide a saved inbox.
        const pending = Promise.all([
            readTeamInbox().then((next) => { if (current()) { setInbox((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); setSnapshotAt(Date.now()); setServiceReady(true); setError(''); } }).catch((failure: Error) => { if (current()) { setServiceReady(false); setError(failureMessage(failure)); } }),
            readAiTaskProjects().then((next) => { if (current()) setProjects(next); }).catch((failure: Error) => { if (current()) setError(failureMessage(failure)); }),
            readAiHostStatus().then((next) => { if (current()) { setHost(next); setHostError(''); } }).catch((failure: Error) => { if (current()) setHostError(failureMessage(failure)); }),
        ]).then(() => {
            if (current()) { setLoading(false); setRefreshRevision((value) => value + 1); }
        }).finally(() => { if (inboxRead.current === pending) inboxRead.current = null; });
        inboxRead.current = pending;
        await pending;
    }, []);
    React.useEffect(() => {
        generation.current += 1;
        setSnapshotRuntime(runtime);
        setMutationError(''); setDraftStorageError(false);
        setInbox(null); setSnapshotAt(null); setDetails(null); setHost(null); setProjects([]); setProjectId(''); setServiceReady(false); setError(''); setHostError(''); setDetailsError(''); setLoading(false);
        return () => { generation.current += 1; };
    }, [runtime, allowed]);
    React.useEffect(() => {
        if (!active || !allowed) return;
        let disposed = false;
        let tickSequence = 0;
        let timer: number | undefined;
        const tick = async () => {
            const sequence = ++tickSequence;
            if (inboxRead.current) await inboxRead.current;
            if (disposed || sequence !== tickSequence) return;
            await refresh();
            if (!disposed && sequence === tickSequence && document.visibilityState !== 'hidden') timer = window.setTimeout(() => void tick(), 10_000);
        };
        const onVisible = () => {
            window.clearTimeout(timer);
            tickSequence += 1;
            readSequence.current += 1;
            if (document.visibilityState !== 'hidden') void tick();
        };
        void tick();
        document.addEventListener('visibilitychange', onVisible);
        return () => { disposed = true; window.clearTimeout(timer); readSequence.current += 1; document.removeEventListener('visibilitychange', onVisible); };
    }, [active, allowed, runtime, refresh]);
    React.useEffect(() => {
        setDetailsError('');
        if (!active || !allowed || !teammateId) return;
        let disposed = false;
        const owner = getRuntimeKey();
        const version = generation.current;
        const current = () => !disposed && visible.current && document.visibilityState !== 'hidden' && owner === getRuntimeKey() && version === generation.current;
        const timer = window.setTimeout(() => { if (current()) setDetailsError(t('home.teamReadSlow')); }, 15_000);
        const load = async () => {
            if (detailRead.current) await detailRead.current.catch(() => {});
            if (!current() || document.visibilityState === 'hidden') return null;
            const pending = readTeamDetails(projectId, teammateId);
            detailRead.current = pending;
            try { return await pending; }
            finally { if (detailRead.current === pending) detailRead.current = null; }
        };
        void load().then((next) => {
            if (current() && next) { setDetails((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); setDetailsError(''); }
        }).catch((failure: Error) => { if (current()) setDetailsError(failureMessage(failure)); }).finally(() => window.clearTimeout(timer));
        return () => { disposed = true; window.clearTimeout(timer); };
    }, [active, allowed, runtime, projectId, teammateId, refreshRevision, t]);
    const mutate = async (action: () => Promise<void>) => {
        if (mutationPending.current || !allowed || !serviceReady) return;
        mutationPending.current = true;
        const version = ++generation.current;
        const owner = getRuntimeKey();
        setBusy(true); setMutationError('');
        let succeeded = false;
        try {
            await action();
            succeeded = true;
        } catch (failure) {
            if (version === generation.current && owner === getRuntimeKey()) {
                setMutationError(failureMessage(failure instanceof Error ? failure : String(failure)));
                if (failure instanceof TeamRuntimeUnavailableError) setServiceReady(false);
            }
        } finally {
            mutationPending.current = false;
            if (owner === getRuntimeKey()) {
                setBusy(false);
                if (inboxRead.current) await inboxRead.current;
                if (succeeded && version === generation.current) void refresh();
            }
        }
    };
    const setText = (text: string) => {
        const next = { text, requestId: crypto.randomUUID() };
        setDrafts((previous) => new Map(previous).set(draftKey, next));
        try { writeTeamDraft(runtime, projectId, next); setDraftStorageError(false); } catch { setDraftStorageError(true); }
    };
    const selectProject = (id: string) => {
        setProjectId(id); setFocusedRunId(null); setDetailsError(''); setMutationError(''); setDraftStorageError(false);
        const key = JSON.stringify([runtime, id]);
        if (drafts.has(key)) return;
        try {
            const saved = readTeamDraft(runtime, id);
            if (saved) setDrafts((previous) => new Map(previous).set(key, saved));
        } catch { setDraftStorageError(true); }
    };
    const title = (draft?.text ?? '').trim().split('\n')[0].slice(0, 120);
    if (!allowed) return active ? <p className="oc-home-empty">{t(blocked || networkBlocked ? 'home.blocked' : 'home.desktopOnly')}</p> : null;
    if (snapshotRuntime !== runtime) return active ? <p role="status" className="oc-home-empty">{t('common.loading')}</p> : null;
    return <section hidden={!active} className="oc-home-task-panel max-h-[65dvh] overflow-y-auto">
        <div className="oc-home-card-heading"><h2>{t('home.teamTitle')}</h2><Button size="xs" variant="ghost" className="ms-auto" disabled={busy || loading} onClick={() => void refresh()}>{t('home.refresh')}</Button></div>
        <p className="oc-home-empty">{t('home.teamScope')}</p>
        <Select value={projectId} disabled={busy || !projects.length} onValueChange={selectProject}><SelectTrigger size="settings" aria-label={t('home.aiProject')}><SelectValue placeholder={t('home.aiChooseProject')}>{projects.find((project) => project.id === projectId)?.label || t('home.aiChooseProject')}</SelectValue></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.label}</SelectItem>)}</SelectContent></Select>
        <div role="status" className="oc-home-empty">{loading ? t('common.loading') : ''}</div>
        {slow && (loading || busy) && <p role="status" className="oc-home-empty">{t('home.teamReadSlow')}</p>}
        {error && <p role="alert" className="oc-home-empty break-words text-destructive">{error}</p>}
        {mutationError && <p role="alert" className="oc-home-empty break-words text-destructive">{mutationError}</p>}
        {!serviceReady && !loading && <p className="oc-home-empty">{t('home.teamUnavailable')}</p>}
        {projectId && <>
            {interruptionPending && <p role="status" className="oc-home-empty">{t('home.teamPausePending')}</p>}
            {snapshotAt !== null && <p className="mt-2 text-xs text-muted-foreground">{t('home.teamSnapshot', { date: new Date(snapshotAt).toLocaleString(locale) })}</p>}
            {serviceReady && inbox && !teammate && <p className="oc-home-empty">{t('home.teamEmpty')}</p>}
            {inbox?.filter((row) => row.teammate.projectId === projectId).map((row) => <div key={row.teammate.id} className="my-3 space-y-1 border-b border-border pb-3">
                <Button variant="ghost" size="sm" className="oc-home-row oc-home-context-row" onClick={() => {
                    if (row.latestRun?.sessionId) useSessionUIStore.getState().setCurrentSession(row.latestRun.sessionId, row.latestRun.directory);
                    else if (row.latestRun) setFocusedRunId(row.latestRun.id);
                }}><span className="oc-home-row-context"><span dir="auto">{row.teammate.projectLabel} · {row.teammate.agent}</span><span className="oc-home-row-detail" dir="auto">{row.latestRun?.title || t('home.teamEmpty')}</span></span></Button>
                {row.latestRun?.failure && <p className="break-words text-xs text-destructive" dir="auto">{row.latestRun.failure.message}</p>}
                {row.latestRun && <p className="text-xs text-muted-foreground">{t(row.latestRun.phase === 'done' ? 'home.aiDone' : row.latestRun.phase === 'needs-you' ? 'home.aiNeedsYou' : row.latestRun.phase === 'paused' ? 'home.teamPause' : row.latestRun.phase === 'running' ? 'home.aiWorking' : 'common.loading')}</p>}
                {row.unread && <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t('home.teamUnread')}</span><Button variant="ghost" size="xs" disabled={!canWrite} onClick={() => void mutate(async () => { await acknowledgeTeam(row.teammate.projectId, row.teammate.id, visibleDetails?.teammate.revision ?? row.teammate.revision); })}>{t('home.teamMarkRead')}</Button></div>}
            </div>)}
            <div className="mt-3 space-y-2">
                <SettingsStackedField label={t('home.teamMessage')} controlClassName="w-full max-w-none"><Textarea dir="auto" value={draft?.text ?? ''} maxLength={20000} disabled={busy} aria-label={t('home.teamMessage')} onChange={(event) => setText(event.target.value)} /></SettingsStackedField>
                {draftStorageError && <p role="alert" className="text-xs text-destructive">{t('home.teamDraftStorage')}</p>}
                <p className="text-xs leading-relaxed text-muted-foreground">{t('home.teamExecutionHint')}</p>
                <Button size="sm" disabled={!canDispatch || !title} onClick={() => {
                    if (!draft) return;
                    const captured = draft;
                    const capturedKey = draftKey;
                    void mutate(async () => {
                        const run = await sendTeamMessage({ projectId, title, text: captured.text.trim(), requestId: captured.requestId });
                        if (!run.failure) {
                            try { writeTeamDraft(runtime, projectId, null); } catch { if (getRuntimeKey() === runtime) setDraftStorageError(true); }
                            setDrafts((previous) => {
                            if (previous.get(capturedKey)?.requestId !== captured.requestId) return previous;
                            const next = new Map(previous); next.delete(capturedKey); return next;
                            });
                        }
                    });
                }}>{t('home.teamSend')}</Button>
                <HomeTeamRoutineForm key={draftKey} disabled={!canDispatch || !title} onPropose={(schedule, limits) => void mutate(async () => { await proposeTeamRoutine({ projectId, title, text: draft?.text.trim() ?? '', schedule, limits, allowedActions: ['read-project'] }); })} />
            </div>
            {detailsError && <p role="alert" className="oc-home-empty break-words text-destructive">{detailsError}</p>}
            {teammate && !visibleDetails && !detailsError && <p role="status" className="oc-home-empty">{t('common.loading')}</p>}
            {visibleDetails && <div className="mt-5">
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('home.teamRoutines')}</h3>
                {visibleDetails.routines.map((routine) => <HomeTeamRoutineReview key={routine.id} routine={routine} projectLabel={visibleDetails.teammate.projectLabel} busy={!canWrite} onConfirm={() => void mutate(async () => { await confirmTeamRoutine(routine); })} onPause={() => void mutate(async () => { await pauseTeamRoutine(routine); })} />)}
                <h3 className="mb-2 mt-5 text-xs font-medium text-muted-foreground">{t('home.teamHistory')}</h3>
                {visibleDetails.runs.slice().reverse().map((run) => <HomeTeamRunDetails key={`${draftKey}:${run.id}`} runtime={runtime} run={run} reveal={focusedRunId === run.id} disabled={!canWrite} revisionDisabled={!canDispatch} onRevise={(input, onSaved) => void mutate(async () => { const revised = await reviseTeamRun(input); if (!revised.failure) onSaved(); })} onRecover={() => void mutate(async () => { await recoverTeamRun({ projectId: run.projectId, runId: run.id }); })} onPause={() => void mutate(async () => { await pauseTeamContinuation(run); })} />)}
                {!visibleDetails.runs.length && !visibleDetails.routines.length && <p className="oc-home-empty">{t('home.teamEmpty')}</p>}
            </div>}
        </>}
        <details className="mt-4 border-t border-border pt-2 text-xs leading-relaxed"><summary className="cursor-pointer py-2 focus-visible:outline focus-visible:outline-ring">{t('home.teamHost')}<span className="ms-2 text-muted-foreground">{hostState}</span><span className="ms-2 text-muted-foreground">{teamWorkState}</span></summary>
            <p role="status" className="my-2">{hostState}</p>
            <p role="status" className="my-2">{teamWorkState}</p>
            {hostError && <p role="alert" className="break-words text-destructive">{hostError}</p>}
            {host && ['native_failure', 'unsupported', 'coordinator_unavailable'].includes(host.wakeProtection.reason) && <p role="alert">{t('home.teamUnavailable')}</p>}
            {host && <SettingsCheckboxRow checked={host.wakeProtection.enabled} disabled={busy || !host.wakeProtection.supported || Boolean(hostError) || !serviceReady} label={t('home.teamWakeControl')} onChange={(enabled) => void mutate(async () => { const next = await configureAiHost(enabled); if (getRuntimeKey() === runtime) setHost(next); })} />}
            <p className="my-2 text-muted-foreground">{t('home.teamHostLimits')}</p>
            <p className="text-muted-foreground">{t('home.teamBilling')}</p>
            <p className="mt-2 text-muted-foreground">{t('home.teamThresholds', { project: (100000).toLocaleString(locale), account: (250000).toLocaleString(locale) })}</p>
        </details>
    </section>;
}
