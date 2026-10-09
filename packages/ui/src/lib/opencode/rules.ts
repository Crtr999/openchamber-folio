import { z } from 'zod';
import type { ConfigSource } from './model';
import { mergeConfigDocuments } from './projection';

/** Keep policy provenance: folding experimental config would hide policies from earlier layers. */
export function projectRulesConfiguration(entries: readonly ConfigSource[]) {
  const documents = entries.filter((entry) => entry.type === 'document');
  const config = mergeConfigDocuments(entries);
  const defaultModel = z.string().or(z.object({ providerID: z.string(), model: z.string() }).transform(({ providerID, model }) => `${providerID}/${model}`)).optional().parse(config.model);
  return {
    config,
    defaultModel,
    sources: documents.flatMap((entry) => entry.path ? [entry.path] : []),
    ruleSources: documents.map((entry) => ({
      path: entry.path,
      policies: entry.info.experimental?.policies ?? [],
      permissions: entry.info.permissions ?? [],
      instructions: entry.info.instructions ?? [],
    })),
  };
}
