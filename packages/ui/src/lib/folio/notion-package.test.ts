import { describe, expect, test } from 'bun:test';
import { importNotionPackage } from './notion-package';
import { notionUUID } from './notion-import';

const ROOT = 'cf941f660ab142059f3d8f7b610fd7cf', DB = '4e53b372d04a42deacce70bd62d1170e', CHILD = '60ce11a2d1f04dbdaf66fade81156eb0';
const source = `<page url="https://app.notion.com/p/${ROOT}" icon="📕">
<iconMetadata>{"type":"emoji","emoji":"📕"}</iconMetadata>
<content>
<columns>
\t<column ratio="68.75">
\t\t<database url="https://app.notion.com/p/${DB}" inline="true">Books</database>
\t</column>
\t<column ratio="31.25">
\t\tReading <span color="blue">list</span>:
\t\t1. Update notes
\t\t<page url="https://app.notion.com/p/${CHILD}">Instructions</page>
\t</column>
</columns>
<meeting-notes>
\t**Team check-in** <mention-date start="2026-01-05"/>
\t<summary>
\t\t### Update
\t\t- Reviewed the deal [^https://www.notion.so/x]
\t</summary>
</meeting-notes>
<table header-row="true">
<tr>
<td>A</td>
<td>B</td>
</tr>
<tr>
<td>1</td>
<td>2</td>
</tr>
</table>
</content>
</page>`;
const supplement = `<meeting-notes>
\t**Team check-in** <mention-date start="2026-01-05"/>
\t<transcript>
\t\tHello there.
\t</transcript>
</meeting-notes>`;
const config = `Source: https://app.notion.com/p/${DB}?pvs=204
<database url="{{https://app.notion.com/p/${DB}}}" inline="true">
The title of this Database is: Books
<data-source url="{{collection://f4e3}}">
<data-source-state>
{"name":"Books","schema":{"Title":{"name":"Title","type":"title"},"Status":{"name":"Status","type":"status","groups":{"complete":[{"color":"green","name":"Done"}],"in_progress":[],"to_do":[{"name":"Not started"}]}},"Done on":{"name":"Done on","type":"date"}}}
</data-source-state>
<view url="{{view://94d761b9-9674-4ecf-ac42-ca75c62169c2}}">
{"type":"table","name":"Finished","displayProperties":["Title","Status","Done on"],"simpleFilters":[{"filter":{"operator":"status_is","property":"Status","value":{"type":"is_group","value":"Complete"}}}],"sorts":[{"direction":"descending","property":"Done on"}]}
</view>
`;

describe('importNotionPackage', () => {
  test('rebuilds a top page with columns, an inline database, a meeting and a table', () => {
    const files = [
      { path: `library/Library ${ROOT}.md`, text: '# Library\n' },
      { path: `library/Library/Books ${DB}_all.csv`, text: 'Title,Done on,Status\nDune,"January 5, 2026",Done\nEmma,,Not started\n' },
      { path: `library/Library/Books/Dune 1111111111111111111111111111111a.md`, text: '# Dune\n\nStatus: Done\n\nGreat book about spice.\n' },
      { path: `library/Library/Books/Emma 1111111111111111111111111111111b.md`, text: '# Emma\n\nStatus: Not started\n' },
      { path: `library/Library/Instructions ${CHILD}.md`, text: '# Instructions\n\nSummarize.\n' },
    ];
    const result = importNotionPackage({ files, sources: [{ archive: 'library', markdown: source, supplement, wide: true }], configs: [{ name: 'books.md', text: config }], now: 1 });
    const root = result.notes.find((n) => n.id === notionUUID(ROOT));
    const books = result.notes.find((n) => n.id === notionUUID(DB));
    expect(root?.icon).toBe('📕');
    expect(root?.wide).toBe(true);
    const database = root?.blocks.find((b) => b.kind === 'database');
    expect(database?.asset).toBe(books?.id);
    expect(database?.column).toBe(0);
    expect(database?.width).toBeCloseTo(0.6875);
    const reading = root?.blocks.find((b) => b.text.startsWith('Reading'));
    expect(reading?.column).toBe(1);
    expect(reading?.marks?.some((m) => m.style === 'color' && m.value === 'blue')).toBe(true);
    expect(root?.blocks.some((b) => b.kind === 'page' && b.asset === notionUUID(CHILD))).toBe(true);
    const meeting = root?.blocks.find((b) => b.kind === 'toggle' && b.text.includes('Team check-in'));
    expect(meeting?.checked).toBe(true);
    expect(root?.blocks.some((b) => b.text === 'Hello there.')).toBe(true);
    expect(root?.blocks.some((b) => b.text.includes('[^'))).toBe(false);
    expect(root?.blocks.find((b) => b.kind === 'table')?.text).toBe('A\tB\n1\t2');
    // Schema, options and the view came from the configuration.
    expect(books?.table?.columns.map((c) => `${c.name}:${c.kind}`)).toEqual(['Title:title', 'Status:status', 'Done on:date']);
    expect(books?.table?.columns[1].colors?.Done).toBe('green');
    expect(books?.table?.views?.[0].filter?.[0]).toEqual({ column: books?.table?.columns[1].id ?? '', op: 'is', values: ['Done'] });
    expect(books?.table?.rows[0].values[books?.table?.columns[2].id ?? '']).toBe('2026-01-05');
    // Dune's page has its own text, so it stays linked from its row; Emma's held only its properties.
    const dune = books?.table?.rows.find((r) => r.values.c0 === 'Dune');
    expect(dune?.page).toBeTruthy();
    expect(result.notes.find((n) => n.id === dune?.page)?.blocks.map((b) => b.text)).toEqual(['Great book about spice.']);
    expect(result.notes.some((n) => n.title === 'Emma')).toBe(false);
  });
});
