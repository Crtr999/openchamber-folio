/**
 * Notices deadlines in finished conversations and adds them to the list.
 *
 * It runs after a turn, on a quiet timer, and never during one. A folder is
 * read only if the folder guard allows it; legal/ZDR folders are skipped
 * before their messages are fetched. A failure is logged without any
 * conversation text and never reaches the user.
 */
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { loadSettledTurns } from '../session-assist/context.js';
import { buildExtractionPrompt, buildExtractionSystemPrompt, isDuplicate, parseExtraction } from './extract.js';

const QUIET_MS = 30_000;
const TURN_WINDOW = 6;
const GENERATION_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const createCommitmentCapture = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  store,
  guard,
  // The providers a folder is bound to. A folder bound to one provider must
  // not be read through another.
  resolveAllowedProviders = async () => [],
  readSessionMetadata = async () => null,
  isSessionArchived = async () => false,
  // The check sessions' own folder: never read back as a conversation.
  isOwnDirectory = () => false,
  lineage = null,
  onChanged = () => {},
  createClient = ({ baseUrl, headers }) => OpenCode.make({ baseUrl, headers }),
  quietMs = QUIET_MS,
  turnWindow = TURN_WINDOW,
  now = () => Date.now(),
  logger = console,
}) => {
  const timers = new Map();
  const inflight = new Map();
  const cursors = new Map();
  let stopped = false;

  const skip = (reason) => logger.log?.(`[commitments] capture skipped: ${reason}`);

  const readPending = async (sessionId, directory, signal) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createClient({
      baseUrl,
      headers: { ...getOpenCodeAuthHeaders(), ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}) },
    });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const session = await client.session.get({ sessionID: sessionId }, requestOptions());
    signal.throwIfAborted();
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
    if (!turns.length) return null;
    const cursor = cursors.get(sessionId);
    const index = cursor ? turns.findIndex((turn) => turn.assistant?.id === cursor) : -1;
    const pending = index >= 0 ? turns.slice(index + 1) : turns;
    return pending.length ? pending : null;
  };

  const runCapture = async (sessionId, directory) => {
    if (stopped) return;
    const controller = new AbortController();
    inflight.set(sessionId, controller);
    try {
      const before = await store.read();
      if (!before.settings.enabled) return skip('tracking is off');
      if (isOwnDirectory(directory)) return skip('own check session');
      // Checked before any message is fetched.
      const allowed = await guard.check(directory);
      if (!allowed.ok) return skip(allowed.reason);
      const metadata = await readSessionMetadata(sessionId);
      if (metadata?.openchamber?.commitment || metadata?.openchamber?.companion) return skip('automated session');

      const pending = await readPending(sessionId, directory, controller.signal);
      if (!pending) return skip('nothing new');

      const { describeSmallModel, generateSmallModelText } = await getSmallModelService();
      const last = pending.at(-1);
      const described = await describeSmallModel({
        directory, preferredProviderID: last?.assistant?.providerID, preferredModelID: last?.assistant?.modelID,
      });
      if (!described) return skip('no small model');
      const bound = await resolveAllowedProviders(directory);
      if (bound.length > 0 && !bound.includes(described.providerID)) return skip('folder is bound to another provider');

      const time = now();
      const system = buildExtractionSystemPrompt({ now: time, timezone: before.settings.timezone });
      const prompt = buildExtractionPrompt(pending, described.inputCharBudget - system.length - 512);
      if (!prompt) return skip('does not fit');
      const generated = await generateSmallModelText({
        prompt, system, directory, sessionID: sessionId,
        model: `${described.providerID}/${described.modelID}`,
        onOverflow: 'error', timeoutMs: GENERATION_TIMEOUT_MS, signal: controller.signal,
      });
      // Read and judged, even if nothing was found.
      if (last?.assistant?.id) cursors.set(sessionId, last.assistant.id);

      const found = parseExtraction(generated?.text, { now: time, timezone: before.settings.timezone });
      if (!found.length) return;
      let added = 0;
      await store.update((state) => {
        const items = [...state.items];
        for (const candidate of found) {
          if (isDuplicate(candidate, items)) continue;
          items.push({
            id: randomUUID(),
            title: candidate.title, dueAt: candidate.dueAt, status: 'active', origin: 'auto',
            sourceSessionId: sessionId, sourceDirectory: directory,
            watches: candidate.watches, research: candidate.research,
            createdAt: time, updatedAt: time,
          });
          added += 1;
        }
        return added ? { ...state, items } : state;
      });
      logger.log?.(`[commitments] captured ${added} new item(s)`);
      if (added) onChanged();
    } catch (error) {
      if (!controller.signal.aborted) logger.warn?.(`[commitments] capture failed: ${error?.message ?? error}`);
    } finally {
      inflight.delete(sessionId);
    }
  };

  const processPayload = (payload, directoryHint) => {
    if (stopped || payload?.type !== 'session.idle') return;
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    if (properties.aborted === true) return;
    const sessionId = asText(properties.sessionID);
    const directory = asText(properties.directory) || asText(directoryHint);
    if (!sessionId || !directory) return;
    if (lineage?.isChild(sessionId) === true) return;
    const existing = timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { timers.delete(sessionId); void runCapture(sessionId, directory); }, quietMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  };

  return { processPayload, stop };
};
