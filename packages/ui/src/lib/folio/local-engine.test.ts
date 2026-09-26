import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFolioEngine, createMemoryStorage, markdownToNote, parseBackup, type FolioHost } from './local-engine';

const host: FolioHost = {
  speak: (_text, done) => done(), pauseSpeaking: () => undefined, stopSpeaking: () => undefined,
  listen: () => false, stopListening: () => undefined, share: async () => undefined, pickFiles: async () => [],
  openFile: () => undefined, utility: (kind) => kind === 'settings',
  startRecording: async (onText) => { onText({ text: 'Hello team', at: 65_000, final: true }); }, stopRecording: async () => new File(['x'], 'Meeting.m4a'),
  calendarAccess: async () => true, calendarEvents: async () => [{ id: 'e1', title: 'Standup', start: 1_800_000_600_000, end: 1_800_002_400_000, calendar: 'Work' }],
  remindersOn: () => false, scheduleReminders: async (_events, on) => on,
  downloadAsset: async (path) => (path === 'assets/MAC.pdf' ? new Blob(['mac file']) : undefined),
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

test('records a meeting into the page and makes meeting notes from calendar events', async () => {
  const local = await engine();
  const first = (await local.request({ command: 'state' })).state?.notes[0];
  await local.request({ command: 'record', flag: true, noteID: first?.id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stopped = await local.request({ command: 'stop-recording' });
  const page = stopped.state?.notes.find((n) => n.id === first?.id);
  assert.ok(page?.blocks.some((b) => b.text === '[1:05] Hello team'));
  assert.equal(page?.blocks.at(-1)?.kind, 'attachment');
  const calendar = await local.request({ command: 'calendar-connect' });
  assert.equal(calendar.state?.events[0].title, 'Standup');
  const prepared = await local.request({ command: 'calendar-prepare', eventID: 'e1' });
  const meeting = prepared.state?.notes.find((n) => n.id === prepared.state?.selectedID);
  assert.equal(meeting?.title, 'Standup');
  assert.equal(meeting?.isMeeting, true);
});

test('phone attachments relink to the Mac copy, and Mac attachments download on demand', async () => {
  const local = await engine();
  const first = (await local.request({ command: 'state' })).state?.notes[0];
  assert.ok(first);
  await local.attachFiles(first.id, [new File(['phone file'], 'Plan.txt')]);
  const [upload] = await local.pendingUploads();
  assert.equal(upload.name, 'Plan.txt');
  await local.relinkAsset(upload.ref, 'assets/NEW.txt', upload.file);
  assert.equal((await local.pendingUploads()).length, 0);
  assert.equal(await (await local.attachment(first.id, 'plan.txt'))?.text(), 'phone file');
  const page = (await local.request({ command: 'state' })).state?.notes[0];
  assert.ok(page);
  await local.mergeRemote([{ ...page, blocks: [...page.blocks, { ...page.blocks[0], id: crypto.randomUUID().toUpperCase(), kind: 'attachment', text: 'Mac.pdf', asset: 'assets/MAC.pdf' }], modified: page.modified + 10 }], () => false);
  assert.deepEqual(await local.missingAssets(), ['assets/MAC.pdf']);
  assert.equal(await (await local.attachment(first.id, 'Mac.pdf'))?.text(), 'mac file');
  const reminders = await local.request({ command: 'calendar-reminders', flag: true });
  assert.equal(reminders.state?.reminders, true);
});
