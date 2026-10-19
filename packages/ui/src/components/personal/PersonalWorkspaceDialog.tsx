import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { artifactPrompt, createArtifact, isWorkspaceArtifact, parseArtifact, serializeArtifact, workspaceArtifactSchema, workflowPrompt, type PersonalTool, type WorkspaceArtifact } from '@/lib/personal-workspace/model';
import { readSites, saveSites, siteSchema, usePersonalReferences, type PersonalReference } from '@/lib/personal-workspace/references';
import { artifactStem, downloadArtifact, sketchPng } from '@/lib/personal-workspace/exports';
import { saveWorkspaceCopy } from '@/lib/personal-workspace/storage';
import { parseDelimitedText } from '@/components/views/files/previews/delimitedText';
import { WorkspaceEditor } from './WorkspaceEditor';
import { TeachingDialog } from './TeachingDialog';

const fieldClass = 'w-full rounded-md border bg-transparent px-3 py-2 typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function PersonalWorkspaceDialog({ tool, directory, isCurrent, onClose, onPrompt, onAttach, onReference }: {
  tool: PersonalTool; directory: string | undefined; onClose: () => void;
  isCurrent: () => boolean;
  onPrompt: (text: string) => void;
  onAttach: (files: File[]) => Promise<void>;
  onReference: (reference: PersonalReference) => Promise<void>;
}) {
  const { t } = useI18n(); const { files } = useRuntimeAPIs();
  const runtime = React.useRef(getRuntimeKey()).current;
  // The created artifact is the untouched-draft baseline. Seeding `saved` with
  // its serialization means a fresh dialog is not dirty until the first edit,
  // so Cancel/Escape on a brand-new sketch closes without a discard prompt.
  const initial = React.useMemo(() => ['document', 'spreadsheet', 'presentation', 'sketch'].includes(tool) ? createArtifact(tool === 'spreadsheet' ? 'spreadsheet' : tool === 'presentation' ? 'presentation' : tool === 'sketch' ? 'sketch' : 'document', t('workspace.untitled')) : null, [tool, t]);
  const [artifact, setArtifact] = React.useState<WorkspaceArtifact | null>(initial);
  const [saved, setSaved] = React.useState(() => initial ? serializeArtifact(initial) : '');
  const [brief, setBrief] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [entries, setEntries] = React.useState<{ path: string; name: string }[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [siteName, setSiteName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [context, setContext] = React.useState('');
  const [editingSiteId, setEditingSiteId] = React.useState<string | null>(null);
  const [addingSite, setAddingSite] = React.useState(false);
  const importedFile = React.useRef<HTMLInputElement>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const current = () => alive.current && getRuntimeKey() === runtime && isCurrent();
  const resources = usePersonalReferences(query);
  const dirty = Boolean((artifact && serializeArtifact(artifact) !== saved) || brief.trim() || siteName || url || context);
  const requestClose = () => { if (dirty) setConfirmDiscard(true); else onClose(); };
  const operation = async (action: () => Promise<void>) => {
    if (busy || !current()) return; setBusy(true); setError('');
    try { await action(); } catch { if (current()) setError(t('workspace.error')); }
    finally { if (current()) setBusy(false); }
  };
  React.useEffect(() => {
    if (tool !== 'library' && tool !== 'templates') return;
    if (!directory || !files.readFile) { setError(t('workspace.unavailable')); return; }
    let active = true; setLoading(true);
    files.listDirectory(`${directory.replace(/\/$/, '')}/artifacts`, { respectGitignore: false }).then((result) => {
      if (active && getRuntimeKey() === runtime) setEntries(result.entries.filter((entry) => !entry.isDirectory && isWorkspaceArtifact(entry.path)).map(({ path, name }) => ({ path, name })));
    }).catch(() => { if (active) setError(t('workspace.libraryError')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [directory, files, runtime, tool, t]);
  const saveCopy = async () => {
    if (!artifact || !directory || !files.uploadFile) throw new Error('save_unavailable');
    const content = serializeArtifact(artifact);
    const path = await saveWorkspaceCopy(files, directory, `${artifactStem(artifact.title)}.ocwork`, new Blob([content], { type: 'application/json' }), runtime);
    if (!current()) return;
    setSaved(content); useUIStore.getState().openContextFile(directory, path);
  };
  const attach = async () => {
    if (!artifact) return;
    const attachments = [new File([serializeArtifact(artifact)], `${artifactStem(artifact.title)}.ocwork`, { type: 'text/plain' })];
    if (artifact.kind === 'sketch') {
      const png = await sketchPng(artifact); if (!current()) return;
      attachments.unshift(new File([png], `${artifactStem(artifact.title)}.png`, { type: 'image/png' }));
    }
    await onAttach(attachments);
    if (current()) { setSaved(serializeArtifact(artifact)); onClose(); }
  };
  const importFile = async (file: File) => {
    if (file.size > 8_000_000) throw new Error('too_large');
    const text = await file.text(); if (!current()) return;
    if (isWorkspaceArtifact(file.name)) setArtifact(parseArtifact(text));
    else if (/\.(csv|tsv)$/i.test(file.name)) {
      const table = parseDelimitedText(text, /\.tsv$/i.test(file.name) ? '\t' : ',');
      if (table.truncated || table.totalRows > 500 || table.columnCount > 50) throw new Error('table_limit');
      setArtifact(workspaceArtifactSchema.parse({ version: 1, kind: 'spreadsheet', title: file.name, template: false, sheets: [{ name: 'Sheet1', rows: [table.header, ...table.rows] }] }));
    } else setArtifact(workspaceArtifactSchema.parse({ version: 1, kind: 'document', title: file.name, template: false, markdown: text }));
    setSaved('');
  };
  const workflow = tool === 'pdf' || tool === 'teach' || tool === 'notion';
  const sketch = artifact?.kind === 'sketch';
  if (tool === 'teach') return <TeachingDialog onClose={onClose} directory={directory} />;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) requestClose(); }}>
    <DialogContent className={sketch ? 'flex h-[min(600px,74dvh)] w-[min(920px,92vw)] max-w-[920px] flex-col gap-0 overflow-hidden rounded-3xl p-0' : artifact ? 'h-[min(850px,92dvh)] max-w-6xl overflow-hidden' : 'max-w-2xl'} showCloseButton={!busy && !sketch}>
      <DialogHeader className={sketch ? 'sr-only' : undefined}><DialogTitle>{t(`workspace.${tool}`)}</DialogTitle><DialogDescription className={tool === 'sites' ? 'sr-only' : undefined}>{t(artifact ? 'workspace.editorHint' : workflow ? 'workspace.workflowHint' : 'workspace.referenceHint')}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="typography-ui-label text-destructive">{error}</p>}
      {artifact ? <>
        <WorkspaceEditor value={artifact} onChange={setArtifact} sketchActions={sketch ? <><Button variant="secondary" className="h-10 rounded-full shadow-sm" disabled={busy} onClick={requestClose}>{t('personalTools.cancel')}</Button><Button className="h-10 rounded-full shadow-sm" disabled={busy || artifact.kind !== 'sketch' || !artifact.elements.length} onClick={() => void operation(attach)}>{busy ? t('workspace.loading') : t('workspace.attach')}</Button></> : undefined} onExport={async (blob, name) => {
          if (!directory || !files.uploadFile) { downloadArtifact(blob, name); return; }
          const path = await saveWorkspaceCopy(files, directory, name, blob, runtime);
          if (current()) useUIStore.getState().openContextFile(directory, path);
        }} />
        {!sketch && <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 typography-ui-label"><input type="checkbox" checked={artifact.template} onChange={(event) => setArtifact({ ...artifact, template: event.target.checked })} />{t('workspace.template')}</label>
          <input aria-label={t('workspace.brief')} className={`${fieldClass} min-w-0 flex-1 basis-48`} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={t('workspace.brief')} />
          <Button size="sm" variant="outline" disabled={busy || !brief.trim()} onClick={() => { onPrompt(artifactPrompt(artifact, brief)); setSaved(serializeArtifact(artifact)); onClose(); }}>{t('workspace.ai')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void operation(attach)}>{t('workspace.attach')}</Button>
          <Button size="sm" disabled={busy || !directory || !files.uploadFile} onClick={() => void operation(saveCopy)}>{busy ? t('workspace.loading') : t('workspace.saveCopy')}</Button>
        </div>}
      </> : workflow ? <>
        <textarea autoFocus aria-label={t('workspace.brief')} className={`${fieldClass} min-h-36 resize-y`} value={brief} maxLength={20_000} onChange={(event) => setBrief(event.target.value)} placeholder={t('workspace.brief')} />
        <DialogFooter><Button disabled={!brief.trim()} onClick={() => { onPrompt(workflowPrompt(tool, brief)); onClose(); }}>{t('workspace.prepare')}</Button></DialogFooter>
      </> : <>
        <input aria-label={t('workspace.search')} className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('workspace.search')} />
        {(tool === 'sites' || tool === 'references') && <>
          {resources.error && <p role="status" className="typography-meta text-muted-foreground">{t('workspace.partial')}</p>}
          <div className="max-h-64 overflow-auto">
            {tool === 'references' && resources.references.map((item) => <Button key={`${item.kind}:${item.id}`} variant="ghost" className="h-auto w-full justify-start gap-3 py-2 text-left" disabled={busy} onClick={() => void operation(async () => { await onReference(item); if (current()) onClose(); })}>
              <span className="w-20 shrink-0 typography-meta text-muted-foreground">{t(`workspace.${item.kind}`)}</span><span className="min-w-0"><span className="block truncate">{item.title}</span><span className="block truncate typography-meta text-muted-foreground">{item.detail}</span></span>
            </Button>)}
            {tool === 'sites' && resources.sites.filter((site) => `${site.name} ${site.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((site) => <div key={site.id} className="group flex items-center gap-1 rounded-xl hover:bg-interactive-hover">
              <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-xl py-3 text-start" title={t('workspace.attach')} disabled={busy} onClick={() => void operation(async () => { await onReference({ kind: 'site', id: site.id, title: site.name, detail: site.url, site }); if (current()) onClose(); })}><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-subtle)]"><Icon name="global" className="size-5 text-muted-foreground" /></span><span className="min-w-0"><span className="block truncate font-medium">{site.name}</span><span className="block truncate typography-meta text-muted-foreground">{site.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></span></Button>
              <Button size="icon" variant="ghost" className="size-9 shrink-0 rounded-full" title={t('workspace.edit')} aria-label={`${t('workspace.edit')} ${site.name}`} onClick={() => { setAddingSite(true); setEditingSiteId(site.id); setSiteName(site.name); setUrl(site.url); setContext(site.context); }}><Icon name="pencil" className="size-4" /></Button>
              <Button size="icon" variant="ghost" className="me-1 size-9 shrink-0 rounded-full" title={t('workspace.remove')} aria-label={`${t('workspace.remove')} ${site.name}`} onClick={() => { try { saveSites(runtime, readSites(runtime).filter((item) => item.id !== site.id)); if (editingSiteId === site.id) { setEditingSiteId(null); setAddingSite(false); setSiteName(''); setUrl(''); setContext(''); } } catch { setError(t('workspace.error')); } }}><Icon name="close" className="size-4" /></Button>
            </div>)}
            {tool === 'sites' && !resources.sites.length && !resources.sitesError && <p className="px-4 py-8 text-center typography-ui-label text-muted-foreground">{t('workspace.emptySites')}</p>}
          </div>
          {tool === 'sites' && (addingSite ? <form className="space-y-3 border-t pt-4" onSubmit={(event) => { event.preventDefault(); setError(''); try { const site = siteSchema.parse({ id: editingSiteId ?? crypto.randomUUID(), name: siteName.trim() || new URL(url).hostname, url, context }); const existing = readSites(runtime); saveSites(runtime, editingSiteId ? existing.map((item) => item.id === editingSiteId ? site : item) : [...existing, site]); setEditingSiteId(null); setAddingSite(false); setSiteName(''); setUrl(''); setContext(''); } catch { setError(t('workspace.siteError')); } }}>
            <input autoFocus aria-label="URL" type="url" className={`${fieldClass} rounded-xl`} value={url} required maxLength={2000} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
            <input aria-label={t('workspace.name')} className={`${fieldClass} rounded-xl`} value={siteName} maxLength={200} onChange={(event) => setSiteName(event.target.value)} placeholder={t('workspace.name')} />
            <details open={Boolean(context) || undefined}><summary className="cursor-pointer typography-ui-label text-muted-foreground">{t('workspace.context')}</summary><textarea aria-label={t('workspace.context')} className={`${fieldClass} mt-2 rounded-xl`} value={context} maxLength={50_000} onChange={(event) => setContext(event.target.value)} placeholder={t('workspace.context')} /></details>
            <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => { setAddingSite(false); setEditingSiteId(null); setSiteName(''); setUrl(''); setContext(''); }}>{t('personalTools.cancel')}</Button><Button type="submit" size="sm" disabled={resources.sitesError}>{t('personalTools.save')}</Button></div>
          </form> : <Button variant="ghost" className="justify-start gap-3 rounded-xl" disabled={resources.sitesError} onClick={() => setAddingSite(true)}><Icon name="add" className="size-5" />{t('workspace.addSite')}</Button>)}
        </>}
        {(tool === 'templates' || tool === 'library') && <>
          <div className="max-h-80 overflow-auto">
            {loading && <p role="status" className="typography-ui-label">{t('workspace.loading')}</p>}
            {!loading && entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((entry) => <Button key={entry.path} variant="ghost" className="h-auto w-full justify-start truncate py-2" disabled={busy} onClick={() => void operation(async () => {
              if (!files.readFile) throw new Error('read_unavailable');
              const result = await files.readFile(entry.path, { directory }); if (!current()) return;
              const loaded = parseArtifact(result.content);
              if (tool === 'library' && directory) { useUIStore.getState().openContextFile(directory, entry.path); onClose(); }
              else { setArtifact({ ...loaded, template: false }); setSaved(''); }
            })}>{entry.name}</Button>)}
            {!loading && !entries.length && <p className="typography-ui-label text-muted-foreground">{t('workspace.empty')}</p>}
          </div>
          <p className="typography-meta text-muted-foreground">{t('workspace.templateHint')}</p>
          <Button variant="outline" onClick={() => importedFile.current?.click()}>{t('workspace.import')}</Button>
        </>}
      </>}
      <input ref={importedFile} type="file" accept=".ocwork,.md,.txt,.csv,.tsv" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void operation(() => importFile(file)); }} />
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}><DialogContent className="max-w-md"><DialogTitle>{t('filesView.unsaved.title')}</DialogTitle><DialogDescription>{t('filesView.unsaved.description')}</DialogDescription><DialogFooter><Button variant="outline" onClick={() => setConfirmDiscard(false)}>{t('personalTools.cancel')}</Button><Button variant="destructive" onClick={onClose}>{t('filesView.unsaved.discard')}</Button></DialogFooter></DialogContent></Dialog>
    </DialogContent>
  </Dialog>;
}
