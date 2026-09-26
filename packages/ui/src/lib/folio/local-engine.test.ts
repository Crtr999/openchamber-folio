import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFolioEngine, createMemoryStorage, markdownToNote, parseBackup, type FolioHost } from './local-engine';

const host: FolioHost = {
  speak: (_text, done) => done(), pauseSpeaking: () => undefined, stopSpeaking: () => undefined,
  listen: () => false, stopListening: () => undefined, share: async () => undefined, pickFiles: async () => [],
  openFile: () => undefined, utility: (kind) => kind === 'settings',
};

async function engine() {
  let clock = 1_800_000_000_000;
  const local = createLocalFolioEngine({ storage: createMemoryStorage(), host, now: () => clock++ });
  await local.ready;
  return local;
}

test('starts with a welcome page and saves edits against the last saved version', async () => {
  const local = await engine();
  const first = await local.request({ command: 'state' });
  const note = first.state?.notes[0];
  assert.ok(note);
  const saved = await local.request({ command: 'save', note: { ...note, title: 'Edited' }, expectedModified: note.modified });
  assert.equal(saved.ok, true);
  assert.equal(saved.state?.notes[0].title, 'Edited');
  const stale = await local.request({ command: 'save', note: { ...note, title: 'Stale' }, expectedModified: note.modified });
  assert.equal(stale.ok, false);
});

test('creates tables, trashes and restores pages, and refuses parent loops', async () => {
  const local = await engine();
  const created = await local.request({ command: 'create', kind: 'library' });
  const library = created.state?.notes.find((n) => n.id === created.state?.selectedID);
  assert.equal(library?.table?.columns[0].name, 'Title');
  const trashed = await local.request({ command: 'trash', noteID: library?.id });
  assert.equal(trashed.state?.notes.find((n) => n.id === library?.id)?.trashed, true);
  const restored = await local.request({ command: 'trash', noteID: library?.id, flag: true });
  const back = restored.state?.notes.find((n) => n.id === library?.id);
  assert.equal(back?.trashed, false);
  assert.ok(back);
  const loop = await local.request({ command: 'save', note: { ...back, parentID: back.id }, expectedModified: back.modified });
  assert.equal(loop.ok, false);
});

test('backup round-trips and converts native Mac dates', async () => {
  const local = await engine();
  const copy = await engine();
  assert.equal(await copy.importBackup(local.backup()), 1);
  const macNote = { ...parseBackup(local.backup())[0], id: 'F61645A9-DC34-499F-B2FA-CA73D7254098', created: 780_000_000, modified: 780_000_000 };
  const [converted] = parseBackup(JSON.stringify([macNote]));
  assert.equal(new Date(converted.modified).getUTCFullYear(), 2025);
});

test('markdown import keeps headings, tasks and lists', () => {
  const note = markdownToNote('# Plan\n\n## Step\n- [x] Done\n- Item\n\nText', 'x', 1);
  assert.equal(note.title, 'Plan');
  assert.deepEqual(note.blocks.map((b) => b.kind), ['heading2', 'task', 'bullet', 'text']);
  assert.equal(note.blocks[1].checked, true);
});
