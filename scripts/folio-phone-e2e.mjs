// End-to-end check of iPhone ⇄ Mac sync on a Mac, without touching the real notebook.
//
// Starts the real Folio engine on a throwaway library plus a sync listener on its own port,
// serves the built phone app (packages/web/dist/folio.html), drives it in Chrome, pairs it,
// and checks notes, attachments and assistant chats in both directions.
//
// Run on a Mac after `bun run build:folio` (packages/electron) and the web build:
//   bun scripts/folio-phone-e2e.mjs
// Needs playwright-core and Google Chrome.

import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFolioEngine } from '../packages/electron/folio-engine.mjs';
import { createFolioSync } from '../packages/electron/folio-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const library = mkdtempSync(path.join(tmpdir(), 'folio-e2e-lib-'));
const engine = createFolioEngine({ resourcesPath: '/nonexistent', developmentRoot: path.join(root, 'packages/electron'), libraryPath: library });
const sync = createFolioSync({ engine, configPath: path.join(library, 'sync.json'), getLocalOrigin: () => '', defaultPort: 47700 + Math.floor(Math.random() * 200) });

// Mac side: a page with an attachment and an assistant conversation on it.
const created = await engine.request({ command: 'create', text: 'Mac test page' });
const macPage = created.state.notes.find((n) => n.id === created.state.selectedID);
const asset = (await engine.syncRequest({ command: 'asset-write', kind: 'agenda.txt', text: Buffer.from('agenda from the Mac').toString('base64') })).text;
await engine.request({ command: 'upsert', note: { ...macPage, blocks: [...macPage.blocks, { ...macPage.blocks[0], id: crypto.randomUUID().toUpperCase(), kind: 'attachment', text: 'agenda.txt', asset }], modified: macPage.modified + 1 } });
const macMessage = { id: crypto.randomUUID().toUpperCase(), role: 'user', content: 'Asked on the Mac', sourceIDs: [] };
await engine.syncRequest({ command: 'chat-put', noteID: macPage.id, text: JSON.stringify([macMessage]) });

const status = sync.enable();
const link = status.pairingURL;

// Serve the built phone app.
const dist = path.join(root, 'packages/web/dist');
if (!existsSync(path.join(dist, 'folio.html'))) throw new Error('Build packages/web first.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(dist, url.pathname === '/' ? 'folio.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const appURL = `http://127.0.0.1:${server.address().port}/folio.html`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(appURL);
  await page.waitForTimeout(3000);

  // A chat saved on the phone by an older build (no message IDs), and a phone page with an attachment.
  await page.evaluate(async () => {
    const put = (db, store, value) => new Promise((resolve, reject) => { const req = indexedDB.open(db, 1); req.onsuccess = () => { const tx = req.result.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = resolve; tx.onerror = reject; }; req.onerror = reject; });
    const now = Date.now();
    await put('folio-chats', 'chats', { id: crypto.randomUUID(), title: 'Started on iPhone', model: { provider: 'openrouter', id: 'z-ai/glm-5.2:free', name: 'GLM 5.2 (free)' }, messages: [{ role: 'user', content: 'Asked on the phone' }, { role: 'assistant', content: 'Answered on the phone' }], noteIDs: [], created: now, modified: now });
  });
  await page.reload();
  await page.waitForTimeout(3000);
  check('home screen shows', await page.getByText('Ask AI').isVisible());

  // Attach a file to the welcome page through the real picker.
  await page.getByRole('button', { name: /Welcome to Folio/ }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'More' }).first().click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).first().click();
  await (await chooser).setFiles({ name: 'from-phone.txt', mimeType: 'text/plain', buffer: Buffer.from('file from the phone') });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Back' }).first().click();

  // Pair from Settings and let the first sync run.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByLabel('Paste pairing link').fill(link);
  await page.getByRole('button', { name: 'Pair' }).click();
  await page.waitForTimeout(9000);

  const macState = await engine.request({ command: 'state' });
  const phoneOnMac = macState.state.notes.find((n) => n.title === 'Welcome to Folio');
  const attachment = phoneOnMac?.blocks.find((b) => b.kind === 'attachment');
  check('phone page arrived on the Mac', Boolean(phoneOnMac));
  check('phone attachment copied to the Mac', Boolean(attachment?.asset?.startsWith('assets/')), attachment?.asset);
  if (attachment?.asset) {
    const bytes = await engine.syncRequest({ command: 'asset-read', text: attachment.asset });
    check('attachment bytes match on the Mac', Buffer.from(bytes.text ?? '', 'base64').toString() === 'file from the phone');
  }
  const chats = JSON.parse((await engine.syncRequest({ command: 'chat-list' })).text);
  const phoneChat = Object.entries(chats).find(([, list]) => list.some((m) => m.content === 'Asked on the phone'));
  check('phone chat is a Mac assistant conversation', Boolean(phoneChat));
  check('phone chat page is a chat on the Mac', macState.state.notes.find((n) => n.id === phoneChat?.[0])?.isChat === true);

  // Phone side after sync.
  await page.getByRole('button', { name: 'Back' }).first().click();
  await page.waitForTimeout(500);
  check('Mac page shows on the phone', await page.getByRole('button', { name: /Mac test page/ }).first().isVisible());
  const phoneAsset = await page.evaluate(async (key) => new Promise((resolve) => { const req = indexedDB.open('folio', 1); req.onsuccess = () => { const get = req.result.transaction('assets').objectStore('assets').get(key); get.onsuccess = async () => resolve(get.result ? await get.result.text() : null); }; }), asset);
  check('Mac attachment downloaded to the phone', phoneAsset === 'agenda from the Mac');
  await page.getByRole('button', { name: 'Folio assistant' }).first().click();
  await page.waitForTimeout(500);
  check('Mac assistant chat listed on the phone', await page.getByText('Asked on the Mac').first().isVisible());

  // Continue the Mac conversation on the Mac, then see it on the phone after the next sync.
  const reply = { id: crypto.randomUUID().toUpperCase(), role: 'assistant', content: 'Answered on the Mac', sourceIDs: [] };
  await engine.syncRequest({ command: 'chat-put', noteID: macPage.id, text: JSON.stringify([macMessage, reply]) });
  await page.getByRole('button', { name: 'Back' }).first().click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: 'Back' }).first().click();
  await page.getByRole('button', { name: 'Folio assistant' }).first().click();
  await page.waitForTimeout(500);
  check('Mac reply reached the phone', await page.getByText('Answered on the Mac').first().isVisible());
  await page.screenshot({ path: path.join(library, 'phone.png') });
} finally {
  await browser.close();
  server.close();
  sync.disable();
  await engine.stop().catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`E2E_DONE ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
