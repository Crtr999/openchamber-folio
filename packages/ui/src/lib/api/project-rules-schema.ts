import { z } from 'zod';
export const projectRulesSettingsSchema = z.object({ model: z.string(), share: z.enum(['inherit', 'manual', 'auto', 'disabled']), policies: z.array(z.object({ resource: z.string().min(1), effect: z.enum(['allow', 'deny']) })) });
export const projectRulesSnapshotSchema = z.object({ path: z.string(), revision: z.string(), content: z.string(), settings: projectRulesSettingsSchema, previous: z.boolean() });
export type ProjectRulesSnapshot = z.infer<typeof projectRulesSnapshotSchema>;
export type ProjectRulesKind = 'instructions' | 'configuration';
export type ProjectRulesSave = { directory: string; kind: ProjectRulesKind; expectedRevision: string; content: string; settings: z.infer<typeof projectRulesSettingsSchema>; restore?: boolean };
