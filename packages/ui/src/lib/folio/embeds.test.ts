import { describe, expect, test } from 'bun:test';
import { databaseEmbed, embedPreviews, pageEmbed } from './embeds';
import { makeBlock, type FolioBlock, type FolioNote, type FolioTable } from './schema';

/** The columns a `library` database is created with, so this is what the phone's books table holds. */
const library: FolioTable = {
  columns: [
    { id: 'title', name: 'Title', kind: 'title', options: [] },
    { id: 'author', name: 'Author', kind: 'text', options: [] },
    { id: 'type', name: 'Type', kind: 'select', options: ['Fiction', 'Philosophy'] },
    { id: 'status', name: 'Status', kind: 'status', options: ['To read', 'Reading', 'Done'] },
    { id: 'rating', name: 'Rating', kind: 'rating', options: [] },
  ],
  rows: [
    { id: 'r1', values: { title: 'Piranesi', author: 'Susanna Clarke', type: 'Fiction', status: 'Reading', rating: '4' } },
    { id: 'r2', values: { title: 'The Dispossessed', author: 'Ursula K. Le Guin', type: 'Fiction', status: 'To read', rating: '' } },
    { id: 'r3', values: { title: 'Meditations', author: '', type: 'Philosophy', status: 'Done', rating: '5' } },
  ],
  view: 'table',
};

const note = (blocks: FolioBlock[], extra: Partial<FolioNote> = {}): FolioNote => ({
  id: 'F61645A9-DC34-499F-B2FA-CA73D7254098', title: 'Start', icon: '', blocks, tags: [], favorite: false,
  excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1, ...extra,
});
const embed = (kind: FolioBlock['kind'], asset: string, text = ''): FolioBlock => ({ ...makeBlock(), kind, asset, text });

describe('an embedded database summarised in place', () => {
  test('each row is its title and the first values the view shows, and the rest are counted', () => {
    const summary = databaseEmbed(library, undefined);
    expect(summary).toEqual({ kind: 'database', rows: ['Piranesi · Susanna Clarke · Fiction', 'The Dispossessed · Ursula K. Le Guin · Fiction', 'Meditations · Philosophy · Done'], hidden: 0 });
    expect(summary.rows.length + summary.hidden).toBe(library.rows.length);
  });

  test('a long table shows a few rows and counts the rest', () => {
    const many = { ...library, rows: [...library.rows, ...Array.from({ length: 9 }, (_v, i) => ({ id: `r${i + 4}`, values: { title: `Book ${i + 4}`, author: 'Someone' } }))] };
    const summary = databaseEmbed(many, undefined);
    expect(summary.rows).toHaveLength(4);
    expect(summary.hidden).toBe(8);
    expect(summary.rows.length + summary.hidden).toBe(many.rows.length);
  });

  // The summary stands in for the grid the user would otherwise have to open, so it has to be the
  // grid's rows: a linked view the block points at decides which rows, their order and their columns.
  test('a linked view decides the rows, their order and the columns beside the title', () => {
    const linked = { ...library, views: [{ id: 'done', name: 'Finished', kind: 'table' as const, linked: true, filter: [{ column: 'status', op: 'is' as const, value: 'Done' }], sort: [{ column: 'title', desc: true }], columns: ['status'] }] };
    expect(databaseEmbed(linked, 'done')).toEqual({ kind: 'database', rows: ['Meditations · Done'], hidden: 0 });
    // A view the block does not name falls back to the database's own, so a stale id cannot hide the table.
    expect(databaseEmbed(linked, 'gone').rows).toEqual(['Piranesi · Susanna Clarke · Fiction', 'The Dispossessed · Ursula K. Le Guin · Fiction', 'Meditations · Philosophy · Done']);
  });

  test('a row with nothing in it is left out of the lines and counted with the rest', () => {
    const withBlank = { ...library, rows: [{ id: 'r0', values: {} }, ...library.rows] };
    const summary = databaseEmbed(withBlank, undefined);
    expect(summary.rows).toHaveLength(3);
    expect(summary.rows.every((line) => line.length > 0)).toBe(true);
    expect(summary.rows.length + summary.hidden).toBe(withBlank.rows.length);
  });

  test('an empty database summarises to nothing rather than to a count of nothing', () => {
    expect(databaseEmbed({ ...library, rows: [] }, undefined)).toEqual({ kind: 'database', rows: [], hidden: 0 });
  });
});

describe('a page link summarised in place', () => {
  test('it shows the first line the page has to say, not a block that only names something else', () => {
    const child = note([embed('database', 'D1'), makeBlock(), { ...makeBlock(), kind: 'heading2', text: 'Books' }, { ...makeBlock(), text: 'Finished Piranesi and Meditations,\nleft the rest.' }]);
    expect(pageEmbed(child)).toEqual({ kind: 'page', snippet: 'Books' });
    expect(pageEmbed(note([{ ...makeBlock(), text: 'Finished Piranesi\nand Meditations.' }]))).toEqual({ kind: 'page', snippet: 'Finished Piranesi and Meditations.' });
  });

  test('a page with nothing written in it has no snippet to show', () => {
    expect(pageEmbed(note([makeBlock(), embed('page', 'P2')]))).toBeUndefined();
    expect(pageEmbed(undefined)).toBeUndefined();
  });

  test('a long first line is cut rather than filling the page it sits in', () => {
    const child = note([{ ...makeBlock(), text: 'x'.repeat(400) }]);
    const snippet = pageEmbed(child)?.snippet ?? '';
    expect(snippet.length).toBeLessThanOrEqual(140);
    expect(snippet.endsWith('…')).toBe(true);
  });
});

describe('what the native editor is handed', () => {
  const libraryNote = note([embed('database', 'L1'), embed('pageIn', 'C1'), makeBlock()], { table: library });
  const child = note([{ ...makeBlock(), text: 'A note about rivers.' }]);
  const notes = new Map<string, FolioNote>([['L1', libraryNote], ['C1', child]]);

  test('one summary per thing the page embeds, and nothing for the rest of the notebook', () => {
    const previews = embedPreviews(libraryNote.blocks, notes);
    expect(Object.keys(previews).sort()).toEqual(['C1', 'L1']);
    expect(previews.L1).toEqual({ kind: 'database', rows: ['Piranesi · Susanna Clarke · Fiction', 'The Dispossessed · Ursula K. Le Guin · Fiction', 'Meditations · Philosophy · Done'], hidden: 0 });
    expect(previews.C1).toEqual({ kind: 'page', snippet: 'A note about rivers.' });
  });

  test('a link that points at nothing is left out rather than summarised as empty', () => {
    expect(embedPreviews([embed('page', 'GONE')], notes)).toEqual({});
    expect(embedPreviews([embed('database', 'GONE')], notes)).toEqual({});
  });

  // The summaries are drawn in the text view and never stored, so building them must leave the page
  // and the database exactly as they were: the native editor hands the page back to the store, and
  // anything that leaked out of here would be written to the notebook.
  test('building a summary changes neither the page nor anything it reads', () => {
    const blocks = libraryNote.blocks.map((block) => structuredClone(block));
    const notebook = new Map(notes);
    const before = structuredClone({ blocks, notebook: [...notebook] });
    embedPreviews(blocks, notebook);
    databaseEmbed(library, undefined);
    pageEmbed(child);
    expect({ blocks, notebook: [...notebook] }).toEqual(before);
  });
});
