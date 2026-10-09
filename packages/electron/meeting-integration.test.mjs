import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { createMeetingBoundary } from './meeting-boundary.mjs';
import { createMeetingService } from '../web/server/lib/meetings/service.js';
import { createMeetingSummaryService } from '../web/server/lib/meetings/summary.js';
import { isPrivateMeetingPath } from '../web/server/lib/meetings/private-paths.js';
import { DEFAULT_LOCAL_STT_MODEL, getLocalSttModelSpec } from '../web/server/lib/dictation/local/model-catalog.js';

// These are synthetic fixtures. No microphone, system audio, inference or network.
test('macOS capture packaging declares both audio purposes without a legacy feature fallback', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  for (const key of ['NSAudioCaptureUsageDescription', 'NSMicrophoneUsageDescription']) {
    const description = manifest.build.mac.extendInfo[key];
    assert.match(description, /\S/);
  }
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /MacCatapLoopbackAudioForScreenShare/);
});

const fixture = async (context, summaryOptions = {}) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'meeting-integration-')));
  const directory = path.join(root, 'private-meetings');
  const modelsDir = path.join(root, 'models');
  const spec = getLocalSttModelSpec(DEFAULT_LOCAL_STT_MODEL);
  const modelDirectory = path.join(modelsDir, spec.extractedDir);
  await mkdir(modelDirectory, { recursive: true });
  for (const name of spec.requiredFiles) await writeFile(path.join(modelDirectory, name), 'synthetic model fixture');
  const generationRequests = [];
  let enterprise = false;
  const service = createMeetingService({ directory, modelsDir, workerFactory: () => {
    let emitter;
    return {
      async createSession(_options, events) { emitter = events; return { sessionId: 'synthetic', requiredSampleRate: 16000 }; },
      async sendRequest(request) {
        if (request.type === 'session.commit') emitter.emit('transcript', { transcript: 'Synthetic decision: keep the example local.' });
        return {};
      },
      shutdown() {},
    };
  } });
  const summary = createMeetingSummaryService({
    enterpriseMode: () => enterprise,
    getModels: async () => [{ id: 'gpt-mini', providerID: 'synthetic-provider', family: 'gpt-mini', enabled: true, capabilities: { input: ['text'], output: ['text'] } }],
    generateText: async (request) => {
      generationRequests.push(request);
      return { text: 'Synthetic summary.', providerID: 'synthetic-provider', modelID: 'gpt-mini' };
    },
    ...summaryOptions,
  });
  const frame = {};
  const sender = { mainFrame: frame };
  const event = { sender, senderFrame: frame };
  const lifecycle = [];
  const boundary = createMeetingBoundary({
    service, summary, isSummaryBlocked: () => enterprise,
    authorize: (candidate) => candidate.sender === sender && candidate.senderFrame === frame,
    getSources: async () => [{ id: 'synthetic-screen' }], systemAudioSupported: true,
    emit: (_sender, detail) => lifecycle.push(detail),
  });
  context.after(async () => { await boundary.dispose(); await rm(root, { recursive: true, force: true }); });
  return { directory, service, boundary, lifecycle, generationRequests,
    invoke: (action, args) => boundary.invoke(event, `desktop_meeting_${action}`, args),
    blockSummary: () => { enterprise = true; },
    runtimeChanging: () => boundary.runtimeChanging(event),
  };
};

test('native IPC, local storage and deliberate summary agree without uploading notes or calendar metadata', async (context) => {
  const f = await fixture(context);
  assert.equal(await isPrivateMeetingPath(path.join(f.directory, 'future.json')), true);
  const meeting = await f.invoke('create', { title: 'Synthetic private title', calendarEventId: 'synthetic-calendar-id' });
  await f.invoke('notes', { id: meeting.id, notes: 'Synthetic private notes are not summary input.' });
  const started = await f.invoke('start', { id: meeting.id, consent: true, mode: 'microphone' });
  assert.equal(started.capture.degraded, true);
  const pcm = Array(1600).fill(0.25);
  const transcribed = await f.invoke('chunk', { id: meeting.id, source: 'microphone', startMs: 0, endMs: 100, pcm });
  assert.equal(pcm.every((sample) => sample === 0), true);
  assert.equal(transcribed.segments[0].label, 'Microphone');
  assert.equal(transcribed.segments[0].startMs, 0);
  await assert.rejects(f.invoke('prepare_summary', { id: meeting.id }), { code: 'meeting_not_closed' });
  await f.invoke('stop', { id: meeting.id });
  const preview = await f.invoke('prepare_summary', { id: meeting.id, model: 'synthetic-provider/gpt-mini' });
  assert.deepEqual(preview.disclosure, { data: 'transcript-only', cost: 'unknown', subscriptionCoverage: 'unknown' });
  assert.equal(f.generationRequests.length, 0);
  const saved = await f.invoke('generate_summary', { id: meeting.id, model: preview.model, approvalToken: preview.approvalToken, approved: true });
  assert.equal(saved.summary.status, 'available');
  assert.equal(saved.summary.text, 'Synthetic summary.');
  assert.equal(f.generationRequests.length, 1);
  const prompt = f.generationRequests[0].prompt;
  assert.equal(prompt.includes(transcribed.segments[0].text), true);
  for (const excluded of [meeting.title, meeting.calendarEventId, transcribed.notes]) assert.equal(prompt.includes(excluded), false);
  await assert.rejects(f.invoke('generate_summary', { id: meeting.id, model: preview.model, approvalToken: preview.approvalToken, approved: true }), { code: 'summary_approval_required' });
  const files = await readdir(f.directory);
  assert.deepEqual(files, [`${meeting.id}.json`]);
  const persisted = JSON.parse(await readFile(path.join(f.directory, files[0]), 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'audio'), false);
  assert.equal(Object.hasOwn(persisted, 'pcm'), false);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.directory, files[0]))).mode & 0o777, 0o600);
  f.blockSummary();
  await assert.rejects(f.invoke('prepare_summary', { id: meeting.id }), { code: 'enterprise_mode' });
  assert.equal(f.generationRequests.length, 1);
});

test('native sleep saves an explicit partial record and revoked system grant cannot be reused', async (context) => {
  const f = await fixture(context);
  const meeting = await f.invoke('create', { title: 'Synthetic interrupted meeting' });
  const started = await f.invoke('start', { id: meeting.id, consent: true, mode: 'system-and-microphone' });
  assert.equal(started.capture.systemAudioValidation, 'pending');
  await f.boundary.interrupt('sleep');
  const partial = await f.invoke('get', { id: meeting.id });
  assert.equal(partial.status, 'interrupted');
  assert.equal(partial.interruptionReason, 'sleep');
  assert.equal(f.lifecycle[0].reason, 'sleep');
  let grant;
  await f.boundary.displayMedia({ frame: {}, audioRequested: true, videoRequested: true }, (result) => { grant = result; });
  assert.deepEqual(grant, {});
  assert.equal(f.generationRequests.length, 0);
});

test('capture-error IPC retains the saved partial transcript and releases the recording owner', async (context) => {
  const f = await fixture(context);
  const meeting = await f.invoke('create', { title: 'Synthetic failed capture' });
  await f.invoke('start', { id: meeting.id, consent: true, mode: 'microphone' });
  await f.invoke('chunk', { id: meeting.id, source: 'microphone', startMs: 0, endMs: 100, pcm: Array(1600).fill(0.25) });
  await f.invoke('interrupt', { id: meeting.id, reason: 'capture-error' });
  const partial = await f.invoke('get', { id: meeting.id });
  assert.equal(partial.status, 'interrupted');
  assert.equal(partial.interruptionReason, 'capture-error');
  assert.equal(partial.segments.length, 1);
  const next = await f.invoke('create', { title: 'Synthetic retry' });
  const restarted = await f.invoke('start', { id: next.id, consent: true, mode: 'microphone' });
  assert.equal(restarted.status, 'recording');
  assert.equal(f.generationRequests.length, 0);
});

test('runtime change during summary catalog lookup cancels before transcript dispatch', async (context) => {
  let release;
  let reached;
  let reads = 0;
  const models = [{ id: 'gpt-mini', providerID: 'synthetic-provider', family: 'gpt-mini', enabled: true }];
  const catalog = new Promise((resolve) => { release = resolve; });
  const lookingUp = new Promise((resolve) => { reached = resolve; });
  const f = await fixture(context, { getModels: () => {
    if (++reads === 2) { reached(); return catalog; }
    return Promise.resolve(models);
  } });
  const meeting = await f.invoke('create', { title: 'Synthetic cancelled summary' });
  await f.invoke('start', { id: meeting.id, consent: true, mode: 'microphone' });
  await f.invoke('chunk', { id: meeting.id, source: 'microphone', startMs: 0, endMs: 100, pcm: Array(1600).fill(0.25) });
  await f.invoke('stop', { id: meeting.id });
  const approval = await f.invoke('prepare_summary', { id: meeting.id, model: 'synthetic-provider/gpt-mini' });
  const generation = f.invoke('generate_summary', { id: meeting.id, model: approval.model, approvalToken: approval.approvalToken, approved: true });
  const rejected = assert.rejects(generation, { code: 'summary_cancelled' });
  await lookingUp;
  await f.runtimeChanging();
  release(models);
  await rejected;
  assert.equal(f.generationRequests.length, 0);
  assert.equal((await f.invoke('get', { id: meeting.id })).summary.status, 'unavailable');
});
