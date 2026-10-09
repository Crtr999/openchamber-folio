import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, symlink, rm, realpath, link, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createMeetingService } from './service.js';
import { DEFAULT_LOCAL_STT_MODEL, getLocalSttModelSpec } from '../dictation/local/model-catalog.js';
import { isPrivateMeetingPath } from './private-paths.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service?.dispose().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function setup({ installed = true, behavior = 'success', timeoutMs = 500 } = {}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'meeting-test-'));
  const directory = path.join(root, 'private-meetings');
  const modelsDir = path.join(root, 'models');
  if (installed) {
    const spec = getLocalSttModelSpec(DEFAULT_LOCAL_STT_MODEL);
    const modelDir = path.join(modelsDir, spec.extractedDir);
    await mkdir(modelDir, { recursive: true });
    for (const file of spec.requiredFiles) await writeFile(path.join(modelDir, file), 'synthetic model fixture, never loaded');
  }
  const workers = [];
  const workerFactory = () => {
    const worker = {
      emitter: null, audio: null, shutDown: false, rejectCommit: null,
      async createSession(config, emitter) {
        this.emitter = emitter;
        return { sessionId: 'synthetic-session', requiredSampleRate: 16000 };
      },
      async sendRequest(request) {
        if (request.type === 'session.append') this.audio = request.audio;
        if (request.type === 'session.commit') {
          if (behavior === 'failure') throw new Error('Synthetic internal failure');
          if (behavior === 'hang') return new Promise((resolve, reject) => { this.rejectCommit = reject; });
          this.emitter.emit('transcript', { transcript: 'Synthetic test speech' });
        }
      },
      shutdown() { this.shutDown = true; this.rejectCommit?.(new Error('Worker closed')); },
    };
    workers.push(worker);
    return worker;
  };
  const options = { directory, modelsDir, workerFactory, timeoutMs };
  const fixture = { root, directory, workers, options, service: createMeetingService(options) };
  fixtures.push(fixture);
  return fixture;
}
const chunk = (source = 'microphone', startMs = 0) => ({ source, startMs, endMs: startMs + 100, pcm16k: new Array(1600).fill(0.25) });
async function recording(fixture) {
  const meeting = await fixture.service.create({ title: 'Synthetic meeting' });
  await fixture.service.start(meeting.id);
  return meeting;
}
async function waitForCommit(fixture) {
  for (let i = 0; i < 100; i += 1) {
    if (fixture.workers[0]?.rejectCommit) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Synthetic worker never received commit');
}

describe('private local meetings', () => {
  it('registers HTTP filesystem exclusion before first use and keeps it after dispose', async () => {
    const fixture = await setup();
    expect(await isPrivateMeetingPath(path.join(fixture.directory, 'future-record.json'))).toBe(true);
    await fixture.service.dispose();
    expect(await isPrivateMeetingPath(path.join(fixture.directory, 'future-record.json'))).toBe(true);
  });

  it('persists optional calendar links locally but excludes them from transcript approval', async () => {
    const fixture = await setup();
    const created = await fixture.service.create({ title: 'Synthetic linked meeting', calendarEventId: 'synthetic-event-id' });
    expect((await fixture.service.get(created.id)).calendarEventId).toBe('synthetic-event-id');
    await expect(fixture.service.create({ calendarEventId: '' })).rejects.toMatchObject({ code: 'invalid_calendar_event' });
  });

  it('persists only text, labels sources, and uses restricted modes', async () => {
    const fixture = await setup();
    const meeting = await recording(fixture);
    const input = chunk();
    let result = await fixture.service.chunk(meeting.id, input);
    expect(input.pcm16k.every((sample) => sample === 0)).toBe(true);
    expect(fixture.workers[0].audio.every((byte) => byte === 0)).toBe(true);
    // The speech worker stays warm between chunks so text can arrive live.
    expect(fixture.workers[0].shutDown).toBe(false);
    result = await fixture.service.chunk(meeting.id, chunk('system'));
    expect(fixture.workers).toHaveLength(1);
    expect(result.segments.map((s) => s.label)).toEqual(['Microphone', 'System audio']);
    expect(result.summary.status).toBe('unavailable');
    await fixture.service.notes(meeting.id, 'Synthetic notes');
    await fixture.service.pause(meeting.id);
    expect(fixture.workers[0].shutDown).toBe(true);
    await fixture.service.resume(meeting.id);
    await fixture.service.stop(meeting.id);
    expect(fixture.workers.every((worker) => worker.shutDown)).toBe(true);
    const files = await readdir(fixture.directory);
    expect(files).toEqual([`${meeting.id}.json`]);
    expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(fixture.directory, files[0]))).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(path.join(fixture.directory, files[0]), 'utf8'));
    expect(saved.notes).toBe('Synthetic notes');
    expect(saved.status).toBe('stopped');
    expect(saved).not.toHaveProperty('audio');
    expect(saved).not.toHaveProperty('pcm16k');
    await fixture.service.dispose();
    fixture.service = createMeetingService(fixture.options);
    expect((await fixture.service.get(meeting.id)).segments).toEqual(result.segments);
  });

  it('does not download or use hosted STT when a local model is missing', async () => {
    const fixture = await setup({ installed: false });
    const meeting = await fixture.service.create();
    expect(await fixture.service.readiness()).toEqual({ available: false, modelId: DEFAULT_LOCAL_STT_MODEL, reasonCode: 'models_missing' });
    await expect(fixture.service.start(meeting.id)).rejects.toMatchObject({ code: 'models_missing' });
    expect((await fixture.service.get(meeting.id)).status).toBe('draft');
    expect(fixture.workers).toHaveLength(0);
    expect(await readdir(fixture.root)).toEqual(['private-meetings']);
  });

  it('bounds samples and clears PCM on invalid state and invalid audio', async () => {
    const fixture = await setup();
    const meeting = await fixture.service.create();
    const draftChunk = chunk();
    await expect(fixture.service.chunk(meeting.id, draftChunk)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(draftChunk.pcm16k.every((sample) => sample === 0)).toBe(true);
    await fixture.service.start(meeting.id);
    for (const invalid of [
      { ...chunk(), source: 'speaker-1' },
      { ...chunk(), endMs: 90001 },
      { ...chunk(), pcm16k: [NaN], endMs: 0.0625 },
      { ...chunk(), pcm16k: new Array(16000 * 90 + 1).fill(0.1), endMs: 90000 },
    ]) {
      await expect(fixture.service.chunk(meeting.id, invalid)).rejects.toMatchObject({ code: 'invalid_audio' });
      expect(invalid.pcm16k.every((sample) => sample === 0)).toBe(true);
    }
    // Starting warms a worker, but invalid audio is never sent to it.
    expect(fixture.workers.every((worker) => worker.audio === null)).toBe(true);
  });

  it('accepts the 90-second boundary, rejects replay and preserves committed text', async () => {
    const fixture = await setup();
    const meeting = await recording(fixture);
    const maximum = { source: 'microphone', startMs: 0, endMs: 90000, pcm16k: new Float32Array(16000 * 90).fill(0.25) };
    const result = await fixture.service.chunk(meeting.id, maximum);
    expect(result.segments).toHaveLength(1);
    expect(maximum.pcm16k.every((sample) => sample === 0)).toBe(true);
    await expect(fixture.service.chunk(meeting.id, chunk())).rejects.toMatchObject({ code: 'invalid_audio' });
    expect((await fixture.service.get(meeting.id)).segments).toEqual(result.segments);
  });

  it('preserves the previous notes on a failed atomic write', async () => {
    const fixture = await setup();
    const meeting = await fixture.service.create();
    await fixture.service.notes(meeting.id, 'Original synthetic notes');
    await chmod(fixture.directory, 0o500);
    try {
      await expect(fixture.service.notes(meeting.id, 'Must not replace notes')).rejects.toMatchObject({ code: 'EACCES' });
    } finally { await chmod(fixture.directory, 0o700); }
    expect((await fixture.service.get(meeting.id)).notes).toBe('Original synthetic notes');
    expect(await readdir(fixture.directory)).toEqual([`${meeting.id}.json`]);
  });

  it('rejects concurrent chunks and clears failed or timed out decode buffers', async () => {
    const fixture = await setup({ behavior: 'hang', timeoutMs: 60 });
    const meeting = await recording(fixture);
    const input = chunk();
    const first = fixture.service.chunk(meeting.id, input);
    const failure = first.catch((error) => error);
    await waitForCommit(fixture);
    const second = chunk('system');
    await expect(fixture.service.chunk(meeting.id, second)).rejects.toMatchObject({ code: 'busy' });
    expect(second.pcm16k.every((sample) => sample === 0)).toBe(true);
    await expect(fixture.service.stop(meeting.id)).rejects.toMatchObject({ code: 'busy' });
    expect(await failure).toMatchObject({ code: 'timeout' });
    expect(input.pcm16k.every((sample) => sample === 0)).toBe(true);
    expect(fixture.workers[0].audio.every((byte) => byte === 0)).toBe(true);
    expect((await fixture.service.get(meeting.id)).segments).toEqual([]);
    await fixture.service.stop(meeting.id);
  });

  it('interrupt cancels an in-flight chunk without persisting late results', async () => {
    const fixture = await setup({ behavior: 'hang' });
    const meeting = await recording(fixture);
    const first = fixture.service.chunk(meeting.id, chunk());
    const failure = first.catch((error) => error);
    await waitForCommit(fixture);
    const result = await fixture.service.interrupt({ reason: 'sleep' });
    expect(await failure).toMatchObject({ code: 'interrupted' });
    expect(result.status).toBe('interrupted');
    expect(result.interruptionReason).toBe('sleep');
    expect(result.segments).toEqual([]);
    expect(fixture.workers[0].shutDown).toBe(true);
  });

  it('capture-error bypasses busy stop and persists interrupted partial text', async () => {
    const fixture = await setup({ behavior: 'hang' });
    const meeting = await recording(fixture);
    const partial = await fixture.service.get(meeting.id);
    partial.segments.push({ source: 'microphone', label: 'Microphone', startMs: 0, endMs: 100, text: 'Synthetic committed partial', createdAt: partial.createdAt });
    await writeFile(path.join(fixture.directory, `${meeting.id}.json`), JSON.stringify(partial));
    const input = chunk('microphone', 100);
    const pending = fixture.service.chunk(meeting.id, input);
    const failure = pending.catch((error) => error);
    await waitForCommit(fixture);
    await expect(fixture.service.stop(meeting.id)).rejects.toMatchObject({ code: 'busy' });
    const interrupted = await fixture.service.interrupt({ id: meeting.id, reason: 'capture-error' });
    expect(await failure).toMatchObject({ code: 'interrupted' });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.interruptionReason).toBe('capture-error');
    expect(interrupted.segments).toEqual(partial.segments);
    expect((await fixture.service.get(meeting.id)).segments).toEqual(partial.segments);
    expect(input.pcm16k.every((sample) => sample === 0)).toBe(true);
    expect(fixture.workers[0].audio.every((byte) => byte === 0)).toBe(true);
    expect(fixture.workers[0].shutDown).toBe(true);
  });

  it('skips silence and preserves earlier text on worker failure', async () => {
    const fixture = await setup({ behavior: 'failure' });
    const meeting = await recording(fixture);
    const silent = chunk();
    silent.pcm16k.fill(0);
    expect((await fixture.service.chunk(meeting.id, silent)).segments).toEqual([]);
    expect(fixture.workers.every((worker) => worker.audio === null)).toBe(true);
    const input = chunk();
    await expect(fixture.service.chunk(meeting.id, input)).rejects.toMatchObject({ code: 'transcription_failed' });
    expect(fixture.workers[0].audio.every((byte) => byte === 0)).toBe(true);
    expect((await fixture.service.get(meeting.id)).status).toBe('recording');
  });

  it('recovers a crashed partial meeting and does not erase complete records', async () => {
    const fixture = await setup();
    const meeting = await recording(fixture);
    await fixture.service.chunk(meeting.id, chunk());
    await fixture.service.dispose();
    const file = path.join(fixture.directory, `${meeting.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.status = 'recording';
    await writeFile(file, JSON.stringify(record));
    fixture.service = createMeetingService(fixture.options);
    const recovered = await fixture.service.get(meeting.id);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.interruptionReason).toBe('crash');
    expect(recovered.segments).toHaveLength(1);
  });

  it('rejects traversal, directory symlinks, file symlinks and hard links', async () => {
    const fixture = await setup();
    const meeting = await fixture.service.create();
    await expect(fixture.service.get('../outside')).rejects.toMatchObject({ code: 'invalid_id' });
    const outside = path.join(fixture.root, 'outside.json');
    await writeFile(outside, 'private synthetic outside');
    const file = path.join(fixture.directory, `${meeting.id}.json`);
    await rm(file);
    await symlink(outside, file);
    await expect(fixture.service.get(meeting.id)).rejects.toMatchObject({ code: 'unsafe_storage' });
    await expect(fixture.service.notes(meeting.id, 'do not write')).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(await readFile(outside, 'utf8')).toBe('private synthetic outside');
    const linked = path.join(fixture.root, 'linked');
    await symlink(fixture.directory, linked);
    const service = createMeetingService({ ...fixture.options, directory: linked });
    await expect(service.list()).rejects.toMatchObject({ code: 'unsafe_storage' });
    await service.dispose().catch(() => {});
    await rm(file);
    await link(outside, file);
    await expect(fixture.service.get(meeting.id)).rejects.toMatchObject({ code: 'unsafe_storage' });
  });

  it('rejects corrupted records without preventing access to unrelated records', async () => {
    const fixture = await setup();
    const first = await fixture.service.create();
    const second = await fixture.service.create();
    await fixture.service.dispose();
    await writeFile(path.join(fixture.directory, `${first.id}.json`), '{broken');
    fixture.service = createMeetingService(fixture.options);
    expect((await fixture.service.get(second.id)).id).toBe(second.id);
    expect((await fixture.service.list()).map((meeting) => meeting.id)).toEqual([second.id]);
    expect(fixture.service.getWarnings()).toEqual([{ id: first.id, code: 'invalid_record', message: 'Meeting record is damaged.' }]);
    const third = await fixture.service.create();
    expect((await fixture.service.get(third.id)).id).toBe(third.id);
    expect(await readFile(path.join(fixture.directory, `${first.id}.json`), 'utf8')).toBe('{broken');
    await writeFile(path.join(fixture.directory, `${second.id}.json`), '{broken');
    await writeFile(path.join(fixture.directory, `${third.id}.json`), '{broken');
    expect(await fixture.service.list()).toEqual([]);
    expect(fixture.service.getWarnings()).toHaveLength(3);
  });

  it('does not hide unsafe directories as record warnings, even after initialization', async () => {
    const fixture = await setup();
    const meeting = await fixture.service.create();
    await fixture.service.list();
    await rm(fixture.directory, { recursive: true });
    const replacement = path.join(fixture.root, 'replacement');
    await mkdir(replacement);
    await symlink(replacement, fixture.directory);
    await expect(fixture.service.list()).rejects.toMatchObject({ code: 'unsafe_storage' });
    await expect(fixture.service.get(meeting.id)).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(fixture.service.getWarnings()).toEqual([]);
  });

  it('rejects new work as soon as dispose begins', async () => {
    const fixture = await setup();
    await fixture.service.create();
    const disposal = fixture.service.dispose();
    await expect(fixture.service.create()).rejects.toMatchObject({ code: 'disposed' });
    await disposal;
  });

  it('persists explicit summaries only for a closed matching transcript revision', async () => {
    const fixture = await setup();
    const meeting = await recording(fixture);
    const recorded = await fixture.service.chunk(meeting.id, chunk());
    const transcriptRevision = createHash('sha256').update(JSON.stringify(recorded.segments.map(({ source, startMs, endMs, text }) => ({ source, startMs, endMs, text })))).digest('hex');
    const result = { text: 'Synthetic approved summary', providerID: 'synthetic', modelID: 'test-model', transcriptRevision };
    await expect(fixture.service.saveSummary(meeting.id, result)).rejects.toMatchObject({ code: 'invalid_state' });
    await fixture.service.stop(meeting.id);
    await expect(fixture.service.saveSummary(meeting.id, { ...result, transcriptRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'stale_transcript' });
    expect((await fixture.service.get(meeting.id)).summary.status).toBe('unavailable');
    await fixture.service.updateNotes(meeting.id, 'Notes are not part of approval');
    const saved = await fixture.service.saveSummary(meeting.id, result);
    expect(saved.summary).toMatchObject({ ...result, status: 'available' });
    expect((await fixture.service.get(meeting.id)).summary).toEqual(saved.summary);
  });
});
