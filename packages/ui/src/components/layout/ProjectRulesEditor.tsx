import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { FilesystemError } from '@/lib/api/files-errors';
import { projectRulesSettingsSchema, type ProjectRulesKind, type ProjectRulesSnapshot } from '@/lib/api/project-rules-schema';

export function ProjectRulesEditor({ directory, kind, onFinish, onGuard }: { directory: string; kind: ProjectRulesKind; onFinish: () => void; onGuard: (guard: boolean) => void }) {
  const { files } = useRuntimeAPIs();
  const { t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<ProjectRulesSnapshot>();
  const [content, setContent] = React.useState('');
  const [model, setModel] = React.useState('');
  const [share, setShare] = React.useState<ProjectRulesSnapshot['settings']['share']>('inherit');
  const [policies, setPolicies] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<'error' | 'conflict' | 'invalid'>();
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setSnapshot(undefined); setBusy(true); setError(undefined);
    files.readProjectRules?.(directory, kind).then(value => {
      if (!alive) return;
      setSnapshot(value); setContent(value.content); setModel(value.settings.model); setShare(value.settings.share);
      setPolicies(value.settings.policies.map(policy => `${policy.effect} ${policy.resource}`).join('\n'));
    }).catch(() => { if (alive) setError('error'); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [files, directory, kind, reload]);
  const initialPolicies = snapshot?.settings.policies.map(policy => `${policy.effect} ${policy.resource}`).join('\n') ?? '';
  const dirty = Boolean(snapshot && (kind === 'instructions' ? content !== snapshot.content : model !== snapshot.settings.model || share !== snapshot.settings.share || policies !== initialPolicies));
  React.useEffect(() => { onGuard(dirty || busy); return () => onGuard(false); }, [dirty, busy, onGuard]);
  const save = async (restore = false) => {
    if (!snapshot || !files.saveProjectRules || busy) return;
    const parsedPolicies = policies.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const match = /^(allow|deny)\s+(.+)$/.exec(line);
      return { effect: match?.[1], resource: match?.[2] };
    });
    const settings = projectRulesSettingsSchema.safeParse({ model, share, policies: parsedPolicies });
    if (!restore && kind === 'configuration' && !settings.success) { setError('invalid'); return; }
    setBusy(true); setError(undefined);
    try {
      await files.saveProjectRules({ directory, kind, expectedRevision: snapshot.revision, content, settings: kind === 'instructions' || restore ? snapshot.settings : settings.success ? settings.data : snapshot.settings, restore });
      onFinish();
    } catch (failure) { setError(failure instanceof FilesystemError && failure.status === 409 ? 'conflict' : 'error'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4 typography-ui-label">
    <p className="break-all text-muted-foreground typography-meta">{snapshot?.path ?? directory}</p>
    <p className="text-muted-foreground">{t('personalTools.editHint')}</p>
    {busy && !snapshot && <p role="status">{t('common.loading')}</p>}
    {snapshot && (kind === 'instructions' ? <SettingsStackedField label={t('workspaceStatus.instructions')} controlClassName="w-full max-w-none"><Textarea aria-label={t('workspaceStatus.instructions')} className="min-h-64 font-mono typography-ui-label" value={content} disabled={busy} onChange={event => setContent(event.target.value)} /></SettingsStackedField> : <>
      <SettingsStackedField label={t('workspaceStatus.model')}><Input aria-label={t('workspaceStatus.model')} value={model} placeholder={t('personalTools.inherit')} disabled={busy} onChange={event => setModel(event.target.value)} /></SettingsStackedField>
      <SettingsStackedField label={t('workspaceStatus.sharing')}><Select value={share} onValueChange={setShare} disabled={busy}><SelectTrigger className="w-full max-w-[28ch]"><SelectValue>{t(`personalTools.${share}`)}</SelectValue></SelectTrigger><SelectContent>{(['inherit', 'manual', 'auto', 'disabled'] as const).map(value => <SelectItem key={value} value={value}>{t(`personalTools.${value}`)}</SelectItem>)}</SelectContent></Select></SettingsStackedField>
      <SettingsStackedField label={t('workspaceStatus.policies')} description={t('personalTools.policyFormat')}><Textarea aria-label={t('workspaceStatus.policies')} value={policies} disabled={busy} onChange={event => setPolicies(event.target.value)} className="min-h-32 font-mono typography-ui-label" /></SettingsStackedField>
    </>)}
    {error && <p role="alert" className="text-status-error">{t(error === 'conflict' ? 'personalTools.conflict' : error === 'invalid' ? 'personalTools.invalid' : 'personalTools.error')}</p>}
    {error === 'conflict' && <Button variant="outline" size="sm" disabled={busy} onClick={() => setReload(value => value + 1)}>{t('personalTools.reload')}</Button>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
      {snapshot?.previous && <Button variant="outline" size="sm" disabled={busy || dirty} onClick={() => void save(true)}>{t('personalTools.restore')}</Button>}
      <Button variant="outline" size="sm" disabled={busy} onClick={onFinish}>{t('personalTools.cancel')}</Button>
      <Button size="sm" disabled={!snapshot || busy || !dirty} onClick={() => void save()}>{t('personalTools.save')}</Button>
    </div>
  </div>;
}
