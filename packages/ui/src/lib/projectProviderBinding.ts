import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * A project folder can be bound to specific providers: Carter's Claude folder
 * only runs the Claude Code provider, the ChatGPT folder only OpenAI, and the
 * ZDR Legal folder only OpenRouter ZDR (`openrouter-zdr`). The binding is read
 * from the folder's own OpenCode config (`provider.use` deny-all plus allows),
 * the same policy the server enforces on every send, so the picker and the
 * server cannot disagree. Folders without such a policy are unbound and keep
 * the unrestricted pickers.
 */

type CatalogProvider = { id: string; models: ReadonlyArray<{ id: string }> };

/**
 * Fallback for when the folder's config cannot be read: the personal
 * "Open Carter/<Name>" workspace folders and ZDR Legal folders are named for
 * their provider policy.
 */
const OPEN_CARTER_FOLDER_PROVIDERS: Record<string, string[]> = {
  claude: ['claude-code'],
  chatgpt: ['openai'],
  gemini: ['gemini-cli'],
};

export const providerBindingFromFolderName = (directory: string | null | undefined): string[] | null => {
  const parts = (directory ?? '').split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const leaf = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (leaf === 'zdr management' || leaf === 'zdr legal' || leaf.startsWith('zdr ')) {
    return ['openrouter-zdr'];
  }
  if (parts.length < 2 || parts[parts.length - 2]?.toLowerCase() !== 'open carter') return null;
  return OPEN_CARTER_FOLDER_PROVIDERS[leaf] ?? null;
};

export const isStrictlyZdrBound = (binding: readonly string[] | null | undefined): boolean =>
  Boolean(binding && binding.length === 1 && binding[0] === 'openrouter-zdr');

export type UnboundDraftTarget = {
  selectedProjectId: string | null;
  directoryOverride: string | null;
  target: 'chat' | 'project';
};

let lastUnboundDraftTarget: UnboundDraftTarget | null = null;

export const rememberUnboundDraftTarget = (draft: UnboundDraftTarget): void => {
  if (draft.directoryOverride && providerBindingFromFolderName(draft.directoryOverride)) {
    return;
  }
  lastUnboundDraftTarget = {
    selectedProjectId: draft.selectedProjectId ?? null,
    directoryOverride: draft.directoryOverride ?? null,
    target: draft.target,
  };
};

export const consumeUnboundDraftTarget = (fallbackChatProjectId: string): UnboundDraftTarget => {
  const saved = lastUnboundDraftTarget;
  lastUnboundDraftTarget = null;
  if (saved && !(saved.directoryOverride && providerBindingFromFolderName(saved.directoryOverride))) {
    return saved;
  }
  return {
    selectedProjectId: fallbackChatProjectId,
    directoryOverride: null,
    target: 'chat',
  };
};

export const isBoundAgentName = (agentName: string | null | undefined): boolean => {
  const normalized = agentName?.trim().toLowerCase();
  return normalized === 'claude' || normalized === 'chatgpt' || normalized === 'zdr';
};

/** Providers the binding allows; unbound (null/empty) allows everything. */
export const filterProvidersByBinding = <T extends { id: string }>(
  providers: readonly T[],
  binding: readonly string[] | null | undefined,
): T[] => {
  if (!binding || binding.length === 0) return [...providers];
  const allowed = new Set(binding);
  return providers.filter((provider) => allowed.has(String(provider.id)));
};

/** Whether the binding permits an agent whose configuration pins a model. */
export const agentAllowedByBinding = (
  agent: { model?: { providerID?: string } | null },
  binding: readonly string[] | null | undefined,
): boolean => {
  if (!binding || binding.length === 0) return true;
  const pinned = agent.model?.providerID;
  return !pinned || binding.includes(pinned);
};

/**
 * The model a draft in a bound folder should start on: the preferred
 * (OpenCode default) model when the binding allows it, else the first model of
 * the first allowed provider that has any. Null when nothing qualifies.
 */
export const pickBoundModel = ({
  providers,
  binding,
  preferred,
}: {
  providers: readonly CatalogProvider[];
  binding: readonly string[];
  preferred?: { providerId: string; modelId: string } | null;
}): { providerId: string; modelId: string } | null => {
  const allowed = filterProvidersByBinding(providers, binding);
  if (preferred) {
    const provider = allowed.find((entry) => entry.id === preferred.providerId);
    if (provider?.models.some((model) => model.id === preferred.modelId)) return preferred;
  }
  for (const id of binding) {
    const provider = allowed.find((entry) => entry.id === id && entry.models.length > 0);
    if (provider) return { providerId: provider.id, modelId: provider.models[0].id };
  }
  const any = allowed.find((entry) => entry.models.length > 0);
  return any ? { providerId: any.id, modelId: any.models[0].id } : null;
};

const bindingCache = new Map<string, string[] | null>();
const bindingInFlight = new Map<string, Promise<string[] | null>>();

export const clearProviderBindingCache = (): void => {
  bindingCache.clear();
  bindingInFlight.clear();
};

export const readProviderBinding = (directory: string): Promise<string[] | null> => {
  const key = `${getRuntimeKey()}\u0000${directory}`;
  if (bindingCache.has(key)) return Promise.resolve(bindingCache.get(key) ?? null);
  const pending = bindingInFlight.get(key);
  if (pending) return pending;
  const request = opencodeClient.getAllowedProviders(directory)
    .then((binding) => binding ?? providerBindingFromFolderName(directory), () => providerBindingFromFolderName(directory))
    .then((binding) => {
      bindingCache.set(key, binding);
      return binding;
    })
    .finally(() => bindingInFlight.delete(key));
  bindingInFlight.set(key, request);
  return request;
};

/** The providers a directory is bound to, or null while unknown/unbound. */
export const useDirectoryProviderBinding = (directory: string | null | undefined): string[] | null => {
  const [state, setState] = React.useState<{ directory: string | null; binding: string[] | null }>({ directory: null, binding: null });
  React.useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    void readProviderBinding(directory).then((binding) => {
      if (!cancelled) setState({ directory, binding });
    });
    return () => { cancelled = true; };
  }, [directory]);
  return directory && state.directory === directory ? state.binding : providerBindingFromFolderName(directory);
};
