// Imports a full Notion → Folio migration package into the running Folio notebook on this Mac.
//
//   bun scripts/folio-import-notion-package.mjs "<Notion to Folio Export folder>" [--dry-run]
//
// The folder holds notion-archives/*.zip (Notion's Markdown & CSV exports), source-pages/*.md (each
// top page's Notion-flavored source and meeting transcripts), and database-configs/ (schemas and
// views). Pages go through the app's encrypted sync route, the same way the iPhone sends pages, so
// the running Folio engine writes them. Attachments are copied first. Pages you edited in Folio
// since an earlier import keep your version. Nothing is sent anywhere but this Mac's Folio.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encrypt } from '../packages/electron/folio-sync.mjs';
import { attachmentPrefix } from '../packages/ui/src/lib/folio/notion-import.ts';
import { importNotionPackage } from '../packages/ui/src/lib/folio/notion-package.ts';

const root = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!root) { console.error('Usage: bun scripts/folio-import-notion-package.mjs "<export folder>" [--dry-run]'); process.exit(1); }

// 1. Unpack each archive privately (ditto keeps Notion's Unicode file names).
const work = mkdtempSync(path.join(os.homedir(), 'Library/Caches/folio-notion-'));
const archives = ['library', 'law-dashboard', 'cbc', 'deed-street-capital'];
const files = [];
try {
  for (const name of archives) {
    const target = path.join(work, name);
    execFileSync('ditto', ['-x', '-k', path.join(root, 'notion-archives', `${name}.zip`), target]);
    const walk = (dir, rel) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === '__MACOSX') continue;
        const full = path.join(dir, entry);
        const relative = `${rel}/${entry}`;
        if (statSync(full).isDirectory()) walk(full, relative);
        else files.push({ path: relative, full, text: /\.(md|csv)$/i.test(entry) ? readFileSync(full, 'utf8') : undefined });
      }
    };
    walk(target, name);
  }
  const source = (file) => { try { return readFileSync(path.join(root, 'source-pages', file), 'utf8'); } catch { return undefined; } };
  const sources = [
    { archive: 'library', markdown: source('library.md'), wide: true },
    { archive: 'law-dashboard', markdown: source('law-dashboard.md'), wide: true },
    { archive: 'cbc', markdown: source('cbc.md'), supplement: source('cbc-meeting-notes-and-transcripts.md'), wide: true },
    { archive: 'deed-street-capital', markdown: source('deed-street-capital.md'), supplement: source('deed-street-capital-meeting-notes-and-transcripts.md') },
  ].filter((s) => s.markdown);
  const configs = [];
  const walkConfigs = (dir) => { for (const entry of readdirSync(dir)) { const full = path.join(dir, entry); if (statSync(full).isDirectory()) walkConfigs(full); else if (entry.endsWith('.md')) configs.push({ name: path.relative(path.join(root, 'database-configs'), full), text: readFileSync(full, 'utf8') }); } };
  walkConfigs(path.join(root, 'database-configs'));

  const started = Date.now();
  const result = importNotionPackage({ files: files.map(({ path: p, text }) => ({ path: p, text })), sources, configs, now: Date.now() });
  console.log(`Built ${result.notes.length} pages (${result.notes.filter((n) => n.table).length} databases) in ${Date.now() - started} ms; ${result.files.length} files to copy.`);
  for (const [archive, count] of Object.entries(result.rows)) console.log(`  ${archive}: ${count.rows} rows in ${count.databases} databases`);

  // 2. The notebook as it is now: pages edited since an earlier import keep the user's version.
  const config = JSON.parse(readFileSync(path.join(os.homedir(), 'Library/Application Support/OpenChamber Folio/folio-sync.json'), 'utf8'));
  const key = Buffer.from(config.key, 'base64url');
  const call = async (value) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/folio-sync`, { method: 'POST', body: encrypt(key, { t: Date.now(), ...value }) });
    if (!response.ok) throw new Error(`Folio answered ${response.status}`);
    return decrypt(key, await response.text());
  };
  const existing = new Map((await call({ op: 'sync', since: 0, notes: [], assistant: [], assistantHashes: {} })).notes.map((n) => [n.id, n]));
  const kept = [];
  const rootIDs = new Set(result.notes.filter((n) => !n.parentID).map((n) => n.id));
  // A page counts as edited in Folio when it holds words the Notion export does not.
  // A row page's own row counts as its text too (its property lines now live in the row).
  const rowValues = new Map(result.notes.flatMap((n) => (n.table?.rows ?? []).flatMap((r) => (r.page ? [[r.page, [...Object.values(r.values), ...n.table.columns.map((c) => c.name)]]] : []))));
  const noise = new Set(['https', 'http', 'www', 'app', 'notion', 'com', 'pvs', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
  const words = (note, extra = []) => new Set(([...(note.blocks ?? []).map((b) => b.text || ''), ...(note.table?.rows ?? []).flatMap((r) => Object.values(r.values)), ...(note.table?.columns ?? []).map((c) => c.name), ...extra].join(' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !noise.has(w) && !/^[0-9a-f]{16,}$/.test(w)));
  for (const [index, note] of result.notes.entries()) {
    const mine = existing.get(note.id);
    if (!mine || mine.trashed) continue;
    if (rootIDs.has(note.id)) { if (mine.title && mine.title !== 'Law Dashboard') note.title = mine.title; if (mine.icon && !note.icon) note.icon = mine.icon; continue; }
    const fresh = words(note, rowValues.get(note.id) ?? []);
    const added = [...words(mine)].filter((w) => !fresh.has(w));
    if (added.length < 3) continue;
    kept.push(mine.title);
    if (dryRun) console.log(`  ${mine.title}: ${added.length} words only in Folio, e.g. ${added.slice(0, 8).join(' ')}; fresh has ${fresh.size}, Folio has ${words(mine).size}; row ${JSON.stringify(rowValues.get(note.id) ?? null).slice(0, 200)}`);
    if (note.table && mine.table) {
      // Rows added in Folio stay; everything else comes from Notion.
      const title = (t) => t.columns.find((c) => c.kind === 'title') ?? t.columns[0];
      const names = new Set(note.table.rows.map((r) => (r.values[title(note.table)?.id] ?? '').trim().toLowerCase()));
      const extra = mine.table.rows.filter((r) => !names.has((r.values[title(mine.table)?.id] ?? '').trim().toLowerCase()));
      result.notes[index] = { ...note, table: { ...note.table, rows: [...note.table.rows, ...extra.map((r) => ({ id: r.id, values: Object.fromEntries(note.table.columns.map((c) => [c.id, r.values[mine.table.columns.find((m) => m.name === c.name)?.id] ?? ''])) }))] } };
    } else result.notes[index] = { ...note, title: mine.title, icon: mine.icon || note.icon, blocks: mine.blocks };
  }
  if (kept.length) console.log(`Kept your Folio edits on ${kept.length} page(s): ${kept.slice(0, 12).join(', ')}${kept.length > 12 ? '…' : ''}`);
  for (const line of result.report) console.log(`• ${line}`);
  if (dryRun) {
    const preview = path.join(os.homedir(), 'Library/Caches/folio-notion-preview.json');
    writeFileSync(preview, JSON.stringify(result.notes.map((n) => ({ id: n.id, title: n.title, parent: n.parentID, blocks: n.blocks.length, kinds: [...new Set(n.blocks.map((b) => b.kind))], rows: n.table?.rows.length, pages: n.table?.rows.filter((r) => r.page).length, views: n.table?.views?.map((v) => `${v.kind}:${v.name}`) })), null, 1));
    console.log(`Dry run: nothing saved. Preview at ${preview}`);
  } else {

  // 3. Attachments into the Mac library; the same file on the same page is not copied twice.
  const already = new Map();
  for (const note of existing.values()) for (const block of note.blocks ?? []) if (block.kind === 'attachment' && block.asset?.startsWith('assets/')) already.set(`${note.id}|${block.text}`, block.asset);
  const stored = new Map();
  let failed = 0;
  const owner = new Map();
  for (const note of result.notes) for (const block of note.blocks) if (block.asset?.startsWith(attachmentPrefix)) owner.set(block.asset.slice(attachmentPrefix.length), `${note.id}|${block.text}`);
  for (const file of result.files) {
    const reuse = already.get(owner.get(file));
    if (reuse) { stored.set(file, reuse); continue; }
    const entry = files.find((f) => f.path === file);
    if (!entry) { failed += 1; continue; }
    const bytes = readFileSync(entry.full);
    if (bytes.length > 40_000_000) { console.log(`Skipped ${path.basename(file)} (over 40 MB).`); failed += 1; continue; }
    try { stored.set(file, (await call({ op: 'asset-put', name: path.basename(file), data: bytes.toString('base64') })).path); }
    catch (error) { failed += 1; console.log(`Could not copy ${path.basename(file)}: ${error.message}`); }
  }
  for (const note of result.notes) {
    note.blocks = note.blocks.map((block) => {
      if (!block.asset?.startsWith(attachmentPrefix)) return block;
      const copy = stored.get(block.asset.slice(attachmentPrefix.length));
      return copy ? { ...block, asset: copy } : { ...block, kind: 'text', asset: undefined, text: `${block.text} (file not imported)` };
    });
  }

  // 4. Save: parents first, in batches the sync route accepts.
  const byID = new Map(result.notes.map((n) => [n.id, n]));
  const depth = (n) => { let d = 0; for (let p = n.parentID; p && byID.has(p) && d < 30; p = byID.get(p).parentID) d += 1; return d; };
  const ordered = [...result.notes].sort((a, b) => depth(a) - depth(b));
  const now = Date.now();
  let applied = 0, batch = [], size = 0;
  const send = async () => { if (!batch.length) return; applied += (await call({ op: 'sync', since: now, notes: batch, assistant: [], assistantHashes: {} })).applied ?? 0; batch = []; size = 0; };
  for (const note of ordered) {
    const body = JSON.stringify(note).length;
    if (size + body > 24_000_000 || batch.length >= 60) await send();
    batch.push({ ...note, created: existing.get(note.id)?.created ?? now, modified: now });
    size += body;
  }
  await send();
  console.log(`Folio saved ${applied} page(s). Copied ${stored.size} file(s)${failed ? `, ${failed} not copied` : ''}.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
