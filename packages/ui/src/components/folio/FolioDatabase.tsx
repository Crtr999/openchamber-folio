import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { columnKinds, columnKindSchema, viewKinds, type FolioNote, type FolioTable, type FolioView } from '@/lib/folio/schema';
import { folioColors } from '@/lib/folio/rich-text';
import { isImageName, useFolioAssetURL } from '@/lib/folio/assets';
import { FolioIcon } from './FolioIcon';
import { FolioIconPicker } from './FolioIconPicker';
import { FolioConfirm } from './FolioConfirm';
import { setPageIcon } from '@/lib/folio/rows';
import { chartPoints, defaultView, displayColumns, groupsFor, splitValues, viewRows, type FilterOp } from '@/lib/folio/database';

type Column = FolioTable['columns'][number];
type Row = FolioTable['rows'][number];

const palette = [folioColors.gray, folioColors.blue, folioColors.green, folioColors.orange, folioColors.purple, folioColors.pink, folioColors.yellow, folioColors.brown, folioColors.red];
const namedTone: Array<[RegExp, string]> = [[/not started|to ?do|backlog/i, folioColors.gray], [/progress|doing|reading|active/i, folioColors.blue], [/done|complete|finished|read$/i, folioColors.green], [/blocked|stuck|dropped/i, folioColors.red]];
function optionColor(column: Column | undefined, value: string): string {
  const named = column?.colors?.[value];
  if (named && named !== 'none') return folioColors[named] ?? folioColors.gray;
  if (named === 'none') return folioColors.gray;
  const tone = namedTone.find(([pattern]) => pattern.test(value))?.[1];
  if (tone) return tone;
  const index = Math.max(0, column?.options.indexOf(value) ?? 0);
  return palette[index % palette.length];
}
function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className="inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs" style={{ background: `color-mix(in srgb, ${color} 26%, transparent)`, color: 'var(--foreground)' }}>
    <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />{children}
  </span>;
}
const cellInput = 'w-full min-w-0 rounded bg-transparent px-1.5 py-1 text-sm outline-none hover:bg-interactive-hover focus:bg-interactive-hover';
const menuItem = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover';
const PAGE = 50;
const ops: FilterOp[] = ['is', 'isNot', 'contains', 'notContains', 'empty', 'notEmpty', 'checked', 'unchecked'];
const viewIcon = { table: 'table-2', board: 'layout-column', gallery: 'image', list: 'list-unordered', chart: 'bar-chart-2' } satisfies Record<FolioView['kind'], IconName>;

/** What a value looks like when not being edited. */
function CellValue({ column, value }: { column: Column; value: string }) {
  if (!value) return null;
  if (column.kind === 'select' || column.kind === 'status') return <Chip color={optionColor(column, value)}>{value}</Chip>;
  if (column.kind === 'multiSelect') return <span className="flex flex-wrap gap-1">{splitValues(value).map((v) => <Chip key={v} color={optionColor(column, v)}>{v}</Chip>)}</span>;
  if (column.kind === 'rating') return <span className="text-[var(--status-warning)]">{'★'.repeat(Number(value) || 0)}</span>;
  if (column.kind === 'checkbox') return <span aria-label={value}>{/^(true|yes|1|x)$/i.test(value) ? '☑' : '☐'}</span>;
  if (column.kind === 'url') {
    const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return <a href={href} target="_blank" rel="noreferrer" className="truncate text-[var(--primary)] underline underline-offset-2" onClick={(e) => e.stopPropagation()}>{value}</a>;
  }
  return <span className={cn('block truncate', column.kind === 'title' && 'font-medium')}>{value}</span>;
}

/** One cell: shows its value, and turns into an editor on click (a thousand-row table stays light). */
function Cell({ column, value, onChange, compact }: { column: Column; value: string; onChange: (value: string) => void; compact?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  if (column.kind === 'checkbox') {
    const on = /^(true|yes|1|x)$/i.test(value);
    return <button type="button" className="px-1.5 py-1 text-sm" aria-pressed={on} aria-label={column.name} onClick={() => onChange(on ? '' : 'true')}>{on ? '☑' : '☐'}</button>;
  }
  if (column.kind === 'rating') {
    const stars = Number(value) || 0;
    return <div className="flex px-1" role="radiogroup" aria-label={column.name}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={stars === n} className={cn('text-sm', n <= stars ? 'text-[var(--status-warning)]' : 'text-muted-foreground/40')} onClick={() => onChange(stars === n ? '' : String(n))}>★</button>)}</div>;
  }
  if (!editing) {
    return <button type="button" className={cn('block min-h-7 w-full min-w-0 rounded px-1.5 py-1 text-left text-sm hover:bg-interactive-hover', compact && 'min-h-6 py-0.5')} aria-label={column.name}
      onClick={() => { setDraft(value); setEditing(true); }}><CellValue column={column} value={value} /></button>;
  }
  if (column.kind === 'select' || column.kind === 'status') {
    return <select autoFocus aria-label={column.name} className={cn(cellInput, 'cursor-pointer')} value={value}
      onChange={(e) => { onChange(e.target.value); setEditing(false); }} onBlur={() => setEditing(false)}>
      <option value="">—</option>
      {[...new Set([...column.options.filter(Boolean), ...(value ? [value] : [])])].map((option) => <option key={option} value={option}>{option}</option>)}
    </select>;
  }
  const commit = () => { setEditing(false); if (draft !== value) onChange(draft); };
  return <input autoFocus aria-label={column.name} className={cn(cellInput, column.kind === 'title' && 'font-medium')}
    type={column.kind === 'date' ? 'date' : column.kind === 'number' ? 'number' : 'text'} value={draft}
    list={column.kind === 'multiSelect' ? `folio-options-${column.id}` : undefined}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }} />;
}

function Cover({ page, icon }: { page?: FolioNote; icon?: string }) {
  const image = page?.blocks.find((b) => b.kind === 'attachment' && b.asset && isImageName(b.text || b.asset));
  const url = useFolioAssetURL(image?.asset);
  const mark = icon || page?.icon;
  if (!url) return <div className="flex h-full items-center justify-center bg-secondary/40 text-4xl">{mark ? <FolioIcon value={mark} large /> : null}</div>;
  return <img src={url} alt="" className="h-full w-full object-cover" />;
}

/** A tiny line or bar chart, drawn as SVG. */
function Chart({ points, kind }: { points: Array<{ label: string; value: number }>; kind: 'line' | 'bar' }) {
  if (!points.length) return null;
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = 320, h = 160, pad = 18;
  const x = (i: number) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (points.length - 1));
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  if (kind === 'bar') {
    return <div className="space-y-2 py-3">{points.map((p) => <div key={p.label} className="grid grid-cols-[120px_1fr_36px] items-center gap-3">
      <span className="truncate text-sm">{p.label || '—'}</span>
      <div className="h-5 rounded bg-secondary"><div className="h-5 rounded bg-[var(--primary)]" style={{ width: `${(p.value / max) * 100}%` }} /></div>
      <span className="text-sm tabular-nums">{p.value}</span>
    </div>)}</div>;
  }
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-44 w-full" role="img">
    <path d={`${path} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`} fill="color-mix(in srgb, var(--primary) 16%, transparent)" />
    <path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" />
    {points.map((p, i) => <g key={p.label}><circle cx={x(i)} cy={y(p.value)} r="2.5" fill="var(--primary)" /><text x={x(i)} y={y(p.value) - 6} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">{p.value}</text></g>)}
    <text x={pad} y={h - 4} fontSize="8" fill="var(--muted-foreground)">{points[0].label}</text>
    <text x={w - pad} y={h - 4} fontSize="8" textAnchor="end" fill="var(--muted-foreground)">{points[points.length - 1].label}</text>
  </svg>;
}

export interface FolioDatabaseProps {
  table: FolioTable;
  onChange: (table: FolioTable) => void;
  /** A linked view shows only this view of the database. */
  viewID?: string;
  /** Row pages, for opening a row and for gallery covers. */
  pageOf?: (id: string) => FolioNote | undefined;
  /** Opens (creating when needed) a row's page. */
  onOpenRow?: (rowID: string) => void;
  mobile?: boolean;
}

export function FolioDatabase({ table, onChange, viewID, pageOf, onOpenRow, mobile }: FolioDatabaseProps) {
  const { t } = useI18n();
  const allViews = table.views?.length ? table.views : [defaultView(table)];
  const linked = viewID ? allViews.find((v) => v.id === viewID) : undefined;
  // Linked views belong to the pages that embed them, not to the database's own tabs.
  const own = allViews.filter((v) => !v.linked);
  const views = own.length ? own : [defaultView(table)];
  const [localView, setLocalView] = React.useState<string>();
  const view = linked ?? views.find((v) => v.id === (localView ?? table.activeView)) ?? views[0];
  const [editingColumn, setEditingColumn] = React.useState<string>();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [limit, setLimit] = React.useState(PAGE);
  const [dragRow, setDragRow] = React.useState<string>();
  const [dropGroup, setDropGroup] = React.useState<string>();
  React.useEffect(() => { setLimit(PAGE); }, [view.id, query]);

  const update = (change: Partial<FolioTable>) => onChange({ ...table, ...change });
  const setView = (next: FolioView) => update({ views: allViews.some((v) => v.id === next.id) ? allViews.map((v) => (v.id === next.id ? next : v)) : [...allViews, next] });
  const titleColumn = table.columns.find((c) => c.kind === 'title') ?? table.columns[0];
  const shown = displayColumns(table, view);
  const rows = React.useMemo(() => viewRows(table, view, query), [table, view, query]);
  const setValue = (rowID: string, columnID: string, value: string) => update({ rows: table.rows.map((row) => (row.id === rowID ? { ...row, values: { ...row.values, [columnID]: value } } : row)) });
  const addRow = (values: Record<string, string> = {}) => update({ rows: [...table.rows, { id: crypto.randomUUID(), values }] });
  const removeRow = (rowID: string) => update({ rows: table.rows.filter((r) => r.id !== rowID) });
  const [iconRow, setIconRow] = React.useState<string>();
  const [removingRow, setRemovingRow] = React.useState<string>();
  // A row that another surface or a sync removed while its confirmation stood open has nothing left to confirm.
  const removing = table.rows.find((r) => r.id === removingRow);
  const setIcon = (row: Row, icon: string | undefined) => {
    update({ rows: table.rows.map((r) => { if (r.id !== row.id) return r; const next = { ...r }; if (icon) next.icon = icon; else delete next.icon; return next; }) });
    setPageIcon(row.page, icon ?? '');
    setIconRow(undefined);
  };
  /** The row's icon, and (for the title cell) a button to pick one, like a Notion page icon. */
  const rowIcon = (row: Row, pickable: boolean) => <span className="relative shrink-0">
    {pickable
      ? <button type="button" aria-label={t('folio.icon')} title={t('folio.icon')} className={cn('flex size-6 items-center justify-center rounded hover:bg-interactive-hover', !row.icon && 'opacity-0 group-hover/row:opacity-60')} onClick={() => setIconRow(iconRow === row.id ? undefined : row.id)}>
        {row.icon ? <FolioIcon value={row.icon} /> : <Icon name="emotion-happy" className="size-3.5 text-muted-foreground" />}
      </button>
      : row.icon ? <FolioIcon value={row.icon} /> : null}
    {pickable && iconRow === row.id && <div className="absolute -top-14 left-0 z-40"><FolioIconPicker onClose={() => setIconRow(undefined)} onPick={(icon) => setIcon(row, icon)} onRemove={() => setIcon(row, undefined)} /></div>}
  </span>;
  const column = table.columns.find((c) => c.id === editingColumn);
  const viewName = (v: FolioView) => v.name.trim() || t(`folio.${v.kind}`);
  const more = rows.length > limit && <button type="button" className="mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-interactive-hover" onClick={() => setLimit(limit + 200)}>{t('folio.db.showMore', { count: rows.length - limit })}</button>;
  const open = (row: Row) => onOpenRow?.(row.id);
  /** The row's Open button. A pointer reveals it over the title on hover, as before; touch has no hover, so the phone shows it in the row, where a long title truncates instead of hiding underneath it. */
  const rowOpen = (row: Row) => <button type="button" onClick={() => open(row)}
    className={cn('rounded border border-border bg-background text-[11px] text-muted-foreground hover:text-foreground',
      mobile ? 'min-h-8 shrink-0 px-2 py-1' : 'absolute right-1 top-1 hidden px-1.5 shadow-sm group-hover/row:block')}>{t('folio.db.open')}</button>;
  /** The row's delete button. A pointer reveals it on hover, as before; touch has no hover, so the phone keeps it in the row, where it asks first, because a row that cannot be brought back must not go on a mis-tap. */
  const rowRemove = (row: Row) => <button type="button" aria-label={t('folio.remove')}
    className={cn('rounded px-2 text-muted-foreground hover:bg-interactive-hover', mobile ? 'min-h-8 shrink-0 py-1' : 'invisible group-hover/row:visible')}
    onClick={() => { if (mobile) setRemovingRow(row.id); else removeRow(row.id); }}>×</button>;
  const props = (row: Row) => shown.filter((c) => c.id !== titleColumn?.id && row.values[c.id]).map((c) => <span key={c.id} className="max-w-full text-xs text-muted-foreground"><CellValue column={c} value={row.values[c.id]} /></span>);

  return <section className="my-2 min-w-0 text-sm">
    {/* Views, like Notion's tabs above a database. */}
    <div className="flex items-center gap-1 border-b border-border pb-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {(linked ? [linked] : views).map((v) => <button key={v.id} type="button" aria-pressed={v.id === view.id} onClick={() => { setLocalView(v.id); if (!linked && table.activeView !== v.id) update({ activeView: v.id }); }}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-interactive-hover', v.id === view.id && 'font-medium text-foreground')}>
          <Icon name={viewIcon[v.kind]} className="size-3.5" />{viewName(v)}
        </button>)}
        {!linked && <button type="button" className="shrink-0 rounded-md px-2 py-1 text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.db.newView')} title={t('folio.db.newView')}
          onClick={() => { const next: FolioView = { id: crypto.randomUUID(), name: '', kind: 'table' }; update({ views: [...allViews, next], activeView: next.id }); setLocalView(next.id); setSettingsOpen(true); }}>+</button>}
      </div>
      {!mobile && <input aria-label={t('folio.db.search')} placeholder={t('folio.db.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="w-36 rounded-md bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 hover:bg-interactive-hover focus:bg-interactive-hover" />}
      <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">{t('folio.db.rows', { count: rows.length })}</span>
      <div className="relative shrink-0">
        <button type="button" className="rounded-md px-2 py-1 text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.db.viewSettings')} title={t('folio.db.viewSettings')} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="equalizer-2" className="size-3.5" /></button>
        {settingsOpen && <>
          <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
          <ViewSettings table={table} view={view} onView={setView} onDelete={views.length > 1 && !linked ? () => { const rest = allViews.filter((v) => v.id !== view.id); update({ views: rest, activeView: rest.find((v) => !v.linked)?.id }); setLocalView(undefined); setSettingsOpen(false); } : undefined} />
        </>}
      </div>
      <button type="button" className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground" onClick={() => addRow()}>{t('folio.newCard')}</button>
    </div>
    {mobile && <input aria-label={t('folio.db.search')} placeholder={t('folio.db.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded-md bg-secondary/50 px-2 py-1.5 text-sm outline-none" />}

    {(view.filter?.length || view.sort?.length) ? <div className="flex flex-wrap gap-1 pt-1.5">
      {view.sort?.map((s) => { const c = table.columns.find((x) => x.id === s.column); return c ? <span key={`s-${s.column}`} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{s.desc ? '↓' : '↑'} {c.name}</span> : null; })}
      {view.filter?.map((f, i) => { const c = table.columns.find((x) => x.id === f.column); return c ? <span key={`f-${i}`} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{c.name} {t(`folio.db.op.${f.op}`)} {f.values?.join(', ') ?? f.value ?? ''}</span> : null; })}
    </div> : null}

    {column && <div className="my-2 flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
      <input className={cn(cellInput, 'w-40 border border-border')} aria-label={t('folio.name')} value={column.name} onChange={(e) => update({ columns: table.columns.map((c) => (c.id === column.id ? { ...c, name: e.target.value } : c)) })} />
      <select className={cn(cellInput, 'w-36 border border-border')} aria-label={t('folio.kind')} value={column.kind} onChange={(e) => { const parsed = columnKindSchema.safeParse(e.target.value); if (parsed.success) update({ columns: table.columns.map((c) => (c.id === column.id ? { ...c, kind: parsed.data } : c)) }); }}>
        {columnKinds.map((kind) => <option key={kind} value={kind}>{t(`folio.property.${kind}`)}</option>)}
      </select>
      {(column.kind === 'select' || column.kind === 'status' || column.kind === 'multiSelect') && <input className={cn(cellInput, 'min-w-60 flex-1 border border-border')} aria-label={t('folio.options')} placeholder={t('folio.options')} value={column.options.join(', ')} onChange={(e) => update({ columns: table.columns.map((c) => (c.id === column.id ? { ...c, options: e.target.value.split(',').map((s) => s.trim()) } : c)) })} />}
      <button type="button" className="rounded px-2 py-1 text-xs text-destructive hover:bg-interactive-hover" onClick={() => { update({ columns: table.columns.filter((c) => c.id !== column.id) }); setEditingColumn(undefined); }}>{t('folio.remove')}</button>
      <button type="button" className="rounded px-2 py-1 text-xs hover:bg-interactive-hover" onClick={() => setEditingColumn(undefined)}>{t('folio.done')}</button>
    </div>}
    {table.columns.filter((c) => c.kind === 'multiSelect').map((c) => <datalist key={c.id} id={`folio-options-${c.id}`}>{c.options.map((o) => <option key={o} value={o} />)}</datalist>)}

    {view.kind === 'table' && <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
          {shown.map((c) => <th key={c.id} className={cn('border-r border-border/60 px-1 py-1 font-normal last:border-r-0', c.kind === 'title' ? 'min-w-48' : 'min-w-32')}>
            <button type="button" className="w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-interactive-hover" onClick={() => setEditingColumn(c.id)}>{c.name}</button>
          </th>)}
          <th className="w-8"><button type="button" aria-label={t('folio.column')} title={t('folio.column')} className="rounded px-2 py-0.5 hover:bg-interactive-hover" onClick={() => { const id = crypto.randomUUID(); update({ columns: [...table.columns, { id, name: t('folio.name'), kind: 'text', options: [] }] }); setEditingColumn(id); }}>+</button></th>
        </tr></thead>
        <tbody>{rows.slice(0, limit).map((row) => <tr key={row.id} className="group/row border-b border-border/60 align-top">
          {shown.map((c) => <td key={c.id} className="relative max-w-80 border-r border-border/60 p-0.5 last:border-r-0">
            {c.id === titleColumn?.id
              ? <div className="flex items-center gap-0.5">{rowIcon(row, true)}<div className="min-w-0 flex-1"><Cell column={c} value={row.values[c.id] || ''} onChange={(value) => setValue(row.id, c.id, value)} /></div>{onOpenRow && rowOpen(row)}</div>
              : <Cell column={c} value={row.values[c.id] || ''} onChange={(value) => setValue(row.id, c.id, value)} />}
          </td>)}
          <td>{rowRemove(row)}</td>
        </tr>)}</tbody>
      </table>
      {more}
      {!rows.length && <div className="px-2 py-3 text-sm text-muted-foreground">{t('folio.db.noRows')}</div>}
      <button type="button" className="mt-1 w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-interactive-hover" onClick={() => addRow()}>+ {t('folio.newCard')}</button>
    </div>}

    {view.kind === 'list' && <div className="py-1">
      {rows.slice(0, limit).map((row) => <button key={row.id} type="button" className="flex w-full items-center gap-3 rounded-md border-b border-border/50 px-2 py-1.5 text-left hover:bg-interactive-hover" onClick={() => open(row)}>
        {row.icon ? <FolioIcon value={row.icon} /> : <Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate font-medium">{(titleColumn && row.values[titleColumn.id]) || t('folio.untitled')}</span>
        <span className="flex min-w-0 shrink items-center gap-2 overflow-hidden">{props(row)}</span>
      </button>)}
      {more}
    </div>}

    {view.kind === 'gallery' && <div className={cn('grid gap-3 py-2', view.cardSize === 'large' ? 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]' : view.cardSize === 'medium' ? 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]')}>
      {rows.slice(0, limit).map((row) => <button key={row.id} type="button" className="overflow-hidden rounded-lg border border-border text-left shadow-sm transition-colors hover:border-foreground/30" onClick={() => open(row)}>
        {view.cover !== 'none' && <div className={cn('overflow-hidden', view.cardSize === 'small' ? 'h-20' : 'h-32')}><Cover page={row.page ? pageOf?.(row.page) : undefined} icon={row.icon} /></div>}
        <div className="space-y-1 p-2">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium">{row.icon && <FolioIcon value={row.icon} />}{(titleColumn && row.values[titleColumn.id]) || t('folio.untitled')}</div>
          <div className="flex flex-col gap-0.5">{props(row)}</div>
        </div>
      </button>)}
      {more && <div className="col-span-full">{more}</div>}
    </div>}

    {view.kind === 'board' && (() => {
      const groupColumn = table.columns.find((c) => c.id === view.groupBy) ?? table.columns.find((c) => c.kind === 'status') ?? table.columns.find((c) => c.kind === 'select');
      const groups = groupsFor(groupColumn, rows);
      return <div className="flex gap-3 overflow-x-auto pb-2 pt-2">
        {groups.map((group) => {
          const inGroup = rows.filter((row) => (groupColumn ? (groupColumn.kind === 'multiSelect' ? splitValues(row.values[groupColumn.id] || '').includes(group) || (!group && !row.values[groupColumn.id]) : (row.values[groupColumn.id] || '') === group) : true));
          const color = group ? optionColor(groupColumn, group) : folioColors.gray;
          return <div key={group || 'none'} className={cn('flex w-64 shrink-0 flex-col gap-1.5 rounded-lg p-1.5 transition-colors', dropGroup === group && 'bg-interactive-hover')}
            style={{ background: dropGroup === group ? undefined : `color-mix(in srgb, ${color} 7%, transparent)` }}
            onDragOver={(e) => { if (dragRow && groupColumn) { e.preventDefault(); setDropGroup(group); } }}
            onDragLeave={() => setDropGroup((g) => (g === group ? undefined : g))}
            onDrop={(e) => { e.preventDefault(); if (dragRow && groupColumn) setValue(dragRow, groupColumn.id, group); setDragRow(undefined); setDropGroup(undefined); }}>
            <div className="flex items-center gap-2 px-1 py-0.5"><Chip color={color}>{group || '—'}</Chip><span className="text-xs text-muted-foreground">{inGroup.length}</span></div>
            {inGroup.slice(0, limit).map((row) => <div key={row.id} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragRow(row.id); }} onDragEnd={() => { setDragRow(undefined); setDropGroup(undefined); }}
              className={cn('cursor-grab rounded-md border border-border/70 bg-background p-2 shadow-sm hover:border-border', dragRow === row.id && 'opacity-50')}>
              <button type="button" className="block w-full text-left" onClick={() => open(row)}>
                <div className="flex items-center gap-1.5 truncate font-medium">{row.icon && <FolioIcon value={row.icon} />}{(titleColumn && row.values[titleColumn.id]) || t('folio.untitled')}</div>
                <div className="mt-1 flex flex-wrap gap-1">{props(row).filter((p) => p.key !== groupColumn?.id)}</div>
              </button>
            </div>)}
            <button type="button" className="rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-interactive-hover" onClick={() => addRow(groupColumn ? { [groupColumn.id]: group } : {})}>+ {t('folio.newCard')}</button>
          </div>;
        })}
      </div>;
    })()}

    {view.kind === 'chart' && <div role="img" aria-label={t('folio.chart')}>
      <Chart points={chartPoints(table, view, rows)} kind={view.chart?.kind ?? (table.columns.find((c) => c.id === view.chart?.x)?.kind === 'date' ? 'line' : 'bar')} />
    </div>}

    {mobile && removing && <FolioConfirm label={t('folio.remove')} body={t('folio.db.deleteRowWarning')} confirmLabel={t('folio.remove')}
      onConfirm={() => { removeRow(removing.id); setRemovingRow(undefined); }} onCancel={() => setRemovingRow(undefined)} />}
  </section>;
}

function ViewSettings({ table, view, onView, onDelete }: { table: FolioTable; view: FolioView; onView: (view: FolioView) => void; onDelete?: () => void }) {
  const { t } = useI18n();
  const visible = displayColumns(table, view).map((c) => c.id);
  const set = (change: Partial<FolioView>) => onView({ ...view, ...change });
  const select = 'rounded-md border border-border bg-transparent px-1.5 py-1 text-xs';
  const groupable = table.columns.filter((c) => c.kind === 'select' || c.kind === 'status' || c.kind === 'multiSelect');
  return <div className="absolute right-0 top-8 z-40 max-h-[70vh] w-72 space-y-3 overflow-y-auto rounded-xl border border-border bg-background p-3 shadow-2xl">
    <input className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm" aria-label={t('folio.name')} placeholder={t(`folio.${view.kind}`)} value={view.name} onChange={(e) => set({ name: e.target.value })} />
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t('folio.db.layout')}</div>
      <div className="grid grid-cols-5 gap-1">{viewKinds.map((kind) => <button key={kind} type="button" aria-pressed={view.kind === kind} title={t(`folio.${kind}`)} className={cn('flex flex-col items-center gap-0.5 rounded-md border border-border py-1.5 text-[10px]', view.kind === kind && 'border-[var(--primary)] text-[var(--primary)]')} onClick={() => set({ kind })}><Icon name={viewIcon[kind]} className="size-4" />{t(`folio.${kind}`)}</button>)}</div>
    </div>
    {view.kind === 'board' && <label className="flex items-center justify-between gap-2 text-xs">{t('folio.group')}
      <select className={select} value={view.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || undefined })}><option value="">—</option>{groupable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
    </label>}
    {view.kind === 'gallery' && <label className="flex items-center justify-between gap-2 text-xs">{t('folio.db.cardSize')}
      <select className={select} value={view.cardSize ?? 'medium'} onChange={(e) => set({ cardSize: e.target.value === 'small' || e.target.value === 'large' ? e.target.value : 'medium' })}>{(['small', 'medium', 'large'] as const).map((s) => <option key={s} value={s}>{t(`folio.db.size.${s}`)}</option>)}</select>
    </label>}
    {view.kind === 'chart' && <div className="space-y-1.5">
      <label className="flex items-center justify-between gap-2 text-xs">{t('folio.db.chartBy')}
        <select className={select} value={view.chart?.x ?? ''} onChange={(e) => set({ chart: { ...view.chart, x: e.target.value || undefined } })}><option value="">—</option>{table.columns.filter((c) => c.kind !== 'title').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">{t('folio.db.chartKind')}
        <select className={select} value={view.chart?.kind ?? ''} onChange={(e) => set({ chart: { ...view.chart, kind: e.target.value === 'line' || e.target.value === 'bar' ? e.target.value : undefined } })}><option value="">{t('folio.db.auto')}</option><option value="line">{t('folio.db.line')}</option><option value="bar">{t('folio.db.bar')}</option></select>
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">{t('folio.db.bucket')}
        <select className={select} value={view.chart?.bucket ?? 'month'} onChange={(e) => set({ chart: { ...view.chart, bucket: e.target.value === 'day' || e.target.value === 'year' ? e.target.value : 'month' } })}>{(['day', 'month', 'year'] as const).map((b) => <option key={b} value={b}>{t(`folio.db.bucket.${b}`)}</option>)}</select>
      </label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(view.chart?.cumulative)} onChange={(e) => set({ chart: { ...view.chart, cumulative: e.target.checked } })} />{t('folio.db.cumulative')}</label>
    </div>}
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t('folio.db.properties')}</div>
      {table.columns.map((c) => <label key={c.id} className={cn(menuItem, 'py-1')}><input type="checkbox" checked={visible.includes(c.id)} disabled={c.kind === 'title'}
        onChange={(e) => set({ columns: e.target.checked ? table.columns.filter((x) => visible.includes(x.id) || x.id === c.id).map((x) => x.id) : visible.filter((id) => id !== c.id) })} />{c.name}</label>)}
    </div>
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t('folio.db.sort')}</div>
      {(view.sort ?? []).map((s, i) => <div key={i} className="mb-1 flex gap-1">
        <select className={cn(select, 'min-w-0 flex-1')} value={s.column} onChange={(e) => set({ sort: (view.sort ?? []).map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>{table.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className={select} value={s.desc ? 'desc' : 'asc'} onChange={(e) => set({ sort: (view.sort ?? []).map((x, j) => (j === i ? { ...x, desc: e.target.value === 'desc' } : x)) })}><option value="asc">{t('folio.db.ascending')}</option><option value="desc">{t('folio.db.descending')}</option></select>
        <button type="button" className="px-1 text-muted-foreground" aria-label={t('folio.remove')} onClick={() => set({ sort: (view.sort ?? []).filter((_, j) => j !== i) })}>×</button>
      </div>)}
      <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => set({ sort: [...(view.sort ?? []), { column: table.columns[0]?.id ?? '' }] })}>+ {t('folio.db.addSort')}</button>
    </div>
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t('folio.db.filter')}</div>
      {(view.filter ?? []).map((f, i) => {
        const change = (next: Partial<NonNullable<FolioView['filter']>[number]>) => set({ filter: (view.filter ?? []).map((x, j) => (j === i ? { ...x, ...next } : x)) });
        return <div key={i} className="mb-1 flex flex-wrap gap-1">
          <select className={cn(select, 'min-w-0 flex-1')} value={f.column} onChange={(e) => change({ column: e.target.value })}>{table.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select className={select} value={f.op} onChange={(e) => { const op = ops.find((o) => o === e.target.value); if (op) change({ op }); }}>{ops.map((o) => <option key={o} value={o}>{t(`folio.db.op.${o}`)}</option>)}</select>
          {!['empty', 'notEmpty', 'checked', 'unchecked'].includes(f.op) && <input className={cn(select, 'w-full')} aria-label={t('folio.db.filter')} value={f.values?.join(', ') ?? f.value ?? ''} onChange={(e) => change({ value: e.target.value, values: undefined })} />}
          <button type="button" className="px-1 text-muted-foreground" aria-label={t('folio.remove')} onClick={() => set({ filter: (view.filter ?? []).filter((_, j) => j !== i) })}>×</button>
        </div>;
      })}
      <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => set({ filter: [...(view.filter ?? []), { column: table.columns[0]?.id ?? '', op: 'contains', value: '' }] })}>+ {t('folio.db.addFilter')}</button>
    </div>
    {onDelete && <button type="button" className="w-full rounded-md px-2 py-1 text-left text-xs text-destructive hover:bg-interactive-hover" onClick={onDelete}>{t('folio.db.deleteView')}</button>}
  </div>;
}
