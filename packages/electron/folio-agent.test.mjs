import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFolioAgent } from './folio-agent.mjs';

const block = (id, text, kind = 'text') => ({ id, kind, text, checked: false, highlight: 'none', marks: [] });
const page = (id, title, extra = {}) => ({ id, title, icon: '', blocks: [block(`${id.slice(0, 8)}-0000-4000-8000-000000000001`, 'First line')], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1, ...extra });

// A stand-in for the native engine: the same save revision check, nothing else.
function fakeEngine(notes) {
  const log = [];
  let selectedID = notes[0].id;
  const state = () => ({ notes: notes.map((n) => structuredClone(n)), selectedID });
  return { log, notes, request: async (input) => {
    log.push(input.command);
    if (input.command === 'save') {
      const index = notes.findIndex((n) => n.id === input.note.id);
      if (input.expectedModified !== notes[index].modified) return { ok: false, error: 'This page changed in another view. Reload the saved page before editing again.' };
      notes[index] = { ...input.note, modified: notes[index].modified + 1 };
    }
    if (input.command === 'create') { const created = page('CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC', input.text, { parentID: input.parentID }); notes.push(created); selectedID = created.id; }
    if (input.command === 'select') selectedID = input.noteID;
    return { ok: true, state: state() };
  } };
}

const welcome = page('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'Welcome to Folio');
const books = page('BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', 'Reading list', { blocks: [], table: { columns: [{ id: 'c1', name: 'Title', kind: 'text', options: [] }, { id: 'c2', name: 'Status', kind: 'select', options: ['Reading', 'Done'] }], rows: [{ id: 'r1', values: { c1: 'Dune', c2: 'Done' } }], view: 'table' } });
const hidden = page('DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD', 'Private journal', { excludedFromAI: true });

test('a page named like an @mention reads as markdown with block ids', async () => {
  const agent = createFolioAgent({ engine: fakeEngine([structuredClone(welcome)]) });
  const result = await agent.execute('folio.read', { page: '@welcome to folio' });
  assert.equal(result.id, welcome.id);
  assert.match(result.markdown, /# Welcome to Folio\n\nFirst line/);
  assert.equal(result.blocks[0].text, 'First line');
});

test('database rows are added by column name through the live engine and reported as changed', async () => {
  const engine = fakeEngine([structuredClone(books)]);
  const changed = [];
  const agent = createFolioAgent({ engine, onChanged: (ids) => changed.push(...ids) });
  const { rowId } = await agent.execute('folio.add_row', { page: 'Reading list', values: { title: 'Hamlet', Status: 'Reading' } });
  assert.deepEqual(engine.notes[0].table.rows.at(-1), { id: rowId, values: { c1: 'Hamlet', c2: 'Reading' } });
  assert.deepEqual(changed, [books.id]);
  await assert.rejects(agent.execute('folio.add_row', { page: 'Reading list', values: { Author: 'x' } }), /No column "Author". Columns: Title, Status/);
});

test('appending markdown adds typed blocks; editing a line keeps its id', async () => {
  const engine = fakeEngine([structuredClone(welcome)]);
  const agent = createFolioAgent({ engine });
  await agent.execute('folio.append', { page: welcome.id, markdown: '## Rules\n- Rule 1.1 competence\n- [ ] Read ch. 2' });
  assert.deepEqual(engine.notes[0].blocks.map((b) => `${b.kind}:${b.text}`), ['text:First line', 'heading2:Rules', 'bullet:Rule 1.1 competence', 'task:Read ch. 2']);
  const first = engine.notes[0].blocks[0].id;
  await agent.execute('folio.update_block', { page: welcome.id, blockId: first, markdown: 'Edited first line' });
  assert.equal(engine.notes[0].blocks[0].id, first);
  assert.equal(engine.notes[0].blocks[0].text, 'Edited first line');
});

test('creating a page leaves the user on the page they had open', async () => {
  const engine = fakeEngine([structuredClone(welcome)]);
  const agent = createFolioAgent({ engine });
  const created = await agent.execute('folio.create', { title: 'Class 3 notes', markdown: 'Hello', parent: 'Welcome to Folio' });
  assert.equal(engine.notes.at(-1).parentID, welcome.id);
  assert.equal(engine.notes.at(-1).blocks[0].text, 'Hello');
  assert.deepEqual(engine.log.filter((c) => c === 'select').length, 1);
  assert.equal(created.title, 'Class 3 notes');
});

test('pages excluded from AI are listed but never read or changed', async () => {
  const agent = createFolioAgent({ engine: fakeEngine([structuredClone(hidden)]) });
  assert.equal((await agent.execute('folio.list', {})).pages[0].excludedFromAI, true);
  await assert.rejects(agent.execute('folio.read', { page: 'Private journal' }), /excluded from AI/);
  await assert.rejects(agent.execute('folio.append', { page: 'Private journal', markdown: 'x' }), /excluded from AI/);
});
