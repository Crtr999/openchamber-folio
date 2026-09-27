import { flushPendingEdits, useFolioStore } from './store';
import type { FolioNote, FolioTable } from './schema';

/** Database rows and the pages they open, shared by the page editor and the blocks that show databases. */

export function noteByID(id: string): FolioNote | undefined {
  flushPendingEdits();
  const s = useFolioStore.getState();
  return s.drafts[id]?.note ?? s.status?.notes.find((n) => n.id === id);
}
export const useNote = (id: string | undefined) => useFolioStore((s) => (id ? s.drafts[id]?.note ?? s.status?.notes.find((n) => n.id === id) : undefined));

/** Opens a database row's page, creating it (a child of the database) the first time. */
export async function openDatabaseRow(tableID: string, rowID: string): Promise<void> {
  const store = useFolioStore.getState();
  const database = noteByID(tableID);
  const row = database?.table?.rows.find((r) => r.id === rowID);
  if (!database?.table || !row) return;
  const existing = row.page ? store.status?.notes.find((n) => n.id === row.page && !n.trashed) : undefined;
  if (existing) { await store.run({ command: 'select', noteID: existing.id }); return; }
  const title = database.table.columns.find((c) => c.kind === 'title') ?? database.table.columns[0];
  const response = await store.run({ command: 'create', text: (title && row.values[title.id]) || '', parentID: tableID });
  const created = response?.state?.selectedID;
  if (!created || created === tableID) return;
  const latest = noteByID(tableID);
  if (latest?.table) store.edit({ ...latest, table: { ...latest.table, rows: latest.table.rows.map((r) => (r.id === rowID ? { ...r, page: created } : r)) } });
}

/** The row this page belongs to, when it is a database row's page: its properties sit under the title. */
export function useRowOf(note: FolioNote | undefined): { database: FolioNote; row: FolioTable['rows'][number] } | undefined {
  const parent = useNote(note?.parentID);
  if (!note || !parent?.table) return undefined;
  const row = parent.table.rows.find((r) => r.page === note.id);
  return row ? { database: parent, row } : undefined;
}

