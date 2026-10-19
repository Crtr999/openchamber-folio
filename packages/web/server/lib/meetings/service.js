import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_LOCAL_STT_MODEL, isLocalSttModelId } from '../dictation/local/model-catalog.js';
import { isLocalSttModelInstalled } from '../dictation/local/model-downloader.js';
import { createMeetingStorage, meetingError } from './storage.js';
import { createMeetingTranscriber } from './local-transcriber.js';
import { registerPrivateMeetingDirectory } from './private-paths.js';

const SUMMARY = {
  status: 'unavailable',
  reason: 'Meeting summaries are not connected to an approved provider. Your transcript stays on this device.',
};
const owners = new Set();
const sources = new Set(['microphone', 'system']);
const reasons = new Set(['sleep', 'quit', 'navigation', 'renderer-gone', 'capture-error']);
const titleSchema = z.string().trim().min(1).max(300);
const notesSchema = z.string().max(100000);
const transcriptTextSchema = z.string().max(100000);
const isRecordFailure = (error, id) => error.meetingId === id && ['invalid_record', 'unsafe_storage', 'not_found'].includes(error.code);

export function createMeetingService({ directory, modelsDir = path.join(os.homedir(), '.config', 'openchamber', 'speech-models'), modelId = DEFAULT_LOCAL_STT_MODEL, timeoutMs = 120000, workerFactory } = {}) {
  const storage = createMeetingStorage(directory);
  // One speech worker stays warm while a meeting records (see local-transcriber.js).
  const transcriber = createMeetingTranscriber({ modelsDir, modelId, workerFactory });
  if (!isLocalSttModelId(modelId)) throw meetingError('invalid_model', 'Choose a catalog local transcription model.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw meetingError('invalid_timeout', 'Invalid transcription timeout.');
  if (owners.has(directory)) throw meetingError('busy', 'Meeting storage is already open.');
  registerPrivateMeetingDirectory(directory);
  owners.add(directory);
  let initialization;
  let queue = Promise.resolve();
  let activeId = null;
  let pending = null;
  let disposed = false;
  let closing = false;
  let warnings = [];
  const ready = () => {
    initialization ??= (async () => {
      await storage.initialize();
      for (const id of await storage.ids()) {
        let record;
        try { record = await storage.read(id); } catch (error) {
          // A damaged record stays on disk and list reports a warning. It must
          // not prevent another meeting from being opened or recovered.
          if (isRecordFailure(error, id)) continue;
          throw error;
        }
        if (record.status === 'recording' || record.status === 'paused') {
          await storage.write({ ...record, status: 'interrupted', interruptionReason: 'crash', updatedAt: new Date().toISOString() });
        }
      }
    })();
    return initialization;
  };
  const serialized = (action, allowClosing = false) => {
    const operation = queue.then(async () => {
      if (disposed || (closing && !allowClosing)) throw meetingError('disposed', 'Meeting service is closed.');
      await ready();
      return action();
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const save = async (record, changes) => {
    const next = { ...record, ...changes, updatedAt: new Date().toISOString() };
    await storage.write(next);
    return next;
  };
  const readiness = async () => {
    if (disposed || closing) throw meetingError('disposed', 'Meeting service is closed.');
    const available = await isLocalSttModelInstalled(modelsDir, modelId);
    if (available) return { available, modelId };
    return { available, modelId, reasonCode: 'models_missing' };
  };
  const requireModel = async () => {
    if (!(await readiness()).available) throw meetingError('models_missing', 'Download a local speech model in Dictation settings before recording a meeting.');
  };
  const list = () => serialized(async () => {
    const result = [];
    const failures = [];
    for (const id of await storage.ids()) {
      try { result.push(await storage.read(id)); } catch (error) {
        if (!isRecordFailure(error, id)) throw error;
        failures.push({ id, code: error.code, message: error.message });
      }
    }
    warnings = failures;
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  const getWarnings = () => warnings.map((warning) => ({ ...warning }));
  const get = (id) => serialized(() => storage.read(id));
  const create = ({ title = 'Untitled meeting', calendarEventId } = {}) => serialized(async () => {
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) throw meetingError('invalid_title', 'Meeting title must be between 1 and 300 characters.');
    const now = new Date().toISOString();
    const record = { version: 1, id: randomUUID(), title: parsed.data, createdAt: now, updatedAt: now, status: 'draft', interruptionReason: null, notes: '', segments: [], summary: { ...SUMMARY } };
    if (calendarEventId !== undefined) {
      const event = z.string().min(1).max(2048).safeParse(calendarEventId);
      if (!event.success) throw meetingError('invalid_calendar_event', 'Invalid meeting calendar link.');
      record.calendarEventId = event.data;
    }
    await storage.write(record);
    return record;
  });
  const rename = (id, title) => serialized(async () => {
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) throw meetingError('invalid_title', 'Meeting title must be between 1 and 300 characters.');
    return save(await storage.read(id), { title: parsed.data });
  });
  const updateNotes = (id, notes) => serialized(async () => {
    const parsed = notesSchema.safeParse(notes);
    if (!parsed.success) throw meetingError('invalid_notes', 'Meeting notes are too long or invalid.');
    return save(await storage.read(id), { notes: parsed.data });
  });
  // Only the native approval/provider boundary may call this persistence hook.
  // It has no provider access and never prepares or generates a summary.
  const saveSummary = (id, result) => serialized(async () => {
    const record = await storage.read(id);
    if (!['stopped', 'interrupted'].includes(record.status)) throw meetingError('invalid_state', 'Stop the meeting before saving a summary.');
    const revision = createHash('sha256').update(JSON.stringify(record.segments.map(({ source, startMs, endMs, text }) => ({ source, startMs, endMs, text })))).digest('hex');
    if (result?.transcriptRevision !== revision) throw meetingError('stale_transcript', 'The transcript changed. Approve the summary again.');
    return save(record, { summary: { status: 'available', text: result.text, providerID: result.providerID, modelID: result.modelID, transcriptRevision: revision, createdAt: new Date().toISOString() } });
  });
  const transition = (id, from, status) => serialized(async () => {
    if (pending) throw meetingError('busy', 'Wait for the current audio chunk to finish.');
    const record = await storage.read(id);
    if (!from.includes(record.status) || (activeId && activeId !== id)) throw meetingError('invalid_state', 'Meeting cannot change state now.');
    if (status === 'recording') await requireModel();
    const next = await save(record, { status, interruptionReason: null });
    activeId = status === 'stopped' ? null : id;
    // Load the model while the renderer is still opening devices, so the first
    // chunk is decoded immediately. Any non-recording state ends the worker.
    if (status === 'recording') void transcriber.warm();
    else {
      // The saved state is already authoritative. Wait briefly for the worker
      // to exit, but never let a slow process shutdown turn a successful
      // pause/stop into a renderer timeout; the closure finishes on its own.
      const releasing = transcriber.release().catch(() => {});
      let timer;
      await Promise.race([releasing, new Promise((resolve) => { timer = setTimeout(resolve, 4000); })]);
      clearTimeout(timer);
    }
    return next;
  });
  // A closed meeting (stopped or interrupted by quit, sleep or a crash) can be
  // reopened: new phrases append to the saved transcript and notes.
  const start = (id) => transition(id, ['draft', 'stopped', 'interrupted'], 'recording');
  const pause = (id) => transition(id, ['recording'], 'paused');
  const resume = (id) => transition(id, ['paused'], 'recording');
  const stop = (id) => transition(id, ['recording', 'paused', 'interrupted'], 'stopped');

  const transcribeChunk = async (id, chunk) => {
    const input = chunk?.pcm16k;
    let audio;
    let job;
    try {
      if (pending) throw meetingError('busy', 'A meeting audio chunk is already being transcribed.');
      if ((!Array.isArray(input) && !(input instanceof Float32Array)) || input.length < 1 || input.length > 16000 * 90 ||
        !sources.has(chunk.source) || !Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) || chunk.startMs < 0 ||
        chunk.endMs <= chunk.startMs || chunk.endMs - chunk.startMs > 90000 ||
        Math.abs(chunk.endMs - chunk.startMs - input.length / 16) > 1) {
        throw meetingError('invalid_audio', 'Provide at most 90 seconds of mono 16 kHz audio with matching timestamps.');
      }
      const controller = new AbortController();
      job = { id, controller, done: null };
      pending = job;
      job.done = (async () => {
        await serialized(async () => {
          const record = await storage.read(id);
          if (activeId !== id || record.status !== 'recording') throw meetingError('invalid_state', 'Meeting is not recording.');
          const last = record.segments.findLast((segment) => segment.source === chunk.source);
          if (last && chunk.startMs < last.endMs) throw meetingError('invalid_audio', 'Meeting chunks must not overlap for the same source.');
          await requireModel();
        });
        if (controller.signal.aborted) throw meetingError('interrupted', 'Meeting transcription was interrupted.');
        audio = Buffer.alloc(input.length * 2);
        let peak = 0;
        for (let i = 0; i < input.length; i += 1) {
          const sample = input[i];
          if (!Number.isFinite(sample) || sample < -1 || sample > 1) throw meetingError('invalid_audio', 'Audio samples must be normalized finite numbers.');
          const value = Math.round(sample * (sample < 0 ? 32768 : 32767));
          audio.writeInt16LE(value, i * 2);
          peak = Math.max(peak, Math.abs(value));
        }
        input.fill(0);
        let timer;
        let text = '';
        try {
          timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
          if (peak >= 300) text = await transcriber.transcribe(audio, controller.signal);
          if (controller.signal.aborted) throw meetingError(controller.signal.reason === 'timeout' ? 'timeout' : 'interrupted', 'Meeting transcription did not complete.');
        } catch (error) {
          if (controller.signal.aborted) throw meetingError(controller.signal.reason === 'timeout' ? 'timeout' : 'interrupted', 'Meeting transcription did not complete.');
          if (error.code) throw error;
          throw meetingError('transcription_failed', 'Local transcription failed. No audio was saved.');
        } finally { clearTimeout(timer); }
        audio.fill(0);
        const parsed = transcriptTextSchema.safeParse(text);
        if (!parsed.success) throw meetingError('transcription_failed', 'Local transcription returned an invalid result.');
        return serialized(async () => {
          if (controller.signal.aborted) throw meetingError('interrupted', 'Meeting transcription was interrupted.');
          const record = await storage.read(id);
          if (record.status !== 'recording') throw meetingError('interrupted', 'Meeting is no longer recording.');
          if (!text.trim()) return record;
          const segment = { source: chunk.source, label: chunk.source === 'microphone' ? 'Microphone' : 'System audio', startMs: chunk.startMs, endMs: chunk.endMs, text: text.trim(), createdAt: new Date().toISOString() };
          return save(record, { segments: [...record.segments, segment] });
        });
      })();
      return await job.done;
    } finally {
      if (Array.isArray(input) || input instanceof Float32Array) input.fill(0);
      audio?.fill(0);
      if (pending === job) pending = null;
    }
  };
  const interrupt = async ({ id, reason } = {}) => {
    if (!reasons.has(reason)) throw meetingError('invalid_reason', 'Invalid meeting interruption reason.');
    if (pending && (!id || pending.id === id)) {
      pending.controller.abort(reason);
      await pending.done.catch(() => {});
    }
    return serialized(async () => {
      try {
        const target = id ?? activeId;
        if (!target) return null;
        const record = await storage.read(target);
        if (!['recording', 'paused'].includes(record.status)) return record;
        const next = await save(record, { status: 'interrupted', interruptionReason: reason });
        if (activeId === target) activeId = null;
        return next;
      } finally { await transcriber.release(); }
    }, true);
  };
  const dispose = async () => {
    if (disposed) return;
    closing = true;
    try { await interrupt({ reason: 'quit' }); } finally {
      await transcriber.release();
      disposed = true;
      owners.delete(directory);
    }
  };
  return { list, getWarnings, create, get, rename, updateNotes, notes: updateNotes, saveSummary, start, pause, resume, stop, transcribeChunk, chunk: transcribeChunk, interrupt, readiness, dispose };
}
