import { describe, expect, test } from 'bun:test';
import { chartPoints, embeddedView, ownViews, viewRows } from './database';
import type { FolioTable } from './schema';

const table: FolioTable = {
  columns: [{ id: 't', name: 'Title', kind: 'title', options: [] }, { id: 's', name: 'Status', kind: 'status', options: ['Not started', 'In progress', 'Done'] }, { id: 'd', name: 'Completed', kind: 'date', options: [] }, { id: 'g', name: 'Type', kind: 'multiSelect', options: ['Fiction', 'Philosophy'] }],
  rows: [
    { id: '1', values: { t: 'A', s: 'Done', d: '2026-01-05', g: 'Fiction' } },
    { id: '2', values: { t: 'B', s: 'In progress', d: '', g: 'Philosophy, Fiction' } },
    { id: '3', values: { t: 'C', s: 'Done', d: '2026-03-01', g: '' } },
  ],
  view: 'table',
};

describe('database views', () => {
  test('filters by any of several values and sorts dates descending with blanks last', () => {
    const rows = viewRows(table, { id: 'v', name: '', kind: 'table', filter: [{ column: 's', op: 'is', values: ['Done'] }], sort: [{ column: 'd', desc: true }] });
    expect(rows.map((r) => r.values.t)).toEqual(['C', 'A']);
    expect(viewRows(table, { id: 'v', name: '', kind: 'table', sort: [{ column: 'd', desc: true }] }).map((r) => r.values.t)).toEqual(['C', 'A', 'B']);
  });
  test('multi-select filters and search', () => {
    expect(viewRows(table, { id: 'v', name: '', kind: 'table', filter: [{ column: 'g', op: 'is', value: 'Fiction' }] }).map((r) => r.id)).toEqual(['1', '2']);
    expect(viewRows(table, { id: 'v', name: '', kind: 'table' }, 'philo').map((r) => r.id)).toEqual(['2']);
  });
  test('cumulative line chart by month', () => {
    const rows = viewRows(table, { id: 'v', name: '', kind: 'chart' });
    expect(chartPoints(table, { id: 'v', name: '', kind: 'chart', chart: { x: 'd', cumulative: true } }, rows)).toEqual([{ label: '2026-01', value: 1 }, { label: '2026-03', value: 2 }]);
  });

  // A linked view belongs to the page that embeds it, so it is not a tab of its own, and a database
  // whose views are all linked still needs one to draw. The same two rules decide which view a page
  // embedding the database shows, which is what the phone's summary of it is built from.
  test('own views skip the linked ones and fall back to the default', () => {
    expect(ownViews(table).map((v) => v.id)).toEqual(['default']);
    const views = { ...table, activeView: 'board', views: [{ id: 'linked', name: 'L', kind: 'table' as const, linked: true }, { id: 'board', name: 'B', kind: 'board' as const }, { id: 'list', name: 'I', kind: 'list' as const }] };
    expect(ownViews(views).map((v) => v.id)).toEqual(['board', 'list']);
    expect(ownViews({ ...table, views: [{ id: 'linked', name: 'L', kind: 'table' as const, linked: true }] }).map((v) => v.id)).toEqual(['default']);
  });

  test('an embedding page gets the view it links to, or the database’s own active one', () => {
    const views = { ...table, activeView: 'list', views: [{ id: 'linked', name: 'L', kind: 'table' as const, linked: true }, { id: 'list', name: 'I', kind: 'list' as const }, { id: 'board', name: 'B', kind: 'board' as const }] };
    expect(embeddedView(views, 'linked').id).toBe('linked');
    expect(embeddedView(views, undefined).id).toBe('list');
    expect(embeddedView(views, 'gone').id).toBe('list');
  });
});
