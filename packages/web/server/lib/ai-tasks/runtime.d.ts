export interface AiTaskConfig { board: string; model: string; enabled: boolean }
export interface AiTaskFailure {
  stage: 'claim' | 'read-task' | 'resolve' | 'create' | 'dispatch' | 'inspect' | 'pause' | 'stall' | 'writeback';
  code: string;
  message: string;
  at: number;
}
export interface AiTaskRun {
  id: string;
  page: string;
  board: string;
  title: string;
  phase: 'claimed' | 'running' | 'result' | 'done' | 'needs-you' | 'cancelled';
  startedAt: number;
  sessionId?: string;
  directory?: string;
  projectId?: string;
  projectLabel?: string;
  agent?: string;
  assignmentRevision?: string;
  teamRequestId?: string;
  teamRunId?: string;
  teammateId?: string;
  teamRevision?: number;
  content?: string;
  outcome?: 'done' | 'needs-you';
  failure?: AiTaskFailure;
  writebackFailure?: AiTaskFailure;
}
export interface AiTaskBoard {
  columns: string[];
  rows: Array<{ url: string; title: string | null; status: string | null }>;
}
/** Credentials and transport stay with the host's approved Notion adapter. */
export interface AiTaskConnection {
  filePath: string;
  notion: {
    readBoard: (board: string, status?: string) => Promise<AiTaskBoard>;
    readTask: (board: string, page: string) => Promise<string>;
    claim: (board: string, page: string) => Promise<boolean>;
    finish: (run: AiTaskRun) => Promise<boolean>;
    prepareCreateBoard: () => Promise<void>;
    createBoard: () => Promise<string>;
    delete?: (board: string, input: { page: string; confirmed: true }) => Promise<{ saved: true }>;
  };
}
export interface AiTaskStatus {
  config: AiTaskConfig;
  runs: AiTaskRun[];
  assignments: Array<{ board: string; page: string; projectId: string; model?: { providerID: string; id: string }; revision?: string }>;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  error: string;
  provisioning: boolean;
}
export interface AiTaskCoordinator {
  start: () => void;
  close: () => Promise<void>;
  status: () => Promise<AiTaskStatus>;
  configure: (config: AiTaskConfig) => Promise<{ saved: true }>;
  check: () => Promise<AiTaskStatus>;
  createBoard: () => Promise<{ saved: true }>;
  delete: (input: { page: string; confirmed: true }) => Promise<{ saved: true }>;
  /** models lists the project's reviewed team models; empty for projects without a team policy. */
  projects: () => Promise<Array<{ id: string; label: string; models: Array<{ providerID: string; id: string; name: string; default: boolean }> }>>;
  assign: (input: { page: string; projectId: string; model?: { providerID: string; id: string } }) => Promise<{ saved: true }>;
  details: (id: string) => Promise<{
    run: AiTaskRun;
    children: { kind: 'loaded'; items: Array<{ id: string; title: string; directory: string }> } | { kind: 'failed'; failure: AiTaskFailure };
  }>;
}
export interface AiTaskDestination {
  projectId: string;
  label: string;
  directory: string;
  agent: string;
  model: { providerID: string; id: string; variant?: string };
  permissions: Array<{ action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }>;
}
export declare const AI_TASK_COLUMNS: string[];
/** Local Mac dispatcher. No HTTP routes are registered by this module. */
export interface TeamLimits {
  maxOccurrences: number;
  /** Observed manager + descendant tokens; not a hard billing cap. */
  tokenGuardrail: number;
}
export type TeamSchedule =
  | { kind: 'once'; date: string; time: string; timezone: string }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; weekdays: number[]; time: string; timezone: string }
  | { kind: 'cron'; cron: string; timezone: string };
export interface Teammate {
  id: string;
  projectId: string;
  projectLabel: string;
  directory: string;
  agent: string;
  role: 'manager';
  revision: number;
  readRevision: number;
}
export interface TeamFailure { stage: 'resolve' | 'create' | 'dispatch' | 'inspect' | 'pause' | 'stall'; code: string; message: string; at: number }
export interface TeamUsage {
  kind: 'available' | 'unavailable';
  tokens: number;
  reportedCost: number;
  sessionIds: string[];
  /** Always false. Provider cost reports are not enforceable dollar caps. */
  dollarCapSupported: false;
}
export interface TeamArtifact { path: string; label: string; sessionId: string; messageId: string; verified?: true; sha256?: string; sizeBytes?: number }
export interface TeamRun {
  id: string;
  taskId: string;
  teammateId: string;
  projectId: string;
  directory: string;
  title: string;
  text: string;
  phase: 'queued' | 'creating' | 'dispatching' | 'running' | 'done' | 'needs-you' | 'paused';
  startedAt: number;
  revision: number;
  sessionId?: string;
  content?: string;
  failure?: TeamFailure;
  children: Array<{ id: string; title: string; directory: string }>;
  artifacts: TeamArtifact[];
  usage: TeamUsage;
  inspectFailures: number;
  routineId?: string;
  scheduledFor?: number;
  policyRevision?: string;
  /** Frozen effective model for new runs; historical runs may omit it. */
  model?: { providerID: string; id: string };
  queuePolicyRevision?: string;
  pendingDispatch?: true;
  cancelledBeforeDispatch?: true;
  queuedAt?: number;
  pausePending?: boolean;
  revisionOf?: string;
  sourceRevision?: number;
  savedContext?: string;
  handoffs?: Array<{ sessionId: string; messageId: string; toolId: string; status: 'completed' }>;
  receiptScan?: { kind: 'partial' | 'complete'; incompleteSessionIds: string[] };
}
export interface TeamRoutine {
  id: string;
  teammateId: string;
  projectId: string;
  revision: string;
  title: string;
  text: string;
  schedule: TeamSchedule;
  allowedActions: Array<'read-project' | 'fetch-reference' | 'draft-output' | 'safe-compute' | 'read-output'>;
  limits: TeamLimits;
  status: 'proposed' | 'confirmed' | 'paused' | 'complete';
  occurrences: number;
  nextRunAt?: number;
  policyRevision: string;
  model?: { providerID: string; id: string };
  failure?: TeamFailure;
}
export interface TeamInboxItem {
  teammate: Teammate;
  unread: boolean;
  latestRun: TeamRun | null;
}
export type TeamToolRequest = { projectId: string; sessionID: string } & (
  { action: 'team_compute'; input: { request: string } } | { action: 'team_output'; input: { filename: string; content: string } }
  | { action: 'team_read_output'; input: { filename: string } }
);
export interface TeamRuntime {
  executeTool(input: TeamToolRequest, options: { signal: AbortSignal }): Promise<{ content: string }>;
  listTeammates(): Promise<Teammate[]>;
  inbox(): Promise<TeamInboxItem[]>;
  details(input: { projectId: string; teammateId: string }): Promise<{ teammate: Teammate; runs: TeamRun[]; routines: TeamRoutine[] }>;
  /** requestId is a caller-generated, project-scoped idempotency key. Each message creates a real separate run. */
  send(input: { projectId: string; text: string; title: string; requestId: string; model?: { providerID: string; id: string } }): Promise<TeamRun>;
  /** Reviewed zero-priced models a task in this project may choose. Read-only. */
  enqueue(input: { projectId: string; title: string; text: string; requestId: string; model?: { providerID: string; id: string } }): Promise<TeamRun>;
  cancelQueued(input: { projectId: string; runId: string }): Promise<TeamRun>;
  resumeQueued(input: { projectId: string; runId: string }): Promise<TeamRun>;
  models(projectId: string): Promise<Array<{ providerID: string; id: string; name: string; default: boolean }>>;
  /** Project-scoped durable request lookup only. Never creates, inspects, or dispatches. */
  getRun(input: { projectId: string; requestId: string }): Promise<TeamRun | null>;
  revise(input: { projectId: string; runId: string; revision: number; text: string; requestId: string }): Promise<TeamRun>;
  recover(input: { projectId: string; runId: string }): Promise<TeamRun>;
  ack(input: { projectId: string; teammateId: string; revision: number }): Promise<Teammate>;
  proposeRoutine(input: { projectId: string; title: string; text: string; schedule: TeamSchedule; allowedActions: TeamRoutine['allowedActions']; limits: TeamLimits }): Promise<TeamRoutine>;
  confirmRoutine(input: { projectId: string; routineId: string; revision: string }): Promise<TeamRoutine>;
  pauseRoutine(input: { projectId: string; routineId: string; revision: string }): Promise<TeamRoutine>;
  /** Prevents automatic work. Does not approve, reject, or rewrite pending permissions. */
  pauseContinuation(input: { projectId: string; runId: string }): Promise<TeamRun>;
  check(): Promise<void>;
  close(): Promise<void>;
}
export interface TeamDestination extends AiTaskDestination {
  policyRevision: string;
  queuePolicyRevision?: string;
  /** Every admitted child has independently validated policy and bounded steps. */
  specialists: string[];
}
export interface TeamExecutor {
  resolveProject(projectId: string, model?: { providerID: string; id: string }): Promise<TeamDestination>;
  models?(projectId: string): Promise<Array<{ providerID: string; id: string; name: string; default: boolean }>>;
  create(input: { title: string; destination: TeamDestination; runId: string }): Promise<{ id: string; directory: string }>;
  send(run: TeamRun, content: string): Promise<void>;
  inspect(run: TeamRun): Promise<{ kind: 'pending' | 'running' | 'done' | 'needs-you'; content?: string; reviewEvidence?: 'verified' }>;
  children(run: TeamRun): Promise<TeamRun['children']>;
  evidence(run: TeamRun): Promise<{ usage: TeamUsage; artifacts: TeamArtifact[] }>;
  pause(run: TeamRun): Promise<void>;
}
export interface TeamConnection {
  filePath: string;
  guardrails: { projectTokens: number; accountTokens: number };
  /** Trusted native observer only; derived from durable run/routine authorization, never old inbox status. */
  onWorkState?: (value: { state: 'required' | 'idle' | 'unavailable' }) => void;
}
export declare function createTeamRuntime(options: TeamConnection & { executor: TeamExecutor; isBlocked: () => boolean; now?: () => number }): TeamRuntime;
export declare function createAiTaskRuntime(options: AiTaskConnection & {
  /** The same server-owned authority used by direct team messages. Never closed or polled by this coordinator. */
  team?: Pick<TeamRuntime, 'send' | 'details' | 'getRun' | 'models'>;
  isBlocked: () => boolean;
  now?: () => number;
  executor: {
    projects: () => Promise<Array<{ id: string; label: string }>>;
    resolveProject: (id: string) => Promise<AiTaskDestination>;
    create: (input: { title: string; destination: AiTaskDestination; runId: string }) => Promise<{ id: string; directory: string }>;
    send: (run: AiTaskRun, content: string) => Promise<void>;
    inspect: (run: AiTaskRun) => Promise<{ kind: 'pending' | 'running' | 'done' | 'needs-you'; content?: string }>;
    children: (run: AiTaskRun) => Promise<Array<{ id: string; title: string; directory: string }>>;
  };
}): AiTaskCoordinator;
