import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';

const taskSchema = z.object({
  id: z.string(), name: z.string(), enabled: z.boolean(),
  state: z.object({ lastStatus: z.string().optional(), lastError: z.string().optional(), nextRunAt: z.number().optional(), lastSessionId: z.string().optional() }),
});
const tasksSchema = z.object({ tasks: z.array(taskSchema) });
const settingsSchema = z.object({ activityEnabled: z.boolean(), timezone: z.string(), quietStart: z.string(), quietEnd: z.string(), dailyAlertLimit: z.number() });
const inboxSchema = z.object({ settings: settingsSchema, inbox: z.array(z.object({ id: z.string(), title: z.string(), excerpt: z.string(), createdAt: z.number(), seen: z.boolean() })) });
type Settings = z.infer<typeof settingsSchema>;

type Task = z.infer<typeof taskSchema>;
type SaveResponsibility = {
  id: string; name: string; prompt: string; time: string; timezone: string;
  providerID: string; modelID: string; enabled: boolean;
};

// Uses the same project scheduler and root sessions as desktop. No replicated
// conversation state, automatic enrollment, or background client timer.
export function CompanionPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const setProject = useProjectsStore((state) => state.setActiveProject);
  const projectId = useProjectsStore((state) => state.activeProjectId);
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === state.activeProjectId));
  const providerID = useConfigStore((state) => state.currentProviderId);
  const modelID = useConfigStore((state) => state.currentModelId);
  const [name, setName] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [time, setTime] = React.useState('09:00');
  const [inbox, setInbox] = React.useState<z.infer<typeof inboxSchema>['inbox']>([]);
  const [settings, setSettings] = React.useState<Settings>({ activityEnabled: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, quietStart: '21:00', quietEnd: '08:00', dailyAlertLimit: 6 });
  const settingsDirty = React.useRef(false);
  const busyRef = React.useRef(false);
  const owner = React.useRef(0);
  const [tasks, setTasks] = React.useState<Task[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const generation = React.useRef(0);
  const pendingId = React.useRef(`companion:${crypto.randomUUID()}`);
  const load = React.useCallback(async () => {
    if (!projectId) return;
    const sequence = ++generation.current;
    setFailed(false);
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/companion`;
      const [response, inboxResponse] = await Promise.all([runtimeFetch(base), runtimeFetch(`${base}/inbox`)]);
      if (!inboxResponse.ok) throw new Error('inbox');
      const companion = inboxSchema.parse(await inboxResponse.json());
      if (!response.ok) throw new Error('load');
      const result = tasksSchema.parse(await response.json());
      if (sequence === generation.current) {
        setTasks(result.tasks); setInbox(companion.inbox);
        if (!settingsDirty.current) setSettings(companion.settings);
      }
    } catch {
      if (sequence === generation.current) setFailed(true);
    }
  }, [projectId]);
  React.useEffect(() => {
    owner.current++;
    settingsDirty.current = false; busyRef.current = false;
    setInbox([]);
    setTasks(null);
    setName('');
    setPrompt('');
    setBusy(false);
    pendingId.current = `companion:${crypto.randomUUID()}`;
    void load();
    const invalidate = () => { generation.current++; owner.current++; };
    const unsubscribe = subscribeRuntimeEndpointChanged(onClose);
    return () => { invalidate(); unsubscribe(); };
  }, [load, onClose]);
  React.useEffect(() => {
    const refresh = () => { if (!busyRef.current && document.visibilityState !== 'hidden') void load(); };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready' || (event.type === 'companion-changed' && event.projectId === projectId)) refresh();
    });
    document.addEventListener('visibilitychange', refresh);
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', refresh); };
  }, [load, projectId]);
  const mutate = async (path: string, method: string, body: SaveResponsibility | { enabled: boolean } | Settings & { providerID: string; modelID: string } | { dismissed: boolean }) => {
    if (!projectId || busyRef.current) return;
    const runtime = getRuntimeKey();
    const scope = owner.current;
    generation.current++;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const response = await runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/companion${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('save');
      if (runtime !== getRuntimeKey() || scope !== owner.current) return;
      if (path === '/settings') settingsDirty.current = false;
      if (method === 'PUT' && !path) {
        setName(''); setPrompt('');
        pendingId.current = `companion:${crypto.randomUUID()}`;
      }
      await load();
    } catch { if (runtime === getRuntimeKey() && scope === owner.current) setFailed(true); }
    finally { if (runtime === getRuntimeKey() && scope === owner.current) { busyRef.current = false; setBusy(false); } }
  };
  const openResult = async (id: string, markSeen = false) => {
    const scope = owner.current;
    const runtime = getRuntimeKey();
    if (markSeen && projectId) {
      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/companion/inbox/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen: true }) });
        if (!response.ok) throw new Error('mark seen');
      } catch { setFailed(true); }
    }
    if (scope !== owner.current || runtime !== getRuntimeKey()) return;
    await useSessionUIStore.getState().setCurrentSession(id, project?.path ?? null);
    onClose();
  };
  const editSettings = (patch: Partial<Settings>) => { settingsDirty.current = true; setSettings((current) => ({ ...current, ...patch })); };
  return <MobileFullscreenSurface open title={t('companion.title')} onClose={onClose}>
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <p className="text-sm text-muted-foreground">{t('companion.hint')}</p>
      <Select value={projectId ?? ''} onValueChange={setProject} disabled={busy}>
        <SelectTrigger aria-label={t('companion.project')}><SelectValue placeholder={t('companion.project')}>{project ? project.label || project.path : undefined}</SelectValue></SelectTrigger>
        <SelectContent>{projects.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label || entry.path}</SelectItem>)}</SelectContent>
      </Select>
      {!projectId ? <p role="status">{t('companion.project')}</p> : <>
        {failed ? <p role="alert">{t('companion.error')}</p> : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>{t('companion.refresh')}</Button>
        <section className="space-y-3 rounded-lg border border-border p-3">
          <h2>{t('companion.inbox')}</h2>
          {!inbox.length ? <p className="text-sm text-muted-foreground">{t('companion.empty')}</p> : null}
          {inbox.map((entry) => <article key={entry.id} className="space-y-2 border-b border-border pb-3">
            <p>{entry.title}{!entry.seen ? <span className="ml-2 text-sm text-muted-foreground">{t('companion.unread')}</span> : null}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{entry.excerpt}</p>
            <p className="text-sm text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</p>
            <Button variant="outline" size="sm" onClick={() => void openResult(entry.id, true)}>{t('companion.result')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(`/inbox/${encodeURIComponent(entry.id)}`, 'PATCH', { dismissed: true })}>{t('companion.dismiss')}</Button>
          </article>)}
        </section>
        <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); void mutate('/settings', 'PUT', { ...settings, providerID, modelID }); }}>
          <label className="flex items-center gap-2"><Checkbox checked={settings.activityEnabled} onChange={(value) => editSettings({ activityEnabled: value })} />{t('companion.monitor')}</label>
          <p className="text-sm text-muted-foreground">{t('companion.monitorHint')}</p>
          <label className="block text-sm">{t('sessions.scheduledTasks.editor.timezone.label')}<input required className="ml-2 max-w-full rounded-md border border-input bg-background p-2" value={settings.timezone} onChange={(event) => editSettings({ timezone: event.target.value })} /></label>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">{t('companion.quietStart')}<input type="time" required className="ml-2 rounded-md border border-input bg-background p-2" value={settings.quietStart} onChange={(event) => editSettings({ quietStart: event.target.value })} /></label>
            <label className="text-sm">{t('companion.quietEnd')}<input type="time" required className="ml-2 rounded-md border border-input bg-background p-2" value={settings.quietEnd} onChange={(event) => editSettings({ quietEnd: event.target.value })} /></label>
          </div>
          <label className="block text-sm">{t('companion.alertLimit')}<input type="number" min={1} max={20} required className="ml-2 w-20 rounded-md border border-input bg-background p-2" value={settings.dailyAlertLimit} onChange={(event) => editSettings({ dailyAlertLimit: Number(event.target.value) })} /></label>
          <Button type="submit" disabled={busy || tasks === null || (settings.activityEnabled && (!providerID || !modelID))}>{t('companion.saveSettings')}</Button>
        </form>
        {tasks?.map((task) => <section key={task.id} className="space-y-2 rounded-lg border border-border p-3">
          <p>{task.name}</p>
          {task.state.lastStatus === 'error' ? <p role="alert">{task.state.lastError || t('companion.error')}</p> : null}
          {task.state.nextRunAt ? <p className="text-sm text-muted-foreground">{new Date(task.state.nextRunAt).toLocaleString()}</p> : null}
          {task.state.lastSessionId ? <Button variant="link" size="sm" onClick={() => void openResult(task.state.lastSessionId || '')}>{t('companion.result')}</Button> : null}
          <Button className="ml-2" variant="outline" size="sm" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(task.id)}`, 'PATCH', { enabled: !task.enabled })}>{t(task.enabled ? 'companion.pause' : 'companion.resume')}</Button>
        </section>)}
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          void mutate('', 'PUT', {
            id: pendingId.current, name, prompt, time,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            providerID, modelID, enabled: true,
          });
        }}>
          <label className="block text-sm">{t('companion.name')}<input required maxLength={80} className="mt-1 w-full rounded-md border border-input bg-background p-2" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="block text-sm">{t('companion.prompt')}<textarea required maxLength={6000} rows={5} className="mt-1 w-full rounded-md border border-input bg-background p-2" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <label className="block text-sm">{t('companion.time')}<input type="time" required className="ml-2 rounded-md border border-input bg-background p-2" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <p className="text-sm text-muted-foreground">{providerID} / {modelID}</p>
          <Button type="submit" disabled={busy || !providerID || !modelID}>{t('companion.save')}</Button>
        </form>
      </>}
    </div>
  </MobileFullscreenSurface>;
}
