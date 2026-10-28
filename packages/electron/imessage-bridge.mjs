/**
 * Texting a friend: inbound iMessage, outbound replies.
 *
 * The bridge is a native desktop capability, so it lives in the Electron
 * boundary rather than in a server route. It owns three things:
 *
 *   1. reading new inbound rows from ~/Library/Messages/chat.db (read-only,
 *      incremental by ROWID, allowlisted handles only),
 *   2. handing each conversation to the local OpenChamber server as ordinary
 *      chat turns in a folder, and
 *   3. sending the settled reply back through Messages.app.
 *
 * It adds no listener, no cloud endpoint and no second conversation store: the
 * conversation it keeps is an ordinary OpenChamber session in a folder, so the
 * friend's rules, memory, model and guardrails apply exactly as they do in the
 * app.
 *
 * Message bodies are never logged, only row ids and lengths.
 *
 * Reading chat.db requires Full Disk Access for the running app. Without it
 * sqlite reports "authorization denied" and the bridge reports `read: denied`
 * instead of pretending there were no messages.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STORE_VERSION = 2;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 2_500;
const MAX_BATCH_WAIT_MS = 15_000;
const DEFAULT_REPLY_TIMEOUT_MS = 240_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_INBOUND_PER_POLL = 40;
const IDLE_POLL_MS = 2_000;
const SETTLE_MS = 900;

const nowMs = () => Date.now();

const DAY_MS = 86_400_000;

/** Wall clock in the Mac's own zone: the day it belongs to and minutes since
 *  midnight. A morning text has to follow the phone's calendar, not UTC. */
const localParts = (at, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const field = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = field('hour') === '24' ? '00' : field('hour');
  return {
    date: `${field('year')}-${field('month')}-${field('day')}`,
    minutes: Number(hour) * 60 + Number(field('minute')),
  };
};

const dayKey = (at, timeZone) => localParts(at, timeZone).date;

const dayNumber = (key) => {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

const formatDue = (at, timeZone, sameDay) => (sameDay
  ? new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(at)).replace(/\s/g, '').toLowerCase()
  : new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' })
    .format(new Date(at)));

/** A text is a small screen. A trailing bracket is working detail, so it goes,
 *  and a dash becomes a colon when the whole thing still fits; only a title too
 *  long for one line is cut back to the part before the dash. */
const shortTitle = (title) => {
  const raw = cleanMessageText(String(title || ''));
  const trimmed = raw.replace(/(\s*\([^)]*\))+\s*$/, '').trim() || raw;
  const spoken = trimmed.replace(/\s*[—–]\s*/g, ', ');
  if (spoken.length <= 46) return spoken;
  const head = trimmed.split(/\s*[—–]\s*/)[0].trim();
  if (head && head.length <= 46) return head;
  return `${spoken.slice(0, 43).trimEnd()}...`;
};

/** The morning text: what is overdue, what falls due today, what is close, and
 *  what is only being watched. Built from the commitments list the app keeps, so
 *  it is the same list the folder would read out if asked. */
export const composeMorningText = (items, { now = Date.now(), timeZone = 'UTC' } = {}) => {
  const today = dayKey(now, timeZone);
  const active = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.status === 'active')
    // A zero-retention folder never reaches a phone.
    .filter((item) => !/zdr/i.test(String(item.sourceDirectory || '')));
  const dated = active
    .filter((item) => Number.isFinite(Number(item.dueAt)) && Number(item.dueAt) > 0)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  const same = (item) => dayKey(Number(item.dueAt), timeZone) === today;
  const overdue = dated.filter((item) => dayKey(Number(item.dueAt), timeZone) < today);
  const dueToday = dated.filter(same);
  const ahead = dated.filter((item) => {
    const key = dayKey(Number(item.dueAt), timeZone);
    return key > today && dayNumber(key) - dayNumber(today) <= 7;
  });
  const watching = active.filter((item) => !(Number.isFinite(Number(item.dueAt)) && Number(item.dueAt) > 0)
    && Array.isArray(item.watches) && item.watches.length > 0);
  const line = (label, group, times) => {
    if (group.length === 0) return '';
    const shown = group.slice(0, 3).map((item) => `${shortTitle(item.title)} (${formatDue(Number(item.dueAt), timeZone, times)})`);
    const more = group.length > 3 ? ` and ${group.length - 3} more` : '';
    return `${label}: ${shown.join(', ')}${more}.`;
  };
  const counts = [];
  if (dueToday.length > 0) counts.push(`${dueToday.length} due today`);
  if (overdue.length > 0) counts.push(`${overdue.length} overdue`);
  const lines = [counts.length > 0 ? `Morning. ${counts.join(', ')}.` : 'Morning. Nothing due today.'];
  for (const part of [
    line('Overdue', overdue, false),
    line('Today', dueToday, true),
    line('Next', ahead, false),
    watching.length > 0
      ? `Watching: ${watching.slice(0, 2).map((item) => shortTitle(item.title)).join(', ')}.`
      : '',
  ]) {
    if (part) lines.push(part);
  }
  return lines.join('\n');
};

// A friend reading Carter's words on a phone answers the way a person texts,
// not the way an app prints a report.
const TEXT_STYLE = 'This arrived as a text on Carter\'s phone. Answer like a text: a sentence or two, plain words, no markdown, no headings, no lists, and do not introduce yourself.';
const GROUP_CHAT_STYLE = 43;

/** "+1 (267) 888-8147" and "2678888147" name the same person; emails fold case.
 *  Anything that is neither a phone number nor an email is rejected here, so a
 *  typo in the allowlist cannot silently match nothing forever. */
export const normalizeHandle = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed.toLowerCase() : '';
  }
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  // Ten digits is the number someone types without a country code.
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
};

export const normalizeHandles = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const normalized = normalizeHandle(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

/** The friend who answers when a text names nobody. It is an ordinary folder
 *  friend too, the one whose sessions live in the chats root. */
export const ALL_CHATS_FRIEND = Object.freeze({
  key: 'all-chats',
  label: 'All Chats',
  directory: null,
  aliases: Object.freeze(['all chats', 'allchats', 'chats']),
  zdr: false,
});

export const slugify = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-')
  .slice(0, 40) || 'friend';

/** A registered project is a friend. Its label is what the user types after an
 *  @, its path is the folder whose rules, memory and style answer. */
export const friendFromProject = (project) => {
  const directory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!directory) return null;
  const basename = directory.split('/').filter(Boolean).pop() || directory;
  const label = typeof project?.label === 'string' && project.label.trim() ? project.label.trim() : basename;
  // "Legal (cite but no ZDR)" is addressed as "Legal"; the parenthetical is a note.
  const short = label.replace(/\s*\([^)]*\)\s*$/, '').trim() || basename;
  const aliases = [...new Set([label, short, basename].map((entry) => entry.trim()).filter(Boolean))];
  return {
    key: slugify(short),
    label,
    directory,
    aliases,
    // Only the folder that actually enforces zero retention is marked. A label
    // that says "no ZDR" must not be treated as one.
    zdr: /zdr/i.test(basename),
  };
};

export const buildFriends = (projects, options = {}) => {
  const allChatsDirectory = typeof options?.allChatsDirectory === 'string' && options.allChatsDirectory.trim()
    ? options.allChatsDirectory.trim()
    : null;
  const seen = new Set([ALL_CHATS_FRIEND.key]);
  // All Chats is a real folder, the chats root, so a session can be created in
  // it: the session route refuses a request with no directory at all.
  const friends = [{ ...ALL_CHATS_FRIEND, directory: allChatsDirectory, aliases: [...ALL_CHATS_FRIEND.aliases] }];
  for (const project of Array.isArray(projects) ? projects : []) {
    const friend = friendFromProject(project);
    if (!friend) continue;
    let key = friend.key;
    let suffix = 2;
    while (seen.has(key)) key = `${friend.key}-${suffix++}`;
    seen.add(key);
    friends.push({ ...friend, key });
  }
  return friends;
};

/**
 * "@business launch, what changed?" names a friend and leaves a body. The match
 * is exact first, then the longest alias that ends on a word boundary, so a
 * multi-word friend is reachable without a menu. Two friends sharing a name are
 * reported rather than guessed.
 */
export const parseMention = (text, friends) => {
  const source = typeof text === 'string' ? text : '';
  const at = source.indexOf('@');
  if (at < 0) return { friend: null, body: source.trim(), ambiguous: [], mention: null };
  const after = source.slice(at + 1);
  const firstLine = after.split('\n')[0] || '';
  const window = firstLine.slice(0, 80);
  const lower = window.toLowerCase();
  const exact = [];
  const partial = [];
  for (const friend of Array.isArray(friends) ? friends : []) {
    for (const alias of friend.aliases || []) {
      const candidate = String(alias || '').trim().toLowerCase();
      if (!candidate) continue;
      if (lower.startsWith(candidate)) {
        const next = lower[candidate.length];
        const boundary = lower.length === candidate.length || /[\s,:;.!?]/.test(next || '');
        if (!boundary) continue;
        if (lower.length === candidate.length) exact.push({ friend, length: candidate.length });
        else partial.push({ friend, length: candidate.length });
      }
    }
  }
  const pool = exact.length > 0 ? exact : partial;
  if (pool.length === 0) {
    // A first word is enough when only one friend starts with it: @villanova
    // reaches "Villanova Work". It never trims a longer name to its start.
    const word = lower.split(/[\s,:;.!?]/)[0] || '';
    if (!word) return { friend: null, body: source.trim(), ambiguous: [], mention: null };
    const byWord = [];
    for (const friend of Array.isArray(friends) ? friends : []) {
      for (const alias of friend.aliases || []) {
        const candidate = String(alias || '').trim().toLowerCase();
        const first = candidate.split(/[\s,:;.!?]/)[0] || '';
        if (!first || first !== word) continue;
        byWord.push({ friend, length: word.length });
        break;
      }
    }
    const wordFriends = [...new Map(byWord.map((entry) => [entry.friend.key, entry])).values()];
    if (wordFriends.length === 1) {
      const only = wordFriends[0];
      const restOfLine = window.slice(only.length).replace(/^[\s,:;.!?-]+/, '');
      const tail = after.slice(window.length);
      const body = `${source.slice(0, at)}${restOfLine}${tail}`.trim();
      return { friend: only.friend, body, ambiguous: [], mention: window.slice(0, only.length).trim() };
    }
    if (wordFriends.length > 1) {
      return { friend: null, body: source.trim(), ambiguous: wordFriends.map((entry) => entry.friend), mention: word };
    }
    return { friend: null, body: source.trim(), ambiguous: [], mention: null };
  }
  const longest = Math.max(...pool.map((entry) => entry.length));
  const winners = pool.filter((entry) => entry.length === longest);
  const unique = [...new Map(winners.map((entry) => [entry.friend.key, entry.friend])).values()];
  if (unique.length > 1) {
    return { friend: null, body: source.trim(), ambiguous: unique, mention: window.slice(0, longest) };
  }
  const friend = unique[0];
  const restOfLine = window.slice(longest).replace(/^[\s,:;.!?-]+/, '');
  const tail = after.slice(window.length);
  const body = `${source.slice(0, at)}${restOfLine}${tail}`.trim();
  return { friend, body, ambiguous: [], mention: window.slice(0, longest).trim() };
};

/** A reply in a shared thread needs a name on it; a one-to-one does not. */
export const prefixReply = (text, friend, isGroup) => {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!isGroup || !friend) return body;
  return `${friend.label}: ${body}`;
};

/**
 * Modern macOS stores most incoming text in `attributedBody` and leaves `text`
 * NULL. The blob is an NSKeyedArchiver plist; the readable string is introduced
 * by the `NSString` class block, then a `+` marker, then a length prefix. Node
 * has no bplist parser and this module adds no dependency, so the archive is
 * read at that known shape and every result is validated before use.
 */
export const decodeAttributedBody = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return '';
  const anchor = buffer.indexOf(Buffer.from('NSString', 'latin1'));
  if (anchor < 0) return '';
  let marker = -1;
  for (let i = anchor + 8; i < Math.min(anchor + 16, buffer.length); i += 1) {
    if (buffer[i] === 0x2b) { marker = i; break; }
  }
  if (marker < 0) return '';
  let offset = marker + 1;
  let length = buffer[offset];
  if (length === undefined) return '';
  if (length === 0x81) {
    if (offset + 2 >= buffer.length) return '';
    length = buffer.readUInt16LE(offset + 1);
    offset += 3;
  } else if (length === 0x82) {
    if (offset + 4 >= buffer.length) return '';
    length = buffer.readUInt32LE(offset + 1);
    offset += 5;
  } else {
    offset += 1;
  }
  if (!(length > 0) || offset + length > buffer.length) return '';
  const text = buffer.subarray(offset, offset + length).toString('utf8');
  if (text.includes('\uFFFD')) return '';
  return text;
};

/** Object replacement characters stand in for attachments; they are not words. */
export const cleanMessageText = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\uFFFC/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const rowToMessage = (row) => {
  const fromMe = Number(row?.is_from_me) === 1;
  const direct = normalizeHandle(row?.handle);
  // A row the user sent has no handle in a group chat, so the account he sent
  // from is the identity that decides whether this Mac reads it.
  const own = normalizeHandle(typeof row?.account === 'string' ? row.account.replace(/^[EP]:/, '') : '');
  const text = cleanMessageText(row?.text) || cleanMessageText(decodeAttributedBody(
    typeof row?.bodyHex === 'string' ? Buffer.from(row.bodyHex, 'hex') : Buffer.alloc(0),
  ));
  return {
    rowId: Number(row?.rowid),
    handle: fromMe && !direct ? own : direct,
    chatGuid: typeof row?.chatGuid === 'string' ? row.chatGuid : '',
    isGroup: Number(row?.chatStyle) === GROUP_CHAT_STYLE,
    fromMe,
    text,
  };
};

/** Group chats need their own outgoing rows, because a thread whose only
 *  members are the user's own addresses records his texts as sent by him.
 *  One-to-one chats keep answering inbound only. */
export const buildInboundQuery = (afterRowId) => {
  const cursor = Number.isFinite(afterRowId) && afterRowId > 0 ? Math.trunc(afterRowId) : 0;
  return `
SELECT m.ROWID AS rowid,
       m.text AS text,
       hex(m.attributedBody) AS bodyHex,
       m.is_from_me AS is_from_me,
       m.account AS account,
       h.id AS handle,
       c.guid AS chatGuid,
       c.style AS chatStyle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
 WHERE m.ROWID > ${cursor}
   AND (m.is_from_me = 0 OR c.style = ${GROUP_CHAT_STYLE})
   AND m.item_type = 0
   AND m.is_system_message = 0
   AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
 ORDER BY m.ROWID ASC
 LIMIT ${MAX_INBOUND_PER_POLL};
`.trim();
};

/** The Apple ID addresses and numbers this Mac is signed in to Messages with.
 *  A text from the user's own phone can arrive from any of them, so they are
 *  always the user, with no list to keep in step. */
export const buildOwnIdentitiesQuery = () => `
SELECT DISTINCT account_login AS login
  FROM chat
 WHERE account_login IS NOT NULL AND account_login != '';
`.trim();

export const ownIdentitiesFromRows = (rows) => {
  if (!Array.isArray(rows)) return [];
  return normalizeHandles(rows.map((row) => (
    typeof row?.login === 'string' ? row.login.replace(/^[A-Z]:/, '') : ''
  )));
};

export const buildCursorQuery = () => 'SELECT COALESCE(MAX(ROWID), 0) AS maxRowId FROM message;';

/** Assistant text parts joined, with tool calls and their output left out. */
const assistantText = (entry) => {
  const parts = Array.isArray(entry?.content) ? entry.content : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
};

/** The newest reply only counts once the newest thing in the conversation is a
 *  finished assistant message. A step that is still running, or a user message
 *  with no answer yet, is not a reply. Neither the array order nor a tool call
 *  decides this, only the two timestamps the session API puts on each message. */
export const settledReply = (messages) => {
  if (!Array.isArray(messages)) return null;
  const created = (item) => Number(item?.time?.created);
  const completed = (item) => Number(item?.time?.completed);
  const finished = messages.filter((item) => item?.type === 'assistant' && Number.isFinite(completed(item)));
  if (finished.length === 0) return null;
  const best = finished.reduce((a, b) => (completed(b) >= completed(a) ? b : a));
  const content = messages.filter((item) => item?.type === 'assistant' || item?.type === 'user');
  if (content.length > 0 && content.every((item) => Number.isFinite(created(item)))) {
    const newest = content.reduce((a, b) => (created(b) > created(a) ? b : a));
    // Something started after this answer finished, so the turn is not over.
    if (newest.id !== best.id && created(newest) > completed(best)) return null;
  }
  return { id: best.id, text: assistantText(best) };
};

export const extractReplyText = (messages) => settledReply(messages)?.text ?? '';

export const latestCompletedAssistantId = (messages) => settledReply(messages)?.id ?? null;

/** The text of one specific assistant message. A turn can emit several steps,
 *  so the caller names the step instead of taking whatever is newest. */
export const assistantTextById = (messages, id) => {
  if (!Array.isArray(messages) || !id) return '';
  const entry = messages.find((item) => item?.id === id);
  if (!entry || entry.type !== 'assistant') return '';
  return assistantText(entry);
};

export const truncateReply = (text, limit = MAX_TEXT_LENGTH) => {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

const asPositiveInt = (value, fallback, max) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.trunc(number), max);
};

const emptyStore = () => ({
  version: STORE_VERSION,
  enabled: false,
  handles: [],
  defaultFriend: null,
  forwardNotifications: false,
  pollMs: DEFAULT_POLL_MS,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
  cursor: 0,
  threads: {},
  // Hashes of texts this bridge sent, never the texts themselves. They are what
  // stops it answering its own words when a thread echoes them back.
  recentSent: [],
  // One text a morning with what is due, built from the commitments list.
  morning: { enabled: true, time: '08:05', lastDay: '' },
  lastError: null,
  lastErrorAt: null,
  lastTextAt: null,
  lastInboundAt: null,
});

/** A thread is one iMessage conversation, and inside it one Open Carter session
 *  per friend, so @legal and @research keep separate histories in one chat. */
export const normalizeStore = (raw) => {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  const threads = {};
  const rawThreads = raw.threads && typeof raw.threads === 'object' ? raw.threads : {};
  for (const [chatGuid, value] of Object.entries(rawThreads)) {
    if (!chatGuid || !value || typeof value !== 'object') continue;
    const friends = {};
    const rawFriends = value.friends && typeof value.friends === 'object' ? value.friends : {};
    for (const [friendKey, entry] of Object.entries(rawFriends)) {
      const key = slugify(friendKey);
      if (!key || !entry || typeof entry !== 'object') continue;
      const sessionId = typeof entry.sessionId === 'string' && entry.sessionId.startsWith('ses_') ? entry.sessionId : '';
      if (!sessionId) continue;
      friends[key] = {
        sessionId,
        lastAt: Number.isFinite(Number(entry.lastAt)) ? Number(entry.lastAt) : 0,
      };
    }
    const sticky = slugify(value.sticky);
    threads[chatGuid] = {
      friends,
      sticky: friends[sticky] ? sticky : (Object.keys(friends)[0] || ''),
    };
  }
  return {
    ...base,
    enabled: raw.enabled === true,
    handles: normalizeHandles(raw.handles),
    defaultFriend: typeof raw.defaultFriend === 'string' && raw.defaultFriend.trim() ? slugify(raw.defaultFriend) : null,
    forwardNotifications: raw.forwardNotifications === true,
    pollMs: asPositiveInt(raw.pollMs, DEFAULT_POLL_MS, 30_000),
    debounceMs: asPositiveInt(raw.debounceMs, DEFAULT_DEBOUNCE_MS, 10_000),
    replyTimeoutMs: asPositiveInt(raw.replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS, 900_000),
    cursor: Number.isFinite(Number(raw.cursor)) && Number(raw.cursor) > 0 ? Math.trunc(Number(raw.cursor)) : 0,
    threads,
    recentSent: Array.isArray(raw.recentSent)
      ? raw.recentSent
        .filter((entry) => entry && typeof entry.hash === 'string' && entry.hash.length > 0 && Number.isFinite(Number(entry.at)))
        .slice(-60)
        .map((entry) => ({
          hash: entry.hash.slice(0, 64),
          at: Number(entry.at),
          chatGuid: typeof entry.chatGuid === 'string' ? entry.chatGuid : '',
        }))
      : [],
    morning: {
      enabled: raw.morning?.enabled !== false,
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.morning?.time || '')) ? String(raw.morning.time) : '08:05',
      lastDay: typeof raw.morning?.lastDay === 'string' ? raw.morning.lastDay : '',
    },
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    lastErrorAt: Number.isFinite(Number(raw.lastErrorAt)) ? Number(raw.lastErrorAt) : null,
    lastTextAt: Number.isFinite(Number(raw.lastTextAt)) ? Number(raw.lastTextAt) : null,
    lastInboundAt: Number.isFinite(Number(raw.lastInboundAt)) ? Number(raw.lastInboundAt) : null,
  };
};

/** Everything the settings panel shows. Bodies and session contents stay out. */
export const toStatus = (store, runtime) => ({
  enabled: store.enabled,
  handles: [...store.handles],
  defaultFriend: store.defaultFriend,
  forwardNotifications: store.forwardNotifications,
  morning: {
    enabled: store.morning.enabled,
    time: store.morning.time,
    lastDay: store.morning.lastDay,
  },
  readAccess: runtime.readAccess,
  sendAccess: runtime.sendAccess,
  running: runtime.running,
  conversations: Object.values(store.threads).reduce((total, thread) => total + Object.keys(thread.friends).length, 0),
  pending: runtime.pending,
  lastError: store.lastError,
  lastErrorAt: store.lastErrorAt,
  lastTextAt: store.lastTextAt,
  lastInboundAt: store.lastInboundAt,
  chatDbPath: runtime.chatDbPath,
  friends: Array.isArray(runtime.friends) ? runtime.friends : [],
  permissionHint: runtime.readAccess === 'denied'
    ? 'Grant Full Disk Access to Open Carter in System Settings, then relaunch Open Carter.'
    : null,
});

const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
};

/** Runs a command and returns stdout. `input` is written to stdin, which is how
 *  osascript receives its script without any user text being parsed as a flag. */
const spawnCapture = (file, args, { input = null, timeout = 20_000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    if (error) reject(error);
    else resolve(stdout);
  };
  const killer = setTimeout(() => {
    child.kill('SIGKILL');
    const error = new Error(`${path.basename(file)} timed out`);
    error.stderr = stderr;
    finish(error);
  }, timeout);
  killer.unref?.();
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 16 * 1024 * 1024) {
      child.kill('SIGKILL');
      finish(new Error(`${path.basename(file)} produced too much output`));
    }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => {
    if (code === 0) {
      finish(null);
      return;
    }
    const error = new Error(String(stderr || `${path.basename(file)} exited with ${code}`).trim().slice(0, 400));
    error.stderr = stderr;
    error.code = code;
    finish(error);
  });
  if (input != null) child.stdin.end(input);
  else child.stdin.end();
});

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const SEND_SCRIPT = [
  'on run argv',
  'set messageText to item 1 of argv',
  'set chatId to item 2 of argv',
  'set buddyId to item 3 of argv',
  'tell application "Messages"',
  'if chatId is not "" then',
  'send messageText to chat id chatId',
  'else',
  'set targetService to 1st service whose service type = iMessage',
  'send messageText to buddy buddyId of targetService',
  'end if',
  'end tell',
  'end run',
].join('\n');

export const createImessageBridge = ({
  filePath,
  chatDbPath = path.join(process.env.HOME || '', 'Library/Messages/chat.db'),
  sqlitePath = '/usr/bin/sqlite3',
  osascriptPath = '/usr/bin/osascript',
  getApiBaseUrl = () => '',
  allChatsDirectory = '',
  commitmentsFilePath = '',
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  log = console,
  clock = nowMs,
} = {}) => {
  let store = emptyStore();
  const runtime = {
    readAccess: 'unknown',
    sendAccess: 'unknown',
    running: false,
    pending: 0,
    chatDbPath,
    friends: [],
  };
  let loaded = false;
  let polling = false;
  let timer = null;
  let generation = 0;
  let friendsCache = { at: 0, list: [] };
  const batches = new Map();
  const chains = new Map();
  let morningCheckedAt = 0;

  const persist = async () => {
    try {
      await writeJsonAtomic(filePath, store);
    } catch (error) {
      log.warn?.(`[imessage] could not save settings: ${error?.message || error}`);
    }
  };

  const setError = (message) => {
    store.lastError = String(message || '').slice(0, 300) || null;
    store.lastErrorAt = store.lastError ? clock() : null;
  };

  const load = async () => {
    if (loaded) return store;
    try {
      store = normalizeStore(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
      store = emptyStore();
    }
    loaded = true;
    return store;
  };

  const apiBase = () => {
    const base = getApiBaseUrl();
    if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw new Error('Open Carter is not ready yet');
    return base.replace(/\/+$/, '');
  };

  const requestJson = async (method, route, body) => {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 30_000);
    guard.unref?.();
    try {
      const response = await fetch(`${apiBase()}${route}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const failure = new Error(String(payload?.error || payload?.message || `Open Carter returned ${response.status}`).slice(0, 300));
        failure.status = response.status;
        throw failure;
      }
      return payload;
    } finally {
      clearTimeout(guard);
    }
  };

  /** The friends the app knows are its registered project folders, plus All
   *  Chats. They are read from the same settings the sidebar uses, so a folder
   *  added in the app can be addressed by name without any second list. */
  const loadFriends = async (force = false) => {
    if (!force && friendsCache.list.length > 0 && clock() - friendsCache.at < 60_000) return friendsCache.list;
    try {
      const payload = await requestJson('GET', '/api/config/settings');
      const friends = buildFriends(Array.isArray(payload?.projects) ? payload.projects : [], { allChatsDirectory });
      friendsCache = { at: clock(), list: friends };
    } catch {
      if (friendsCache.list.length === 0) friendsCache = { at: clock(), list: buildFriends([]) };
    }
    runtime.friends = friendsCache.list.map((friend) => ({
      key: friend.key,
      label: friend.label,
      zdr: friend.zdr,
      handles: friend.aliases,
    }));
    return friendsCache.list;
  };

  const readSql = async (sql) => {
    const stdout = await spawnCapture(sqlitePath, ['-readonly', '-json', chatDbPath, sql]);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  };

  const probeRead = async () => {
    try {
      await readSql('SELECT 1 AS ok;');
      runtime.readAccess = 'granted';
      return true;
    } catch (error) {
      const message = String(error?.stderr || error?.message || '');
      runtime.readAccess = /authorization denied|operation not permitted|unable to open/i.test(message) ? 'denied' : 'error';
      if (runtime.readAccess === 'error') setError(message.slice(0, 200) || 'could not read Messages');
      return false;
    }
  };

  const probeSend = async () => {
    try {
      const stdout = await spawnCapture(osascriptPath, ['-e', 'tell application "Messages" to count services'], { timeout: 8_000 });
      runtime.sendAccess = Number(stdout.trim()) > 0 ? 'granted' : 'no-account';
    } catch (error) {
      const message = String(error?.stderr || error?.message || '');
      runtime.sendAccess = /not authorized|not allowed|not permitted|-1743/i.test(message) ? 'denied' : 'error';
    }
    return runtime.sendAccess;
  };

  const sendText = async ({ chatGuid, handle, text }) => {
    const body = truncateReply(text);
    if (!body) throw new Error('nothing to send');
    const target = typeof chatGuid === 'string' ? chatGuid.trim() : '';
    try {
      await spawnCapture(osascriptPath, ['-', body, target, handle], { input: SEND_SCRIPT, timeout: 30_000 });
      runtime.sendAccess = 'granted';
      store.lastTextAt = clock();
      rememberSent(body, target);
      return true;
    } catch (error) {
      const message = String(error?.stderr || error?.message || '');
      runtime.sendAccess = /not authorized|not allowed|not permitted|-1743/i.test(message) ? 'denied' : 'error';
      throw new Error(message.trim().slice(0, 200) || 'Messages refused the text');
    }
  };

  const messagesFor = async (sessionId, directory) => {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const payload = await requestJson('GET', `/api/session/${encodeURIComponent(sessionId)}/message${query}`);
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  };

  /**
   * The server's own session service does the dispatch, so a text becomes an
   * ordinary chat in that friend's folder: same agent, rules, memory and style.
   * One iMessage thread holds one session per friend, so @legal and @research
   * do not share a history.
   */
  const threadFor = (chatGuid) => {
    const key = String(chatGuid || '');
    if (!key) return null;
    if (!store.threads[key]) store.threads[key] = { friends: {}, sticky: '' };
    return store.threads[key];
  };

  const dispatch = async ({ chatGuid, friend, prompt }) => {
    if (!friend.directory) throw new Error(`${friend.label} has no folder to answer in`);
    const thread = threadFor(chatGuid);
    const existing = thread?.friends[friend.key]?.sessionId || '';
    if (existing) {
      try {
        const result = await requestJson('POST', `/api/openchamber/sessions/${encodeURIComponent(existing)}/send`, {
          prompt,
          ...(friend.directory ? { directory: friend.directory } : {}),
        });
        if (result?.promptDispatched === false) throw new Error(result?.promptError || 'the prompt did not reach the agent');
        return { sessionId: result?.sessionId || existing, directory: result?.directory || friend.directory };
      } catch (error) {
        if (error?.status !== 404) throw error;
        // Archived or removed: start a fresh session below.
      }
    }
    const created = await requestJson('POST', '/api/openchamber/sessions', {
      prompt,
      title: `${friend.label} · texts`,
      ...(friend.directory ? { directory: friend.directory } : {}),
    });
    if (created?.promptDispatched === false) throw new Error(created?.promptError || 'the prompt did not reach the agent');
    if (!created?.sessionId) throw new Error('Open Carter did not create a conversation');
    const target = threadFor(chatGuid);
    target.friends[friend.key] = { sessionId: created.sessionId, lastAt: clock() };
    target.sticky = friend.key;
    return { sessionId: created.sessionId, directory: created.directory || friend.directory };
  };

  /** `session.idle` is the authoritative end of a turn. Polling is the safety
   *  net for a stream that was missed, dropped or never connected. `baselineId`
   *  is the last reply before this text arrived, so a stale answer can never be
   *  sent back as if it were new. */
  const awaitTurn = async ({ sessionId, directory, timeoutMs, baselineId }) => {
    const deadline = clock() + Math.max(15_000, timeoutMs);
    const controller = new AbortController();
    let idle = false;
    let streamError = null;

    const subscribe = async () => {
      try {
        const response = await fetch(`${apiBase()}/api/event`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf('\n\n');
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let event = null;
              try {
                event = JSON.parse(line.slice(5).trim());
              } catch {
                continue;
              }
              if (event?.type !== 'session.idle' && event?.type !== 'session.error') continue;
              const id = event?.data?.sessionID ?? event?.properties?.sessionID ?? null;
              if (id !== sessionId) continue;
              if (event?.data?.aborted === true) {
                streamError = new Error('the turn was interrupted');
                return;
              }
              if (event?.type === 'session.error') {
                streamError = new Error('the agent reported an error');
                return;
              }
              idle = true;
              return;
            }
          }
        }
      } catch {
        // A closed or refused stream is not a failure; polling still decides.
      }
    };

    void subscribe();
    try {
      let lastId = null;
      let stable = 0;
      while (clock() < deadline) {
        if (streamError) throw streamError;
        if (idle) break;
        await delay(IDLE_POLL_MS);
        if (streamError) throw streamError;
        if (idle) break;
        let messages;
        try {
          messages = await messagesFor(sessionId, directory);
        } catch {
          continue;
        }
        const settled = settledReply(messages);
        if (!settled || settled.id === baselineId) {
          lastId = null;
          stable = 0;
          continue;
        }
        if (settled.id === lastId) stable += 1;
        else {
          lastId = settled.id;
          stable = 0;
        }
        // Two consecutive quiet polls mean the step is over even if the
        // stream never arrived. The second read confirms no new step replaced
        // it; an answer with no text still counts as answered.
        if (stable >= 1) {
          await delay(SETTLE_MS);
          const again = await messagesFor(sessionId, directory).catch(() => messages);
          const confirmed = settledReply(again);
          if (confirmed && confirmed.id === settled.id) return settled.text;
        }
      }
      if (streamError) throw streamError;
      const finalMessages = await messagesFor(sessionId, directory).catch(() => []);
      const finalReply = settledReply(finalMessages);
      if (finalReply && finalReply.id !== baselineId) return finalReply.text;
      if (!idle) throw new Error('the reply took too long');
      return '';
    } finally {
      controller.abort();
    }
  };

  const MAX_TEXTS_PER_THREAD = 8;
  const TEXT_WINDOW_MS = 10 * 60_000;

  const respond = async ({ handle, chatGuid, friend, isGroup, prompt }) => {
    const started = clock();
    try {
      // A runaway thread is a bug, not a conversation: hold it rather than pour
      // texts into a phone. The user can still start it again after the window.
      const recentOutgoing = store.recentSent
        .filter((entry) => entry.chatGuid === chatGuid && clock() - entry.at < TEXT_WINDOW_MS).length;
      if (recentOutgoing >= MAX_TEXTS_PER_THREAD) {
        setError('paused one thread after too many texts in ten minutes');
        log.warn?.('[imessage] holding a thread: too many texts in ten minutes');
        await persist();
        return;
      }
      const existingSession = store.threads[chatGuid]?.friends?.[friend.key]?.sessionId || '';
      const baselineId = existingSession
        ? latestCompletedAssistantId(await messagesFor(existingSession, friend.directory).catch(() => []))
        : null;
      const dispatched = await dispatch({ chatGuid, friend, prompt: `${TEXT_STYLE}\n\n${prompt}` });
      const text = await awaitTurn({
        sessionId: dispatched.sessionId,
        directory: dispatched.directory,
        timeoutMs: store.replyTimeoutMs,
        baselineId,
      });
      const thread = store.threads[chatGuid];
      if (thread?.friends?.[friend.key]?.sessionId === dispatched.sessionId) {
        thread.friends[friend.key].lastAt = clock();
        thread.sticky = friend.key;
      }
      const body = prefixReply(text || 'Done.', friend, isGroup);
      await sendText({ chatGuid, handle, text: body });
      setError(null);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      setError(message);
      log.warn?.(`[imessage] turn failed after ${clock() - started}ms: ${message}`);
      try {
        await sendText({ chatGuid, handle, text: `${friend.label} could not finish that: ${message}` });
      } catch (sendError) {
        log.warn?.(`[imessage] could not report the failure: ${sendError?.message || sendError}`);
      }
    } finally {
      await persist();
    }
  };

  const flush = (batchKey) => {
    const batch = batches.get(batchKey);
    if (!batch) return;
    batches.delete(batchKey);
    if (batch.timer) clearTimeout(batch.timer);
    runtime.pending = Math.max(0, runtime.pending - 1);
    const prompt = batch.messages.join('\n').trim();
    if (!prompt) return;
    // One chat answers in order, whichever friend was named.
    const previous = chains.get(batch.chatGuid) || Promise.resolve();
    const next = previous
      .then(() => respond({ ...batch, prompt }))
      .catch((error) => log.warn?.(`[imessage] queue error: ${error?.message || error}`));
    chains.set(batch.chatGuid, next);
    void next.finally(() => {
      if (chains.get(batch.chatGuid) === next) chains.delete(batch.chatGuid);
    });
  };

  /** Several texts to the same friend in a row are one thought; a text to a
   *  different friend is its own turn and flushes the first. */
  const enqueue = (message) => {
    const batchKey = `${message.chatGuid}|${message.friend.key}`;
    const existing = batches.get(batchKey);
    if (existing) {
      existing.messages.push(message.text);
      if (existing.timer) clearTimeout(existing.timer);
      const remaining = Math.max(0, MAX_BATCH_WAIT_MS - (clock() - existing.firstAt));
      existing.timer = setTimeout(() => flush(batchKey), Math.min(store.debounceMs, remaining));
      existing.timer.unref?.();
      return;
    }
    const batch = {
      chatGuid: message.chatGuid,
      handle: message.handle,
      friend: message.friend,
      isGroup: message.isGroup,
      messages: [message.text],
      firstAt: clock(),
      timer: null,
    };
    batch.timer = setTimeout(() => flush(batchKey), store.debounceMs);
    batch.timer.unref?.();
    batches.set(batchKey, batch);
    runtime.pending += 1;
  };

  /**
   * A reply the bridge itself sent must never come back as a prompt. In a thread
   * with nobody but the user, every text this Mac sends returns as an incoming
   * message, so this check is applied to every row, not only to sent ones. Only
   * a hash is kept, never the body, and it survives a restart so a pending echo
   * cannot restart a loop.
   */
  const hashBody = (text) => createHash('sha256').update(cleanMessageText(text)).digest('hex');

  const wasSentByBridge = (text) => {
    const hash = hashBody(text);
    const cutoff = clock() - 10 * 60_000;
    store.recentSent = store.recentSent.filter((entry) => entry.at >= cutoff);
    // Hash only, any thread: an echo may come back under a different chat id,
    // and a loop is far worse than dropping a word-for-word repeat.
    return store.recentSent.some((entry) => entry.hash === hash);
  };

  const rememberSent = (text, chatGuid) => {
    store.recentSent.push({
      hash: hashBody(text),
      at: clock(),
      chatGuid: typeof chatGuid === 'string' ? chatGuid : '',
    });
    if (store.recentSent.length > 60) store.recentSent.splice(0, store.recentSent.length - 60);
  };

  /** Who answers this message: the @mentioned friend, the thread's last friend,
   *  or the default. Groups and the user's own rows must name someone. */
  const resolveTarget = async (message) => {
    const friends = await loadFriends();
    const mention = parseMention(message.text, friends);
    if (mention.ambiguous.length > 0) return { clarify: mention.ambiguous };
    if (mention.friend) return { friend: mention.friend, body: mention.body || message.text };
    // A shared thread, or a row the user sent himself, is answered only when a
    // friend was named; an ordinary one-to-one text needs no ceremony.
    if (message.isGroup || message.fromMe) return null;
    const stickyKey = store.threads[message.chatGuid]?.sticky || store.defaultFriend || '';
    const friend = friends.find((entry) => entry.key === stickyKey)
      || friends.find((entry) => entry.key === ALL_CHATS_FRIEND.key)
      || friends[0];
    return friend ? { friend, body: message.text } : null;
  };

  const OWN_IDENTITIES_REFRESH_MS = 10 * 60_000;
  let ownIdentities = new Set();
  let ownIdentitiesAt = 0;

  const pollOnce = async () => {
    if (polling || !store.enabled) return;
    polling = true;
    const generationAtStart = generation;
    try {
      // Once the database has been read successfully there is no reason to
      // re-probe the permission on every tick; a failed read re-checks it.
      if (runtime.readAccess !== 'granted' && !(await probeRead())) {
        await persist();
        return;
      }
      await loadFriends();
      if (Date.now() - ownIdentitiesAt > OWN_IDENTITIES_REFRESH_MS) {
        ownIdentitiesAt = Date.now();
        try {
          ownIdentities = new Set(ownIdentitiesFromRows(await readSql(buildOwnIdentitiesQuery())));
        } catch {
          // Keep the last known identities; the allowlist still works.
        }
      }
      if (store.handles.length === 0 && ownIdentities.size === 0) return;
      if (store.cursor === 0) {
        // First run reads history before answering anything. Nothing before
        // this moment is a message to the friend.
        const rows = await readSql(buildCursorQuery());
        const max = Number(rows?.[0]?.maxRowId);
        store.cursor = Number.isFinite(max) && max > 0 ? Math.trunc(max) : 0;
        await persist();
        return;
      }
      const rows = await readSql(buildInboundQuery(store.cursor));
      if (generation !== generationAtStart) return;
      let changed = false;
      for (const row of rows) {
        const message = rowToMessage(row);
        if (Number.isFinite(message.rowId) && message.rowId > store.cursor) {
          store.cursor = message.rowId;
          changed = true;
        }
        if (!message.handle || !message.text || !message.chatGuid) continue;
        if (!store.handles.includes(message.handle) && !ownIdentities.has(message.handle)) continue;
        // Our own words come back as incoming rows in a self-thread. Dropping
        // them by body hash is what keeps the bridge from answering itself.
        if (wasSentByBridge(message.text)) continue;
        // In a thread where the user's own rows are read, only a named friend
        // is a prompt.
        if (message.fromMe && !message.text.includes('@')) continue;
        if (message.isGroup && !message.text.includes('@')) continue;
        const target = await resolveTarget(message);
        if (target?.clarify) {
          const names = target.clarify.map((friend) => friend.label).join(' or ');
          await sendText({
            chatGuid: message.chatGuid,
            handle: message.handle,
            text: `Which one: ${names}?`,
          }).catch(() => {});
          changed = true;
          continue;
        }
        if (!target) continue;
        store.lastInboundAt = clock();
        enqueue({ ...message, friend: target.friend, text: target.body });
        changed = true;
      }
      if (changed) await persist();
    } catch (error) {
      const message = String(error?.stderr || error?.message || error);
      if (/authorization denied|operation not permitted|unable to open/i.test(message)) {
        runtime.readAccess = 'denied';
      }
      setError(String(error?.message || error));
      await persist();
    } finally {
      polling = false;
    }
  };

  const start = async () => {
    await load();
    generation += 1;
    runtime.running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!store.enabled) return;
    runtime.running = true;
    void probeSend();
    const myGeneration = generation;
    const tick = () => {
      if (myGeneration !== generation) return;
      void pollOnce();
      void sendMorning().catch(() => {});
    };
    tick();
    timer = setInterval(tick, store.pollMs);
    timer.unref?.();
  };

  const stop = () => {
    generation += 1;
    runtime.running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const batch of batches.values()) if (batch.timer) clearTimeout(batch.timer);
    batches.clear();
    runtime.pending = 0;
  };

  const status = async () => {
    await load();
    await loadFriends();
    if (runtime.readAccess === 'unknown') await probeRead();
    if (runtime.sendAccess === 'unknown') await probeSend();
    return toStatus(store, runtime);
  };

  const configure = async (patch = {}) => {
    await load();
    const before = JSON.stringify([store.enabled, store.handles, store.defaultFriend, store.pollMs, store.debounceMs, store.replyTimeoutMs]);
    if (patch.enabled !== undefined) store.enabled = patch.enabled === true;
    if (patch.handles !== undefined) {
      const list = Array.isArray(patch.handles) ? patch.handles.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
      const invalid = list.filter((entry) => !normalizeHandle(entry));
      if (invalid.length > 0) throw new Error(`Not a phone number or email: ${invalid[0].slice(0, 60)}`);
      store.handles = normalizeHandles(list);
    }
    if (patch.defaultFriend !== undefined) {
      if (patch.defaultFriend === null || patch.defaultFriend === '') {
        store.defaultFriend = null;
      } else {
        const friends = await loadFriends(true);
        const wanted = slugify(patch.defaultFriend);
        const match = friends.find((friend) => friend.key === wanted)
          || friends.find((friend) => (friend.aliases || []).some((alias) => slugify(alias) === wanted || alias.toLowerCase() === String(patch.defaultFriend).trim().toLowerCase()));
        if (!match) throw new Error(`No friend called ${String(patch.defaultFriend).slice(0, 40)}`);
        store.defaultFriend = match.key;
      }
    }
    if (patch.forwardNotifications !== undefined) store.forwardNotifications = patch.forwardNotifications === true;
    if (patch.morningEnabled !== undefined) store.morning.enabled = patch.morningEnabled === true;
    if (patch.morningTime !== undefined) {
      const value = String(patch.morningTime || '').trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Give the morning time as HH:MM');
      store.morning.time = value;
    }
    if (patch.pollMs !== undefined) store.pollMs = asPositiveInt(patch.pollMs, DEFAULT_POLL_MS, 30_000);
    if (patch.debounceMs !== undefined) store.debounceMs = asPositiveInt(patch.debounceMs, DEFAULT_DEBOUNCE_MS, 10_000);
    if (patch.replyTimeoutMs !== undefined) store.replyTimeoutMs = asPositiveInt(patch.replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS, 900_000);
    const after = JSON.stringify([store.enabled, store.handles, store.defaultFriend, store.pollMs, store.debounceMs, store.replyTimeoutMs]);
    await persist();
    if (before !== after) await start();
    return status();
  };

  /** Forget the sessions a friend holds in every thread, so the next text to
   *  that friend starts a fresh Open Carter chat. The threads stay. */
  const resetConversation = async (friendInput) => {
    await load();
    const friends = await loadFriends(true);
    const wanted = slugify(friendInput);
    const friend = friends.find((entry) => entry.key === wanted)
      || friends.find((entry) => (entry.aliases || []).some((alias) => slugify(alias) === wanted));
    if (!friend) return status();
    let changed = false;
    for (const thread of Object.values(store.threads)) {
      if (thread.friends[friend.key]) {
        delete thread.friends[friend.key];
        changed = true;
      }
      if (thread.sticky === friend.key) thread.sticky = Object.keys(thread.friends)[0] || '';
    }
    if (changed) await persist();
    return status();
  };

  /** Proactive text, used by notifications when the user asked for them. */
  const notify = async ({ text, handle }) => {
    await load();
    const target = normalizeHandle(handle) || store.handles[0] || '';
    if (!target) throw new Error('no number is allowed to receive texts yet');
    const lastThread = Object.entries(store.threads)
      .filter(([, thread]) => Object.keys(thread.friends).length > 0)
      .sort((a, b) => {
        const latest = (thread) => Math.max(0, ...Object.values(thread.friends).map((entry) => entry.lastAt || 0));
        return latest(b[1]) - latest(a[1]);
      })[0]?.[0] || '';
    await sendText({ chatGuid: lastThread, handle: target, text });
    await persist();
    return { sent: true, handle: target };
  };

  /** One text a morning with what is due. It goes through the same send path as a
   *  reply, so the bridge records its own words and never answers them back. */
  const sendMorning = async ({ force = false } = {}) => {
    await load();
    if (!force && clock() - morningCheckedAt < 60_000) return { sent: false, reason: 'checked a moment ago' };
    morningCheckedAt = clock();
    if (!store.enabled) return { sent: false, reason: 'texting is off' };
    if (!store.morning.enabled && !force) return { sent: false, reason: 'the morning text is off' };
    const now = clock();
    const local = localParts(now, timeZone);
    if (!force) {
      if (store.morning.lastDay === local.date) return { sent: false, reason: 'already sent today' };
      const [hour, minute] = store.morning.time.split(':').map(Number);
      // Too early is not the morning yet; past nine at night it can wait for
      // tomorrow rather than buzz him in bed.
      if (local.minutes < hour * 60 + minute || local.minutes >= 21 * 60) {
        return { sent: false, reason: 'outside the morning window' };
      }
    }
    const target = store.handles.find((entry) => !entry.includes('@')) || store.handles[0] || '';
    if (!target) return { sent: false, reason: 'no number is allowed to receive texts yet' };
    let items = [];
    if (commitmentsFilePath) {
      try {
        const payload = JSON.parse(await readFile(commitmentsFilePath, 'utf8'));
        if (Array.isArray(payload?.items)) items = payload.items;
      } catch {
        // A list that cannot be read is not a reason to stay silent about the day.
      }
    }
    const text = composeMorningText(items, { now, timeZone });
    try {
      await notify({ text, handle: target });
      store.morning.lastDay = local.date;
      await persist();
      return { sent: true, text, handle: target };
    } catch (error) {
      setError(String(error?.message || 'the morning text did not send'));
      await persist();
      return { sent: false, reason: String(error?.message || 'send failed') };
    }
  };

  /** Every session the bridge created, with the friend who owns it. */
  const sessionEntries = () => {
    const rows = [];
    for (const [chatGuid, thread] of Object.entries(store.threads)) {
      for (const [friendKey, entry] of Object.entries(thread.friends || {})) {
        if (entry?.sessionId) rows.push({ chatGuid, friendKey, sessionId: entry.sessionId });
      }
    }
    return rows;
  };

  /** True when a session exists only because someone texted. Its notification is
   *  already answered by the reply, so it must not be mirrored as a second text. */
  const ownsSession = (sessionId) => typeof sessionId === 'string' && sessionId.startsWith('ses_')
    && sessionEntries().some((entry) => entry.sessionId === sessionId);

  /** A friend that enforces zero retention is never mirrored into a
   *  notification, and its texts stay on this Mac. */
  const isZdrSession = (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('ses_')) return false;
    return sessionEntries().some((entry) => entry.sessionId === sessionId && /zdr/i.test(entry.friendKey));
  };

  /**
   * Opt-in mirror of a desktop notification. It sends only when the user turned
   * forwarding on, so a normal app never texts anyone by itself.
   */
  const mirrorNotification = async ({ title, body, sessionId }) => {
    await load();
    if (!store.enabled || !store.forwardNotifications) return { sent: false };
    if (isZdrSession(sessionId)) return { sent: false };
    const text = [title, body].filter((part) => typeof part === 'string' && part.trim()).join('\n').trim();
    if (!text) return { sent: false };
    await notify({ text: truncateReply(text, 600) });
    return { sent: true };
  };

  const sendTest = async (handleInput) => {
    await load();
    const handle = normalizeHandle(handleInput) || store.handles[0] || '';
    if (!handle) throw new Error('Add your number first.');
    await sendText({
      chatGuid: '',
      handle,
      text: 'Open Carter here. Text @ and a friend\'s name to reach that folder.',
    });
    await persist();
    return { sent: true, handle };
  };

  const dispose = () => {
    stop();
    loaded = false;
  };

  return {
    load,
    start,
    stop,
    status,
    configure,
    resetConversation,
    notify,
    mirrorNotification,
    ownsSession,
    isZdrSession,
    sendTest,
    sendMorning,
    pollOnce,
    dispose,
  };
};

export default createImessageBridge;
