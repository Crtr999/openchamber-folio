import type { Teammate, TeamSchedule, TeamLimits, TeamDestination, TeamConnection, TeamToolRequest } from './runtime.js';
import type { TeamRun, TeamRoutine } from './team-state.js';
export type { TeamRun, TeamRoutine, TeamFailure } from './team-state.js';
export interface TeamModelOption { providerID: string; id: string; name: string; default: boolean }

export interface TeamRuntime {
  executeTool(input: TeamToolRequest, options: { signal: AbortSignal }): Promise<{ content: string }>;
  listTeammates(): Promise<Teammate[]>;
  inbox(): Promise<Array<{ teammate: Teammate; unread: boolean; latestRun: TeamRun | null }>>;
  details(input: { projectId: string; teammateId: string }): Promise<{ teammate: Teammate; runs: TeamRun[]; routines: TeamRoutine[] }>;
  /** Read-only project-scoped recovery by the same request ID used for send. */
  getRun(input: { projectId: string; requestId: string }): Promise<TeamRun | null>;
  /** model must be one of the project policy's reviewed team models; absent uses its default. */
  send(input: { projectId: string; title: string; text: string; requestId: string; model?: { providerID: string; id: string } }): Promise<TeamRun>;
  enqueue(input: { projectId: string; title: string; text: string; requestId: string; model?: { providerID: string; id: string } }): Promise<TeamRun>;
  cancelQueued(input: { projectId: string; runId: string }): Promise<TeamRun>;
  resumeQueued(input: { projectId: string; runId: string }): Promise<TeamRun>;
  models(projectId: string): Promise<TeamModelOption[]>;
  /** Exact run revision required. Creates a linked new run, never resumes or resends the old one. */
  revise(input: { projectId: string; runId: string; revision: number; text: string; requestId: string }): Promise<TeamRun>;
  /** Retries interruption and reads evidence only. Never sends prompts or confirms routines. */
  recover(input: { projectId: string; runId: string }): Promise<TeamRun>;
  ack(input: { projectId: string; teammateId: string; revision: number }): Promise<Teammate>;
  proposeRoutine(input: { projectId: string; title: string; text: string; schedule: TeamSchedule; allowedActions: TeamRoutine['allowedActions']; limits: TeamLimits }): Promise<TeamRoutine>;
  confirmRoutine(input: { projectId: string; routineId: string; revision: string }): Promise<TeamRoutine>;
  pauseRoutine(input: { projectId: string; routineId: string; revision: string }): Promise<TeamRoutine>;
  pauseContinuation(input: { projectId: string; runId: string }): Promise<TeamRun>;
  check(): Promise<void>;
  close(): Promise<void>;
}
export interface TeamExecutor {
  authorizeTool(run: TeamRun, input: TeamToolRequest): Promise<{ directory: string; receipt?: TeamRun['artifacts'][number] }>;
  accounting?(run: TeamRun): Promise<TeamRun['usage']>;
  resolveProject(projectId: string, model?: { providerID: string; id: string }): Promise<TeamDestination>;
  models?(projectId: string): Promise<TeamModelOption[]>;
  create(input: { title: string; destination: TeamDestination; runId: string }): Promise<{ id: string; directory: string }>;
  send(run: TeamRun, content: string): Promise<void>;
  inspect(run: TeamRun): Promise<{ kind: 'pending' | 'running' | 'done' | 'needs-you'; content?: string; reviewEvidence?: 'verified' }>;
  children(run: TeamRun): Promise<TeamRun['children']>;
  evidence(run: TeamRun): Promise<{ usage: TeamRun['usage']; artifacts: TeamRun['artifacts'] }>;
  pause(run: TeamRun): Promise<void>;
}
export declare function createTeamRuntime(options: TeamConnection & { executor: TeamExecutor; isBlocked: () => boolean; now?: () => number }): TeamRuntime;
