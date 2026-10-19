import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';

// A separate offscreen Electron, not Carter's app or browser profile.
const output = process.env.OC_WORKSPACE_TEST_OUTPUT;
if (!output) throw new Error('Set OC_WORKSPACE_TEST_OUTPUT to an isolated evidence directory.');
app.setPath('userData', path.join(os.tmpdir(), `oc-workspace-test-${process.pid}`));
app.commandLine.appendSwitch('disable-gpu');
async function runSmoke() {
await mkdir(output, { recursive: true });
const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
const errors = [];
win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
const run = (source) => win.webContents.executeJavaScript(source);
const waitFor = async (source) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await run(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${source}`);
};
const click = async (label) => {
  const clicked = await run(`(() => { const button = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') || el.textContent).trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())}); if (!button) return false; button.click(); return true; })()`);
  assert.ok(clicked, `Missing button ${label}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
};
const capture = async (name) => writeFile(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
const artifact = () => run(`JSON.parse(document.querySelector('[data-testid="artifact-json"]').textContent)`);
const reports = [];
try {
  await win.loadURL('http://127.0.0.1:5191/@fs/Users/carterlaborde/Developer/openchamber/scripts/fixtures/personal-workspace.html');
  await waitFor(`!!document.querySelector('svg[aria-label="Sketch test"]')`);
  const viewport = await run(`({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth})`);
  assert.equal(viewport.width, 1440);
  const bounds = await run(`(() => { const r = document.querySelector('svg[aria-label="Sketch test"]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  const point = (x, y) => ({ x: Math.round(bounds.x + bounds.width * x), y: Math.round(bounds.y + bounds.height * y) });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point(.2, .2), button: 'left', clickCount: 1 });
  for (let index = 0; index < 12; index++) win.webContents.sendInputEvent({ type: 'mouseMove', ...point(.2 + index * .02, .2 + index * .025), button: 'left' });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point(.42, .475), button: 'left', clickCount: 1 });
  await waitFor(`JSON.parse(document.querySelector('[data-testid="artifact-json"]').textContent).elements.length === 1`);
  assert.ok((await artifact()).elements[0].points.length > 1);
  await click('Undo'); assert.equal((await artifact()).elements.length, 0);
  await click('Redo'); assert.equal((await artifact()).elements.length, 1);
  await click('Rectangle');
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point(.55, .25), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point(.8, .7), button: 'left' });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point(.8, .7), button: 'left', clickCount: 1 });
  await waitFor(`JSON.parse(document.querySelector('[data-testid="artifact-json"]').textContent).elements.length === 2`);
  await capture('sketch-dark');
  await run(`document.querySelector('summary[aria-label="Export"]').click()`);
  await click('Export SVG'); await click('PNG'); await click('PDF');
  reports.push({ test: 'sketch real pointer capture, shapes, undo/redo, SVG/PNG/PDF export', passed: true });

  // The export overflow is a <details> that stays open from earlier steps; close it
  // so the creation menu is the thing actually captured.
  await run(`[...document.querySelectorAll('details[open]')].forEach(d => d.removeAttribute('open'))`);
  await run(`document.querySelector('button[aria-label="Add attachment"]').click()`);
  await waitFor(`document.body.textContent.includes('Record a skill')`);
  const menu = await run(`[...document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent.trim())`);
  for (const label of ['Sketch', 'Document', 'Spreadsheet', 'Presentation', 'PDF tools', 'Record a skill', 'Notion', 'Saved sites']) assert.ok(menu.includes(label), label);
  // Every option needs its own glyph: ChatGPT pairs each label with an icon that
  // explains the action, and six of these used to share one generic page glyph.
  const rows = await run(`[...document.querySelectorAll('[role="menuitem"]')].map(el => ({label: el.textContent.trim(), hasIcon: Boolean(el.querySelector('svg'))}))`);
  const missingIcon = rows.filter((row) => !row.hasIcon).map((row) => row.label);
  assert.equal(missingIcon.length, 0, `menu options without an icon: ${missingIcon.join(', ')}`);
  const glyphs = await run(`[...document.querySelectorAll('[role="menuitem"]')].map(el => ({label: el.textContent.trim(), glyph: (el.querySelector('svg use')?.getAttribute('href') || '').replace('#oc-','')}))`);
  const distinctGlyphs = new Set(glyphs.map((row) => row.glyph).filter(Boolean));
  assert.ok(distinctGlyphs.size >= 8, `expected a distinct glyph per option, got ${distinctGlyphs.size}: ${[...distinctGlyphs].join(', ')}`);
  // Offscreen capturePage does not composite the portal-rendered popover, so record the
  // resolved label→glyph mapping as the durable evidence for this check.
  reports.push({ test: 'creation menu pairs every option with a distinct icon', passed: true, detail: glyphs });
  await capture('creation-menu-dark');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });

  await click('Document'); await click('Preview');
  await waitFor(`document.querySelector('.markdown-content')?.textContent.includes('Priorities')`);
  await capture('document-dark'); await click('Export DOCX'); await click('PDF');
  reports.push({ test: 'document preview, DOCX/PDF export', passed: true });
  await click('Spreadsheet');
  await waitFor(`document.querySelector('input[aria-label="Budget B4"]')?.value === '400'`);
  await capture('spreadsheet-dark'); await click('Export XLSX'); await click('CSV'); await click('PDF');
  await click('Presentation'); await click('Preview');
  await capture('presentation-dark'); await click('Export PPTX'); await click('PDF');
  reports.push({ test: 'spreadsheet calculation, XLSX/CSV/PDF, slide preview and PPTX/PDF', passed: true });
  await click('Light'); await capture('presentation-light');
  win.setSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const mobile = await run(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`);
  assert.ok(mobile.scroll <= mobile.width, `Mobile overflow: ${JSON.stringify(mobile)}`);
  await capture('presentation-mobile');
  reports.push({ test: 'light mode and narrow viewport without page overflow', passed: true });
  win.setSize(1440, 900);
  await click('Draw dialog');
  await waitFor(`!!document.querySelector('[role="dialog"] [data-drawing-canvas]')`);
  const drawingBounds = await run(`(() => { const r=document.querySelector('[role="dialog"] svg[role="img"]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  assert.ok(drawingBounds.height >= 380 && drawingBounds.height <= 700, `canvas should be a realistic panel, not full page: ${JSON.stringify(drawingBounds)}`);
  assert.ok(drawingBounds.width <= 940, `canvas should not span the page: ${JSON.stringify(drawingBounds)}`);
  const paperFill = await run(`document.querySelector('[role="dialog"] svg[role="img"] rect').getAttribute('fill')`);
  assert.ok(paperFill === '#2f2f2f', `sketch paper should be dark grey, got ${paperFill}`);
  const defaultPigment = await run(`(() => { const swatches=[...document.querySelectorAll('[role="dialog"] [role="group"] button[aria-pressed="true"] span')]; return swatches[0]?.style.background ?? ''; })()`);
  assert.ok(defaultPigment === 'rgb(255, 255, 255)', `default marker should be white, got ${defaultPigment}`);
  await capture('drawing-dialog-light');
  const drawingPoint = (x,y) => ({x:Math.round(drawingBounds.x+drawingBounds.width*x),y:Math.round(drawingBounds.y+drawingBounds.height*y)});
  win.webContents.sendInputEvent({type:'mouseDown',...drawingPoint(.3,.3),button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',...drawingPoint(.6,.5),button:'left'});
  win.webContents.sendInputEvent({type:'mouseUp',...drawingPoint(.6,.5),button:'left',clickCount:1});
  await click('Attach to chat');
  await waitFor(`document.querySelector('[data-testid="attached"]').textContent.includes('.png')`);
  reports.push({test:'dedicated drawing dialog, dark-grey panel sized like ChatGPT canvas, white default marker and PNG/source attachment',passed:true});
  const exported = await run(`Promise.all(window.workspaceFixtureExports.map(async entry => ({name:entry.name, bytes:Array.from(new Uint8Array(await entry.blob.arrayBuffer()))})))`);
  for (let index = 0; index < exported.length; index++) await writeFile(path.join(output, `${index}-${exported[index].name}`), Buffer.from(exported[index].bytes));
  assert.ok(exported.some((entry) => entry.name.endsWith('.docx')));
  assert.ok(exported.some((entry) => entry.name.endsWith('.xlsx')));
  assert.ok(exported.some((entry) => entry.name.endsWith('.pptx')));
  // This fixture has no OpenCode backend. SyncProvider is present only for the
  // shared Markdown renderer; expected bootstrap failures are recorded separately.
  const bootstrapErrors = errors.filter((message) => /^\[(bootstrap|event-pipeline)\]/.test(message));
  const uiErrors = errors.filter((message) => !bootstrapErrors.includes(message));
  assert.equal(uiErrors.length, 0, uiErrors.join('\n'));
  await writeFile(path.join(output, 'smoke-result.json'), JSON.stringify({ passed: true, reports, menu, viewport, mobile, exports: exported.map(({ name, bytes }) => ({ name, bytes: bytes.length })), uiErrors, expectedFixtureBootstrapErrors: bootstrapErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, reports, output }, null, 2));
} catch (error) {
  await capture('failure');
  await writeFile(path.join(output, 'smoke-result.json'), JSON.stringify({ passed: false, reports, error: String(error), errors }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { win.destroy(); app.exit(process.exitCode ?? 0); }
}
void app.whenReady().then(runSmoke).catch((error) => { console.error(error); app.exit(1); });
