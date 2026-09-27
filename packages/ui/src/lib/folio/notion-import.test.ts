import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNotionExport, notionUUID, parseCSV, parseInline } from './notion-import';
import { noteSchema } from './schema';

const HOME = 'e733521a8e5548eb830659e2b207d74f', DB = '91191e0a7e534c158d2942e647b6bde1', ROW = '3824fdbee45080139badf1177bb045ee';

test('a Notion export becomes a page tree with a database, links, nested lists and attachments', () => {
  const files = [
    { path: `Home ${HOME}.md`, text: `# Home\n\nStudent ID: 1\n\n[Subjects](Home/Subjects%20${DB}.csv)\n\nsk-ant-api03-${'x'.repeat(40)}\n\nSee **bold** and [site](https://example.com).` },
    { path: `Home/Subjects ${DB}.csv`, text: '\uFEFFName,Teacher\nAccounting,"Honer, J"\n' },
    { path: `Home/Subjects ${DB}_all.csv`, text: '\uFEFFName,Teacher,Room\nAccounting,"Honer, J",303\n' },
    { path: `Home/Subjects/Accounting ${ROW}.md`, text: '# Accounting\n\nTeacher: Honer\n\n- Chapter 1\n    - Nested\n        - Deeper\n\n![shot.png](Accounting/shot.png)' },
    { path: 'Home/Subjects/Accounting/shot.png' },
  ];
  const result = importNotionExport(files, 1_800_000_000_000);
  assert.equal(result.removedSecrets, 1);
  assert.equal(result.notes.length, 3);
  for (const note of result.notes) assert.ok(noteSchema.safeParse(note).success, note.title);
  const [home, table, row] = [notionUUID(HOME), notionUUID(DB), notionUUID(ROW)].map((id) => result.notes.find((n) => n.id === id));
  assert.equal(table?.parentID, home?.id);
  assert.equal(row?.parentID, table?.id);
  assert.deepEqual(table?.table?.columns.map((c) => c.name), ['Name', 'Teacher', 'Room']);
  assert.equal(table?.table?.rows[0].values.c1, 'Honer, J');
  assert.ok(home?.blocks.some((b) => b.kind === 'page' && b.asset === table?.id));
  assert.ok(home?.blocks.some((b) => b.text === '[removed secret]'));
  assert.deepEqual(row?.blocks.filter((b) => b.kind === 'bullet').map((b) => b.indent ?? 0), [0, 1, 2]);
  assert.deepEqual(result.attachments, [{ notePath: `Home/Subjects/Accounting ${ROW}.md`, file: 'Home/Subjects/Accounting/shot.png' }]);
});

test('CSV and inline parsing handle quotes, marks and links', () => {
  assert.deepEqual(parseCSV('a,b\n"x, y","line\nbreak"\n'), [['a', 'b'], ['x, y', 'line\nbreak']]);
  const inline = parseInline('A **bold** and *it* [link](https://x.y)', (t) => t);
  assert.equal(inline.text, 'A bold and it link');
  assert.deepEqual(inline.marks.map((m) => m.style), ['bold', 'italic', 'link']);
  assert.match(notionUUID(HOME), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});
