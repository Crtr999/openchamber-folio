// Imports a Notion "Markdown & CSV" export into the running Folio notebook on this Mac.
//
//   bun scripts/folio-import-notion.mjs "<folder that holds the export>"
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
import { attachmentPrefix, importNotionExport } from '../packages/ui/src/lib/folio/notion-import.ts';

const root = process.argv[2];
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

// Copy attachments into the Mac library, then point the blocks at the copies.
const stored = new Map();
let failed = 0;
for (const file of new Set(result.attachments.map((a) => a.file))) {
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

const reply = await call({ op: 'sync', since: Date.now(), notes: result.notes, assistant: [], assistantHashes: {} });
console.log(`Folio saved ${reply.applied} page(s). Copied ${stored.size} file(s)${failed ? `, ${failed} not copied` : ''}.`);
