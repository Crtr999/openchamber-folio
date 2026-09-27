import { makeBlock, type FolioNote, type FolioTable } from './schema';

/**
 * Daily habits live in an ordinary Folio table page tagged "habits": one row per day (the title
 * column is the date, YYYY-MM-DD) and one column per habit, "✓" when done. Because it is a normal
 * page it syncs, shows as a table, and charts like any other database.
 */

export const HABITS_TAG = 'habits';
export const DONE = '✓';

export const dayKey = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const findHabitsPage = (notes: readonly FolioNote[]) => notes.find((n) => !n.trashed && n.table && n.tags.includes(HABITS_TAG));

export function newHabitsPage(id: string, now: number, habits: readonly string[]): FolioNote {
  const table: FolioTable = {
    columns: [{ id: 'day', name: 'Day', kind: 'title', options: [] }, ...habits.map((name, i): FolioTable['columns'][number] => ({ id: `h${i}`, name, kind: 'select', options: [DONE] }))],
    rows: [],
    view: 'table',
  };
  return { id, title: 'Habits', icon: '✅', blocks: [{ ...makeBlock(), text: 'Check habits off from Home. Each day is a row; each habit is a column.' }], tags: [HABITS_TAG], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now, table };
}

export interface HabitDay { id: string; name: string; done: boolean; streak: number }

/** Today's habits with whether each is done and its current streak (days in a row, counting today if done). */
export function habitsToday(page: FolioNote, now: number): HabitDay[] {
  const table = page.table;
  if (!table) return [];
  const title = table.columns[0]?.id ?? 'day';
  const byDay = new Map(table.rows.map((r) => [r.values[title] ?? '', r]));
  const today = dayKey(now);
  return table.columns.slice(1).map((column) => {
    const doneOn = (day: string) => byDay.get(day)?.values[column.id] === DONE;
    let streak = 0;
    // Yesterday's streak still counts until today ends.
    for (let offset = doneOn(today) ? 0 : 1; offset < 3660; offset += 1) {
      if (!doneOn(dayKey(now - offset * 86_400_000))) break;
      streak += 1;
    }
    return { id: column.id, name: column.name, done: doneOn(today), streak };
  });
}

/** The page with one habit ticked or unticked for today. */
export function toggleHabit(page: FolioNote, habitID: string, now: number): FolioNote {
  const table = page.table;
  if (!table) return page;
  const title = table.columns[0]?.id ?? 'day';
  const today = dayKey(now);
  const existing = table.rows.find((r) => r.values[title] === today);
  const row = existing ?? { id: `d${today}`, values: { [title]: today } };
  const values = { ...row.values, [habitID]: row.values[habitID] === DONE ? '' : DONE };
  const rows = existing ? table.rows.map((r) => (r.id === row.id ? { ...r, values } : r)) : [{ ...row, values }, ...table.rows];
  return { ...page, table: { ...table, rows } };
}

export function addHabit(page: FolioNote, name: string): FolioNote {
  const table = page.table;
  if (!table || !name.trim()) return page;
  const id = `h${Date.now().toString(36)}`;
  return { ...page, table: { ...table, columns: [...table.columns, { id, name: name.trim(), kind: 'select', options: [DONE] }] } };
}
