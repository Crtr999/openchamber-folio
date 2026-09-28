import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPages, dropZoneAt, isUnder, sortSiblings, type DropZone } from './order';
import { makeBlock, type FolioNote, type FolioTable } from './schema';

const page = (id: string, title: string, extra: Partial<FolioNote> = {}): FolioNote =>
  ({ id, title, icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1, ...extra });

/**
 * A loose meeting note next to a loose parent, which is the case the tree has to serve: the note belongs
 * under CBC and the only thing in the way is that it was never filed.
 */
const cbc = page('cbc', 'CBC');
const meeting = page('meeting', '@April 13, 2026 3:30 PM');
const inbox = page('inbox', 'Inbox');
const agenda = page('agenda', 'Agenda', { parentID: cbc.id, order: 0 });
const actions = page('actions', 'Actions', { parentID: cbc.id });
const notes = page('notes', 'Notes', { parentID: agenda.id, order: 0 });
const minutes = page('minutes', 'Minutes', { parentID: agenda.id, order: 1 });
const clients: FolioTable = {
  columns: [{ id: 'name', name: 'Name', kind: 'title', options: [] }],
  rows: [{ id: 'r1', values: { name: 'Acme' }, page: 'acme' }],
  view: 'table',
};
const acme = page('acme', 'Acme', { parentID: 'book' });
const book = page('book', 'Clients', { table: clients });
const tree = [cbc, meeting, inbox, agenda, actions, notes, minutes, book, acme];

/** What the sidebar does with a drop: rewrite exactly the pages the drop reported. */
const apply = (pages: readonly FolioNote[], movedID: string, targetID: string, zone: DropZone): FolioNote[] => {
  const changed = new Map(dropPages(pages, movedID, targetID, zone).map((note) => [note.id, note]));
  return pages.map((note) => changed.get(note.id) ?? note);
};
const parentOf = (pages: readonly FolioNote[], id: string) => pages.find((note) => note.id === id)?.parentID;
const titlesUnder = (pages: readonly FolioNote[], parentID: string) => sortSiblings(pages.filter((note) => note.parentID === parentID)).map((note) => note.title);

test('the outer quarters of a row put the dragged page beside it and the middle half puts it inside', () => {
  const row = 28;
  assert.deepEqual([0, 3, 6, 7, 14, 21, 22, 27].map((y) => dropZoneAt(y, row)), ['before', 'before', 'before', 'inside', 'inside', 'inside', 'after', 'after']);
  // A row with no measured height has no quarters, so all of it is the middle rather than a coin toss.
  assert.equal(dropZoneAt(0, 0), 'inside');
  assert.equal(dropZoneAt(-12, 0), 'inside');
});

test('dropping on the middle of a page files the dragged page inside it, after the pages already there', () => {
  const dropped = dropPages(tree, meeting.id, cbc.id, 'inside');
  const filed = dropped.find((note) => note.id === meeting.id);
  assert.equal(filed?.parentID, cbc.id);
  assert.equal(filed?.order, 2);

  const after = apply(tree, meeting.id, cbc.id, 'inside');
  assert.deepEqual(titlesUnder(after, cbc.id), ['Agenda', 'Actions', '@April 13, 2026 3:30 PM']);
  // Filing a page under another one is the only page that changes hands.
  assert.deepEqual(after.filter((note) => note.id !== meeting.id).map((note) => note.parentID), tree.filter((note) => note.id !== meeting.id).map((note) => note.parentID));
});

test('a page the user has never dragged is numbered along with the one arriving, so the new one still lands last', () => {
  // Actions has no order, and `sortSiblings` reads an un-ordered page as the last of the group, so a
  // dropped page numbered on its own would land in the middle of the group instead of at the end.
  assert.equal(tree.find((note) => note.id === actions.id)?.order, undefined);
  const after = apply(tree, meeting.id, cbc.id, 'inside');
  assert.equal(after.find((note) => note.id === actions.id)?.order, 1);
  assert.equal(after.find((note) => note.id === agenda.id)?.order, 0);
});

test('a database takes a page inside it like any other page, after its row pages', () => {
  const after = apply(tree, meeting.id, book.id, 'inside');
  assert.equal(parentOf(after, meeting.id), book.id);
  assert.deepEqual(titlesUnder(after, book.id), ['Acme', '@April 13, 2026 3:30 PM']);
});

test('a page keeps its own pages, and their order, when it is filed somewhere else', () => {
  const after = apply(tree, agenda.id, book.id, 'inside');
  assert.equal(parentOf(after, agenda.id), book.id);
  // The subtree travels because the children still point at the page that moved, and nothing about them
  // is rewritten, so their order among themselves cannot shift.
  assert.deepEqual(titlesUnder(after, agenda.id), ['Notes', 'Minutes']);
  assert.deepEqual(after.find((page) => page.id === notes.id), notes);
  assert.deepEqual(after.find((page) => page.id === minutes.id), minutes);
  assert.deepEqual(titlesUnder(after, cbc.id), ['Actions']);
});

test('a database\'s row pages keep their place when a page is filed inside it', () => {
  const after = apply(tree, agenda.id, book.id, 'inside');
  assert.equal(parentOf(after, acme.id), book.id);
});

test('the two edges reorder among the target\'s own siblings and change no page\'s parent', () => {
  const after = apply(tree, meeting.id, inbox.id, 'after');
  assert.deepEqual(sortSiblings(after.filter((note) => !note.parentID)).map((note) => note.title), ['CBC', 'Inbox', '@April 13, 2026 3:30 PM', 'Clients']);
  assert.deepEqual(after.map((note) => note.parentID), tree.map((note) => note.parentID));

  const back = apply(tree, meeting.id, cbc.id, 'before');
  assert.deepEqual(sortSiblings(back.filter((note) => !note.parentID)).map((note) => note.title), ['@April 13, 2026 3:30 PM', 'CBC', 'Inbox', 'Clients']);
  assert.deepEqual(back.map((note) => note.parentID), tree.map((note) => note.parentID));
});

test('the edges do not carry a page across a level, so they only reach the target\'s own siblings', () => {
  assert.deepEqual(dropPages(tree, meeting.id, agenda.id, 'before'), []);
  assert.deepEqual(dropPages(tree, meeting.id, agenda.id, 'after'), []);
  assert.deepEqual(dropPages(tree, agenda.id, cbc.id, 'after'), []);
});

test('a page is never dropped inside a page of its own, which would take the subtree out of the tree', () => {
  assert.equal(isUnder(tree, cbc.id, agenda.id), true);
  assert.equal(isUnder(tree, cbc.id, notes.id), true);
  assert.equal(isUnder(tree, agenda.id, cbc.id), false);
  assert.deepEqual(dropPages(tree, cbc.id, agenda.id, 'inside'), []);
  assert.deepEqual(dropPages(tree, cbc.id, notes.id, 'inside'), []);
  assert.deepEqual(dropPages(tree, agenda.id, cbc.id, 'inside'), []);
});

test('a drop that moves nothing is refused rather than written', () => {
  assert.deepEqual(dropPages(tree, cbc.id, cbc.id, 'inside'), []);
  assert.deepEqual(dropPages(tree, cbc.id, cbc.id, 'after'), []);
  // Actions is already in CBC, so dropping it on CBC again has nowhere to put it.
  assert.deepEqual(dropPages(tree, actions.id, cbc.id, 'inside'), []);
});

test('a parent that is not in the notebook reads as no parent, so a loose page is still a sibling', () => {
  const orphan = page('orphan', 'Orphan', { parentID: 'gone' });
  const withOrphan = [...tree, orphan];
  // A page whose parent is gone is a loose page, so the edges reach it and the middle takes it in.
  assert.ok(dropPages(withOrphan, meeting.id, orphan.id, 'after').length > 0);
  assert.equal(parentOf(apply(withOrphan, meeting.id, orphan.id, 'after'), meeting.id), undefined);
  assert.equal(parentOf(apply(withOrphan, meeting.id, orphan.id, 'inside'), meeting.id), orphan.id);
});
