import type { OpenCodeClient } from '@opencode/client';
import type { TeamArtifact, TeamDestination, TeamExecutor } from './runtime.js';

export type TeamCapability = 'read-project' | 'fetch-reference' | 'draft-output' | 'safe-compute';
export interface TeamModel { providerID: string; id: string }
export interface TeamProfilePermissions { id: string; permissions: TeamDestination['permissions'] }
export type TeamPolicy =
  | { version: 1; manager: 'manager'; providers: string[]; specialists: string[] }
  | { version: 2; manager: 'manager'; model: TeamModel; freeOnly: true; paidFallback: false;
      specialists: Array<{ id: string; capabilities: TeamCapability[] }> };
export interface VerifiedTeamArtifact extends TeamArtifact {
  /** Point-in-time file verification, not a claim of semantic correctness. */
  verified: true;
  sha256: string;
  sizeBytes: number;
}
export interface TeamHandoffEvidence {
  /** Actual completed parent subagent tool call; no inferred child ID. */
  sessionId: string;
  messageId: string;
  toolId: string;
  status: 'completed';
}
export interface ValidatedTeamExecutor extends TeamExecutor {
  resolveProject(projectId: string): Promise<TeamDestination & { policyVersion: 1 | 2; childPermissions: TeamProfilePermissions[] }>;
  evidence: (run: Parameters<TeamExecutor['evidence']>[0]) => Promise<{
    usage: Awaited<ReturnType<TeamExecutor['evidence']>>['usage'];
    artifacts: VerifiedTeamArtifact[];
    handoffs: TeamHandoffEvidence[];
  }>;
  diagnose(projectId: string): Promise<{
    projectId: string;
    directory: string;
    agents: Array<{ id: string; mode: 'primary' | 'subagent' | 'all'; hidden: boolean; steps?: number; model?: TeamModel }>;
    validation: { kind: 'ready'; policyRevision: string; specialists: string[] } | { kind: 'blocked'; code: string; message: string };
  }>;
}
export declare function createTeamExecutor(options: {
  readProjects: () => Promise<Array<{ id: string; path: string; label?: string; defaultModel?: string | null; defaultVariant?: string | null }>>;
  waitForReady?: () => Promise<void>;
  getClient?: (directory: string) => OpenCodeClient | null;
  /** Trusted runtime proof of the loaded guard's exact configured model,
   * covering title, summary, compaction, optimizers and
   * all auxiliary generation. Must enforce exact model at invocation time;
   * replace inherited session rules for each real child with its admitted rules,
   * deny child delegation, and force ask for every webfetch even after saved
   * approvals. Do not implement this as a name check or prompt instruction. */
  verifyFreeExecution?: (input: { directory: string; model: TeamModel; manager: TeamProfilePermissions;
    specialists: TeamProfilePermissions[]; forceAskActions: Array<'webfetch'> }) => Promise<boolean>;
  /** Verify installed version-1 team tool implementation: bounded pure compute
   * or create-only confined team-output drafts, never host shell or network.
   * This must attest the actual tool implementation, not only its name. */
  verifyTeamTool?: (input: { directory: string; tool: 'team_compute' | 'team_output'; version: 1 }) => Promise<boolean>;
}): ValidatedTeamExecutor;
