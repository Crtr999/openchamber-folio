import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { readTeamDraft, writeTeamDraft, type HomeTeamRun, type reviseTeamRun } from '@/lib/personal-home';

export function HomeTeamRunDetails({ runtime, run, disabled, revisionDisabled = false, reveal = false, onPause, onRevise, onRecover }: {
    runtime: string; run: HomeTeamRun; disabled: boolean; revisionDisabled?: boolean; reveal?: boolean; onPause: () => void; onRecover: () => void;
    onRevise: (input: Parameters<typeof reviseTeamRun>[0], onSaved: () => void) => void;
}) {
    const { t, locale } = useI18n();
    const [draft, setDraft] = React.useState<ReturnType<typeof readTeamDraft>>(null);
    const [storageError, setStorageError] = React.useState(false);
    React.useEffect(() => {
        try { setDraft(readTeamDraft(runtime, run.projectId, run.id)); }
        catch { setStorageError(true); }
    }, [runtime, run.projectId, run.id]);
    const detailRef = React.useRef<HTMLDetailsElement>(null);
    const canRevise = !disabled && !revisionDisabled && !run.pausePending && !run.pendingDispatch && ['done', 'needs-you', 'paused'].includes(run.phase);
    React.useEffect(() => {
        if (!reveal || !detailRef.current) return;
        detailRef.current.open = true;
        detailRef.current.scrollIntoView?.({ block: 'nearest' });
    }, [reveal]);
    const openChat = (id: string, directory: string, messageId?: string) => {
        useSessionUIStore.getState().setCurrentSession(id, directory);
        if (messageId) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#search-message-${messageId}`);
        else if (window.location.hash.startsWith('#search-message-')) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    };
    const phase = run.cancelledBeforeDispatch ? t('home.aiCancelled') : run.phase === 'queued' && run.pendingDispatch ? t('friends.queued') : run.phase === 'done' ? t('home.aiDone') : run.phase === 'needs-you' ? t('home.aiNeedsYou') : run.phase === 'paused' ? t('home.teamPause') : run.phase === 'running' ? t('home.aiWorking') : t('common.loading');
    return <details ref={detailRef} className="border-t border-border py-2 text-sm">
        <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline focus-visible:outline-ring"><span className="break-words font-medium" dir="auto">{run.title}</span><span className="ms-2 text-xs text-muted-foreground">{phase} · {new Date(run.startedAt).toLocaleString(locale)}</span></summary>
        <div className="space-y-3 py-2 leading-relaxed">
            <p className="break-all text-xs text-muted-foreground" dir="ltr">{run.taskId} · {run.id}</p>
            {run.revisionOf && <p className="break-all text-xs text-muted-foreground">{t('home.teamRevisionOf', { id: run.revisionOf })}</p>}
            <p className="whitespace-pre-wrap break-words" dir="auto">{run.text}</p>
            {run.failure && <p role="alert" dir="auto" className="break-words text-destructive">{t('home.aiFailureStage', { stage: run.failure.stage, code: run.failure.code })} {run.failure.message}</p>}
            {run.content && <p className="whitespace-pre-wrap break-words" dir="auto">{run.content}</p>}
            {run.sessionId ? <Button variant="outline" size="sm" onClick={() => { if (run.sessionId) openChat(run.sessionId, run.directory); }}>{t('home.aiOpenChat')}</Button> : <p>{t('home.aiNoChat')}</p>}
            <form className="space-y-2" onSubmit={(event) => {
                event.preventDefault();
                if (!canRevise || !draft?.text.trim()) return;
                const captured = draft;
                onRevise({ projectId: run.projectId, runId: run.id, revision: captured.revision ?? run.revision, text: captured.text.trim(), requestId: captured.requestId }, () => {
                    try { writeTeamDraft(runtime, run.projectId, null, run.id); }
                    catch { setStorageError(true); }
                    setDraft((current) => current?.requestId === captured.requestId ? null : current);
                });
            }}>
                <label className="block text-xs text-muted-foreground">
                {t('home.teamRevision')}
                <Textarea dir="auto" required maxLength={20000} disabled={disabled} value={draft?.text ?? ''} aria-label={t('home.teamRevision')} onChange={(event) => {
                    const next = { text: event.target.value, requestId: crypto.randomUUID(), revision: run.revision };
                    setDraft(next);
                    try { writeTeamDraft(runtime, run.projectId, next, run.id); setStorageError(false); }
                    catch { setStorageError(true); }
                }} /></label>
                {storageError && <p role="alert" className="text-xs text-destructive">{t('home.teamDraftStorage')}</p>}
                <Button type="submit" size="sm" variant="outline" disabled={!canRevise || !draft?.text.trim()}>{t('home.teamRevisionSend')}</Button>
            </form>
            {(run.pausePending || run.failure?.stage === 'pause' || run.failure?.stage === 'stall') && <div className="space-y-2">
                {run.pausePending && <p role="status" className="text-xs">{t('home.teamPausePending')}</p>}
                <p className="text-xs text-muted-foreground">{t('home.teamRecoverHint')}</p>
                <Button size="sm" variant="outline" disabled={disabled} onClick={onRecover}>{t('home.teamRecover')}</Button>
            </div>}
            {run.failure?.stage === 'inspect' && <p role="alert" className="text-xs text-destructive">{t('home.teamChildren')}</p>}
            <div className="flex flex-wrap gap-1">{run.children.map((child) => <Button key={child.id} variant="ghost" size="sm" className="max-w-full truncate" onClick={() => openChat(child.id, child.directory)}>{child.title || child.id}</Button>)}</div>
            {run.artifacts.length > 0 && <div className="space-y-1"><h4 className="text-xs font-medium">{t('home.teamArtifacts')}</h4>{run.artifacts.map((artifact) => {
                const directory = artifact.sessionId === run.sessionId ? run.directory : run.children.find((child) => child.id === artifact.sessionId)?.directory;
                const path = artifact.path;
                const root = directory?.replace(/\/+$/, '');
                // Evidence may contain URLs or traversal strings. Only project file paths go to Files.
                const safePath = root && path && !Array.from(path).some((character) => character.charCodeAt(0) < 32 || character === '\\') && !path.split('/').includes('..') && !/^[a-z][a-z\d+.-]*:/i.test(path)
                    ? path.startsWith('/') ? path.startsWith(`${root}/`) ? path : null : `${root}/${path}` : null;
                return <div key={`${artifact.sessionId}:${artifact.messageId}:${artifact.path}`} className="min-w-0 space-y-1">
                    <p className="break-words" dir="auto">{artifact.label || artifact.path}</p>
                    <div className="flex flex-wrap gap-1">
                        <Button variant="outline" size="xs" disabled={!safePath} onClick={() => { if (directory && safePath) { openChat(artifact.sessionId, directory); useUIStore.getState().openContextFile(directory, safePath); } }}>{t('chat.toolPart.openFile')}</Button>
                        <Button variant="link" size="xs" disabled={!directory} onClick={() => { if (directory) openChat(artifact.sessionId, directory, artifact.messageId); }}>{t('home.teamSource')}</Button>
                    </div><p className="break-all text-xs text-muted-foreground" dir="ltr">{path}</p>
                </div>;
            })}</div>}
            {run.usage.kind === 'available' && <p className="text-xs text-muted-foreground">{t('home.teamUsage', { tokens: run.usage.tokens.toLocaleString(locale), cost: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(run.usage.reportedCost) })}</p>}
            <p className="text-xs text-muted-foreground">{t('home.teamBilling')}</p>
            {!['done', 'paused'].includes(run.phase) && <Button size="sm" variant="outline" disabled={disabled} onClick={onPause}>{t('home.teamPause')}</Button>}
        </div>
    </details>;
}
