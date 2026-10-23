/**
 * The folder friend learns on its own.
 *
 * A friend is a folder: every conversation in that folder is the same
 * relationship, and what the earlier ones worked out belongs to the later
 * ones. The agent can save a memory when it thinks to — the `openchamber_memory`
 * tool exists for that — but an agent only remembers what it noticed at the
 * time, and the user did not ask to remind it. This runtime closes that gap:
 * when a conversation in a folder ends, the turns since the last capture are
 * read, distilled by a small model, and stored in the folder's project memory.
 *
 * The store, the tool and the delivery of stored memory to later sessions are
 * all `agent-memory` and `session-knowledge`. This is the one piece that was
 * missing: somebody has to write the memory down.
 *
 * What it is careful about:
 *
 * - **It runs after the turn, never during it.** A capture is background work
 *   on a conversation that already ended; nothing the user is waiting for
 *   depends on it, and a failure is silent.
 * - **It only ever writes to the project the conversation ran in.** The scope
 *   comes from the session's directory, never from the model.
 * - **It distils through the provider the conversation itself used.** A folder
 *   bound to one provider — a ZDR folder is the case that matters — must not
 *   reach another provider to be summarised. If no small model in that provider
 *   exists, nothing is captured.
 * - **It reads each turn once.** A cursor remembers the last message that was
 *   distilled, so a long conversation is captured turn by turn instead of
 *   re-summarised from the top every time.
 */

import { OpenCode } from '@opencode/client';
import { loadSettledTurns } from '../session-assist/context.js';
import { buildCapturePrompt, buildCaptureSystemPrompt, parseCaptureResponse } from './prompt.js';

/** How long a conversation has to be quiet before it is distilled. */
const CAPTURE_QUIET_MS = 20_000;
/** How many settled turns are read at once. */
const CAPTURE_TURN_WINDOW = 8;
/** How many entries one capture may add. */
const MAX_ENTRIES_PER_CAPTURE = 4;
const GENERATION_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const createSessionMemoryCaptureRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  agentMemoryRuntime,
  isAgentMemoryEnabled,
  isCaptureEnabled,
  resolveProjectId,
  /**
   * The providers this folder is allowed to use, read from its own
   * `provider.use` policy. An empty list means the folder is not bound to one
   * provider and may be summarised through any of them.
   */
  resolveAllowedProviders = async () => [],
  onMemoryChanged = null,
  // `../session-lineage.js`: a known subsession is not a conversation with the
  // user, and what it worked out belongs to its parent.
  lineage = null,
  isSessionArchived = async () => false,
  // Dated chat directories are one shared project, not a folder of the user's.
  isCapturableDirectory = () => true,
  isCapturableSession = async () => true,
  // The seam the tests use; the real client is OpenCode's own SDK.
  createClient = ({ baseUrl, headers }) => OpenCode.make({ baseUrl, headers }),
  quietMs = CAPTURE_QUIET_MS,
  turnWindow = CAPTURE_TURN_WINDOW,
  maxEntriesPerCapture = MAX_ENTRIES_PER_CAPTURE,
  now = () => Date.now(),
}) => {
  const timers = new Map();
  const inflight = new Map();
  // The last message that was distilled, per session.
  const cursors = new Map();
  // Projects whose store refused a write, so the warning is said once.
  const exhausted = new Set();
  let stopped = false;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  /**
   * Why a capture did not happen.
   *
   * A capture that quietly does not happen is a feature nobody can trust, so
   * every path that skips says so. The reason is the first thing worth
   * looking at when a folder is not learning anything.
   */
  const skip = (reason, detail) => {
    console.log(`[session-memory-capture] skipped: ${reason}${detail ? ` (${detail})` : ''}`);
  };

  const announce = (projectId) => {
    if (typeof onMemoryChanged !== 'function') return;
    try {
      onMemoryChanged({ scope: 'project', projectId });
    } catch {
      // A listener that throws must not report the capture as failed.
    }
  };

  const captureTurns = async (sessionId, directory, signal) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createClient({
      baseUrl,
      headers: {
        ...getOpenCodeAuthHeaders(),
        // v2 scopes by header and rejects non-ASCII header values.
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
      },
    });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const checkCurrent = () => {
      signal.throwIfAborted();
      if (buildOpenCodeUrl('/', '').replace(/\/$/, '') !== baseUrl) throw new Error('Session memory capture runtime changed');
    };

    const session = await client.session.get({ sessionID: sessionId }, requestOptions());
    checkCurrent();
    // A child session is its parent's work, and a reverted session is not the
    // conversation the user is having.
    if (session?.id !== sessionId || session.parentID || session.revert?.messageID) return null;
    if (await isSessionArchived(sessionId)) return null;

    const turns = await loadSettledTurns({
      signal,
      limit: turnWindow,
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        requestOptions(),
      ),
    });
    checkCurrent();
    if (!turns.length) return null;

    // Only the turns that have not been distilled yet. A cursor that no
    // longer appears — after a compaction, say — falls back to capturing the
    // window again; the store collapses the restatement.
    const cursor = cursors.get(sessionId);
    const index = cursor ? turns.findIndex((turn) => turn.assistant?.id === cursor) : -1;
    const pending = index >= 0 ? turns.slice(index + 1) : turns;
    if (!pending.length) return null;
    return pending;
  };

  const runCapture = async (sessionId, directory) => {
    if (stopped) return;
    const controller = new AbortController();
    inflight.set(sessionId, controller);
    try {
      if (!(await isAgentMemoryEnabled())) { skip('memory is off'); return; }
      if (!(await isCaptureEnabled())) { skip('capture is switched off'); return; }
      if (!isCapturableDirectory(directory)) { skip('not a capturable directory', directory); return; }
      if (!(await isCapturableSession(sessionId))) { skip('not a capturable session', sessionId); return; }
      const projectId = asNonEmptyString(await resolveProjectId(directory));
      if (!projectId) { skip('no project for this directory', directory); return; }
      if (exhausted.has(projectId)) { skip('the store for this project is full', projectId); return; }

      const pending = await captureTurns(sessionId, directory, controller.signal);
      if (!pending) { skip('nothing new to read', sessionId); return; }

      const { describeSmallModel, generateSmallModelText } = await getSmallModelService();
      const last = pending.at(-1);
      const preferredProviderID = last?.assistant?.providerID;
      const preferredModelID = last?.assistant?.modelID;
      const described = await describeSmallModel({ directory, preferredProviderID, preferredModelID });
      if (!described) { skip('no small model is available', directory); return; }
      /**
       * The folder's own provider policy decides.
       *
       * A folder bound to one provider — a ZDR folder is the case that matters
       * — must not be summarised through another, which is what a default
       * model would do when the bound provider has no small model. An unbound
       * folder may use the cheap default: nothing about it is secret from
       * that provider, and refusing would mean ordinary folders never learn
       * anything at all.
       */
      const allowedProviders = await resolveAllowedProviders(directory);
      if (allowedProviders.length > 0 && !allowedProviders.includes(described.providerID)) {
        skip('the folder is bound to another provider', `${described.providerID} is not allowed`);
        return;
      }

      const system = buildCaptureSystemPrompt();
      const prompt = buildCapturePrompt(pending, described.inputCharBudget - system.length - 512);
      if (!prompt) { skip('the conversation did not fit the budget'); return; }

      /**
       * The model the service resolved, asked for by name.
       *
       * Forcing the conversation's own provider was wrong twice over: the
       * provider a conversation ran on is often one that cannot serve a
       * generation at all, and the folder's binding is what should decide.
       * The model above was resolved with the conversation's provider first
       * and only then fell back, and the binding check above has already
       * refused anything the folder is not allowed to use.
       */
      const generated = await generateSmallModelText({
        prompt: prompt.text,
        system,
        directory,
        sessionID: sessionId,
        model: `${described.providerID}/${described.modelID}`,
        onOverflow: 'error',
        timeoutMs: GENERATION_TIMEOUT_MS,
        signal: controller.signal,
      });

      const memories = parseCaptureResponse(generated?.text);
      console.log(`[session-memory-capture] read ${pending.length} turn(s) for ${projectId}; ${memories.length} worth keeping`);
      // The cursor advances even when nothing was worth keeping: those turns
      // were read and judged, and reading them again would judge them again.
      const newest = last?.assistant?.id;
      if (newest) cursors.set(sessionId, newest);
      if (!memories.length) return;

      let stored = 0;
      for (const memory of memories.slice(0, maxEntriesPerCapture)) {
        try {
          await agentMemoryRuntime.create(
            { scope: 'project', projectId },
            { title: memory.title, body: memory.body, type: memory.type, sessionId },
          );
          stored += 1;
        } catch (error) {
          // A full store says so, and says what to do about it. The agent can
          // consolidate; this runtime must not keep asking.
          if (/memory is full/i.test(String(error?.message ?? ''))) {
            exhausted.add(projectId);
            console.warn('[session-memory-capture] project memory is full; capture paused for this project');
          } else {
            console.warn('[session-memory-capture] failed to store a captured memory');
          }
        }
      }
      if (stored > 0) announce(projectId);
    } catch (error) {
      if (!controller.signal.aborted) {
        // The reason matters: a capture that fails for a reason nobody can see
        // is a capture that never gets fixed.
        console.warn(`[session-memory-capture] capture failed: ${error?.message ?? error}`);
      }
    } finally {
      inflight.delete(sessionId);
    }
  };

  const schedule = (sessionId, directory) => {
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void runCapture(sessionId, directory);
    }, quietMs);
    timer.unref?.();
    timers.set(sessionId, { timer });
  };

  const processPayload = (payload, directoryHint) => {
    if (stopped) return;
    if (payload?.type !== 'session.idle') return;
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    // A turn the user cancelled was never finished, so it says nothing about
    // what the project should remember.
    if (properties.aborted === true) return;
    const sessionId = asNonEmptyString(properties.sessionID);
    if (!sessionId) return;
    const directory = asNonEmptyString(properties.directory) || asNonEmptyString(directoryHint) || '';
    if (!directory) return;
    if (lineage?.isChild(sessionId) === true) return;
    schedule(sessionId, directory);
  };

  const stop = () => {
    stopped = true;
    for (const { timer } of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  };

  return {
    processPayload,
    stop,
    // Exposed for the panel and for tests: how much of this conversation has
    // been distilled.
    describeSession: (sessionId) => ({ lastCapturedMessageId: cursors.get(sessionId) ?? null, capturedAt: now() }),
  };
};
