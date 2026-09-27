import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import { noteByID, openDatabaseRow, useNote } from '@/lib/folio/rows';
import { isImageName, useFolioAssetURL } from '@/lib/folio/assets';
import type { FolioBlock, FolioNote, FolioTable } from '@/lib/folio/schema';
import { FolioDatabase } from './FolioDatabase';
import { FolioIcon } from './FolioIcon';

/**
 * Blocks that are not typed text: a database shown inside a page, a simple table, an image, and a
 * button. Each edits the page (or the database page it shows) through the notebook store.
 */

/** A database as it appears inside a page (Notion's inline database or linked view). */
export function FolioDatabaseBlock({ block, mobile }: { block: FolioBlock; mobile?: boolean }) {
  const { t } = useI18n();
  const target = useNote(block.asset);
  const notes = useFolioStore((s) => s.status?.notes);
  const pages = React.useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  if (!target?.table) return <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">{t('folio.db.missing')}</div>;
  const change = (table: FolioTable) => { const current = noteByID(target.id); if (current) useFolioStore.getState().edit({ ...current, table }); };
  return <div className="min-w-0 flex-1">
    <button type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 text-base font-semibold hover:bg-interactive-hover" onClick={() => void useFolioStore.getState().run({ command: 'select', noteID: target.id })}>
      <FolioIcon value={target.icon} />{target.title || t('folio.untitled')}
    </button>
    <FolioDatabase table={target.table} onChange={change} viewID={block.text || undefined} mobile={mobile}
      pageOf={(id) => pages.get(id)} onOpenRow={(rowID) => void openDatabaseRow(target.id, rowID)} />
  </div>;
}

export function FolioRowProperties({ database, row }: { database: FolioNote; row: FolioTable['rows'][number] }) {
  const table = database.table;
  if (!table) return null;
  const set = (columnID: string, value: string) => {
    const current = noteByID(database.id);
    if (!current?.table) return;
    useFolioStore.getState().edit({ ...current, table: { ...current.table, rows: current.table.rows.map((r) => (r.id === row.id ? { ...r, values: { ...r.values, [columnID]: value } } : r)) } });
  };
  const shown = table.columns.filter((c) => c.kind !== 'title');
  if (!shown.length) return null;
  return <div className="mb-6 space-y-0.5 border-b border-border pb-3 text-sm">
    {shown.map((c) => <div key={c.id} className="flex items-start gap-3">
      <span className="w-40 shrink-0 truncate py-1 text-muted-foreground">{c.name}</span>
      <PropertyInput kind={c.kind} options={c.options} value={row.values[c.id] || ''} label={c.name} onChange={(value) => set(c.id, value)} />
    </div>)}
  </div>;
}

function PropertyInput({ kind, options, value, label, onChange }: { kind: FolioTable['columns'][number]['kind']; options: string[]; value: string; label: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const input = 'min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 outline-none hover:bg-interactive-hover focus:bg-interactive-hover';
  if (kind === 'select' || kind === 'status') return <select aria-label={label} className={input} value={value} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{[...new Set([...options.filter(Boolean), ...(value ? [value] : [])])].map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  if (kind === 'checkbox') return <input type="checkbox" aria-label={label} className="mt-2" checked={/^(true|yes|1|x)$/i.test(value)} onChange={(e) => onChange(e.target.checked ? 'true' : '')} />;
  return <textarea rows={1} aria-label={label} className={cn(input, 'resize-none')} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== value) onChange(draft); }} />;
}

const linkPattern = /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;
/** Plain text with its links clickable (simple tables keep Markdown links as typed). */
function Linked({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const href = match[3] ?? match[0];
    parts.push(<a key={at} href={href} target="_blank" rel="noreferrer" className="text-[var(--primary)] underline underline-offset-2" onClick={(e) => e.stopPropagation()}>{match[2] ?? match[0]}</a>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A simple table (Notion's /table): cells stored as tab-separated lines; `checked` marks a header row. */
export function FolioSimpleTable({ block, onChange }: { block: FolioBlock; onChange: (block: FolioBlock) => void }) {
  const { t } = useI18n();
  const rows = block.text.split('\n').map((line) => line.split('\t'));
  const width = Math.max(1, ...rows.map((r) => r.length));
  const grid = rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => '')]);
  const [editing, setEditing] = React.useState<{ r: number; c: number; value: string }>();
  const save = (next: string[][]) => onChange({ ...block, text: next.map((r) => r.map((cell) => cell.replace(/[\t\n]/g, ' ')).join('\t')).join('\n') });
  const commit = () => {
    if (!editing) return;
    const next = grid.map((r) => [...r]);
    next[editing.r][editing.c] = editing.value;
    setEditing(undefined);
    if (editing.value !== grid[editing.r][editing.c]) save(next);
  };
  return <div className="group/table min-w-0 flex-1 overflow-x-auto py-1">
    <table className="w-full border-collapse text-sm">
      <tbody>{grid.map((row, r) => <tr key={r} className={cn(r === 0 && block.checked && 'bg-secondary/40 font-medium')}>
        {row.map((cell, c) => <td key={c} className="min-w-24 border border-border p-0 align-top">
          {editing?.r === r && editing.c === c
            ? <textarea autoFocus rows={1} className="block w-full resize-none bg-transparent px-2 py-1 outline-none" value={editing.value} aria-label={t('folio.block.table')}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } if (e.key === 'Escape') setEditing(undefined); }} />
            : <button type="button" className="block min-h-7 w-full whitespace-pre-wrap break-words px-2 py-1 text-left" onClick={() => setEditing({ r, c, value: cell })}><Linked text={cell} /></button>}
        </td>)}
      </tr>)}</tbody>
    </table>
    <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover/table:opacity-100">
      <button type="button" className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-interactive-hover" onClick={() => save([...grid, Array.from({ length: width }, () => '')])}>+ {t('folio.db.addRow')}</button>
      <button type="button" className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-interactive-hover" onClick={() => save(grid.map((r) => [...r, '']))}>+ {t('folio.column')}</button>
      <button type="button" className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-interactive-hover" aria-pressed={block.checked} onClick={() => onChange({ ...block, checked: !block.checked })}>{t('folio.db.headerRow')}</button>
    </div>
  </div>;
}

/** An attachment: images show inline (like Notion), other files as a chip that opens them. */
export function FolioAttachment({ block, onOpen }: { block: FolioBlock; onOpen: () => void }) {
  const { t } = useI18n();
  const image = isImageName(block.text || block.asset || '');
  const url = useFolioAssetURL(image ? block.asset : undefined);
  if (image && url) return <button type="button" className="my-1 block max-w-full overflow-hidden rounded-md" onClick={onOpen} title={block.text}><img src={url} alt={block.text} className="max-h-[480px] max-w-full rounded-md object-contain" /></button>;
  return <button type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-interactive-hover" onClick={onOpen}><Icon name={image ? 'image' : 'attachment-2'} className="size-4" />{block.text || t('folio.attach')}</button>;
}

/** A button block: a label, and the page it opens when one is linked. */
export function FolioButton({ block }: { block: FolioBlock }) {
  const target = useNote(block.asset);
  return <button type="button" className="my-1 inline-flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-interactive-hover disabled:cursor-default"
    disabled={!target} onClick={() => { if (target) void useFolioStore.getState().run({ command: 'select', noteID: target.id }); }}>
    <Icon name="add" className="size-4" />{block.text || target?.title}
  </button>;
}
