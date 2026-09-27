// Imports Notion pages read with the Notion connector (Notion-flavored Markdown) into the running
// Folio notebook on this Mac, through the same encrypted sync route the iPhone uses.
//
//   bun scripts/folio-import-notion-pages.mjs <pages.json>
//
// pages.json: { pages: [{ hex, title, icon, parent, markdown }], databases: [{ hex, icon, parent,
// config, records }], links: { <hex of a linked view>: { hex of the database it shows } } }.
// IDs come from Notion's, so importing again updates the same pages.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encrypt } from '../packages/electron/folio-sync.mjs';
import { notionUUID } from '../packages/ui/src/lib/folio/notion-import.ts';
import { notionPageBlocks, notionTableFromConfig } from '../packages/ui/src/lib/folio/notion-package.ts';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const config = JSON.parse(readFileSync(path.join(os.homedir(), 'Library/Application Support/OpenChamber Folio/folio-sync.json'), 'utf8'));
const key = Buffer.from(config.key, 'base64url');
const call = async (value) => {
  const response = await fetch(`http://127.0.0.1:${config.port}/folio-sync`, { method: 'POST', body: encrypt(key, { t: Date.now(), ...value }) });
  if (!response.ok) throw new Error(`Folio answered ${response.status}`);
  return decrypt(key, await response.text());
};
const existing = new Map((await call({ op: 'sync', since: 0, notes: [], assistant: [], assistantHashes: {} })).notes.map((n) => [n.id, n]));
const now = Date.now();
const report = [];
const block = () => ({ id: crypto.randomUUID().toUpperCase(), kind: 'text', text: '', checked: false, highlight: 'none', marks: [] });

const known = new Set([...input.pages.map((p) => p.hex), ...input.databases.map((d) => d.hex)]);
const databases = new Map(input.databases.map((d) => [d.hex, { asset: notionUUID(d.hex) }]));
for (const [hex, target] of Object.entries(input.links ?? {})) {
  const id = notionUUID(target.hex);
  if (existing.has(id)) databases.set(hex, { asset: id }); else report.push(`A linked view (${hex}) points to a database that is not in Folio.`);
}
const notes = [];
for (const db of input.databases) {
  const built = notionTableFromConfig(db.config, db.records, report);
  if (!built) { report.push(`Could not read the database ${db.hex}.`); continue; }
  notes.push({ id: notionUUID(db.hex), title: built.title, icon: db.icon || 'icon:table-2', parentID: db.parent ? notionUUID(db.parent) : undefined, blocks: [block()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now, table: built.table });
}
for (const page of input.pages) {
  const blocks = notionPageBlocks(page.markdown, { known, databases, report });
  notes.push({ id: notionUUID(page.hex), title: page.title, icon: page.icon || '', parentID: page.parent ? notionUUID(page.parent) : undefined, blocks: blocks.length ? blocks : [block()], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: now, modified: now });
}
const kept = [];
const final = notes.map((note) => {
  const mine = existing.get(note.id);
  if (!mine || mine.trashed) return note;
  // Edited in Folio since an earlier import: keep that page as it is.
  if (mine.modified - mine.created > 10 * 60_000) { kept.push(mine.title); return undefined; }
  return { ...note, created: mine.created };
}).filter(Boolean);
const depth = (n) => { let d = 0; for (let p = n.parentID; p && d < 30; p = final.find((x) => x.id === p)?.parentID) d += 1; return d; };
final.sort((a, b) => depth(a) - depth(b));
const reply = await call({ op: 'sync', since: now, notes: final.map((n) => ({ ...n, modified: now })), assistant: [], assistantHashes: {} });
console.log(`Folio saved ${reply.applied} page(s): ${final.map((n) => n.title).join(', ')}.`);
for (const n of final.filter((x) => x.table)) console.log(`  ${n.title}: ${n.table.rows.length} rows, views ${n.table.views?.map((v) => `${v.kind}:${v.name}`).join(', ')}`);
if (kept.length) console.log(`Kept your Folio edits on: ${kept.join(', ')}`);
for (const line of [...new Set(report)]) console.log(`• ${line}`);
