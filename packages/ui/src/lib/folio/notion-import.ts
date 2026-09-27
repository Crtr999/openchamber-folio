import { makeBlock, type FolioBlock, type FolioNote, type FolioTable } from './schema';

/**
 * Turns a Notion "Markdown & CSV" export into Folio pages. Pure: the caller reads the files and,
 * for attachments, uploads the bytes and swaps each `notion:<path>` asset for the stored copy.
 *
 * Mapping: every .md is a page, every database .csv is a table page, and a page's sub-folder
 * holds its children, so the Notion tree becomes the Folio tree. Links between pages become
 * Folio page links, images and files become attachments, nested lists keep their depth.
 * IDs come from Notion's own IDs, so importing the same export again updates the same pages.
 */

export interface NotionFile { path: string; text?: string }
export interface NotionImport { notes: FolioNote[]; attachments: { notePath: string; file: string }[]; removedSecrets: number }

type Mark = NonNullable<FolioBlock['marks']>[number];
export interface InlineText { text: string; marks: Mark[] }
interface ParsedPage { title: string; blocks: FolioBlock[] }
type Kind = FolioBlock['kind'];

const headingKinds: readonly Kind[] = ['heading1', 'heading2', 'heading3', 'heading4'];
const namePattern = /^(.*) ([0-9a-f]{32})(_all)?\.(md|csv)$/i;
const secretPattern = /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;
export const attachmentPrefix = 'notion:';

/** Notion IDs are 32 hex digits; Folio wants RFC 4122 UUIDs, so version and variant digits are set. */
export function notionUUID(hex: string): string {
  const h = hex.toLowerCase();
  const v = `${h.slice(0, 12)}4${h.slice(13, 16)}${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`.toUpperCase();
}

const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
function join(dir: string, relative: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const piece of relative.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}
function decode(target: string): string { try { return decodeURIComponent(target); } catch { return target; } }

/** Parses one CSV file (quoted fields may hold commas and line breaks). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

/** Markdown inline formatting to plain text plus Folio marks. */
export function parseInline(source: string, resolveLink: (target: string) => string | undefined): InlineText {
  let text = '';
  const marks: Mark[] = [];
  const styles: [RegExp, Mark['style']][] = [[/^\*\*([^*]+?)\*\*/, 'bold'], [/^__([^_]+?)__/, 'bold'], [/^~~([^~]+?)~~/, 'strike'], [/^`([^`]+?)`/, 'code'], [/^\*([^*\s][^*]*?)\*/, 'italic'], [/^_([^_\s][^_]*?)_(?![A-Za-z0-9])/, 'italic']];
  let i = 0;
  outer: while (i < source.length) {
    const rest = source.slice(i);
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const inner = parseInline(link[1] || link[2], resolveLink);
      const start = text.length;
      for (const m of inner.marks) marks.push({ ...m, start: m.start + start });
      text += inner.text;
      const href = resolveLink(link[2]);
      if (href && inner.text) marks.push({ start, length: inner.text.length, style: 'link', value: href });
      i += link[0].length;
      continue;
    }
    for (const [pattern, style] of styles) {
      const found = pattern.exec(rest);
      if (found && (style !== 'italic' || !/[A-Za-z0-9]/.test(text.slice(-1)))) {
        const inner = parseInline(found[1], resolveLink);
        const start = text.length;
        for (const m of inner.marks) marks.push({ ...m, start: m.start + start });
        text += inner.text;
        if (inner.text) marks.push({ start, length: inner.text.length, style });
        i += found[0].length;
        continue outer;
      }
    }
    const html = /^<\/?(?:u|span|mark|br)[^>]*>/i.exec(rest);
    if (html) { i += html[0].length; continue; }
    text += source[i];
    i += 1;
  }
  return { text, marks };
}

interface Entry { path: string; name: string; id: string; kind: 'page' | 'table'; container: string; text: string }

export function importNotionExport(files: readonly NotionFile[], now: number): NotionImport {
  let removedSecrets = 0;
  const scrub = (value: string) => value.replace(secretPattern, () => { removedSecrets += 1; return '[removed secret]'; });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const entries: Entry[] = [];
  for (const file of files) {
    const match = namePattern.exec(basename(file.path));
    if (!match || file.text === undefined) continue;
    const [, name, hex, all, ext] = match;
    if (ext.toLowerCase() === 'csv' && !all && byPath.has(file.path.replace(/\.csv$/i, '_all.csv'))) continue; // the _all file has every column
    const dir = dirname(file.path);
    entries.push({ path: file.path, name, id: notionUUID(hex), kind: ext.toLowerCase() === 'csv' ? 'table' : 'page', container: dir ? `${dir}/${name}` : name, text: file.text });
  }
  // A folder holds the children of the page or table with the same name next to it.
  const byContainer = new Map<string, Entry>();
  for (const entry of entries) if (!byContainer.has(entry.container)) byContainer.set(entry.container, entry);
  const byFile = new Map<string, Entry>();
  for (const entry of entries) {
    byFile.set(entry.path, entry);
    if (entry.kind === 'table') byFile.set(entry.path.replace(/_all\.csv$/i, '.csv'), entry);
  }
  const attachments: NotionImport['attachments'] = [];

  const resolver = (fromDir: string) => (target: string) => {
    if (/^(https?|mailto):/i.test(target)) return target;
    const linked = byFile.get(join(fromDir, decode(target)));
    return linked ? `folio://note/${linked.id}` : undefined;
  };

  const notes: FolioNote[] = [];
  for (const entry of entries) {
    const parent = byContainer.get(dirname(entry.path));
    const base: FolioNote = { id: entry.id, title: entry.name, icon: '', parentID: parent?.id, blocks: [], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now };
    if (entry.kind === 'table') {
      notes.push({ ...base, icon: 'icon:table-2', table: tableFrom(parseCSV(scrub(entry.text))) });
      continue;
    }
    const dir = dirname(entry.path);
    const { title, blocks } = blocksFrom(scrub(entry.text), dir, resolver(dir), byFile, (file) => { attachments.push({ notePath: entry.path, file }); });
    notes.push({ ...base, title: title || entry.name, blocks: blocks.length ? blocks : [makeBlock()] });
  }
  // Files in a page's folder that the page never linked still belong to it.
  const linked = new Set(attachments.map((a) => a.file));
  for (const file of files) {
    if (file.text !== undefined || linked.has(file.path) || basename(file.path).startsWith('.')) continue;
    const owner = byContainer.get(dirname(file.path));
    const note = owner && owner.kind === 'page' ? notes.find((n) => n.id === owner.id) : undefined;
    if (!note || !owner) continue;
    note.blocks.push({ ...makeBlock(), kind: 'attachment', text: basename(file.path), asset: `${attachmentPrefix}${file.path}` });
    attachments.push({ notePath: owner.path, file: file.path });
  }
  return { notes, attachments, removedSecrets };
}

function tableFrom(rows: string[][]): FolioTable {
  const [header = ['Name'], ...body] = rows;
  const columns: FolioTable['columns'] = header.map((name, index) => {
    const values = body.map((r) => (r[index] ?? '').trim()).filter(Boolean);
    const distinct = [...new Set(values)];
    let kind: FolioTable['columns'][number]['kind'] = index === 0 ? 'title' : 'text';
    if (index > 0 && values.length) {
      if (values.every((v) => /^-?\$?[\d,]+(\.\d+)?%?$/.test(v))) kind = 'number';
      else if (values.every((v) => !Number.isNaN(Date.parse(v)) && /\d{4}/.test(v) && v.length < 40)) kind = 'date';
      else if (distinct.length <= 8 && distinct.length < values.length && distinct.every((v) => v.length <= 40)) kind = 'select';
    }
    return { id: `c${index}`, name: name.trim() || `Column ${index + 1}`, kind, options: kind === 'select' ? distinct : [] };
  });
  const toDate = (value: string) => { const time = Date.parse(value); return Number.isNaN(time) ? value : new Date(time).toISOString().slice(0, 10); };
  return {
    columns,
    rows: body.map((r, rowIndex) => ({ id: `r${rowIndex}`, values: Object.fromEntries(columns.map((c, i) => [c.id, c.kind === 'date' ? toDate((r[i] ?? '').trim()) : (r[i] ?? '').trim()])) })),
    view: 'table',
  };
}

function blocksFrom(markdown: string, dir: string, resolve: (target: string) => string | undefined, byFile: Map<string, Entry>, attach: (file: string) => void): ParsedPage {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: FolioBlock[] = [];
  let title = '';
  let inProperties = false;
  const push = (kind: Kind, source: string, indent: number, extra: Partial<FolioBlock> = {}) => {
    const { text, marks } = parseInline(source, resolve);
    blocks.push({ ...makeBlock(), kind, text, marks: marks.length ? marks : undefined, indent: indent > 0 ? Math.min(indent, 8) : undefined, ...extra });
  };
  const depthOf = (line: string) => { const lead = /^[ \t]*/.exec(line)?.[0] ?? ''; return Math.floor(lead.replace(/\t/g, '    ').length / 4); };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { inProperties = false; continue; }
    const indent = depthOf(raw);

    if (!title && /^# /.test(line)) { title = line.slice(2).trim(); inProperties = true; continue; }
    // Page properties right under the title: "Teacher: Joseph Honer".
    if (inProperties && /^[^:]{1,40}: /.test(line) && !line.startsWith('-')) {
      const at = line.indexOf(': ');
      const { text } = parseInline(line.slice(at + 2), resolve);
      const key = line.slice(0, at);
      blocks.push({ ...makeBlock(), text: `${key}: ${text}`, marks: [{ start: 0, length: key.length + 1, style: 'bold' }] });
      continue;
    }
    inProperties = false;

    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith('```'); i += 1) body.push(lines[i].replace(/^ {0,8}/, ''));
      blocks.push({ ...makeBlock(), kind: 'code', text: body.join('\n'), indent: indent || undefined });
      continue;
    }
    if (/^<aside>/i.test(line)) {
      const body: string[] = [line.replace(/^<aside>/i, '').replace(/<\/aside>$/i, '').trim()];
      if (!/<\/aside>/i.test(line)) for (i += 1; i < lines.length && !/<\/aside>/i.test(lines[i]); i += 1) body.push(lines[i].trim());
      push('callout', body.filter(Boolean).join('\n'), indent);
      continue;
    }
    if (/^<\/?details>$/i.test(line) || /^<\/aside>$/i.test(line)) continue;
    const summary = /^<summary>(.*)<\/summary>$/i.exec(line);
    if (summary) { push('toggle', summary[1], indent); continue; }
    if (/^\$\\color\{.*\\rule/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) { blocks.push({ ...makeBlock(), kind: 'divider' }); continue; }
    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading) { push(headingKinds[heading[1].length - 1], heading[2], 0); continue; }

    if (line.startsWith('|')) {
      // Notion tables: rows start with "|", a cell may continue on the next lines.
      const rows: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,4} |```)/.test(lines[i + 1].trim())) {
        i += 1;
        if (lines[i].trim().startsWith('|')) rows.push(lines[i].trim()); else rows[rows.length - 1] += `\n${lines[i].trim()}`;
      }
      const cells = rows.filter((r) => !/^\|[\s|:-]+\|?$/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const [head, ...body] = cells;
      if (head && head.length === 2 && !body.length) { push('text', `**${head[0]}**: ${head[1]}`, indent); continue; }
      const table = body.length ? body : [];
      if (head && head.length === 2) {
        for (const row of [head, ...table]) push('text', `**${row[0]}**: ${row.slice(1).join(' ')}`, indent);
      } else {
        if (head) push('text', `**${head.join(' · ')}**`, indent);
        for (const row of table) push('bullet', row.join(' · '), indent);
      }
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
    if (image || (link && !/\.(md|csv)$/i.test(decode(link[2])) && !/^(https?|mailto):/i.test(link[2]))) {
      const target = decode((image ?? link)?.[2] ?? '');
      if (/^https?:/i.test(target)) { push('text', line, indent); continue; }
      const file = join(dir, target);
      const block: FolioBlock = { ...makeBlock(), kind: 'attachment', text: basename(file), asset: `${attachmentPrefix}${file}`, indent: indent || undefined };
      attach(file);
      blocks.push(block);
      continue;
    }
    if (link && /\.(md|csv)$/i.test(decode(link[2]))) {
      const target = byFile.get(join(dir, decode(link[2])));
      if (target) { blocks.push({ ...makeBlock(), kind: 'page', text: '', asset: target.id, indent: indent || undefined }); continue; }
    }

    const task = /^[-*+] \[( |x|X)\] (.*)$/.exec(line);
    if (task) { push('task', task[2], indent, { checked: task[1] !== ' ' }); continue; }
    const bullet = /^[-*+] (.*)$/.exec(line);
    if (bullet) { push('bullet', bullet[1], indent); continue; }
    const numbered = /^\d+[.)] (.*)$/.exec(line);
    if (numbered) { push('numbered', numbered[1], indent); continue; }
    if (line.startsWith('>')) {
      const body = [line.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) { i += 1; body.push(lines[i].trim().replace(/^>\s?/, '')); }
      push('quote', body.join('\n'), indent);
      continue;
    }
    // Text under a list item keeps that item's depth.
    push('text', line, indent);
  }
  return { title, blocks };
}
