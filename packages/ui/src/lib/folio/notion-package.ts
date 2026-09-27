import { makeBlock, type FolioBlock, type FolioNote, type FolioTable, type FolioView } from './schema';
import { attachmentPrefix, importNotionExport, notionUUID, parseInline, type NotionFile } from './notion-import';

/**
 * Builds Folio pages from a full Notion migration package: the Markdown & CSV archives (content and
 * files), the Notion-flavored source of each top page (columns, inline databases, toggles, meeting
 * notes), database configurations (property types, option colors, views) and meeting transcripts.
 *
 * Pure: the caller reads the files, copies attachments and saves the pages. IDs come from Notion's
 * own IDs, so importing again updates the same pages. Text inside the pages is copied as content.
 */

export interface PackageSource { archive: string; markdown: string; supplement?: string; wide?: boolean }
export interface PackageInput { files: readonly NotionFile[]; sources: readonly PackageSource[]; configs: readonly { name: string; text: string }[]; now: number }
export interface PackageResult {
  notes: FolioNote[];
  /** Archive paths of files the pages reference (`notion:<path>` assets). */
  files: string[];
  /** Differences from Notion worth telling the user about. */
  report: string[];
  rows: Record<string, { databases: number; rows: number }>;
}

type Column = FolioTable['columns'][number];
type ColorName = FolioBlock['highlight'];
type Mark = NonNullable<FolioBlock['marks']>[number];

const hexOf = (url: string): string | undefined => /([0-9a-f]{32})(?:[?#]|$)/i.exec(url.replace(/-/g, ''))?.[1]?.toLowerCase();
const colorNames: readonly string[] = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const toColor = (value: string | undefined): ColorName => {
  const base = (value ?? '').replace(/_background$/, '');
  return colorNames.includes(base) ? (base as ColorName) : 'none';
};

// ---- Database configurations (Notion's schema and views, as saved by the export tool).

interface ConfigProperty { name: string; type: string; options?: { name: string; color?: string }[]; groups?: Record<string, { name: string; color?: string }[]> }
interface ConfigView { id: string; json: NotionViewJSON }
interface NotionViewJSON {
  type?: string; name?: string; displayProperties?: string[];
  simpleFilters?: { filter?: { operator?: string; property?: string; value?: { type?: string; value?: unknown } } }[];
  sorts?: { direction?: string; property?: string }[];
  groupBy?: unknown; cover?: { type?: string }; cardSize?: string;
  chartConfig?: { type?: string; chartFormat?: { axisCumulative?: boolean }; dataConfig?: { groupBy?: { property?: string } } };
}
interface DatabaseConfig { file: string; id: string; title: string; inline: boolean; dataSource?: string; schema?: Record<string, ConfigProperty>; views: ConfigView[] }

function parseConfig(file: string, text: string): DatabaseConfig | undefined {
  const id = hexOf(/Source: (\S+)/.exec(text)?.[1] ?? '');
  if (!id) return undefined;
  const title = /The title of this Database is: (.*)/.exec(text)?.[1]?.trim() ?? '';
  const inline = /<database [^>]*inline="true"/.test(text);
  const dataSource = /data-source url="\{?\{?(collection:\/\/[0-9a-f-]+)/.exec(text)?.[1];
  let schema: DatabaseConfig['schema'];
  const state = /<data-source-state>\s*(\{[\s\S]*?\})\s*<\/data-source-state>/.exec(text)?.[1];
  if (state) { try { schema = (JSON.parse(state) as { schema?: Record<string, ConfigProperty> }).schema; } catch { schema = undefined; } }
  const views: ConfigView[] = [];
  for (const match of text.matchAll(/<view url="\{?\{?view:\/\/([0-9a-f-]+)\}?\}?">\s*\n(\{.*\})\s*\n/g)) {
    try { views.push({ id: match[1], json: JSON.parse(match[2]) as NotionViewJSON }); } catch { /* an unreadable view is reported below */ }
  }
  return { file, id, title, inline, dataSource, schema, views };
}

const kindFor = (type: string): Column['kind'] => {
  switch (type) {
    case 'title': return 'title';
    case 'select': return 'select';
    case 'status': return 'status';
    case 'multi_select': return 'multiSelect';
    case 'date': case 'created_time': case 'last_edited_time': return 'date';
    case 'number': return 'number';
    case 'checkbox': return 'checkbox';
    case 'url': return 'url';
    default: return 'text';
  }
};
const statusGroupKey = (value: string) => value.toLowerCase().replace(/[\s-]+/g, '_').replace(/^todo$/, 'to_do');

/** "January 5, 2026 → January 9, 2026" or "2026/01/05" → "2026-01-05" (the start). */
function isoDate(value: string): string {
  const start = value.split('→')[0].trim();
  if (!start) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(start)) return start.slice(0, 10);
  const time = Date.parse(start.replace(/\s+\(.*\)$/, ''));
  if (Number.isNaN(time)) return value;
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Relations export as "Title (https://www.notion.so/...)"; the titles are what people read. */
const relationTitles = (value: string) => value.replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();

function applySchema(table: FolioTable, config: DatabaseConfig, report: string[]): FolioTable {
  const schema = config.schema ?? {};
  const byName = new Map(Object.values(schema).map((p) => [p.name.trim().toLowerCase(), p]));
  const columns = table.columns.map((column): Column => {
    const property = byName.get(column.name.trim().toLowerCase());
    if (!property) return column;
    const kind = kindFor(property.type);
    const options = property.type === 'status'
      ? ['to_do', 'in_progress', 'complete'].flatMap((g) => property.groups?.[g]?.map((o) => o.name) ?? [])
      : property.options?.map((o) => o.name) ?? [];
    const all = property.type === 'status' ? Object.values(property.groups ?? {}).flat() : property.options ?? [];
    const colors = Object.fromEntries(all.map((o) => [o.name, toColor(o.color)]));
    if (['relation', 'formula', 'rollup', 'people', 'files'].includes(property.type)) report.push(`${config.title}: "${column.name}" is a Notion ${property.type} property; its values are kept as text.`);
    return { ...column, kind, options, ...(Object.keys(colors).length ? { colors } : {}) };
  });
  const rows = table.rows.map((row) => ({
    ...row,
    values: Object.fromEntries(columns.map((column) => {
      const raw = row.values[column.id] ?? '';
      const property = byName.get(column.name.trim().toLowerCase());
      if (column.kind === 'date') return [column.id, isoDate(raw)];
      if (column.kind === 'checkbox') return [column.id, /^(yes|true)$/i.test(raw.trim()) ? 'true' : ''];
      if (property?.type === 'relation') return [column.id, relationTitles(raw)];
      return [column.id, raw];
    })),
  }));
  // Columns in the order the main view shows them, then the rest.
  const order = config.views[0]?.json.displayProperties?.map((name) => name.trim().toLowerCase()) ?? [];
  const rank = (c: Column) => { const at = order.indexOf(c.name.trim().toLowerCase()); return c.kind === 'title' ? -1 : at < 0 ? 1000 : at; };
  const ordered = columns.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c);
  return { ...table, columns: ordered, rows };
}

function viewFrom(view: ConfigView, table: FolioTable, config: DatabaseConfig, report: string[]): FolioView {
  const json = view.json;
  const columnID = (name: string | undefined) => table.columns.find((c) => c.name.trim().toLowerCase() === (name ?? '').trim().toLowerCase())?.id;
  const kind: FolioView['kind'] = json.type === 'board' || json.type === 'gallery' || json.type === 'list' || json.type === 'chart' ? json.type : 'table';
  if (json.type && !['table', 'board', 'gallery', 'list', 'chart'].includes(json.type)) report.push(`${config.title}: the "${json.name || json.type}" view was a Notion ${json.type} view; it opens as a table.`);
  const schema = Object.values(config.schema ?? {});
  const filter: NonNullable<FolioView['filter']> = [];
  for (const item of json.simpleFilters ?? []) {
    const f = item.filter;
    const column = columnID(f?.property);
    if (!f?.operator || !column) continue;
    const value = typeof f.value?.value === 'string' ? f.value.value : undefined;
    if (f.value?.type === 'is_group') {
      if (!value) continue; // "any group": no filter
      const property = schema.find((p) => p.name === f.property);
      const group = property?.groups?.[statusGroupKey(value)]?.map((o) => o.name);
      filter.push({ column, op: 'is', values: group ?? [value] });
      continue;
    }
    const op = /does_not_contain/.test(f.operator) ? 'notContains' : /contains/.test(f.operator) ? 'contains' : /is_not_empty/.test(f.operator) ? 'notEmpty' : /is_empty/.test(f.operator) ? 'empty' : /(is_not|does_not_equal)$/.test(f.operator) ? 'isNot' : /(_is|equals)$/.test(f.operator) ? 'is' : undefined;
    if (!op) { report.push(`${config.title}: a "${f.operator}" filter on "${f.property}" could not be recreated.`); continue; }
    filter.push({ column, op, ...(value !== undefined ? { value } : {}) });
  }
  const sort = (json.sorts ?? []).flatMap((s) => { const column = columnID(s.property); return column ? [{ column, ...(s.direction === 'descending' ? { desc: true } : {}) }] : []; });
  const groupName = typeof json.groupBy === 'string' ? json.groupBy : typeof json.groupBy === 'object' && json.groupBy && 'property' in json.groupBy && typeof json.groupBy.property === 'string' ? json.groupBy.property : undefined;
  const columns = json.displayProperties?.flatMap((name) => columnID(name) ?? []);
  const chartX = columnID(json.chartConfig?.dataConfig?.groupBy?.property);
  return {
    id: view.id, name: (json.name ?? '').trim(), kind,
    ...(columns?.length ? { columns } : {}),
    ...(sort.length ? { sort } : {}),
    ...(filter.length ? { filter } : {}),
    ...(groupName && columnID(groupName) ? { groupBy: columnID(groupName) } : {}),
    ...(kind === 'gallery' ? { cover: json.cover?.type && json.cover.type !== 'none' ? 'page' : 'none', cardSize: json.cardSize === 'small' || json.cardSize === 'large' ? json.cardSize : 'medium' } : {}),
    ...(kind === 'chart' ? { chart: { ...(chartX ? { x: chartX } : {}), kind: json.chartConfig?.type === 'line' ? 'line' : 'bar', bucket: 'month', ...(json.chartConfig?.chartFormat?.axisCumulative ? { cumulative: true } : {}) } } : {}),
  };
}

// ---- Notion-flavored Markdown of a top page (from the Notion connector's fetch).

interface Line { depth: number; text: string }
interface Context {
  known: Set<string>;
  databaseFor: (hex: string) => { asset: string; view?: string } | undefined;
  fileFor: (name: string) => string | undefined;
  transcripts: Map<string, string[]>;
  report: string[];
  files: Set<string>;
}

const people: Record<string, string> = { '94193414-9aec-47bd-b918-9dff72b02c30': 'Carter' };
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One line of Notion-flavored text: spans, mentions and links become Folio text and marks. */
function inline(source: string, ctx: Context): { text: string; marks: Mark[] } {
  const cleaned = source
    .replace(/\s*\[\^[^\]]*\]/g, '')
    .replace(/<mention-date start="([^"]+)"[^>]*\/>/g, (_, iso: string) => formatDate(iso.slice(0, 10)))
    .replace(/<mention-user url="user:\/\/([^"]+)"\s*\/>/g, (_, id: string) => `@${people[id] ?? 'teammate'}`)
    .replace(/<mention-page url="([^"]+)"[^>]*>(.*?)<\/mention-page>/g, (_, url: string, title: string) => `[${title || 'page'}](${url})`)
    .replace(/<mention-page url="([^"]+)"\s*\/>/g, (_, url: string) => `[page](${url})`)
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/\\([$>*_[\]#~`|])/g, '$1');
  const resolve = (target: string) => {
    const hex = /notion\.(?:so|com)/.test(target) ? hexOf(target) : undefined;
    if (hex && ctx.known.has(hex)) return `folio://note/${notionUUID(hex)}`;
    return /^(https?|mailto):/i.test(target) ? target : undefined;
  };
  // Colored and underlined spans: parse each piece and mark its range.
  const text: string[] = [];
  const marks: Mark[] = [];
  let length = 0;
  const stack: { color?: string; underline?: boolean }[] = [];
  for (const piece of cleaned.split(/(<span[^>]*>|<\/span>)/)) {
    if (piece.startsWith('<span')) { stack.push({ color: /color="([^"]+)"/.exec(piece)?.[1], underline: /underline="true"/.test(piece) }); continue; }
    if (piece === '</span>') { stack.pop(); continue; }
    if (!piece) continue;
    const parsed = parseInline(piece, resolve);
    for (const m of parsed.marks) marks.push({ ...m, start: m.start + length });
    const style = stack.at(-1);
    if (parsed.text.length && style?.color) {
      const color = toColor(style.color);
      if (color !== 'none') marks.push({ start: length, length: parsed.text.length, style: style.color.endsWith('_background') ? 'highlight' : 'color', value: color });
    }
    if (parsed.text.length && style?.underline) marks.push({ start: length, length: parsed.text.length, style: 'underline' });
    text.push(parsed.text);
    length += parsed.text.length;
  }
  return { text: text.join(''), marks };
}

function lines(markdown: string): Line[] {
  const content = /<content>\n?([\s\S]*?)<\/content>/.exec(markdown)?.[1] ?? '';
  return content.split('\n').map((raw) => { const tabs = /^\t*/.exec(raw)?.[0].length ?? 0; return { depth: tabs, text: raw.slice(tabs).trimEnd() }; });
}

/** The line index of the matching closing tag (same depth), or the end. */
function closing(all: readonly Line[], from: number, tag: string, depth: number): number {
  for (let i = from + 1; i < all.length; i += 1) if (all[i].text.startsWith(`</${tag}`) && all[i].depth <= depth) return i;
  return all.length;
}

function parseLines(all: readonly Line[], start: number, end: number, base: number, ctx: Context): FolioBlock[] {
  const out: FolioBlock[] = [];
  const push = (kind: FolioBlock['kind'], source: string, indent: number, extra: Partial<FolioBlock> = {}) => {
    const { text, marks } = inline(source, ctx);
    out.push({ ...makeBlock(), kind, text, marks: marks.length ? marks : undefined, indent: indent > 0 ? Math.min(indent, 8) : undefined, ...extra });
  };
  for (let i = start; i < Math.min(end, all.length); i += 1) {
    const { depth, text } = all[i];
    const indent = Math.max(0, depth - base);
    if (!text || text === '<empty-block/>') continue;

    if (text === '<columns>') {
      const stop = closing(all, i, 'columns', depth);
      const row = crypto.randomUUID().slice(0, 12);
      let column = 0;
      for (let j = i + 1; j < stop; j += 1) {
        if (!all[j].text.startsWith('<column')) continue;
        const ratio = Number(/ratio="([\d.]+)"/.exec(all[j].text)?.[1]);
        const colEnd = closing(all, j, 'column', all[j].depth);
        const inner = parseLines(all, j + 1, colEnd, all[j].depth + 1, ctx);
        const blocks = inner.length ? inner : [makeBlock()];
        blocks.forEach((b, k) => { b.row = row; b.column = column; if (k === 0 && ratio > 0 && ratio < 100) b.width = Math.min(0.95, Math.max(0.05, ratio / 100)); });
        out.push(...blocks);
        column += 1;
        j = colEnd;
      }
      i = stop;
      continue;
    }
    if (text === '<details>') {
      const stop = closing(all, i, 'details', depth);
      const summary = /<summary>(.*)<\/summary>/.exec(all[i + 1]?.text ?? '')?.[1] ?? '';
      push('toggle', summary, indent);
      for (const child of parseLines(all, i + 2, stop, depth + 1, ctx)) out.push({ ...child, indent: Math.min(8, (child.indent ?? 0) + indent + 1) });
      i = stop;
      continue;
    }
    if (text.startsWith('<table')) {
      const stop = closing(all, i, 'table', 99);
      const rows: string[][] = [];
      const raw: string[][] = [];
      let current: string[] | undefined, currentRaw: string[] = [];
      for (let j = i + 1; j < stop; j += 1) {
        const t = all[j].text;
        if (t.startsWith('<tr')) { current = []; currentRaw = []; }
        else if (t.startsWith('</tr')) { if (current) { rows.push(current); raw.push(currentRaw); } current = undefined; }
        else if (t.startsWith('<td') && current) {
          const cell = t.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '');
          currentRaw.push(cell);
          current.push(inline(cell, ctx).text.replace(/[\t\n]/g, ' ').trim());
        }
      }
      // A header row: marked so, or a first row written in bold or underline.
      const header = /header-row="true"/.test(text) || (raw[0] ?? []).some((cell) => /\*\*|underline="true"/.test(cell));
      if (rows.length) out.push({ ...makeBlock(), kind: 'table', text: rows.map((r) => r.join('\t')).join('\n'), checked: header, indent: indent || undefined });
      i = stop;
      continue;
    }
    if (text.startsWith('<meeting-notes')) {
      const stop = closing(all, i, 'meeting-notes', depth);
      const title = all[i + 1]?.text ?? 'Meeting';
      const date = /<mention-date start="([^"]+)"/.exec(title)?.[1]?.slice(0, 10) ?? '';
      push('toggleHeading3', `📝 ${title}`, indent, { checked: true });
      const section = (tag: string) => {
        const at = all.findIndex((l, k) => k > i && k < stop && l.text === `<${tag}>`);
        if (at < 0) return [] as FolioBlock[];
        const close = closing(all, at, tag, all[at].depth);
        return parseLines(all, at + 1, close, all[at].depth + 1, ctx);
      };
      const nest = (blocks: FolioBlock[], by: number) => blocks.map((b) => ({ ...b, indent: Math.min(8, (b.indent ?? 0) + indent + by) }));
      const summary = section('summary'), notes = section('notes');
      if (summary.length) { out.push({ ...makeBlock(), kind: 'heading4', text: 'Summary', indent: indent + 1 }); out.push(...nest(summary, 1)); }
      const transcriptKey = `${date}|${inline(title, ctx).text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
      const supplement = ctx.transcripts.get(transcriptKey);
      const ownNotes = notes.filter((b) => b.text.trim());
      if (ownNotes.length) { out.push({ ...makeBlock(), kind: 'heading4', text: 'Notes', indent: indent + 1 }); out.push(...nest(notes, 1)); }
      if (supplement?.length) {
        out.push({ ...makeBlock(), kind: 'toggle', text: 'Transcript', checked: true, indent: indent + 1 });
        for (const line of supplement) out.push({ ...makeBlock(), text: line, indent: Math.min(8, indent + 2) });
        ctx.transcripts.delete(transcriptKey);
      }
      i = stop;
      continue;
    }
    const database = /^<database url="([^"]+)"[^>]*>(.*?)<\/database>?$/.exec(text);
    if (database) {
      const target = ctx.databaseFor(hexOf(database[1]) ?? '');
      if (target) out.push({ ...makeBlock(), kind: 'database', asset: target.asset, text: target.view ?? '', indent: indent || undefined });
      else push('text', `Database: ${database[2]} (not in the export)`, indent);
      continue;
    }
    const page = /^<page url="([^"]+)"[^>]*>(.*?)<\/page>$/.exec(text);
    if (page) {
      const hex = hexOf(page[1]);
      if (hex && ctx.known.has(hex)) out.push({ ...makeBlock(), kind: 'page', asset: notionUUID(hex), indent: indent || undefined });
      else push('text', page[2], indent);
      continue;
    }
    if (text.startsWith('<unknown') && /alt="button"/.test(text)) { out.push({ ...makeBlock(), kind: 'button', text: '', indent: indent || undefined }); continue; }
    const file = /^<file src="file:\/\/([^"]+)"/.exec(text);
    const image = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(text);
    if (file || image) {
      const name = file ? /attachment:[0-9a-f-]+:([^"]+?)"/.exec(decodeURIComponent(file[1]))?.[1] ?? '' : decodeURIComponent((image?.[2] ?? '').split('?')[0].split('/').pop() ?? '');
      const path = name ? ctx.fileFor(name) : undefined;
      if (path) { ctx.files.add(path); out.push({ ...makeBlock(), kind: 'attachment', text: name, asset: `${attachmentPrefix}${path}`, indent: indent || undefined }); }
      else { ctx.report.push(`A file (${name || 'image'}) on a top page was not in the export.`); push('text', `(${name || 'image'} not included in the export)`, indent); }
      continue;
    }
    if (/^<\/?(notes|summary|transcript|column|columns|details|content)>$/.test(text) || text.startsWith('<colgroup') || text.startsWith('<col')) continue;
    if (/^\$`?\\color\{[^}]*\}\\rule/.test(text) || /^(-{3,}|\*{3,})$/.test(text)) { out.push({ ...makeBlock(), kind: 'divider', highlight: toColor(/color\{(\w+)\}/.exec(text)?.[1]?.replace('skyblue', 'blue')), indent: indent || undefined }); continue; }
    const heading = /^(#{1,4}) (.*)$/.exec(text);
    if (heading) { push((['heading1', 'heading2', 'heading3', 'heading4'] as const)[heading[1].length - 1], heading[2], indent); continue; }
    const task = /^[-*] \[( |x)\]\s?(.*)$/.exec(text);
    if (task) { push('task', task[2], indent, { checked: task[1] === 'x' }); continue; }
    const bullet = /^[-*] (.*)$/.exec(text);
    if (bullet) { push('bullet', bullet[1], indent); continue; }
    const numbered = /^\d+[.)] (.*)$/.exec(text);
    if (numbered) { push('numbered', numbered[1], indent); continue; }
    if (text.startsWith('> ')) { push('quote', text.slice(2), indent); continue; }
    push('text', text, indent);
  }
  return out;
}

/** Transcripts from a supplement file, keyed by meeting date and title. */
function transcriptsFrom(supplement: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!supplement) return out;
  for (const block of supplement.split(/<meeting-notes[^>]*>/).slice(1)) {
    const firstLine = block.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const date = /<mention-date start="([^"]+)"/.exec(firstLine)?.[1]?.slice(0, 10) ?? '';
    const title = firstLine.replace(/\s*<mention-date[^>]*\/>/, '').replace(/\*\*/g, '').trim().toLowerCase();
    const transcript = /<transcript>\n([\s\S]*?)\n\s*<\/transcript>/.exec(block)?.[1];
    if (!transcript) continue;
    const text = transcript.split('\n').map((l) => l.trim()).filter((l) => l && !/^Transcript omitted/.test(l));
    if (text.length) out.set(`${date}|${title} ${formatDate(date).toLowerCase()}`.replace(/\s+/g, ' ').trim(), text);
  }
  return out;
}

// ---- The package.

const titleOf = (note: FolioNote) => note.title.trim().toLowerCase();

export function importNotionPackage(input: PackageInput): PackageResult {
  const report: string[] = [];
  const base = importNotionExport(input.files, input.now);
  if (base.removedSecrets) report.push(`${base.removedSecrets} value(s) that looked like API keys were replaced with "[removed secret]".`);
  let notes = base.notes;
  const byID = () => new Map(notes.map((n) => [n.id, n]));
  const configs = input.configs.flatMap((c) => parseConfig(c.name, c.text) ?? []);
  const known = new Set(notes.map((n) => n.id));
  const hexToID = (hex: string) => notionUUID(hex);

  // Databases: schemas, option colors and views; linked views join the database they show.
  const baseConfigs = configs.filter((c) => !/^View of /i.test(c.title));
  const linkedViews = new Map<string, { asset: string; view?: string }>();
  for (const config of baseConfigs) {
    const note = notes.find((n) => n.id === hexToID(config.id));
    if (!note) {
      if (config.schema) {
        // A database Notion exported no CSV for (it has no rows): recreated from its schema.
        const columns: Column[] = Object.values(config.schema).map((p, i) => ({ id: `c${i}`, name: p.name, kind: kindFor(p.type), options: p.options?.map((o) => o.name) ?? [] }));
        const table = applySchema({ columns: columns.sort((a, b) => (a.kind === 'title' ? -1 : b.kind === 'title' ? 1 : 0)), rows: [], view: 'table' }, config, report);
        notes.push({ id: hexToID(config.id), title: config.title.trim(), icon: 'icon:table-2', blocks: [makeBlock()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: input.now, modified: input.now, table: { ...table, views: config.views.map((v) => viewFrom(v, table, config, report)) } });
        known.add(hexToID(config.id));
        report.push(`${config.title} had no rows in Notion; it was recreated empty from its schema.`);
      }
      continue;
    }
    if (!note.table) continue;
    const table = applySchema(note.table, config, report);
    const views = config.views.map((v) => viewFrom(v, table, config, report));
    note.table = { ...table, ...(views.length ? { views, activeView: views[0].id } : {}) };
    if (config.title) note.title = config.title.trim();
  }
  for (const config of configs.filter((c) => /^View of /i.test(c.title))) {
    const target = baseConfigs.find((b) => b.dataSource && b.dataSource === config.dataSource) ?? baseConfigs.find((b) => b.title.toLowerCase() === config.title.replace(/^View of /i, '').trim().toLowerCase());
    const note = target ? notes.find((n) => n.id === hexToID(target.id)) : undefined;
    if (!target || !note?.table) { report.push(`The linked view "${config.title}" points to a database that is not in the export.`); continue; }
    // Linked views show inside other pages; they are not tabs of the database itself.
    const views = config.views.map((v) => ({ ...viewFrom(v, note.table as FolioTable, target, report), linked: true }));
    note.table = { ...note.table, views: [...(note.table.views ?? []), ...views.filter((v) => !(note.table?.views ?? []).some((x) => x.id === v.id))] };
    linkedViews.set(config.id, { asset: note.id, view: views[0]?.id });
  }
  // A linked view's own CSV repeats its database's rows: its page goes, and links to it show the database.
  const linkedIDs = new Map([...linkedViews].map(([hex, target]) => [hexToID(hex), target]));
  notes = notes.filter((n) => !linkedIDs.has(n.id));
  const inlineIDs = new Set(configs.filter((c) => c.inline).map((c) => hexToID(c.id)));
  const tables = byID();
  for (const note of notes) {
    note.blocks = note.blocks.map((b) => {
      if (b.kind !== 'page' || !b.asset) return b;
      const linked = linkedIDs.get(b.asset);
      if (linked) return { ...b, kind: 'database', asset: linked.asset, text: linked.view ?? '' };
      if (tables.get(b.asset)?.table && inlineIDs.has(b.asset)) return { ...b, kind: 'database', text: '' };
      return b;
    });
  }

  // Row pages: a row's page is kept (and linked from the row) only when it has content of its own.
  let dropped = 0;
  const drop = new Set<string>();
  for (const database of notes.filter((n) => n.table)) {
    const table = database.table as FolioTable;
    const title = table.columns.find((c) => c.kind === 'title') ?? table.columns[0];
    const children = notes.filter((n) => n.parentID === database.id && !n.table);
    const names = new Map(table.columns.map((c) => [c.name.trim().toLowerCase(), c]));
    // The property lines under a row page's title repeat its row ("Teacher: Honer").
    const propertyCount = (page: FolioNote) => {
      let first = 0;
      while (first < page.blocks.length && (() => { const b = page.blocks[first]; const at = b.text.indexOf(': '); return b.kind === 'text' && at > 0 && names.has(b.text.slice(0, at).trim().toLowerCase()); })()) first += 1;
      return first;
    };
    const flat = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const titleKey = (value: string) => { const v = flat(value); return v === 'untitled' ? '' : v; };
    // Pages match rows by title and, when titles repeat, by the property values they list.
    const signature = (title: string, props: Array<[string, string]>) => `${titleKey(title)}|${props.filter(([, v]) => v && v.length < 120 && !v.includes('\n')).map(([k, v]) => `${k}=${flat(v)}`).sort().slice(0, 4).join('&')}`;
    const pageProps = (page: FolioNote) => page.blocks.slice(0, propertyCount(page)).map((b): [string, string] => { const at = b.text.indexOf(': '); const column = names.get(b.text.slice(0, at).trim().toLowerCase()); return [column?.id ?? '', b.text.slice(at + 2)]; });
    const byTitle = new Map<string, FolioNote[]>(), bySignature = new Map<string, FolioNote[]>();
    for (const child of children) {
      const add = (map: Map<string, FolioNote[]>, key: string) => { const list = map.get(key); if (list) list.push(child); else map.set(key, [child]); };
      add(byTitle, titleKey(child.title));
      add(bySignature, signature(child.title, pageProps(child)));
    }
    const taken = new Set<string>();
    const take = (list: FolioNote[] | undefined) => { const page = list?.find((p) => !taken.has(p.id)); if (page) taken.add(page.id); return page; };
    const rows = table.rows.map((row) => {
      const rowTitle = row.values[title?.id ?? ''] ?? '';
      const rowProps = table.columns.filter((c) => c.id !== title?.id).map((c): [string, string] => [c.id, row.values[c.id] ?? '']);
      const candidates = bySignature.get(signature(rowTitle, rowProps));
      const page = take(candidates) ?? take(byTitle.get(titleKey(rowTitle)));
      if (!page) return row;
      const body = page.blocks.slice(propertyCount(page));
      const content = body.filter((b) => b.text.trim() || b.kind === 'attachment' || b.kind === 'page' || b.kind === 'database' || b.kind === 'table');
      const bodyText = flat(content.map((b) => b.text).join(' ')).slice(0, 300);
      const repeatsCell = bodyText.length > 0 && Object.values(row.values).some((v) => flat(v).includes(bodyText.slice(0, 200)));
      const hasChildren = notes.some((n) => n.parentID === page.id);
      if ((!content.length || (repeatsCell && !content.some((b) => b.kind === 'attachment'))) && !hasChildren) { drop.add(page.id); dropped += 1; return row; }
      page.blocks = body.length ? body : [makeBlock()];
      return { ...row, page: page.id };
    });
    database.table = { ...table, rows };
    // Row pages no row claimed: kept only when they hold something of their own.
    for (const page of children.filter((c) => !taken.has(c.id))) {
      const content = page.blocks.slice(propertyCount(page)).filter((b) => b.text.trim() || b.kind === 'attachment' || b.kind === 'page' || b.kind === 'table');
      if (!content.length && !notes.some((n) => n.parentID === page.id)) { drop.add(page.id); dropped += 1; }
    }
  }
  notes = notes.filter((n) => !drop.has(n.id));
  if (dropped) report.push(`${dropped} database row pages held only the row's own values (or text already in a cell), so they were not made into separate pages; every value is in its database row.`);

  // Top pages from their Notion-flavored source: columns, inline databases, toggles, meeting notes.
  const allFiles = new Set(input.files.map((f) => f.path));
  const files = new Set(base.attachments.map((a) => a.file));
  // Folio IDs set Notion's version digits, so links in the source are matched by their original hex.
  const hexByID = new Map([...allHexes(input.files), ...configs.map((c) => c.id)].map((hex) => [hexToID(hex), hex]));
  for (const source of input.sources) {
    const rootHex = hexOf(/<page url="([^"]+)"/.exec(source.markdown)?.[1] ?? '');
    const root = rootHex ? notes.find((n) => n.id === hexToID(rootHex)) : undefined;
    if (!root || !rootHex) { report.push(`The top page in ${source.archive} was not found in its archive.`); continue; }
    const folder = input.files.find((f) => f.path.startsWith(`${source.archive}/`) && f.path.endsWith(`${rootHex}.md`))?.path.replace(/ [0-9a-f]{32}\.md$/i, '') ?? '';
    const ctx: Context = {
      known: new Set(notes.flatMap((n) => { const hex = hexByID.get(n.id); return hex ? [hex] : []; })),
      databaseFor: (hex) => linkedViews.get(hex) ?? (notes.some((n) => n.id === hexToID(hex) && n.table) ? { asset: hexToID(hex) } : undefined),
      fileFor: (name) => { const path = `${folder}/${name}`; return allFiles.has(path) ? path : undefined; },
      transcripts: transcriptsFrom(source.supplement),
      report, files,
    };
    const blocks = parseLines(lines(source.markdown), 0, Infinity, 0, ctx);
    const emoji = /<iconMetadata>\{"type":"emoji","emoji":"([^"]+)"/.exec(source.markdown)?.[1];
    // A button's target: the database its label names ("Create A New Assignment" → Assignments & Projects).
    for (const block of blocks.filter((b) => b.kind === 'button')) {
      const assignments = notes.find((n) => n.table && /assignment/i.test(n.title));
      block.text = 'Create A New Assignment';
      if (assignments) block.asset = assignments.id;
    }
    root.blocks = blocks.length ? blocks : [makeBlock()];
    // A database shown on the top page with no page of its own lives under it.
    for (const block of blocks) { const target = block.kind === 'database' && block.asset ? notes.find((n) => n.id === block.asset) : undefined; if (target && !target.parentID) target.parentID = root.id; }
    if (emoji) root.icon = emoji;
    if (source.wide) root.wide = true;
    const leftover = [...ctx.transcripts.keys()];
    if (leftover.length) report.push(`${leftover.length} meeting transcript(s) in ${source.archive} did not match a meeting on the page.`);
    // Files in the top page's folder that the source never showed still belong to it.
    for (const path of allFiles) {
      if (!path.startsWith(`${folder}/`) || path.slice(folder.length + 1).includes('/') || /\.(md|csv)$/i.test(path) || root.blocks.some((b) => b.asset === `${attachmentPrefix}${path}`)) continue;
      root.blocks.push({ ...makeBlock(), kind: 'attachment', text: path.split('/').pop() ?? '', asset: `${attachmentPrefix}${path}` });
      files.add(path);
    }
  }

  // Record IDs so later updates can be reconciled, and keep sensitive record sets away from the AI.
  for (const note of notes) {
    if (note.table?.columns.some((c) => /^(ssn|social security|birthdate|dob)$/i.test(c.name.trim()))) {
      note.excludedFromAI = true;
      report.push(`"${note.title}" has SSN or birthdate columns, so it is excluded from AI (change it in the page menu).`);
    }
  }

  const rows: PackageResult['rows'] = {};
  for (const note of notes.filter((n) => n.table)) {
    const hex = hexByID.get(note.id);
    const archive = (hex ? input.files.find((f) => f.path.includes(hex))?.path.split('/')[0] : undefined) ?? input.configs.find((c) => hex && c.text.includes(hex))?.name ?? '';
    const entry = rows[archive] ?? { databases: 0, rows: 0 };
    entry.databases += 1; entry.rows += note.table?.rows.length ?? 0;
    rows[archive] = entry;
  }
  const referenced = new Set(notes.flatMap((n) => n.blocks.flatMap((b) => (b.asset?.startsWith(attachmentPrefix) ? [b.asset.slice(attachmentPrefix.length)] : []))));
  return { notes, files: [...files].filter((f) => referenced.has(f)), report: [...new Set(report)], rows };
}

function allHexes(files: readonly NotionFile[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) for (const match of file.path.matchAll(/([0-9a-f]{32})/gi)) out.add(match[1].toLowerCase());
  return out;
}
