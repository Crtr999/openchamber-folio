import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { cacheTeachingInputs, readTeachingInputs, cacheTeachingSkillDraft, compileTeachingSkill, readTeachingSkill, teachingSkillModels, installTeachingSkill, saveTeachingSkillDraft, testTeachingSkill, type TeachingSkillDraft, type TeachingSkillModel } from '@/lib/personal-workspace/teaching';

export function TeachingSkillPanel({ source, directory, onClose, onBusyChange }: { source: string; directory?: string; onClose: () => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useI18n();
  const [models, setModels] = React.useState<TeachingSkillModel[]>([]);
  const [modelKey, setModelKey] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [task, setTask] = React.useState('');
  const [inputsLoaded, setInputsLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState<TeachingSkillDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [slow, setSlow] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const locked = React.useRef(false);
  const active = React.useRef(true);
  const editor = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = React.useCallback(async () => {
    setBusy(true); setError(false);
    try {
      const inputs = readTeachingInputs(source);
      const [choices, saved] = await Promise.all([teachingSkillModels(), readTeachingSkill(source)]);
      if (!active.current) return;
      setModels(choices); setDraft(saved);
      setNotes(inputs.notes); setTask(inputs.task); setInputsLoaded(true);
      const config = useConfigStore.getState();
      const current = choices.find(model => model.providerID === config.currentProviderId && model.id === config.currentModelId);
      setModelKey(current ? JSON.stringify([current.providerID, current.id]) : '');
    } catch { if (active.current) setError(true); }
    finally { if (active.current) setBusy(false); }
  }, [source]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  React.useEffect(() => { if (draft) { try { cacheTeachingSkillDraft(draft); } catch { setError(true); } } }, [draft]);
  React.useEffect(() => { if (inputsLoaded) { try { cacheTeachingInputs(source, { notes, task }); } catch { setError(true); } } }, [source, notes, task, inputsLoaded]);
  React.useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [busy]);
  const model = models.find(choice => JSON.stringify([choice.providerID, choice.id]) === modelKey);
  const work = async (action: 'compile' | 'save' | 'install' | 'test') => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(false); setNotice('');
    try {
      if (action === 'compile' && model) {
        const next = await compileTeachingSkill(source, notes, model);
        if (active.current) { setDraft(next); requestAnimationFrame(() => editor.current?.focus()); }
      } else if (action === 'save' && draft) {
        const next = await saveTeachingSkillDraft(draft);
        if (active.current) { setDraft(next); setNotice(t('workspace.saved')); }
      } else if (action === 'install' && draft) {
        const installed = await installTeachingSkill(draft);
        if (active.current) { setDraft({ ...draft, installed: true }); setNotice(t('workspace.skillInstalled', { name: installed.name })); }
      } else if (action === 'test' && model && directory && draft?.installed) {
        const session = await testTeachingSkill(source, task, directory, model);
        if (active.current) { useSessionUIStore.getState().setCurrentSession(session.sessionId, session.directory); onClose(); }
      }
    } catch { if (active.current) setError(true); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  };
  const edit = (patch: Partial<Pick<TeachingSkillDraft, 'name' | 'markdown'>>) => setDraft(value => value ? { ...value, ...patch, installed: false } : value);
  return <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5" aria-label={t('workspace.skillReview')} aria-busy={busy}>
    <h2 className="typography-ui-label font-medium">{t('workspace.skillReview')}</h2>
    <label className="space-y-2 typography-ui-label">{t('workspaceStatus.model')}
      <Select value={modelKey} onValueChange={value => setModelKey(value ?? '')} disabled={busy}>
        <SelectTrigger className="w-full"><SelectValue placeholder={t('workspaceStatus.model')}>{model ? `${model.providerID}/${model.name}` : t('workspaceStatus.model')}</SelectValue></SelectTrigger>
        <SelectContent>{models.map(choice => <SelectItem key={JSON.stringify([choice.providerID, choice.id])} value={JSON.stringify([choice.providerID, choice.id])}>{choice.providerID}/{choice.name}</SelectItem>)}</SelectContent>
      </Select>
    </label>
    {!busy && models.length === 0 && <p className="typography-ui-label text-muted-foreground">{t('workspace.skillNoModels')}</p>}
    <label className="space-y-2 typography-ui-label">{t('workspace.brief')}<Textarea aria-label={t('workspace.brief')} value={notes} maxLength={6000} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
    <p className="max-w-prose typography-ui-label text-muted-foreground">{t('workspace.skillDisclosure')}</p>
    <Button disabled={busy || !model || !notes.trim()} onClick={() => void work('compile')}>{t('workspace.skillCreate')}</Button>
    {draft && <>
      <label className="space-y-2 typography-ui-label">{t('workspace.name')}<Input aria-label={t('workspace.name')} value={draft.name} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100} disabled={busy} onChange={event => edit({ name: event.target.value, markdown: draft.markdown.replace(/^name:\s*.+$/m, `name: ${event.target.value}`) })} /></label>
      <label className="space-y-2 typography-ui-label">SKILL.md<Textarea ref={editor} aria-label="SKILL.md" className="min-h-64 font-mono" value={draft.markdown} maxLength={60_000} disabled={busy} onChange={event => edit({ markdown: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void work('save')}>{t('personalTools.save')}</Button><Button disabled={busy || draft.installed} onClick={() => void work('install')}>{t('workspace.skillInstall')}</Button></div>
      {draft.installed && <>
        <p className="typography-ui-label text-muted-foreground">{t('workspace.skillTestHint')}</p>
        <label className="space-y-2 typography-ui-label">{t('workspace.skillTest')}<Textarea aria-label={t('workspace.skillTest')} value={task} maxLength={6000} disabled={busy} onChange={event => setTask(event.target.value)} /></label>
        <Button variant="outline" disabled={busy || !directory || !model || !task.trim()} onClick={() => void work('test')}>{t('workspace.skillTest')}</Button>
      </>}
    </>}
    <div role="status" className="typography-ui-label text-muted-foreground">{busy ? t(slow ? 'workspace.skillSlow' : 'workspace.loading') : notice}</div>
    {error && <div role="alert" className="space-y-2 typography-ui-label text-destructive"><p>{t('workspace.skillError')}</p><Button variant="outline" disabled={busy} onClick={() => void load()}>{t('workspace.connected')}</Button></div>}
  </section>;
}
