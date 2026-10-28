import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCheckboxRow, SettingsFieldRow, SettingsSection, SETTINGS_SELECT_SIZE, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

const sourceSchema = z.enum(['past-chats', 'follow-ups', 'notion', 'calendar', 'outlook']);
const responseSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })) })),
  connected: z.object({ notion: z.boolean(), calendar: z.boolean(), mailAccounts: z.array(z.string()) }),
  approval: z.object({ enabled: z.boolean(), projectId: z.string(), modelID: z.string(), sources: z.array(sourceSchema), mailAccounts: z.array(z.string()) }).nullable(),
});
type Source = z.infer<typeof sourceSchema>;
const base = '/api/companion/personal-awareness';

export function PersonalAwarenessSection(): React.ReactNode {
  const { t } = useI18n();
  const blocked = useEnterpriseMode();
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
  const [data, setData] = React.useState<z.infer<typeof responseSchema> | null>(null);
  const [projectId, setProject] = React.useState('');
  const [modelID, setModel] = React.useState('');
  const [sources, setSources] = React.useState<Source[]>([]);
  const [accounts, setAccounts] = React.useState<string[]>([]);
  const [approved, setApproved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const generation = React.useRef(0);
  const refresh = React.useCallback(async (revision: number) => {
    const response = await runtimeFetch(base, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Personal review unavailable');
    const next = responseSchema.parse(await response.json());
    if (generation.current !== revision) return;
    setData(next);
    setProject(next.approval?.projectId ?? '');
    setModel(next.approval?.modelID ?? '');
    const verifiedAccounts = (next.approval?.mailAccounts ?? []).filter((address) => next.connected.mailAccounts.includes(address));
    setSources((next.approval?.sources ?? []).filter((source) => {
      if (source === 'notion' || source === 'calendar') return next.connected[source];
      if (source === 'outlook') return verifiedAccounts.length > 0;
      return true;
    }));
    setAccounts(verifiedAccounts);
    setApproved(false);
  }, []);
  React.useEffect(() => {
    const revision = ++generation.current;
    setData(null); setProject(''); setModel(''); setSources([]); setAccounts([]); setApproved(false); setBusy(false); setError(false);
    if (!blocked) void refresh(revision).catch(() => { if (generation.current === revision) setError(true); });
    return () => { generation.current = revision + 1; };
  }, [runtime, blocked, refresh]);
  const mutate = async (enable: boolean) => {
    if (busy) return;
    const revision = generation.current;
    setBusy(true); setError(false);
    reportSettingsSaveState('saving');
    try {
      const options: RequestInit = { method: enable ? 'PUT' : 'DELETE', signal: AbortSignal.timeout(15000) };
      if (enable) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({
          approved, projectId, providerID: 'openai', modelID, sources,
          mailAccounts: sources.includes('outlook') ? accounts : [],
        });
      }
      const response = await runtimeFetch(base, options);
      if (!response.ok) throw new Error('Personal review update failed');
      if (generation.current !== revision) return;
      reportSettingsSaveState('saved');
      if (blocked) { setData(null); setApproved(false); }
      else await refresh(revision);
    } catch {
      if (generation.current === revision) { setError(true); reportSettingsSaveState('error'); }
    } finally { if (generation.current === revision) setBusy(false); }
  };
  const toggle = (source: Source, checked: boolean) => {
    setApproved(false);
    setSources((current) => checked ? [...current, source] : current.filter((item) => item !== source));
  };
  const project = data?.projects.find((item) => item.id === projectId);
  return <SettingsSection title={t('awareness.title')} settingsItem="integrations.personal-awareness" contentClassName="space-y-4"
    headerAction={<Button type="button" size="sm" variant="ghost" disabled={busy || blocked} onClick={() => { setError(false); void refresh(generation.current).catch(() => setError(true)); }}>{t('home.refresh')}</Button>}>
    <p className="text-sm text-muted-foreground">{t('awareness.disclosure')}</p>
    {blocked ? <>
      <p className="text-sm text-muted-foreground">{t('outlook.blocked')}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void mutate(false)}>{t('awareness.disable')}</Button>
    </> : <>
      {!data && !error ? <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p> : null}
      {data?.approval?.enabled ? <p role="status" className="text-sm">{t('awareness.enabled')}</p> : null}
      {data && !data.projects.length ? <p className="text-sm text-muted-foreground">{t('awareness.empty')}</p> : null}
      <SettingsFieldRow label={t('awareness.folder')}><Select value={projectId} disabled={busy || !data} onValueChange={(value) => { setProject(value); setModel(''); setApproved(false); }}>
        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('awareness.folder')}><SelectValue placeholder={t('awareness.folder')} /></SelectTrigger>
        <SelectContent>{data?.projects.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select></SettingsFieldRow>
      <SettingsFieldRow label={t('awareness.model')}><Select value={modelID} disabled={busy || !project} onValueChange={(value) => { setModel(value); setApproved(false); }}>
        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('awareness.model')}><SelectValue placeholder={t('awareness.model')} /></SelectTrigger>
        <SelectContent>{project?.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
      </Select></SettingsFieldRow>
      <SettingsCheckboxRow label={t('awareness.chats')} ariaLabel={t('awareness.chats')} checked={sources.includes('past-chats')} disabled={busy} onChange={(checked) => toggle('past-chats', checked)} />
      <SettingsCheckboxRow label={t('awareness.followups')} ariaLabel={t('awareness.followups')} checked={sources.includes('follow-ups')} disabled={busy} onChange={(checked) => toggle('follow-ups', checked)} />
      <SettingsCheckboxRow label="Notion" ariaLabel="Notion" checked={sources.includes('notion')} disabled={busy || !data?.connected.notion} onChange={(checked) => toggle('notion', checked)} />
      <SettingsCheckboxRow label={t('awareness.calendar')} ariaLabel={t('awareness.calendar')} checked={sources.includes('calendar')} disabled={busy || !data?.connected.calendar} onChange={(checked) => toggle('calendar', checked)} />
      {data?.connected.mailAccounts.map((address) => <SettingsCheckboxRow key={address} label={`Outlook · ${address}`} ariaLabel={`Outlook · ${address}`} checked={sources.includes('outlook') && accounts.includes(address)} disabled={busy || (!accounts.includes(address) && accounts.length >= 5)} onChange={(checked) => {
        setApproved(false);
        const next = checked ? [...accounts, address] : accounts.filter((item) => item !== address);
        setAccounts(next);
        if (checked && !sources.includes('outlook')) setSources([...sources, 'outlook']);
        if (!next.length) setSources(sources.filter((item) => item !== 'outlook'));
      }} />)}
      <p className="text-xs text-muted-foreground">{t('awareness.connections')}</p>
      <SettingsCheckboxRow label={t('awareness.approve')} ariaLabel={t('awareness.approve')} checked={approved} disabled={busy} onChange={setApproved} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || !approved || !sources.length || !project?.models.some((model) => model.id === modelID)} onClick={() => void mutate(true)}>{busy ? t('common.loading') : t('awareness.enable')}</Button>
        {data?.approval?.enabled ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void mutate(false)}>{t('awareness.disable')}</Button> : null}
      </div>
    </>}
    {error ? <p role="alert" className="text-sm text-destructive">{t('awareness.error')}</p> : null}
  </SettingsSection>;
}
