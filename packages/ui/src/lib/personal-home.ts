import { z } from 'zod';
import { invokeDesktop, isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';

export const personalHomeSupported = () => isElectronShell() && isDesktopLocalOriginActive();
const statusSchema = z.object({ connected: z.boolean(), signingIn: z.boolean(), board: z.string(), habits: z.string(), destination: z.string() });
const boardSchema = z.object({ name: z.string(), columns: z.array(z.string()), rows: z.array(z.object({ url: z.string(), title: z.string().nullable(), status: z.string().nullable(), due: z.object({ start: z.string(), end: z.string().nullable(), isDatetime: z.boolean() }).nullable().default(null) })), limited: z.boolean() });
const calendarSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), error: z.string().optional(), calendars: z.array(z.object({ id: z.string(), title: z.string(), writable: z.boolean() })).default([]), events: z.array(z.object({ id: z.string(), title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), calendarId: z.string(), calendarTitle: z.string(), writable: z.boolean() })).default([]) });
export type HomeNotionStatus = z.infer<typeof statusSchema>;
export type HomeNotionBoard = z.infer<typeof boardSchema>;
export type HomeCalendar = z.infer<typeof calendarSchema>;
export type HomeCalendarEvent = HomeCalendar['events'][number];
const invoke = (args: Parameters<typeof invokeDesktop>[1]) => {
    if (!personalHomeSupported()) throw new Error('Personal connections require the desktop app.');
    return invokeDesktop('desktop_personal_home', args);
};
export const readHomeNotionStatus = async () => statusSchema.parse(await invoke({ action: 'status' }));
export const readHomeBoard = async () => boardSchema.parse(await invoke({ action: 'board' }));
const aiTaskFailureSchema = z.object({ stage: z.enum(['claim', 'read-task', 'create', 'dispatch', 'inspect', 'writeback']), code: z.string(), message: z.string(), at: z.number() });
const aiTaskModelSchema = z.object({ providerID: z.string().min(1), id: z.string().min(1) });
export type AiTaskModel = z.infer<typeof aiTaskModelSchema>;
const aiTaskRunSchema = z.object({ model: aiTaskModelSchema.optional(), id: z.string(), page: z.string(), title: z.string(), phase: z.enum(['claimed', 'running', 'result', 'done', 'needs-you', 'cancelled']), sessionId: z.string().optional(), directory: z.string().optional(), startedAt: z.number(), content: z.string().optional(), projectId: z.string().optional(), projectLabel: z.string().optional(), agent: z.string().optional(), failure: aiTaskFailureSchema.optional(), writebackFailure: aiTaskFailureSchema.optional() });
const aiTaskStatusSchema = z.object({
    config: z.object({ board: z.string(), model: z.string(), enabled: z.boolean() }),
    runs: z.array(aiTaskRunSchema),
    assignments: z.array(z.object({ board: z.string(), page: z.string(), projectId: z.string(), model: aiTaskModelSchema.optional() })).default([]),
    lastCheckedAt: z.number().nullable(), nextCheckAt: z.number().nullable(), error: z.string(), provisioning: z.boolean(),
});
export const readAiTaskStatus = async () => aiTaskStatusSchema.parse(await invoke({ action: 'ai-status' }));
// models are the folder's reviewed zero-priced team models; empty means the folder has no team policy.
export const readAiTaskProjects = async () => z.array(z.object({ id: z.string(), label: z.string(), models: z.array(aiTaskModelSchema.extend({ name: z.string(), default: z.boolean() })).default([]) })).parse(await invoke({ action: 'ai-projects' }));
export const assignAiTask = (page: string, projectId: string, model?: AiTaskModel) => invoke({ action: 'ai-assign', page, projectId, ...(model ? { model } : {}) });
export const readAiTaskDetails = async (id: string) => z.object({ run: aiTaskRunSchema, children: z.discriminatedUnion('kind', [z.object({ kind: z.literal('loaded'), items: z.array(z.object({ id: z.string(), title: z.string(), directory: z.string() })) }), z.object({ kind: z.literal('failed'), failure: z.object({ message: z.string(), code: z.string() }) })]) }).parse(await invoke({ action: 'ai-details', id }));
export const configureAiTasks = (config: { board: string; model: string; enabled: boolean }) => invoke({ action: 'ai-configure', ...config });
export const checkAiTasks = async () => aiTaskStatusSchema.parse(await invoke({ action: 'ai-check' }));
export const readAiTaskBoard = async () => boardSchema.parse(await invoke({ action: 'ai-board' }));
export const createAiTask = (title: string, notes?: string) => invoke({ action: 'ai-create', title, ...(notes?.trim() ? { notes } : {}) });
export const readAiTaskNotes = async (page: string) => z.object({ notes: z.string(), editable: z.boolean() }).parse(await invoke({ action: 'ai-notes', page }));
export const saveAiTaskNotes = (page: string, notes: string) => invoke({ action: 'ai-save-notes', page, notes });
export const createAiTaskBoard = () => invoke({ action: 'ai-create-board' });
export const moveAiTask = (page: string, status: string) => invoke({ action: 'ai-move', page, status });
/** Call only after the user confirms moving this card to Notion trash. */
export const deleteAiTask = async (page: string): Promise<{ saved: true }> => z.object({ saved: z.literal(true) }).parse(await invoke({ action: 'ai-delete', page, confirmed: true }));
/** Carter's ChatGPT/Codex automations, read-only. Provider identities never merge with local ids. */
const chatGPTTaskScheduleSchema = z.object({ understood: z.boolean(), summary: z.string(), timeZone: z.string().nullable(), nextRunAt: z.number().finite().nullable() });
const chatGPTTaskSchema = z.object({ providerJobId: z.string().min(1), name: z.string().min(1), kind: z.string().min(1), status: z.string().min(1), rrule: z.string().min(1), providerThreadId: z.string().min(1), createdAt: z.number().finite(), updatedAt: z.number().finite(), schedule: chatGPTTaskScheduleSchema });
const chatGPTTasksSchema = z.object({ rows: z.array(chatGPTTaskSchema).max(500), readAt: z.number().finite(), partial: z.boolean(), skipped: z.array(z.string()).default([]), error: z.string().optional() });
export type HomeChatGPTTaskFeed = z.infer<typeof chatGPTTasksSchema>;
export const readHomeChatGPTTasks = async () => chatGPTTasksSchema.parse(await invoke({ action: 'chatgpt-automations-list' }));

const teamFailureSchema = z.object({ stage: z.enum(['resolve', 'create', 'dispatch', 'inspect', 'pause', 'stall']), code: z.string(), message: z.string(), at: z.number().finite() });
const teammateSchema = z.object({ id: z.string().min(1), projectId: z.string().min(1), projectLabel: z.string(), directory: z.string().min(1), agent: z.string(), role: z.literal('manager'), revision: z.number().int().nonnegative(), readRevision: z.number().int().nonnegative() });
const teamUsageSchema = z.object({ kind: z.enum(['available', 'unavailable']), tokens: z.number().finite().nonnegative(), reportedCost: z.number().finite().nonnegative(), sessionIds: z.array(z.string()), dollarCapSupported: z.literal(false) });
const teamRunSchema = z.object({
    id: z.string().min(1), taskId: z.string().min(1), teammateId: z.string().min(1), projectId: z.string().min(1), directory: z.string().min(1), title: z.string(), text: z.string(),
    phase: z.enum(['queued', 'creating', 'dispatching', 'running', 'done', 'needs-you', 'paused']), startedAt: z.number().finite(), revision: z.number().int().nonnegative(),
    pendingDispatch: z.literal(true).optional(), cancelledBeforeDispatch: z.literal(true).optional(), queuedAt: z.number().finite().optional(), sessionId: z.string().min(1).optional(), content: z.string().optional(), failure: teamFailureSchema.optional(),
    children: z.array(z.object({ id: z.string().min(1), title: z.string(), directory: z.string().min(1) })),
    artifacts: z.array(z.object({ path: z.string(), label: z.string(), sessionId: z.string().min(1), messageId: z.string().min(1), verified: z.literal(true).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), sizeBytes: z.number().int().nonnegative().optional() })), usage: teamUsageSchema,
    inspectFailures: z.number().int().nonnegative(), routineId: z.string().optional(), scheduledFor: z.number().finite().optional(), policyRevision: z.string().optional(),
    pausePending: z.boolean().optional(), revisionOf: z.string().min(1).optional(), sourceRevision: z.number().int().nonnegative().optional(), savedContext: z.string().optional(),
});
const teamScheduleSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('once'), date: z.string(), time: z.string(), timezone: z.string() }),
    z.object({ kind: z.literal('daily'), time: z.string(), timezone: z.string() }),
    z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(0).max(6)).min(1), time: z.string(), timezone: z.string() }),
    z.object({ kind: z.literal('cron'), cron: z.string(), timezone: z.string() }),
]);
const teamRoutineSchema = z.object({ id: z.string().min(1), teammateId: z.string().min(1), projectId: z.string().min(1), revision: z.string().min(1), title: z.string(), text: z.string(), schedule: teamScheduleSchema, allowedActions: z.array(z.enum(['read-project', 'fetch-reference', 'draft-output', 'safe-compute'])).min(1).max(4), limits: z.object({ maxOccurrences: z.number().int().min(1).max(31), tokenGuardrail: z.number().int().min(1).max(10_000_000) }), status: z.enum(['proposed', 'confirmed', 'paused', 'complete']), occurrences: z.number().int().nonnegative(), nextRunAt: z.number().finite().optional(), policyRevision: z.string(), failure: teamFailureSchema.optional() });
const teamInboxSchema = z.array(z.object({ teammate: teammateSchema, unread: z.boolean(), latestRun: teamRunSchema.nullable() })).superRefine((items, context) => {
    for (const { teammate, latestRun } of items) {
        if (latestRun && (latestRun.projectId !== teammate.projectId || latestRun.teammateId !== teammate.id)) context.addIssue({ code: 'custom', message: 'Team inbox owner mismatch.' });
    }
});
const teamDetailsSchema = z.object({ teammate: teammateSchema, runs: z.array(teamRunSchema), routines: z.array(teamRoutineSchema) }).superRefine((details, context) => {
    for (const item of [...details.runs, ...details.routines]) {
        if (item.projectId !== details.teammate.projectId || item.teammateId !== details.teammate.id) context.addIssue({ code: 'custom', message: 'Team detail owner mismatch.' });
    }
});
const teamUnavailableSchema = z.object({ code: z.literal('team_runtime_unavailable'), message: z.string(), at: z.number() });
export class TeamRuntimeUnavailableError extends Error { readonly code = 'team_runtime_unavailable'; }
const invokeTeam = async (args: Parameters<typeof invokeDesktop>[1]) => {
    const value = await invoke(args);
    const unavailable = teamUnavailableSchema.safeParse(value);
    if (unavailable.success) throw new TeamRuntimeUnavailableError(unavailable.data.message);
    return value;
};
export type HomeTeamRun = z.infer<typeof teamRunSchema>;
export type HomeTeamRoutine = z.infer<typeof teamRoutineSchema>;
export type HomeTeamSchedule = z.infer<typeof teamScheduleSchema>;
export type HomeTeamDetails = z.infer<typeof teamDetailsSchema>;
export const readTeamInbox = async () => teamInboxSchema.parse(await invokeTeam({ action: 'team-inbox' }));
export const readTeamDetails = async (projectId: string, teammateId: string) => {
    const value = teamDetailsSchema.parse(await invokeTeam({ action: 'team-details', projectId, teammateId }));
    if (value.teammate.projectId !== projectId || value.teammate.id !== teammateId) throw new Error('Team detail owner mismatch.');
    return value;
};
export const sendTeamMessage = async (input: { projectId: string; title: string; text: string; requestId: string }) => {
    const run = teamRunSchema.parse(await invokeTeam({ action: 'team-send', ...input }));
    if (run.projectId !== input.projectId) throw new Error('Team run owner mismatch.');
    return run;
};
export const reviseTeamRun = async (input: { projectId: string; runId: string; revision: number; text: string; requestId: string }) => {
    const run = teamRunSchema.parse(await invokeTeam({ action: 'team-revise', ...input }));
    if (run.projectId !== input.projectId) throw new Error('Team run owner mismatch.');
    if (run.revisionOf !== input.runId || run.sourceRevision !== input.revision) throw new Error('Team revision source mismatch.');
    return run;
};
export const recoverTeamRun = async (input: { projectId: string; runId: string }) => {
    const run = teamRunSchema.parse(await invokeTeam({ action: 'team-recover', ...input }));
    if (run.projectId !== input.projectId || run.id !== input.runId) throw new Error('Team recovery owner mismatch.');
    return run;
};
const teamDraftSchema = z.object({ text: z.string().max(20000), requestId: z.string().uuid(), revision: z.number().int().nonnegative().optional() });
const teamDraftKey = (runtime: string, projectId: string, runId: string) => `open-carter:team-draft:v1:${JSON.stringify([runtime, projectId, runId])}`;
// Drafts are local user content, never credentials or proof of current work.
export const readTeamDraft = (runtime: string, projectId: string, runId = '') => {
    const saved = localStorage.getItem(teamDraftKey(runtime, projectId, runId));
    return saved === null ? null : teamDraftSchema.parse(JSON.parse(saved));
};
export const writeTeamDraft = (runtime: string, projectId: string, draft: z.infer<typeof teamDraftSchema> | null, runId = '') => {
    const key = teamDraftKey(runtime, projectId, runId);
    if (draft) localStorage.setItem(key, JSON.stringify(teamDraftSchema.parse(draft)));
    else localStorage.removeItem(key);
};
export const acknowledgeTeam = async (projectId: string, teammateId: string, revision: number) => teammateSchema.parse(await invokeTeam({ action: 'team-ack', projectId, teammateId, revision }));
export const proposeTeamRoutine = async (input: { projectId: string; title: string; text: string; schedule: HomeTeamSchedule; allowedActions: HomeTeamRoutine['allowedActions']; limits: HomeTeamRoutine['limits'] }) => teamRoutineSchema.parse(await invokeTeam({ action: 'team-propose-routine', ...input }));
export const confirmTeamRoutine = async (routine: HomeTeamRoutine) => teamRoutineSchema.parse(await invokeTeam({ action: 'team-confirm-routine', projectId: routine.projectId, routineId: routine.id, revision: routine.revision }));
export const pauseTeamRoutine = async (routine: HomeTeamRoutine) => teamRoutineSchema.parse(await invokeTeam({ action: 'team-pause-routine', projectId: routine.projectId, routineId: routine.id, revision: routine.revision }));
export const pauseTeamContinuation = async (run: HomeTeamRun) => teamRunSchema.parse(await invokeTeam({ action: 'team-pause-continuation', projectId: run.projectId, runId: run.id }));
const aiHostSchema = z.object({
    platform: z.string(), coordinator: z.object({ state: z.enum(['waiting', 'enabled', 'paused', 'unavailable', 'stopped']), enabled: z.boolean().nullable(), lastCheckedAt: z.number().finite().nullable(), nextCheckAt: z.number().finite().nullable(), hasError: z.boolean() }),
    teamWork: z.object({ state: z.enum(['required', 'idle', 'unavailable']) }),
    wakeProtection: z.object({ supported: z.boolean(), enabled: z.boolean(), active: z.boolean(), source: z.enum(['team-and-app', 'app', 'team', 'none']), reason: z.enum(['stopped', 'suspended', 'native_failure', 'unsupported', 'protected', 'disabled', 'paused', 'coordinator_unavailable']) }),
    power: z.object({ state: z.enum(['awake', 'suspended']), lastSuspendAt: z.number().finite().nullable(), lastResumeAt: z.number().finite().nullable() }), diagnostics: z.array(z.string()),
});
export const readAiHostStatus = async () => {
    if (!personalHomeSupported()) throw new Error('Local host controls require the desktop app.');
    return aiHostSchema.parse(await invokeDesktop('desktop_ai_host_status', {}));
};
export const configureAiHost = async (wakeProtectionEnabled: boolean) => {
    if (!personalHomeSupported()) throw new Error('Local host controls require the desktop app.');
    return aiHostSchema.parse(await invokeDesktop('desktop_ai_host_configure', { wakeProtectionEnabled }));
};
export const connectHomeNotion = () => invoke({ action: 'connect' });
export const configureHomeNotion = (board: string, habits: string, destination: string) => invoke({ action: 'configure', board, habits, destination });
export const moveHomeTask = (page: string, status: string) => invoke({ action: 'move', page, status });
export const createHomeTask = (title: string, status?: string) => invoke({ action: 'create-task', title, status });
export const renameHomeTask = (page: string, title: string) => invoke({ action: 'rename-task', page, title });
export const deleteHomeTask = (page: string) => invoke({ action: 'delete-task', page, confirmed: true });
export const readHomeCalendar = async (connect = false) => calendarSchema.parse(await invoke({ action: 'calendar', op: connect ? 'connect' : 'read' }));
const reminderSchema = z.object({
    access: z.enum(['connected', 'not-connected', 'unsupported']),
    error: z.string().optional(),
    reminders: z.array(z.object({ id: z.string(), title: z.string(), due: z.string().nullable(), overdue: z.boolean(), priority: z.enum(['none', 'low', 'medium', 'high']), list: z.string() })).default([]),
});
export type HomeReminder = z.infer<typeof reminderSchema>['reminders'][number];
export const readHomeReminders = async (connect = false) => reminderSchema.parse(await invoke({ action: 'reminders', op: connect ? 'reminders-connect' : 'reminders-read' }));
export const completeHomeReminder = async (id: string) => {
    const result = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), savedId: z.string().optional(), error: z.string().optional() }).parse(await invoke({ action: 'reminders', op: 'reminder-complete', id }));
    if (result.error) throw new Error(result.error);
    if (result.access !== 'connected') throw new Error('Connect Reminders before completing one.');
};
export const saveHomeReminder = async (title: string, due?: string) => {
    const result = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), savedId: z.string().optional(), error: z.string().optional() }).parse(await invoke({ action: 'reminders', op: 'reminder-save', title, ...(due ? { due } : {}) }));
    if (result.error) throw new Error(result.error);
    if (result.access !== 'connected' || !result.savedId) throw new Error('Connect Reminders before adding one.');
    return result;
};
const savedEventSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), savedId: z.string().optional(), error: z.string().optional() });
export const saveHomeEvent = async (event: { id?: string; title: string; start: string; end: string; calendarId: string }) => {
    const result = savedEventSchema.parse(await invoke({ action: 'calendar', op: 'save', ...event }));
    if (result.error) throw new Error(result.error);
    if (result.access !== 'connected' || !result.savedId) throw new Error('Connect Calendar before saving an event.');
    return result;
};

export async function exportHomeChat(session: Session, roles: { user: string; assistant: string }) {
    const records = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await opencodeClient.getSessionMessages(session.id, { limit: 100, cursor, order: 'asc' }, session.directory);
        records.push(...page.items);
        cursor = page.cursor.next;
        if (cursor && seen.has(cursor)) throw new Error('The chat could not be loaded completely. Try again.');
        if (cursor) seen.add(cursor);
    } while (cursor);
    const content = records.sort((a, b) => a.info.time.created - b.info.time.created).flatMap(({ info, parts }) => {
        const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
        return text.trim() ? [`## ${info.role === 'user' ? roles.user : roles.assistant}\n\n${text}`] : [];
    }).join('\n\n---\n\n');
    return invoke({ action: 'export', title: session.title, content });
}

/** Save a meeting (summary, notes, transcript) as a page under the saved-chats Notion page. */
export const exportMeetingToNotion = (title: string, content: string) => invoke({ action: 'export', title, content });

const notionPageSchema = z.object({ id: z.string(), url: z.string(), title: z.string(), lastEdited: z.string().nullable() });
export type NotionPageSummary = z.infer<typeof notionPageSchema>;
const notionSearchResultSchema = z.object({ connected: z.boolean(), pages: z.array(notionPageSchema) });
/**
 * Read-only page lookup for the composer's @ picker. Metadata only: the page
 * body is fetched live by the agent through the Notion MCP tools. A
 * disconnected Notion is reported as such, never as an empty result set.
 *
 * The lookup is a round trip to a remote service, and the picker asks for one
 * on every keystroke and every time it opens. A short-lived cache and a shared
 * in-flight request mean the same question is only asked once: reopening the
 * picker is instant, and a query that has been typed before is instant too.
 */
const NOTION_SEARCH_TTL_MS = 90_000;
const notionSearchCache = new Map<string, { at: number; result: z.infer<typeof notionSearchResultSchema> }>();
const notionSearchInFlight = new Map<string, Promise<z.infer<typeof notionSearchResultSchema>>>();

export const searchNotionPages = async (query: string): Promise<z.infer<typeof notionSearchResultSchema>> => {
  const key = query.trim().toLowerCase();
  const cached = notionSearchCache.get(key);
  if (cached && Date.now() - cached.at < NOTION_SEARCH_TTL_MS) return cached.result;
  const inFlight = notionSearchInFlight.get(key);
  if (inFlight) return inFlight;
  const request = invoke({ action: 'search', query })
    .then((raw) => {
      const result = notionSearchResultSchema.parse(raw);
      notionSearchCache.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      notionSearchInFlight.delete(key);
    });
  notionSearchInFlight.set(key, request);
  return request;
};

const habitsSchema = z.object({ day: z.string(), page: z.string().nullable(), items: z.array(z.object({ name: z.string(), checked: z.boolean() })) });
export type HomeHabits = z.infer<typeof habitsSchema>;
export const readHomeHabits = async (day: string) => habitsSchema.parse(await invoke({ action: 'habits', day }));
export const startHomeDay = async (day: string) => habitsSchema.parse(await invoke({ action: 'start-day', day }));
export const toggleHomeHabit = (page: string, name: string, checked: boolean) => invoke({ action: 'habit', page, name, checked });
export const disconnectHomeNotion = () => invoke({ action: 'disconnect' });

/** Durable queued work uses the same scoped coordinator as the Notion board. */
export const enqueueTeamMessage = async (input: { projectId: string; title: string; text: string; requestId: string; model?: { providerID: string; id: string } }) => {
    const run = teamRunSchema.parse(await invokeTeam({ action: 'team-enqueue', ...input }));
    if (run.projectId !== input.projectId || run.text !== input.text || run.title !== input.title) throw new Error('Team assignment owner mismatch.');
    return run;
};
export const resumeTeamQueued = async (run: HomeTeamRun) => {
    const next = teamRunSchema.parse(await invokeTeam({ action: 'team-resume-queued', projectId: run.projectId, runId: run.id }));
    if (next.projectId !== run.projectId || next.id !== run.id) throw new Error('Team assignment owner mismatch.');
    return next;
};

export const cancelTeamQueued = async (run: HomeTeamRun) => {
    const next = teamRunSchema.parse(await invokeTeam({ action: 'team-cancel-queued', projectId: run.projectId, runId: run.id }));
    if (next.projectId !== run.projectId || next.id !== run.id) throw new Error('Team assignment owner mismatch.');
    return next;
};
