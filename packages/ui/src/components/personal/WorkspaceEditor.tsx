import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { calculateCell, columnName } from '@/lib/personal-workspace/formulas';
import { parseArtifact, serializeArtifact, type WorkspaceArtifact } from '@/lib/personal-workspace/model';
import { artifactStem, downloadArtifact, exportCsv, exportDocx, exportPptx, exportSvg, exportXlsx, sketchPng } from '@/lib/personal-workspace/exports';
import { exportPdf } from '@/lib/personal-workspace/pdf';
import type { FileCanvasHandle } from '@/components/views/files/fileCanvas';
import { SketchEditor } from './SketchEditor';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { saveWorkspaceCopy } from '@/lib/personal-workspace/storage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

const fieldClass = 'w-full min-w-0 rounded-md border border-border bg-transparent px-3 py-2 typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function WorkspaceEditor({ value, onChange, readOnly = false, onExport, sketchActions }: { value: WorkspaceArtifact; onChange: (value: WorkspaceArtifact) => void; readOnly?: boolean; onExport?: (blob: Blob, name: string) => Promise<void>; sketchActions?: React.ReactNode }) {
  const { t } = useI18n();
  const [preview, setPreview] = React.useState(false);
  const [title, setTitle] = React.useState(value.title);
  React.useEffect(() => setTitle(value.title), [value.title]);
  const [sheetIndex, setSheetIndex] = React.useState(0);
  const [slideIndex, setSlideIndex] = React.useState(0);
  const [activeCell, setActiveCell] = React.useState('');
  const [history, setHistory] = React.useState<WorkspaceArtifact[]>([]);
  const [future, setFuture] = React.useState<WorkspaceArtifact[]>([]);
  const [error, setError] = React.useState('');
  const [exporting, setExporting] = React.useState(false);
  const change = (next: WorkspaceArtifact) => { if (readOnly) return; setHistory((previous) => [...previous.slice(-49), value]); setFuture([]); onChange(next); };
  const runExport = async (format: 'office' | 'pdf' | 'source' | 'csv' | 'png') => {
    setExporting(true); setError('');
    try {
      const stem = artifactStem(value.title);
      const emit = onExport ?? (async (blob: Blob, name: string) => downloadArtifact(blob, name));
      if (format === 'source') await emit(new Blob([serializeArtifact(value)], { type: 'application/json' }), `${stem}.ocwork`);
      else if (format === 'pdf') await emit(await exportPdf(value), `${stem}.pdf`);
      else if (value.kind === 'document') await emit(new Blob([exportDocx(value)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), `${stem}.docx`);
      else if (value.kind === 'presentation') await emit(new Blob([exportPptx(value)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${stem}.pptx`);
      else if (value.kind === 'spreadsheet') {
        const sheet = value.sheets[Math.min(sheetIndex, value.sheets.length - 1)];
        if (format === 'csv') await emit(new Blob([exportCsv(sheet.rows)], { type: 'text/csv;charset=utf-8' }), `${stem}-${artifactStem(sheet.name)}.csv`);
        else await emit(new Blob([exportXlsx(value)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${stem}.xlsx`);
      } else if (format === 'png') await emit(await sketchPng(value), `${stem}.png`);
      else await emit(new Blob([exportSvg(value)], { type: 'image/svg+xml' }), `${stem}.svg`);
    } catch { setError(t('workspace.error')); }
    finally { setExporting(false); }
  };
  const sheet = value.kind === 'spreadsheet' ? value.sheets[Math.min(sheetIndex, value.sheets.length - 1)] : null;
  const slide = value.kind === 'presentation' ? value.slides[Math.min(slideIndex, value.slides.length - 1)] : null;
  const undo = () => { const previous = history.at(-1); if (previous) { setFuture((items) => [...items, value]); setHistory((items) => items.slice(0, -1)); onChange(previous); } };
  const redo = () => { const next = future.at(-1); if (next) { setHistory((items) => [...items, value]); setFuture((items) => items.slice(0, -1)); onChange(next); } };
  if (value.kind === 'sketch') return <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden" onKeyDown={(event) => {
    if (readOnly || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || event.target instanceof HTMLInputElement) return;
    event.preventDefault(); if (event.shiftKey) redo(); else undo();
  }}>
    <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-[var(--surface-elevated)] p-1 shadow-sm">
        {!readOnly && <><Button size="icon" variant="ghost" className="size-10 rounded-full" aria-label={t('workspace.undo')} title={t('workspace.undo')} disabled={!history.length} onClick={undo}><Icon name="arrow-go-back" className="size-5" /></Button><Button size="icon" variant="ghost" className="size-10 rounded-full" aria-label={t('workspace.redo')} title={t('workspace.redo')} disabled={!future.length} onClick={redo}><Icon name="arrow-go-forward" className="size-5" /></Button></>}
        <details className="relative"><summary className="flex size-10 cursor-pointer list-none items-center justify-center rounded-full hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('workspace.export')} title={t('workspace.export')}><Icon name="more" className="size-5" /></summary>
          <div className="absolute start-0 top-12 flex min-w-40 flex-col rounded-xl border bg-[var(--surface-elevated)] p-1 shadow-lg">
            {(['office', 'png', 'pdf', 'source'] as const).map((format) => <Button key={format} variant="ghost" size="sm" className="justify-start" disabled={exporting} onClick={() => void runExport(format)}>{format === 'office' ? `${t('workspace.export')} SVG` : format === 'source' ? '.ocwork' : format.toUpperCase()}</Button>)}
          </div>
        </details>
      </div>
      <div className="pointer-events-auto flex items-center gap-2">{sketchActions}</div>
    </div>
    {error && <p role="alert" className="absolute inset-x-4 top-20 z-10 rounded-xl bg-[var(--surface-elevated)] p-3 text-destructive">{error}</p>}
    <SketchEditor value={value} onChange={change} readOnly={readOnly} />
  </div>;
  return <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-1">
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={t('workspace.name')} className={`${fieldClass} flex-1 basis-48 font-medium`} value={title} readOnly={readOnly} maxLength={200} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() && title.trim() !== value.title) change({ ...value, title: title.trim() }); else setTitle(value.title); }} />
      {!readOnly && <>
        <Button size="sm" variant="ghost" disabled={!history.length} onClick={() => { const previous = history.at(-1); if (previous) { setFuture((items) => [...items, value]); setHistory((items) => items.slice(0, -1)); onChange(previous); } }}>{t('workspace.undo')}</Button>
        <Button size="sm" variant="ghost" disabled={!future.length} onClick={() => { const next = future.at(-1); if (next) { setHistory((items) => [...items, value]); setFuture((items) => items.slice(0, -1)); onChange(next); } }}>{t('workspace.redo')}</Button>
      </>}
      <Button size="sm" variant="outline" disabled={exporting} onClick={() => void runExport('office')}>{t('workspace.export')} {value.kind === 'document' ? 'DOCX' : value.kind === 'spreadsheet' ? 'XLSX' : value.kind === 'presentation' ? 'PPTX' : 'SVG'}</Button>
      <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void runExport('pdf')}>PDF</Button>
      {value.kind === 'spreadsheet' && <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void runExport('csv')}>CSV</Button>}
      <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void runExport('source')}>.ocwork</Button>
    </div>
    <p className="typography-meta text-muted-foreground">{t('workspace.exportHint')}</p>
    {error && <p role="alert" className="typography-ui-label text-destructive">{error}</p>}
    {value.kind === 'document' && <>
      <div className="flex gap-2"><Button size="sm" variant="chip" aria-pressed={!preview} onClick={() => setPreview(false)}>{t('workspace.source')}</Button><Button size="sm" variant="chip" aria-pressed={preview} onClick={() => setPreview(true)}>{t('workspace.preview')}</Button></div>
      {preview ? <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-6"><SimpleMarkdownRenderer content={value.markdown} enableFileReferences={false} /></div> : <textarea aria-label={t('workspace.document')} maxLength={500_000} className={`${fieldClass} min-h-[260px] flex-1 resize-none font-mono`} value={value.markdown} readOnly={readOnly} onChange={(event) => change({ ...value, markdown: event.target.value })} />}
    </>}
    {value.kind === 'spreadsheet' && sheet && <>
      <div className="flex flex-wrap items-center gap-1">
        {value.sheets.map((item, index) => <Button key={index} size="sm" variant="chip" aria-pressed={index === sheetIndex} onClick={() => setSheetIndex(index)}>{item.name}</Button>)}
        {!readOnly && <>
          <Button size="sm" variant="ghost" disabled={value.sheets.length >= 20} onClick={() => { let number = value.sheets.length + 1; while (value.sheets.some((item) => item.name.toLocaleLowerCase() === `sheet${number}`)) number++; change({ ...value, sheets: [...value.sheets, { name: `Sheet${number}`, rows: Array.from({ length: 20 }, () => Array.from({ length: 6 }, () => '')) }] }); setSheetIndex(value.sheets.length); }}>{t('workspace.addSheet')}</Button>
          <Button size="sm" variant="ghost" disabled={sheet.rows.length >= 500} onClick={() => change({ ...value, sheets: value.sheets.map((item) => item === sheet ? { ...item, rows: [...item.rows, Array.from({ length: Math.max(6, ...item.rows.map((row) => row.length)) }, () => '')] } : item) })}>{t('workspace.addRow')}</Button>
          <Button size="sm" variant="ghost" disabled={Math.max(0, ...sheet.rows.map((row) => row.length)) >= 50} onClick={() => change({ ...value, sheets: value.sheets.map((item) => item === sheet ? { ...item, rows: item.rows.map((row) => [...row, '']) } : item) })}>{t('workspace.addColumn')}</Button>
        </>}
      </div>
      <p className="typography-meta text-muted-foreground">{t('workspace.formulaHint')}</p>
      <div className="min-h-[240px] flex-1 overflow-auto rounded-lg border">
        <table className="border-separate border-spacing-0 font-mono typography-meta"><thead className="sticky top-0 z-10 bg-[var(--surface-elevated)]"><tr><th scope="col" className="min-w-10 border-b border-r" />{Array.from({ length: Math.max(1, ...sheet.rows.map((row) => row.length)) }, (_, column) => <th scope="col" key={column} className="min-w-28 border-b border-r px-2 py-1">{columnName(column)}</th>)}</tr></thead>
          <tbody>{sheet.rows.map((row, r) => <tr key={r}><th scope="row" className="sticky left-0 border-b border-r bg-[var(--surface-elevated)] px-2 font-normal">{r + 1}</th>{Array.from({ length: Math.max(1, ...sheet.rows.map((item) => item.length)) }, (_, c) => {
            const key = `${sheetIndex}:${r}:${c}`; const source = row[c] ?? '';
            return <td key={c} className="border-b border-r"><input aria-label={`${sheet.name} ${columnName(c)}${r + 1}`} maxLength={10_000} readOnly={readOnly} className="w-32 bg-transparent px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" value={activeCell === key ? source : calculateCell(sheet.rows, r, c)} title={source} onFocus={() => setActiveCell(key)} onBlur={() => setActiveCell('')} onChange={(event) => change({ ...value, sheets: value.sheets.map((item) => item === sheet ? { ...item, rows: item.rows.map((cells, index) => index === r ? Array.from({ length: Math.max(c + 1, cells.length) }, (_, column) => column === c ? event.target.value : cells[column] ?? '') : cells) } : item) })} /></td>;
          })}</tr>)}</tbody></table>
      </div>
    </>}
    {value.kind === 'presentation' && slide && <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-1">{value.slides.map((item, index) => <Button key={index} variant="chip" size="sm" aria-pressed={index === slideIndex} onClick={() => setSlideIndex(index)} title={item.title}>{index + 1}</Button>)}
        {!readOnly && <Button size="sm" variant="ghost" disabled={value.slides.length >= 100} onClick={() => { change({ ...value, slides: [...value.slides, { title: '', body: '', notes: '' }] }); setSlideIndex(value.slides.length); }}>{t('workspace.addSlide')}</Button>}
        <Button size="sm" variant="chip" aria-pressed={preview} onClick={() => setPreview(!preview)}>{t('workspace.preview')}</Button>
      </div>
      {preview ? <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-[var(--surface-background)] p-8"><h2 className="mb-6 text-3xl font-semibold leading-snug">{slide.title}</h2><div className="whitespace-pre-wrap text-lg leading-relaxed">{slide.body}</div></div> : <>
        <input aria-label={t('workspace.name')} maxLength={1000} className={`${fieldClass} text-xl font-medium`} readOnly={readOnly} value={slide.title} onChange={(event) => change({ ...value, slides: value.slides.map((item) => item === slide ? { ...item, title: event.target.value } : item) })} />
        <textarea aria-label={t('workspace.presentation')} maxLength={30_000} className={`${fieldClass} min-h-[160px] flex-1 resize-none`} readOnly={readOnly} value={slide.body} onChange={(event) => change({ ...value, slides: value.slides.map((item) => item === slide ? { ...item, body: event.target.value } : item) })} />
        <label className="typography-meta text-muted-foreground">{t('workspace.notes')}<textarea maxLength={30_000} className={`${fieldClass} mt-1 h-20 resize-none`} readOnly={readOnly} value={slide.notes} onChange={(event) => change({ ...value, slides: value.slides.map((item) => item === slide ? { ...item, notes: event.target.value } : item) })} /></label>
      </>}
    </div>}
  </div>;
}

/** Reuses FilesView's save, autosave, conflict, and fullscreen lifecycle. */
export const WorkspaceFileEditor = React.forwardRef<FileCanvasHandle, { content: string; directory: string; readOnly: boolean; onDirtyChange: (dirty: boolean) => void; onEdit: () => void }>(({ content, directory, readOnly, onDirtyChange, onEdit }, ref) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const initial = React.useMemo(() => { try { return { artifact: parseArtifact(content), error: false }; } catch { return { artifact: null, error: true }; } }, [content]);
  const [value, setValue] = React.useState(initial.artifact);
  const current = React.useRef(value); current.current = value;
  const baseline = React.useRef(content);
  React.useImperativeHandle(ref, () => ({
    getContent: () => {
      if (!current.current) return { ok: false, message: t('workspace.error') };
      const serialized = serializeArtifact(current.current);
      return { ok: true, snapshot: { content: serialized, signature: serialized } };
    },
    markSaved: (signature) => { baseline.current = signature; onDirtyChange(Boolean(current.current && serializeArtifact(current.current) !== signature)); },
  }), [onDirtyChange, t]);
  if (!value || initial.error) return <p role="alert" className="p-4 text-destructive">{t('workspace.invalidFile')}</p>;
  return <WorkspaceEditor value={value} readOnly={readOnly} onExport={async (blob, name) => {
    if (!directory || !files.uploadFile) { downloadArtifact(blob, name); return; }
    const runtime = getRuntimeKey();
    const path = await saveWorkspaceCopy(files, directory, name, blob, runtime);
    if (getRuntimeKey() === runtime) useUIStore.getState().openContextFile(directory, path);
  }} onChange={(next) => { setValue(next); current.current = next; onDirtyChange(serializeArtifact(next) !== baseline.current); onEdit(); }} />;
});
WorkspaceFileEditor.displayName = 'WorkspaceFileEditor';
