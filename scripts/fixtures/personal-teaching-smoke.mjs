import { app, BrowserWindow, session } from 'electron';
import { createPersonalTeaching } from '../../packages/web/server/lib/personal-teaching.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { teachingReplayScript } from '../../packages/ui/src/lib/personal-workspace/teaching-replay.ts';

const output = process.env.OC_WORKSPACE_TEST_OUTPUT;
if (!output) throw new Error('Set OC_WORKSPACE_TEST_OUTPUT');
app.setPath('userData', path.join(process.env.TMPDIR, `oc-teaching-test-${process.pid}`));
const service = createPersonalTeaching();
let ownsRecording = false;
async function run() {
const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { partition: 'teaching-smoke', contextIsolation: true, nodeIntegration: false } });
try {
  await mkdir(output, { recursive: true });
  assert.notEqual((await service.status()).phase, 'recording', 'Do not interrupt an existing user recording');
  const recording = await service.start();
  ownsRecording = true;
  assert.equal(recording.phase, 'recording');
  const credentials = service.credentials();
  await session.fromPartition('teaching-smoke').cookies.set({ url: credentials.origin, name: 'cb_key', value: credentials.token, httpOnly: true, sameSite: 'strict', secure: credentials.origin.startsWith('https:') });
  await win.loadURL(recording.viewUrl);
  await new Promise(resolve => setTimeout(resolve, 2000));
  await writeFile(path.join(output, 'teaching-live.png'), (await win.webContents.capturePage()).toPNG());
  const review = await service.stop();
  ownsRecording = false;
  assert.equal(review.phase, 'review');
  await win.loadURL(review.viewUrl);
  await win.webContents.executeJavaScript(teachingReplayScript(review.videoUrl));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const media = await win.webContents.executeJavaScript(`(() => { const v=document.querySelector('video'); return { exists: !!v, readyState:v?.readyState, duration:v?.duration, error:v?.error?.message, contentType:document.contentType }; })()`);
  assert.equal(media.exists, true, JSON.stringify(media));
  assert.ok(media.readyState >= 1, JSON.stringify(media));
  await writeFile(path.join(output, 'teaching-replay.png'), (await win.webContents.capturePage()).toPNG());
  await writeFile(path.join(output, 'teaching-result.json'), JSON.stringify({ passed: true, recordingId: review.recordingId, seconds: review.seconds, media }, null, 2));
  console.log(JSON.stringify({ passed: true, media, output }));
} catch (error) {
  await writeFile(path.join(output, 'teaching-result.json'), JSON.stringify({ passed: false, error: String(error) }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (ownsRecording) await service.dismiss().catch(() => {});
  win.destroy(); app.exit(process.exitCode ?? 0);
}
}
void app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
