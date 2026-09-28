import { getModelDisplayName } from '@/lib/modelDisplay';
import { listModelVariantIds } from '@/lib/modelVariants';
import type { Model, ModelRef, Provider } from '@/lib/opencode/model';

/**
 * The model a page's Ask AI answers with.
 *
 * Ask AI carries its own choice instead of reading whatever an ordinary chat
 * happens to be on. The send path takes this value and nothing else, so a model
 * change made in a chat can no longer silently re-point a page conversation
 * at a model the provider will reject.
 */
export interface AskModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

/** What Ask AI follows before the user has picked a model for it. */
export interface AskModelFallback {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

/** The config store's provider list carries the models it owns. */
export type AskModelProvider = Provider & { models: Model[] };

/**
 * The model a send runs on: the pick when there is one, otherwise the app's
 * current selection. A pick is never merged with the app's variant, because a
 * thinking level belongs to the model that was picked.
 */
export function resolveAskModel(
  selection: AskModelSelection | undefined,
  fallback: AskModelFallback,
): AskModelSelection | undefined {
  if (selection?.providerID && selection.modelID) return { providerID: selection.providerID, modelID: selection.modelID, variant: selection.variant };
  if (fallback.providerID && fallback.modelID) return { providerID: fallback.providerID, modelID: fallback.modelID, variant: fallback.variant };
  return undefined;
}

function askModelRecord(
  providers: readonly AskModelProvider[],
  selection: AskModelSelection | undefined,
): Model | undefined {
  if (!selection) return undefined;
  return providers.find((provider) => provider.id === selection.providerID)?.models.find((model) => model.id === selection.modelID);
}

/**
 * The thinking levels a model actually offers. A model without them is sent no
 * variant, because OpenCode hands the value to the provider and an effort the
 * model never declared comes back as a rejected request.
 */
export function askVariantIds(providers: readonly AskModelProvider[], selection: AskModelSelection | undefined): string[] {
  return listModelVariantIds(askModelRecord(providers, selection)?.variants);
}

function askSendableVariant(providers: readonly AskModelProvider[], selection: AskModelSelection | undefined): string | undefined {
  const variant = selection?.variant;
  if (!variant) return undefined;
  return askVariantIds(providers, selection).includes(variant) ? variant : undefined;
}

/**
 * The reference the send path hands OpenCode. Only identifiers travel: the name
 * the trigger shows is a label, and a label sent where a model id belongs is a
 * request the provider cannot resolve.
 */
export function askModelRef(providers: readonly AskModelProvider[], model: AskModelSelection): ModelRef {
  const ref: ModelRef = { providerID: model.providerID, id: model.modelID };
  const variant = askSendableVariant(providers, model);
  if (variant) ref.variant = variant;
  return ref;
}

/** What the trigger shows: the model's own name, or its id before metadata lands. */
export function askModelLabel(providers: readonly AskModelProvider[], selection: AskModelSelection | undefined): string {
  const record = askModelRecord(providers, selection);
  return (record && getModelDisplayName(record)) || selection?.modelID || '';
}

/** The next thinking level from the current one, wrapping through "no level". */
export function nextAskVariant(variantIds: readonly string[], variant: string | undefined, step: 1 | -1): string | undefined {
  const levels: Array<string | undefined> = [undefined, ...variantIds];
  const current = levels.indexOf(variant);
  const from = current >= 0 ? current : 0;
  return levels[(from + step + levels.length) % levels.length];
}
