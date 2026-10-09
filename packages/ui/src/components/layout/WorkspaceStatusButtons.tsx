import React from 'react';
import { ProjectRulesEditor } from './ProjectRulesEditor';
import type { ProjectRulesKind } from '@/lib/api/project-rules-schema';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import type { RemoteClientRecord } from '@/lib/api/types';
import { remoteClientRecordsSchema } from '@/lib/api/client-auth-schema';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { deviceActivity, relayStatusSchema, serverInfoSchema, versionRelation } from '@/lib/workspace-status';
import { useUIStore } from '@/stores/useUIStore';

type Result<T> = { value: T; error?: never } | { error: true; value?: never };
type RulesSnapshot = Awaited<ReturnType<typeof opencodeClient.getRulesConfiguration>>;
type PhoneSnapshot = {
  server: Result<{ openchamberVersion: string }>;
  relay: Result<{ enabled: boolean; state: string; connectedClients?: number; blockedByEnterprise?: boolean }>;
  clients: Result<RemoteClientRecord[]>;
  checked: number;
};
const resultOf = <T,>(result: PromiseSettledResult<T>): Result<T> => result.status === 'fulfilled' ? { value: result.value } : { error: true };
const activityKeys = {
  revoked: 'workspaceStatus.revoked', expired: 'workspaceStatus.expired', recent: 'workspaceStatus.recent',
  inactive: 'workspaceStatus.inactive', unseen: 'workspaceStatus.unseen',
} satisfies Record<ReturnType<typeof deviceActivity>, I18nKey>;
const versionKeys = {
  sameVersion: 'workspaceStatus.sameVersion', differentVersion: 'workspaceStatus.differentVersion', unreported: 'workspaceStatus.unreported',
} satisfies Record<ReturnType<typeof versionRelation>, I18nKey>;

/** Status views and explicit local rules editing on the active runtime. Phone status is explicitly unsupported without clientAuth
 * (VS Code); rules use the same SDK/file capability on web, desktop and shared mobile builds.
 * Official TestFlight builds retain their own UI. Pairing is unchanged; rule saves use a scoped FilesAPI capability. */
export function WorkspaceStatusButtons({ directory }: { directory: string }) {
  const { t } = useI18n();
  const { clientAuth, files } = useRuntimeAPIs();
  const [panel, setPanel] = React.useState<'phone' | 'rules' | null>(null);
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [phone, setPhone] = React.useState<PhoneSnapshot>();
  const [rules, setRules] = React.useState<Result<RulesSnapshot>>();
  const [instructions, setInstructions] = React.useState<Result<string>>();
  const [editing, setEditing] = React.useState<ProjectRulesKind | null>(null);
  const [guard, setGuard] = React.useState(false);
  React.useEffect(() => { setEditing(null); }, [panel, runtime, directory]);
  const finishEditing = () => { setEditing(null); refresh(); };
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => { setRuntime(getRuntimeKey()); setPanel(null); setPhone(undefined); setRules(undefined); setInstructions(undefined); }), []);
  // Close before a different project's contents can be displayed. Header passes its non-sticky directory.
  React.useEffect(() => { setPanel(null); setRules(undefined); setInstructions(undefined); }, [directory]);
  React.useEffect(() => {
    if (!panel) return;
    let alive = true;
    const abort = new AbortController();
    setBusy(true);
    setPhone(undefined); setRules(undefined); setInstructions(undefined);
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      if (panel === 'phone' && clientAuth) {
        const request = async (path: string) => {
          const response = await runtimeFetch(path, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]), cache: 'no-store' });
          if (!response.ok) throw new Error('Status unavailable');
          return response.json();
        };
        const [server, relay, clients] = await Promise.allSettled([
          request('/api/system/info').then((data) => serverInfoSchema.parse(data)),
          request('/api/openchamber/relay/status').then((data) => relayStatusSchema.parse(data)),
          clientAuth.listClients().then((clients) => remoteClientRecordsSchema.parse(clients)),
        ]);
        if (alive) setPhone({ server: resultOf(server), relay: resultOf(relay), clients: resultOf(clients), checked: Date.now() });
      }
      if (panel === 'rules' && directory) {
        const [configuration, file] = await Promise.allSettled([
          opencodeClient.getRulesConfiguration(directory),
          files.readFile ? files.readFile(`${directory.replace(/\/$/, '')}/AGENTS.md`, { directory, optional: true, fresh: true }).then((data) => data.content) : Promise.reject(new Error('File reading unavailable')),
        ]);
        if (alive) { setRules(resultOf(configuration)); setInstructions(resultOf(file)); }
      }
      inFlight = false;
      if (alive) setBusy(false);
    };
    void load();
    const timer = panel === 'phone' && clientAuth ? window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000) : undefined;
    return () => { alive = false; abort.abort(); if (timer) clearInterval(timer); };
  }, [panel, directory, runtime, revision, clientAuth, files]);
  const error = <p role="alert" className="text-status-error">{t('workspaceStatus.error')}</p>;
  const row = (label: string, value: React.ReactNode) => <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2"><span className="text-muted-foreground">{label}</span><span className="break-all text-right">{value}</span></div>;
  const config = rules?.value?.config;
  return <>
    <Button variant="ghost" size="sm" className="app-region-no-drag h-8 gap-1 px-2" title={t('workspaceStatus.rules')} onClick={() => setPanel('rules')}><Icon name="shield" className="size-4" /><span>{t('workspaceStatus.rules')}</span></Button>
    <Dialog open={panel !== null} onOpenChange={(open) => { if (!open && !guard) setPanel(null); }}>
      <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>{t(panel === 'phone' ? 'workspaceStatus.phone' : 'workspaceStatus.rules')}</DialogTitle><DialogDescription>{t(panel === 'phone' ? 'workspaceStatus.phoneHint' : 'workspaceStatus.rulesHint')}</DialogDescription></DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto typography-ui-label" aria-busy={busy}>
          {busy && !phone && !rules && <p role="status">{t('common.loading')}</p>}
          {panel === 'phone' && <>
            {!clientAuth && <p>{t('workspaceStatus.unavailable')}</p>}
            {phone && <>
              {row(t('workspaceStatus.server'), phone.server.error ? error : `${t('workspaceStatus.reachable')} · v${phone.server.value.openchamberVersion}`)}
              {row(t('workspaceStatus.relay'), phone.relay.error ? error : phone.relay.value.blockedByEnterprise ? t('workspaceStatus.blocked') : phone.relay.value.enabled ? `${phone.relay.value.state} · ${phone.relay.value.connectedClients ?? t('workspaceStatus.unreported')}` : t('workspaceStatus.disabled'))}
              <h3 className="font-medium">{t('workspaceStatus.devices')}</h3>
              <p className="text-muted-foreground">{t('workspaceStatus.activityHint')}</p>
              {phone.clients.error ? error : phone.clients.value.length === 0 ? <p>{t('workspaceStatus.noDevices')}</p> : phone.clients.value.map((client) => <div key={client.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap justify-between gap-2"><strong>{client.deviceName || client.label}</strong><span>{t(activityKeys[deviceActivity(client, phone.checked)])}</span></div>
                <p className="text-muted-foreground">{[client.devicePlatform, client.deviceModel].filter(Boolean).join(' · ')}</p>
                {row(t('workspaceStatus.lastActivity'), client.lastUsedAt && Number.isFinite(Date.parse(client.lastUsedAt)) ? new Date(client.lastUsedAt).toLocaleString() : t('workspaceStatus.unseen'))}
                {row(t('workspaceStatus.transport'), client.lastTransport ?? t('workspaceStatus.unreported'))}
                {row(t('workspaceStatus.version'), client.appVersion ? `${client.appVersion} · ${phone.server.value ? t(versionKeys[versionRelation(phone.server.value.openchamberVersion, client.appVersion)]) : t('workspaceStatus.unreported')}` : t('workspaceStatus.unreported'))}
              </div>)}
              <p className="text-muted-foreground">{t('workspaceStatus.versionHint')}</p>
            </>}
            <p className="text-muted-foreground">{t('workspaceStatus.keepAwake')}</p>
            {clientAuth && <Button variant="outline" size="sm" onClick={() => { setPanel(null); useUIStore.getState().setSettingsPage('remote-instances'); useUIStore.getState().setSettingsDialogOpen(true); }}>{t('workspaceStatus.connections')}</Button>}
          </>}
          {panel === 'rules' && editing && <ProjectRulesEditor directory={directory} kind={editing} onFinish={finishEditing} onGuard={setGuard} />}
          {panel === 'rules' && !editing && <>
            {row(t('workspaceStatus.directory'), directory || t('workspaceStatus.unreported'))}
            {directory && files.readProjectRules && files.saveProjectRules && <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setEditing('configuration')}>{t('personalTools.editConfiguration')}</Button></div>}
            {!directory && <p>{t('workspaceStatus.unavailable')}</p>}
            {rules?.error && error}
            {config && <>
              {row(t('workspaceStatus.model'), rules?.value?.defaultModel ? rules.value.defaultModel : t('workspaceStatus.unset'))}
              {row(t('workspaceStatus.sharing'), config.share ?? t('workspaceStatus.unset'))}
              <p className="text-muted-foreground">{t('workspaceStatus.sharingHint')}</p>
              <h3 className="font-medium">{t('workspaceStatus.policies')}</h3>
              <p className="text-muted-foreground">{t('workspaceStatus.policyHint')}</p>
              {rules?.value?.ruleSources.some((source) => source.policies.length || source.permissions.length) ? rules.value.ruleSources.filter((source) => source.policies.length || source.permissions.length).map((source, index) => <div key={source.path ?? index} className="space-y-2">
                <p className="break-all text-xs text-muted-foreground">{source.path ?? t('workspaceStatus.unreported')}</p>
                <ul className="space-y-1 font-mono text-xs">{[...source.policies, ...source.permissions].map((policy, ruleIndex) => <li key={`${ruleIndex}-${policy.action}-${policy.resource}`}>{policy.action} · {policy.resource} → {policy.effect}</li>)}</ul>
              </div>) : <p>{t('workspaceStatus.noPolicies')}</p>}
              <details><summary className="cursor-pointer font-medium">{t('workspaceStatus.sources')}</summary><ul className="mt-2 space-y-1 break-all text-muted-foreground">{rules?.value?.sources.map((source) => <li key={source}>{source}</li>)}</ul></details>
              {rules?.value?.ruleSources.some((source) => source.instructions.length) ? <details><summary className="cursor-pointer font-medium">{t('workspaceStatus.references')}</summary><ul className="mt-2 space-y-1 break-all text-muted-foreground">{rules.value.ruleSources.flatMap((source) => source.instructions).map((reference, index) => <li key={`${index}-${reference}`}>{reference}</li>)}</ul></details> : null}
            </>}
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{t('workspaceStatus.instructions')}</h3>{directory && files.readProjectRules && files.saveProjectRules && <Button variant="outline" size="sm" onClick={() => setEditing('instructions')}>{t('personalTools.editInstructions')}</Button>}</div>
            {instructions?.error ? error : instructions?.value ? <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 font-sans text-sm leading-relaxed">{instructions.value}</pre> : instructions && <p>{t('workspaceStatus.noInstructions')}</p>}
          </>}
        </div>
        {!editing && <div className="flex justify-end border-t border-border pt-3"><Button variant="outline" size="sm" disabled={busy} onClick={() => refresh()}>{t('workspaceStatus.refresh')}</Button></div>}
      </DialogContent>
    </Dialog>
  </>;
}
