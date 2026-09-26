import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatHash, chatToNote, createFolioSync, decrypt, encrypt, mergeMessages, PHONE_CHATS_PAGE_ID } from './folio-sync.mjs';

test('encrypted envelopes round-trip and reject the wrong key', () => {
  const key = randomBytes(32);
  const body = encrypt(key, { hello: 'world' });
  assert.deepEqual(decrypt(key, body), { hello: 'world' });
  assert.throws(() => decrypt(randomBytes(32), body));
});

test('phone chats become readable pages under the iPhone chats page', () => {
  const page = chatToNote({ id: '0f2c7a52-6f7c-4d57-9a8e-2b1f1f5a1c11', title: 'Plan', created: 1_800_000_000_000, modified: 1_800_000_000_000, model: { name: 'GLM' }, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello\n\nThere' }] });
  assert.equal(page.parentID, PHONE_CHATS_PAGE_ID);
  assert.deepEqual(page.blocks.map((b) => b.text), ['Chat on iPhone · GLM', 'You', 'Hi', 'GLM', 'Hello', 'There']);
});

test('sync applies newer phone pages and returns Mac changes in phone time', async () => {
  const macNote = { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', title: 'Mac', icon: '', blocks: [], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 800_000_000, modified: 800_000_000 };
  const notes = [macNote];
  const requests = [];
  const engine = { request: async (input) => {
    requests.push(input.command);
    if (input.command === 'upsert') { const i = notes.findIndex((n) => n.id === input.note.id); if (i >= 0) notes[i] = input.note; else notes.push(input.note); }
    return { ok: true, state: { notes: notes.slice() } };
  }, syncRequest: async () => ({ ok: true, text: '{}' }) };
  const sync = createFolioSync({ engine, configPath: path.join(mkdtempSync(path.join(tmpdir(), 'folio-sync-')), 'c.json'), getLocalOrigin: () => '', defaultPort: 40000 + Math.floor(Math.random() * 9000) });
  const status = sync.enable();
  const key = Buffer.from(new URLSearchParams(status.pairingURL.split('?')[1]).get('k'), 'base64url');
  const phoneNote = { ...macNote, id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', title: 'Phone', created: 1_800_000_000_000, modified: 1_800_000_000_000 };
  // Reach the request handler the same way the phone does, through the HTTP listener.

  await new Promise((resolve) => setTimeout(resolve, 150));
  const reply = await fetch(`http://127.0.0.1:${status.port}/folio-sync`, { method: 'POST', body: encrypt(key, { op: 'sync', t: Date.now(), since: 0, notes: [phoneNote], chats: [] }) });
  sync.stop();
  const result = decrypt(key, await reply.text());
  assert.ok(requests.includes('upsert'));
  assert.equal(notes.find((n) => n.id === phoneNote.id).modified, 1_800_000_000 - 978_307_200);
  assert.ok(result.notes.some((n) => n.title === 'Mac' && n.modified === (800_000_000 + 978_307_200) * 1000));
  sync.disable();
});

const msg = (id, role, content) => ({ id, role, content, sourceIDs: [] });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';

test('chat merge keeps the side that added messages, and both sides when they diverged', () => {
  assert.deepEqual(mergeMessages([msg(A, 'user', 'hi')], [msg(A, 'user', 'hi'), msg(B, 'assistant', 'yo')]).map((m) => m.id), [A, B]);
  assert.deepEqual(mergeMessages([msg(A, 'user', 'hi'), msg(B, 'assistant', 'yo')], [msg(A, 'user', 'hi')]).map((m) => m.id), [A, B]);
  assert.deepEqual(mergeMessages([msg(A, 'user', 'hi'), msg(B, 'assistant', 'mac')], [msg(A, 'user', 'hi'), msg(C, 'user', 'phone')]).map((m) => m.id), [A, C, B]);
  assert.equal(chatHash([msg(A.toLowerCase(), 'user', 'hi')]), chatHash([msg(A, 'user', 'hi')]));
});

test('assistant chats, attachments and Bella travel through the encrypted route', async () => {
  const notes = [{ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', title: 'Mac page', icon: '', blocks: [], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 800_000_000, modified: 800_000_000 }];
  const chats = { 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA': [msg(A, 'user', 'On the Mac')] };
  const engine = {
    request: async (input) => {
      if (input.command === 'upsert') { const i = notes.findIndex((n) => n.id === input.note.id); if (i >= 0) notes[i] = input.note; else notes.push(input.note); }
      return { ok: true, state: { notes: notes.slice() } };
    },
    syncRequest: async (input) => {
      if (input.command === 'chat-list') return { ok: true, text: JSON.stringify(chats) };
      if (input.command === 'chat-put') { chats[input.noteID] = JSON.parse(input.text); return { ok: true, text: '' }; }
      if (input.command === 'asset-read') return { ok: true, text: Buffer.from('file').toString('base64') };
      if (input.command === 'asset-write') return { ok: true, text: 'assets/NEW.pdf' };
      if (input.command === 'bella') return { ok: true, text: 'UklGRg==' };
      return { ok: false, error: 'no' };
    },
  };
  const sync = createFolioSync({ engine, configPath: path.join(mkdtempSync(path.join(tmpdir(), 'folio-sync-')), 'c.json'), getLocalOrigin: () => '' });
  const status = sync.enable(); sync.stop();
  const key = Buffer.from(new URLSearchParams(status.pairingURL.split('?')[1]).get('k'), 'base64url');
  const call = async (value) => decrypt(key, await sync.handleEncrypted(encrypt(key, { t: Date.now(), ...value })));
  const phoneChat = { noteID: C, title: 'From phone', created: 1_800_000_000_000, modified: 1_800_000_000_000, messages: [msg(B, 'user', 'Started on iPhone')] };
  const reply = await call({ op: 'sync', since: 0, notes: [], assistant: [phoneChat], assistantHashes: {} });
  assert.equal(notes.find((n) => n.id === C).isChat, true);
  assert.equal(chats[C][0].content, 'Started on iPhone');
  assert.deepEqual(reply.assistant.map((c) => c.title).sort(), ['From phone', 'Mac page']);
  const again = await call({ op: 'sync', since: 0, notes: [], assistantHashes: Object.fromEntries(reply.assistant.map((c) => [c.noteID, chatHash(c.messages)])) });
  assert.equal(again.assistant.length, 0);
  assert.equal((await call({ op: 'asset-get', path: 'assets/X.pdf' })).data, Buffer.from('file').toString('base64'));
  assert.equal((await call({ op: 'asset-put', name: 'a.pdf', data: 'eA==' })).path, 'assets/NEW.pdf');
  assert.equal((await call({ op: 'bella', text: 'Hello' })).audio, 'UklGRg==');
  await assert.rejects(call({ op: 'asset-get', path: '../secret' }));
  sync.disable();
});
