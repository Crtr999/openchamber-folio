import { z } from 'zod';

export const projectPermissionRuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(['allow', 'ask', 'deny']),
});

export const projectRulesSettingsSchema = z.object({
  model: z.string(),
  defaultAgent: z.string().optional(),
  share: z.enum(['inherit', 'manual', 'auto', 'disabled']),
  policies: z.array(z.object({ resource: z.string().min(1), effect: z.enum(['allow', 'deny']) })),
  permissions: z.array(projectPermissionRuleSchema).optional(),
});

export const projectRulesSnapshotSchema = z.object({
  path: z.string(),
  revision: z.string(),
  content: z.string(),
  settings: projectRulesSettingsSchema,
  previous: z.boolean(),
});

export type ProjectPermissionRule = z.infer<typeof projectPermissionRuleSchema>;
export type ProjectRulesSnapshot = z.infer<typeof projectRulesSnapshotSchema>;
export type ProjectRulesKind = 'instructions' | 'memory' | 'configuration';
export type ProjectRulesSave = {
  directory: string;
  kind: ProjectRulesKind;
  expectedRevision: string;
  content: string;
  settings: z.infer<typeof projectRulesSettingsSchema>;
  restore?: boolean;
};
