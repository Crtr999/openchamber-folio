import type { z } from 'zod';
import type { TeamRun as PreviousRun, TeamRoutine as PreviousRoutine, TeamFailure as PreviousFailure, Teammate, TeamSchedule, TeamLimits, TeamUsage, TeamArtifact } from './runtime.js';

export interface TeamFailure extends Omit<PreviousFailure, 'stage'> {
  stage: PreviousFailure['stage'] | 'stall';
}
export interface TeamRun extends Omit<PreviousRun, 'failure'> {
  failure?: TeamFailure;
  /** Unverified interruption blocks every new team dispatch, including other projects. */
  queuePolicyRevision?: string;
  pendingDispatch?: true;
  cancelledBeforeDispatch?: true;
  queuedAt?: number;
  pausePending?: boolean;
  /** Frozen effective model. Historical runs may omit it. */
  model?: { providerID: string; id: string };
  revisionOf?: string;
  sourceRevision?: number;
  /** Frozen project-only context saved before the single prompt dispatch. */
  savedContext?: string;
}
export interface TeamRoutine extends PreviousRoutine { failure?: TeamFailure; model?: { providerID: string; id: string } }
export interface TeamState { version: 1; teammates: Teammate[]; runs: TeamRun[]; routines: TeamRoutine[] }
export declare const scopeSchema: z.ZodType<{ projectId: string; teammateId: string }>;
export declare const scheduleSchema: z.ZodType<TeamSchedule>;
export declare const limitsSchema: z.ZodType<TeamLimits>;
export declare const teammateSchema: z.ZodType<Teammate>;
export declare const childSchema: z.ZodType<TeamRun['children'][number]>;
export declare const usageSchema: z.ZodType<TeamUsage>;
export declare const artifactSchema: z.ZodType<TeamArtifact>;
export declare const runSchema: z.ZodType<TeamRun>;
export declare const routineSchema: z.ZodType<TeamRoutine>;
export declare function createTeamState(filePath: string): {
  load(): Promise<TeamState>;
  save(state: TeamState): Promise<void>;
  close(): Promise<void>;
};
