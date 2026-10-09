import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMeetingBoundary, isMeetingCommand, supportsMeetingSystemAudio } from './meeting-boundary.mjs';

const id = 'fe7d0081-f0be-45d8-80bf-7e0d782273d2';
const otherId = 'cf83b93b-0f7b-4c3a-8542-76508d7c53c7';
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const fixture = (overrides = {}) => {
  const frame = {};
  const sender = { mainFrame: frame };
  const event = { sender, senderFrame: frame };
  const calls = [];
  const events = [];
  let time = 1;
  const meeting = { version: 1, id, title: 'Test meeting', status: 'draft', notes: '', segments: [], summary: { status: 'unavailable' } };
  const service = {
    async readiness() { return { available: true, modelId: 'local-test' }; },
    async list() { return [meeting]; },
    getWarnings() { return []; },
    async create(args) { calls.push(['create', args]); return meeting; },
    async get(value) { calls.push(['get', value]); return meeting; },
    async updateNotes(value, notes) { calls.push(['notes', value, notes]); return { ...meeting, notes }; },
    async start(value) { calls.push(['start', value]); return { ...meeting, status: 'recording' }; },
    async transcribeChunk(value, chunk) { calls.push(['chunk', value, chunk]); return { ...meeting, segments: [{ text: 'Local text', source: chunk.source }] }; },
    async pause() { return { ...meeting, status: 'paused' }; },
    async resume() { return { ...meeting, status: 'recording' }; },
    async stop() { return { ...meeting, status: 'stopped' }; },
    async interrupt(args) { calls.push(['interrupt', args]); return { ...meeting, status: 'interrupted' }; },
    async dispose() { calls.push(['dispose']); },
    ...overrides.service,
  };
  const boundary = createMeetingBoundary({
    service,
    summary: { dispose() {} },
    isSummaryBlocked: () => false,
    authorize: (candidate) => candidate.sender === sender && candidate.senderFrame === frame,
    getSources: async () => [{ id: 'screen:1' }],
    systemAudioSupported: true,
    now: () => time,
    emit: (contents, detail) => events.push({ contents, detail }),
    ...overrides.boundary,
  });
  const invoke = (action, args) => boundary.invoke(event, `desktop_meeting_${action}`, args);
  const start = (mode = 'system-and-microphone') => invoke('start', { id, consent: true, mode });
  const display = async (options = {}) => {
    let result;
    await boundary.displayMedia({ frame, audioRequested: true, videoRequested: true, ...options }, (value) => { result = value; });
    return result;
  };
  const chunk = (source = 'microphone') => ({ id, source, startMs: 0, endMs: 100, pcm: Array(1600).fill(0.5) });
  return { boundary, service, event, calls, events, invoke, start, display, chunk, setTime: (value) => { time = value; } };
};

test('meeting IPC routing parses its command prefix rather than granting unrelated commands', () => {
  assert.equal(isMeetingCommand('desktop_meeting_start'), true);
  assert.equal(isMeetingCommand('desktop_read_file'), false);
  assert.equal(isMeetingCommand(undefined), false);
  assert.equal(isMeetingCommand(1), false);
});

test('runtime notification revokes a start still awaiting local readiness', async () => {
  const readiness = deferred();
  const f = fixture({ service: { readiness: () => readiness.promise } });
  const started = f.start('microphone');
  const rejected = assert.rejects(started, { code: 'meeting_interrupted' });
  await f.boundary.runtimeChanging(f.event);
  readiness.resolve({ available: true, modelId: 'local-test' });
  await rejected;
  assert.equal(f.calls.some(([action]) => action === 'start'), false);
});

test('explicit failure interruption bypasses a busy chunk and clears its owner', async () => {
  const transcription = deferred();
  const f = fixture({ service: {
    transcribeChunk: () => transcription.promise,
    async interrupt(args) { transcription.reject(Object.assign(new Error('Synthetic interruption'), { code: 'interrupted' })); return { id: args.id, status: 'interrupted', interruptionReason: args.reason }; },
  } });
  await f.start('microphone');
  const audio = f.chunk();
  const pending = f.invoke('chunk', audio);
  const rejected = assert.rejects(pending, { code: 'interrupted' });
  await assert.rejects(f.invoke('stop', { id }), { code: 'meeting_busy' });
  const result = await f.invoke('interrupt', { id, reason: 'capture-error' });
  await rejected;
  assert.equal(result.status, 'interrupted');
  assert.equal(audio.pcm.every((sample) => sample === 0), true);
  assert.equal((await f.start('microphone')).status, 'recording');
});

test('failure interruption revokes a pending start and warning snapshot precedes readiness', async () => {
  const readiness = deferred();
  const f = fixture({ service: { readiness: () => readiness.promise } });
  const started = f.start();
  const rejected = assert.rejects(started, { code: 'meeting_interrupted' });
  await f.invoke('interrupt', { id, reason: 'capture-error' });
  readiness.resolve({ available: true, modelId: 'local-test' });
  await rejected;
  assert.deepEqual(await f.display(), {});
  let warnings = [{ id: otherId, code: 'invalid_record', message: 'Synthetic damaged record' }];
  const listing = fixture({ service: {
    getWarnings: () => warnings.map((warning) => ({ ...warning })),
    async readiness() { warnings = []; return { available: true, modelId: 'local-test' }; },
  } });
  assert.equal((await listing.invoke('list')).warnings.length, 1);
});

test('platform gate does not claim older macOS or Linux supports system audio', () => {
  for (const release of ['22.6.0', '23.0.0', '23.1.0', 'garbage']) assert.equal(supportsMeetingSystemAudio('darwin', release), false);
  for (const release of ['23.2.0', '23.6.0', '24.0.0']) assert.equal(supportsMeetingSystemAudio('darwin', release), true);
  assert.equal(supportsMeetingSystemAudio('linux', '99'), false);
  assert.equal(supportsMeetingSystemAudio('win32', '10.0'), true);
});

test('trusted main-frame gate precedes every service operation', async () => {
  const f = fixture();
  for (const action of ['list', 'readiness', 'create', 'get', 'notes', 'start', 'chunk', 'pause', 'resume', 'stop', 'interrupt', 'prepare_summary', 'generate_summary']) {
    await assert.rejects(f.boundary.invoke({ ...f.event, senderFrame: {} }, `desktop_meeting_${action}`, {}), { code: 'meeting_forbidden' });
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.display(), {});
});

test('readiness, records and notes use canonical backend shapes', async () => {
  const f = fixture();
  assert.equal((await f.invoke('list')).readiness.available, true);
  assert.equal((await f.invoke('readiness')).modelId, 'local-test');
  assert.equal((await f.invoke('create', { title: 'Title', calendarEventId: 'event' })).id, id);
  assert.deepEqual(f.calls[0], ['create', { title: 'Title', calendarEventId: 'event' }]);
  assert.equal((await f.invoke('get', { id })).segments.length, 0);
  assert.equal((await f.invoke('notes', { id, notes: 'Private notes' })).notes, 'Private notes');
  await assert.rejects(f.invoke('notes', { id, notes: '', endpoint: 'https://remote.test' }), { code: 'meeting_invalid' });
});

test('start requires literal consent, readiness and explicit supported mode', async () => {
  const f = fixture();
  for (const consent of [false, undefined, 'true']) await assert.rejects(f.invoke('start', { id, consent, mode: 'microphone' }), { code: 'meeting_invalid' });
  const unavailable = fixture({ service: { async readiness() { return { available: false, modelId: null, reasonCode: 'model_missing' }; } } });
  await assert.rejects(unavailable.start(), { code: 'model_missing' });
  assert.equal(unavailable.calls.length, 0);
  const unsupported = fixture({ boundary: { systemAudioSupported: false } });
  await assert.rejects(unsupported.start(), { code: 'meeting_system_unsupported' });
  const result = await unsupported.start('microphone');
  assert.equal(result.capture.degraded, true);
  assert.equal(result.capture.systemAudioValidation, 'pending');
  assert.deepEqual(await unsupported.display(), {});
});

test('display grant is main-frame only, audio-only loopback candidate and single-use', async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(await f.display({ frame: {} }), {});
  assert.deepEqual(await f.display({ audioRequested: false }), {});
  assert.deepEqual(await f.display(), { video: { id: 'screen:1' }, audio: 'loopback' });
  assert.deepEqual(await f.display(), {});
  await assert.rejects(f.start(), { code: 'meeting_active' });
});

test('expired consent and paused/interrupting owners cannot acquire display audio', async () => {
  const f = fixture();
  await f.start();
  f.setTime(30_001);
  assert.deepEqual(await f.display(), {});
  const paused = fixture();
  await paused.start();
  await paused.invoke('pause', { id });
  assert.deepEqual(await paused.display(), {});
  await paused.invoke('resume', { id });
  assert.deepEqual(await paused.display(), {});
  const sources = deferred();
  const interrupted = fixture({ boundary: { getSources: () => sources.promise } });
  await interrupted.start();
  const pending = interrupted.display();
  assert.deepEqual(await interrupted.display(), {});
  await interrupted.boundary.interrupt('sleep');
  sources.resolve([{ id: 'screen:1' }]);
  assert.deepEqual(await pending, {});
});

test('display discovery cannot extend the consent deadline', async () => {
  const sources = deferred();
  const f = fixture({ boundary: { getSources: () => sources.promise } });
  await f.start();
  const pending = f.display();
  f.setTime(30_001);
  sources.resolve([{ id: 'screen:1' }]);
  assert.deepEqual(await pending, {});
  await assert.rejects(f.invoke('chunk', f.chunk('system')), { code: 'meeting_source' });
});

test('pause and resume cannot revive a pending display consent grant', async () => {
  const sources = deferred();
  const f = fixture({ boundary: { getSources: () => sources.promise } });
  await f.start();
  const pending = f.display();
  await f.invoke('pause', { id });
  await f.invoke('resume', { id });
  sources.resolve([{ id: 'screen:1' }]);
  assert.deepEqual(await pending, {});
  await assert.rejects(f.invoke('chunk', f.chunk('system')), { code: 'meeting_source' });
});

test('chunks map normalized PCM, preserve source, and zero every native buffer', async () => {
  const f = fixture();
  await f.start();
  await f.display();
  for (const source of ['microphone', 'system']) {
    const args = f.chunk(source);
    const result = await f.invoke('chunk', args);
    assert.equal(result.segments[0].source, source);
    const transferred = f.calls.at(-1)[2];
    assert.ok(transferred.pcm16k instanceof Float32Array);
    assert.equal(transferred.pcm16k.length, 1600);
    assert.ok(transferred.pcm16k.every((sample) => sample === 0));
    assert.ok(args.pcm.every((sample) => sample === 0));
  }
});

test('invalid chunks and backend failures clear audio, never silently accept wrong rate/source', async () => {
  const f = fixture({ service: { async transcribeChunk() { throw new Error('STT failed'); } } });
  await f.start('microphone');
  for (const args of [f.chunk('system'), { ...f.chunk(), endMs: 200 }, { ...f.chunk(), endMs: 90_001 }, { ...f.chunk(), pcm: [NaN] }, { ...f.chunk(), id: otherId }]) {
    await assert.rejects(f.invoke('chunk', args));
    assert.ok(args.pcm.every((sample) => sample === 0));
  }
  const args = f.chunk();
  await assert.rejects(f.invoke('chunk', args), /STT failed/);
  assert.ok(args.pcm.every((sample) => sample === 0));
});

test('one in-flight chunk bounds memory; pause/stop wait, interrupt cancels through service', async () => {
  const pending = deferred();
  const f = fixture({ service: { transcribeChunk: () => pending.promise } });
  await f.start('microphone');
  const args = f.chunk();
  const first = f.invoke('chunk', args);
  const second = f.chunk();
  await assert.rejects(f.invoke('chunk', second), { code: 'meeting_busy' });
  assert.ok(second.pcm.every((sample) => sample === 0));
  for (const action of ['pause', 'stop']) await assert.rejects(f.invoke(action, { id }), { code: 'meeting_busy' });
  await f.boundary.interrupt('sleep');
  assert.deepEqual(f.events[0].detail, { id, reason: 'sleep' });
  assert.deepEqual(f.calls.at(-1), ['interrupt', { id, reason: 'sleep' }]);
  pending.reject(new Error('Cancelled'));
  await assert.rejects(first, /Cancelled/);
  assert.ok(args.pcm.every((sample) => sample === 0));
});

test('navigation during readiness cannot start recording after consent owner disappears', async () => {
  const pending = deferred();
  const f = fixture({ service: { readiness: () => pending.promise } });
  const start = f.start();
  await f.boundary.interrupt('navigation');
  pending.resolve({ available: true, modelId: 'test' });
  await assert.rejects(start, { code: 'meeting_interrupted' });
  assert.ok(f.calls.every(([operation]) => operation !== 'start'));
});

test('runtime change revokes capture and only the owner main frame can notify', async () => {
  const f = fixture();
  await f.start();
  await assert.rejects(f.boundary.runtimeChanging({ ...f.event, senderFrame: {} }), { code: 'meeting_forbidden' });
  await f.boundary.runtimeChanging(f.event);
  assert.deepEqual(f.events[0].detail, { id, reason: 'navigation' });
  assert.deepEqual(await f.display(), {});
  await assert.rejects(f.invoke('chunk', f.chunk()), { code: 'meeting_not_active' });
});

test('capture and partial-save failures reach the renderer; dispose still releases backend', async () => {
  const f = fixture({ boundary: { getSources: async () => { throw new Error('OS refused'); } } });
  await f.start();
  assert.deepEqual(await f.display(), {});
  assert.equal(f.events[0].detail.code, 'meeting_system_capture_failed');
  const failed = fixture({ service: { async interrupt() { throw new Error('Disk failed'); } } });
  await failed.start('microphone');
  await assert.rejects(failed.boundary.dispose(), /Disk failed/);
  assert.equal(failed.events.at(-1).detail.code, 'meeting_save_failed');
  assert.deepEqual(failed.calls.at(-1), ['dispose']);
});

test('main/preload wire private service, lifecycle and default-session capture without guest changes', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.mjs', import.meta.url), 'utf8');
  assert.match(main, /createMeetingService.*@openchamber\/web\/server\/lib\/meetings\/service\.js/);
  assert.match(main, /event\.sender !== window\.webContents/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /sameOrigin\(apiBaseUrl, state\.sidecarUrl/);
  assert.match(main, /session\.defaultSession\.setDisplayMediaRequestHandler/);
  assert.match(main, /useSystemPicker: false/);
  assert.match(main, /powerMonitor\.on\('suspend'/);
  assert.match(main, /meetingBoundary\.dispose\(\)/);
  assert.match(preload, /event === 'desktop:meeting-lifecycle'.*!isLocalPage.*window\.top !== window/);
});

test('optional summaries use authoritative closed transcript and explicit approval; enterprise refuses', async () => {
  const calls = [];
  const segments = [{ source: 'microphone', startMs: 0, endMs: 100, text: 'Private transcript' }];
  const result = { text: 'Summary', providerID: 'test', modelID: 'small', transcriptRevision: 'revision' };
  const summary = {
    async prepare(request) { calls.push(['prepare', request]); return { available: true, models: [], disclosure: { data: 'transcript-only' } }; },
    async generate(request) { calls.push(['generate', request]); return result; },
    dispose() {},
  };
  const f = fixture({
    service: {
      async get() { return { id, status: 'stopped', segments, notes: 'Never sent' }; },
      async saveSummary(value, saved) { calls.push(['save', value, saved]); return { id: value, summary: saved }; },
    },
    boundary: { summary },
  });
  await f.invoke('prepare_summary', { id });
  assert.deepEqual(calls[0], ['prepare', { meetingId: id, status: 'stopped', segments }]);
  await assert.rejects(f.invoke('generate_summary', { id, model: 'test/small', approvalToken: 'token', approved: false }), { code: 'meeting_invalid' });
  const saved = await f.invoke('generate_summary', { id, model: 'test/small', approvalToken: 'token', approved: true });
  assert.deepEqual(saved.summary, result);
  assert.equal(calls[1][1].approved, true);
  assert.equal(calls[1][1].notes, undefined);
  assert.deepEqual(calls[2], ['save', id, result]);
  const blocked = fixture({ boundary: { summary, isSummaryBlocked: () => true } });
  for (const action of ['prepare_summary', 'generate_summary']) {
    const args = action === 'generate_summary' ? { id, model: 'test/small', approvalToken: 'token', approved: true } : { id };
    await assert.rejects(blocked.invoke(action, args), { code: 'enterprise_mode' });
  }
  assert.equal(blocked.calls.length, 0);
  await assert.rejects(fixture({ boundary: { summary } }).invoke('prepare_summary', { id }), { code: 'meeting_not_closed' });
});

test('summary save errors do not return generated text as a saved record', async () => {
  const f = fixture({
    service: {
      async get() { return { id, status: 'interrupted', segments: [] }; },
      async saveSummary() { throw new Error('Save failed'); },
    },
    boundary: { summary: { async generate() { return { text: 'Unsaved summary' }; }, dispose() {} } },
  });
  await assert.rejects(f.invoke('generate_summary', { id, model: 'test/small', approvalToken: 'token', approved: true }), /Save failed/);
});
