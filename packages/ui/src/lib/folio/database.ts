import type { FolioTable, FolioView } from './schema';

/**
 * How a database view picks, orders and groups its rows. Pure, so the Mac, the phone and tests
 * see the same rows for the same view.
 */
export type FilterOp = NonNullable<FolioView['filter']>[number]['op'];
type Column = FolioTable['columns'][number];
type Row = FolioTable['rows'][number];

/** The view a database without saved views shows: its legacy layout. */
export function defaultView(table: FolioTable): FolioView {
  const view: FolioView = { id: 'default', name: '', kind: table.view, groupBy: table.groupBy };
  if (table.view === 'chart' && table.chartBy) view.chart = { x: table.chartBy };
  return view;
}

export const splitValues = (value: string): string[] => value.split(',').map((v) => v.trim()).filter(Boolean);
const checked = (value: string) => /^(true|yes|1|x)$/i.test(value.trim());

/** Columns the view shows, in its order; the title column always shows. */
export function displayColumns(table: FolioTable, view: FolioView): Column[] {
  if (!view.columns?.length) return table.columns;
  const byID = new Map(table.columns.map((c) => [c.id, c]));
  const listed = view.columns.flatMap((id) => byID.get(id) ?? []);
  const title = table.columns.find((c) => c.kind === 'title');
  return title && !listed.includes(title) ? [title, ...listed] : listed;
}

function matches(column: Column | undefined, value: string, filter: NonNullable<FolioView['filter']>[number]): boolean {
  const v = value.trim().toLowerCase();
  const wanted = (filter.values ?? (filter.value !== undefined ? [filter.value] : [])).map((w) => w.trim().toLowerCase());
  const parts = column?.kind === 'multiSelect' ? splitValues(value).map((p) => p.toLowerCase()) : [v];
  switch (filter.op) {
    case 'is': return !wanted.length || wanted.some((w) => parts.includes(w));
    case 'isNot': return !wanted.some((w) => parts.includes(w));
    case 'contains': return !wanted.length || wanted.some((w) => v.includes(w));
    case 'notContains': return !wanted.some((w) => w && v.includes(w));
    case 'empty': return !v;
    case 'notEmpty': return Boolean(v);
    case 'checked': return checked(value);
    case 'unchecked': return !checked(value);
  }
}

function compare(column: Column | undefined, a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1; // empty values sort last either way, like Notion
  if (!b) return -1;
  if (column?.kind === 'number' || column?.kind === 'rating') {
    const x = Number(a.replace(/[$,%\s]/g, '')), y = Number(b.replace(/[$,%\s]/g, ''));
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  if (column?.kind === 'date') {
    const x = Date.parse(a), y = Date.parse(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  if (column && (column.kind === 'select' || column.kind === 'status') && column.options.length) {
    const x = column.options.indexOf(a), y = column.options.indexOf(b);
    if (x >= 0 && y >= 0) return x - y;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** The rows a view shows: filtered, searched and sorted. */
export function viewRows(table: FolioTable, view: FolioView, query = ''): Row[] {
  const byID = new Map(table.columns.map((c) => [c.id, c]));
  const q = query.trim().toLowerCase();
  let rows = table.rows.filter((row) => (view.filter ?? []).every((f) => matches(byID.get(f.column), row.values[f.column] ?? '', f)));
  if (q) rows = rows.filter((row) => Object.values(row.values).some((value) => value.toLowerCase().includes(q)));
  const sorts = view.sort ?? [];
  if (!sorts.length) return rows;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    for (const s of sorts) {
      const result = compare(byID.get(s.column), a.row.values[s.column] ?? '', b.row.values[s.column] ?? '');
      const empty = !(a.row.values[s.column] ?? '') || !(b.row.values[s.column] ?? '');
      if (result) return s.desc && !empty ? -result : result;
    }
    return a.index - b.index;
  }).map(({ row }) => row);
}

/** Board columns: the option list first, then any other values found, then "no value". */
export function groupsFor(column: Column | undefined, rows: readonly Row[]): string[] {
  if (!column) return [''];
  const found = rows.flatMap((row) => (column.kind === 'multiSelect' ? splitValues(row.values[column.id] || '') : [row.values[column.id] || '']));
  const groups = [...new Set([...column.options.filter(Boolean), ...found.filter(Boolean)])];
  return found.some((g) => !g) || !groups.length ? [...groups, ''] : groups;
}

function bucket(value: string, size: 'day' | 'month' | 'year'): string | undefined {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  const iso = new Date(time).toISOString();
  return size === 'year' ? iso.slice(0, 4) : size === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** Chart points: counts per date bucket (optionally running totals) or per value. */
export function chartPoints(table: FolioTable, view: FolioView, rows: readonly Row[]): Array<{ label: string; value: number }> {
  const column = table.columns.find((c) => c.id === (view.chart?.x ?? view.groupBy)) ?? table.columns.find((c) => c.kind === 'status' || c.kind === 'select');
  if (!column) return [];
  const counts = new Map<string, number>();
  if (column.kind === 'date') {
    for (const row of rows) { const key = bucket(row.values[column.id] ?? '', view.chart?.bucket ?? 'month'); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
    let total = 0;
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => { total += value; return { label, value: view.chart?.cumulative ? total : value }; });
  }
  for (const group of groupsFor(column, rows)) counts.set(group, 0);
  for (const row of rows) {
    const values = column.kind === 'multiSelect' ? splitValues(row.values[column.id] ?? '') : [row.values[column.id] ?? ''];
    for (const value of values.length ? values : ['']) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, value]) => value > 0).map(([label, value]) => ({ label, value }));
}
