import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildCursorQuery,
  buildFriends,
  parseMention,
  prefixReply,
  assistantTextById,
  buildInboundQuery,
  cleanMessageText,
  composeMorningText,
  createImessageBridge,
  decodeAttributedBody,
  extractReplyText,
  latestCompletedAssistantId,
  normalizeHandle,
  normalizeHandles,
  normalizeStore,
  ownIdentitiesFromRows,
  rowToMessage,
  toStatus,
  truncateReply,
} from './imessage-bridge.mjs';

const handle = (value) => normalizeHandle(value);

test('handles fold to one canonical form', () => {
  assert.equal(handle('+1 (856) 689-2599'), '+18566892599');
  assert.equal(handle('8566892599'), '+18566892599');
  assert.equal(handle('  +18566892599 '), '+18566892599');
  assert.equal(handle('Carter@Example.com'), 'carter@example.com');
  assert.equal(handle(''), '');
  assert.equal(handle(null), '');
  // A typo must be refused rather than quietly allowing nothing.
  assert.equal(handle('carter'), '');
  assert.equal(handle('856689'), '');
  assert.equal(handle('carter@'), '');
  assert.deepEqual(normalizeHandles(['8566892599', '+1 856 689 2599', 'carter@example.com', '']),
    ['+18566892599', 'carter@example.com']);
});

/** The real blob shape: `NSString` class block, 0x2b marker, length, UTF-8. */
const attributedBody = (text) => {
  const payload = Buffer.from(text, 'utf8');
  assert.ok(payload.length < 0x80, 'fixture stays in the single-byte length form');
  return Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64, 0x81, 0xe8, 0x03]),
    Buffer.from('NSString', 'latin1'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, payload.length]),
    payload,
    Buffer.from([0x86, 0x84]),
  ]);
};

test('attributedBody text is read back, including the two-byte length form', () => {
  assert.equal(decodeAttributedBody(attributedBody('Apparently the last assignment is 15 pages')), 'Apparently the last assignment is 15 pages');
  const long = 'x'.repeat(300);
  const wide = Buffer.concat([
    Buffer.from('NSString', 'latin1'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(long.length); return b; })(),
    Buffer.from(long, 'utf8'),
  ]);
  assert.equal(decodeAttributedBody(wide), long);
  assert.equal(decodeAttributedBody(Buffer.alloc(0)), '');
  assert.equal(decodeAttributedBody(Buffer.from('no archive here at all', 'latin1')), '');
});

test('a row falls back to the archive when text is null, and drops attachment marks', () => {
  const fromText = rowToMessage({ rowid: '9', text: 'hello  there ', handle: '8566892599', chatGuid: 'any;-;+18566892599', chatStyle: 45 });
  assert.equal(fromText.text, 'hello  there');
  assert.equal(fromText.handle, '+18566892599');
  assert.equal(fromText.isGroup, false);
  const fromBody = rowToMessage({
    rowid: 10,
    text: null,
    bodyHex: attributedBody('Sent from the archive').toString('hex'),
    handle: '+18566892599',
    chatGuid: 'any;-;+18566892599',
    chatStyle: 45,
  });
  assert.equal(fromBody.text, 'Sent from the archive');
  assert.equal(cleanMessageText('photo \uFFFC attached'), 'photo  attached');
  assert.equal(rowToMessage({ rowid: 11, handle: '+1', text: 'x', chatStyle: 43 }).isGroup, true);
});

test('a sent group row is identified by the account, not a handle', () => {
  const sent = rowToMessage({ rowid: 9, text: 'hi', is_from_me: 1, account: 'E:carterlaborde@gmail.com', handle: null, chatGuid: 'any;+;g', chatStyle: 43 });
  assert.equal(sent.fromMe, true);
  assert.equal(sent.handle, 'carterlaborde@gmail.com');
  assert.equal(sent.isGroup, true);
  const incoming = rowToMessage({ rowid: 10, text: 'hi', is_from_me: 0, account: 'E:carterlaborde@gmail.com', handle: '+18566892599', chatGuid: 'any;-;+18566892599', chatStyle: 45 });
  assert.equal(incoming.handle, '+18566892599');
});

test('the inbound query is read-only, cursor-scoped and reaction-free', () => {
  const sql = buildInboundQuery(616352);
  assert.match(sql, /WHERE m\.ROWID > 616352/);
  assert.match(sql, /m\.is_from_me = 0/);
  assert.match(sql, /m\.associated_message_type = 0/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
  // A caller cannot smuggle SQL through the cursor.
  assert.match(buildInboundQuery('616352; DROP TABLE message'), /WHERE m\.ROWID > 0/);
  assert.match(buildCursorQuery(), /MAX\(ROWID\)/);
});

test('the reply is the newest settled assistant text without tool output', () => {
  const messages = [
    { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'do it' },
    { id: 'msg_a1', type: 'assistant', time: { created: 2, completed: 5 }, content: [{ type: 'text', text: 'Working on it.' }] },
    { id: 'msg_a2', type: 'assistant', time: { created: 6, completed: 9 }, content: [
      { type: 'tool', name: 'shell', state: { status: 'completed' } },
      { type: 'text', text: 'All nine files are updated.' },
    ] },
  ];
  assert.equal(extractReplyText(messages), 'All nine files are updated.');
  assert.equal(latestCompletedAssistantId(messages), 'msg_a2');
  assert.equal(extractReplyText([...messages, { id: 'msg_a3', type: 'assistant', time: { created: 10 }, content: [{ type: 'text', text: 'partial' }] }]), '');
  assert.equal(latestCompletedAssistantId([{ id: 'msg_a3', type: 'assistant', time: { created: 10 } }]), null);
  assert.equal(extractReplyText([]), '');
  // The live API answers newest first; a reply must still be found there.
  const newestFirst = [
    { id: 'msg_a2', type: 'assistant', time: { created: 9, completed: 12 }, content: [{ type: 'text', text: 'All nine files are updated.' }] },
    { id: 'msg_user', type: 'user', time: { created: 8 }, text: 'do it' },
    { id: 'msg_a1', type: 'assistant', time: { created: 5, completed: 6 }, content: [{ type: 'text', text: 'Working on it.' }] },
  ];
  assert.equal(extractReplyText(newestFirst), 'All nine files are updated.');
  assert.equal(latestCompletedAssistantId(newestFirst), 'msg_a2');
  // A step that is still running is not an answer.
  assert.equal(extractReplyText([
    { id: 'msg_a3', type: 'assistant', time: { created: 20 }, content: [{ type: 'text', text: 'partial' }] },
    ...newestFirst,
  ]), '');
});

test('the text belongs to the step that finished, not to whatever is newest', () => {
  const messages = [
    { id: 'msg_a1', type: 'assistant', time: { completed: 5 }, content: [{ type: 'text', text: 'Reading the ledger.' }] },
    { id: 'msg_a2', type: 'assistant', time: { created: 6 }, content: [{ type: 'text', text: 'Still going' }] },
  ];
  assert.equal(assistantTextById(messages, 'msg_a1'), 'Reading the ledger.');
  assert.equal(assistantTextById(messages, 'msg_a2'), 'Still going');
  assert.equal(assistantTextById(messages, 'msg_missing'), '');
  assert.equal(assistantTextById(messages, null), '');
});

test('long replies are trimmed rather than dropped', () => {
  const trimmed = truncateReply('a'.repeat(5_000));
  assert.equal(trimmed.length, 4_000);
  assert.ok(trimmed.endsWith('…'));
});

test('the stored shape keeps chat ids but never invents settings', () => {
  const store = normalizeStore({
    enabled: true,
    handles: ['8566892599', '8566892599'],
    cursor: 42.7,
    defaultFriend: 'Business Launch',
    threads: {
      'any;-;+18566892599': {
        sticky: 'business-launch',
        friends: { 'business-launch': { sessionId: 'ses_abc', lastAt: 7 }, 'legal': { sessionId: 'not-a-session' } },
      },
      'any;+;abc': { friends: {} },
      junk: null,
    },
  });
  assert.deepEqual(store.handles, ['+18566892599']);
  assert.equal(store.cursor, 42);
  assert.equal(store.defaultFriend, 'business-launch');
  assert.equal(store.threads['any;-;+18566892599'].friends['business-launch'].sessionId, 'ses_abc');
  assert.equal(store.threads['any;-;+18566892599'].friends.legal, undefined);
  assert.equal(store.threads['any;-;+18566892599'].sticky, 'business-launch');
  assert.deepEqual(store.threads['any;+;abc'], { friends: {}, sticky: '' });
  assert.equal(store.threads.junk, undefined);
  const withEchoes = normalizeStore({ recentSent: [
    { hash: 'abc', at: 5, chatGuid: 'any;+;g' },
    { hash: '', at: 6 },
    { body: 'a body must never be kept', at: 7 },
    'junk',
  ] });
  assert.deepEqual(withEchoes.recentSent, [{ hash: 'abc', at: 5, chatGuid: 'any;+;g' }]);
  const empty = normalizeStore(null);
  assert.equal(empty.enabled, false);
  assert.deepEqual(empty.handles, []);
  assert.deepEqual(empty.threads, {});
});

test('a registered folder is a friend addressed by its name', () => {
  const friends = buildFriends([
    { label: 'Business Launch', path: '/iCloud/Business Launch' },
    { label: 'ZDR Legal (cite+ZDR)', path: '/iCloud/Carter Docs/Built Apps/ZDR Management' },
    { label: 'Legal (cite but no ZDR)', path: '/iCloud/Carter Docs/Legal' },
    { label: 'Mac Maintenance', path: '/Documents/Open Carter/Mac Maintenance' },
    { label: 'No path' },
  ]);
  assert.deepEqual(friends.map((friend) => friend.key), ['all-chats', 'business-launch', 'zdr-legal', 'legal', 'mac-maintenance']);
  assert.equal(friends[1].directory, '/iCloud/Business Launch');
  // A label that says "no ZDR" is not the folder that enforces it.
  assert.equal(friends.find((friend) => friend.key === 'legal').zdr, false);
  assert.equal(friends.find((friend) => friend.key === 'zdr-legal').zdr, true);
  // All Chats is the chats root, which is where its sessions are created.
  assert.equal(friends[0].directory, null);
  assert.equal(buildFriends([], { allChatsDirectory: '/x/chats' })[0].directory, '/x/chats');
});

test('@ names the friend who answers, and multi-word names work', () => {
  const friends = buildFriends([
    { label: 'Business Launch', path: '/iCloud/Business Launch' },
    { label: 'Legal (cite but no ZDR)', path: '/iCloud/Carter Docs/Legal' },
  ]);
  const direct = parseMention('@business launch what changed?', friends);
  assert.equal(direct.friend.key, 'business-launch');
  assert.equal(direct.body, 'what changed?');
  assert.deepEqual(direct.ambiguous, []);

  const short = parseMention('@legal status', friends);
  assert.equal(short.friend.key, 'legal');
  assert.equal(short.body, 'status');

  const mid = parseMention('hey @legal, check the lease', friends);
  assert.equal(mid.friend.key, 'legal');
  assert.equal(mid.body, 'hey check the lease');

  const none = parseMention('no name here', friends);
  assert.equal(none.friend, null);
  assert.equal(none.body, 'no name here');

  // An unknown name is not silently given to the default friend.
  const unknown = parseMention('@zdr legal fine', friends);
  assert.equal(unknown.friend, null);

  // Only a whole word counts: @legally is not @legal.
  const wordish = parseMention('@legally is not a word', friends);
  assert.equal(wordish.friend, null);

  // A first word is enough when only one friend starts with it.
  const firstWord = parseMention('@legal what now', friends);
  assert.equal(firstWord.friend.key, 'legal');
  const onlyOne = parseMention('@business ship it', buildFriends([
    { label: 'Business Launch', path: '/iCloud/Business Launch' },
    { label: 'Mac Maintenance', path: '/Documents/Mac Maintenance' },
  ]));
  assert.equal(onlyOne.friend.key, 'business-launch');
  assert.equal(onlyOne.body, 'ship it');
});

test('two friends sharing a name are reported instead of guessed', () => {
  const friends = buildFriends([
    { label: 'Legal', path: '/a/Legal' },
    { label: 'Legal', path: '/b/Legal' },
  ]);
  const result = parseMention('@legal who owns this?', friends);
  assert.equal(result.friend, null);
  assert.deepEqual(result.ambiguous.map((friend) => friend.directory), ['/a/Legal', '/b/Legal']);
});

test('a shared thread puts the friend name on the reply', () => {
  const friend = { label: 'Business Launch' };
  assert.equal(prefixReply('done', friend, false), 'done');
  assert.equal(prefixReply('done', friend, true), 'Business Launch: done');
});

test('the panel is told about a missing permission instead of an empty inbox', () => {
  const store = normalizeStore({ enabled: true, handles: ['+18566892599'] });
  const denied = toStatus(store, { readAccess: 'denied', sendAccess: 'granted', running: false, pending: 0, chatDbPath: '/x' });
  assert.match(denied.permissionHint, /Full Disk Access/);
  const granted = toStatus(store, { readAccess: 'granted', sendAccess: 'granted', running: true, pending: 0, chatDbPath: '/x' });
  assert.equal(granted.permissionHint, null);
  assert.equal(granted.running, true);
});

test('a number that cannot be a handle is refused with a reason', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-config-'));
  const bridge = createImessageBridge({
    filePath: path.join(directory, 'bridge.json'),
    chatDbPath: path.join(directory, 'missing.db'),
    osascriptPath: '/bin/echo',
    getApiBaseUrl: () => '',
    log: { warn: () => {} },
  });
  try {
    await assert.rejects(() => bridge.configure({ handles: ['carter'] }), /Not a phone number or email: carter/);
    await assert.rejects(() => bridge.configure({ handles: ['+1 856 689 2599', 'nope'] }), /Not a phone number or email: nope/);
    const status = await bridge.configure({ handles: ['+1 856 689 2599'] });
    assert.deepEqual(status.handles, ['+18566892599']);
    assert.equal(status.enabled, false);
  } finally {
    bridge.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inbound rows from a real sqlite database reach one turn and one reply', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-bridge-'));
  const dbPath = path.join(directory, 'chat.db');
  const filePath = path.join(directory, 'bridge.json');
  execFileSync('/usr/bin/sqlite3', [dbPath, `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, chat_identifier TEXT, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
  is_from_me INTEGER, item_type INTEGER, is_system_message INTEGER, associated_message_type INTEGER, account TEXT, date INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
INSERT INTO handle (ROWID, id, service) VALUES (1, '+18566892599', 'iMessage');
INSERT INTO handle (ROWID, id, service) VALUES (2, '+15551234567', 'iMessage');
INSERT INTO chat (ROWID, guid, style, chat_identifier) VALUES (1, 'any;-;+18566892599', 45, '+18566892599');
INSERT INTO chat (ROWID, guid, style, chat_identifier) VALUES (2, 'any;-;+15551234567', 45, '+15551234567');
INSERT INTO chat (ROWID, guid, style, chat_identifier) VALUES (3, 'chat0001', 43, 'chat0001');
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (100, 'g100', 'ignore history', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (101, 'g101', 'what changed in the ledger?', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (102, 'g102', 'and the second sheet', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (103, 'g103', 'stranger', 2, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (104, 'g104', 'group hello', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (105, 'g105', 'thumbs up', 1, 0, 0, 0, 2000);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 100), (1, 101), (1, 102), (2, 103), (3, 104), (1, 105);
`]);

  const dispatched = [];
  
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/api/config/settings')) {
      return new Response(JSON.stringify({
        projects: [{ label: 'Business Launch', path: '/tmp/example' }],
      }), { status: 200 });
    }
    if (target.endsWith('/api/event')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"session.idle","data":{"sessionID":"ses_text"}}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (target.endsWith('/api/openchamber/sessions') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      dispatched.push(body);
      return new Response(JSON.stringify({ sessionId: 'ses_text', directory: body.directory, promptDispatched: true }), { status: 200 });
    }
    if (target.includes('/api/session/ses_text/message')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'msg_user', type: 'user', text: 'x' },
          { id: 'msg_a1', type: 'assistant', time: { completed: 11 }, content: [{ type: 'text', text: 'Both sheets are reconciled.' }] },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${target}`);
  };

  const bridge = createImessageBridge({
    filePath,
    chatDbPath: dbPath,
    osascriptPath: '/bin/echo',
    getApiBaseUrl: () => 'http://127.0.0.1:1',
    log: { warn: () => {} },
  });

  try {
    await bridge.configure({ enabled: true, handles: ['8566892599'], debounceMs: 20, defaultFriend: 'Business Launch' });
    // The first poll establishes the cursor so history is never answered.
    await bridge.pollOnce();
    let status = await bridge.status();
    assert.equal(status.readAccess, 'granted');
    assert.equal(dispatched.length, 0);

    await sleep(120);
    // Second poll is empty because the cursor is at the newest row.
    await bridge.pollOnce();
    assert.equal(dispatched.length, 0);

    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (110, 'g110', 'what changed in the ledger?', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (111, 'g111', 'and the second sheet', 1, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (112, 'g112', 'stranger again', 2, 0, 0, 0, 0);
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type)
  VALUES (113, 'g113', 'group again', 1, 0, 0, 0, 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 110), (1, 111), (2, 112), (3, 113);
`]);
    await bridge.pollOnce();
    await sleep(200);
    await waitFor(() => dispatched.length > 0, 8_000);

    assert.equal(dispatched.length, 1, 'one turn for two texts, no stranger, no group');
    assert.ok(dispatched[0].prompt.endsWith('what changed in the ledger?\nand the second sheet'));
    // The friend is told to answer like a text, not like a report.
    assert.match(dispatched[0].prompt, /Answer like a text/);
    assert.equal(dispatched[0].directory, '/tmp/example');
    assert.match(dispatched[0].title, /Business Launch · texts/);

    status = await bridge.status();
    assert.equal(status.conversations, 1);
    assert.equal(status.lastError, null);
    // The reply went out through the Messages command, not back into a chat.
    await waitForStatus(bridge, (value) => value.lastTextAt !== null, 10_000);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForStatus = async (bridge, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await bridge.status();
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`status never matched: ${JSON.stringify(last)}`);
};
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error('condition was never met');
};

test('a group thread answers only a named friend, and never its own reply', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-group-'));
  const dbPath = path.join(directory, 'chat.db');
  execFileSync('/usr/bin/sqlite3', [dbPath, `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, chat_identifier TEXT, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
  is_from_me INTEGER, item_type INTEGER, is_system_message INTEGER, associated_message_type INTEGER, account TEXT, date INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
INSERT INTO handle (ROWID, id, service) VALUES (1, '+18566892599', 'iMessage');
INSERT INTO chat (ROWID, guid, style, chat_identifier, display_name) VALUES (1, 'any;+;group1', 43, 'group1', 'Friends');
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (10, 'g10', 'old', NULL, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10);
`]);

  const dispatched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/api/config/settings')) {
      return new Response(JSON.stringify({
        projects: [
          { label: 'Business Launch', path: '/tmp/example' },
          { label: 'Legal', path: '/tmp/legal' },
        ],
      }), { status: 200 });
    }
    if (target.endsWith('/api/event')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"session.idle","data":{"sessionID":"ses_group"}}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (target.endsWith('/api/openchamber/sessions') && init.method === 'POST') {
      dispatched.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ sessionId: 'ses_group', promptDispatched: true }), { status: 200 });
    }
    if (target.includes('/api/session/ses_group/message')) {
      return new Response(JSON.stringify({
        data: [{ id: 'msg_a', type: 'assistant', time: { completed: 5 }, content: [{ type: 'text', text: 'Deck is out. Ask @legal.' }] }],
      }), { status: 200 });
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${target}`);
  };

  const bridge = createImessageBridge({
    filePath: path.join(directory, 'bridge.json'),
    chatDbPath: dbPath,
    osascriptPath: '/bin/echo',
    getApiBaseUrl: () => 'http://127.0.0.1:1',
    log: { warn: () => {} },
  });

  try {
    // A sent group row is identified by the account it was sent from, so that
    // address has to be allowed as well.
    await bridge.configure({ enabled: true, handles: ['8566892599', 'carterlaborde@gmail.com'], debounceMs: 20, defaultFriend: 'Business Launch' });
    await bridge.pollOnce();

    // A group text that names nobody is not a prompt, even from the user.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (11, 'g11', 'just chatting', NULL, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 11);
`]);
    await bridge.pollOnce();
    await sleep(80);
    assert.equal(dispatched.length, 0);

    // Naming the friend is the prompt, and the mention leaves the body.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (12, 'g12', '@business launch ship the deck', NULL, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 12);
`]);
    await bridge.pollOnce();
    await waitFor(() => dispatched.length > 0, 8_000);
    await waitForStatus(bridge, (value) => value.lastTextAt !== null, 10_000);
    assert.equal(dispatched.length, 1);
    assert.ok(dispatched[0].prompt.endsWith('ship the deck'));

    // Our own reply comes back as a from-me row. It must not start another turn.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (13, 'g13', 'Business Launch: Deck is out. Ask @legal.', NULL, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 13);
`]);
    await bridge.pollOnce();
    await sleep(120);
    // The row names @legal, so only the body check keeps it from being a second
    // prompt in the same group.
    assert.equal(dispatched.length, 1, 'the bridge does not answer itself');

    // And the same words come back as an incoming row in a self-thread, which is
    // how a failed reply turned into a loop on 2026-10-28.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (14, 'g14', 'Business Launch: Deck is out. Ask @legal.', 1, 0, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 14);
`]);
    await bridge.pollOnce();
    await sleep(120);
    assert.equal(dispatched.length, 1, 'an echoed reply is not a new request');
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a text from the phone to its own number is a prompt, though it is stored as a sent row', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-self-'));
  const dbPath = path.join(directory, 'chat.db');
  execFileSync('/usr/bin/sqlite3', [dbPath, `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, chat_identifier TEXT, display_name TEXT, account_login TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
  is_from_me INTEGER, item_type INTEGER, is_system_message INTEGER, associated_message_type INTEGER, account TEXT, date INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
INSERT INTO handle (ROWID, id, service) VALUES (1, '+18566892599', 'iMessage'), (2, '+12672888147', 'iMessage');
INSERT INTO chat (ROWID, guid, style, chat_identifier, account_login) VALUES (1, 'any;-;+18566892599', 45, '+18566892599', 'E:carterlaborde@gmail.com'), (2, 'any;-;+12672888147', 45, '+12672888147', 'E:carterlaborde@gmail.com');
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (10, 's10', 'old', 1, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10);
`]);

  const dispatched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/api/config/settings')) {
      return new Response(JSON.stringify({ projects: [{ label: 'Business Launch', path: '/tmp/example' }] }), { status: 200 });
    }
    if (target.endsWith('/api/event')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"session.idle","data":{"sessionID":"ses_self"}}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (target.endsWith('/api/openchamber/sessions') && init.method === 'POST') {
      dispatched.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ sessionId: 'ses_self', promptDispatched: true }), { status: 200 });
    }
    if (target.includes('/api/session/ses_self/message')) {
      return new Response(JSON.stringify({
        data: [{ id: 'msg_a', type: 'assistant', time: { completed: 5 }, content: [{ type: 'text', text: 'Looking into it.' }] }],
      }), { status: 200 });
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${target}`);
  };

  const bridge = createImessageBridge({
    filePath: path.join(directory, 'bridge.json'),
    chatDbPath: dbPath,
    osascriptPath: '/bin/echo',
    getApiBaseUrl: () => 'http://127.0.0.1:1',
    log: { warn: () => {} },
  });

  try {
    await bridge.configure({ enabled: true, handles: ['8566892599'], debounceMs: 20, defaultFriend: 'Business Launch' });
    await bridge.pollOnce();

    // Carter's own sent text in someone else's thread is never a prompt.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (11, 's11', 'see you at six', 2, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 11);
`]);
    await bridge.pollOnce();
    await sleep(80);
    assert.equal(dispatched.length, 0);

    // The same words sent to his own number are the question.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (12, 's12', 'what is on my plate today', 1, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 12);
`]);
    await bridge.pollOnce();
    await waitFor(() => dispatched.length > 0, 8_000);
    await waitForStatus(bridge, (value) => value.lastTextAt !== null, 10_000);
    assert.equal(dispatched.length, 1);

    // Its reply lands in the same thread as another sent row, and is ignored.
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account)
  VALUES (13, 's13', 'Looking into it.', 1, 1, 0, 0, 0, 'E:carterlaborde@gmail.com');
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 13);
`]);
    await bridge.pollOnce();
    await sleep(120);
    assert.equal(dispatched.length, 1, 'the bridge does not answer itself');

    // A text left unread for twenty minutes is not answered late.
    const staleDate = (Math.floor(Date.now() / 1000) - 20 * 60 - 978307200) * 1_000_000_000;
    execFileSync('/usr/bin/sqlite3', [dbPath, `
INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, item_type, is_system_message, associated_message_type, account, date)
  VALUES (14, 's14', 'an old question', 1, 1, 0, 0, 0, 'E:carterlaborde@gmail.com', ${staleDate});
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 14);
`]);
    await bridge.pollOnce();
    await sleep(120);
    assert.equal(dispatched.length, 1, 'a stale text is not answered');
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});


test('the morning text lists what is overdue, due today and close', () => {
  const now = Date.UTC(2026, 9, 28, 13, 0);
  const text = composeMorningText([
    { title: 'Motion to compel (draft)', status: 'active', dueAt: Date.UTC(2026, 9, 15, 23, 59) },
    { title: 'LP Quiz', status: 'active', dueAt: Date.UTC(2026, 9, 29, 3, 59) },
    { title: 'In-house memo', status: 'active', dueAt: Date.UTC(2026, 9, 30, 23, 59) },
    { title: 'ZDR brief', status: 'active', dueAt: Date.UTC(2026, 9, 28, 20, 0), sourceDirectory: '/x/ZDR Management' },
    { title: 'Finished thing', status: 'done', dueAt: Date.UTC(2026, 9, 28, 20, 0) },
    { title: 'Far thing', status: 'active', dueAt: Date.UTC(2026, 10, 20, 23, 59) },
    { title: 'New phone', status: 'active', dueAt: null, watches: ['release'] },
  ], { now, timeZone: 'America/New_York' });
  assert.equal(text, [
    'Morning. 1 due today, 1 overdue.',
    'Overdue: Motion to compel (Oct 15).',
    'Today: LP Quiz (11:59pm).',
    'Next: In-house memo (Oct 30).',
    'Watching: New phone.',
  ].join('\n'));
});

test('a dash in a title keeps its detail when the title still fits a text', () => {
  const text = composeMorningText([
    { title: 'Directed Research — first draft (verify overdue status)', status: 'active', dueAt: Date.UTC(2026, 9, 28, 23, 0) },
  ], { now: Date.UTC(2026, 9, 28, 13, 0), timeZone: 'America/New_York' });
  assert.match(text, /Today: Directed Research, first draft \(/);
});

test('a quiet day still says so, and a text stays within the week', () => {
  const now = Date.UTC(2026, 9, 28, 13, 0);
  assert.equal(composeMorningText([], { now, timeZone: 'America/New_York' }), 'Morning. Nothing due today.');
  const later = composeMorningText([
    { title: 'Six days out', status: 'active', dueAt: Date.UTC(2026, 10, 3, 20, 0) },
  ], { now, timeZone: 'America/New_York' });
  assert.match(later, /Next: Six days out/);
});

test('the morning text sends once a day, after its time, through the send path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imessage-morning-'));
  try {
    const storePath = path.join(dir, 'store.json');
    const commitmentsPath = path.join(dir, 'commitments.json');
    writeFileSync(commitmentsPath, JSON.stringify({
      items: [{ title: 'LP Quiz', status: 'active', dueAt: Date.UTC(2026, 9, 29, 3, 59) }],
    }));
    let now = Date.UTC(2026, 9, 28, 12, 0);
    writeFileSync(storePath, JSON.stringify({
      version: 2,
      enabled: true,
      handles: ['+18566892599'],
      cursor: 1,
      morning: { enabled: true, time: '08:05', lastDay: '' },
    }));
    const bridge = createImessageBridge({
      filePath: storePath,
      chatDbPath: path.join(dir, 'chat.db'),
      osascriptPath: '/bin/echo',
      commitmentsFilePath: commitmentsPath,
      timeZone: 'America/New_York',
      clock: () => now,
    });
    await bridge.load();

    // 08:00 in New York, five minutes before its time.
    assert.equal((await bridge.sendMorning()).sent, false);

    now = Date.UTC(2026, 9, 28, 12, 10);
    const first = await bridge.sendMorning();
    assert.equal(first.sent, true);
    assert.match(first.text, /Today: LP Quiz/);

    now = Date.UTC(2026, 9, 28, 12, 30);
    assert.equal((await bridge.sendMorning()).sent, false, 'one text a day');

    assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).morning.lastDay, '2026-10-28');

    // An explicit test still goes out, and is recorded like any other send.
    const forced = await bridge.sendMorning({ force: true });
    assert.equal(forced.sent, true);
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.ok(store.recentSent.some((entry) => entry.hash.length > 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Mac's signed-in Messages accounts count as the user without a list", () => {
  assert.deepEqual(
    ownIdentitiesFromRows([
      { login: 'E:CarterLaborde@Gmail.com' },
      { login: 'P:+18566892599' },
      { login: 'P:+18566892599' },
      { login: '' },
      {},
    ]),
    ['carterlaborde@gmail.com', '+18566892599'],
  );
  assert.deepEqual(ownIdentitiesFromRows(null), []);
});
