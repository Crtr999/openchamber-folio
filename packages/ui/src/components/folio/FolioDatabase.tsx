import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { columnKinds, columnKindSchema, type FolioTable } from '@/lib/folio/schema';
import { folioColors } from '@/lib/folio/rich-text';

type Column = FolioTable['columns'][number];
type Row = FolioTable['rows'][number];

const palette = [folioColors.gray, folioColors.blue, folioColors.green, folioColors.orange, folioColors.purple, folioColors.pink, folioColors.yellow, folioColors.brown, folioColors.red];
const namedTone: Array<[RegExp, string]> = [[/not started|to ?do|backlog/i, folioColors.gray], [/progress|doing|reading|active/i, folioColors.blue], [/done|complete|finished|read$/i, folioColors.green], [/blocked|stuck/i, folioColors.red]];
function optionColor(column: Column | undefined, value: string): string {
  const named = namedTone.find(([pattern]) => pattern.test(value))?.[1];
  if (named) return named;
  const index = Math.max(0, column?.options.indexOf(value) ?? 0);
  return palette[index % palette.length];
}
function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className="inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs" style={{ background: `color-mix(in srgb, ${color} 26%, transparent)`, color: 'var(--foreground)' }}>
    <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />{children}
  </span>;
}
const cellInput = 'w-full min-w-0 rounded bg-transparent px-1.5 py-1 text-sm outline-none hover:bg-interactive-hover focus:bg-interactive-hover';

export function FolioDatabase({ table, onChange }: { table: FolioTable; onChange: (table: FolioTable) => void }) {
  const { t } = useI18n();
  const [editingColumn, setEditingColumn] = React.useState<string>();
  const [openRow, setOpenRow] = React.useState<string>();
  const [dragRow, setDragRow] = React.useState<string>();
  const [dropGroup, setDropGroup] = React.useState<string>();
  const update = (change: Partial<FolioTable>) => onChange({ ...table, ...change });
  const titleColumn = table.columns.find((c) => c.kind === 'title') ?? table.columns[0];
  const groupColumn = table.columns.find((c) => c.id === (table.view === 'chart' ? table.chartBy : table.groupBy))
    ?? table.columns.find((c) => c.kind === 'status') ?? table.columns.find((c) => c.kind === 'select');
  const groups = groupColumn ? [...new Set([...groupColumn.options.filter(Boolean), ...table.rows.map((row) => row.values[groupColumn.id] || '')])] : [''];
  const setValue = (rowID: string, columnID: string, value: string) => update({ rows: table.rows.map((row) => row.id === rowID ? { ...row, values: { ...row.values, [columnID]: value } } : row) });
  const addRow = (values: Record<string, string> = {}) => { const row = { id: crypto.randomUUID(), values }; update({ rows: [...table.rows, row] }); setOpenRow(row.id); };
  const column = table.columns.find((c) => c.id === editingColumn);

  const cell = (row: Row, col: Column, compact = false) => {
    const value = row.values[col.id] || '';
    if (col.kind === 'select' || col.kind === 'status') {
      return <select aria-label={col.name} className={cn(cellInput, 'cursor-pointer appearance-none')} value={value} onChange={(e) => setValue(row.id, col.id, e.target.value)}>
        <option value="">—</option>
        {[...new Set([...col.options.filter(Boolean), ...(value ? [value] : [])])].map((option) => <option key={option} value={option}>{option}</option>)}
      </select>;
    }
    if (col.kind === 'rating') {
      const stars = Number(value) || 0;
      return <div className="flex px-1" role="radiogroup" aria-label={col.name}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={stars === n} className={cn('text-sm', n <= stars ? 'text-[var(--status-warning)]' : 'text-muted-foreground/40')} onClick={() => setValue(row.id, col.id, stars === n ? '' : String(n))}>★</button>)}</div>;
    }
    return <input aria-label={col.name} className={cn(cellInput, col.kind === 'title' && 'font-medium', compact && 'py-0.5')} type={col.kind === 'date' ? 'date' : col.kind === 'number' ? 'number' : 'text'} value={value} placeholder={col.kind === 'title' ? t('folio.untitled') : ''} onChange={(e) => setValue(row.id, col.id, e.target.value)} />;
  };

  const summary = (row: Row) => table.columns.filter((c) => c.id !== titleColumn?.id && c.id !== groupColumn?.id && row.values[c.id]).map((c) => {
    const value = row.values[c.id];
    if (c.kind === 'select' || c.kind === 'status') return <Chip key={c.id} color={optionColor(c, value)}>{value}</Chip>;
    if (c.kind === 'rating') return <span key={c.id} className="text-xs text-[var(--status-warning)]">{'★'.repeat(Number(value) || 0)}</span>;
    return <span key={c.id} className="truncate text-xs text-muted-foreground">{value}</span>;
  });

  return <section className="my-4 text-sm">
    <div className="flex items-center gap-1 border-b border-border pb-1">
      {([['table', 'table-2'], ['board', 'layout-column'], ['chart', 'bar-chart-2']] as const).map(([view, icon]) => (
        <button key={view} type="button" aria-pressed={table.view === view} onClick={() => update({ view })}
          className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-interactive-hover', table.view === view && 'text-foreground font-medium')}>
          <Icon name={icon} className="size-3.5" />{t(`folio.${view}`)}
        </button>
      ))}
      <span className="flex-1" />
      {table.view !== 'table' && groupColumn && <select aria-label={t('folio.group')} className="rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-interactive-hover" value={groupColumn.id} onChange={(e) => update(table.view === 'chart' ? { chartBy: e.target.value } : { groupBy: e.target.value })}>
        {table.columns.filter((c) => c.kind === 'select' || c.kind === 'status').map((c) => <option key={c.id} value={c.id}>{t('folio.group')}: {c.name}</option>)}
      </select>}
      <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground" onClick={() => addRow()}>{t('folio.newCard')}</button>
    </div>

    {column && <div className="my-2 flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
      <input className={cn(cellInput, 'w-40 border border-border')} aria-label={t('folio.name')} value={column.name} onChange={(e) => update({ columns: table.columns.map((c) => c.id === column.id ? { ...c, name: e.target.value } : c) })} />
      <select className={cn(cellInput, 'w-32 border border-border')} aria-label={t('folio.kind')} value={column.kind} onChange={(e) => { const parsed = columnKindSchema.safeParse(e.target.value); if (parsed.success) update({ columns: table.columns.map((c) => c.id === column.id ? { ...c, kind: parsed.data } : c) }); }}>
        {columnKinds.map((kind) => <option key={kind} value={kind}>{t(`folio.property.${kind}`)}</option>)}
      </select>
      {(column.kind === 'select' || column.kind === 'status') && <input className={cn(cellInput, 'min-w-60 flex-1 border border-border')} aria-label={t('folio.options')} placeholder={t('folio.options')} value={column.options.join(', ')} onChange={(e) => update({ columns: table.columns.map((c) => c.id === column.id ? { ...c, options: e.target.value.split(',').map((s) => s.trim()) } : c) })} />}
      <button type="button" className="rounded px-2 py-1 text-xs text-destructive hover:bg-interactive-hover" onClick={() => { update({ columns: table.columns.filter((c) => c.id !== column.id) }); setEditingColumn(undefined); }}>{t('folio.remove')}</button>
      <button type="button" className="rounded px-2 py-1 text-xs hover:bg-interactive-hover" onClick={() => setEditingColumn(undefined)}>{t('folio.done')}</button>
    </div>}

    {table.view === 'table' && <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
          {table.columns.map((c) => <th key={c.id} className="min-w-36 border-r border-border/60 px-1 py-1 font-normal last:border-r-0">
            <button type="button" className="w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-interactive-hover" onClick={() => setEditingColumn(c.id)}>{c.name}</button>
          </th>)}
          <th className="w-8"><button type="button" aria-label={t('folio.column')} title={t('folio.column')} className="rounded px-2 py-0.5 hover:bg-interactive-hover" onClick={() => { const id = crypto.randomUUID(); update({ columns: [...table.columns, { id, name: t('folio.name'), kind: 'text', options: [] }] }); setEditingColumn(id); }}>+</button></th>
        </tr></thead>
        <tbody>{table.rows.map((row) => <tr key={row.id} className="group/row border-b border-border/60">
          {table.columns.map((c) => <td key={c.id} className="border-r border-border/60 p-0.5 last:border-r-0">{cell(row, c)}</td>)}
          <td><button type="button" aria-label={t('folio.remove')} className="invisible rounded px-2 text-muted-foreground hover:bg-interactive-hover group-hover/row:visible" onClick={() => update({ rows: table.rows.filter((r) => r.id !== row.id) })}>×</button></td>
        </tr>)}</tbody>
      </table>
      <button type="button" className="mt-1 w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-interactive-hover" onClick={() => addRow()}>+ {t('folio.newCard')}</button>
    </div>}

    {table.view === 'board' && <div className="flex gap-3 overflow-x-auto pb-2 pt-2">
      {groups.map((group) => {
        const rows = table.rows.filter((row) => (groupColumn ? row.values[groupColumn.id] || '' : '') === group);
        const color = group ? optionColor(groupColumn, group) : folioColors.gray;
        return <div key={group || 'none'} className={cn('flex w-64 shrink-0 flex-col gap-1.5 rounded-lg p-1.5 transition-colors', dropGroup === group && 'bg-interactive-hover')}
          style={{ background: dropGroup === group ? undefined : `color-mix(in srgb, ${color} 7%, transparent)` }}
          onDragOver={(e) => { if (dragRow && groupColumn) { e.preventDefault(); setDropGroup(group); } }}
          onDragLeave={() => setDropGroup((g) => (g === group ? undefined : g))}
          onDrop={(e) => { e.preventDefault(); if (dragRow && groupColumn) setValue(dragRow, groupColumn.id, group); setDragRow(undefined); setDropGroup(undefined); }}>
          <div className="flex items-center gap-2 px-1 py-0.5"><Chip color={color}>{group || '—'}</Chip><span className="text-xs text-muted-foreground">{rows.length}</span></div>
          {rows.map((row) => <div key={row.id} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragRow(row.id); }} onDragEnd={() => { setDragRow(undefined); setDropGroup(undefined); }}
            className={cn('cursor-grab rounded-md border border-border/70 bg-background p-2 shadow-sm hover:border-border', dragRow === row.id && 'opacity-50')}>
            {openRow === row.id
              ? <div className="space-y-1">
                {table.columns.map((c) => <label key={c.id} className="block text-[11px] text-muted-foreground">{c.name}{cell(row, c, true)}</label>)}
                <div className="flex justify-between pt-1">
                  <button type="button" className="rounded px-1.5 text-xs text-destructive hover:bg-interactive-hover" onClick={() => update({ rows: table.rows.filter((r) => r.id !== row.id) })}>{t('folio.remove')}</button>
                  <button type="button" className="rounded px-1.5 text-xs hover:bg-interactive-hover" onClick={() => setOpenRow(undefined)}>{t('folio.done')}</button>
                </div>
              </div>
              : <button type="button" className="block w-full text-left" onClick={() => setOpenRow(row.id)}>
                <div className="truncate font-medium">{(titleColumn && row.values[titleColumn.id]) || t('folio.untitled')}</div>
                <div className="mt-1 flex flex-wrap gap-1">{summary(row)}</div>
              </button>}
          </div>)}
          <button type="button" className="rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-interactive-hover" onClick={() => addRow(groupColumn ? { [groupColumn.id]: group } : {})}>+ {t('folio.newCard')}</button>
        </div>;
      })}
    </div>}

    {table.view === 'chart' && <div className="space-y-2 py-3" role="img" aria-label={t('folio.chart')}>
      {groups.map((group) => {
        const count = table.rows.filter((row) => (groupColumn ? row.values[groupColumn.id] || '' : '') === group).length;
        return <div key={group || 'none'} className="grid grid-cols-[140px_1fr_40px] items-center gap-3">
          <span className="truncate text-sm">{group || '—'}</span>
          <div className="h-6 rounded bg-secondary"><div className="h-6 rounded" style={{ width: `${(count / Math.max(1, table.rows.length)) * 100}%`, background: optionColor(groupColumn, group) }} /></div>
          <span className="text-sm tabular-nums">{count}</span>
        </div>;
      })}
    </div>}
  </section>;
}
