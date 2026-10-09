import { EventEmitter } from 'node:events';
import { DictationWorkerClient } from '../dictation/local/worker-client.js';
import { meetingError } from './storage.js';

const interrupted = () => meetingError('interrupted', 'Meeting transcription was interrupted.');
const failed = (message = 'Local transcription failed.') => meetingError('transcription_failed', message);

// Resolves only once the OS confirms the worker process is gone. Callers stay
// busy until then so audio-bearing memory never outlives the call that owned it.
function joinWorkerClosure(client, terminated) {
  const worker = client.worker ?? terminated;
  const closed = worker && worker.exitCode === null && worker.signalCode === null
    ? new Promise((resolve) => {
      const killTimer = setTimeout(() => worker.kill('SIGKILL'), 1000);
      worker.once('close', () => { clearTimeout(killTimer); resolve(); });
    }) : Promise.resolve();
  client.shutdown();
  return closed;
}

/**
 * One speech worker kept warm for the length of a recording.
 *
 * Loading the speech model for every chunk made live text impossible: each
 * short chunk paid a full process start plus model load. The worker now stays
 * up while a meeting records, so a chunk costs only its decode. It holds no
 * audio between chunks (the session discards a segment when it commits), and
 * `release()` kills the process whenever recording pauses, stops, is
 * interrupted or the service closes. Aborts, timeouts and any decode error
 * also kill it; the next chunk starts a fresh worker.
 */
export function createMeetingTranscriber({ modelsDir, modelId, workerFactory = () => new DictationWorkerClient() }) {
  let current = null;
  let opening = null;

  const close = (state) => {
    if (!state) return Promise.resolve();
    if (current === state) current = null;
    state.broken = true;
    // Memoized so every caller joins the same confirmed process closure.
    state.closed ??= joinWorkerClosure(state.client, state.client.worker);
    return state.closed;
  };

  const open = () => {
    if (current && !current.broken) return Promise.resolve(current);
    opening ??= (async () => {
      if (current) await close(current);
      const client = workerFactory();
      const emitter = new EventEmitter();
      const state = { client, emitter, sessionId: null, broken: false };
      // A worker that dies while idle must not throw from the emitter, and
      // must make the next chunk build a fresh worker.
      emitter.on('error', () => { state.broken = true; });
      current = state;
      try {
        const session = await client.createSession({ modelsDir, modelId }, emitter);
        if (session.requiredSampleRate !== 16000) throw failed('Local model requires an unsupported sample rate.');
        state.sessionId = session.sessionId;
        return state;
      } catch (error) {
        await close(state);
        throw error;
      }
    })().finally(() => { opening = null; });
    return opening;
  };

  /** Starts the worker and loads the model without waiting for audio. */
  const warm = () => open().then(() => undefined, () => undefined);

  const transcribe = async (audio, signal) => {
    if (signal.aborted) throw interrupted();
    let state = null;
    let closing = null;
    let rejectResult = () => {};
    let removeListeners = () => {};
    const onAbort = () => {
      rejectResult(interrupted());
      if (state) closing ??= close(state);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      state = await open();
      if (signal.aborted) { closing ??= close(state); throw interrupted(); }
      const { client, emitter, sessionId } = state;
      const result = new Promise((resolve, reject) => {
        rejectResult = reject;
        const onTranscript = (payload) => { resolve(payload.transcript); };
        const onError = () => { reject(failed()); };
        emitter.on('transcript', onTranscript);
        emitter.on('error', onError);
        removeListeners = () => { emitter.off('transcript', onTranscript); emitter.off('error', onError); };
      });
      // The worker can fail while append/commit is pending.
      void result.catch(() => {});
      await client.sendRequest({ type: 'session.append', sessionId, audio });
      if (signal.aborted) throw interrupted();
      const commit = client.sendRequest({ type: 'session.commit', sessionId });
      const [text] = await Promise.all([result, commit]);
      return text;
    } catch (error) {
      // Never reuse a worker after an uncertain decode.
      if (state) closing ??= close(state);
      throw error;
    } finally {
      removeListeners();
      signal.removeEventListener('abort', onAbort);
      if (closing) await closing;
    }
  };

  /** Kills the worker and waits for the OS to confirm it is gone. */
  const release = async () => {
    if (opening) await opening.catch(() => {});
    await close(current);
  };

  return { warm, transcribe, release };
}

// One-shot form: a dedicated worker for a single chunk, closed before return.
export async function transcribeLocalChunk({ audio, modelsDir, modelId, signal, workerFactory }) {
  const transcriber = createMeetingTranscriber({ modelsDir, modelId, workerFactory });
  try {
    return await transcriber.transcribe(audio, signal);
  } finally {
    await transcriber.release();
    audio.fill(0);
  }
}
