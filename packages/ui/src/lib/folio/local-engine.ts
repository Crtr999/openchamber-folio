import { z } from 'zod';
import { makeBlock, noteSchema, type FolioAPI, type FolioBlock, type FolioNote, type FolioRequest, type FolioResponse, type FolioStatus, type FolioTable } from './schema';

/**
 * A Folio engine that runs inside the page instead of the Mac helper, so the iPhone app
 * keeps every note on the phone and works with no Mac or network. It answers the same
 * request/response protocol as the native bridge, so the shared Folio UI is unchanged.
 * Dates are milliseconds since 1970 here.
 */

export interface FolioStorage {
  loadNotes(): Promise<FolioNote[]>;
  saveNote(note: FolioNote): Promise<void>;
  loadSelected(): Promise<string | undefined>;
  saveSelected(id: string | undefined): Promise<void>;
  putAsset(id: string, file: Blob): Promise<void>;
  getAsset(id: string): Promise<Blob | undefined>;
}

/** Phone features the engine reaches through the app shell (speech, files, sharing). */
export interface FolioHost {
  speak(text: string, done: () => void): void;
  pauseSpeaking(paused: boolean): void;
  stopSpeaking(): void;
  /** Returns false when the device offers no speech recognition to the page. */
  listen(onWords: (words: string) => void, done: () => void): boolean;
  stopListening(): void;
  share(file: File): Promise<void>;
  pickFiles(accept: string, multiple: boolean): Promise<File[]>;
  openFile(file: Blob, name: string): void;
  /** Opens a phone screen such as settings or the assistant; false when there is none. */
  utility(kind: string): boolean;
}

export interface LocalEngine extends FolioAPI {
  ready: Promise<void>;
  importBackup(text: string): Promise<number>;
  backup(): string;
  /** Pages changed on this phone (by modified time) since a moment, for sync. */
  changedSince(time: number): FolioNote[];
  /** Applies pages from the Mac: newer wins, and pages with an open edit here are left alone. */
  mergeRemote(notes: readonly unknown[], skip: (id: string) => boolean): Promise<number>;
  /** File actions started straight from a tap: iOS only opens pickers and share sheets inside the tap itself. */
  attachFiles(noteID: string, files: File[]): Promise<void>;
  importFiles(files: File[]): Promise<void>;
  exportFile(note: FolioNote, kind: string): File | undefined;
  backupFile(): File;
}

const assetPrefix = 'asset:';

function freshStatus(): FolioStatus {
  return {
    notes: [], status: '', importing: false, importProgress: '', listening: false, dictation: '', speaking: false, paused: false,
    voiceID: '', rate: 0.5, voices: [], recording: false, recordingStarting: false, transcribing: false, recordingProgress: '',
    microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [], reminders: false, fontSize: 17, highlightStrength: 0.8,
    aiBusy: false, messages: [],
  };
}

const newID = () => crypto.randomUUID().toUpperCase();

function welcomeNote(now: number): FolioNote {
  const text = (value: string, kind: FolioBlock['kind'] = 'text'): FolioBlock => ({ ...makeBlock(), kind, text: value });
  return {
    id: newID(), title: 'Welcome to Folio', icon: '📓', blocks: [
      text('Your notes live on this iPhone and work without your Mac or a signal.'),
      text('Type / for headings, lists, to-dos and databases.', 'bullet'),
      text('Open the menu to search, start an AI chat, or change settings.', 'bullet'),
      text('Move your Mac notes here from Settings → Import backup.', 'bullet'),
    ], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now,
  };
}

function table(kind: 'table' | 'library'): FolioTable {
  const column = (name: string, columnKind: FolioTable['columns'][number]['kind'], options: string[] = []) => ({ id: newID(), name, kind: columnKind, options });
  const columns = kind === 'library'
    ? [column('Title', 'title'), column('Author', 'text'), column('Type', 'select', ['Fiction', 'Biography', 'Philosophy', 'Poetry', 'Economics', 'History', 'Self-help', 'Science']), column('Status', 'status', ['To read', 'Reading', 'Done']), column('Rating', 'rating')]
    : [column('Name', 'title'), column('Status', 'status', ['Not started', 'In progress', 'Done'])];
  const group = columns.find((c) => c.kind === 'status' || c.kind === 'select')?.id;
  return { columns, rows: [], view: 'table', groupBy: group, chartBy: group };
}

function inlineMarkdown(block: FolioBlock): string {
  const marks = (block.marks ?? []).filter((m) => m.length > 0 && m.start + m.length <= block.text.length);
  if (!marks.length) return block.text;
  const cuts = [...new Set([0, block.text.length, ...marks.flatMap((m) => [m.start, m.start + m.length])])].sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i], end = cuts[i + 1];
    let part = block.text.slice(start, end);
    for (const mark of marks.filter((m) => m.start <= start && m.start + m.length >= end)) {
      if (mark.style === 'bold') part = `**${part}**`;
      else if (mark.style === 'italic') part = `*${part}*`;
      else if (mark.style === 'strike') part = `~~${part}~~`;
      else if (mark.style === 'code') part = `\`${part}\``;
      else if (mark.style === 'link' && mark.value) part = `[${part}](${mark.value})`;
    }
    out += part;
  }
  return out;
}

export function noteToMarkdown(note: FolioNote, plain = false): string {
  const body = note.blocks.map((b) => {
    if (plain) return b.kind === 'divider' ? '────────' : b.kind === 'task' ? `[${b.checked ? 'x' : ' '}] ${b.text}` : b.text;
    const t = inlineMarkdown(b);
    const heading = /eading([1-4])$/.exec(b.kind)?.[1];
    if (heading) return `${'#'.repeat(Number(heading))} ${b.kind.startsWith('toggle') ? '▸ ' : ''}${t}`;
    switch (b.kind) {
      case 'bullet': return `- ${t}`;
      case 'numbered': return `1. ${t}`;
      case 'task': return `- [${b.checked ? 'x' : ' '}] ${t}`;
      case 'quote': case 'callout': return t.split('\n').map((line) => `> ${line}`).join('\n');
      case 'code': return `\`\`\`\n${t}\n\`\`\``;
      case 'equation': return `$$\n${t}\n$$`;
      case 'divider': return '---';
      default: return t;
    }
  }).join('\n\n');
  const grid = note.table;
  const rows = grid ? '\n\n' + [
    '| ' + grid.columns.map((c) => c.name).join(' | ') + ' |',
    '| ' + grid.columns.map(() => '---').join(' | ') + ' |',
    ...grid.rows.map((row) => '| ' + grid.columns.map((c) => (row.values[c.id] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |'),
  ].join('\n') : '';
  return plain ? `${note.title}\n\n${body}${rows}` : `# ${note.title || 'Untitled'}\n\n${body}${rows}`;
}

const headingKinds: readonly FolioBlock['kind'][] = ['heading1', 'heading2', 'heading3', 'heading4'];

/** Imports plain Markdown as a new page, one block per paragraph or list line. */
export function markdownToNote(markdown: string, fallbackTitle: string, now: number): FolioNote {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = fallbackTitle;
  const first = lines[0] ?? '';
  if (first.startsWith('# ')) { title = first.slice(2).trim(); lines.shift(); }
  const blocks: FolioBlock[] = [];
  let paragraph: string[] = [];
  const push = (text: string, kind: FolioBlock['kind'] = 'text', checked = false) => blocks.push({ ...makeBlock(), kind, text, checked });
  const flush = () => { if (paragraph.length) { push(paragraph.join('\n')); paragraph = []; } };
  for (const line of lines) {
    const heading = /^(#{1,4}) (.*)$/.exec(line);
    const task = /^- \[( |x)\] (.*)$/i.exec(line);
    if (!line.trim()) flush();
    else if (heading) { flush(); push(heading[2], headingKinds[heading[1].length - 1] ?? 'heading4'); }
    else if (task) { flush(); push(task[2], 'task', task[1].toLowerCase() === 'x'); }
    else if (/^[-*+] /.test(line)) { flush(); push(line.slice(2), 'bullet'); }
    else if (/^\d+\. /.test(line)) { flush(); push(line.replace(/^\d+\. /, ''), 'numbered'); }
    else if (/^> /.test(line)) { flush(); push(line.slice(2), 'quote'); }
    else if (line.trim() === '---') { flush(); push('', 'divider'); }
    else paragraph.push(line);
  }
  flush();
  return { id: newID(), title, icon: '', blocks: blocks.length ? blocks : [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now };
}

/** Native Folio (Swift) writes dates as seconds since 2001; the phone uses milliseconds since 1970. */
function normalizeDate(value: number): number {
  if (value > 1e11) return value;
  if (value > 1e9 * 1.5) return value * 1000;
  return (value + 978_307_200) * 1000;
}

export function parseBackup(text: string): FolioNote[] {
  const data: unknown = JSON.parse(text);
  const list: unknown[] = Array.isArray(data) ? data : noteListSchema.parse(data).notes;
  const notes: FolioNote[] = [];
  for (const item of list) {
    const parsed = noteSchema.safeParse(item);
    if (parsed.success) notes.push({ ...parsed.data, created: normalizeDate(parsed.data.created), modified: normalizeDate(parsed.data.modified) });
  }
  return notes;
}
const noteListSchema = z.object({ notes: z.array(z.unknown()) });

export function createLocalFolioEngine({ storage, host, onChange, now = () => Date.now() }: { storage: FolioStorage; host: FolioHost; onChange?: () => void; now?: () => number }): LocalEngine {
  const status = freshStatus();
  let notes: FolioNote[] = [];
  let selectedID: string | undefined;
  const snapshot = (): FolioStatus => ({ ...status, notes: notes.slice(), selectedID });
  const changed = () => onChange?.();
  const stamp = (previous = 0) => Math.max(now(), previous + 1);

  const ready = (async () => {
    notes = await storage.loadNotes();
    selectedID = await storage.loadSelected();
    if (!notes.length) { const first = welcomeNote(now()); notes = [first]; await storage.saveNote(first); }
    if (!selectedID || !notes.some((n) => n.id === selectedID)) selectedID = notes.filter((n) => !n.trashed).sort((a, b) => b.modified - a.modified)[0]?.id;
  })();

  const find = (id?: string) => notes.find((n) => n.id === (id ?? selectedID));
  const selected = (id?: string) => { const note = find(id); if (!note) throw new Error('Choose a Folio page first'); return note; };
  const store = async (note: FolioNote) => {
    const index = notes.findIndex((n) => n.id === note.id);
    if (index >= 0) notes[index] = note; else notes.unshift(note);
    await storage.saveNote(note);
  };
  const select = async (id: string | undefined) => { selectedID = id; await storage.saveSelected(id); };
  const create = async (fields: Partial<FolioNote>) => {
    const time = now();
    const note: FolioNote = { id: newID(), title: '', icon: '', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: time, modified: time, ...fields };
    await store(note); await select(note.id); return note;
  };
  const addNotes = async (incoming: FolioNote[]) => {
    for (const note of incoming) {
      const existing = find(note.id);
      if (!existing || existing.modified < note.modified) await store(note);
    }
  };
  const importFiles = async (files: File[]) => {
    let count = 0;
    for (const file of files) {
      const text = await file.text();
      if (/\.json$/i.test(file.name)) { const list = parseBackup(text); await addNotes(list); count += list.length; }
      else { const note = markdownToNote(text, file.name.replace(/\.(md|markdown|txt)$/i, ''), now()); await store(note); await select(note.id); count += 1; }
    }
    status.status = `Imported ${count} page${count === 1 ? '' : 's'}`;
  };
  const backup = () => JSON.stringify({ app: 'folio', version: 1, exported: now(), notes }, null, 1);
  const backupFile = () => new File([backup()], `Folio backup ${new Date(now()).toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  const exportFile = (note: FolioNote, kind: string): File | undefined => {
    const grid = note.table;
    const name = note.title || 'Untitled';
    if (kind === 'csv') {
      if (!grid) return undefined;
      const cell = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const csv = [grid.columns.map((c) => cell(c.name)).join(','), ...grid.rows.map((r) => grid.columns.map((c) => cell(r.values[c.id] ?? '')).join(','))].join('\n');
      return new File([csv], `${name}.csv`, { type: 'text/csv' });
    }
    const plain = kind === 'txt';
    return new File([noteToMarkdown(note, plain)], `${name}.${plain ? 'txt' : 'md'}`, { type: plain ? 'text/plain' : 'text/markdown' });
  };
  const attach = async (noteID: string, files: File[]) => {
    const note = selected(noteID);
    if (!files.length) return;
    const blocks = [...note.blocks];
    for (const file of files) { const id = newID(); await storage.putAsset(id, file); blocks.push({ ...makeBlock(), kind: 'attachment', text: file.name, asset: assetPrefix + id }); }
    await store({ ...note, blocks, modified: stamp(note.modified) });
  };

  async function handle(input: FolioRequest): Promise<{ text?: string }> {
    await ready;
    switch (input.command) {
      case 'state': case 'clear-error': case 'stop-ai': case 'shutdown': case 'cancel-import': return {};
      case 'select': await select(selected(input.noteID).id); return {};
      case 'create': {
        const parentID = input.parentID && find(input.parentID) ? input.parentID : undefined;
        if (input.kind === 'table' || input.kind === 'library') await create({ title: input.kind === 'library' ? 'Library' : 'Untitled database', icon: input.kind === 'library' ? 'books.vertical' : '', blocks: [], table: table(input.kind), parentID });
        else await create({ title: input.text ?? '', parentID, isMeeting: input.kind === 'meeting' });
        return {};
      }
      case 'save': {
        const incoming = input.note;
        const current = incoming && find(incoming.id);
        if (!incoming || !current) throw new Error('Page was not found');
        if (input.expectedModified !== current.modified) throw new Error('This page changed in another view. Reload the saved page before editing again.');
        const seen = new Set<string>();
        for (let parent = incoming.parentID; parent; parent = find(parent)?.parentID) {
          if (parent === incoming.id || seen.has(parent) || !find(parent)) throw new Error('Invalid page parent');
          seen.add(parent);
        }
        await store({ ...incoming, created: current.created, modified: stamp(current.modified) });
        status.status = 'All changes saved';
        return {};
      }
      case 'trash': { const note = selected(input.noteID); await store({ ...note, trashed: input.flag !== true, modified: stamp(note.modified) }); return {}; }
      case 'duplicate': {
        const note = selected(input.noteID);
        await create({ ...note, id: newID(), title: `${note.title} copy`, blocks: note.blocks.map((b) => ({ ...b, id: newID() })) });
        return {};
      }
      case 'search': {
        const q = (input.text ?? '').toLowerCase();
        return { text: JSON.stringify(notes.filter((n) => !n.trashed && (n.title.toLowerCase().includes(q) || n.blocks.some((b) => b.text.toLowerCase().includes(q)))).map((n) => n.id)) };
      }
      case 'markdown': {
        const note = selected(input.noteID);
        if (note.excludedFromAI && input.flag) throw new Error('This page is excluded from AI');
        return { text: noteToMarkdown(note, input.kind === 'text') };
      }
      case 'export': { const file = exportFile(selected(input.noteID), input.kind ?? 'md'); if (file) await host.share(file); return {}; }
      case 'export-library': await host.share(backupFile()); return {};
      case 'import':
        await importFiles(await host.pickFiles('.json,.md,.markdown,.txt,application/json,text/markdown,text/plain', true));
        return {};
      case 'attach': await attach(selected(input.noteID).id, await host.pickFiles('*/*', true)); return {};
      case 'open-attachment': {
        const block = selected(input.noteID).blocks.find((b) => b.id === input.blockID);
        const file = block?.asset?.startsWith(assetPrefix) ? await storage.getAsset(block.asset.slice(assetPrefix.length)) : undefined;
        if (!block || !file) throw new Error('This attachment is stored on your Mac.');
        host.openFile(file, block.text || 'Attachment');
        return {};
      }
      case 'read': {
        const text = input.text?.trim() || noteToMarkdown(selected(input.noteID), true);
        status.speaking = true; status.paused = false;
        host.speak(text, () => { status.speaking = false; status.paused = false; changed(); });
        return {};
      }
      case 'pause-reading': status.paused = !status.paused; host.pauseSpeaking(status.paused); return {};
      case 'stop-reading': host.stopSpeaking(); status.speaking = false; status.paused = false; return {};
      case 'listen': {
        const target = selected(input.noteID).id;
        const started = host.listen(async (words) => {
          const note = find(target); if (!note || !words.trim()) return;
          await store({ ...note, blocks: [...note.blocks, { ...makeBlock(), text: words.trim() }], modified: stamp(note.modified) });
          changed();
        }, () => { status.listening = false; status.dictation = ''; changed(); });
        if (!started) throw new Error('Tap a line and use the microphone key on the iPhone keyboard to dictate.');
        status.listening = true; status.dictation = 'Listening…';
        return {};
      }
      case 'stop-listening': host.stopListening(); status.listening = false; status.dictation = ''; return {};
      case 'append': {
        const note = selected(input.noteID);
        const added = (input.text ?? '').split(/\n{2,}/).filter(Boolean).map((text) => ({ ...makeBlock(), text }));
        await store({ ...note, blocks: input.flag ? added : [...note.blocks, ...added], modified: stamp(note.modified) });
        return {};
      }
      case 'utility':
        if (input.noteID && find(input.noteID)) await select(input.noteID);
        if (!host.utility(input.kind ?? 'settings')) throw new Error('This tool is only on your Mac for now.');
        return {};
      default:
        throw new Error('Recordings, calendar and history are only on your Mac for now.');
    }
  }

  return {
    ready,
    backup,
    importBackup: async (text) => { const list = parseBackup(text); await addNotes(list); changed(); return list.length; },
    changedSince: (time) => notes.filter((n) => n.modified > time),
    attachFiles: async (noteID, files) => { await ready; await attach(noteID, files); changed(); },
    importFiles: async (files) => { await ready; await importFiles(files); changed(); },
    exportFile,
    backupFile,
    mergeRemote: async (incoming, skip) => {
      await ready;
      let count = 0;
      for (const note of incoming) {
        const parsed = noteSchema.safeParse(note);
        if (!parsed.success || skip(parsed.data.id)) continue;
        const existing = find(parsed.data.id);
        if (existing && existing.modified >= parsed.data.modified) continue;
        await store(parsed.data); count += 1;
      }
      if (!selectedID && notes.length) await select(notes[0].id);
      return count;
    },
    request: async (input): Promise<FolioResponse> => {
      try {
        const { text } = await handle(input);
        status.error = undefined;
        return { id: newID(), ok: true, state: snapshot(), text };
      } catch (error) {
        return { id: newID(), ok: false, state: snapshot(), error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function createMemoryStorage(): FolioStorage {
  const notes = new Map<string, FolioNote>();
  const assets = new Map<string, Blob>();
  let selected: string | undefined;
  return {
    loadNotes: async () => [...notes.values()],
    saveNote: async (note) => { notes.set(note.id, note); },
    loadSelected: async () => selected,
    saveSelected: async (id) => { selected = id; },
    putAsset: async (id, file) => { assets.set(id, file); },
    getAsset: async (id) => assets.get(id),
  };
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

/** Notes, attachments and the last open page, kept in the app's own IndexedDB. */
export function createIndexedDBStorage(name = 'folio'): FolioStorage {
  const open = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('notes', { keyPath: 'id' });
      db.createObjectStore('assets');
      db.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = async (store: 'notes' | 'assets' | 'meta', mode: IDBTransactionMode) => (await open).transaction(store, mode).objectStore(store);
  const blobSchema = z.instanceof(Blob);
  const idSchema = z.string().optional();
  return {
    loadNotes: async () => {
      const rows: unknown[] = await promised((await tx('notes', 'readonly')).getAll());
      return rows.flatMap((row) => { const parsed = noteSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
    },
    saveNote: async (note) => { await promised((await tx('notes', 'readwrite')).put(note)); },
    loadSelected: async () => { const value: unknown = await promised((await tx('meta', 'readonly')).get('selectedID')); const parsed = idSchema.safeParse(value); return parsed.success ? parsed.data : undefined; },
    saveSelected: async (id) => { await promised((await tx('meta', 'readwrite')).put(id, 'selectedID')); },
    putAsset: async (id, file) => { await promised((await tx('assets', 'readwrite')).put(file, id)); },
    getAsset: async (id) => { const value: unknown = await promised((await tx('assets', 'readonly')).get(id)); const parsed = blobSchema.safeParse(value); return parsed.success ? parsed.data : undefined; },
  };
}
