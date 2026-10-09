import { z } from 'zod';

const idSchema = z.string().uuid();
const idArgs = z.object({ id: idSchema }).strict();
const schemas = {
  list: z.object({}).strict(),
  readiness: z.object({}).strict(),
  prepare_summary: idArgs.extend({ model: z.string().min(1).max(300).optional() }).strict(),
  generate_summary: idArgs.extend({ model: z.string().min(1).max(300), approvalToken: z.string().min(1).max(2048), approved: z.literal(true) }).strict(),
  create: z.object({ title: z.string().trim().min(1).max(300).optional(), calendarEventId: z.string().min(1).max(2048).optional() }).strict(),
  get: idArgs,
  notes: idArgs.extend({ notes: z.string().max(100_000) }).strict(),
  rename: idArgs.extend({ title: z.string().trim().min(1).max(300) }).strict(),
  start: idArgs.extend({ consent: z.literal(true), mode: z.enum(['system-and-microphone', 'microphone']) }).strict(),
  chunk: idArgs.extend({ source: z.enum(['microphone', 'system']), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative(), pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(16_000 * 90) }).strict(),
  pause: idArgs,
  resume: idArgs,
  stop: idArgs,
  interrupt: idArgs.extend({ reason: z.literal('capture-error') }).strict(),
};

const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const commandSchema = z.string().max(100).startsWith('desktop_meeting_');
export const isMeetingCommand = (command) => commandSchema.safeParse(command).success;

// Darwin 23.2 is macOS 14.2, the first supported Electron loopback candidate.
export const supportsMeetingSystemAudio = (platform, release) => {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  const [major, minor] = release.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 2);
};

/** Native authorization and capture grants only. Records and STT belong to web. */
export const createMeetingBoundary = ({ service, summary, isSummaryBlocked, authorize, getSources, systemAudioSupported, emit, now = Date.now }) => {
  let active = null;
  let starting = null;
  let grant = null;
  let controlBusy = false;
  let chunkBusy = false;
  let generation = 0;
  let closed = false;
  const summaryRequests = new Set();

  const capture = (mode) => ({ mode, degraded: mode === 'microphone', systemAudioSupported, systemAudioValidation: 'pending' });
  const requireOwner = (event, id) => {
    if (!active || active.id !== id || active.sender !== event.sender || active.frame !== event.senderFrame) {
      throw failure('meeting_not_active', 'This window does not own that recording.');
    }
  };

  const invoke = async (event, command, input = {}) => {
    // Check the actual frame and runtime on every call, including read-only calls.
    if (!authorize(event)) {
      if (command === 'desktop_meeting_chunk' && Array.isArray(input?.pcm)) input.pcm.fill(0);
      throw failure('meeting_forbidden', 'Meetings require the trusted local main application.');
    }
    if (closed) {
      if (command === 'desktop_meeting_chunk' && Array.isArray(input?.pcm)) input.pcm.fill(0);
      throw failure('meeting_closed', 'Meeting capture is shutting down.');
    }
    const action = command.slice('desktop_meeting_'.length);
    if (!Object.hasOwn(schemas, action)) throw failure('meeting_command', 'Unknown meeting command.');
    if (action === 'chunk' && chunkBusy) {
      input?.pcm?.fill?.(0);
      throw failure('meeting_busy', 'Wait for the current audio chunk to finish.');
    }
    const parsed = schemas[action].safeParse(input);
    if (!parsed.success) {
      if (action === 'chunk' && Array.isArray(input?.pcm)) input.pcm.fill(0);
      throw failure('meeting_invalid', 'Invalid meeting request.');
    }
    const args = parsed.data;
    if (action === 'readiness') return service.readiness();
    if (action === 'list') {
      const meetings = await service.list();
      const warnings = service.getWarnings();
      const readiness = await service.readiness();
      return { meetings, warnings, readiness, capture: { systemAudioSupported, systemAudioValidation: 'pending' } };
    }
    if (action === 'create') return service.create(args);
    if (action === 'get') return service.get(args.id);
    if (action === 'notes') return service.updateNotes(args.id, args.notes);
    if (action === 'rename') return service.rename(args.id, args.title);
    if (action === 'interrupt') {
      const owner = active ?? starting;
      if (owner && (owner.id !== args.id || owner.sender !== event.sender || owner.frame !== event.senderFrame)) {
        throw failure('meeting_not_active', 'This window does not own that recording.');
      }
      // Cancellation must bypass the busy gate, including an unanswered start.
      return interrupt(args.reason, event.sender, args.id);
    }
    if (action === 'prepare_summary' || action === 'generate_summary') {
      const epoch = generation;
      if (isSummaryBlocked()) throw failure('enterprise_mode', 'Meeting summaries are disabled by enterprise policy.');
      const meeting = await service.get(args.id);
      if (!['stopped', 'interrupted'].includes(meeting.status)) throw failure('meeting_not_closed', 'Stop recording before preparing a summary.');
      const requireSummaryOwner = () => {
        if (epoch !== generation || !authorize(event) || closed) throw failure('meeting_forbidden', 'Meeting summary approval is no longer available in this window.');
      };
      requireSummaryOwner();
      const request = { meetingId: meeting.id, status: meeting.status, segments: meeting.segments };
      if (args.model) request.model = args.model;
      if (action === 'prepare_summary') return summary.prepare(request);
      const controller = new AbortController();
      summaryRequests.add(controller);
      try {
        const result = await summary.generate({ ...request, approvalToken: args.approvalToken, approved: true }, { signal: controller.signal, authorize: requireSummaryOwner });
        requireSummaryOwner();
        // A stale transcript or failed write must not be reported as a saved summary.
        if (isSummaryBlocked()) throw failure('enterprise_mode', 'Meeting summaries are disabled by enterprise policy.');
        return await service.saveSummary(meeting.id, result);
      } finally { summaryRequests.delete(controller); }
    }
    if (action === 'chunk') {
      let pcm16k;
      try {
        requireOwner(event, args.id);
        if (controlBusy) throw failure('meeting_busy', 'Wait for the recording operation to finish.');
        if (active.paused) throw failure('meeting_paused', 'Recording is paused.');
        if (args.source === 'system' && (active.mode !== 'system-and-microphone' || !active.displayGranted)) {
          throw failure('meeting_source', 'System audio was not authorized for this recording.');
        }
        const duration = args.endMs - args.startMs;
        if (duration <= 0 || duration > 90_000 || Math.abs(args.pcm.length - duration * 16) > 16) {
          throw failure('meeting_audio', 'Audio must be 16 kHz mono and no longer than 90 seconds.');
        }
        chunkBusy = true;
        pcm16k = Float32Array.from(args.pcm);
        return await service.transcribeChunk(args.id, { source: args.source, startMs: args.startMs, endMs: args.endMs, pcm16k });
      } finally {
        pcm16k?.fill(0);
        args.pcm.fill(0);
        input.pcm.fill(0);
        chunkBusy = false;
      }
    }
    if (controlBusy || chunkBusy) throw failure('meeting_busy', 'Wait for the current recording operation to finish.');
    controlBusy = true;
    const epoch = generation;
    try {
      if (action === 'start') {
        if (active) throw failure('meeting_active', 'Stop the current recording first.');
        if (args.mode === 'system-and-microphone' && !systemAudioSupported) {
          throw failure('meeting_system_unsupported', 'System audio is unavailable here. Choose microphone-only capture explicitly.');
        }
        starting = { id: args.id, sender: event.sender, frame: event.senderFrame };
        const readiness = await service.readiness();
        if (!readiness.available) throw failure(readiness.reasonCode || 'meeting_model_unavailable', 'The local transcription model is not ready. No audio was captured.');
        if (epoch !== generation || !authorize(event)) throw failure('meeting_interrupted', 'Recording start was interrupted.');
        active = { id: args.id, sender: event.sender, frame: event.senderFrame, mode: args.mode, paused: false, displayGranted: false, displayConsent: args.mode === 'system-and-microphone' };
        try {
          const meeting = await service.start(args.id);
          if (epoch !== generation || !authorize(event)) {
            await service.interrupt({ id: args.id, reason: 'navigation' });
            active = null;
            throw failure('meeting_interrupted', 'Recording start was interrupted.');
          }
          if (args.mode === 'system-and-microphone') grant = { owner: active, expiresAt: now() + 30_000 };
          return { ...meeting, capture: capture(args.mode) };
        } catch (error) {
          active = null;
          grant = null;
          throw error;
        }
      }
      requireOwner(event, args.id);
      const meeting = await service[action](args.id);
      if (action === 'stop') { active = null; grant = null; }
      else if (active) {
        active.paused = action === 'pause';
        if (active.paused) { active.displayConsent = false; grant = null; }
      }
      return meeting;
    } finally {
      if (action === 'start') starting = null;
      controlBusy = false;
    }
  };

  const displayMedia = async (request, callback) => {
    const candidate = grant;
    const owner = candidate?.owner;
    const event = owner && { sender: owner.sender, senderFrame: request.frame };
    if (!candidate || candidate.expiresAt <= now() || owner !== active || owner.paused || !owner.displayConsent
      || request.frame !== owner.frame || !request.audioRequested || !request.videoRequested || !authorize(event)) {
      callback({});
      return;
    }
    // Consume before awaiting discovery. A second request cannot borrow consent.
    grant = null;
    try {
      const sources = await getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      if (!sources[0] || candidate.expiresAt <= now() || owner !== active || owner.paused || !owner.displayConsent || !authorize(event)) { callback({}); return; }
      owner.displayGranted = true;
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});
      emit(owner.sender, { id: owner.id, reason: 'capture-error', code: 'meeting_system_capture_failed' });
      try { await interrupt('capture-error', owner.sender, owner.id); }
      catch { /* interrupt already reports an explicit partial-save failure. */ }
    }
  };

  const interrupt = async (reason, sender, id) => {
    const owner = active ?? starting;
    if (sender && owner && (owner.sender !== sender || (id && owner.id !== id))) return null;
    generation += 1;
    for (const controller of summaryRequests) controller.abort();
    grant = null;
    active = null;
    starting = null;
    if (owner) emit(owner.sender, { id: owner.id, reason });
    try {
      const request = { reason };
      if (owner || id) request.id = owner?.id ?? id;
      return await service.interrupt(request);
    } catch (error) {
      if (owner) emit(owner.sender, { id: owner.id, reason, code: 'meeting_save_failed' });
      throw error;
    }
  };

  const dispose = async () => {
    closed = true;
    summary.dispose();
    try { await interrupt('quit'); }
    finally { await service.dispose(); }
  };
  const runtimeChanging = async (event) => {
    if (!authorize(event)) throw failure('meeting_forbidden', 'Only the trusted main application may interrupt its recording.');
    return interrupt('navigation', event.sender);
  };
  return { invoke, displayMedia, interrupt, runtimeChanging, dispose };
};
