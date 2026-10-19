import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { readTeamInbox, readTeamDetails, readAiTaskProjects, enqueueTeamMessage, cancelTeamQueued, pauseTeamContinuation, resumeTeamQueued, recoverTeamRun, reviseTeamRun, readTeamDraft, writeTeamDraft, type HomeTeamDetails } from '@/lib/personal-home';
import { HomeTeamRunDetails } from './HomeTeamRunDetails';

type ReviewedModel = Awaited<ReturnType<typeof readAiTaskProjects>>[number]['models'][number];
export function HomeFriendsWork({ projectId, runtime }: { projectId: string; runtime: string }) {
    const { t } = useI18n();
    const blocked = useEnterpriseMode();
    const networkBlocked = useEnterprisePolicyStore(s => s.networkAccessBlocked);
    const [details, setDetails] = React.useState<HomeTeamDetails | null>(null);
    const [models, setModels] = React.useState<ReviewedModel[]>([]);
    const [model, setModel] = React.useState('default');
    const [draft, setDraft] = React.useState<ReturnType<typeof readTeamDraft>>(null);
    const [error, setError] = React.useState('');
    const [mutationError, setMutationError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [ready, setReady] = React.useState(false);
    const alive = React.useRef(true);
    const revision = React.useRef(0);
    const pending = React.useRef(false);
    const read = React.useRef(false);
    const current = React.useCallback(() => alive.current && getRuntimeKey() === runtime, [runtime]);
    const refresh = React.useCallback(async () => {
        if (read.current || pending.current || !current() || blocked || networkBlocked) return;
        read.current = true;
        const token = ++revision.current;
        try {
            const [inbox, projects] = await Promise.all([readTeamInbox(), readAiTaskProjects()]);
            const teammate = inbox.find(item => item.teammate.projectId === projectId)?.teammate;
            const next = teammate ? await readTeamDetails(projectId, teammate.id) : null;
            if (current() && token === revision.current) {
                setDetails(next); setModels(projects.find(item => item.id === projectId)?.models ?? []); setReady(true); setError('');
            }
        } catch (failure) { if (current() && token === revision.current) { setError(failure instanceof Error ? failure.message : t('personalTools.error')); setReady(false); } }
        finally { read.current = false; }
    }, [projectId, current, blocked, networkBlocked, t]);
    React.useEffect(() => {
        alive.current = true;
        try { setDraft(readTeamDraft(runtime, projectId)); } catch { setMutationError(t('home.teamDraftStorage')); }
        void refresh();
        const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 10_000);
        return () => { alive.current = false; revision.current += 1; window.clearInterval(timer); };
    }, [runtime, projectId, refresh, t]);
    const mutate = async (work: () => Promise<void>) => {
        if (pending.current || !current() || blocked || networkBlocked) return;
        pending.current = true; revision.current += 1; setBusy(true); setMutationError('');
        try { await work(); }
        catch (failure) { if (current()) setMutationError(failure instanceof Error ? failure.message : t('personalTools.error')); }
        finally { pending.current = false; if (current()) { setBusy(false); void refresh(); } }
    };
    const saveDraft = (text: string) => {
        const next = { text, requestId: crypto.randomUUID() };
        setDraft(next);
        try { writeTeamDraft(runtime, projectId, next); } catch { setMutationError(t('home.teamDraftStorage')); }
    };
    if (blocked || networkBlocked) return <p className="text-sm text-muted-foreground">{t('friends.policyBlocked')}</p>;
    return <div className="space-y-4">
        <div className="flex items-start justify-between gap-3"><p className="text-sm text-muted-foreground">{t('friends.coordination')}</p><Button variant="ghost" size="xs" disabled={busy} onClick={() => void refresh()}>{t('home.refresh')}</Button></div>
        {mutationError && <p role="alert" className="break-words text-sm text-destructive">{mutationError}</p>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {!ready && !error && <p role="status">{t('common.loading')}</p>}
        {ready && !models.length && <p className="text-sm text-muted-foreground">{t('friends.noPolicy')}</p>}
        <Textarea aria-label={t('friends.assignment')} placeholder={t('friends.assignment')} value={draft?.text ?? ''} maxLength={20000} disabled={busy} onChange={event => saveDraft(event.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
            <Select value={model} onValueChange={setModel} disabled={busy || !models.length}><SelectTrigger className="max-w-xs" aria-label={t('home.aiModel')}><SelectValue>{model === 'default' ? t('friends.folderDefault') : models.find(item => JSON.stringify([item.providerID, item.id]) === model)?.name}</SelectValue></SelectTrigger><SelectContent><SelectItem value="default">{t('friends.folderDefault')}</SelectItem>{models.map(item => <SelectItem key={JSON.stringify([item.providerID, item.id])} value={JSON.stringify([item.providerID, item.id])}>{item.providerID} · {item.name}</SelectItem>)}</SelectContent></Select>
            <Button size="sm" disabled={busy || !ready || !models.length || !draft?.text.trim()} onClick={() => {
                if (!draft) return;
                const captured = draft;
                const selected = models.find(item => JSON.stringify([item.providerID, item.id]) === model);
                void mutate(async () => {
                    await enqueueTeamMessage({ projectId, title: captured.text.trim().split('\n')[0].slice(0, 120), text: captured.text.trim(), requestId: captured.requestId, model: selected ? { providerID: selected.providerID, id: selected.id } : undefined });
                    writeTeamDraft(runtime, projectId, null);
                    if (current()) setDraft(null);
                });
            }}>{t('friends.queue')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('friends.queueRules')}</p>
        {details?.runs.slice().reverse().map(run => <div key={run.id}>
            {run.pendingDispatch && <p className="text-xs text-muted-foreground">{t(run.phase === 'paused' ? 'home.teamPause' : 'friends.queued')}</p>}
            {run.pendingDispatch && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void mutate(async () => { await cancelTeamQueued(run); })}>{t('personalTools.cancel')}</Button>}
            {run.pendingDispatch && run.phase === 'paused' && <Button size="xs" variant="outline" disabled={busy} onClick={() => void mutate(async () => { await resumeTeamQueued(run); })}>{t('friends.resume')}</Button>}
            <HomeTeamRunDetails runtime={runtime} run={run} disabled={busy || !ready} revisionDisabled={busy || !ready || Boolean(run.pendingDispatch)} onPause={() => void mutate(async () => { await pauseTeamContinuation(run); })} onRecover={() => void mutate(async () => { await recoverTeamRun({ projectId, runId: run.id }); })} onRevise={(input, onSaved) => void mutate(async () => { const next = await reviseTeamRun(input); if (!next.failure && current()) onSaved(); })} />
        </div>)}
        {ready && !details?.runs.length && <p className="text-sm text-muted-foreground">{t('friends.noWork')}</p>}
    </div>;
}
