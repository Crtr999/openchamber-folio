import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { controlTeaching, dismissTeaching, teachingSupported, type TeachingState } from '@/lib/personal-workspace/teaching';
import { teachingReplayScript } from '@/lib/personal-workspace/teaching-replay';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { TeachingSkillPanel } from './TeachingSkillPanel';

/** Capture controls never invoke the model or put a request in the composer. */
export function TeachingDialog({ onClose, directory }: { onClose: () => void; directory?: string }) {
  const { t } = useI18n();
  const blocked = useEnterpriseMode();
  const [state, setState] = React.useState<TeachingState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [guest, setGuest] = React.useState<WebviewElement | null>(null);
  const [skillOpen, setSkillOpen] = React.useState(false);
  const [skillBusy, setSkillBusy] = React.useState(false);
  const attachGuest = React.useCallback((node: WebviewElement | null) => setGuest(node), []);
  React.useEffect(() => {
    if (!guest || !state?.videoUrl) return;
    const script = teachingReplayScript(state.videoUrl);
    const play = () => { void guest.executeJavaScript(script).catch(() => setError(true)); };
    guest.addEventListener('dom-ready', play);
    return () => guest.removeEventListener('dom-ready', play);
  }, [guest, state?.videoUrl]);
  const locked = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = React.useCallback(async (action: 'status' | 'start' | 'stop' | 'review', id?: string) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(false);
    try { const next = await controlTeaching(action, id); if (mounted.current) { setState(next); setElapsed(0); } }
    catch { if (mounted.current) setError(true); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }, []);
  React.useEffect(() => { if (teachingSupported() && !blocked) void run('status'); }, [run, blocked]);
  React.useEffect(() => {
    if (state?.phase !== 'recording') return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [state?.phase]);
  const close = async () => {
    if (locked.current) return;
    if (teachingSupported()) {
      locked.current = true; setBusy(true);
      try { await dismissTeaching(); onClose(); }
      catch { setError(true); }
      finally { locked.current = false; if (mounted.current) setBusy(false); }
    } else onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open) void close(); }}>
    <DialogContent className="flex h-[min(850px,94dvh)] max-w-6xl flex-col gap-0 overflow-hidden p-0" showCloseButton={false}>
      <DialogHeader className="flex-row items-center justify-between gap-3 border-b px-5 py-4 text-start">
        <div className="min-w-0"><DialogTitle>{t('workspace.teach')}</DialogTitle><DialogDescription className="mt-1">{t('workspace.teachHint')}</DialogDescription></div>
        <Button variant="ghost" size="icon" className="shrink-0 rounded-full" aria-label={t('personalTools.cancel')} disabled={busy} onClick={() => void close()}><Icon name="close" className="size-5" /></Button>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
      <div className="relative flex min-h-64 flex-1 items-center justify-center bg-[var(--surface-background)]">
        {state && !blocked && <webview ref={attachGuest} key={`${state.phase}:${state.recordingId ?? ''}`} src={state.viewUrl} partition="open-carter-teaching" className="h-full min-h-0 w-full flex-1" />}
        {(!state || blocked) && <div className="max-w-md space-y-4 p-8 text-center"><Icon name="video-on" className="mx-auto size-10 text-muted-foreground" /><p className="typography-ui-label text-muted-foreground">{t(blocked ? 'workspaceStatus.blocked' : teachingSupported() ? 'workspace.teachConnect' : 'workspace.teachUnsupported')}</p>{teachingSupported() && !blocked && <Button disabled={busy} onClick={() => void run('status')}>{t('workspace.connected')}</Button>}</div>}
      </div>
      {skillOpen && state?.phase === 'review' && state.recordingId && !blocked && <TeachingSkillPanel key={state.recordingId} source={state.recordingId} directory={directory} onClose={() => void close()} onBusyChange={setSkillBusy} />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
        <div role="status" className="flex items-center gap-2 typography-ui-label text-muted-foreground">
          {state?.phase === 'recording' && <><span className="size-2 rounded-full bg-[var(--status-error)]" />{t('workspace.teachRecording')}<span className="font-mono tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span></>}
          {state?.phase === 'review' && t('workspace.teachReview')}
          {state?.phase === 'ready' && t('workspace.teachReady')}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state?.phase === 'review' && !blocked && <Button variant="outline" disabled={busy || skillBusy} onClick={() => setSkillOpen(value => !value)}>{t('workspace.skillReview')}</Button>}
          {state && state.recordings.length > 0 && state.phase !== 'recording' && <details className="relative"><summary className="cursor-pointer rounded-lg px-3 py-2 typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('workspace.library')}</summary><div className="absolute bottom-12 end-0 z-10 max-h-60 w-72 overflow-auto rounded-xl border bg-[var(--surface-elevated)] p-1 shadow-lg">{state.recordings.map((id) => <Button key={id} variant="ghost" className="w-full justify-start truncate" disabled={busy || skillBusy} onClick={() => void run('review', id)}>{id.slice(0, 19).replaceAll('-', ' ')}</Button>)}</div></details>}
          {state && !blocked && <Button disabled={busy || skillBusy} title={skillBusy ? t('workspace.skillBusy') : undefined} className="gap-2 rounded-full px-5" onClick={() => void run(state.phase === 'recording' ? 'stop' : 'start')}><Icon name={state.phase === 'recording' ? 'stop' : 'checkbox-blank-circle-fill'} className="size-5" />{busy ? t('workspace.loading') : t(state.phase === 'recording' ? 'workspace.teachStop' : 'workspace.teachStart')}</Button>}
        </div>
      </div>
      {error && <div role="alert" className="flex items-center justify-between gap-3 border-t px-5 py-3 typography-ui-label text-destructive"><span>{t('workspace.teachError')}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void run('status')}>{t('workspace.preview')}</Button></div>}
    </DialogContent>
  </Dialog>;
}
