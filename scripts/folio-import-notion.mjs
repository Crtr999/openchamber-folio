// Imports a Notion "Markdown & CSV" export into the running Folio notebook on this Mac.
//
//   bun scripts/folio-import-notion.mjs "<folder that holds the export>" [--title "Villanova Law"] [--icon logo.jpg]
//
// The folder should contain the top page's .md and its folder (as Notion's zip unpacks).
// Pages go through the app's own encrypted sync route, the same way the iPhone sends pages, so the
// running Folio engine writes them (no second process touches the library). Attachments are
// copied first. Secrets such as API keys found in the export are replaced with "[removed secret]".
// Needs iPhone sync turned on in Folio (⋯ → Sync with iPhone) for the local route to answer.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encrypt } from '../packages/electron/folio-sync.mjs';
import { attachmentPrefix, importNotionExport, tidyNotionImport } from '../packages/ui/src/lib/folio/notion-import.ts';

const root = process.argv[2];
const flag = (name) => { const at = process.argv.indexOf(name); return at > 2 ? process.argv[at + 1] : undefined; };
const iconFile = flag('--icon');
if (!root) { console.error('Usage: bun scripts/folio-import-notion.mjs "<export folder>"'); process.exit(1); }

const files = [];
const walk = (dir, rel) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const relative = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, relative);
    else files.push({ path: relative, full, text: /\.(md|csv)$/i.test(name) ? readFileSync(full, 'utf8') : undefined });
  }
};
walk(root, '');

const result = importNotionExport(files.map(({ path: p, text }) => ({ path: p, text })), Date.now());
// Shape it like the Notion page looked: merged views, no wrapper pages, databases listed where they were shown.
const tidied = tidyNotionImport(result.notes, { rootTitle: flag('--title'), rootIcon: iconFile ? `data:image/jpeg;base64,${readFileSync(iconFile).toString('base64')}` : undefined });
const removed = new Set(tidied.removed);
result.notes = tidied.notes;
result.attachments = result.attachments.filter((a) => tidied.notes.some((n) => n.blocks.some((b) => b.asset === `${attachmentPrefix}${a.file}`)));
console.log(`Read ${result.notes.length} pages (${result.notes.filter((n) => n.table).length} databases) and ${new Set(result.attachments.map((a) => a.file)).size} files.`);
if (result.removedSecrets) console.log(`Removed ${result.removedSecrets} secret(s) that looked like API keys. Rotate them: they were stored in Notion.`);

const configPath = path.join(os.homedir(), 'Library/Application Support/OpenChamber Folio/folio-sync.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const key = Buffer.from(config.key, 'base64url');
async function call(value) {
  const response = await fetch(`http://127.0.0.1:${config.port}/folio-sync`, { method: 'POST', body: encrypt(key, { t: Date.now(), ...value }) });
  if (!response.ok) throw new Error(`Folio answered ${response.status}`);
  return decrypt(key, await response.text());
}

// Copy attachments into the Mac library, then point the blocks at the copies. Files an earlier import
// already copied (same page, same file name) are reused instead of copied again.
const existing = new Map();
for (const note of (await call({ op: 'sync', since: 0, notes: [], assistant: [], assistantHashes: {} })).notes) {
  for (const block of note.blocks ?? []) if (block.kind === 'attachment' && block.asset?.startsWith('assets/')) existing.set(`${note.id}|${block.text}`, block.asset);
}
const stored = new Map();
for (const note of result.notes) for (const block of note.blocks) {
  const reuse = block.asset?.startsWith(attachmentPrefix) ? existing.get(`${note.id}|${block.text}`) : undefined;
  if (reuse) stored.set(block.asset.slice(attachmentPrefix.length), reuse);
}
let failed = 0;
for (const file of new Set(result.attachments.map((a) => a.file))) {
  if (stored.has(file)) continue;
  const source = files.find((f) => f.path === file);
  if (!source) { failed += 1; continue; }
  const bytes = readFileSync(source.full);
  if (bytes.length > 40_000_000) { console.log(`Skipped ${path.basename(file)} (over 40 MB).`); failed += 1; continue; }
  try { stored.set(file, (await call({ op: 'asset-put', name: path.basename(file), data: bytes.toString('base64') })).path); }
  catch (error) { failed += 1; console.log(`Could not copy ${path.basename(file)}: ${error.message}`); }
}
for (const note of result.notes) {
  note.blocks = note.blocks.flatMap((block) => {
    if (!block.asset?.startsWith(attachmentPrefix)) return [block];
    const copy = stored.get(block.asset.slice(attachmentPrefix.length));
    return copy ? [{ ...block, asset: copy }] : [{ ...block, kind: 'text', asset: undefined, text: `${block.text} (file not imported)` }];
  });
}

// Pages an earlier import created that are now merged away go to the Trash (restorable), not deleted.
const now = Date.now();
const trashed = [...removed].map((id) => ({ id, title: 'Merged during import', icon: '', blocks: [{ id: crypto.randomUUID().toUpperCase(), kind: 'text', text: '', checked: false, highlight: 'none' }], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: true, created: now, modified: now }));
const reply = await call({ op: 'sync', since: Date.now(), notes: [...result.notes, ...trashed], assistant: [], assistantHashes: {} });
console.log(`Folio saved ${reply.applied} page(s) (${removed.size} merged away). Copied ${stored.size} file(s)${failed ? `, ${failed} not copied` : ''}.`);
