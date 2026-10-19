import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AiTaskSetupError } from './executor.js';
export { createTeamRuntime } from './team-runtime.js';

const configSchema = z.object({ board: z.string().trim().max(2000).default(''), enabled: z.boolean().default(false), model: z.string().trim().max(500).default('') });
const modelSchema = z.object({ providerID: z.string().min(1), id: z.string().min(1) }).strict();
const failureSchema = z.object({ stage: z.enum(['claim', 'read-task', 'resolve', 'create', 'dispatch', 'inspect', 'pause', 'stall', 'writeback']), code: z.string(), message: z.string(), at: z.number() });
const runSchema = z.object({
  id: z.string(), page: z.string(), board: z.string(), title: z.string(),
  phase: z.enum(['claimed', 'running', 'result', 'done', 'needs-you', 'cancelled']),
  sessionId: z.string().optional(), directory: z.string().optional(),
  startedAt: z.number(), content: z.string().optional(), outcome: z.enum(['done', 'needs-you']).optional(),
  projectId: z.string().optional(), projectLabel: z.string().optional(), agent: z.string().optional(), assignmentRevision: z.string().optional(), model: modelSchema.optional(),
  teamRequestId: z.string().optional(), teamRunId: z.string().optional(), teammateId: z.string().optional(), teamRevision: z.number().int().nonnegative().optional(),
  failure: failureSchema.optional(), writebackFailure: failureSchema.optional(),
});
const assignmentSchema = z.object({ board: z.string(), page: z.string(), projectId: z.string().min(1), model: modelSchema.optional(), revision: z.string().optional() });
const stateSchema = z.object({ config: configSchema.default({ board: '', enabled: false, model: '' }), runs: z.array(runSchema).default([]), assignments: z.array(assignmentSchema).default([]), provisioning: z.boolean().default(false) });
const transportFailureSchema = z.object({ status: z.number().int().min(400).max(599) });
const notionFailures = new Map([
  ['Your Notion connection does not allow this action.', { code: 'notion_access', message: 'Notion does not currently allow this operation. Review the connection’s permissions and query allowance before retrying.' }],
  ['Connect Notion first.', { code: 'notion_disconnected', message: 'Connect Notion before retrying this task.' }],
  ['Reconnect Notion.', { code: 'notion_reconnect', message: 'Reconnect Notion before retrying this task.' }],
  ['This task page is incomplete. Open Notion to resolve it before pickup.', { code: 'notion_incomplete', message: 'The task page is incomplete. Resolve it in Notion before retrying.' }],
  ['Describe the task in its Notion page before moving it to Ready for AI.', { code: 'task_empty', message: 'Describe the task and deliverable in Notion before retrying.' }],
]);
const notionReferenceFailures = new Map([
  ['notion_reference_url', 'Use an official Notion page URL from the connected workspace.'],
  ['notion_reference_incomplete', 'The Notion source is incomplete. Resolve its access or link a smaller complete page before retrying.'],
  ['notion_reference_scope', 'Notion did not verify the requested source identity or location. Check the link before retrying.'],
  ['notion_reference_ambiguous', 'More than one source may match, or search is incomplete. Paste the exact Notion page URL.'],
  ['notion_reference_missing', 'No verified source matches that title and location. Check access or paste its Notion page URL.'],
  ['notion_reference_limit', 'The Notion source exceeds the bounded context limit. Link a smaller complete source.'],
  ['notion_reference_access', 'The connected Notion workspace could not read this source. Check its permissions before retrying.'],
]);
// SDK errors can contain response bodies, prompts and credentials. Preserve
// actionable transport classification, never arbitrary exception text.
const failureDetails = (failure, stage, at) => {
  if (failure instanceof AiTaskSetupError) return { stage, code: failure.code, message: failure.message, at };
  if (notionReferenceFailures.has(failure?.code)) return { stage, code: failure.code, message: notionReferenceFailures.get(failure.code), at };
  const notion = notionFailures.get(failure?.message);
  if (notion) return { stage, ...notion, at };
  const http = transportFailureSchema.safeParse(failure?.cause ?? failure);
  const code = http.success ? `http_${http.data.status}` : failure instanceof z.ZodError ? 'invalid_response' : failure?.name === 'TimeoutError' ? 'timeout' : failure?.name === 'AbortError' ? 'aborted' : 'unavailable';
  const message = http.success ? `OpenCode or Notion returned HTTP ${http.data.status}.` : code === 'invalid_response' ? 'The service returned an unexpected response.' : code === 'timeout' ? 'The service did not respond before the timeout.' : code === 'aborted' ? 'The request was interrupted.' : 'The service could not complete this step. Check the connection and project configuration.';
  return { stage, code, message, at };
};
const INTERVAL = 15 * 60_000;
const DEADLINE = 30 * 60_000;
const terminal = (run) => ['done', 'needs-you', 'cancelled'].includes(run.phase);
const sharedRunSchema = z.object({
  id: z.string().min(1), teammateId: z.string().min(1), projectId: z.string().min(1), directory: z.string().min(1),
  phase: z.enum(['queued', 'creating', 'dispatching', 'running', 'done', 'needs-you', 'paused']),
  revision: z.number().int().nonnegative(), sessionId: z.string().min(1).optional(), content: z.string().optional(),
  failure: failureSchema.optional(), children: z.array(z.object({ id: z.string().min(1), title: z.string(), directory: z.string().min(1) })),
  pausePending: z.boolean().optional(),
});
export const AI_TASK_COLUMNS = ['Idea', 'Ready for AI', 'Doing', 'Done', 'Needs you', 'Parked'];

/** Desktop supplies its encrypted Notion connection; orchestration stays server-owned. */
export function createAiTaskRuntime({ filePath, notion, executor, team, isBlocked, now = Date.now }) {
  let state;
  let operation = Promise.resolve();
  let timer;
  let closed = false;
  let nextCheck = 0;
  let lastCheckedAt = null;
  let error = '';
  const load = async () => {
    if (state) return state;
    try { state = stateSchema.parse(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (failure) { if (failure.code !== 'ENOENT') throw new Error('AI task tracking could not be read. No tasks were started.'); state = stateSchema.parse({}); }
    return state;
  };
  const persist = async (next) => {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, filePath);
    state = next;
  };
  const serialize = (work) => {
    const result = operation.then(work);
    operation = result.catch(() => {});
    return result;
  };
  const requireAllowed = () => {
    if (closed) throw new Error('AI task coordinator is stopped.');
    if (isBlocked()) throw new Error('AI tasks are unavailable under your organization’s policy.');
  };
  const saveRun = (run) => persist({ ...state, runs: state.runs.map((item) => item.id === run.id ? run : item) });
  const validateBoard = (board) => {
    if (!AI_TASK_COLUMNS.every((column) => board.columns.includes(column))) throw new Error(`AI Tasks needs these statuses: ${AI_TASK_COLUMNS.join(', ')}.`);
  };
  const finish = async (run) => {
    requireAllowed();
    // The Notion adapter verifies the task still belongs to the same board and
    // is still Doing. A user moving it out cancels automatic writes.
    try {
      const saved = await notion.finish(run);
      const completed = { ...run, phase: saved ? run.outcome : 'cancelled', writebackFailure: undefined };
      if (run.failure?.stage === 'writeback') completed.failure = undefined;
      await saveRun(completed);
    } catch (failure) {
      await saveRun({ ...run, writebackFailure: failureDetails(failure, 'writeback', now()) });
      throw failure;
    }
  };
  const sharedDetails = async (run) => {
    if (!team) throw new Error('The shared team authority is unavailable. Saved tracking was kept.');
    let details;
    let found;
    if (run.teamRunId) {
      details = await team.details({ projectId: run.projectId, teammateId: run.teammateId });
      found = details.runs.find((item) => item.id === run.teamRunId);
    } else {
      found = await team.getRun({ projectId: run.projectId, requestId: run.teamRequestId });
      if (found) {
        details = await team.details({ projectId: run.projectId, teammateId: found.teammateId });
        found = details.runs.find((item) => item.id === found.id);
        if (!found) throw new Error('Shared lookup and details disagree. Saved tracking was kept.');
      }
    }
    if (!found) return null;
    const shared = sharedRunSchema.parse(found);
    if (shared.projectId !== run.projectId || (run.teamRunId && shared.id !== run.teamRunId)
      || (run.directory && shared.directory !== run.directory) || (run.sessionId && shared.sessionId !== run.sessionId)
      || shared.revision < (run.teamRevision ?? 0)
      || shared.children.some((child) => child.directory !== shared.directory)) throw new Error('Shared task scope or revision changed. Saved tracking was kept.');
    const teammate = z.object({ id: z.literal(shared.teammateId), projectId: z.literal(run.projectId), directory: z.literal(shared.directory), projectLabel: z.string(), agent: z.string() }).parse(details.teammate);
    return { shared, teammate };
  };
  const reconcileShared = async (run) => {
    let details;
    try { details = await sharedDetails(run); }
    catch (failure) { await saveRun({ ...run, failure: failureDetails(failure, 'inspect', now()) }); throw failure; }
    requireAllowed();
    if (!details) {
      if (run.teamRunId) {
        await saveRun({ ...run, failure: { stage: 'inspect', code: 'shared_run_missing', message: 'The saved shared task could not be found. Tracking was kept. No automatic resend will occur.', at: now() } });
        throw new Error('The saved shared task could not be found. Tracking was kept.');
      }
      const failure = run.failure ?? { stage: 'dispatch', code: 'shared_run_missing', message: 'Shared dispatch has no durable run to inspect. Review the team and move the card back to Ready for AI only when safe. No automatic resend will occur.', at: now() };
      const failed = { ...run, phase: 'result', outcome: 'needs-you', failure, content: `${failure.stage}: ${failure.message}\nNo automatic resend will occur.` };
      await saveRun(failed); await finish(failed); return;
    }
    const { shared, teammate } = details;
    const complete = ['done', 'needs-you', 'paused'].includes(shared.phase);
    const updated = { ...run, teamRunId: shared.id, teammateId: shared.teammateId, teamRevision: shared.revision,
      sessionId: shared.sessionId, directory: shared.directory, projectLabel: teammate.projectLabel, agent: teammate.agent,
      phase: complete ? 'result' : 'running', outcome: complete ? shared.phase === 'done' ? 'done' : 'needs-you' : undefined,
      content: complete ? shared.content || shared.failure?.message || 'The shared task has no successful final answer. Open its linked chat to review or continue.' : undefined,
      failure: shared.failure,
    };
    await saveRun(updated);
    if (complete) await finish(updated);
  };
  const reconcile = async (run) => {
    // Notion deduplicates by run ID, so retries keep the exact result revision
    // whose append may already have succeeded. Never substitute newer content.
    if (run.phase === 'result') { await finish(run); return; }
    // Request identity survives even a crash before the shared run ID is saved.
    // Lookup is read-only. The server polls team.check; this adapter never does.
    if (run.teamRequestId) { await reconcileShared(run); return; }
    if (run.phase === 'claimed') {
      const interrupted = { ...run, phase: 'result', outcome: 'needs-you', content: 'Pickup was interrupted before dispatch. No prompt will be sent automatically. Move this card back to Ready for AI to try again.' };
      await saveRun(interrupted);
      await finish(interrupted);
      return;
    }
    let result;
    try { result = await executor.inspect(run); }
    catch (failure) { await saveRun({ ...run, failure: failureDetails(failure, 'inspect', now()) }); throw failure; }
    requireAllowed();
    if (result.kind === 'running' && now() - run.startedAt < DEADLINE) return;
    if (result.kind === 'running') {
      // Do not interrupt a user's approval or a session they are continuing.
      // Keep the chat alive, but stop claiming it will finish unattended.
      return;
    }
    if (result.kind === 'pending' && now() - run.startedAt < DEADLINE) return;
    const outcome = result.kind === 'done' ? 'done' : 'needs-you';
    const content = result.content || 'The chat did not produce a successful final answer. Open its linked chat to review or continue.';
    const completed = { ...run, phase: 'result', outcome, content, failure: undefined };
    await saveRun(completed);
    await finish(completed);
  };
  const tick = () => serialize(async () => {
    requireAllowed();
    await load();
    error = '';
    // Pausing stops new pickups, not result reconciliation for existing work.
    for (const run of state.runs.filter((item) => !terminal(item))) {
      try { await reconcile(run); }
      catch { error = 'A task could not be reconciled. Its chat and saved tracking were kept. Try Refresh.'; }
    }
    if (!state.config.enabled || now() < nextCheck) return;
    const config = state.config;
    if (state.runs.some((run) => !terminal(run))) return; // one coordinator at a time
    requireAllowed();
    const board = await notion.readBoard(config.board, 'Ready for AI');
    validateBoard(board);
    lastCheckedAt = now();
    nextCheck = now() + INTERVAL;
    const ready = board.rows.filter((row) => row.status === 'Ready for AI' && row.title?.trim());
    const task = ready.find((row) => state.assignments.some((item) => item.board === config.board && item.page === row.url
      && !state.runs.some((run) => run.board === config.board && run.page === row.url && run.failure?.stage === 'claim' && run.assignmentRevision === item.revision)));
    if (ready.length && !task) error = 'Choose a project folder for a ready task before pickup.';
    if (!task) return;
    const assignment = state.assignments.find((item) => item.board === config.board && item.page === task.url);
    requireAllowed();
    const run = { id: randomUUID(), board: config.board, page: task.url, title: task.title, phase: 'claimed', startedAt: now(), projectId: assignment.projectId, assignmentRevision: assignment.revision, ...(assignment.model ? { model: assignment.model } : {}) };
    await persist({ ...state, runs: [...state.runs, run] }); // durable BEFORE any dispatch
    let stage = 'claim';
    let currentRun = run;
    try {
      if (!await notion.claim(config.board, task.url)) { await saveRun({ ...run, phase: 'cancelled' }); return; }
      requireAllowed();
      stage = 'read-task';
      const content = await notion.readTask(config.board, task.url);
      requireAllowed();
      if (team) {
        stage = 'dispatch';
        currentRun = { ...run, phase: 'running', teamRequestId: `notion:${run.id}` };
        await saveRun(currentRun); // durable authorization BEFORE shared send
        requireAllowed();
        const shared = sharedRunSchema.parse(await team.send({ projectId: run.projectId, title: task.title, text: content, requestId: currentRun.teamRequestId, ...(run.model ? { model: run.model } : {}) }));
        if (shared.projectId !== run.projectId) throw new Error('Shared task project mismatch.');
        currentRun = { ...currentRun, teamRunId: shared.id, teammateId: shared.teammateId, sessionId: shared.sessionId, directory: shared.directory, teamRevision: shared.revision };
        await saveRun(currentRun);
        stage = 'inspect';
        const details = await sharedDetails(currentRun);
        if (!details) throw new Error('The shared task could not be found.');
        currentRun = { ...currentRun, projectLabel: details.teammate.projectLabel, agent: details.teammate.agent, failure: details.shared.failure };
        await saveRun(currentRun);
        return; // shared send is the ONLY dispatcher for this run
      }
      stage = 'create';
      // The legacy executor cannot honor per-card team model choices. Refuse
      // instead of silently creating a session on the ordinary folder default.
      if (assignment.model) throw new AiTaskSetupError('teamProvider');
      const destination = await executor.resolveProject(assignment.projectId);
      const session = await executor.create({ title: task.title, destination, runId: run.id });
      const running = { ...run, phase: 'running', sessionId: session.id, directory: session.directory, projectLabel: destination.label, agent: destination.agent };
      currentRun = running;
      await saveRun(running); // persist identity BEFORE prompt; ambiguous sends never retry
      stage = 'dispatch';
      requireAllowed();
      await executor.send(running, content);
    } catch (failure) {
      const details = failureDetails(failure, stage, now());
      error = `${stage}: ${details.message}`;
      if (stage === 'dispatch' || currentRun.teamRequestId) {
        await saveRun({ ...currentRun, failure: details }); // inspect, never send again
      } else {
        const failed = { ...currentRun, phase: 'result', outcome: 'needs-you', failure: details, content: `${stage}: ${details.message}\nNo task prompt was sent. Review the folder and connection, then move the card back to Ready for AI to try again.` };
        await saveRun(failed);
        try { await finish(failed); } catch { /* durable result is retried independently */ }
      }
    }
  });
  return {
    start() {
      if (timer || closed) return;
      // Poll only local chat state between the 15-minute Notion board checks.
      timer = setInterval(() => { void tick().catch(() => { error = 'AI Tasks could not check the board. Refresh to retry.'; }); }, 15_000);
      timer.unref?.();
    },
    close() { closed = true; clearInterval(timer); return operation; },
    status: () => serialize(async () => {
      requireAllowed(); await load();
      return { config: state.config, runs: state.runs, assignments: state.assignments.filter((item) => item.board === state.config.board), lastCheckedAt, nextCheckAt: state.config.enabled ? nextCheck || null : null, error: state.provisioning ? 'Board creation was interrupted. Check Notion for AI Tasks and paste its database URL in setup. Creation will not repeat automatically.' : error, provisioning: state.provisioning };
    }),
    projects: () => serialize(async () => {
      requireAllowed();
      const projects = await executor.projects();
      // A project without a reviewed team policy simply offers no model choice.
      return Promise.all(projects.map(async (project) => ({ ...project, models: team?.models ? await team.models(project.id).catch(() => []) : [] })));
    }),
    details: (id) => serialize(async () => {
      requireAllowed(); await load();
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error('This task run could not be found.');
      let children = { kind: 'loaded', items: [] };
      if (run.teamRequestId) {
        try {
          const details = await sharedDetails(run);
          if (!details) throw new Error('The shared task could not be found.');
          children = { kind: 'loaded', items: details.shared.children };
        } catch (failure) { children = { kind: 'failed', failure: failureDetails(failure, 'inspect', now()) }; }
      } else if (run.sessionId && run.directory) {
        try { children = { kind: 'loaded', items: await executor.children(run) }; }
        catch (failure) { children = { kind: 'failed', failure: failureDetails(failure, 'inspect', now()) }; }
      }
      requireAllowed();
      return { run, children };
    }),
    delete: (raw) => serialize(async () => {
      requireAllowed(); await load();
      const input = z.object({ page: z.string().min(1), confirmed: z.literal(true) }).parse(raw);
      const board = state.config.board;
      if (!board) throw new Error('Configure the AI Tasks database first.');
      // Serialize with pickup and reconciliation. A card moved out of Doing
      // is not proof that its durable dispatch or pending writeback finished.
      if (state.runs.some((run) => run.board === board && run.page === input.page && !terminal(run))) throw new Error('This task has an active run. Wait for it to finish before deleting it.');
      for (const run of state.runs.filter((item) => item.board === board && item.page === input.page && item.teamRequestId)) {
        const details = await sharedDetails(run);
        if (!details && !run.teamRunId && terminal(run)) { requireAllowed(); continue; }
        if (!details || details.shared.pausePending || !['done', 'needs-you', 'paused'].includes(details.shared.phase)) throw new Error('This task has active or unverified shared work. Wait for it to settle before deleting it.');
        requireAllowed();
      }
      if (!notion.delete) throw new Error('This Notion host does not support deleting tasks.');
      requireAllowed();
      await notion.delete(board, input);
      // Keep all saved runs, results and chat identities. Only the future
      // pickup assignment is removed, after Notion confirms the trash action.
      await persist({ ...state, assignments: state.assignments.filter((item) => item.board !== board || item.page !== input.page) });
      return { saved: true };
    }),
    assign: (raw) => serialize(async () => {
      requireAllowed(); await load();
      const input = z.object({ page: z.string().min(1), projectId: z.string().min(1), model: modelSchema.optional() }).parse(raw);
      if (state.runs.some((run) => run.board === state.config.board && run.page === input.page && !terminal(run))) throw new Error('Wait for this run to finish before changing its folder.');
      const board = await notion.readBoard(state.config.board);
      if (!board.rows.some((row) => row.url === input.page)) throw new Error('This task is no longer on the selected board.');
      const projects = await executor.projects();
      if (!projects.some((project) => project.id === input.projectId)) throw new Error('Choose an existing project folder.');
      if (input.model && !(team?.models ? await team.models(input.projectId) : []).some((item) => item.providerID === input.model.providerID && item.id === input.model.id)) throw new Error('Choose a model approved for this project folder.');
      requireAllowed();
      const assignment = { ...input, board: state.config.board, revision: randomUUID() };
      await persist({ ...state, assignments: [...state.assignments.filter((item) => item.board !== assignment.board || item.page !== assignment.page), assignment] });
      nextCheck = 0;
      return { saved: true };
    }),
    createBoard: () => serialize(async () => {
      requireAllowed(); await load();
      if (state.config.board || state.provisioning) throw new Error('An AI Tasks board already exists or its creation needs review in Notion.');
      await notion.prepareCreateBoard();
      requireAllowed();
      await persist({ ...state, provisioning: true });
      const board = await notion.createBoard();
      requireAllowed();
      await persist({ ...state, provisioning: false, config: { ...state.config, board, enabled: false } });
      return { saved: true };
    }),
    configure: (raw) => serialize(async () => {
      requireAllowed(); await load();
      const config = configSchema.parse(raw);
      if (config.enabled) {
        if (!config.board) throw new Error('Choose a separate Notion database for AI Tasks.');
        validateBoard(await notion.readBoard(config.board));
        requireAllowed();
      }
      if (state.runs.some((run) => !terminal(run)) && (config.board !== state.config.board || config.model !== state.config.model)) throw new Error('Wait for the active task before changing its board or model. You can pause pickups now.');
      await persist({ ...state, config, provisioning: false });
      nextCheck = 0; error = '';
      return { saved: true };
    }),
    async check() { nextCheck = 0; error = ''; await tick(); return this.status(); },
  };
}
